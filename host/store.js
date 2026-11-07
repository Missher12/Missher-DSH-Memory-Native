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
  ftruncateSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'
import { blockSourceRecall } from './capture-journal.js'

import { isValidProjectKey, scopePaths } from './paths.js'
import { buildRecord, nextRevision } from './records.js'
import { CACHE_FILE, hotRecord, rememberAuthority } from './cache-records.js'
import { withFileLock, writeAll } from './persistence.js'
import { createCompleteBackup } from './backup.js'
import { validateImport } from './import-validation.js'

export const SCHEMA_VERSION = 2
export const MAX_RECORDS_PER_FILE = 2000
export const MAX_BYTES_PER_FILE = 4 * 1024 * 1024

/** Detect appends, same-size rewrites, replacements and deletions. */
export function fileStamp(file) {
  try {
    const stat = statSync(file, { bigint: true })
    return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':')
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

/** Whether a parsed JSONL line is a usable record revision. */
function isRecordRevision(value) {
  return value !== null && typeof value === 'object' &&
    typeof value.id === 'string' && value.id !== '' &&
    typeof value.kind === 'string' && typeof value.content === 'string' &&
    typeof value.status === 'string' &&
    typeof value.revision === 'number' && Number.isInteger(value.revision) && value.revision >= 1
}

/** Read and parse one JSONL authority file; corrupt lines are skipped, counted and returned. */
export function readJsonl(file) {
  if (!existsSync(file)) return { records: [], lines: 0, bytes: 0, corrupt: 0, corruptLines: [] }
  const text = readFileSync(file, 'utf8')
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
  return { records, lines, bytes: Buffer.byteLength(text), corrupt, corruptLines }
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
  #backupInFlight = null

  /**
   * @param {{ root: string, clock?: () => number }} options
   */
  constructor(options = {}) {
    if (typeof options.root !== 'string' || options.root === '') throw new Error('MemoryStore requires an absolute root')
    this.#root = options.root
    this.#clock = typeof options.clock === 'function' ? options.clock : () => Date.now()
    this.#meta = { schemaVersion: SCHEMA_VERSION, updatedAt: null }
  }

  #quarantined = new Set()

  get root() {
    return this.#root
  }

  setLifecycle({ beforeWrite = null, onChange = null } = {}) {
    this.#beforeWrite = beforeWrite
    this.#onChange = onChange
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
    return this
  }

  #state(scope, projectKey) {
    const key = scope === 'global' ? 'global' : `project:${projectKey}`
    let state = this.#scopes.get(key)
    if (state !== undefined) return state
    const paths = scopePaths(this.#root, scope, projectKey)
    const parsed = readJsonl(paths.file)
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
      stamp: fileStamp(paths.file),
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
    const records = [...this.list('global', null, options)]
    for (const projectKey of this.listProjects()) records.push(...this.list('project', projectKey, options))
    return records
  }

  /** Find one current revision across the given scopes (loaded on demand). */
  find(id, scopes = [{ scope: 'global', projectKey: null }]) {
    for (const { scope, projectKey } of scopes) {
      const record = this.#state(scope, projectKey).records.get(id)
      if (record !== undefined) return record
    }
    return undefined
  }

  /** Append a record revision under a cross-process lock; fsync before returning. */
  append(record, options = {}) {
    if (record === null || typeof record !== 'object') throw new Error('append requires a record')
    this.#beforeWrite?.()
    const state = this.#state(record.scope, record.projectKey)
    const outcome = this.#withLock(() => {
      this.#refreshState(state)
      const current = state.records.get(record.id)
      if (options.importOnly && current && (current.revision >= record.revision || current.status === 'deleted' && record.status !== 'deleted')) {
        return { record: current, changed: false, compact: false, protectedDeleted: current.status === 'deleted' && record.status !== 'deleted' }
      }
      let next = record
      if (current !== undefined) {
        if (record.revision <= current.revision) {
          if (record.content === current.content && record.status === current.status) {
            return { record: current, compact: false, changed: false }
          }
          next = { ...record, revision: current.revision + 1 }
        }
      }
      mkdirSync(state.dir, { recursive: true, mode: 0o700 })
      if (current && (current.content !== next.content || (current.status === 'active' && next.status !== 'active'))) blockSourceRecall(this.#root, current)
      if (next.status === 'deleted') blockSourceRecall(this.#root, next)
      const line = `${JSON.stringify(next)}\n`
      const fd = openSync(state.file, 'a+', 0o600)
      const originalSize = fstatSync(fd).size
      let separatorBytes = 0
      try {
        if (originalSize > 0) {
          const tail = Buffer.alloc(1)
          if (readSync(fd, tail, 0, 1, originalSize - 1) !== 1) throw new Error('cannot verify authority tail')
          if (tail[0] !== 10) { writeAll(fd, '\n'); separatorBytes = 1 }
        }
        writeAll(fd, line)
        fsyncSync(fd)
      } catch (error) {
        // We hold the writer lock: roll back only this uncommitted append.
        try { ftruncateSync(fd, originalSize); fsyncSync(fd) }
        catch (rollback) { error.rollbackFailed = rollback?.code ?? 'unknown' }
        throw error
      } finally {
        closeSync(fd)
      }
      state.records.set(next.id, next)
      rememberAuthority(next, line.slice(0, -1))
      state.lines += 1
      state.bytes += Buffer.byteLength(line) + separatorBytes
      state.stamp = fileStamp(state.file)
      this.#touch()
      // A large live set stays above the old size threshold even immediately
      // after compaction. Rewrite only when enough obsolete revisions exist.
      const redundant = state.lines - state.records.size
      const compact = (state.lines > MAX_RECORDS_PER_FILE || state.bytes > MAX_BYTES_PER_FILE) &&
        redundant >= Math.max(100, Math.ceil(state.records.size / 4))
      return { record: next, previous: current, changed: true, compact }
    })
    if (outcome.changed) this.#onChange?.({ type: 'upsert', records: [outcome.record], previous: [outcome.previous], state })
    if (outcome.compact) this.compact(record.scope, record.projectKey)
    return options.importOnly ? outcome : outcome.record
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
  update(id, patch, scopes) {
    this.#beforeWrite?.()
    const record = this.find(id, scopes)
    if (record === undefined) return undefined
    const next = nextRevision(record, patch, this.#clock())
    return this.append(next)
  }

  /** Publish a replacement and the old record's retirement as one file commit. */
  replace(oldId, replacement) {
    if (!isRecordRevision(replacement) || replacement.id === oldId) throw new Error('invalid replacement record')
    this.#beforeWrite?.()
    const state = this.#state(replacement.scope, replacement.projectKey)
    const result = this.#withLock(() => {
      this.#refreshState(state)
      const old = state.records.get(oldId)
      if (old === undefined || (old.status !== 'active' && old.status !== 'candidate')) {
        throw new Error('replacement target is no longer active in this scope')
      }
      if (state.records.has(replacement.id)) throw new Error('replacement id already exists')
      blockSourceRecall(this.#root, old)
      const previous = nextRevision(old, { status: 'superseded', validTo: this.#clock() }, this.#clock())
      const record = { ...replacement, supersedesId: oldId }
      const original = readFileSync(state.file, 'utf8')
      const separator = original.endsWith('\n') ? '' : '\n'
      const previousJson = JSON.stringify(previous), recordJson = JSON.stringify(record)
      const text = `${original}${separator}${previousJson}\n${recordJson}\n`
      const bytes = Buffer.from(text)
      const temp = `${state.file}.replace.tmp`
      try {
        const fd = openSync(temp, 'w', 0o600)
        try {
          let offset = 0
          while (offset < bytes.length) {
            const written = writeSync(fd, bytes, offset, bytes.length - offset)
            if (written <= 0) throw new Error('replacement write made no progress')
            offset += written
          }
          fsyncSync(fd)
        } finally {
          closeSync(fd)
        }
        renameSync(temp, state.file)
      } finally {
        try { unlinkSync(temp) } catch {}
      }
      // No consumer sees either half until the authority file was committed.
      state.records.set(previous.id, previous)
      state.records.set(record.id, record)
      rememberAuthority(previous, previousJson)
      rememberAuthority(record, recordJson)
      state.lines += 2
      state.bytes = bytes.length
      state.stamp = fileStamp(state.file)
      try {
        const fd = openSync(state.dir, 'r')
        try { fsyncSync(fd) } finally { closeSync(fd) }
      } catch {
        // As with compact(), some platforms do not support directory fsync.
      }
      this.#touch()
      return { previous, record }
    })
    this.#onChange?.({ type: 'upsert', records: [result.previous, result.record], previous: [result.previous], state })
    return result
  }

  /** Soft-delete one record (writes a tombstone revision). */
  remove(id, scopes) {
    this.#beforeWrite?.()
    const record = this.find(id, scopes)
    if (record === undefined) return undefined
    return this.append(nextRevision(record, { status: 'deleted' }, this.#clock()))
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
    this.#onChange?.({ type: 'rewrite', state, changed: outcome.changed })
    return outcome.count
  }

  /** All persisted revisions of one record, newest revision first. */
  history(id, scopes) {
    for (const { scope, projectKey } of scopes) {
      const state = this.#state(scope, projectKey)
      if (!state.records.has(id)) continue
      const revisions = new Map()
      for (const record of readJsonl(state.file).records) {
        if (record.id !== id) continue
        if (!revisions.has(record.revision)) revisions.set(record.revision, record)
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
      if (!state.records.has(id)) continue
      let previous
      const purged = this.#withLock(() => {
        this.#refreshState(state)
        if (!state.records.has(id)) return false
        previous = state.records.get(id)
        blockSourceRecall(this.#root, previous)
        // A physical purge must also discard the derived copy of this record.
        try { unlinkSync(join(this.#root, CACHE_FILE)) } catch (error) {
          if (error?.code !== 'ENOENT') throw error
        }
        const kept = readJsonl(state.file).records.filter((record) => record.id !== id)
        mkdirSync(state.dir, { recursive: true, mode: 0o700 })
        const text = kept.map((record) => `${JSON.stringify(record)}\n`).join('')
        const temp = `${state.file}.tmp`
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
          // Directory fsync is best effort.
        }
        state.records.delete(id)
        state.lines = kept.length
        state.bytes = Buffer.byteLength(text)
        state.stamp = fileStamp(state.file)
        this.#touch()
        return true
      })
      if (purged) this.#onChange?.({ type: 'remove', records: [previous], id, state })
      return purged
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

  /** Snapshot all recoverable local data; unlike exportData, retain evidence/history. */
  backup() {
    // Snapshot validation detects concurrent mutations without freezing writers.
    this.#backupInFlight ??= createCompleteBackup(this.#root, this.#clock()).finally(() => { this.#backupInFlight = null })
    return this.#backupInFlight
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
        if (current?.status === 'deleted' && record.status !== 'deleted') { skipped++; protectedDeleted++ }
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
    const parsed = readJsonl(state.file)
    if (stamp === state.stamp) return
    state.records = new Map(latestRevisions(parsed.records).map((record) => [record.id, record]))
    state.lines = parsed.lines
    state.bytes = parsed.bytes
    state.corrupt = parsed.corrupt
    state.stamp = stamp
    if (parsed.corrupt > 0) this.#quarantine(state.file, parsed.corruptLines)
    this.#onChange?.({ type: 'refresh', state })
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
    return withFileLock(join(this.#root, '.write.lock'), fn)
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
