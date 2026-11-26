import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { knowledgeFileSignature, KNOWLEDGE_DIR, readKnowledgeSnapshot } from './knowledge.js'
import { atomicWritePrivateAsync } from './persistence.js'

const VERSION = 2
const MAX_CACHE_BYTES = 32 * 1024 * 1024
const DIGEST = /^[a-f0-9]{64}$/u
const PERIOD_STATUSES = new Set(['active', 'superseded', 'excluded'])
const cachePath = root => join(root, 'derived-knowledge-directory.json')
const hash = value => createHash('sha256').update(value).digest('hex')
const validBoundary = value => value === null || Number.isFinite(value)

export const directoryRouteKey = (file, signature) => hash(file + '\0' + signature)
export const directoryBucket = projectKey => projectKey === null ? 'global' : hash(projectKey)

function cacheFileStat(file) {
  const stat = lstatSync(file, { throwIfNoEntry: false })
  return stat?.isFile() && stat.size <= MAX_CACHE_BYTES ? stat : null
}

export function hasDirectoryCache(root) {
  try { return cacheFileStat(cachePath(root)) !== null } catch { return false }
}

export function knowledgePeriod({ status, quoted, validFrom, validTo }) {
  const start = validFrom ?? null
  const end = validTo ?? null
  if (quoted || (status !== 'active' && status !== 'superseded') || !validBoundary(start) || !validBoundary(end)) {
    return ['excluded', null, null]
  }
  return [status, start, end]
}

export function matchesKnowledgePeriod([status, start, end], now, asOf) {
  if (status !== 'active' && (asOf === null || status !== 'superseded')) return false
  if (asOf !== null && (!Number.isFinite(asOf) || start === null || (status === 'superseded' && end === null))) return false
  const at = asOf ?? now
  return !(start !== null && start > at) && !(end !== null && end <= at)
}

export function readDirectoryEntry(root, file, routes, previousSignature) {
  let signature
  try {
    const stat = lstatSync(join(root, KNOWLEDGE_DIR, file))
    if (!stat.isFile()) return {}
    signature = knowledgeFileSignature(stat)
    if (signature === previousSignature) return null
  } catch { return {} }
  const hint = routes?.get(directoryRouteKey(file, signature))
  if (hint !== undefined) return { signature, hint }
  try {
    const header = readKnowledgeSnapshot(root, file, { headerOnly: true })
    return { signature: header.signature, header }
  } catch { return { signature } }
}

function validRoute(row, version) {
  if (!Array.isArray(row) || row.length !== (version === 1 ? 2 : 3)) return false
  const [key, bucket, period = null] = row
  return typeof key === 'string' && DIGEST.test(key) &&
    typeof bucket === 'string' && (bucket === 'global' || DIGEST.test(bucket)) &&
    (period === null || (Array.isArray(period) && period.length === 3 &&
      PERIOD_STATUSES.has(period[0]) && validBoundary(period[1]) && validBoundary(period[2])))
}

/** A routing hint contains no note text or authorization. */
export function readDirectoryRoutes(root) {
  let descriptor
  try {
    const file = cachePath(root)
    const listed = cacheFileStat(file)
    if (!listed) return null
    descriptor = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    const current = fstatSync(descriptor)
    const signature = knowledgeFileSignature(listed)
    if (!current.isFile() || knowledgeFileSignature(current) !== signature) return null
    const contents = readFileSync(descriptor, 'utf8')
    if (knowledgeFileSignature(fstatSync(descriptor)) !== signature) return null
    const saved = JSON.parse(contents)
    if ((saved?.version !== 1 && saved?.version !== VERSION) || !Array.isArray(saved.routes) ||
        !saved.routes.every(row => validRoute(row, saved.version)) ||
        saved.checksum !== hash(JSON.stringify(saved.routes))) return null
    const routes = new Map(saved.routes.map(([key, bucket, period = null]) => [key, { bucket, period }]))
    return routes.size === saved.routes.length ? routes : null
  } catch { return null }
  finally { if (descriptor !== undefined) closeSync(descriptor) }
}

export async function writeDirectoryRoutes(root, entries) {
  const routes = []
  for (const [file, { signature, bucket, period }] of entries) {
    if (bucket !== undefined) routes.push([directoryRouteKey(file, signature), bucket, period])
  }
  const checksum = hash(JSON.stringify(routes))
  const contents = JSON.stringify({ version: VERSION, routes, checksum })
  if (Buffer.byteLength(contents) <= MAX_CACHE_BYTES) await atomicWritePrivateAsync(cachePath(root), contents)
}
