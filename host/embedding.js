import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, rename, unlink, open } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { Worker } from 'node:worker_threads'

export const EMBEDDING_MODEL = 'multilingual-e5-small-761b726-v1'
export const defaultModelDirectory = () => join(homedir(), '.cache', 'dsh-memory', 'models', EMBEDDING_MODEL)
const base = 'https://huggingface.co/Xenova/multilingual-e5-small/resolve/761b726dd34fb83930e26aab4e9ac3899aa1fa78/'
const assets = [
  ['tokenizer.json', 17082730, '0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39'],
  ['tokenizer_config.json', 443, 'a1d6bc8734a6f635dc158508bef000f8e2e5a759c7d92f984b2c86e5ff53425b'],
  ['onnx/model_quantized.onnx', 118308185, 'f80102d3f2a1229f387d3c81909990d8945513e347b0eab049f7de3c6f98c193'],
]
const valid = (bytes, size, digest) => bytes.length === size && createHash('sha256').update(bytes).digest('hex') === digest

/** Only public pinned model assets leave the machine; memory text never enters fetch. */
export async function ensureEmbeddingModel(dir, { allowDownload = false, signal, onState = () => {} } = {}) {
  const missing = []
  for (const asset of assets) {
    try { if (valid(await readFile(join(dir, asset[0].split('/').at(-1))), asset[1], asset[2])) continue } catch {}
    missing.push(asset)
  }
  if (!missing.length) return dir
  if (!allowDownload) throw new Error('本地语义模型尚未下载')
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const lock = join(dir, 'download.lock')
  let owned
  try { owned = await open(lock, 'wx', 0o600); await owned.writeFile(String(process.pid)) }
  catch (error) {
    if (error.code !== 'EEXIST') throw error
    // Never compete with a live downloader; a later lookup can resume a dead one.
    const pid = Number(await readFile(lock, 'utf8').catch(() => '0'))
    if (pid > 0) { try { process.kill(pid, 0) } catch (probe) { if (probe.code === 'ESRCH') await unlink(lock).catch(() => {}) } }
    throw new Error('本地语义模型正在另一进程下载，稍后自动检查')
  }
  try {
    for (const [name, size, digest] of missing) {
      onState('downloading')
      const response = await fetch(base + name + '?download=true', { signal: AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(300000)]) })
      if (!response.ok) throw new Error(`语义模型下载失败：HTTP ${response.status}`)
      const chunks = []; let length = 0
      for await (const chunk of response.body) {
        length += chunk.length
        if (length > size) throw new Error('语义模型文件大小不符')
        chunks.push(chunk)
      }
      const bytes = Buffer.concat(chunks)
      if (!valid(bytes, size, digest)) throw new Error('语义模型文件校验失败')
      const file = join(dir, name.split('/').at(-1)), temporary = file + '.' + process.pid + '.tmp'
      try { await writeFile(temporary, bytes, { mode: 0o600 }); await rename(temporary, file) }
      finally { await unlink(temporary).catch(() => {}) }
    }
  } finally { await owned.close(); await unlink(lock).catch(() => {}) }
  return dir
}

export class LocalEmbedding {
  #options
  #worker
  #starting
  #pending = new Map()
  #sequence = 0
  #abort = new AbortController()
  #disposed = false
  state = 'idle'
  error = null
  constructor(options = {}) { this.#options = options }
  async #start() {
    if (this.#disposed) throw new Error('embedding disposed')
    if (this.#starting) return this.#starting
    this.#starting = (async () => {
      this.state = 'loading'
      const modelDir = await ensureEmbeddingModel(this.#options.modelDir ?? defaultModelDirectory(), {
        allowDownload: this.#options.allowDownload, signal: this.#abort.signal, onState: state => { this.state = state },
      })
      if (this.#disposed) throw new Error('embedding disposed')
      await new Promise((resolve, reject) => {
        const worker = this.#worker = new Worker(new URL('./embedding-worker.js', import.meta.url), { workerData: { modelDir } })
        worker.unref()
        const timer = setTimeout(() => { reject(new Error('本地语义模型加载超时')); worker.terminate() }, 30000)
        worker.on('message', message => {
          if (message.ready) { clearTimeout(timer); this.state = 'ready'; resolve(); return }
          const pending = this.#pending.get(message.id)
          if (!pending) return
          this.#pending.delete(message.id); clearTimeout(pending.timer)
          if (message.error) pending.reject(new Error(message.error)); else pending.resolve(message.vectors)
        })
        const fail = error => {
          clearTimeout(timer); this.state = 'failed'; this.error = error.message; reject(error)
          for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(error) }
          this.#pending.clear()
        }
        worker.on('error', fail)
        worker.on('exit', code => { fail(new Error(`本地语义进程已退出 (${code})`)) })
      })
    })().catch(error => { this.state = 'failed'; this.error = error.message; throw error })
    return this.#starting
  }
  async embed(texts, mode = 'passage') {
    await this.#start()
    if (this.#disposed || this.state !== 'ready') throw new Error(this.error ?? 'embedding unavailable')
    return new Promise((resolve, reject) => {
      const id = ++this.#sequence
      const timer = setTimeout(() => { this.#pending.delete(id); reject(new Error('本地语义计算超时')) }, 30000)
      this.#pending.set(id, { resolve, reject, timer })
      this.#worker.postMessage({ id, texts: texts.map(text => `${mode}: ${text}`) })
    })
  }
  dispose() {
    this.#disposed = true; this.#abort.abort()
    for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('embedding disposed')) }
    this.#pending.clear(); this.#worker?.terminate()
  }
}
