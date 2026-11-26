/**
 * JSONL authority storage.
 *
 * One file per scope: `global/memories.jsonl` and
 * `projects/<projectKey>/memories.jsonl`. Each line is a complete record
 * revision; the loader keeps the highest revision per id. Deletion writes a
 * `status: 'deleted'` tombstone revision. Writes are synchronous appends; the
 * file is rewritten (compacted) when it grows past a threshold, using a temp
 * file + rename so a crash cannot leave a half-written authority file.
 *
 * @module dsh-memory/host/store
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { blockSourceRecall, canReadSource } from './capture-journal.js'
import { authorityAppend, authorityIdentity, clearAuthorityIntent, prepareAuthorityIntent, readAuthorityIntent,
  recoverAuthorityWrite, visibleAuthorityBytes } from './authority-intent.js'

import { isValidProjectKey, scopePaths } from './paths.js'
import { buildRecord, isValidMemoryId, nextRevision } from './records.js'
import { CACHE_FILE, hotRecord, rememberAuthority } from './cache-records.js'
import { atomicWritePrivate, syncDirectory, truncateFile, withFileLock, writeAll } from './persistence.js'
import { createCompleteBackup } from './backup.js'
import { validateImport } from './import-validation.js'
import { invalidateStoredRecallReports } from './recall-reports.js'
import { memoryNoteDigests, readPurgedNoteDigests, writePurgedNoteDigests } from './obsidian-note.js'
import { PERMANENT_REVISION, readRevocationLedger, retainRevocations } from './revocation-ledger.js'

export const SCHEMA_VERSION = 2
export const PURGED_IDS_FILE = 'obsidian-purged-ids.json'
export const MAX_RECORDS_PER_FILE = 2000
export const MAX_BYTES_PER_FILE = 4 * 1024 * 1024
const SUMMARY_KINDS = ['preference', 'fact', 'decision', 'episode']

function activityDay(at) {
  const date = new Date(at)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function pushMax(heap, value) {
  let index = heap.push(value) - 1
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2)
    if (heap[parent] >= value) break
    heap[index] = heap[parent]
    index = parent
  }
  heap[index] = value
}

function popMax(heap) {
  const max = heap[0]
  const tail = heap.pop()
  if (heap.length > 0) {
    let index = 0
    while (true) {
      const left = index * 2 + 1, right = left + 1
      if (left >= heap.length) break
      const child = right < heap.length && heap[right] > heap[left] ? right : left
      if (heap[child] <= tail) break
      heap[index] = heap[child]
      index = child
    }
    heap[index] = tail
  }
  return max
}

function emptyAggregate() {
  return { total: 0, deleted: 0, statusCounts: new Map(), kinds: new Map(SUMMARY_KINDS.map(kind => [kind, 0])),
    confidenceSum: 0, confidenceCount: 0, activityDays: new Map(), timestamps: new Map(), maxTimestampHeap: [] }
}

function adjustAggregate(aggregate, rawRecord, delta) {
  if (rawRecord === undefined) return
  const record = hotRecord(rawRecord)
  aggregate.statusCounts.set(record.status, (aggregate.statusCounts.get(record.status) ?? 0) + delta)
  const isDeleted = record.status === 'deleted'
  if (isDeleted) aggregate.deleted += delta
  else aggregate.total += delta

  if (record.status === 'active' || record.status === 'candidate') {
    if (aggregate.kinds.has(record.kind)) aggregate.kinds.set(record.kind, aggregate.kinds.get(record.kind) + delta)
    if (typeof record.confidence === 'number' && Number.isFinite(record.confidence)) {
      aggregate.confidenceSum += record.confidence * delta
      aggregate.confidenceCount += delta
    }
  }

  if (isDeleted) return
  const at = typeof record.updatedAt === 'number' ? record.updatedAt : record.observedAt
  if (typeof at === 'number' && Number.isFinite(at)) {
    const date = activityDay(at)
    let bucket = aggregate.activityDays.get(date)
    if (bucket === undefined) {
      bucket = { date, count: 0, preference: 0, fact: 0, decision: 0, episode: 0 }
      aggregate.activityDays.set(date, bucket)
    }
    bucket.count += delta
    if (Object.hasOwn(bucket, record.kind)) bucket[record.kind] += delta
    if (bucket.count <= 0) aggregate.activityDays.delete(date)

    const previousCount = aggregate.timestamps.get(at) ?? 0
    const count = previousCount + delta
    if (count <= 0) aggregate.timestamps.delete(at)
    else {
      if (delta > 0 && previousCount === 0) pushMax(aggregate.maxTimestampHeap, at)
      aggregate.timestamps.set(at, count)
    }
  }
}

function buildAggregate(records) {
  const aggregate = emptyAggregate()
  for (const record of records) adjustAggregate(aggregate, record, 1)
  return aggregate
}

function latestAggregateTimestamp(aggregate) {
  while (aggregate.maxTimestampHeap.length > 0 && !aggregate.timestamps.has(aggregate.maxTimestampHeap[0])) {
    popMax(aggregate.maxTimestampHeap)
  }
  return aggregate.maxTimestampHeap[0] ?? 0
}

function readPurgedIds(root) {
  const file = join(root, PURGED_IDS_FILE)
  if (!existsSync(file)) return new Set()
  let ids
  try { ids = JSON.parse(readFileSync(file, 'utf8')) }
  catch { throw new Error('memory store purge ledger is invalid; refusing to start safely') }
  if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string' || id === '')) {
    throw new Error('memory store purge ledger is invalid; refusing to start safely')
  }
  return new Set(ids)
}

/** Detect appends, same-size rewrites, replacements and deletions. */
export function fileStamp(file) {
  try { return authorityFileStamp(statSync(file, { bigint: true })) }
  catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

export function authorityFileStamp(stat) {
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':')
}

/** Whether a parsed JSONL line is a usable record revision. */
function isRecordRevision(value) {
  return value !== null && typeof value === 'object' &&
    typeof value.id === 'string' && value.id !== '' &&
    typeof value.kind === 'string' && typeof value.content === 'string' &&
    typeof value.status === 'string' &&
    typeof value.revision === 'number' && Number.isInteger(value.revision) && value.revision >= 1
}

function authoritySnapshot(file, root) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const intent = root === undefined ? null : readAuthorityIntent(root)
    const stamp = fileStamp(file)
    let bytes
    try { bytes = stamp === null ? Buffer.alloc(0) : readFileSync(file) }
    catch (error) { if (error?.code === 'ENOENT') continue; throw error }
    if (stamp !== fileStamp(file) || root !== undefined && intent !== readAuthorityIntent(root)) continue
    return { bytes: visibleAuthorityBytes(root, file, bytes, intent), stamp, intent }
  }
  throw new Error('记忆文件正被其他进程更新，请稍后重试。')
}

/** Read and parse one JSONL authority file; corrupt lines are skipped, counted and returned. */
export function readJsonl(file, root) {
  const { bytes, stamp, intent } = authoritySnapshot(file, root)
  return { ...parseMemoryLines(bytes), bytes: bytes.length, stamp, intent }
}

export function parseMemoryLines(bytes) {
  const text = bytes.toString('utf8')
  const records = []
  const corruptLines = []
  let lines = 0
  let corrupt = 0
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    lines += 1
    try {
      const value = JSON.parse(line)
      if (isRecordRevision(value)) { rememberAuthority(value, line); records.push(value) }
      else corrupt += 1
    } catch {
      corrupt += 1
    }
    if (corrupt > corruptLines.length) corruptLines.push(line.slice(0, 2000))
  }
  return { records, lines, corrupt, corruptLines }
}

/** Collapse revisions to the latest one per id, preserving insertion order by createdAt. */
export function latestRevisions(records) {
  const byId = new Map()
  for (const record of records) {
    const current = byId.get(record.id)
    if (current === undefined || record.revision > current.revision) byId.set(record.id, record)
  }
  return [...byId.values()].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
}

export class MemoryStore {
  #root
  #clock
  #scopes = new Map()
  #meta
  #beforeWrite = null
  #onChange = null
  #onRecallRevoke = null
  #changeListeners = new Set()
  #backupInFlight = null
  #purgedIds = new Set()
  #purgedIdsStamp

  /**
   * @param {{ root: string, clock?: () => number, onRecallRevoke?: Function }} options
   */
  constructor(options = {}) {
    if (typeof options.root !== 'string' || options.root === '') throw new Error('MemoryStore requires an absolute root')
    this.#root = options.root
    this.#clock = typeof options.clock === 'function' ? options.clock : () => Date.now()
    this.#onRecallRevoke = options.onRecallRevoke ?? null
    this.#meta = { schemaVersion: SCHEMA_VERSION, updatedAt: null }
  }

  #quarantined = new Set()

  get root() {
    return this.#root
  }

  setLifecycle({ beforeWrite = null, onChange = null, onRecallRevoke = null } = {}) {
    this.#beforeWrite = beforeWrite
    this.#onChange = onChange
    this.#onRecallRevoke = onRecallRevoke
  }

  addChangeListener(listener) {
    if (typeof listener !== 'function') throw new Error('change listener must be a function')
    this.#changeListeners.add(listener)
    return () => this.#changeListeners.delete(listener)
  }

  #notifyChange(event) {
    this.#onChange?.(event)
    for (const listener of this.#changeListeners) {
      try { listener(event) } catch { /* Observers cannot interrupt a committed write. */ }
    }
  }

  snapshot() { return this.#scopes }

  restore(scopes) {
    if (!(scopes instanceof Map)) throw new Error('invalid derived store')
    for (const [key, state] of scopes) {
      if (!state || !(state.records instanceof Map) ||
        key !== (state.scope === 'global' ? 'global' : `project:${state.projectKey}`)) throw new Error('invalid derived scope')
      const paths = scopePaths(this.#root, state.scope, state.projectKey)
      state.dir = paths.dir
      state.file = paths.file
      state.aggregate = null
    }
    this.#scopes = scopes
    return this
  }

  reset(keep = null) {
    this.#scopes.clear()
    if (keep !== null) this.#scopes.set(keep.key, keep)
  }

  /** Create the root directory and load `meta.json`. */
  open() {
    mkdirSync(this.#root, { recursive: true, mode: 0o700 })
    this.#currentPurgedIds()
    const metaFile = join(this.#root, 'meta.json')
    let previous = null
    if (existsSync(metaFile)) {
      try {
        const parsed = JSON.parse(readFileSync(metaFile, 'utf8'))
        if (parsed !== null && typeof parsed === 'object') {
          previous = Number.isInteger(parsed.schemaVersion) ? parsed.schemaVersion : null
          this.#meta = { ...parsed, schemaVersion: previous ?? SCHEMA_VERSION }
        }
      } catch {
        // A corrupt meta file is metadata only; the authority files still load.
      }
    }
    if (previous !== null && previous > SCHEMA_VERSION) {
      throw new Error(`memory store schema v${previous} is newer than supported v${SCHEMA_VERSION}`)
    }
    if (previous !== SCHEMA_VERSION) {
      this.#meta.schemaVersion = SCHEMA_VERSION
      this.#touch()
    }
    if (readAuthorityIntent(this.#root)) {
      try { this.#withLock(() => {}) }
      catch (error) {
        // Reads still enforce the intent when the disk cannot finish cleanup.
        if (error?.code !== 'recall-recovery-pending') throw error
      }
    }
    return this
  }

  #state(scope, projectKey) {
    if (scope === 'global') projectKey = null
    const key = scope === 'global' ? 'global' : `project:${projectKey}`
    let state = this.#scopes.get(key)
    if (state !== undefined) return state
    const paths = scopePaths(this.#root, scope, projectKey)
    const parsed = readJsonl(paths.file, this.#root)
    const latest = latestRevisions(parsed.records)
    state = {
      key,
      scope,
      projectKey,
      dir: paths.dir,
      file: paths.file,
      records: new Map(latest.map((record) => [record.id, record])),
      lines: parsed.lines,
      bytes: parsed.bytes,
      corrupt: parsed.corrupt,
      stamp: parsed.stamp,
      intent: parsed.intent,
      aggregate: null,
    }
    if (parsed.corrupt > 0) this.#quarantine(paths.file, parsed.corruptLines)
    this.#scopes.set(key, state)
    return state
  }

  /** All loaded revisions of one scope, newest first. */
  list(scope, projectKey, options = {}) {
    const state = this.#state(scope, projectKey)
    const includeDeleted = options.includeDeleted === true
    return [...state.records.values()]
      .filter((record) => includeDeleted || hotRecord(record).status !== 'deleted')
      .sort((a, b) => (hotRecord(b).updatedAt ?? 0) - (hotRecord(a).updatedAt ?? 0))
  }

  /** Project keys that already have an authority file on disk. */
  listProjects() {
    const projectsRoot = join(this.#root, 'projects')
    if (!existsSync(projectsRoot)) return []
    const keys = []
    for (const entry of readdirSync(projectsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !isValidProjectKey(entry.name)) continue
      if (existsSync(join(projectsRoot, entry.name, 'memories.jsonl'))) keys.push(entry.name)
    }
    return keys.sort()
  }

  /** Every current record across the global scope and every project. */
  listAll(options = {}) {
    const records = this.list('global', null, options)
    for (const projectKey of this.listProjects()) {
      for (const record of this.list('project', projectKey, options)) records.push(record)
    }
    return records
  }

  /** Refresh one authority file after another process may have changed it. */
  refreshScope(scope, projectKey = null) {
    const key = scope === 'global' ? 'global' : `project:${projectKey}`
    const wasLoaded = this.#scopes.has(key)
    const state = this.#state(scope, projectKey)
    if (wasLoaded) return this.#refreshState(state)
    this.#notifyChange({ type: 'refresh', state, previousRecords: [], records: [...state.records.values()] })
    return true
  }

  /** Find one current revision across the given scopes (loaded on demand). */
  find(id, scopes = [{ scope: 'global', projectKey: null }]) {
    for (const { scope, projectKey } of scopes) {
      const record = this.#state(scope, projectKey).records.get(id)
      if (record !== undefined) return record
    }
    return undefined
  }

  #appendCommitted(state, changes) {
    const changed = changes.filter(change => change.changed !== false)
    const committed = this.#commitAppends(changed.length ? [{ state, changes: changed }] : [])
    return { compact: committed.completed[0]?.compact ?? false, revocationError: committed.revocationError }
  }

  /** Validate all the participating files before appending, then finish or roll back together. */
  #commitAppends(entries, sourceIds = []) {
    const changes = entries.flatMap(entry => entry.changes)
    const targets = this.#revocationTargets(changes, sourceIds)
    if (targets.deletions?.length) readRevocationLedger(this.#root)
    const journal = changes.length > 1 || targets.sourceIds.length || targets.recordThrough.length
    const plans = []
    let intent
    try {
      for (const entry of entries) {
        const { state } = entry
        const lines = entry.changes.map(change => JSON.stringify(change.record))
        mkdirSync(state.dir, { recursive: true, mode: 0o700 })
        const fd = openSync(state.file, 'a+', 0o600)
        const plan = { ...entry, lines, fd }
        plans.push(plan)
        const stat = fstatSync(fd, { bigint: true })
        plan.originalSize = Number(stat.size)
        let separator = ''
        if (plan.originalSize > 0) {
          const tail = Buffer.alloc(1)
          if (readSync(fd, tail, 0, 1, plan.originalSize - 1) !== 1) throw new Error('cannot verify authority tail')
          if (tail[0] !== 10) separator = '\n'
        }
        plan.bytes = Buffer.from(`${separator}${lines.join('\n')}\n`)
        if (journal) plan.proof = authorityAppend(state, stat, plan.bytes)
      }
      if (journal) intent = prepareAuthorityIntent(this.#root, { appends: plans.map(plan => plan.proof), targets })
      for (const plan of plans) {
        plan.writing = true
        writeAll(plan.fd, plan.bytes)
        fsyncSync(plan.fd)
        if (intent && plan.originalSize === 0) {
          syncDirectory(plan.state.dir)
          if (plan.state.scope === 'project') syncDirectory(join(this.#root, 'projects'))
          syncDirectory(this.#root)
        }
      }
    } catch (error) {
      try {
        for (const plan of plans) if (plan.writing) truncateFile(plan.state.file, plan.originalSize)
        if (readAuthorityIntent(this.#root)) clearAuthorityIntent(this.#root)
      } catch (rollback) { error.rollbackFailed = rollback?.code ?? 'unknown' }
      throw error
    } finally { for (const plan of plans) closeSync(plan.fd) }
    const completed = plans.map(plan => this.#acceptAppend(plan))
    if (plans.length) this.#touch()
    if (intent) {
      try { this.#completeAuthorityIntent(intent) }
      catch (error) {
        for (const entry of completed) entry.compact = false
        return { completed, revocationError: error }
      }
    }
    return { completed }
  }

  #acceptAppend({ state, changes, lines, bytes }) {
    for (let i = 0; i < changes.length; i++) {
      const change = changes[i]
      state.records.set(change.record.id, change.record)
      this.#adjustAggregate(state, change.previous, change.record)
      rememberAuthority(change.record, lines[i])
      state.lines += 1
    }
    state.bytes += bytes.length
    state.stamp = fileStamp(state.file)
    state.intent = null
    const redundant = state.lines - state.records.size
    const compact = (state.lines > MAX_RECORDS_PER_FILE || state.bytes > MAX_BYTES_PER_FILE) &&
      redundant >= Math.max(100, Math.ceil(state.records.size / 4))
    return { state, changes, compact }
  }

  #revocationTargets(changes, explicitSourceIds = []) {
    const sourceIds = new Set(explicitSourceIds), recordThrough = [], deletions = []
    let deleted = sourceIds.size > 0
    for (const { record, previous } of changes) {
      const forget = record.status === 'deleted'
      const revokePrevious = previous && (previous.content !== record.content ||
        (previous.status === 'active' && record.status !== 'active') || record.status === 'superseded' || forget)
      if (revokePrevious || forget) recordThrough.push({
        id: record.id, projectKey: record.scope === 'global' ? null : record.projectKey,
        revision: forget ? record.revision : previous.revision,
      })
      if (forget) {
        deleted = true
        const projectKey = record.scope === 'global' ? null : record.projectKey
        const at = Number.isSafeInteger(record.updatedAt) && record.updatedAt >= 0 ? record.updatedAt : 0
        deletions.push({ id:record.id, projectKey, revision:record.revision, at })
      }
      for (const entry of [revokePrevious ? previous : null, forget ? record : null]) {
        for (const ref of entry?.sourceRefs ?? []) {
          if (/^src_[a-f0-9]{24}$/u.test(ref?.sourceId ?? '')) sourceIds.add(ref.sourceId)
        }
      }
    }
    return { recordThrough, sourceIds: [...sourceIds], ...(deletions.length ? { deletions } : {}),
      ...(deleted ? { reason: 'delete' } : {}) }
  }

  #completeAuthorityIntent({ targets, purge }) {
    try {
      if (purge) this.#persistPurge(purge)
      const deletions = purge ? [{ id:purge.id, projectKey:purge.projectKey, revision:PERMANENT_REVISION, at:0 }] : targets.deletions ?? []
      retainRevocations(this.#root, deletions)
      if (targets.sourceIds.length) {
        blockSourceRecall(this.#root, { sourceRefs: targets.sourceIds.map(sourceId => ({ sourceId })) })
      }
      if (targets.recordThrough.length || targets.sourceIds.length) {
        if (this.#onRecallRevoke === null) invalidateStoredRecallReports(this.#root, targets)
        else this.#onRecallRevoke(targets)
      }
      clearAuthorityIntent(this.#root)
    } catch (cause) {
      throw Object.assign(new Error('记忆已写入，原文和报告清理待恢复。请检查存储后重试。', { cause }),
        { code: 'recall-recovery-pending', committed: true })
    }
  }

  #publishChanges(state, changes, compact) {
    const changed = changes.filter(change => change.changed !== false)
    if (changed.length) this.#notifyChange({ type: 'upsert', state, records: changed.map(change => change.record),
      previous: changed.map(change => change.previous) })
    if (compact) this.compact(state.scope, state.projectKey)
  }

  #requireReadableSources(sourceIds = []) {
    if (sourceIds.some(id => !canReadSource(this.#root, id))) {
      throw Object.assign(new Error('memory source was revoked before the write'), { code: 'source-revoked' })
    }
  }

  /** Forget the source and its committed derivatives before another writer can add more. */
  revokeSource(sourceId, projectKey) {
    if (!/^src_[a-f0-9]{24}$/u.test(sourceId ?? '') || !isValidProjectKey(projectKey)) throw new Error('invalid source recall scope')
    this.#beforeWrite?.()
    const outcome = this.#withLock(() => {
      const entries = []
      for (const state of [this.#state('project', projectKey), this.#state('global', null)]) {
        this.#refreshState(state)
        const changes = []
        for (const previous of state.records.values()) {
          if (hotRecord(previous).status !== 'deleted' && previous.sourceRefs?.some(ref => ref?.sourceId === sourceId)) {
            changes.push({ previous, record: nextRevision(previous, { status: 'deleted' }, this.#clock()) })
          }
        }
        if (changes.length) entries.push({ state, changes })
      }
      return this.#commitAppends(entries, [sourceId])
    })
    for (const entry of outcome.completed) this.#publishChanges(entry.state, entry.changes, entry.compact)
    if (outcome.revocationError) throw outcome.revocationError
    return outcome.completed.flatMap(entry => entry.changes.map(change => change.record))
  }

  /** Append a record revision under a cross-process lock; fsync before returning. */
  append(record, options = {}) {
    if (record === null || typeof record !== 'object') throw new Error('append requires a record')
    this.#beforeWrite?.()
    const state = this.#state(record.scope, record.projectKey)
    const outcome = this.#withLock(() => {
      this.#refreshState(state)
      this.#requireReadableSources(options.sourceIds)
      const current = state.records.get(record.id)
      const protectedDeleted = this.#currentPurgedIds().has(record.id) || current?.status === 'deleted' && record.status !== 'deleted'
      if (options.importOnly) {
        if (protectedDeleted || current && current.revision >= record.revision) {
          return { record: current, changed: false, compact: false, protectedDeleted }
        }
      }
      if (protectedDeleted) throw new Error('cannot append over a deleted or purged memory')
      let next = record
      if (current !== undefined) {
        if (record.revision <= current.revision) {
          if (record.content === current.content && record.status === current.status) {
            return { record: current, compact: false, changed: false }
          }
          next = { ...record, revision: current.revision + 1 }
        }
      }
      const change = { record: next, previous: current, changed: true }
      // A large live set stays above the old size threshold even immediately
      // after compaction. Rewrite only when enough obsolete revisions exist.
      const result = this.#appendCommitted(state, [change])
      return { record: next, previous: current, changed: true, ...result }
    })
    if (outcome.changed) this.#notifyChange({ type: 'upsert', records: [outcome.record], previous: [outcome.previous], state })
    if (outcome.compact) this.compact(record.scope, record.projectKey)
    if (outcome.revocationError) throw outcome.revocationError
    return options.importOnly ? outcome : outcome.record
  }

  /** Append a same-scope record set as one rollback-safe JSONL write. */
  appendBatch(records) {
    if (!Array.isArray(records) || records.length === 0 || records.some(record => !isRecordRevision(record))) {
      throw new Error('appendBatch requires one or more complete memory records')
    }
    const first = records[0]
    if (records.some(record => record.scope !== first.scope || record.projectKey !== first.projectKey) ||
        new Set(records.map(record => record.id)).size !== records.length) {
      throw new Error('appendBatch records must have unique ids in one scope')
    }
    this.#beforeWrite?.()
    const state = this.#state(first.scope, first.projectKey)
    const outcome = this.#withLock(() => {
      this.#refreshState(state)
      this.#requireReadableSources([...new Set(records.flatMap(record => (record.sourceRefs ?? [])
        .map(ref => ref?.sourceId).filter(value => typeof value === 'string' && value !== '')))])
      const changes = []
      const purged = this.#currentPurgedIds()
      for (const input of records) {
        const current = state.records.get(input.id)
        if (purged.has(input.id) || current?.status === 'deleted' && input.status !== 'deleted') {
          throw new Error('cannot append over a deleted or purged memory')
        }
        if (current && input.content === current.content && input.status === current.status) {
          changes.push({ record: current, previous: current, changed: false })
          continue
        }
        const next = current && input.revision <= current.revision
          ? { ...input, revision: current.revision + 1 }
          : input
        changes.push({ record: next, previous: current, changed: true })
      }
      return { changes, ...this.#appendCommitted(state, changes) }
    })
    this.#publishChanges(state, outcome.changes, outcome.compact)
    if (outcome.revocationError) throw outcome.revocationError
    return outcome.changes.map(item => item.record)
  }

  /**
   * Validate and append a new memory.
   * @param {Record<string, unknown>} input
   * @param {{ now?: number, id?: string, autoApproveConfidence?: number }} [options]
   * @returns {{ ok: true, record: object } | { ok: false, reason: string }}
   */
  write(input, options = {}) {
    const built = buildRecord(input, { now: this.#clock(), ...options })
    if (built.ok !== true) return built
    return { ok: true, record: this.append(built.record) }
  }

  /** Append the next revision for an existing record. */
  update(id, patch, scopes = [{ scope: 'global', projectKey: null }], options = {}) {
    this.#beforeWrite?.()
    const result = this.#withLock(() => {
      this.#requireReadableSources(options.sourceIds)
      for (const { scope, projectKey } of scopes) {
        const state = this.#state(scope, projectKey)
        this.#refreshState(state)
        const current = state.records.get(id)
        if (current === undefined) continue
        if (options.requireDeleted && current.status !== 'deleted') return null
        const fields = typeof patch === 'function' ? patch(current) : patch
        if (current.status === 'deleted' && !options.restore && fields.status !== 'deleted') return null
        if (current.status === 'deleted' && fields.status === 'deleted') return { record: current }
        const record = nextRevision(current, fields, this.#clock())
        const change = { record, previous: current }
        return { record, state, change, ...this.#appendCommitted(state, [change]) }
      }
      return null
    })
    if (result?.change) this.#publishChanges(result.state, [result.change], result.compact)
    if (result?.revocationError) throw result.revocationError
    return result?.record
  }

  /** Validate and commit one scope before applying any irreversible side effects. */
  updateBatch(ids, scope, projectKey, patch, { restore = false } = {}) {
    this.#beforeWrite?.()
    const state = this.#state(scope, projectKey)
    const outcome = this.#withLock(() => {
      this.#refreshState(state)
      const changes = ids.map(id => {
        try {
          const current = state.records.get(id)
          if (!current) throw new Error('memory not found in the requested scope')
          const fields = patch(current)
          if (current.status === 'deleted' && !restore && fields.status !== 'deleted') throw new Error('memory is deleted')
          if (current.status === 'deleted' && fields.status === 'deleted') return { record: current, changed: false }
          return { previous: current, record: nextRevision(current, fields, this.#clock()) }
        } catch (error) {
          throw Object.assign(error, { memoryId: id })
        }
      })
      return { changes, ...this.#appendCommitted(state, changes) }
    })
    this.#publishChanges(state, outcome.changes, outcome.compact)
    return { records: outcome.changes.map(change => change.record), revocationError: outcome.revocationError }
  }

  /** Publish a replacement and the old record's retirement as one file commit. */
  replace(oldId, replacement, options = {}) {
    if (!isRecordRevision(replacement) || replacement.id === oldId) throw new Error('invalid replacement record')
    this.#beforeWrite?.()
    const state = this.#state(replacement.scope, replacement.projectKey)
    const result = this.#withLock(() => {
      this.#refreshState(state)
      this.#requireReadableSources(options.sourceIds)
      const old = state.records.get(oldId)
      if (old === undefined || (old.status !== 'active' && old.status !== 'candidate')) {
        throw new Error('replacement target is no longer active in this scope')
      }
      if (state.records.has(replacement.id)) throw new Error('replacement id already exists')
      const previous = nextRevision(old, { status: 'superseded', validTo: this.#clock() }, this.#clock())
      const record = { ...replacement, supersedesId: oldId }
      const changes = [{ previous: old, record: previous }, { record }]
      return { previous, record, changes, ...this.#appendCommitted(state, changes) }
    })
    this.#publishChanges(state, result.changes, result.compact)
    if (result.revocationError) throw result.revocationError
    return { previous: result.previous, record: result.record }
  }

  /** Soft-delete one record (writes a tombstone revision). */
  remove(id, scopes) {
    return this.update(id, { status: 'deleted' }, scopes)
  }

  /** Rewrite one authority file with only the latest revision per id (locked, re-reads first). */
  compact(scope, projectKey) {
    this.#beforeWrite?.()
    const state = this.#state(scope, projectKey)
    const outcome = this.#withLock(() => {
      this.#refreshState(state)
      const latest = latestRevisions([...state.records.values()])
      mkdirSync(state.dir, { recursive: true, mode: 0o700 })
      const temp = `${state.file}.tmp`
      const lines = latest.map((record) => JSON.stringify(record))
      const text = lines.map((line) => `${line}\n`).join('')
      const fd = openSync(temp, 'w', 0o600)
      try {
        writeAll(fd, text)
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      renameSync(temp, state.file)
      try {
        const dirFd = openSync(state.dir, 'r')
        try { fsyncSync(dirFd) } finally { closeSync(dirFd) }
      } catch {
        // Directory fsync is best effort on platforms that refuse it.
      }
      state.records = new Map(latest.map((record) => [record.id, record]))
      if (state.aggregate != null) state.aggregate = buildAggregate(state.records.values())
      let changed = false
      for (let i = 0; i < latest.length; i += 1) {
        if (rememberAuthority(latest[i], lines[i])) changed = true
      }
      state.lines = latest.length
      state.bytes = Buffer.byteLength(text)
      state.stamp = fileStamp(state.file)
      this.#touch()
      return { count: latest.length, changed }
    })
    this.#notifyChange({ type: 'rewrite', state, changed: outcome.changed })
    return outcome.count
  }

  /** All persisted revisions of one record, newest revision first. */
  history(id, scopes) {
    for (const { scope, projectKey } of scopes) {
      const state = this.#state(scope, projectKey)
      if (!state.records.has(id)) continue
      const revisions = new Map()
      const { bytes } = authoritySnapshot(state.file, this.#root)
      const encodedId = isValidMemoryId(id) ? JSON.stringify(id) : null
      for (const line of bytes.toString('utf8').split('\n')) {
        // Legacy journals may escape the ID itself or the property name.
        if (encodedId && !line.includes(encodedId) && !line.includes('\\u')) continue
        let record
        try { record = JSON.parse(line) } catch { continue }
        if (!isRecordRevision(record) || record.id !== id || revisions.has(record.revision)) continue
        rememberAuthority(record, line)
        revisions.set(record.revision, record)
      }
      return [...revisions.values()].sort((left, right) => right.revision - left.revision)
    }
    return []
  }

  /** Physically remove every revision of one record (used by the recycle bin). */
  purge(id, scopes) {
    this.#beforeWrite?.()
    for (const { scope, projectKey } of scopes) {
      const state = this.#state(scope, projectKey)
      const result = this.#withLock(() => {
        this.#refreshState(state)
        const previous = state.records.get(id)
        if (!previous) return null
        const history = readJsonl(state.file, this.#root).records
        const kept = history.filter(record => record.id !== id)
        const removed = history.filter(record => record.id === id)
        const bytes = Buffer.from(kept.map(record => `${JSON.stringify(record)}\n`).join(''))
        const sourceIds = [...new Set(removed.flatMap(record =>
          (record.sourceRefs ?? []).map(ref => ref?.sourceId).filter(value => /^src_[a-f0-9]{24}$/u.test(value ?? ''))))]
        const noteDigests = [...memoryNoteDigests(removed)]
        if (noteDigests.length) readPurgedNoteDigests(this.#root)
        readRevocationLedger(this.#root)
        const targets = { sourceIds, reason: 'delete',
          recordThrough: [{ id, projectKey: state.projectKey, revision: PERMANENT_REVISION }] }
        const temp = `${state.file}.tmp`
        let intent
        try {
          const fd = openSync(temp, 'w', 0o600)
          let after
          try {
            writeAll(fd, bytes)
            fsyncSync(fd)
            after = authorityIdentity(fstatSync(fd, { bigint: true }))
          } finally { closeSync(fd) }
          const before = authorityIdentity(statSync(state.file, { bigint: true }))
          intent = prepareAuthorityIntent(this.#root, {
            purge: { id, scope, projectKey: state.projectKey, before, after, bytes: bytes.length, noteDigests }, targets,
          })
          renameSync(temp, state.file)
        } catch (error) {
          try {
            const pending = readAuthorityIntent(this.#root)
            if (pending && !recoverAuthorityWrite(this.#root, pending)) clearAuthorityIntent(this.#root)
          } catch (recovery) { error.rollbackFailed = recovery?.code ?? 'unknown' }
          throw error
        } finally {
          try { unlinkSync(temp) } catch (error) { if (error?.code !== 'ENOENT') throw error }
        }
        state.records.delete(id)
        this.#adjustAggregate(state, previous, undefined)
        state.lines = kept.length
        state.bytes = bytes.length
        state.stamp = fileStamp(state.file)
        this.#touch()
        try {
          syncDirectory(state.dir)
          this.#completeAuthorityIntent(intent)
          return { previous }
        } catch (revocationError) { return { previous, revocationError } }
      })
      if (!result) continue
      this.#notifyChange({ type: 'remove', records: [result.previous], id, state })
      if (result.revocationError) throw result.revocationError
      return true
    }
    return false
  }

  /** Export every current record (global + all projects) as a JSON object. */
  exportData() {
    const projects = {}
    for (const key of this.listProjects()) projects[key] = this.list('project', key)
    return {
      schemaVersion: SCHEMA_VERSION,
      exportedAt: this.#clock(),
      global: this.list('global', null),
      projects,
    }
  }

  /** IDs physically purged from authority, retained to block stale imports. */
  purgedIds() {
    return new Set(this.#currentPurgedIds())
  }

  #currentPurgedIds() {
    const stamp = fileStamp(join(this.#root, PURGED_IDS_FILE))
    if (stamp !== this.#purgedIdsStamp) {
      this.#purgedIds = readPurgedIds(this.#root)
      this.#purgedIdsStamp = stamp
    }
    return this.#purgedIds
  }

  #persistPurge({ id, noteDigests }) {
    const purgedIds = this.purgedIds()
    purgedIds.add(id)
    atomicWritePrivate(join(this.#root, PURGED_IDS_FILE), `${JSON.stringify([...purgedIds].sort())}\n`)
    if (noteDigests?.length) {
      const entries = readPurgedNoteDigests(this.#root)
      entries.set(id, new Set([...(entries.get(id) ?? []), ...noteDigests]))
      writePurgedNoteDigests(this.#root, entries)
    }
    // A crash can leave a staged snapshot. Remove it under the same writer lock.
    for (const name of readdirSync(this.#root)) {
      if (name !== CACHE_FILE && !(name.startsWith(CACHE_FILE + '.') &&
          /^\d+\.[\da-f-]{36}\.tmp$/u.test(name.slice(CACHE_FILE.length + 1)))) continue
      try { unlinkSync(join(this.#root, name)) }
      catch (error) { if (error?.code !== 'ENOENT') throw error }
    }
  }

  /** Snapshot all recoverable local data; unlike exportData, retain evidence/history. */
  backup(format = 'compatible') {
    // Snapshot validation detects concurrent mutations without freezing writers.
    if (this.#backupInFlight !== null) {
      if (this.#backupInFlight.format === format) return this.#backupInFlight.promise
      return Promise.reject(Object.assign(new Error('已有备份正在进行。'), { code: 'backup-in-progress' }))
    }
    const promise = createCompleteBackup(this.#root, this.#clock(), format).finally(() => { this.#backupInFlight = null })
    this.#backupInFlight = { format, promise }
    return promise
  }

  /**
   * Merge an exported payload into this store; newer revisions win.
   * @param {object} payload exportData() shape
   * @param {{ dryRun?: boolean }} [options]
   */
  importData(payload, options = {}) {
    const records = validateImport(payload, SCHEMA_VERSION, this.#clock())
    if (options.dryRun !== true) this.#beforeWrite?.()
    const dryRun = options.dryRun === true
    const purged = dryRun ? this.#currentPurgedIds() : null
    const existing = new Map(this.listAll({ includeDeleted: true }).map(record => [record.id, record]))
    for (const record of records) {
      const previous = existing.get(record.id)
      if (previous && (previous.scope !== record.scope || previous.projectKey !== record.projectKey)) throw new Error('导入记录与本地记录范围冲突，未应用。')
    }
    let imported = 0, skipped = 0, protectedDeleted = 0
    for (const record of records) {
      const state = this.#state(record.scope, record.projectKey)
      const current = state.records.get(record.id)
      if (dryRun) {
        if (purged.has(record.id) || current?.status === 'deleted' && record.status !== 'deleted') { skipped++; protectedDeleted++ }
        else if (current && record.revision <= current.revision) skipped++
        else imported++
      } else {
        const result = this.append(record, { importOnly: true })
        if (result.changed) imported++
        else { skipped++; if (result.protectedDeleted) protectedDeleted++ }
      }
    }
    return { imported, skipped, protectedDeleted, dryRun }
  }

  /** Re-read one authority file when another process changed it. */
  #refreshState(state) {
    const stamp = fileStamp(state.file)
    if (stamp === state.stamp && !state.intent) return false
    const previousRecords = [...state.records.values()]
    const parsed = readJsonl(state.file, this.#root)
    state.records = new Map(latestRevisions(parsed.records).map((record) => [record.id, record]))
    if (state.aggregate != null) state.aggregate = buildAggregate(state.records.values())
    state.lines = parsed.lines
    state.bytes = parsed.bytes
    state.corrupt = parsed.corrupt
    state.stamp = parsed.stamp
    state.intent = parsed.intent
    if (parsed.corrupt > 0) this.#quarantine(state.file, parsed.corruptLines)
    this.#notifyChange({ type: 'refresh', state, previousRecords, records: [...state.records.values()] })
    return true
  }

  #adjustAggregate(state, previous, next) {
    if (state.aggregate == null) return
    adjustAggregate(state.aggregate, previous, -1)
    adjustAggregate(state.aggregate, next, 1)
  }

  #aggregate(state) {
    state.aggregate ??= buildAggregate(state.records.values())
    return state.aggregate
  }

  /** Cached whole-store counters; mutation paths update them by record revision. */
  aggregateStats() {
    const projectKeys = this.listProjects()
    const scopes = [this.#state('global', null), ...projectKeys.map(key => this.#state('project', key))]
    const result = { total: 0, deleted: 0, statusCounts: new Map(), kinds: new Map(SUMMARY_KINDS.map(kind => [kind, 0])),
      confidenceSum: 0, confidenceCount: 0, lastCapturedAt: 0, projectKeys, browseableProjectKeys: [] }
    for (const state of scopes) {
      const aggregate = this.#aggregate(state)
      if (state.scope === 'project' && aggregate.total > 0) result.browseableProjectKeys.push(state.projectKey)
      result.total += aggregate.total
      result.deleted += aggregate.deleted
      result.confidenceSum += aggregate.confidenceSum
      result.confidenceCount += aggregate.confidenceCount
      result.lastCapturedAt = Math.max(result.lastCapturedAt, latestAggregateTimestamp(aggregate))
      for (const [status, count] of aggregate.statusCounts) {
        result.statusCounts.set(status, (result.statusCounts.get(status) ?? 0) + count)
      }
      for (const [kind, count] of aggregate.kinds) result.kinds.set(kind, (result.kinds.get(kind) ?? 0) + count)
    }
    return result
  }

  /** Per-day current record counts for an activity chart. Returned buckets are copies. */
  activitySummary(scope, projectKey) {
    const aggregate = this.#aggregate(this.#state(scope, projectKey))
    return [...aggregate.activityDays.values()].map(bucket => ({ ...bucket })).sort((left, right) => left.date.localeCompare(right.date))
  }

  /** Keep the first copy of each corrupt line so compaction cannot erase it silently. */
  #quarantine(file, lines) {
    if (!Array.isArray(lines) || lines.length === 0) return
    const key = `${file}:${lines.length}:${lines[0].slice(0, 48)}`
    if (this.#quarantined.has(key)) return
    this.#quarantined.add(key)
    try {
      const target = join(this.#root, 'corrupt-lines.jsonl')
      const fd = openSync(target, 'a', 0o600)
      try {
        for (const text of lines) writeAll(fd, `${JSON.stringify({ file, at: this.#clock(), text })}\n`)
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
    } catch {
      // Quarantine is diagnostic; never fail a read over it.
    }
  }

  /** Cross-process writer lock with stale-lock recovery. */
  #withLock(fn) {
    mkdirSync(this.#root, { recursive: true, mode: 0o700 })
    return withFileLock(join(this.#root, '.write.lock'), () => {
      const intent = readAuthorityIntent(this.#root)
      if (intent) {
        if (recoverAuthorityWrite(this.#root, intent)) this.#completeAuthorityIntent(intent)
        else clearAuthorityIntent(this.#root)
      }
      return fn()
    })
  }

  /** Per-scope counters for the panel/debug output. */
  stats() {
    return [...this.#scopes.values()].map((state) => ({
      scope: state.scope,
      projectKey: state.projectKey,
      records: state.records.size,
      lines: state.lines,
      bytes: state.bytes,
      corrupt: state.corrupt,
    }))
  }

  #touch() {
    this.#meta.updatedAt = this.#clock()
    const metaFile = join(this.#root, 'meta.json')
    try {
      writeFileSync(metaFile, `${JSON.stringify(this.#meta, null, 2)}\n`, { mode: 0o600 })
    } catch {
      // Metadata is advisory; a failed meta write must not lose the authority append.
    }
  }
}
