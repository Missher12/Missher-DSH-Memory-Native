/** Three-way, restart-safe Obsidian reconciliation. Files are never overwritten without preserving their bytes. */
import { createHash, randomUUID } from 'node:crypto'
import { linkSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, watch, writeFileSync } from 'node:fs'
import { mkdir, readdir, readFile, writeFile, rename, link, unlink, lstat } from 'node:fs/promises'
import { basename, dirname, join, sep } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { parseMemoryNote, publishNewKnowledge, resolveObsidianTarget, serializeMemory } from './obsidian.js'
import { isKnowledgeFile, knowledgeBinding, parseKnowledgeNote } from './knowledge.js'
import { hasKnowledgeLink, knowledgeAuthority, knowledgeLineageAllowed, withKnowledgeWriter } from './knowledge-authority.js'
import { buildRecord, nextRevision, MEMORY_KINDS, MEMORY_STATUSES, isValidMemoryId } from './records.js'
import { isValidProjectKey } from './paths.js'
import { isGeneratedReadingPage, READING_DIRECTORIES, refreshReadingPages } from './obsidian-reading.js'
import { atomicWritePrivate } from './persistence.js'
import { memoryNoteDigests, obsidianSyncStateFile, readExportedKnowledge, readPurgedNoteDigests } from './obsidian-note.js'
import { conflictCopyName, findManagedCopies, managedHistoryName, recoverManagedCleanup, removeManagedCopies } from './obsidian-artifacts.js'

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
const PAIR_PROOF_VERSION = 1
const signature = info => [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':')
async function matchesFile(file, expected) {
  try {
    const info = await lstat(file, { bigint: true })
    return info.isFile() && signature(info) === expected
  } catch { return false }
}
const cleanReceipt = entry => typeof entry?.left === 'string' && entry.left === entry.right && entry.proof?.version === PAIR_PROOF_VERSION &&
  typeof entry.proof?.left === 'string' && typeof entry.proof?.right === 'string'
const textAt = async file => { try { return await readFile(file, 'utf8') } catch (e) { if (e.code === 'ENOENT') return null; throw e } }
async function directory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 })
  if ((await lstat(path)).isSymbolicLink()) throw new Error('同步文件夹不能是符号链接')
}
function directoryIdentity(path) {
  try {
    const info = lstatSync(path)
    return info.isDirectory() ? `${info.dev}:${info.ino}` : null
  } catch { return null }
}
async function names(path) {
  try { return (await readdir(path, { withFileTypes: true })).filter(e => e.isFile() && e.name.endsWith('.md') && !e.name.startsWith('_')).map(e => e.name).sort() }
  catch (e) { if (e.code === 'ENOENT') return []; throw e }
}
function regularText(file) {
  try {
    if (!lstatSync(file).isFile()) throw new Error('同步来源必须是普通文件')
    return readFileSync(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

function noteBinding(text) {
  if (text === null) return null
  const { data } = parseKnowledgeNote(text)
  if (data.dsh_knowledge !== true) throw new Error('不是 DSH 知识笔记')
  return knowledgeBinding(data)
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
    this.watchedPaths = new Map(); this.watchTarget = null; this.watchedTarget = null
    this.changedFiles = new Set(); this.changedRecordIds = new Set(); this.purgedRecordIds = new Set()
    this.fullScanRequested = false; this.queue = []; this.changeTimer = null; this.fullScanIntervalMs = 300000
    this.lastFullScanAt = null; this.watcherErrors = 0
    this.selfWrites = new Map(); this.selfDirectoryEvents = new Map(); this.selfWriteTimer = null
    this.unsubscribeStore = this.store.addChangeListener?.(event => this.#authorityChanged(event)) ?? null
  }
  status() {
    return { enabled: this.getConfig()?.autoSync === true, running: this.busy !== null,
      pendingFiles: this.changedFiles.size + this.changedRecordIds.size, fullScanPending: this.fullScanRequested || this.queue.some(item => item.request.fullScan),
      lastFullScanAt: this.lastFullScanAt, watcherErrors: this.watcherErrors, watchersReady: this.watchedTarget !== null,
      ...this.last, conflicts: this.#visibleConflicts(this.last.conflicts) }
  }
  #visibleConflicts(conflicts) {
    const check = knowledgeAuthority(this.store)
    return conflicts.filter(item => (item.knowledgeLinks ?? []).every(binding => check(binding).allowed) &&
      (!item.memoryLink || check(item.memoryLink).allowed))
  }
  #checkDestination(config) {
    const current = this.getConfig()
    if (this.disposed || current.vaultPath !== config.vaultPath || current.folder !== config.folder ||
        config.autoSync && !current.autoSync) throw new Error('同步设置已变化，本轮写入停止')
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
  #closeWatcher(path) {
    const entry = this.watchedPaths.get(path)
    this.watchedPaths.delete(path)
    entry?.watcher.close()
    this.watchedTarget = null
  }
  #closeWatchers() {
    for (const path of this.watchedPaths.keys()) this.#closeWatcher(path)
    this.watchTarget = null
  }
  #watchDirectoryChanged(path) {
    const entry = this.watchedPaths.get(path)
    return entry && entry.identity !== directoryIdentity(path)
  }
  #queueReadingAudit(directory, replaceWatches) {
    if (replaceWatches) {
      // A watcher can stay bound to the old inode after the path is moved.
      const path = join(this.watchTarget, directory)
      for (const watched of this.watchedPaths.keys()) {
        if (watched === path || watched.startsWith(path + sep)) this.#closeWatcher(watched)
      }
    }
    this.changedFiles.add(`${directory}/`)
    this.#scheduleWatcherRun()
  }
  #watch(path, prefix) {
    if (this.disposed) return false
    const reading = READING_DIRECTORIES.includes(prefix)
    const identity = reading ? directoryIdentity(path) : null
    if (reading && identity === null) return false
    try {
      const watcher = this.watcherFactory(path, { persistent: false }, (_event, filename) => {
        if (this.disposed || this.stopped || this.watchedPaths.get(path)?.watcher !== watcher) return
        if (filename === null || filename === undefined) {
          // Directory-only notifications can include a user's edit during
          // the self-write window. Audit the affected directory.
          if (reading) {
            this.#queueReadingAudit(prefix, this.#watchDirectoryChanged(path))
            return
          }
          if ((this.selfDirectoryEvents.get(path) ?? 0) > Date.now()) return
          this.fullScanRequested = true
          this.#scheduleWatcherRun()
          return
        }
        const name = String(filename).replaceAll('\\', '/')
        const relativeFile = prefix ? `${prefix}/${name}` : name
        if (reading && name === basename(path) && this.#watchDirectoryChanged(path)) {
          this.#queueReadingAudit(prefix, true)
          return
        }
        if (READING_DIRECTORIES.includes(relativeFile) && this.#watchDirectoryChanged(join(this.watchTarget, relativeFile))) {
          this.#queueReadingAudit(relativeFile, true)
          return
        }
        if (relativeFile.startsWith('阅读/') && !isGeneratedReadingPage(relativeFile)) return
        if (this.#isSelfWrite(join(path, name))) return
        if (!name.endsWith('.md') || name.split('/').some(part => part.startsWith('_'))) return
        this.changedFiles.add(relativeFile)
        this.#scheduleWatcherRun()
      })
      watcher.on('error', () => {
        if (this.disposed || this.watchedPaths.get(path)?.watcher !== watcher) return
        this.#closeWatcher(path)
        this.watcherErrors++; this.fullScanRequested = true
        this.#scheduleWatcherRun()
      })
      this.watchedPaths.set(path, { watcher, identity })
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
      stamp = signature(lstatSync(file, { bigint: true }))
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
      stamp = signature(lstatSync(file, { bigint: true }))
    } catch { /* Expected for a self-generated deletion. */ }
    if (stamp === mark.stamp) return true
    this.selfWrites.delete(file); this.selfDirectoryEvents.delete(dirname(file))
    return false
  }
  #ensureWatchers(dir, includeReading = true) {
    if (this.disposed) return
    if (this.watchTarget !== dir) {
      this.#closeWatchers()
      this.watchTarget = dir
    }
    if (!includeReading && this.watchedTarget === dir) return
    const directories = [[dir, ''], [join(dir, 'knowledge'), 'knowledge'], [join(this.root, 'knowledge'), 'knowledge'],
      ...(includeReading ? READING_DIRECTORIES.map(name => [join(dir, name), name]) : [])]
    let complete = true
    for (const [path, prefix] of directories) {
      if (READING_DIRECTORIES.includes(prefix) && this.#watchDirectoryChanged(path)) this.#closeWatcher(path)
      if (prefix.startsWith('阅读/') && !this.watchedPaths.has(join(dir, '阅读'))) {
        this.#closeWatcher(path)
        complete = false
        continue
      }
      if (this.watchedPaths.has(path)) continue
      complete = this.#watch(path, prefix) && complete
    }
    if (complete && includeReading) { this.watchedTarget = dir; this.watcherErrors = 0 }
  }
  #scheduleWatcherRun() {
    if (this.disposed) return
    clearTimeout(this.changeTimer)
    this.changeTimer = setTimeout(() => {
      if (this.disposed || this.stopped || this.getConfig()?.autoSync !== true) return
      const fullScan = this.fullScanRequested
      void this.run({ fullScan, automatic: true, files: [...this.changedFiles], recordIds: [...this.changedRecordIds],
        purgedRecordIds: [...this.purgedRecordIds] }).catch(() => {})
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
            purgedRecordIds: [...this.purgedRecordIds] })
          else if (this.changedFiles.size || this.changedRecordIds.size) await this.run({ fullScan: false, automatic: true,
            files: [...this.changedFiles], recordIds: [...this.changedRecordIds], purgedRecordIds: [...this.purgedRecordIds] })
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
    this.#closeWatchers()
    this.selfWrites.clear(); this.selfDirectoryEvents.clear()
    this.unsubscribeStore?.(); this.unsubscribeStore = null
    this.#drain()
  }
  configurationChanged() {
    if (this.disposed) return Promise.resolve(this.status())
    this.#closeWatchers()
    this.fullScanRequested = true
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
    const request = { ...requested, fullScan, files, recordIds, purgedRecordIds }
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
      purgedRecordIds: new Set([...item.request.purgedRecordIds, ...request.purgedRecordIds]) }
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
    const info = await lstat(file, { bigint: true })
    if (!info.isFile()) throw new Error('同步来源必须是普通文件')
    const stamp = signature(info)
    const cached = this.files.get(file)
    if (cached?.stamp === stamp) return cached.text
    const text = await readFile(file, 'utf8')
    if (!await matchesFile(file, stamp)) {
      throw Object.assign(new Error('文件在读取时变化，等待下一轮同步'), { code: 'ESTALE' })
    }
    this.files.set(file, { stamp, text })
    return text
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
  #memoryStamp(record) {
    const key = record.scope === 'global' ? 'global' : 'project:' + record.projectKey
    const state = this.store.snapshot().get(key)
    return state?.records.get(record.id) === record && !state.intent && typeof state.stamp === 'string'
      ? key + ':' + state.stamp : null
  }
  async verifiedTextStamp(file, text, relativeFile) {
    try {
      const cached = this.files.get(file)
      if (cached?.text === text) return cached.stamp
      if (await this.existingText(file) === text) return this.files.get(file)?.stamp
    } catch (error) {
      if (error?.code !== 'ESTALE') return null
    }
    // An edit during publication is real input, even if fs.watch drops it.
    this.changedFiles.add(relativeFile)
    this.#scheduleWatcherRun()
    return null
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
  async replace(file, before, after, vaultDir, commit, managed) {
    if (before === after) return
    await directory(join(file, '..'))
    if (commit) return commit(() => this.#replaceLocked(file, before, after, vaultDir, managed))
    if (await textAt(file) !== before) throw new Error('文件已变化，请等待下一轮同步')
    this.#beginSelfWrite(file)
    if (before !== null) {
      const history = join(vaultDir, '_history'); await directory(history)
      const name = managed ? managedHistoryName(managed.kind, managed.hash) : `${Date.now()}-${randomUUID()}-${basename(file)}`
      const saved = join(history, name)
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

  #preserveLocked(dir, name, text) {
    if (text === null) return null
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    if (!lstatSync(dir).isDirectory()) throw new Error('同步文件夹不能是符号链接')
    const path = join(dir, name)
    if (publishNewKnowledge(path, text) === 'conflict') throw new Error('恢复副本发生冲突')
    this.#markSelfWrite(path)
    return path
  }

  #replaceLocked(file, before, after, dir, managed) {
    this.#beginSelfWrite(file)
    let saved
    try {
      if (before !== null) {
        const history = join(dir, '_history')
        mkdirSync(history, { recursive: true, mode: 0o700 })
        if (!lstatSync(history).isDirectory()) throw new Error('同步文件夹不能是符号链接')
        const name = managed ? managedHistoryName(managed.kind, managed.hash) : `${Date.now()}-${randomUUID()}-${basename(file)}`
        const path = join(history, name)
        renameSync(file, path)
        saved = path
        if (regularText(saved) !== before) throw new Error('文件在同步时变化，两个版本已保留')
      }
      if (after !== null && publishNewKnowledge(file, after) === 'conflict') throw new Error('文件在同步时变化，两个版本已保留')
    } catch (error) {
      if (saved) {
        try { linkSync(saved, file) } catch (reason) { if (reason.code !== 'EEXIST') throw reason }
      }
      throw error
    } finally {
      this.#markSelfWrite(file)
      this.files.delete(file)
    }
    // A plain generated reading page is already staged and checked. If the
    // process stops before this point, the next full scan retires that stage.
    if (saved && managed?.kind === 'reading' && regularText(saved) === before) unlinkSync(saved)
  }
  async reconcile(options = {}) {
    if (this.disposed) return this.last
    const resolution = typeof options.key === 'string' ? options : null
    const fullScan = options.fullScan !== false
    const changedFiles = new Set(options.files instanceof Set ? options.files : Array.isArray(options.files) ? options.files : [])
    const changedRecordIds = new Set(options.recordIds instanceof Set ? options.recordIds : Array.isArray(options.recordIds) ? options.recordIds : [])
    const purgedRecordIds = new Set(options.purgedRecordIds instanceof Set ? options.purgedRecordIds : Array.isArray(options.purgedRecordIds) ? options.purgedRecordIds : [])
    const config = { ...this.getConfig() }
    if (!config?.vaultPath) return this.last
    const { dir } = resolveObsidianTarget(config.vaultPath, config.folder)
    const stateFile = obsidianSyncStateFile(this.root, dir)
    return serializeReconcile(stateFile, this.onReconcileQueued, () => {
      if (this.disposed) return this.last
      return this.#reconcile(options, config, dir, stateFile,
        { resolution, fullScan, changedFiles, changedRecordIds, purgedRecordIds })
    })
  }
  async #reconcile(options, config, dir, stateFile, { resolution, fullScan, changedFiles, changedRecordIds, purgedRecordIds }) {
    await directory(dir); await directory(join(dir, 'knowledge'))
    const knowledgeRoot = join(this.root, 'knowledge')
    await directory(knowledgeRoot)
    const targetChanged = this.target !== dir
    let state = null
    try { state = JSON.parse(await textAt(stateFile)) } catch { /* An absent baseline means conflict, never overwrite. */ }
    this.state = state?.version === 1 && state.entries && typeof state.entries === 'object' ? state : { version: 1, entries: {} }
    this.state.purged = this.state.purged && typeof this.state.purged === 'object' ? this.state.purged : {}
    if (targetChanged) { this.target = dir; this.files.clear() }
    this.#ensureWatchers(dir, false)
    this.synchronize()
    const result = { at: Date.now(), dir, mode: fullScan ? 'full' : 'incremental', exported: 0, imported: 0,
      purgedCopies: 0, conflicts: [], errors: [] }
    this.#checkDestination(config)
    recoverManagedCleanup(this.root, dir, result)
    const readingPaths = new Set([...changedFiles].filter(file => isGeneratedReadingPage(file) || READING_DIRECTORIES.includes(file.slice(0, -1)) && file.endsWith('/')))
    if (!fullScan && !changedFiles.size && !changedRecordIds.size && !purgedRecordIds.size) {
      this.#ensureWatchers(dir)
      this.last = result
      return result
    }
    const records = new Map(this.store.listAll({ includeDeleted: true }).map(r => [r.id, r]))
    const retired = this.store.purgedIds()
    const purged = new Set([...retired].filter(id => !records.has(id)))
    const notifiedPurge = [...purgedRecordIds].some(id => retired.has(id))
    for (const id of purged) purgedRecordIds.add(id)
    const digests = retired.size
      ? new Map([...readPurgedNoteDigests(this.root)].filter(([id]) => retired.has(id))) : new Map()
    const manualExports = readExportedKnowledge(this.root, dir)
    const removals = new Map(), softDeleted = new Map()
    const noteRemoval = (id, file, right, record, previous) => {
      if (right === null) return
      const hashValue = hash(right)
      if (purged.has(id) && (digests.get(id)?.has(hashValue) || previous?.generated === hashValue)) {
        removals.set(file, hashValue)
      } else if (record?.status === 'deleted') {
        const scope = { scope: record.scope, projectKey: record.projectKey }
        if (previous?.generated === hashValue || memoryNoteDigests(this.store.history(id, [scope])).has(hashValue)) {
          softDeleted.set(file, { hash: hashValue, id, scope })
        }
      }
    }
    const pairs = new Map(), blocked = new Set()
    // Enumerate the same files as a full scan. A receipt can only save the
    // body read after both sides of that exact pair have been checked.
    const reuse = fullScan && options.automatic === true && !resolution
    const previousFiles = new Map()
    if (reuse) for (const [key, entry] of Object.entries(this.state.entries)) {
      if (!key.startsWith('memory:') || !cleanReceipt(entry)) continue
      previousFiles.set(entry.file, previousFiles.has(entry.file) ? null : key)
    }
    const verifiedRecords = new Map()
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
        const known = previousFiles.get(file)
        if (known) {
          const pair = pairs.get(known)
          const previous = this.state.entries[known], record = pair?.record
          if (record && record.status !== 'deleted' && !purged.has(record.id) &&
              await matchesFile(join(dir, file), previous.proof.right)) {
            const stamp = this.#memoryStamp(record)
            if (stamp && (stamp === previous.proof.left || hash(semantic(record)) === previous.left)) {
              if (seen.has(known)) { blocked.add(known); throw new Error('多个笔记使用相同记忆 id') }
              seen.add(known)
              verifiedRecords.set(known, record)
              pairs.delete(known)
              continue
            }
          }
        }
        const text = await this.existingText(join(dir, file))
        if (text === null) continue
        const parsed = parseMemoryNote(text)
        if (parsed?.data.dsh_memory !== true) continue
        const input = memoryInput(text, parsed), key = `memory:${input.id}`
        const record = records.get(input.id)
        if (purged.has(input.id) || record?.status === 'deleted' || !record && this.state.purged[input.id] === true) {
          noteRemoval(input.id, file, text, record, this.state.entries[key])
          pairs.set(key, { key, id: input.id, record, file, kind: 'memory', input, diskText: text,
            purged: !record && (purged.has(input.id) || this.state.purged[input.id] === true) })
          continue
        }
        if (seen.has(key)) { blocked.add(key); throw new Error('多个笔记使用相同记忆 id') }
        seen.add(key)
        const previousFile = this.state.entries[key]?.file
        if (previousFile && previousFile !== file && !changedRootFiles.has(previousFile) && await this.existingText(join(dir, previousFile)) !== null) {
          blocked.add(key); throw new Error('多个笔记使用相同记忆 id')
        }
        if (record) delete this.state.purged[input.id]
        if (record && (record.scope !== input.scope || record.projectKey !== input.projectKey)) { blocked.add(key); throw new Error('笔记不能移动已有记忆的范围') }
        pairs.set(key, { key, id: input.id, record, file, kind: 'memory', input, diskText: text })
      } catch (e) {
        for (const [key, pair] of pairs) if (pair.file === file) blocked.add(key)
        result.errors.push({ file, message: e.message })
      }
    }
    const localKnowledgeFiles = fullScan ? await names(knowledgeRoot) : []
    const vaultKnowledgeFiles = fullScan ? await names(join(dir, 'knowledge')) : [...changedFiles]
      .filter(file => file.startsWith('knowledge/')).map(file => file.slice('knowledge/'.length))
    const knowledgeFiles = new Set([...localKnowledgeFiles, ...vaultKnowledgeFiles])
    if (!fullScan && (changedRecordIds.size || purgedRecordIds.size)) {
      for (const [key, entry] of Object.entries(this.state.entries)) {
        if (key.startsWith('knowledge:') && entry.knowledgeLinks?.some(binding =>
          changedRecordIds.has(binding.memoryId) || purgedRecordIds.has(binding.memoryId))) knowledgeFiles.add(key.slice('knowledge:'.length))
      }
    }
    for (const file of knowledgeFiles) {
      if (isKnowledgeFile(file)) pairs.set(`knowledge:${file}`, { key: `knowledge:${file}`, file: `knowledge/${file}`, kind: 'knowledge' })
    }
    let resolved = false
    let knowledgeChanged = false
    let readingDirty = readingPaths.size > 0 || fullScan
    const noteAuthority = knowledgeAuthority(this.store)
    const savePair = async (pair, leftHash, rightHash, left, right, links, generated, record) => {
      const entry = { left: leftHash, right: rightHash, file: pair.file, ...links, generated }
      if (leftHash !== null && leftHash === rightHash) {
        const leftStamp = pair.kind === 'memory' ? record && this.#memoryStamp(record)
          : await this.verifiedTextStamp(join(this.root, pair.file), left, pair.file)
        const rightStamp = await this.verifiedTextStamp(join(dir, pair.file), right, pair.file)
        if (leftStamp && rightStamp) {
          entry.proof = { version: PAIR_PROOF_VERSION, left: leftStamp, right: rightStamp }
          if (pair.kind === 'memory') verifiedRecords.set(pair.key, record)
        }
      }
      this.state.entries[pair.key] = entry
    }
    for (const pair of pairs.values()) {
      if (blocked.has(pair.key)) continue
      try {
        const vaultFile = join(dir, pair.file), localFile = pair.kind === 'knowledge' ? join(this.root, pair.file) : null
        const previous = this.state.entries[pair.key]
        if (reuse && localFile && cleanReceipt(previous) && previous.file === pair.file) {
          const unchanged = await Promise.all([matchesFile(localFile, previous.proof.left), matchesFile(vaultFile, previous.proof.right)])
          if (unchanged.every(Boolean) && (previous.knowledgeLinks ?? []).every(binding => noteAuthority(binding).allowed)) continue
        }
        let right = pair.diskText ?? await this.existingText(vaultFile)
        let left = pair.kind === 'memory' ? (pair.record && pair.record.status !== 'deleted' ? this.memory(pair.record).text : null) : await this.existingText(localFile)
        let savedRecord = pair.record
        let generated = previous?.generated
        const manualReceipt = manualExports.get(pair.file)
        if (manualReceipt && right !== null && manualReceipt === hash(right)) generated = manualReceipt
        let knowledgeLinks, commit
        if (pair.kind === 'memory' && (pair.record?.status === 'deleted' || pair.purged || purged.has(pair.id))) {
          noteRemoval(pair.id, pair.file, right, pair.record, previous)
          delete this.state.entries[pair.key]
          if (purged.has(pair.id)) this.state.purged[pair.id] = true
          readingDirty = true
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
          if (pair.record) commit = action => withKnowledgeWriter(this.store, () => {
            this.#checkDestination(config)
            const { scope, projectKey } = pair.record
            this.store.refreshScope(scope, projectKey)
            if (this.store.find(pair.id, [{ scope, projectKey }]) !== pair.record) throw new Error('记忆已变化，等待下一轮同步')
            if (regularText(vaultFile) !== right) throw new Error('记忆笔记已变化，等待下一轮同步')
            return action()
          })
        } else {
          const pastLinks = Array.isArray(previous?.knowledgeLinks) ? previous.knowledgeLinks.filter(binding => binding && typeof binding === 'object') : []
          const leftBinding = noteBinding(left), rightBinding = noteBinding(right)
          const leftLinks = leftBinding && hasKnowledgeLink(leftBinding) ? [...pastLinks, leftBinding] : pastLinks
          const links = rightBinding && hasKnowledgeLink(rightBinding) ? [...leftLinks, rightBinding] : leftLinks
          knowledgeLinks = [...new Map(links.map(binding => [JSON.stringify(binding), binding])).values()]
          if (knowledgeLinks.some(binding => !noteAuthority(binding).allowed)) {
            if (right !== null && generated === hash(right) && purged.has(rightBinding?.memoryId)) {
              removals.set(pair.file, generated)
            }
            this.state.entries[pair.key] = { left: null, right: null, file: pair.file, knowledgeLinks, generated }
            knowledgeChanged = true
            readingDirty = true
            continue
          }
          const lineageAllowed = check => (!leftBinding || knowledgeLineageAllowed(check, leftBinding, pastLinks)) &&
            (!rightBinding || knowledgeLineageAllowed(check, rightBinding, leftLinks))
          if (!lineageAllowed(noteAuthority)) throw new Error('知识笔记的关联记忆已变化，原件已保留。')
          if (knowledgeLinks.length > 0) commit = action => withKnowledgeWriter(this.store, check => {
            this.#checkDestination(config)
            if (!lineageAllowed(check) || knowledgeLinks.some(binding => !check(binding).allowed)) throw new Error('关联记忆的授权已变化，等待下一轮同步')
            if (regularText(localFile) !== left || regularText(vaultFile) !== right) throw new Error('知识笔记已变化，等待下一轮同步')
            return action()
          })
        }
        const lh = lv === null ? null : hash(lv), rh = rv === null ? null : hash(rv)
        const links = knowledgeLinks?.length ? { knowledgeLinks } : {}
        const token = hash(JSON.stringify([left, right]))
        let direction = null
        if (resolution?.key === pair.key) {
          if (resolution.token !== token) throw new Error('冲突内容已变化，请刷新后重新选择')
          direction = resolution.side === 'memory' ? 'export' : 'import'; resolved = true
        } else if (lh === rh) {
          if (previous?.file !== pair.file) readingDirty = true
          await savePair(pair, lh, rh, left, right, links, generated, savedRecord)
          continue
        } else if (!previous && left === null) direction = 'import'
        else if (!previous && right === null) direction = 'export'
        else if (left !== null && right !== null && previous) {
          if (lh === previous.left && rh !== previous.right) direction = 'import'
          else if (rh === previous.right && lh !== previous.left) direction = 'export'
        }
        if (direction === null) {
          const folder = join(dir, '_conflicts', hash(pair.key).slice(0, 16))
          const names = [conflictCopyName(token, 'memory', left ?? ''), conflictCopyName(token, 'obsidian', right ?? '')]
          const copies = (commit ? commit(() => [
            this.#preserveLocked(folder, names[0], left),
            this.#preserveLocked(folder, names[1], right),
          ]) : await Promise.all([
            this.preserve(folder, names[0], left),
            this.preserve(folder, names[1], right),
          ])).filter(Boolean)
          const memoryLink = pair.record ? { memoryId: pair.id, memoryScope: pair.record.scope,
            memoryProjectKey: pair.record.projectKey, scope: pair.record.scope, projectKey: pair.record.projectKey } : undefined
          result.conflicts.push({ key: pair.key, file: pair.file, token, copies, reason: left === null || right === null ? '一侧已删除，另一侧内容仍保留' : '两侧内容不同，未自动覆盖', memoryText: left, vaultText: right, ...links, memoryLink })
          continue
        }
        const currentConfig = this.getConfig()
        if (currentConfig.vaultPath !== config.vaultPath || currentConfig.folder !== config.folder || (config.autoSync && !currentConfig.autoSync)) throw new Error('同步设置已变化，本轮写入停止')
        if (direction === 'export') {
          // Recheck the authority after asynchronous file reads before publishing.
          if (pair.kind === 'memory' && this.store.find(pair.id, [{scope:pair.record.scope,projectKey:pair.record.projectKey}]) !== pair.record) throw new Error('记忆已变化，请等待下一轮同步')
          const managed = right !== null && generated === hash(right) ? { kind: pair.kind, hash: generated } : undefined
          await this.replace(vaultFile, right, left, dir, commit, managed)
          if (right !== left) generated = left === null ? undefined : hash(left)
          right = left; rv = lv; result.exported++
          if (pair.kind === 'knowledge') knowledgeChanged = true
          readingDirty = true
        } else {
          if (await textAt(vaultFile) !== right) throw new Error('笔记已变化，请等待下一轮同步')
          if (pair.kind === 'knowledge') { await this.replace(localFile, left, right, dir, commit); knowledgeChanged = true; readingDirty = true }
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
              savedRecord = semantic(record) === rv ? record : null
            }
            readingDirty = true
          }
          left = right; lv = rv; result.imported++
        }
        await savePair(pair, lv === null ? null : hash(lv), rv === null ? null : hash(rv), left, right, links, generated, savedRecord)
      } catch (e) {
        if (resolution?.key === pair.key) throw e
        result.errors.push({ file: pair.file, message: e.message })
      }
    }
    if (resolution && !resolved) throw new Error('冲突内容已变化或已经解决')
    const priorPurgeChecks = new Set(Array.isArray(this.state.purgeChecks) ? this.state.purgeChecks : [])
    const checkArchives = fullScan || notifiedPurge || [...retired].some(id => !priorPurgeChecks.has(id))
    if (checkArchives) for (const [file, digest] of findManagedCopies(dir, purged, digests)) removals.set(file, digest)
    if (removals.size || softDeleted.size) withKnowledgeWriter(this.store, () => {
      this.#checkDestination(config)
      for (const [file, { hash, id, scope }] of softDeleted) {
        this.store.refreshScope(scope.scope, scope.projectKey)
        if (this.store.find(id, [scope])?.status === 'deleted') removals.set(file, hash)
      }
      removeManagedCopies(this.root, dir, removals, result)
    })
    if (checkArchives && !result.errors.length) this.state.purgeChecks = [...retired]
    if (knowledgeChanged) {
      try { this.onKnowledgeChange() } catch { /* Recall refresh is fail-soft; the next edit retries it. */ }
    }
    if (knowledgeChanged) readingDirty = true
    if (readingDirty) {
      const reuseReading = reuse && !result.errors.length && !result.conflicts.length
      if (reuseReading) for (const file of Object.keys(this.state.readingPages ?? {})) {
        if (!isGeneratedReadingPage(file)) throw new Error('阅读页路径无效')
        if (!await matchesFile(join(dir, file), this.state.readingStamps?.[file])) readingPaths.add(file)
      }
      await refreshReadingPages(this, dir, config, result, { force: fullScan && !reuseReading, auditPaths: readingPaths })
    }
    for (const [key, record] of verifiedRecords) {
      const proof = this.state.entries[key]?.proof
      const stamp = this.#memoryStamp(record)
      if (proof && stamp) proof.left = stamp
    }
    const serialized = JSON.stringify(this.state)
    if (await textAt(stateFile) !== serialized) {
      atomicWritePrivate(stateFile, serialized)
    }
    this.#ensureWatchers(dir)
    if (fullScan) this.lastFullScanAt = result.at
    for (const error of result.errors) if (error.file) this.changedFiles.add(error.file)
    result.conflicts = this.#visibleConflicts(result.conflicts)
    this.last = result
    return result
  }
}
