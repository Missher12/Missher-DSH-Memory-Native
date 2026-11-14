import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, lstat, mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises'
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
const basename = name => name.split('/').at(-1)
const abortError = () => Object.assign(new Error('模型准备已取消'), { name: 'AbortError' })
const checkAbort = signal => { if (signal?.aborted) throw abortError() }

async function hashFile(file, expectedSize, expectedDigest) {
  let info
  try { info = await lstat(file) } catch { return false }
  if (!info.isFile() || info.isSymbolicLink() || info.size !== expectedSize) return false
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex') === expectedDigest
}

async function withDownloadLock(dir, operation) {
  const lock = join(dir, 'download.lock')
  let owned
  try { owned = await open(lock, 'wx', 0o600); await owned.writeFile(String(process.pid)) }
  catch (error) {
    if (error.code !== 'EEXIST') throw error
    const pid = Number(await readFile(lock, 'utf8').catch(() => '0'))
    if (pid > 0) { try { process.kill(pid, 0) } catch (probe) { if (probe.code === 'ESRCH') await unlink(lock).catch(() => {}) } }
    throw new Error('本地语义模型正在另一进程准备，稍后自动检查')
  }
  try { return await operation() }
  finally { await owned.close(); await unlink(lock).catch(() => {}) }
}

function retryableRangeError(message, restart = false) {
  return Object.assign(new Error(message), { restart })
}

async function filePrefixHash(file, size) {
  const hash = createHash('sha256')
  let length = 0
  if (size > 0) for await (const chunk of createReadStream(file)) { hash.update(chunk); length += chunk.length }
  return { hash, length }
}

export async function promoteCompletePart(part, file, size, expectedDigest) {
  if (await hashFile(file, size, expectedDigest)) return true
  if (!await hashFile(part, size, expectedDigest)) return false
  await unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error })
  await rename(part, file)
  return true
}

async function writeAll(handle, chunk) {
  let offset = 0
  while (offset < chunk.length) {
    const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset, null)
    if (bytesWritten <= 0) throw new Error('语义模型文件写入未完成')
    offset += bytesWritten
  }
}

/** Only public pinned model assets leave the machine; memory text never enters fetch. */
export async function ensureEmbeddingModel(dir, { allowDownload = false, signal, onState = () => {} } = {}) {
  const missing = []
  for (const asset of assets) if (!await hashFile(join(dir, basename(asset[0])), asset[1], asset[2])) missing.push(asset)
  if (!missing.length) { onState({ state: 'ready', progress: { asset: null, downloaded: 0, total: 0 } }); return dir }
  if (!allowDownload) throw new Error('本地语义模型尚未下载')
  await mkdir(dir, { recursive: true, mode: 0o700 })
  return withDownloadLock(dir, async () => {
    for (const asset of missing) {
      checkAbort(signal)
      const [name, size, expectedDigest] = asset
      const file = join(dir, basename(name)), part = file + '.part'
      if (await hashFile(file, size, expectedDigest)) continue
      if (await promoteCompletePart(part, file, size, expectedDigest)) {
        onState({ state: 'asset-ready', progress: { asset: basename(name), downloaded: size, total: size } })
        continue
      }
      let forceFull = false, completed = false
      for (let attempt = 1; attempt <= 3 && !completed; attempt++) {
        checkAbort(signal)
        let offset = 0
        try { offset = (await stat(part)).size } catch {}
        if (offset >= size) { await unlink(part).catch(() => {}); offset = 0 }
        if (forceFull) { await unlink(part).catch(() => {}); offset = 0; forceFull = false }
        const prefix = await filePrefixHash(part, offset)
        offset = prefix.length
        const progress = (downloaded, state = 'downloading') => onState({ state, progress: { asset: basename(name), downloaded, total: size, attempt } })
        progress(offset)
        let handle
        try {
          const response = await fetch(base + name + '?download=true', {
            ...(offset > 0 ? { headers: { Range: `bytes=${offset}-` } } : {}),
            signal: AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(300000)]),
          })
          if (offset > 0 && response.status === 200) {
            // Some mirrors ignore Range. Start over from byte zero using this body.
            offset = 0
            prefix.hash.destroy?.()
            await unlink(part).catch(() => {})
          } else if (!response.ok) {
            throw new Error(`语义模型下载失败：HTTP ${response.status}`)
          } else if (offset > 0) {
            const range = response.headers.get('content-range')
            const match = /^bytes (\d+)-(\d+)\/(\d+)$/u.exec(range ?? '')
            if (response.status !== 206 || !match || Number(match[1]) !== offset || Number(match[2]) !== size - 1 || Number(match[3]) !== size) {
              throw retryableRangeError('模型服务器续传范围不匹配', true)
            }
          } else if (response.status !== 200) {
            throw new Error(`语义模型下载失败：HTTP ${response.status}`)
          }
          if (!response.body) throw new Error('语义模型下载没有响应内容')
          const hash = offset === 0 ? createHash('sha256') : prefix.hash
          handle = await open(part, offset === 0 ? 'w' : 'a', 0o600)
          let downloaded = offset
          for await (const chunk of response.body) {
            checkAbort(signal)
            downloaded += chunk.length
            if (downloaded > size) throw retryableRangeError('语义模型文件大小超出预期', true)
            await writeAll(handle, chunk)
            hash.update(chunk)
            progress(downloaded)
          }
          await handle.close(); handle = null
          if (downloaded < size) throw new Error('语义模型下载中断，已保存可续传部分')
          if (hash.digest('hex') !== expectedDigest) throw retryableRangeError('语义模型文件校验失败', true)
          if (!await hashFile(part, size, expectedDigest)) throw retryableRangeError('语义模型落盘校验失败', true)
          await rename(part, file)
          completed = true
          progress(size, 'asset-ready')
        } catch (error) {
          await handle?.close().catch(() => {})
          if (signal?.aborted || error?.name === 'AbortError') throw abortError()
          if (error.restart) { await unlink(part).catch(() => {}); forceFull = true }
          if (attempt === 3) throw error
          await new Promise(resolve => setTimeout(resolve, attempt * 250))
        }
      }
    }
    onState({ state: 'ready', progress: { asset: null, downloaded: 0, total: 0 } })
    return dir
  })
}

/** Copy only the fixed, hash-pinned files from a user-selected offline folder. */
export async function importEmbeddingModel(sourceDir, targetDir, { signal, onState = () => {} } = {}) {
  if (typeof sourceDir !== 'string' || sourceDir.trim() === '') throw new Error('请选择模型文件夹')
  await mkdir(targetDir, { recursive: true, mode: 0o700 })
  return withDownloadLock(targetDir, async () => {
    for (const [name, size, expectedDigest] of assets) {
      checkAbort(signal)
      const source = join(sourceDir, basename(name)), target = join(targetDir, basename(name))
      if (await hashFile(target, size, expectedDigest)) continue
      onState({ state: 'importing', progress: { asset: basename(name), downloaded: 0, total: size } })
      if (!await hashFile(source, size, expectedDigest)) throw new Error('离线模型文件缺失或校验失败')
      const temporary = target + '.' + process.pid + '.import'
      try {
        await copyFile(source, temporary)
        checkAbort(signal)
        if (!await hashFile(temporary, size, expectedDigest)) throw new Error('离线模型文件在导入时发生变化')
        if (!await hashFile(target, size, expectedDigest)) {
          await unlink(target).catch(error => { if (error.code !== 'ENOENT') throw error })
          await rename(temporary, target)
        }
      } finally { await unlink(temporary).catch(() => {}) }
      onState({ state: 'importing', progress: { asset: basename(name), downloaded: size, total: size } })
    }
    onState({ state: 'ready', progress: { asset: null, downloaded: 0, total: 0 } })
    return targetDir
  })
}

export class LocalEmbedding {
  #options
  #worker = null
  #workerTimer = null
  #startupReject = null
  #starting = null
  #pending = new Map()
  #sequence = 0
  #abort = new AbortController()
  #disposed = false
  #generation = 0
  #modelDir
  state = 'idle'
  error = null
  progress = null

  constructor(options = {}) { this.#options = options; this.#modelDir = options.modelDir ?? defaultModelDirectory() }

  async #start() {
    if (this.#disposed) throw new Error('embedding disposed')
    if (this.state === 'ready' && this.#worker) return
    if (this.#starting) return this.#starting
    const generation = this.#generation
    this.state = 'preparing'
    this.error = null
    this.#starting = (async () => {
      const ensureModel = this.#options.ensureModel ?? ensureEmbeddingModel
      const modelDir = await ensureModel(this.#modelDir, {
        allowDownload: this.#options.allowDownload, signal: this.#abort.signal,
        onState: value => {
          if (generation !== this.#generation) return
          this.state = value.state
          this.progress = value.progress ?? null
        },
      })
      if (generation !== this.#generation || this.#disposed) throw abortError()
      await new Promise((resolve, reject) => {
        const workerFactory = this.#options.workerFactory ?? ((directory) => new Worker(new URL('./embedding-worker.js', import.meta.url), { workerData: { modelDir: directory } }))
        const worker = this.#worker = workerFactory(modelDir)
        worker.unref()
        this.state = 'loading'
        this.#workerTimer = setTimeout(() => { reject(new Error('本地语义模型加载超时')); worker.terminate() }, 30000)
        this.#startupReject = error => {
          clearTimeout(this.#workerTimer); this.#workerTimer = null
          this.#startupReject = null
          reject(error)
        }
        worker.on('message', message => {
          if (generation !== this.#generation) return
          if (message.ready) {
            clearTimeout(this.#workerTimer); this.#workerTimer = null; this.#startupReject = null
            this.state = 'ready'; this.progress = null; resolve(); return
          }
          const pending = this.#pending.get(message.id)
          if (!pending) return
          this.#pending.delete(message.id); clearTimeout(pending.timer)
          if (message.error) pending.reject(new Error(message.error)); else pending.resolve(message.vectors)
        })
        const fail = error => {
          if (generation !== this.#generation) return
          clearTimeout(this.#workerTimer); this.#workerTimer = null
          this.#startupReject = null
          this.state = 'failed'; this.error = error.message; reject(error)
          for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(error) }
          this.#pending.clear()
        }
        worker.on('error', fail)
        worker.on('exit', code => { if (code !== 0) fail(new Error(`本地语义进程已退出 (${code})`)) })
      })
    })().catch(error => {
      if (generation === this.#generation && error?.name !== 'AbortError') { this.state = 'failed'; this.error = error.message }
      throw error
    }).finally(() => { if (generation === this.#generation) this.#starting = null })
    return this.#starting
  }

  prepare() { return this.#start() }

  async importModel(sourceDir) {
    const previous = this.#starting
    this.cancel()
    await previous?.catch(() => {})
    const importModel = this.#options.importModel ?? importEmbeddingModel
    await importModel(sourceDir, this.#modelDir, {
      signal: this.#abort.signal,
      onState: value => { this.state = value.state; this.progress = value.progress ?? null },
    })
    return this.#start()
  }

  cancel() {
    if (this.#disposed) return
    this.#generation++
    this.#abort.abort()
    this.#abort = new AbortController()
    clearTimeout(this.#workerTimer); this.#workerTimer = null
    this.#startupReject?.(abortError()); this.#startupReject = null
    this.#worker?.terminate(); this.#worker = null
    for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(abortError()) }
    this.#pending.clear()
    this.#starting = null
    this.state = 'idle'; this.error = null; this.progress = null
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
    if (this.#disposed) return
    this.cancel()
    this.#disposed = true
  }
}
