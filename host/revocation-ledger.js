/** Scoped deletion boundaries survive compaction and restoration. */
import { lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isValidProjectKey } from './paths.js'
import { atomicWritePrivate } from './persistence.js'

export const REVOCATION_FILE = 'recovery-revocations.json'
export const PERMANENT_REVISION = Number.MAX_SAFE_INTEGER
export const validSourceId = value => typeof value === 'string' && /^src_[a-f0-9]{24}$/u.test(value)
export const revocationKey = ({ id, projectKey }) => JSON.stringify([projectKey, id])
export const validRevocation = value => value !== null && typeof value === 'object' &&
  typeof value.id === 'string' && value.id !== '' &&
  (value.projectKey === null || isValidProjectKey(value.projectKey)) &&
  Number.isSafeInteger(value.revision) && value.revision > 0 &&
  Number.isSafeInteger(value.at) && value.at >= 0

export function mergeRevocations(entries, input) {
  let changed = false
  for (const row of input) {
    const key = revocationKey(row)
    const previous = entries.get(key)
    if (previous && (previous.revision > row.revision ||
        previous.revision === row.revision && previous.at >= row.at)) continue
    const { id, projectKey, revision, at } = row
    entries.set(key, { id, projectKey, revision, at })
    changed = true
  }
  return changed
}

export function readRevocationLedger(root) {
  const file = join(root, REVOCATION_FILE)
  const records = new Map()
  try {
    if (!lstatSync(file).isFile()) throw new Error('删除记录必须是普通文件。')
    const value = JSON.parse(readFileSync(file, 'utf8'))
    if (value?.version !== 1 || !Array.isArray(value.records) || !value.records.every(validRevocation) ||
        !Array.isArray(value.deniedSources) || !value.deniedSources.every(validSourceId)) throw new Error('删除记录格式无效。')
    mergeRevocations(records, value.records)
    return { records, deniedSources: new Set(value.deniedSources) }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    return { records, deniedSources: new Set() }
  }
}

export function retainRevocations(root, rows, denied = []) {
  if (!rows.length && !denied.length) return
  const { records, deniedSources } = readRevocationLedger(root)
  const changed = mergeRevocations(records, rows)
  const before = deniedSources.size
  for (const id of denied) deniedSources.add(id)
  if (changed || deniedSources.size !== before) {
    const body = { version:1, records: [...records.values()], deniedSources:[...deniedSources] }
    atomicWritePrivate(join(root, REVOCATION_FILE), JSON.stringify(body) + '\n')
  }
}
