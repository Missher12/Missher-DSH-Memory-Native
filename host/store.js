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
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'

import { isValidProjectKey, scopePaths } from './paths.js'
import { buildRecord, nextRevision } from './records.js'

export const SCHEMA_VERSION = 2
export const MAX_RECORDS_PER_FILE = 2000
export const MAX_BYTES_PER_FILE = 4 * 1024 * 1024

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
      if (isRecordRevision(value)) records.push(value)
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
      .filter((record) => includeDeleted || record.status !== 'deleted')
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
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
  listAll() {
    const records = [...this.list('global', null)]
    for (const projectKey of this.listProjects()) records.push(...this.list('project', projectKey))
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
  append(record) {
    if (record === null || typeof record !== 'object') throw new Error('append requires a record')
    const state = this.#state(record.scope, record.projectKey)
    const outcome = this.#withLock(() => {
      this.#refreshState(state)
      const current = state.records.get(record.id)
      let next = record
      if (current !== undefined) {
        if (record.revision <= current.revision) {
          if (record.content === current.content && record.status === current.status) {
            return { record: current, compact: false }
          }
          next = { ...record, revision: current.revision + 1 }
        }
      }
      mkdirSync(state.dir, { recursive: true, mode: 0o700 })
      const line = `${JSON.stringify(next)}\n`
      const fd = openSync(state.file, 'a', 0o600)
      try {
        writeSync(fd, line)
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      state.records.set(next.id, next)
      state.lines += 1
      state.bytes += Buffer.byteLength(line)
      this.#touch()
      return { record: next, compact: state.lines > MAX_RECORDS_PER_FILE || state.bytes > MAX_BYTES_PER_FILE }
    })
    if (outcome.compact) this.compact(record.scope, record.projectKey)
    return outcome.record
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
    const record = this.find(id, scopes)
    if (record === undefined) return undefined
    const next = nextRevision(record, patch, this.#clock())
    return this.append(next)
  }

  /** Soft-delete one record (writes a tombstone revision). */
  remove(id, scopes) {
    const record = this.find(id, scopes)
    if (record === undefined) return undefined
    return this.append(nextRevision(record, { status: 'deleted' }, this.#clock()))
  }

  /** Rewrite one authority file with only the latest revision per id (locked, re-reads first). */
  compact(scope, projectKey) {
    const state = this.#state(scope, projectKey)
    return this.#withLock(() => {
      this.#refreshState(state)
      const latest = latestRevisions([...state.records.values()])
      mkdirSync(state.dir, { recursive: true, mode: 0o700 })
      const temp = `${state.file}.tmp`
      const text = latest.map((record) => `${JSON.stringify(record)}\n`).join('')
      const fd = openSync(temp, 'w', 0o600)
      try {
        writeSync(fd, text)
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
      state.lines = latest.length
      state.bytes = Buffer.byteLength(text)
      this.#touch()
      return latest.length
    })
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

  /** Write a timestamped backup under `<root>/backups/` and return its path. */
  backup() {
    const dir = join(this.#root, 'backups')
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const stamp = new Date(this.#clock()).toISOString().replace(/[:.]/gu, '-')
    const file = join(dir, `memories-${stamp}.json`)
    writeFileSync(file, `${JSON.stringify(this.exportData(), null, 2)}\n`, { mode: 0o600 })
    return file
  }

  /**
   * Merge an exported payload into this store; newer revisions win.
   * @param {object} payload exportData() shape
   * @param {{ dryRun?: boolean }} [options]
   */
  importData(payload, options = {}) {
    const source = payload !== null && typeof payload === 'object' ? payload : {}
    const dryRun = options.dryRun === true
    let imported = 0
    let skipped = 0
    const push = (record, scope, projectKey) => {
      if (record === null || typeof record !== 'object' || typeof record.id !== 'string') {
        skipped += 1
        return
      }
      const state = this.#state(scope, projectKey)
      const current = state.records.get(record.id)
      if (current !== undefined && (record.revision ?? 0) <= current.revision) {
        skipped += 1
        return
      }
      imported += 1
      if (!dryRun) this.append({ ...record, scope, projectKey })
    }
    for (const record of Array.isArray(source.global) ? source.global : []) push(record, 'global', null)
    for (const [key, list] of Object.entries(source.projects !== null && typeof source.projects === 'object' ? source.projects : {})) {
      if (!isValidProjectKey(key) || !Array.isArray(list)) continue
      for (const record of list) push(record, 'project', key)
    }
    return { imported, skipped, dryRun }
  }

  /** Re-read one authority file when another process changed it. */
  #refreshState(state) {
    const parsed = readJsonl(state.file)
    if (parsed.bytes === state.bytes) return
    for (const record of latestRevisions(parsed.records)) {
      const current = state.records.get(record.id)
      if (current === undefined || record.revision > current.revision) state.records.set(record.id, record)
    }
    state.lines = parsed.lines
    state.bytes = parsed.bytes
    state.corrupt = parsed.corrupt
    if (parsed.corrupt > 0) this.#quarantine(state.file, parsed.corruptLines)
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
        for (const text of lines) writeSync(fd, `${JSON.stringify({ file, at: this.#clock(), text })}\n`)
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
    const lockFile = join(this.#root, '.write.lock')
    const deadline = Date.now() + 3000
    let fd
    for (;;) {
      try {
        fd = openSync(lockFile, 'wx', 0o600)
        writeSync(fd, `${process.pid}\n`)
        break
      } catch (error) {
        if (error === null || error === undefined || error.code !== 'EEXIST') throw error
        try {
          if (Date.now() - statSync(lockFile).mtimeMs > 30_000) {
            try { unlinkSync(lockFile) } catch {}
            continue
          }
        } catch {
          continue
        }
        if (Date.now() > deadline) throw new Error('memory store is locked by another process')
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
      }
    }
    try {
      return fn()
    } finally {
      try { closeSync(fd) } catch {}
      try { unlinkSync(lockFile) } catch {}
    }
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
