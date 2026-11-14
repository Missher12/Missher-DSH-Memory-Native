import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { ensureEmbeddingModel, LocalEmbedding, promoteCompletePart } from '../host/embedding.js'

class WorkerFixture extends EventEmitter {
  constructor(ready = true) {
    super();this.terminated=false
    if(ready)setImmediate(()=>this.emit('message',{ready:true}))
  }
  unref() {}
  postMessage({id,texts}) { setImmediate(()=>this.emit('message',{id,vectors:texts.map(()=>[1])})) }
  terminate() { this.terminated=true;return Promise.resolve(0) }
}

test('model download resumes a validated partial offset and stops after bounded retries', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-model-resume-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const part = join(dir, 'tokenizer.json.part')
  writeFileSync(part, 'x')
  const originalFetch = globalThis.fetch
  const ranges = [], progress = []
  globalThis.fetch = async (_url, options) => {
    ranges.push(options.headers?.Range ?? null)
    return new Response('offline fixture', { status: 502 })
  }
  try {
    await assert.rejects(() => ensureEmbeddingModel(dir, { allowDownload: true, onState: value => progress.push(value) }), /HTTP 502/u)
    assert.deepEqual(ranges, ['bytes=1-', 'bytes=1-', 'bytes=1-'])
    assert.equal(readFileSync(part, 'utf8'), 'x')
    assert.ok(progress.some(value => value.progress?.asset === 'tokenizer.json' && value.progress.downloaded === 1))
  } finally { globalThis.fetch = originalFetch }
})

test('cancelled model preparation leaves an existing partial file untouched', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-model-cancel-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const part = join(dir, 'tokenizer.json.part')
  writeFileSync(part, 'partial')
  const controller = new AbortController();controller.abort()
  const originalFetch = globalThis.fetch
  let requests = 0
  globalThis.fetch = async () => { requests++;throw new Error('unexpected network request') }
  try {
    await assert.rejects(() => ensureEmbeddingModel(dir, { allowDownload: true, signal: controller.signal }), { name: 'AbortError' })
    assert.equal(requests, 0)
    assert.equal(readFileSync(part, 'utf8'), 'partial')
  } finally { globalThis.fetch = originalFetch }
})

test('a complete verified partial file is promoted without a network request', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-model-complete-part-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const bytes = Buffer.from('complete pinned model fixture'), part = join(dir, 'asset.part'), file = join(dir, 'asset')
  writeFileSync(part, bytes)
  const originalFetch = globalThis.fetch
  let requests = 0
  globalThis.fetch = async () => { requests++;throw new Error('unexpected network request') }
  try {
    const promoted = await promoteCompletePart(part, file, bytes.length, createHash('sha256').update(bytes).digest('hex'))
    assert.equal(promoted,true)
    assert.equal(readFileSync(file).toString(),bytes.toString())
    assert.equal(requests,0)
  } finally { globalThis.fetch = originalFetch }
})

test('ready worker is reused across embeddings; cancelling a loading worker settles preparation', async () => {
  let workers = 0
  const embedding = new LocalEmbedding({ ensureModel: async dir => dir, workerFactory: () => { workers++;return new WorkerFixture() } })
  try {
    await embedding.embed(['one'],'query')
    await embedding.embed(['two'],'query')
    assert.equal(workers,1)
    let worker
    embedding.cancel()
    embedding.dispose()

    const loading = new LocalEmbedding({ ensureModel: async dir => dir, workerFactory: () => { worker=new WorkerFixture(false);return worker } })
    const pending = loading.prepare()
    await new Promise(resolve => setImmediate(resolve))
    loading.cancel()
    await assert.rejects(pending, { name: 'AbortError' })
    assert.equal(worker.terminated,true)
  } finally { embedding.dispose() }
})

test('disposing aborts preparation and offline import waits for the old download to release', async () => {
  let aborted = false, calls = 0, importedAfterAbort = false, worker
  const embedding = new LocalEmbedding({
    ensureModel: async (dir, {signal}) => {
      calls++
      if (calls === 1) return new Promise((_resolve,reject) => signal.addEventListener('abort',() => {
        aborted=true;setTimeout(()=>reject(Object.assign(new Error('cancelled'),{name:'AbortError'})),15)
      },{once:true}))
      return dir
    },
    importModel: async () => { importedAfterAbort=aborted },
    workerFactory: () => { worker=new WorkerFixture();return worker },
  })
  const first=embedding.prepare()
  await new Promise(resolve=>setImmediate(resolve))
  const imported=embedding.importModel('/chosen/offline-model')
  await assert.rejects(first,{name:'AbortError'})
  await imported
  assert.equal(importedAfterAbort,true)
  assert.equal(calls,2)
  assert.equal(embedding.state,'ready')
  embedding.dispose()

  let signalAborted=false
  const downloading=new LocalEmbedding({ ensureModel: async (_dir,{signal}) => new Promise((_resolve,reject) => signal.addEventListener('abort',() => {
    signalAborted=true;reject(Object.assign(new Error('cancelled'),{name:'AbortError'}))
  },{once:true})) })
  const preparation=downloading.prepare()
  await new Promise(resolve=>setImmediate(resolve))
  downloading.dispose()
  await assert.rejects(preparation,{name:'AbortError'})
  assert.equal(signalAborted,true)
  assert.equal(worker.terminated,true)
})
