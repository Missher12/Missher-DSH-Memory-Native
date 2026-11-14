/**
 * Durable capture journal: full source messages, turn intakes, extraction tasks
 * and supersede intents.
 *
 * Every record is written with fsync (and atomic rename for whole files) so a
 * crash cannot lose the fact that a turn was accepted or that a paid request
 * completed. Full message text stays in one private source file (0600); tasks
 * and intakes contain only ids, offsets, status and small diagnostics.
 *
 * @module dsh-memory/host/capture-journal
 */

import { createHash } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { gunzipSync, gzipSync } from 'node:zlib'
import { dirname, join } from 'node:path'

import { nextRevision } from './records.js'
import { truncateFile } from './persistence.js'

export const CAPTURE_DIR = 'capture'
export const SOURCE_DIR = 'sources'
export const TASKS_FILE = 'capture-tasks.jsonl'
export const TURNS_FILE = 'capture-turns.jsonl'
export const REPLACEMENTS_FILE = 'capture-replacements.jsonl'
export const TASK_STATUSES = Object.freeze(['pending', 'running', 'done', 'partial', 'failed', 'unknown', 'skipped'])
export const CALL_STATES = Object.freeze(['not-sent', 'requested', 'completed', 'failed', 'unknown'])
const TASKS_COMPACT_BYTES = 512 * 1024
const SOURCE_ID_PATTERN = /^src_[a-f0-9]{24}$/u
const TASK_ID_PATTERN = /^cap_[a-f0-9]{24}$/u
const TURN_ID_PATTERN = /^turn_[a-f0-9]{24}$/u
const REPLACEMENT_ID_PATTERN = /^rep_[a-f0-9]{24}$/u

function hash(value) {
  return createHash('sha256').update(String(value)).digest('hex')
}

function fsyncDir(dir) {
  try {
    const fd = openSync(dir, 'r')
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  } catch {
    // Directory fsync is best effort on platforms that do not support it.
  }
}

/** Write every byte, resuming at the returned byte offset on a legal short write. */
function writeAllSync(fd, content) {
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8')
  let offset = 0
  while (offset < buffer.length) {
    const written = writeSync(fd, buffer, offset, buffer.length - offset)
    if (!Number.isInteger(written) || written <= 0) {
      throw new Error(`short write made no progress at byte ${offset}/${buffer.length}`)
    }
    offset += written
  }
  return buffer.length
}

function writeAtomic(file, content) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const temp = `${file}.tmp`
  const fd = openSync(temp, 'w', 0o600)
  let complete = false
  try {
    writeAllSync(fd, content)
    fsyncSync(fd)
    complete = true
  } finally {
    closeSync(fd)
    if (!complete) {
      try { unlinkSync(temp) } catch { /* best effort; original file is untouched */ }
    }
  }
  renameSync(temp, file)
  fsyncDir(dirname(file))
}

function appendDurable(file, value) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const fd = openSync(file, 'a', 0o600)
  let start = 0
  try {
    start = fstatSync(fd).size
    writeAllSync(fd, `${JSON.stringify(value)}\n`)
    fsyncSync(fd)
  } catch (error) {
    // Never leave a partial journal line that could be mistaken for a task
    // identity; roll back to the pre-append byte offset.
    try { truncateFile(file, start) }
    catch (rollback) { error.rollbackFailed = rollback?.code ?? 'unknown' }
    throw error
  } finally {
    closeSync(fd)
  }
}

function captureDir(root) {
  return join(root, CAPTURE_DIR)
}

function sourceDir(root) {
  return join(captureDir(root), SOURCE_DIR)
}

/**
 * Stable source identity. A host message id or event sequence/time is used when
 * available; only a truly identity-less event falls back to role+content, which
 * may collapse two identical messages but never treats processing time as an
 * identity or double-bills a replay.
 */
export function sourceIdentityOf(input) {
  if (typeof input?.messageId === 'string' && input.messageId !== '') {
    return { kind: 'message-id', value: input.messageId }
  }
  if (Number.isInteger(input?.eventSeq)) return { kind: 'event-seq', value: String(input.eventSeq) }
  if (typeof input?.eventTime === 'number' && Number.isFinite(input.eventTime)) {
    return { kind: 'event-time', value: String(Math.floor(input.eventTime)) }
  }
  return { kind: 'content-fallback', value: `${input?.role === 'user' ? 'user' : 'assistant'}:${input?.text ?? ''}` }
}

/** Deterministic source id; processing time (`at`) is deliberately excluded. */
export function sourceIdOf(input) {
  const identity = sourceIdentityOf(input)
  return `src_${hash([
    input?.sessionId ?? '',
    input?.role === 'user' ? 'user' : 'assistant',
    identity.kind,
    identity.value,
    input?.text ?? '',
  ].join('\u0000')).slice(0, 24)}`
}

/**
 * Persist one full source message and verify it can be read back.
 * @returns {{ id: string, sessionId: string, messageId: string | null, role: string, at: number, chars: number, identityKind: string }}
 */
export function saveSource(root, input) {
  const sessionId = typeof input?.sessionId === 'string' ? input.sessionId : ''
  const text = typeof input?.text === 'string' ? input.text : ''
  const role = input?.role === 'user' ? 'user' : 'assistant'
  const at = typeof input?.at === 'number' && Number.isFinite(input.at) ? input.at : Date.now()
  if (sessionId === '' || text === '') throw new Error('source requires sessionId and text')
  const messageId = typeof input?.messageId === 'string' && input.messageId !== '' ? input.messageId : null
  const sourceKind = typeof input?.sourceKind === 'string' && input.sourceKind !== '' ? input.sourceKind : 'unknown'
  const sourceForm = typeof input?.sourceForm === 'string' && input.sourceForm !== '' ? input.sourceForm : undefined
  const identity = sourceIdentityOf({ ...input, messageId, role, text })
  const id = sourceIdOf({ ...input, messageId, role, text })
  const file = join(sourceDir(root), `${id}.json`)
  const gzipFile = `${file}.gz`
  const payload = {
    id, sessionId, messageId, role, sourceKind,
    ...(sourceForm === undefined ? {} : { sourceForm }),
    at, chars: text.length, identityKind: identity.kind,
    projectKey: typeof input.projectKey === 'string' ? input.projectKey : null,
    compressed: true, textHash: createHash('sha256').update(text).digest('hex'), textBytes: Buffer.byteLength(text),
  }
  if (!existsSync(file)) {
    // Compress the full original first, then publish metadata. A crash between
    // the two writes leaves an orphan .gz, never a metadata file that points
    // at missing text.
    writeAtomic(gzipFile, gzipSync(Buffer.from(text, 'utf8'), { level: 6 }))
    const payloadBack = gunzipSync(readFileSync(gzipFile)).toString('utf8')
    if (payloadBack !== text) {
      try { unlinkSync(gzipFile) } catch { /* best effort */ }
      throw new Error('source gzip write-back verification failed')
    }
    writeAtomic(file, `${JSON.stringify(payload)}\n`)
  }
  const back = readSource(root, id)
  if (back === null || back.text !== text) throw new Error('source read-back verification failed')
  return { id, sessionId, messageId, role, sourceKind, at, chars: text.length, identityKind: identity.kind }
}

/** Read one source, or null when missing/corrupt. */
export function readSource(root, id) {
  if (typeof id !== 'string' || !SOURCE_ID_PATTERN.test(id)) return null
  try {
    const dir = sourceDir(root)
    const value = JSON.parse(readFileSync(join(dir, `${id}.json`), 'utf8'))
    if (value?.id !== id || typeof value.sessionId !== 'string') return null
    if (typeof value.text === 'string') return value
    if (value.compressed !== true) return null
    const text = gunzipSync(readFileSync(join(dir, `${id}.json.gz`))).toString('utf8')
    if (typeof value.textHash === 'string') {
      const actual = createHash('sha256').update(text).digest('hex')
      if (actual !== value.textHash) return null
    }
    return { ...value, text }
  } catch {
    return null
  }
}

// Each marker survives purge and compaction. A shared source cannot reintroduce
// forgotten words via a different active record that cites the same message.
function blockedFile(root, sourceId) { return join(sourceDir(root), sourceId + '.recall-blocked') }

export function canReadSource(root, id) {
  return typeof id === 'string' && SOURCE_ID_PATTERN.test(id) && !existsSync(blockedFile(root, id))
}

export function blockSourceRecall(root, record) {
  for (const ref of record?.sourceRefs ?? []) {
    if (!SOURCE_ID_PATTERN.test(ref.sourceId)) continue
    const file = blockedFile(root, ref.sourceId)
    if (existsSync(file)) continue
    writeAtomic(file, '')
  }
}

export function recallTaskLookup(root) {
  let tasks
  return id => {
    tasks ??= readJournal(tasksPath(root), TASK_ID_PATTERN)
    return tasks.corrupt ? null : tasks.map.get(id)
  }
}

export function readRecallSource(root, id, taskId, projectKey, lookup) {
  if (!canReadSource(root, id) || !TASK_ID_PATTERN.test(taskId)) return null
  const task = lookup(taskId)
  if (task?.projectKey !== projectKey || !task.sourceIds?.includes(id) || !['done', 'partial'].includes(task.status)) return null
  const source = readSource(root, id)
  return source?.projectKey === projectKey && source.sessionId === task.sessionId &&
    source.role === 'user' && source.sourceKind === 'user' ? { source, task } : null
}

/** Delete source files that are no longer referenced (explicit garbage collection). */
export function pruneSources(root, keepIds) {
  const dir = sourceDir(root)
  if (!existsSync(dir)) return 0
  const keep = new Set(Array.isArray(keepIds) ? keepIds : [])
  let removed = 0
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue
    const id = name.slice(0, -5)
    if (keep.has(id)) continue
    if (!SOURCE_ID_PATTERN.test(id)) continue
    try {
      unlinkSync(join(dir, name))
      try { unlinkSync(join(dir, `${name}.gz`)) } catch { /* legacy inline source */ }
      removed += 1
    } catch {
      // Best effort.
    }
  }
  return removed
}

function tasksPath(root) {
  return join(captureDir(root), TASKS_FILE)
}

function compactTasks(file) {
  let size
  try {
    size = statSync(file).size
  } catch {
    return
  }
  if (size <= TASKS_COMPACT_BYTES) return
  const { map } = readJournal(file, TASK_ID_PATTERN)
  const lines = [...map.values()].map((task) => JSON.stringify(task)).join('\n')
  if (lines !== '') writeAtomic(file, `${lines}\n`)
}

/** Read a JSONL journal, tracking corrupt lines instead of pretending it is complete. */
function readJournal(file, pattern) {
  const map = new Map()
  let corrupt = 0
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return { map, corrupt }
  }
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      const value = JSON.parse(line)
      if (value === null || typeof value !== 'object' || typeof value.id !== 'string' || !pattern.test(value.id)) {
        corrupt += 1
        continue
      }
      const current = map.get(value.id)
      if (current === undefined || (value.revision ?? 1) >= (current.revision ?? 1)) map.set(value.id, value)
    } catch {
      corrupt += 1
    }
  }
  return { map, corrupt }
}

/** Journal health for the panel; corrupt lines are visible instead of silently dropped. */
export function captureJournalHealth(root) {
  const { corrupt } = readJournal(tasksPath(root), TASK_ID_PATTERN)
  return { corruptTasks: corrupt }
}

/** All latest task revisions, oldest first. */
export function readCaptureTasks(root) {
  const file = tasksPath(root)
  return [...readJournal(file, TASK_ID_PATTERN).map.values()]
    .sort((left, right) => (left.createdAt ?? 0) - (right.createdAt ?? 0))
}

/** Deterministic task id from its identity fields. */
export function captureTaskIdOf(input) {
  return `cap_${hash([input.sessionId, input.turnKey, input.segmentIndex, input.sourceIds.join(','), input.total].join('\u0000')).slice(0, 24)}`
}

/** Append a new task revision (full object) durably. */
export function writeCaptureTask(root, task) {
  const file = tasksPath(root)
  compactTasks(file)
  const previous = readJournal(file, TASK_ID_PATTERN).map.get(task.id)
  const next = {
    ...task,
    revision: previous === undefined ? 1 : (previous.revision ?? 1) + 1,
    createdAt: previous?.createdAt ?? task.createdAt ?? Date.now(),
    updatedAt: Date.now(),
  }
  appendDurable(file, next)
  return next
}

/** Update task fields by id; a missing task is an error. */
export function updateCaptureTask(root, id, patch) {
  if (typeof id !== 'string' || !TASK_ID_PATTERN.test(id)) throw new Error('invalid capture task id')
  const current = readJournal(tasksPath(root), TASK_ID_PATTERN).map.get(id)
  if (current === undefined) throw new Error('capture task not found')
  return writeCaptureTask(root, { ...current, ...patch, id })
}

/** Deterministic turn-intake id from its sources. */
export function turnIdOf(input) {
  return `turn_${hash([input.sessionId, input.sourceIds.join(',')].join('\u0000')).slice(0, 24)}`
}

/** Persist an accepted turn synchronously, before any async route/segmentation. */
export function writeTurnIntake(root, intake) {
  const file = join(captureDir(root), TURNS_FILE)
  const previous = readJournal(file, TURN_ID_PATTERN).map.get(intake.id)
  const next = {
    ...intake,
    revision: previous === undefined ? 1 : (previous.revision ?? 1) + 1,
    createdAt: previous?.createdAt ?? intake.createdAt ?? Date.now(),
    updatedAt: Date.now(),
  }
  appendDurable(file, next)
  return next
}

/** Latest turn intakes, oldest first, plus corrupt-line count. */
export function readTurnIntakes(root) {
  const file = join(captureDir(root), TURNS_FILE)
  const { map, corrupt } = readJournal(file, TURN_ID_PATTERN)
  return {
    intakes: [...map.values()].sort((left, right) => (left.createdAt ?? 0) - (right.createdAt ?? 0)),
    corrupt,
  }
}

/** Update one intake status durably. */
export function updateTurnIntake(root, id, patch) {
  if (typeof id !== 'string' || !TURN_ID_PATTERN.test(id)) throw new Error('invalid capture turn id')
  const file = join(captureDir(root), TURNS_FILE)
  const current = readJournal(file, TURN_ID_PATTERN).map.get(id)
  if (current === undefined) throw new Error('capture turn intake not found')
  return writeTurnIntake(root, { ...current, ...patch, id })
}

/** Deterministic supersede intent id. */
export function replacementIdOf(oldId, newId) {
  return `rep_${hash(`${oldId}\u0000${newId}`).slice(0, 24)}`
}

/** Persist the intent to replace `oldId` with `newId` before appending either. */
export function writeReplacementIntent(root, intent) {
  const file = join(captureDir(root), REPLACEMENTS_FILE)
  const previous = readJournal(file, REPLACEMENT_ID_PATTERN).map.get(intent.id)
  const next = { ...intent, status: intent.status ?? 'pending', revision: (previous?.revision ?? 0) + 1 }
  appendDurable(file, next)
  return next
}

/** Latest supersede intents. */
export function readReplacementIntents(root) {
  const file = join(captureDir(root), REPLACEMENTS_FILE)
  return [...readJournal(file, REPLACEMENT_ID_PATTERN).map.values()]
    .sort((left, right) => (left.createdAt ?? 0) - (right.createdAt ?? 0))
}

/**
 * Invalidate `old` through the store's normal update path, falling back to a
 * direct locked append of the same superseded revision when update fails. Both
 * paths are local and idempotent; the caller still owns the replace intent.
 */
export function supersedeRecord(store, old, scopes, now = Date.now()) {
  try {
    const next = store.update(old.id, { status: 'superseded', validTo: now }, scopes)
    if (next !== undefined) return next
  } catch {
    // Fall through to the atomic append path below.
  }
  try {
    return store.append(nextRevision(old, { status: 'superseded', validTo: now }, now))
  } catch {
    return undefined
  }
}

/**
 * Finish any supersede interrupted between appending the replacement and
 * invalidating the old record. Only local writes; no model call.
 * @returns {object[]} updated old records that callers should upsert into the index
 */
export function reconcileReplacements(root, store, now = Date.now()) {
  const intents = readReplacementIntents(root)
  const updated = []
  for (const intent of intents) {
    if (intent.status !== 'pending') continue
    const replacement = store.find(intent.newId, intent.scopes)
    const old = store.find(intent.oldId, intent.scopes)
    if (replacement === undefined) {
      writeReplacementIntent(root, { ...intent, status: 'aborted', reason: 'replacement record missing' })
      continue
    }
    if (old !== undefined && old.status !== 'deleted' && old.status !== 'superseded') {
      const next = supersedeRecord(store, old, intent.scopes, now)
      if (next === undefined) continue // Leave the intent pending for the next recovery attempt.
      updated.push(next)
    }
    writeReplacementIntent(root, { ...intent, status: 'done' })
  }
  return updated
}

/**
 * Mark interrupted tasks after a restart. A request already marked `requested`
 * may have been billed, so it becomes `unknown` and is never retried
 * automatically. A completed result persisted before the crash replays locally;
 * a completed-but-unpersisted result becomes `unknown`, never `not-sent`.
 */
export function recoverCaptureTasks(root) {
  const tasks = readCaptureTasks(root)
  let recovered = 0
  for (const task of tasks) {
    if (task.status !== 'running') continue
    if (typeof task.resultText === 'string') {
      updateCaptureTask(root, task.id, {
        status: 'pending',
        callState: 'completed',
        replay: true,
        reason: '进程重启后本地重放已保存的模型结果',
      })
    } else if (task.callState === 'completed') {
      updateCaptureTask(root, task.id, {
        status: 'unknown',
        callState: 'unknown',
        reason: '模型已结束但结果未持久化，无法自动重放；请人工确认后重试',
      })
    } else if (task.callState === 'requested') {
      updateCaptureTask(root, task.id, {
        status: 'unknown',
        callState: 'unknown',
        reason: '提取请求发送后进程退出，结果未知；请确认后手动重试',
      })
    } else {
      updateCaptureTask(root, task.id, { status: 'pending', callState: 'not-sent', reason: '进程重启时尚未发送请求' })
    }
    recovered += 1
  }
  return recovered
}

/** Counts shown in the panel; every state is visible, not just failures. */
export function countCaptureTasks(tasks) {
  const counts = { total: 0, pending: 0, running: 0, done: 0, partial: 0, failed: 0, unknown: 0, skipped: 0 }
  for (const task of Array.isArray(tasks) ? tasks : []) {
    counts.total += 1
    if (Object.hasOwn(counts, task.status)) counts[task.status] += 1
  }
  return counts
}

/** Transparently gzip legacy inline sources; ids and journals stay unchanged. */
export function compressCaptureSources(root) {
  const dir = sourceDir(root)
  if (!existsSync(dir)) return { scanned: 0, compressed: 0, failed: 0, bytesBefore: 0, bytesAfter: 0 }
  let scanned = 0
  let compressed = 0
  let failed = 0
  let bytesBefore = 0
  let bytesAfter = 0
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue
    const file = join(dir, name)
    let value
    try {
      value = JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      continue
    }
    if (value === null || typeof value !== 'object') continue
    if (typeof value.text !== 'string') {
      bytesBefore += statSync(file).size
      try { bytesAfter += statSync(`${file}.gz`).size } catch { /* legacy */ }
      bytesAfter += statSync(file).size
      continue
    }
    scanned += 1
    bytesBefore += statSync(file).size
    const text = value.text
    const gzFile = `${file}.gz`
    const { text: _text, ...metadata } = value
    const next = {
      ...metadata,
      chars: text.length,
      compressed: true,
      textHash: createHash('sha256').update(text).digest('hex'),
      textBytes: Buffer.byteLength(text),
    }
    let published = false
    try {
      writeAtomic(gzFile, gzipSync(Buffer.from(text, 'utf8'), { level: 6 }))
      // Verify the compressed payload before publishing metadata that removes
      // the inline text: a truncated gzip must never make the source unreadable.
      const payloadBack = gunzipSync(readFileSync(gzFile)).toString('utf8')
      if (payloadBack !== text || createHash('sha256').update(payloadBack).digest('hex') !== next.textHash) {
        throw new Error('source gzip verification failed')
      }
      writeAtomic(file, `${JSON.stringify(next)}\n`)
      published = true
      const back = readSource(root, value.id)
      if (back === null || back.text !== text) throw new Error('source metadata verification failed')
      compressed += 1
      bytesAfter += statSync(file).size + statSync(gzFile).size
    } catch {
      failed += 1
      // If metadata was already published, restore the full original inline
      // record; otherwise the original file was never touched. Either way the
      // user's text remains readable.
      try {
        if (published) writeAtomic(file, `${JSON.stringify(value)}\n`)
        else unlinkSync(gzFile)
      } catch {
        // Best effort; the original inline file is still present on the
        // not-published path, and the caller keeps the failure count.
      }
    }
  }
  return { scanned, compressed, failed, bytesBefore, bytesAfter }
}

/** Observable capture-storage footprint; no source text is returned. */
export function captureStorageStatus(root) {
  const status = { sources: { count: 0, bytes: 0 }, tasks: 0, turns: 0, replacements: 0, bytes: 0 }
  const dir = sourceDir(root)
  if (existsSync(dir)) {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue
      try {
        const size = statSync(join(dir, name)).size
        status.sources.count += 1
        status.sources.bytes += size
        try {
          status.sources.bytes += statSync(join(dir, `${name}.gz`)).size
        } catch {
          // Legacy inline sources have no .gz payload.
        }
      } catch {
        // A concurrently removed source is not an error.
      }
    }
  }
  const entries = [
    ['tasks', tasksPath(root)],
    ['turns', join(captureDir(root), TURNS_FILE)],
    ['replacements', join(captureDir(root), REPLACEMENTS_FILE)],
  ]
  for (const [key, file] of entries) {
    try {
      status[key] = readJournal(file, key === 'tasks' ? TASK_ID_PATTERN : key === 'turns' ? TURN_ID_PATTERN : REPLACEMENT_ID_PATTERN).map.size
      status.bytes += statSync(file).size
    } catch {
      // Missing ledgers count as zero.
    }
  }
  status.bytes += status.sources.bytes
  return status
}

/** Compact append-only ledgers while preserving the latest revision per id. */
export function compactCaptureLedgers(root) {
  const entries = [
    [join(captureDir(root), TURNS_FILE), TURN_ID_PATTERN, 256 * 1024],
    [join(captureDir(root), REPLACEMENTS_FILE), REPLACEMENT_ID_PATTERN, 256 * 1024],
  ]
  let compacted = 0
  for (const [file, pattern, threshold] of entries) {
    try {
      if (statSync(file).size <= threshold) continue
      const { map } = readJournal(file, pattern)
      const lines = [...map.values()].map((value) => JSON.stringify(value)).join('\n')
      if (lines !== '') writeAtomic(file, `${lines}\n`)
      compacted += 1
    } catch {
      // Missing or unreadable ledgers are left untouched.
    }
  }
  compactTasks(tasksPath(root))
  return compacted
}
