import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setImmediate as yieldToHost } from 'node:timers/promises'
import { deserialize, serialize } from 'node:v8'
import { readAuthorityIntent } from './authority-intent.js'
import { CAPTURE_DIR, SOURCE_DIR } from './capture-journal.js'
import { SOURCE_PASSAGE_CACHE_DIR, SOURCE_PASSAGE_CACHE_KEY } from './paths.js'
import { MemoryIndex } from './search.js'

const MIN_SOURCES = 4096
const MAX_BYTES = 256 * 1024 * 1024
const VERSION = 2
export const SOURCE_PASSAGE_DESCRIPTOR = Symbol('source passage descriptor')
const folder = root => join(root, SOURCE_PASSAGE_CACHE_DIR)
const keyFile = root => join(folder(root), SOURCE_PASSAGE_CACHE_KEY)
const indexFile = (root, projectKey) => join(folder(root), createHash('sha256').update(projectKey).digest('hex') + '.bin')
const mac = (key, bytes) => createHmac('sha256', key).update(bytes).digest()
const opaqueTerm = (key, term) => mac(key, term).subarray(0, 16).toString('hex')

function directoryStamp(path, identityOnly = false) {
  const stat = lstatSync(path, { bigint: true, throwIfNoEntry: false })
  if (!stat?.isDirectory()) return null
  const identity = [stat.dev, stat.ino]
  return (identityOnly ? identity : [...identity, stat.mtimeNs, stat.ctimeNs]).join(':')
}

export function sourceCacheAuthority(root, projectKey) {
  try {
    if (readAuthorityIntent(root)) return null
    const rootIdentity = directoryStamp(root, true)
    const originalStamp = directoryStamp(join(root, CAPTURE_DIR, SOURCE_DIR))
    const grantStamp = directoryStamp(join(root, CAPTURE_DIR, 'recall-grants', projectKey))
    return rootIdentity && originalStamp && grantStamp ? [rootIdentity, originalStamp, grantStamp].join('|') : null
  } catch { return null }
}

export function sameSourceCacheDirectories(left, right) {
  if (!left || !right) return false
  const identity = state => state.split('|').map(directory => directory.split(':', 2).join(':')).join('|')
  return identity(left) === identity(right)
}

function readKey(root) {
  const stat = lstatSync(keyFile(root), { throwIfNoEntry: false })
  if (!stat?.isFile() || stat.size !== 32) return null
  const key = readFileSync(keyFile(root))
  return key.length === 32 ? key : null
}

function createKey(root) {
  const prior = readKey(root)
  if (prior) return prior
  mkdirSync(folder(root), { recursive: true, mode: 0o700 })
  if (!directoryStamp(folder(root), true)) return null
  const seed = randomBytes(32)
  try { writeFileSync(keyFile(root), seed, { flag: 'wx', mode: 0o600 }); return seed }
  catch (error) {
    if (error?.code === 'EEXIST') return readKey(root)
    throw error
  }
}

function decode(root, projectKey, key, bytes, authority) {
  const payload = bytes.subarray(32)
  if (!timingSafeEqual(bytes.subarray(0, 32), mac(key, payload))) return null
  const data = deserialize(payload)
  if (data.version !== VERSION || data.v8 !== process.versions.v8 || !sameSourceCacheDirectories(data.authority, authority) ||
      data.projectKey !== projectKey || sourceCacheAuthority(root, projectKey) !== authority ||
      !readKey(root)?.equals(key)) return null
  const { index, rows } = data
  if (!Array.isArray(rows) || rows.length !== index.lengths.length) return null
  const recordAt = position => {
    const [id, sourceId, from, to, contentHash, sourceHash, sourceLength, observedAt, sessionId, messageId,
      at, eventTime, eventSeq, timeZone, previousUserSourceId] = rows[position]
    return { [SOURCE_PASSAGE_DESCRIPTOR]: true, id, kind: 'source', scope: 'project', projectKey, status: 'active',
      contentHash, sourceHash, sourceLength, observedAt, updatedAt: observedAt, previousUserSourceId,
      sourceRefs: [{ sourceId, sessionId, messageId, from, to, at, eventTime, eventSeq, timeZone }] }
  }
  const restored = new MemoryIndex().restore({
    ...index, slots: Array.from({ length: rows.length }, (_, at) => at),
    recordAt, hotAt: recordAt, termIds: new Map(index.termNames.map((term, id) => [term, id])),
    encodeTerm: term => opaqueTerm(key, term),
  })
  if (restored.size !== rows.length || restored.size < MIN_SOURCES) return null
  return {
    index: restored, authority: data.authority, key,
    *records(sessionId = null) {
      for (let i = 0; i < rows.length; i++) {
        if (sessionId === null || rows[i][8] === sessionId) yield recordAt(i)
      }
    },
  }
}

function indexLocation(root, projectKey) {
  if (!directoryStamp(folder(root), true)) return null
  const path = indexFile(root, projectKey)
  const stat = lstatSync(path, { throwIfNoEntry: false })
  return stat?.isFile() && stat.size > 32 && stat.size <= MAX_BYTES ? path : null
}

export function readSourceCache(root, projectKey, authority) {
  if (!authority) return null
  try {
    const path = indexLocation(root, projectKey)
    const key = path && readKey(root)
    return key ? decode(root, projectKey, key, readFileSync(path), authority) : null
  } catch { return null }
}

export async function readSourceCacheAsync(root, projectKey, authority) {
  if (!authority) return null
  try {
    const path = indexLocation(root, projectKey)
    const key = path && readKey(root)
    return key ? decode(root, projectKey, key, await readFile(path), authority) : null
  } catch { return null }
}

export async function writeSourceCache(root, projectKey, authority, snapshot, count, encodedKey = null) {
  if (count < MIN_SOURCES || !authority || sourceCacheAuthority(root, projectKey) !== authority ||
      snapshot.slots.some(record => record === null)) return false
  let temp
  try {
    const key = createKey(root)
    if (!key || encodedKey && !encodedKey.equals(key)) return false
    const { termIds, termNames, slots, ...index } = snapshot
    const nameHashes = [], rows = []
    for (let i = 0; i < termNames.length; i++) {
      nameHashes.push(encodedKey ? termNames[i] : opaqueTerm(key, termNames[i]))
      if (i % 1024 === 1023) await yieldToHost()
    }
    for (let i = 0; i < slots.length; i++) {
      const record = slots[i], ref = record.sourceRefs[0]
      rows.push([record.id, ref.sourceId, ref.from, ref.to, record.contentHash, record.sourceHash, record.sourceLength,
        record.observedAt, ref.sessionId, ref.messageId, ref.at, ref.eventTime, ref.eventSeq, ref.timeZone, record.previousUserSourceId])
      if (i % 1024 === 1023) await yieldToHost()
    }
    const payload = serialize({ version: VERSION, v8: process.versions.v8, authority, projectKey, rows,
      index: { ...index, termNames: nameHashes } })
    if (payload.length + 32 > MAX_BYTES) return false
    const path = indexFile(root, projectKey)
    temp = path + '.' + randomUUID() + '.tmp'
    await writeFile(temp, Buffer.concat([mac(key, payload), payload]), { mode: 0o600, flag: 'wx' })
    if (sourceCacheAuthority(root, projectKey) !== authority || !readKey(root)?.equals(key)) return false
    await rename(temp, path)
    temp = undefined
    return true
  } catch { return false }
  finally {
    if (temp) await unlink(temp).catch(() => {})
  }
}
