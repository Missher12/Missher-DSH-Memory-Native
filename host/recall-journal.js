/** Durable receipts for one bounded semantic-selection request per user turn. */
import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { setImmediate as yieldToHost, setTimeout as delay } from 'node:timers/promises'
import { acquireFileLock, atomicWritePrivate, syncDirectory, withFileLock } from './persistence.js'

const ID_PATTERN = /^recall_[a-f0-9]{32}$/u
const FILE_PATTERN = /^recall\/selection\/(recall_[a-f0-9]{32})\.json$/u
const TEMP_PATTERN = /^(recall_[a-f0-9]{32})\.json\.(\d+)\.[a-f0-9-]{36}\.tmp$/u
const STATES = new Set(['requested', 'completed', 'failed', 'unknown', 'not-sent'])
const SAFE_REASONS = new Set([
  'recall receipt is unreadable',
  '模型选择输出未完整结束；不会自动重试',
  '上次选择请求已发送但没有可用回执；不会自动重试',
  '请求发送前，本轮已取消',
  '模型已结束但选择输出不可用；不会自动重试',
  '模型选择回执未知；不会自动重试',
])
export const MAX_RECALL_SELECTION_BYTES = 256 * 1024

export const recallSelectionFileId = relative => FILE_PATTERN.exec(relative)?.[1]

function pathOf(root, id) {
  if (typeof root !== 'string' || root === '' || !ID_PATTERN.test(id)) throw new Error('invalid recall receipt path')
  return join(root, 'recall', 'selection', id + '.json')
}

export function recallSelectionId(sessionId, turnKey) {
  if (typeof sessionId !== 'string' || sessionId === '' || typeof turnKey !== 'string' || turnKey === '') return null
  return 'recall_' + createHash('sha256').update(sessionId + '\0' + turnKey).digest('hex').slice(0, 32)
}

const unreadable = id => ({ id, callState: 'unknown', state: 'unknown', unreadable: true, reason: 'recall receipt is unreadable' })
const encode = task => Buffer.from(JSON.stringify(task) + '\n', 'utf8')

function removeReceiptText(task) {
  const unsafeReason = task.reason != null && !SAFE_REASONS.has(task.reason)
  if (!Object.hasOwn(task, 'slotKeys') && !Object.hasOwn(task, 'resultText') &&
      !Object.hasOwn(task, 'selectionKeys') && !unsafeReason) return task
  const { slotKeys: _questions, resultText: _result, selectionKeys: _legacyProofs, ...ledger } = task
  if (unsafeReason) {
    ledger.reason = task.callState === 'unknown' ? '模型选择回执未知；不会自动重试'
      : task.state === 'failed' || task.callState === 'failed' ? '模型已结束但选择输出不可用；不会自动重试' : null
  }
  return ledger
}

function parseReceipt(bytes, id) {
  if (bytes?.length <= MAX_RECALL_SELECTION_BYTES) {
    try {
      const task = JSON.parse(bytes.toString('utf8'))
      if (task?.id === id && STATES.has(task.callState)) return task
    } catch { /* Preserve an unknown invocation when the receipt is unreadable. */ }
  }
  return null
}

/** Preserve the reservation and typed evidence references without a second copy of the text. */
export function sanitizeRecallSelectionBytes(bytes, id) {
  const raw = parseReceipt(bytes, id)
  if (!raw) return encode(unreadable(id))
  const clean = removeReceiptText(raw)
  return clean === raw ? bytes : encode(clean)
}

/** A corrupt receipt fails closed: it must never authorize another paid call. */
export function readRecallSelection(root, id) {
  const file = pathOf(root, id)
  try {
    const info = lstatSync(file)
    const task = info.isFile() && info.size <= MAX_RECALL_SELECTION_BYTES ? parseReceipt(readFileSync(file), id) : null
    return task ? removeReceiptText(task) : unreadable(id)
  } catch (error) {
    return error?.code === 'ENOENT' ? null : unreadable(id)
  }
}

/** Read durable selection reservations; an unreadable file remains reserved today. */
export function readRecallSelections(root, unknownDay = null) {
  const dir = join(root, 'recall', 'selection')
  let names
  try { names = readdirSync(dir) } catch { return [] }
  const receipts = []
  for (const name of names) {
    const id = recallSelectionFileId('recall/selection/' + name)
    if (!id) continue
    const task = readRecallSelection(root, id)
    if (!task) continue
    receipts.push(task.unreadable
      ? { ...task, budgetReservation: { day: unknownDay, calls: 1, state: 'reserved' } }
      : task)
  }
  return receipts
}

/** A call is claimed once under the same lock as migration and backup publication. */
export function writeRecallSelection(root, task, { createOnly = false } = {}) {
  const file = pathOf(root, task?.id)
  return withFileLock(join(root, '.write.lock'), () => {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    if (createOnly && (readRecallSelection(root, task.id) ||
        readdirSync(dirname(file)).some(name => TEMP_PATTERN.exec(name)?.[1] === task.id))) return false
    atomicWritePrivate(file, encode(removeReceiptText(task)))
    return true
  })
}

/** Clean the live journal off the startup path. Each receipt is independently atomic. */
export async function scrubRecallSelectionReceipts(root, signal) {
  await yieldToHost()
  const recall = join(root, 'recall'), directory = join(recall, 'selection')
  let files
  try {
    if (!lstatSync(recall).isDirectory() || !lstatSync(directory).isDirectory()) throw new Error('invalid recall receipt directory')
    files = readdirSync(directory)
  } catch (error) {
    if (error?.code === 'ENOENT') return
    throw error
  }
  for (const name of files) {
    if (signal?.aborted) return
    const temporary = TEMP_PATTERN.exec(name)
    const id = temporary?.[1] ?? recallSelectionFileId('recall/selection/' + name)
    if (!id) continue
    const file = join(directory, name)
    const lock = join(root, '.write.lock'), deadline = performance.now() + 3000
    let release
    while (!release) {
      if (signal?.aborted) return
      try { release = acquireFileLock(lock, 0) }
      catch (error) {
        if (error?.code !== 'memory-lock-in-use' || performance.now() >= deadline) throw error
        await delay(15)
      }
    }
    try {
      const info = lstatSync(file)
      if (info.isFile() && temporary) {
        let abandoned = false
        try { process.kill(Number(temporary[2]), 0) }
        catch (error) { abandoned = error?.code === 'ESRCH' }
        if (abandoned) {
          if (!readRecallSelection(root, id)) atomicWritePrivate(pathOf(root, id), encode(unreadable(id)))
          unlinkSync(file)
          syncDirectory(directory)
        }
      } else if (info.isFile()) {
        const bytes = info.size <= MAX_RECALL_SELECTION_BYTES ? readFileSync(file) : undefined
        const clean = sanitizeRecallSelectionBytes(bytes, id)
        if (clean !== bytes) atomicWritePrivate(file, clean)
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    } finally { release() }
    await yieldToHost()
  }
}
