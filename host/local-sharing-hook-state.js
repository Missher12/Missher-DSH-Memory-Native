import { createHash } from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWritePrivate } from './persistence.js'
import { isValidProjectKey } from './paths.js'

const hash = value => createHash('sha256').update(value).digest('hex')
const directory = root => join(root, '.local-sharing', 'last-user')
const fileFor = (root, client, sessionId) => join(directory(root), `${hash(`${client}\0${sessionId}`)}.json`)
const MAX_EVENT_TEXT_CHARS = 20_000
const MAX_STATE_FILE_BYTES = 128 * 1024
const sourcePattern = /^src_[a-f0-9]{24}$/u

export function readLastUser(root, client, sessionId, projectKey) {
  if (typeof client !== 'string' || client.length > 40 || !/^[a-z0-9._-]+$/iu.test(client) ||
      typeof sessionId !== 'string' || sessionId === '' || sessionId.length > 160 || !isValidProjectKey(projectKey)) return null
  const file = fileFor(root, client, sessionId)
  try {
    const stat = lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_STATE_FILE_BYTES) return null
    const value = JSON.parse(readFileSync(file, 'utf8'))
    if (value.version !== 1 || value.client !== client || value.sessionId !== sessionId || value.sessionId.length > 160 || value.projectKey !== projectKey ||
        typeof value.text !== 'string' || value.text.length > MAX_EVENT_TEXT_CHARS || typeof value.messageId !== 'string' || value.messageId === '' || value.messageId.length > 200 ||
        value.sourceId !== undefined && value.sourceId !== null && !sourcePattern.test(value.sourceId)) return null
    return value
  } catch { return null }
}

export function writeLastUser(root, { client, sessionId, projectKey, messageId, text, sourceId = null }) {
  if (typeof client !== 'string' || client.length > 40 || !/^[a-z0-9._-]+$/iu.test(client) ||
      typeof sessionId !== 'string' || sessionId === '' || sessionId.length > 160 || !isValidProjectKey(projectKey) ||
      typeof messageId !== 'string' || messageId === '' || messageId.length > 200 ||
      typeof text !== 'string' || text.length > MAX_EVENT_TEXT_CHARS || sourceId !== null && sourceId !== undefined && !sourcePattern.test(sourceId)) return false
  const dir = directory(root)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
  atomicWritePrivate(fileFor(root, client, sessionId), `${JSON.stringify({ version: 1, client, sessionId, projectKey, messageId, text, sourceId })}\n`)
  return true
}

export function clearLastUser(root, client, sessionId) {
  if (!/^[a-z0-9._-]+$/iu.test(client) || typeof sessionId !== 'string' || sessionId === '') return false
  try { unlinkSync(fileFor(root, client, sessionId)); return true }
  catch (error) { if (error?.code === 'ENOENT') return false; throw error }
}

export function clearLastUsersForSources(root, sourceIds) {
  const targets = new Set((sourceIds ?? []).filter(value => typeof value === 'string' && value !== ''))
  if (targets.size === 0) return 0
  let names
  try { names = readdirSync(directory(root)) } catch (error) { if (error?.code === 'ENOENT') return 0; throw error }
  let removed = 0
  for (const name of names) {
    if (!/^[a-f0-9]{64}\.json$/u.test(name)) continue
    const file = join(directory(root), name)
    try {
      const stat = lstatSync(file)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_STATE_FILE_BYTES) continue
      const value = JSON.parse(readFileSync(file, 'utf8'))
      if (value.version === 1 && targets.has(value.sourceId)) { unlinkSync(file); removed += 1 }
    } catch { /* Invalid state is not used as evidence or removed speculatively. */ }
  }
  return removed
}
