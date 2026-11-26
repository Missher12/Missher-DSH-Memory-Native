/** One in-flight authority change per data root, serialized by the store writer lock. */
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, readSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { isValidProjectKey, scopePaths } from './paths.js'
import { atomicWritePrivate, syncDirectory, truncateFile } from './persistence.js'
import { isNoteDigest } from './obsidian-note.js'
import { validRevocation } from './revocation-ledger.js'

const intentPath = root => join(root, '.authority-intent.json')
const intents = new Map()
const integer = value => Number.isSafeInteger(value) && value >= 0
const id = value => typeof value === 'string' && value !== ''
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const validScope = value => value?.scope === 'global' && value.projectKey === null ||
  value?.scope === 'project' && isValidProjectKey(value.projectKey)
const validFile = value => typeof value?.dev === 'string' && /^\d+$/u.test(value.dev) &&
  typeof value?.ino === 'string' && /^\d+$/u.test(value.ino)
const sameFile = (stat, value) => String(stat.dev) === value.dev && String(stat.ino) === value.ino

export function authorityIdentity(stat) {
  return { dev: String(stat.dev), ino: String(stat.ino) }
}

function validAppend(append) {
  return validScope(append) && validFile(append) &&
    integer(append.start) && integer(append.length) && append.length > 0 && integer(append.start + append.length) &&
    /^[a-f0-9]{64}$/u.test(append.sha256)
}

export function readAuthorityIntent(root) {
  const file = intentPath(root)
  let stat, value
  try {
    stat = lstatSync(file, { bigint: true, throwIfNoEntry: false })
    if (stat === undefined) {
      intents.delete(file)
      return null
    }
    if (!stat.isFile()) throw new Error('记忆写入恢复记录不是普通文件。')
    const stamp = [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':')
    const cached = intents.get(file)
    if (cached?.stamp === stamp) return cached.value
    value = JSON.parse(readFileSync(file, 'utf8'))
    const { appends, purge, targets } = value ?? {}
    if (value?.version !== 1 || !id(value.id) || !Array.isArray(appends) || !appends.every(validAppend) || !targets ||
        new Set(appends.map(append => scopePaths(root, append.scope, append.projectKey).file)).size !== appends.length ||
        purge !== undefined && (appends.length || !validScope(purge) || !id(purge.id) ||
          !validFile(purge.before) || !validFile(purge.after) || !integer(purge.bytes) ||
          purge.noteDigests !== undefined && (!Array.isArray(purge.noteDigests) || !purge.noteDigests.every(isNoteDigest))) ||
        !Array.isArray(targets.sourceIds) || !targets.sourceIds.every(value => /^src_[a-f0-9]{24}$/u.test(value)) ||
        !Array.isArray(targets.recordThrough) || !targets.recordThrough.every(item => id(item?.id) &&
          (item.projectKey === null || isValidProjectKey(item.projectKey)) && integer(item.revision) && item.revision > 0) ||
        targets.deletions !== undefined && (!Array.isArray(targets.deletions) || !targets.deletions.every(validRevocation)) ||
        targets.reason !== undefined && targets.reason !== 'delete') {
      throw new Error('记忆写入恢复记录无效。')
    }
    intents.set(file, { stamp, value })
    return value
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    intents.delete(file)
    return null
  }
}

export function authorityAppend(state, stat, bytes) {
  return {
    scope: state.scope, projectKey: state.scope === 'global' ? null : state.projectKey,
    start: Number(stat.size), length: bytes.length,
    ...authorityIdentity(stat), sha256: digest(bytes),
  }
}

export function prepareAuthorityIntent(root, { appends = [], purge, targets }) {
  const intent = { version: 1, id: randomUUID(), appends, purge, targets }
  atomicWritePrivate(intentPath(root), `${JSON.stringify(intent)}\n`)
  return intent
}

export function clearAuthorityIntent(root) {
  unlinkSync(intentPath(root))
  intents.delete(intentPath(root))
  syncDirectory(root)
}

/** A competing reader must not load the first complete lines of a partial batch. */
export function visibleAuthorityBytes(root, file, bytes, intent) {
  const append = intent?.appends.find(value => file === scopePaths(root, value.scope, value.projectKey).file)
  if (!append) return bytes
  const end = append.start + append.length
  if (bytes.length < end && bytes.length >= append.start) return bytes.subarray(0, append.start)
  if (bytes.length !== end || digest(bytes.subarray(append.start)) !== append.sha256) {
    throw new Error('无法验证中断的记忆写入，已保留恢复记录。')
  }
  const complete = intent.appends.every(value => value === append || checkAppend(root, value))
  return complete ? bytes : bytes.subarray(0, append.start)
}

function checkAppend(root, append, durable = false) {
  const { file } = scopePaths(root, append.scope, append.projectKey)
  let fd
  try { fd = openSync(file, durable ? 'r+' : 'r') }
  catch (error) {
    if (error?.code === 'ENOENT' && append.start === 0) return false
    throw error
  }
  try {
    const stat = fstatSync(fd, { bigint: true })
    const size = Number(stat.size)
    const end = append.start + append.length
    if (!sameFile(stat, append) || size < append.start || size > end) {
      throw new Error('记忆文件与恢复记录不一致，未覆盖现有数据。')
    }
    if (size !== end) return false
    const hash = createHash('sha256')
    const buffer = Buffer.allocUnsafe(Math.min(append.length, 128 * 1024))
    for (let offset = append.start; offset < end;) {
      const read = readSync(fd, buffer, 0, Math.min(buffer.length, end - offset), offset)
      if (read <= 0) throw new Error('无法完整读回中断的记忆写入。')
      hash.update(buffer.subarray(0, read))
      offset += read
    }
    if (hash.digest('hex') !== append.sha256) throw new Error('中断的记忆写入校验失败，未覆盖现有数据。')
    if (durable) fsyncSync(fd)
    return true
  } finally { closeSync(fd) }
}

/** Called with the writer lock. Prove the whole change or restore every affected file. */
export function recoverAuthorityWrite(root, { appends, purge }) {
  if (purge) {
    const { dir, file } = scopePaths(root, purge.scope, purge.projectKey)
    const stat = statSync(file, { bigint: true })
    if (sameFile(stat, purge.before)) return false
    if (!sameFile(stat, purge.after) || Number(stat.size) !== purge.bytes) throw new Error('无法核对永久删除后的记忆文件。')
    syncDirectory(dir)
    return true
  }
  // Check every file before deciding whether it is safe to truncate any of them.
  const complete = appends.map(append => checkAppend(root, append, true))
  const committed = complete.every(Boolean)
  for (const append of appends) {
    const { dir, file } = scopePaths(root, append.scope, append.projectKey)
    if (committed) syncDirectory(dir)
    else {
      try { truncateFile(file, append.start) }
      catch (error) { if (error?.code !== 'ENOENT' || append.start !== 0) throw error }
    }
  }
  return committed
}
