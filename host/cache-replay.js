import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs'
import { scopePaths } from './paths.js'
import { authorityFileStamp, parseMemoryLines } from './store.js'

const MAX_REPLAY_BYTES = 512 * 1024
const MAX_REPLAY_REVISIONS = 512
const PROTECTED_STAMPS = new Set(['intent', 'purged'])

function scopeOf(key) {
  if (key === 'global') return { scope: 'global', projectKey: null }
  if (typeof key === 'string' && key.startsWith('project:')) return { scope: 'project', projectKey: key.slice(8) }
  throw new Error('unknown authority scope')
}

function filePosition(stamp) {
  const fields = typeof stamp === 'string' ? stamp.split(':') : []
  if (fields.length !== 5 || !/^\d+$/u.test(fields[2])) return null
  const [dev, ino, bytes] = fields, size = Number(bytes)
  return Number.isSafeInteger(size) ? { dev, ino, size } : null
}

function readParts(file, stamp, prefixSize) {
  const listed = lstatSync(file, { bigint: true })
  if (!listed.isFile() || authorityFileStamp(listed) !== stamp) throw new Error('authority file changed')
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  try {
    const info = fstatSync(fd, { bigint: true })
    const size = Number(info.size), tailSize = size - prefixSize
    if (!info.isFile() || authorityFileStamp(info) !== stamp || !Number.isSafeInteger(size) ||
        tailSize < 0 || tailSize > MAX_REPLAY_BYTES) throw new Error('authority file changed')
    const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(Math.min(prefixSize, 128 * 1024))
    for (let offset = 0; offset < prefixSize;) {
      const read = readSync(fd, buffer, 0, Math.min(buffer.length, prefixSize - offset), offset)
      if (read <= 0) throw new Error('authority prefix could not be read')
      hash.update(buffer.subarray(0, read))
      offset += read
      if (offset === prefixSize && buffer[read - 1] !== 10) throw new Error('authority prefix has no line boundary')
    }
    const tail = Buffer.allocUnsafe(tailSize)
    for (let offset = 0; offset < tail.length;) {
      const read = readSync(fd, tail, offset, tail.length - offset, prefixSize + offset)
      if (read <= 0) throw new Error('authority append could not be read')
      offset += read
    }
    if (tail.length && tail.at(-1) !== 10 || authorityFileStamp(fstatSync(fd, { bigint: true })) !== stamp ||
        authorityFileStamp(lstatSync(file, { bigint: true })) !== stamp) throw new Error('authority append is incomplete')
    return { prefix: hash.digest('hex'), tail }
  } finally { closeSync(fd) }
}

/** The derived file holds hashes and counts. The JSONL still holds all revisions. */
export function capturePrefixes(root, stamps, scopes) {
  if (new Map(stamps).get('intent') !== null) return null
  const prefixes = []
  try {
    for (const [key, stamp] of stamps) {
      if (PROTECTED_STAMPS.has(key) || stamp === null) continue
      const state = scopes.get(key), position = filePosition(stamp)
      if (!state || !position || state.stamp !== stamp || state.bytes !== position.size || state.corrupt !== 0 || state.intent) return null
      const { scope, projectKey } = scopeOf(key)
      const checked = readParts(scopePaths(root, scope, projectKey).file, stamp, position.size)
      prefixes.push([key, { lines: state.lines, hash: checked.prefix }])
    }
    return prefixes
  } catch { return null }
}

/** File metadata only selects candidates. Replay must verify the old bytes. */
export function planCacheAppends(checkpoint, current, scopes = null) {
  if (!Array.isArray(checkpoint?.prefixes)) return null
  const before = new Map(checkpoint.stamp), after = new Map(current), anchors = new Map(checkpoint.prefixes)
  if (before.get('intent') !== null || after.get('intent') !== null || before.get('purged') !== after.get('purged')) return null
  for (const key of before.keys()) if (!after.has(key)) return null
  const files = []
  let bytes = 0, revisions = 0
  for (const [key, next] of current) {
    const previous = before.get(key) ?? null
    if (PROTECTED_STAMPS.has(key) || previous === next) continue
    const oldPosition = filePosition(previous), newPosition = filePosition(next)
    if (!newPosition || previous !== null && (!oldPosition || oldPosition.dev !== newPosition.dev || oldPosition.ino !== newPosition.ino)) return null
    const start = oldPosition?.size ?? 0, anchor = anchors.get(key)
    if (oldPosition && (!Number.isSafeInteger(anchor?.lines) || anchor.lines < 0 || !/^[a-f0-9]{64}$/u.test(anchor.hash))) return null
    if (newPosition.size <= start) return null
    bytes += newPosition.size - start
    if (bytes > MAX_REPLAY_BYTES) return null
    if (scopes) {
      const state = scopes.get(key)
      if (!state || state.stamp !== next || state.corrupt !== 0 || state.intent || state.lines < (anchor?.lines ?? 0)) return null
      revisions += state.lines - (anchor?.lines ?? 0)
      if (revisions > MAX_REPLAY_REVISIONS) return null
    }
    files.push({ key, previous, next, start, size: newPosition.size, anchor })
  }
  return files.length ? { files, bytes } : null
}

/** Apply complete appended revisions to a private, not-yet-published snapshot. */
export function replayCacheAppends(root, plan, scopes) {
  const changes = new Map()
  let revisions = 0
  for (const { key, previous, next, start, size, anchor } of plan.files) {
    const { scope, projectKey } = scopeOf(key)
    const { file } = scopePaths(root, scope, projectKey)
    let state = scopes.get(key)
    if (!state && previous === null) {
      state = { key, scope, projectKey, records: new Map(), lines: 0, bytes: 0, stamp: null, intent: null, corrupt: 0 }
      scopes.set(key, state)
    }
    if (!state || state.scope !== scope || state.projectKey !== projectKey || state.stamp !== previous || state.bytes !== start ||
        state.lines !== (anchor?.lines ?? 0) || state.corrupt !== 0 || state.intent) throw new Error('cached authority cursor differs')
    const { prefix, tail } = readParts(file, next, start)
    if (anchor && anchor.hash !== prefix) throw new Error('authority prefix differs')
    const parsed = parseMemoryLines(tail)
    revisions += parsed.lines
    if (parsed.corrupt || revisions > MAX_REPLAY_REVISIONS) throw new Error('invalid or large authority append')
    for (const record of parsed.records) {
      if (record.scope !== scope || (record.projectKey ?? null) !== projectKey) throw new Error('authority append has the wrong scope')
      const prior = state.records.get(record.id)
      if (prior && prior.revision >= record.revision) continue
      for (const [otherKey, other] of scopes) {
        if (otherKey !== key && other.records.has(record.id)) throw new Error('ambiguous record id in cached scopes')
      }
      const existing = changes.get(record.id)
      changes.set(record.id, { record, previous: existing ? existing.previous : prior })
      state.records.set(record.id, record)
    }
    state.lines += parsed.lines
    state.bytes = size
    state.stamp = next
  }
  return { changes: [...changes.values()], revisions }
}
