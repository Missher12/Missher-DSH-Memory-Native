import { createHash } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWritePrivate } from './persistence.js'
import { isValidMemoryId } from './records.js'

function frontmatterValue(value) {
  return typeof value === 'string' ? JSON.stringify(value) : value
}

/** Serialize one memory record as Markdown with YAML frontmatter. */
export function serializeMemory(record) {
  const tags = JSON.stringify(Array.isArray(record.tags) ? record.tags : [])
  const createdAt = new Date(record.createdAt ?? Date.now()).toISOString()
  const updatedAt = new Date(record.updatedAt ?? record.createdAt ?? Date.now()).toISOString()
  const lines = [
    '---',
    'dsh_memory: true',
    `id: ${record.id.startsWith('mem_') ? record.id : frontmatterValue(record.id)}`,
    `kind: ${record.kind}`,
    `scope: ${record.scope}`,
    `projectKey: ${record.projectKey === null || record.projectKey === undefined ? 'null' : record.projectKey}`,
    `status: ${record.status}`,
    `topic: ${frontmatterValue(record.topic ?? null)}`,
    `tags: ${tags}`,
    `confidence: ${typeof record.confidence === 'number' ? record.confidence : 0.5}`,
    `importance: ${typeof record.importance === 'number' ? record.importance : 0.5}`,
    `revision: ${Number.isInteger(record.revision) ? record.revision : 1}`,
    `createdAt: ${createdAt}`,
    `updatedAt: ${updatedAt}`,
    '---',
    '',
    String(record.content ?? ''),
    '',
  ]
  return lines.join('\n')
}

export const noteDigest = bytes => createHash('sha256').update(bytes).digest('hex')
export const isNoteDigest = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
export const PURGED_NOTE_DIGESTS = 'obsidian-purged-notes.json'
export const obsidianSyncStateFile = (root, vaultDirectory) => join(root, 'obsidian-state-' + noteDigest(vaultDirectory).slice(0, 20) + '.json')
const exportedKnowledgePath = (root, vaultDirectory) => join(root, 'obsidian-exports-' + noteDigest(vaultDirectory).slice(0, 20) + '.json')

export function memoryNoteDigests(records) {
  const hashes = new Set()
  for (const record of records) {
    if (record.status === 'deleted') continue
    try { hashes.add(noteDigest(serializeMemory(record))) }
    catch (error) { if (!(error instanceof RangeError)) throw error }
  }
  return hashes
}

/** Keep checksums only. The original authority bytes can disappear after purge. */
export function readPurgedNoteDigests(root) {
  const file = join(root, PURGED_NOTE_DIGESTS)
  try {
    if (!lstatSync(file).isFile()) throw new Error('Obsidian 校验记录必须是普通文件。')
    const entries = JSON.parse(readFileSync(file, 'utf8'))
    if (!Array.isArray(entries) || entries.some(entry => !Array.isArray(entry) || entry.length !== 2 ||
      !isValidMemoryId(entry[0]) || !Array.isArray(entry[1]) || !entry[1].every(isNoteDigest))) {
      throw new Error('Obsidian 校验记录无效。')
    }
    return new Map(entries.map(([id, digests]) => [id, new Set(digests)]))
  } catch (error) {
    if (error?.code === 'ENOENT') return new Map()
    throw error
  }
}

export function writePurgedNoteDigests(root, entries) {
  atomicWritePrivate(join(root, PURGED_NOTE_DIGESTS), JSON.stringify([...entries].map(([id, digests]) => [id, [...digests]])) + '\n')
}

/** Only a new publication, never a pre-existing identical note, creates a receipt. */
export function readExportedKnowledge(root, vaultDirectory) {
  const file = exportedKnowledgePath(root, vaultDirectory)
  try {
    if (!lstatSync(file).isFile()) throw new Error('Obsidian 导出记录必须是普通文件。')
    const rows = JSON.parse(readFileSync(file, 'utf8'))
    if (!Array.isArray(rows) || rows.some(row => !Array.isArray(row) || row.length !== 2 ||
        typeof row[0] !== 'string' || !/^knowledge\/[^/\\]+\.md$/u.test(row[0]) || !isNoteDigest(row[1]))) {
      throw new Error('Obsidian 导出记录无效。')
    }
    return new Map(rows)
  } catch (error) {
    if (error?.code === 'ENOENT') return new Map()
    throw error
  }
}

export function writeExportedKnowledge(root, vaultDirectory, rows) {
  atomicWritePrivate(exportedKnowledgePath(root, vaultDirectory), JSON.stringify([...rows]) + '\n')
}
