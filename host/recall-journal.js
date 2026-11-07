/** Durable receipts for one bounded semantic-selection request per user turn. */
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeSync } from 'node:fs'
import { dirname, join } from 'node:path'

const ID_PATTERN = /^recall_[a-f0-9]{32}$/u

function pathOf(root, id) {
  if (typeof root !== 'string' || root === '' || !ID_PATTERN.test(id)) throw new Error('invalid recall receipt path')
  return join(root, 'recall', 'selection', `${id}.json`)
}

export function recallSelectionId(sessionId, turnKey) {
  if (typeof sessionId !== 'string' || sessionId === '' || typeof turnKey !== 'string' || turnKey === '') return null
  return `recall_${createHash('sha256').update(`${sessionId}\0${turnKey}`).digest('hex').slice(0, 32)}`
}

/** A corrupt receipt fails closed: it must never authorize another paid call. */
export function readRecallSelection(root, id) {
  const file = pathOf(root, id)
  try {
    const task = JSON.parse(readFileSync(file, 'utf8'))
    if (task?.id === id && ['requested', 'completed', 'failed', 'unknown', 'not-sent'].includes(task.callState)) return task
  } catch {
    // Missing receipt is a normal first call; corrupt receipts are unknown.
  }
  return existsSync(file) ? { id, callState: 'unknown', state: 'unknown', reason: 'recall receipt is unreadable' } : null
}

/** Read durable selection reservations; an unreadable file remains reserved today. */
export function readRecallSelections(root, unknownDay = null) {
  const dir = join(root, 'recall', 'selection')
  let names
  try { names = readdirSync(dir) } catch { return [] }
  const receipts = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const id = name.slice(0, -5)
    if (!ID_PATTERN.test(id)) continue
    try {
      const task = JSON.parse(readFileSync(join(dir, name), 'utf8'))
      if (task?.id === id && ['requested', 'completed', 'failed', 'unknown', 'not-sent'].includes(task.callState)) {
        receipts.push(task)
        continue
      }
    } catch {
      // Preserve the daily call reservation when a sent receipt is unreadable.
    }
    receipts.push({ id, callState: 'unknown', budgetReservation: { day: unknownDay, calls: 1, state: 'reserved' } })
  }
  return receipts
}

/** Atomic private-file replacement, written before and after the provider call. */
export function writeRecallSelection(root, task) {
  const file = pathOf(root, task?.id)
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
  const fd = openSync(temporary, 'wx', 0o600)
  const data = Buffer.from(`${JSON.stringify(task)}\n`, 'utf8')
  let closed = false
  try {
    let offset = 0
    while (offset < data.length) {
      const written = writeSync(fd, data, offset, data.length - offset)
      if (!Number.isInteger(written) || written <= 0) throw new Error('recall receipt write made no progress')
      offset += written
    }
    fsyncSync(fd)
    closeSync(fd)
    closed = true
  } catch (error) {
    if (!closed) {
      try { closeSync(fd) } catch { /* preserve the write error */ }
    }
    try { unlinkSync(temporary) } catch { /* best effort cleanup */ }
    throw error
  }
  renameSync(temporary, file)
  try {
    const dir = openSync(dirname(file), 'r')
    try { fsyncSync(dir) } finally { closeSync(dir) }
  } catch {
    // Directory fsync is best effort on platforms that do not support it.
  }
  return task
}
