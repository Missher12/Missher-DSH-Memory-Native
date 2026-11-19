/** Three-way, restart-safe Obsidian reconciliation. Files are never overwritten without preserving their bytes. */
import { createHash, randomUUID } from 'node:crypto'
import { statSync, watch } from 'node:fs'
import { mkdir, readdir, readFile, writeFile, rename, link, unlink, lstat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { parseMemoryNote, resolveObsidianTarget, serializeMemory } from './obsidian.js'
import { isKnowledgeFile, parseKnowledgeNote } from './knowledge.js'
import { buildRecord, nextRevision, MEMORY_KINDS, MEMORY_STATUSES, isValidMemoryId } from './records.js'
import { isValidProjectKey } from './paths.js'
import { refreshReadingPages } from './obsidian-reading.js'
import { atomicWritePrivate } from './persistence.js'

const hash = value => createHash('sha256').update(value).digest('hex')
const reconcileTails = new Map()
async function serializeReconcile(stateFile, onQueued, task) {
  const queued = reconcileTails.has(stateFile)
  const previous = reconcileTails.get(stateFile) ?? Promise.resolve()
  let release
  const turn = new Promise(resolve => { release = resolve })
  const tail = previous.then(() => turn)
  reconcileTails.set(stateFile, tail)
  try { onQueued?.({ stateFile, queued }) } catch { /* Test observers never affect reconciliation. */ }
  await previous
  try { return await task() }
  finally {
    release()
    if (reconcileTails.get(stateFile) === tail) reconcileTails.delete(stateFile)
  }
}
const fields = ['kind', 'scope', 'projectKey', 'content', 'topic', 'tags', 'confidence', 'importance', 'status']
const semantic = record => JSON.stringify(fields.map(key => record[key] ?? null))
const textAt = async file => { try { return await readFile(file, 'utf8') } catch (e) { if (e.code === 'ENOENT') return null; throw e } }
async function directory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 })
  if ((await lstat(path)).isSymbolicLink()) throw new Error('同步文件夹不能是符号链接')
}
async function names(path) {
  try { return (await readdir(path, { withFileTypes: true })).filter(e => e.isFile() && e.name.endsWith('.md') && !e.name.startsWith('_')).map(e => e.name).sort() }
  catch (e) { if (e.code === 'ENOENT') return []; throw e }
}
function memoryInput(text, parsed = parseMemoryNote(text)) {
  if (parsed?.data.dsh_memory !== true) throw new Error('不是 DSH 记忆笔记')
  const d = parsed.data
  if (!isValidMemoryId(d.id) || !MEMORY_KINDS.includes(d.kind)) throw new Error('记忆 id 或类型无效')
  if (!['global', 'project'].includes(d.scope) || (d.scope === 'project' && !isValidProjectKey(d.projectKey))) throw new Error('记忆范围无效')
  if (!MEMORY_STATUSES.includes(d.status) || d.status === 'deleted') throw new Error('请在 Memory 中操作遗忘，不要修改笔记状态为 deleted')
  const input = { ...d, projectKey: d.scope === 'global' ? null : d.projectKey, content: parsed.body }
  const built = buildRecord(input, { id: d.id })
  if (!built.ok) throw new Error(built.reason)
  return { ...built.record, status: d.status }
}

export class ObsidianSync {
  constructor({ root, store, index, getConfig, synchronize = () => {}, onKnowledgeChange = () => {}, watcherFactory = watch, onReconcileQueued = () => {} }) {
    Object.assign(this, { root, store, index, getConfig, synchronize, onKnowledgeChange, watcherFactory, onReconcileQueued })
    this.timer = null; this.busy = null; this.stopped = false; this.disposed = false
    this.state = null; this.target = null; this.files = new Map(); this.records = new WeakMap()
    this.last = { at: null, exported: 0, imported: 0, conflicts: [], errors: [] }
    this.watchers = []; this.watchedTarget = null; this.changedFiles = new Set(); this.changedRecordIds = new Set(); this.purgedRecordIds = new Set()
    this.readingChanged = false; this.fullScanRequested = false; this.queue = []; this.changeTimer = null; this.fullScanIntervalMs = 300000
    this.lastFullScanAt = null; this.watcherErrors = 0
    this.selfWrites = new Map(); this.selfDirectoryEvents = new Map(); this.selfWriteTimer = null
    this.unsubscribeStore = this.store.addChangeListener?.(event => this.#authorityChanged(event)) ?? null
  }
  status() {
    return { enabled: this.getConfig()?.autoSync === true, running: this.busy !== null,
      pendingFiles: this.changedFiles.size + this.changedRecordIds.size, fullScanPending: this.fullScanRequested || this.queue.some(item => item.request.fullScan),
      lastFullScanAt: this.lastFullScanAt, watcherErrors: this.watcherErrors, watchersReady: this.watchedTarget !== null, ...this.last }
  }
  #authorityChanged(event) {
    if (this.disposed) return
    if (event.type === 'refresh' || event.type === 'rewrite') this.fullScanRequested = true
    const records = Array.isArray(event.records) ? event.records : []
    for (const record of records) if (typeof record?.id === 'string') this.changedRecordIds.add(record.id)
    if (event.type === 'remove' && typeof event.id === 'string') this.purgedRecordIds.add(event.id)
    if (!records.length && event.type !== 'refresh' && event.type !== 'rewrite') this.fullScanRequested = true
    if (this.getConfig()?.autoSync === true) this.#scheduleWatcherRun()
  }
  #watch(path, prefix, recursive = false) {
    if (this.disposed) return false
    try {
      const watcher = this.watcherFactory(path, { persistent: false, ...(recursive ? { recursive: true } : {}) }, (_event, filename) => {
        if (this.disposed || this.stopped) return
        if (filename === null || filename === undefined) {
          if ((this.selfDirectoryEvents.get(path) ?? 0) > Date.now()) return
          this.fullScanRequested = true
          this.#scheduleWatcherRun()
          return
        }
        const name = String(filename).replaceAll('\\', '/')
        if (this.#isSelfWrite(join(path, name))) return
        if (!name.endsWith('.md') || name.split('/').some(part => part.startsWith('_'))) return
        if (prefix === 'reading') { this.readingChanged = true; this.#scheduleWatcherRun(); return }
        this.changedFiles.add(prefix ? `${prefix}/${name}` : name)
        this.#scheduleWatcherRun()
      })
      watcher.on('error', () => {
        if (this.disposed) return
        this.watcherErrors++; watcher.close(); this.watchers = this.watchers.filter(item => item !== watcher)
        this.watchedTarget = null; this.fullScanRequested = true
        this.#scheduleWatcherRun()
      })
      this.watchers.push(watcher)
      return true
    } catch { this.watcherErrors++; return false }
  }
  #beginSelfWrite(file) {
    const expires = Date.now() + 2000
    this.selfWrites.set(file, { pending: true, expires })
    this.selfDirectoryEvents.set(dirname(file), expires)
    clearTimeout(this.selfWriteTimer)
    this.selfWriteTimer = setTimeout(() => { this.selfWrites.clear(); this.selfDirectoryEvents.clear(); this.selfWriteTimer = null }, 2100)
    this.selfWriteTimer.unref?.()
  }
  #markSelfWrite(file) {
    const expires = Date.now() + 2000
    let stamp = null
    try {
      const info = statSync(file)
      stamp = `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`
    } catch { /* A missing file is also a self-generated result. */ }
    this.selfWrites.set(file, { stamp, expires })
    this.selfDirectoryEvents.set(dirname(file), expires)
    clearTimeout(this.selfWriteTimer)
    this.selfWriteTimer = setTimeout(() => { this.selfWrites.clear(); this.selfDirectoryEvents.clear(); this.selfWriteTimer = null }, 2100)
    this.selfWriteTimer.unref?.()
  }
  #isSelfWrite(file) {
    const mark = this.selfWrites.get(file)
    if (!mark) return false
    if (mark.expires <= Date.now()) { this.selfWrites.delete(file); return false }
    if (mark.pending) return true
    let stamp = null
    try {
      const info = statSync(file)
      stamp = `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`
    } catch { /* Expected for a self-generated deletion. */ }
    if (stamp === mark.stamp) return true
    this.selfWrites.delete(file); this.selfDirectoryEvents.delete(dirname(file))
    return false
  }
  #ensureWatchers(dir) {
    if (this.disposed) return
    if (this.watchedTarget === dir) return
    for (const watcher of this.watchers) watcher.close()
    this.watchers = []; this.watchedTarget = null
    const directories = [[dir, ''], [join(dir, 'knowledge'), 'knowledge'], [join(this.root, 'knowledge'), 'knowledge'],
      ...['', '项目', '主题', '手动修改', '决策', '知识库', '偏好', '经历'].map(name => [join(dir, '阅读', name), 'reading'])]
    let complete = true
    for (const [path, prefix] of directories) complete = this.#watch(path, prefix) && complete
    if (complete) { this.watchedTarget = dir; this.watcherErrors = 0 }
  }
  #scheduleWatcherRun() {
    if (this.disposed) return
    clearTimeout(this.changeTimer)
    this.changeTimer = setTimeout(() => {
      if (this.disposed || this.stopped || this.getConfig()?.autoSync !== true) return
      const fullScan = this.fullScanRequested
      void this.run({ fullScan, automatic: true, files: [...this.changedFiles], recordIds: [...this.changedRecordIds],
        purgedRecordIds: [...this.purgedRecordIds], readingChanged: this.readingChanged }).catch(() => {})
    }, 180)
    this.changeTimer.unref?.()
  }
  start(intervalMs = 300000) {
    if (this.disposed) return
    this.stopped = false
    this.fullScanIntervalMs = Math.max(1, intervalMs)
    const tick = async () => {
      try {
        if (this.getConfig()?.autoSync === true) {
          const fullScan = this.fullScanRequested || this.lastFullScanAt === null || Date.now() - this.lastFullScanAt >= this.fullScanIntervalMs
          if (fullScan) await this.run({ fullScan: true, automatic: true, files: [...this.changedFiles], recordIds: [...this.changedRecordIds],
            purgedRecordIds: [...this.purgedRecordIds], readingChanged: this.readingChanged })
          else if (this.changedFiles.size || this.changedRecordIds.size || this.readingChanged) await this.run({ fullScan: false, automatic: true,
            files: [...this.changedFiles], recordIds: [...this.changedRecordIds], purgedRecordIds: [...this.purgedRecordIds], readingChanged: this.readingChanged })
        }
      } catch { /* status exposes the error */ }
      if (!this.stopped) { this.timer = setTimeout(tick, this.fullScanIntervalMs); this.timer.unref?.() }
    }
    this.timer = setTimeout(tick, Math.min(this.fullScanIntervalMs, 5000)); this.timer.unref?.()
  }
  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.stopped = true; clearTimeout(this.timer); clearTimeout(this.changeTimer); clearTimeout(this.selfWriteTimer)
    for (const watcher of this.watchers) watcher.close()
    this.watchers = []; this.watchedTarget = null
    this.selfWrites.clear(); this.selfDirectoryEvents.clear()
    this.unsubscribeStore?.(); this.unsubscribeStore = null
    this.#drain()
  }
  configurationChanged() {
    if (this.disposed) return Promise.resolve(this.status())
    for (const watcher of this.watchers) watcher.close()
    this.watchers = []; this.watchedTarget = null; this.fullScanRequested = true
    clearTimeout(this.changeTimer)
    if (this.getConfig()?.autoSync !== true || !this.getConfig()?.vaultPath) return Promise.resolve(this.status())
    return this.run({ fullScan: true, automatic: true })
  }
  run(options = null) {
    if (this.disposed) return Promise.resolve(this.last)
    const requested = options && typeof options === 'object' ? options : { fullScan: true }
    const resolution = typeof requested.key === 'string' ? requested : null
    const fullScan = resolution !== null || requested.fullScan !== false
    const files = new Set(Array.isArray(requested.files) ? requested.files.filter(file => typeof file === 'string')
      : requested.files instanceof Set ? [...requested.files].filter(file => typeof file === 'string') : [])
    const recordIds = new Set(Array.isArray(requested.recordIds) ? requested.recordIds.filter(id => typeof id === 'string')
      : requested.recordIds instanceof Set ? [...requested.recordIds].filter(id => typeof id === 'string') : [])
    const purgedRecordIds = new Set(Array.isArray(requested.purgedRecordIds) ? requested.purgedRecordIds.filter(id => typeof id === 'string')
      : requested.purgedRecordIds instanceof Set ? [...requested.purgedRecordIds].filter(id => typeof id === 'string') : [])
    if (fullScan) for (const id of this.purgedRecordIds) purgedRecordIds.add(id)
    const request = { ...requested, fullScan, files, recordIds, purgedRecordIds, readingChanged: requested.readingChanged === true || this.readingChanged }
    if (this.busy) {
      return this.#enqueue(request)
    }
    if (this.queue.length) return this.#enqueue(request)
    return this.#start(request)
  }
  #enqueue(request) {
    const resolution = typeof request.key === 'string'
    let item = !resolution ? this.queue[this.queue.length - 1] : null
    if (item?.resolution) item = null
    if (!item) { item = { request, resolution, waiters: [] }; this.queue.push(item) }
    else item.request = { ...item.request, ...request,
      fullScan: item.request.fullScan || request.fullScan,
      files: new Set([...item.request.files, ...request.files]),
      recordIds: new Set([...item.request.recordIds, ...request.recordIds]),
      purgedRecordIds: new Set([...item.request.purgedRecordIds, ...request.purgedRecordIds]),
      readingChanged: item.request.readingChanged || request.readingChanged }
    const promise = new Promise((resolve, reject) => item.waiters.push({ resolve, reject }))
    this.#drain()
    return promise
  }
  #start(request) {
    if (request.fullScan) {
      this.changedFiles.clear(); this.changedRecordIds.clear(); this.purgedRecordIds.clear()
    } else {
      for (const file of request.files) this.changedFiles.delete(file)
      for (const id of request.recordIds) this.changedRecordIds.delete(id)
      for (const id of request.purgedRecordIds) this.purgedRecordIds.delete(id)
    }
    if (request.readingChanged) this.readingChanged = false
    if (request.fullScan) this.fullScanRequested = false
    const running = this.reconcile(request).catch(error => {
      this.last = { ...this.last, at: Date.now(), errors: [{ file: '', message: error.message }] }
      throw error
    }).finally(() => {
      if (this.busy === running) this.busy = null
      this.#drain()
    })
    this.busy = running
    return running
  }
  #drain() {
    if (this.disposed) {
      const error = new Error('Obsidian sync controller is disposed')
      for (const item of this.queue.splice(0)) for (const waiter of item.waiters) waiter.reject(error)
      return
    }
    if (this.busy || !this.queue.length) return
    const item = this.queue.shift()
    const running = this.#start(item.request)
    running.then(value => item.waiters.forEach(waiter => waiter.resolve(value)),
      error => item.waiters.forEach(waiter => waiter.reject(error)))
  }
  resolve({ key, token, side }) {
    if (typeof key !== 'string' || typeof token !== 'string' || !['memory', 'vault'].includes(side)) return Promise.reject(new Error('无效的冲突处理请求'))
    return this.run({ key, token, side })
  }
  async cachedText(file) {
    const info = await lstat(file)
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('同步来源必须是普通文件')
    const stamp = `${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`
    const cached = this.files.get(file)
    if (cached?.stamp === stamp) return cached.text
    const text = await readFile(file, 'utf8'); this.files.set(file, { stamp, text }); return text
  }
  async existingText(file) {
    try { return await this.cachedText(file) } catch (e) { if(e.code === 'ENOENT') return null; throw e }
  }
  memory(record) {
    let cached = this.records.get(record)
    if (!cached || cached.revision !== record.revision) {
      cached = { text: serializeMemory(record), value: semantic(record), revision: record.revision }
      this.records.set(record, cached)
    }
    return cached
  }
  async preserve(dir, name, text) {
    if (text === null) return null
    await directory(dir)
    const file = join(dir, name)
    this.#beginSelfWrite(file)
    try { await writeFile(file, text, { flag: 'wx', mode: 0o600 }) }
    catch (e) { if (e.code !== 'EEXIST') throw e; if (await textAt(file) !== text) throw new Error('恢复副本发生冲突') }
    this.#markSelfWrite(file)
    return file
  }
  async replace(file, before, after, vaultDir) {
    if (before === after) return
    await directory(join(file, '..'))
    if (await textAt(file) !== before) throw new Error('文件已变化，请等待下一轮同步')
    this.#beginSelfWrite(file)
    if (before !== null) {
      const history = join(vaultDir, '_history'); await directory(history)
      const saved = join(history, `${Date.now()}-${randomUUID()}-${basename(file)}`)
      await rename(file, saved)
      if (await textAt(saved) !== before) {
        try { await link(saved, file) } catch (e) { if (e.code !== 'EEXIST') throw e }
        throw new Error('文件在同步时变化，两个版本已保留')
      }
    }
    if (after !== null) {
      const temp = join(vaultDir, `_sync-${randomUUID()}.tmp`)
      await writeFile(temp, after, { flag: 'wx', mode: 0o600 })
      try { await link(temp, file) }
      catch (e) {
        await this.preserve(join(vaultDir, '_conflicts'), `${randomUUID()}-pending.md`, after)
        throw new Error(`文件在同步时变化，待写入版本已保留：${e.code}`)
      } finally { await unlink(temp) }
    }
    this.#markSelfWrite(file)
    this.files.delete(file)
  }
  async reconcile(options = {}) {
    if (this.disposed) return this.last
    const resolution = typeof options.key === 'string' ? options : null
    const fullScan = options.fullScan !== false
    const changedFiles = new Set(options.files instanceof Set ? options.files : Array.isArray(options.files) ? options.files : [])
    const changedRecordIds = new Set(options.recordIds instanceof Set ? options.recordIds : Array.isArray(options.recordIds) ? options.recordIds : [])
    const purgedRecordIds = new Set(options.purgedRecordIds instanceof Set ? options.purgedRecordIds : Array.isArray(options.purgedRecordIds) ? options.purgedRecordIds : [])
    const config = this.getConfig()
    if (!config?.vaultPath) return this.last
    const { dir } = resolveObsidianTarget(config.vaultPath, config.folder)
    const stateFile = join(this.root, `obsidian-state-${hash(dir).slice(0, 20)}.json`)
    return serializeReconcile(stateFile, this.onReconcileQueued, () => {
      if (this.disposed) return this.last
      return this.#reconcile(options, config, dir, stateFile,
        { resolution, fullScan, changedFiles, changedRecordIds, purgedRecordIds })
    })
  }
  async #reconcile(options, config, dir, stateFile, { resolution, fullScan, changedFiles, changedRecordIds, purgedRecordIds }) {
    await directory(dir); await directory(join(dir, 'knowledge'))
    const targetChanged = this.target !== dir
    let state = null
    try { state = JSON.parse(await textAt(stateFile)) } catch { /* An absent baseline means conflict, never overwrite. */ }
    this.state = state?.version === 1 && state.entries && typeof state.entries === 'object' ? state : { version: 1, entries: {} }
    this.state.purged = this.state.purged && typeof this.state.purged === 'object' ? this.state.purged : {}
    if (targetChanged) { this.target = dir; this.files.clear(); this.readingSignature = null }
    this.synchronize()
    const records = new Map(this.store.listAll({ includeDeleted: true }).map(r => [r.id, r]))
    for (const id of this.store.purgedIds?.() ?? []) if (!records.has(id)) purgedRecordIds.add(id)
    const pairs = new Map(), blocked = new Set()
    const result = { at: Date.now(), dir, mode: fullScan ? 'full' : 'incremental', exported: 0, imported: 0, conflicts: [], errors: [] }
    const rootFiles = fullScan ? await names(dir) : [...changedFiles].filter(file => !file.startsWith('knowledge/') && !file.startsWith('阅读/'))
    const changedRootFiles = new Set(rootFiles)
    if (fullScan) {
      for (const [id, record] of records) {
        const key = `memory:${id}`, previous = this.state.entries[key]
        delete this.state.purged[id]
        pairs.set(key, { key, id, record, file: previous?.file ?? `${id}.md`, kind: 'memory' })
      }
      for (const [key, entry] of Object.entries(this.state.entries)) {
        if (!key.startsWith('memory:')) continue
        const id = key.slice('memory:'.length)
        if (!records.has(id) && (this.state.purged[id] === true || purgedRecordIds.has(id))) {
          pairs.set(key, { key, id, record: null, file: entry.file, kind: 'memory', purged: true })
        }
      }
    } else {
      for (const [key, entry] of Object.entries(this.state.entries)) {
        if (!key.startsWith('memory:') || !changedRootFiles.has(entry.file)) continue
        const id = key.slice('memory:'.length)
        pairs.set(key, { key, id, record: records.get(id) ?? null, file: entry.file, kind: 'memory' })
      }
      for (const id of changedRecordIds) {
        const key = `memory:${id}`, previous = this.state.entries[key]
        if (pairs.has(key)) continue
        const record = records.get(id) ?? null
        if (!record && !previous) continue
        pairs.set(key, { key, id, record, file: previous?.file ?? `${id}.md`, kind: 'memory',
          purged: options.purgedRecordIds instanceof Set ? options.purgedRecordIds.has(id) : Array.isArray(options.purgedRecordIds) && options.purgedRecordIds.includes(id) })
      }
    }
    const seen = new Set()
    for (const file of rootFiles) {
      try {
        const text = await this.existingText(join(dir, file))
        if (text === null) continue
        const parsed = parseMemoryNote(text)
        if (parsed?.data.dsh_memory !== true) continue
        const input = memoryInput(text, parsed), key = `memory:${input.id}`
        if (seen.has(key)) { blocked.add(key); throw new Error('多个笔记使用相同记忆 id') }
        seen.add(key)
        const previousFile = this.state.entries[key]?.file
        if (previousFile && previousFile !== file && !changedRootFiles.has(previousFile) && await this.existingText(join(dir, previousFile)) !== null) {
          blocked.add(key); throw new Error('多个笔记使用相同记忆 id')
        }
        const record = records.get(input.id)
        if (!record && (this.state.purged[input.id] === true || purgedRecordIds.has(input.id))) {
          pairs.set(key, { key, id: input.id, record: null, file, kind: 'memory', input, diskText: text, purged: true })
          continue
        }
        if (record) delete this.state.purged[input.id]
        if (record && (record.scope !== input.scope || record.projectKey !== input.projectKey)) { blocked.add(key); throw new Error('笔记不能移动已有记忆的范围') }
        pairs.set(key, { key, id: input.id, record, file, kind: 'memory', input, diskText: text })
      } catch (e) {
        for (const [key, pair] of pairs) if (pair.file === file) blocked.add(key)
        result.errors.push({ file, message: e.message })
      }
    }
    const knowledgeRoot = join(this.root, 'knowledge')
    await directory(knowledgeRoot)
    const localKnowledgeFiles = fullScan ? await names(knowledgeRoot) : []
    const vaultKnowledgeFiles = fullScan ? await names(join(dir, 'knowledge')) : [...changedFiles]
      .filter(file => file.startsWith('knowledge/')).map(file => file.slice('knowledge/'.length))
    const knowledgeFiles = new Set([...localKnowledgeFiles, ...vaultKnowledgeFiles])
    for (const file of knowledgeFiles) {
      if (isKnowledgeFile(file)) pairs.set(`knowledge:${file}`, { key: `knowledge:${file}`, file: `knowledge/${file}`, kind: 'knowledge' })
    }
    let resolved = false
    let knowledgeChanged = false
    let readingDirty = options.readingChanged === true || this.readingChanged || fullScan
    for (const pair of pairs.values()) {
      if (blocked.has(pair.key)) continue
      try {
        const vaultFile = join(dir, pair.file), localFile = pair.kind === 'knowledge' ? join(this.root, pair.file) : null
        let right = pair.diskText ?? await this.existingText(vaultFile)
        let left = pair.kind === 'memory' ? (pair.record && pair.record.status !== 'deleted' ? this.memory(pair.record).text : null) : await this.existingText(localFile)
        if (pair.record?.status === 'deleted') {
          if (right !== null) await this.replace(vaultFile, right, null, dir)
          delete this.state.entries[pair.key]
          if (pair.kind === 'memory') readingDirty = true
          continue
        }
        if (pair.purged) {
          if (right !== null) await this.replace(vaultFile, right, null, dir)
          delete this.state.entries[pair.key]; this.state.purged[pair.id] = true; readingDirty = true
          continue
        }
        let lv = left, rv = right
        if (pair.kind === 'memory') {
          lv = left === null ? null : this.memory(pair.record).value
          if (right !== null) {
            const input = pair.diskText === right && pair.input ? pair.input : memoryInput(right)
            if (input.id !== pair.id) throw new Error('笔记 id 已变化')
            pair.input = input; rv = semantic(input)
          }
        } else {
          for (const value of [left, right]) if (value !== null && parseKnowledgeNote(value).data.dsh_knowledge !== true) throw new Error('不是 DSH 知识笔记')
        }
        const lh = lv === null ? null : hash(lv), rh = rv === null ? null : hash(rv)
        const previous = this.state.entries[pair.key]
        const token = hash(JSON.stringify([left, right]))
        let direction = null
        if (resolution?.key === pair.key) {
          if (resolution.token !== token) throw new Error('冲突内容已变化，请刷新后重新选择')
          direction = resolution.side === 'memory' ? 'export' : 'import'; resolved = true
        } else if (lh === rh) {
          if (previous?.file !== pair.file) readingDirty = true
          this.state.entries[pair.key] = { left: lh, right: rh, file: pair.file }; continue
        } else if (!previous && left === null) direction = 'import'
        else if (!previous && right === null) direction = 'export'
        else if (left !== null && right !== null && previous) {
          if (lh === previous.left && rh !== previous.right) direction = 'import'
          else if (rh === previous.right && lh !== previous.left) direction = 'export'
        }
        if (direction === null) {
          const folder = join(dir, '_conflicts', hash(pair.key).slice(0, 16))
          const copies = (await Promise.all([
            this.preserve(folder, `${token}-memory.md`, left),
            this.preserve(folder, `${token}-obsidian.md`, right),
          ])).filter(Boolean)
          result.conflicts.push({ key: pair.key, file: pair.file, token, copies, reason: left === null || right === null ? '一侧已删除，另一侧内容仍保留' : '两侧内容不同，未自动覆盖', memoryText: left, vaultText: right })
          continue
        }
        const currentConfig = this.getConfig()
        if (currentConfig.vaultPath !== config.vaultPath || currentConfig.folder !== config.folder || (config.autoSync && !currentConfig.autoSync)) throw new Error('同步设置已变化，本轮写入停止')
        if (direction === 'export') {
          // Recheck the authority after asynchronous file reads before publishing.
          if (pair.kind === 'memory' && this.store.find(pair.id, [{scope:pair.record.scope,projectKey:pair.record.projectKey}]) !== pair.record) throw new Error('记忆已变化，请等待下一轮同步')
          await this.replace(vaultFile, right, left, dir); right = left; rv = lv; result.exported++
          if (pair.kind === 'knowledge') knowledgeChanged = true
          readingDirty = true
        } else {
          if (await textAt(vaultFile) !== right) throw new Error('笔记已变化，请等待下一轮同步')
          if (pair.kind === 'knowledge') { await this.replace(localFile, left, right, dir); knowledgeChanged = true; readingDirty = true }
          else {
            this.synchronize()
            const current = pair.record && this.store.find(pair.id, [{scope:pair.record.scope,projectKey:pair.record.projectKey}])
            if (pair.record && current !== pair.record) throw new Error('记忆已变化，请等待下一轮同步')
            if (right === null) { this.store.remove(pair.id, [{scope:current.scope,projectKey:current.projectKey}]); this.index.remove(pair.id) }
            else {
              const input = pair.input
              let record
              if (current) {
                const patch = Object.fromEntries(fields.filter(k => !['scope','projectKey'].includes(k)).map(k => [k,input[k]]))
                const normalized = nextRevision(current, patch)
                record = fields.every(k => isDeepStrictEqual(current[k], normalized[k])) ? current : this.store.update(pair.id, patch, [{scope:current.scope,projectKey:current.projectKey}])
              } else {
                const built = this.store.write(input, {id:pair.id}); if (!built.ok) throw new Error(built.reason); record = built.record
              }
              this.index.upsert(record)
            }
            readingDirty = true
          }
          lv = rv; result.imported++
        }
        this.state.entries[pair.key] = { left: lv === null ? null : hash(lv), right: rv === null ? null : hash(rv), file: pair.file }
      } catch (e) {
        if (resolution?.key === pair.key) throw e
        result.errors.push({ file: pair.file, message: e.message })
      }
    }
    if (resolution && !resolved) throw new Error('冲突内容已变化或已经解决')
    if (knowledgeChanged) {
      try { this.onKnowledgeChange() } catch { /* Recall refresh is fail-soft; the next edit retries it. */ }
    }
    if (knowledgeChanged) readingDirty = true
    if (readingDirty) await refreshReadingPages(this, dir, config, result, { force: fullScan || options.readingChanged === true })
    const serialized = JSON.stringify(this.state)
    if (await textAt(stateFile) !== serialized) {
      atomicWritePrivate(stateFile, serialized)
    }
    this.#ensureWatchers(dir)
    if (fullScan) this.lastFullScanAt = result.at
    for (const error of result.errors) if (error.file) this.changedFiles.add(error.file)
    this.last = result
    return result
  }
}
