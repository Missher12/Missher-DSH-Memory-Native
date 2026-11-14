/** Pure WASM in a worker: no unsigned native addons and no conversation network I/O. */
import { parentPort, workerData } from 'node:worker_threads'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as ort from '../vendor/embedding/ort.wasm.min.mjs'

ort.env.wasm.numThreads = 1
ort.env.wasm.wasmPaths = {
  mjs: new URL('../vendor/embedding/ort-wasm-simd-threaded.mjs', import.meta.url),
  wasm: new URL('../vendor/embedding/ort-wasm-simd-threaded.wasm', import.meta.url),
}
globalThis[Symbol.for('onnxruntime')] = ort
const { XLMRobertaTokenizer } = await import('../vendor/embedding/transformers.min.mjs')
const tokenizer = new XLMRobertaTokenizer(JSON.parse(readFileSync(join(workerData.modelDir, 'tokenizer.json'))),
  JSON.parse(readFileSync(join(workerData.modelDir, 'tokenizer_config.json'))))
const session = await ort.InferenceSession.create(new Uint8Array(readFileSync(join(workerData.modelDir, 'model_quantized.onnx'))),
  { executionProviders: ['wasm'], graphOptimizationLevel: 'all' })

async function embed(text) {
  const tokens = tokenizer(text, { truncation: false }), ids = tokens.input_ids.data
  const vector = new Float32Array(384)
  // Cover every token; unusually long Unicode input must not lose its tail.
  let windows = 0
  for (let from = 1; from < ids.length - 1; from += 448) {
    const body = ids.slice(from, Math.min(ids.length - 1, from + 510))
    const inputIds = new BigInt64Array(body.length + 2)
    inputIds[0] = ids[0]; inputIds.set(body, 1); inputIds[inputIds.length - 1] = ids[ids.length - 1]
    const dims = [1, inputIds.length], feeds = {
      input_ids: new ort.Tensor('int64', inputIds, dims),
      attention_mask: new ort.Tensor('int64', new BigInt64Array(inputIds.length).fill(1n), dims),
      token_type_ids: new ort.Tensor('int64', new BigInt64Array(inputIds.length), dims),
    }
    const output = await session.run(feeds), hidden = output.last_hidden_state
    for (let n = 0; n < inputIds.length; n++) for (let d = 0; d < 384; d++) vector[d] += hidden.data[n * 384 + d] / inputIds.length
    for (const tensor of Object.values(output)) tensor.dispose()
    for (const tensor of Object.values(feeds)) tensor.dispose()
    windows++
    if (from + 510 >= ids.length - 1) break
  }
  if (!windows) throw new Error('empty embedding input')
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0))
  if (!Number.isFinite(norm) || norm === 0) throw new Error('invalid embedding output')
  return Array.from(vector, value => value / norm)
}

let queue = Promise.resolve()
parentPort.on('message', message => {
  queue = queue.then(async () => {
    try {
      const vectors = []
      for (const text of message.texts) vectors.push(await embed(text))
      parentPort.postMessage({ id: message.id, vectors })
    } catch (error) { parentPort.postMessage({ id: message.id, error: error.message }) }
  })
})
parentPort.postMessage({ ready: true })
