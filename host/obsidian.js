/**
 * Obsidian DLC: one memory <-> one Markdown note with YAML frontmatter.
 *
 * Pure filesystem integration: no Obsidian plugin/API dependency. Export is
 * idempotent (unchanged notes are skipped); import is id-based so editing a
 * note updates the existing memory instead of duplicating it. Deletion is
 * never propagated in either direction.
 *
 * @module dsh-memory/host/obsidian
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'

import { isValidProjectKey } from './paths.js'
import { MEMORY_KINDS, MEMORY_STATUSES } from './records.js'

export const DEFAULT_FOLDER = 'DSH Memory'
export const INDEX_FILE = '_index.md'
export const SYNC_FILE = 'obsidian-sync.json'

/** Validate the vault path + folder and return the absolute target directory. */
export function resolveObsidianTarget(vaultPath, folder) {
  if (typeof vaultPath !== 'string' || vaultPath.trim() === '') throw new Error('vault path is required')
  const vault = resolve(vaultPath.trim())
  if (!existsSync(vault)) throw new Error('vault path does not exist')
  if (!statSync(vault).isDirectory()) throw new Error('vault path is not a directory')
  const name = typeof folder === 'string' && folder.trim() !== '' ? folder.trim() : DEFAULT_FOLDER
  if (isAbsolute(name)) throw new Error('folder must be relative to the vault')
  const dir = resolve(vault, name)
  const rel = relative(vault, dir)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) throw new Error('folder must stay inside the vault')
  return { vault, dir }
}

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
    `id: ${record.id}`,
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

/** Parse YAML-ish frontmatter + body; returns null when there is no frontmatter. */
export function parseMemoryNote(text) {
  const match = String(text ?? '').match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/u)
  if (match === null) return null
  const data = {}
  for (const line of match[1].split(/\r?\n/u)) {
    const separator = line.indexOf(':')
    if (separator <= 0) continue
    const key = line.slice(0, separator).trim()
    const raw = line.slice(separator + 1).trim()
    let value = raw
    if (raw === 'null') value = null
    else if (raw === 'true') value = true
    else if (raw === 'false') value = false
    else if (/^-?\d+(?:\.\d+)?$/u.test(raw)) value = Number(raw)
    else if (raw.startsWith('"') || raw.startsWith('[')) {
      try {
        value = JSON.parse(raw)
      } catch {
        value = raw
      }
    }
    data[key] = value
  }
  return { data, body: String(text).slice(match[0].length).trim() }
}

function writeAtomic(file, content) {
  const temp = `${file}.tmp`
  writeFileSync(temp, content, { mode: 0o600 })
  renameSync(temp, file)
}

/** Export current memories to `<vault>/<folder>`; returns counts + directory. */
export function exportToObsidian(options) {
  const { store } = options
  const { dir } = resolveObsidianTarget(options.vaultPath, options.folder)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const records = store.listAll().filter((record) => record.status !== 'deleted')
  let written = 0
  let skipped = 0
  for (const record of records) {
    const file = join(dir, `${record.id}.md`)
    const content = serializeMemory(record)
    let existing = null
    try {
      existing = existsSync(file) ? readFileSync(file, 'utf8') : null
    } catch {
      existing = null
    }
    if (existing === content) {
      skipped += 1
      continue
    }
    writeAtomic(file, content)
    written += 1
  }
  const index = `# DSH Memory\n\nExported ${new Date().toISOString()}\n\n- memories: ${records.length}\n- written: ${written}\n- skipped: ${skipped}\n`
  writeAtomic(join(dir, INDEX_FILE), index)
  return { dir, total: records.length, written, skipped }
}

/** Import notes from `<vault>/<folder>`; id-based upsert, never deletes. */
export function importFromObsidian(options) {
  const { store, index } = options
  const { dir } = resolveObsidianTarget(options.vaultPath, options.folder)
  if (!existsSync(dir)) throw new Error('Obsidian folder does not exist; export first')
  const dryRun = options.dryRun === true
  const files = readdirSync(dir).filter((name) => name.endsWith('.md') && !name.startsWith('_'))
  let imported = 0
  let updated = 0
  let skipped = 0
  const preview = []
  for (const name of files) {
    let parsed
    try {
      parsed = parseMemoryNote(readFileSync(join(dir, name), 'utf8'))
    } catch {
      skipped += 1
      continue
    }
    if (parsed === null || parsed.data.dsh_memory !== true) {
      skipped += 1
      continue
    }
    const data = parsed.data
    const content = parsed.body
    if (typeof data.id !== 'string' || !/^mem_[A-Za-z0-9]+$/u.test(data.id) || content === '') {
      skipped += 1
      continue
    }
    if (!MEMORY_KINDS.includes(data.kind)) {
      skipped += 1
      continue
    }
    const scope = data.scope === 'global' ? 'global' : data.scope === 'project' ? 'project' : null
    if (scope === null) {
      skipped += 1
      continue
    }
    const projectKey = scope === 'project' ? data.projectKey : null
    if (scope === 'project' && (typeof projectKey !== 'string' || !isValidProjectKey(projectKey))) {
      skipped += 1
      continue
    }
    const scopes = [{ scope, projectKey }]
    const existing = store.find(data.id, scopes)
    const status = MEMORY_STATUSES.includes(data.status) && data.status !== 'deleted' ? data.status : 'active'
    const patch = {
      content,
      topic: typeof data.topic === 'string' ? data.topic : null,
      tags: Array.isArray(data.tags) ? data.tags.filter((tag) => typeof tag === 'string') : [],
      importance: typeof data.importance === 'number' ? data.importance : 0.5,
      confidence: typeof data.confidence === 'number' ? data.confidence : 0.5,
      status,
    }
    if (dryRun) {
      preview.push({ file: name, id: data.id, action: existing === undefined ? 'create' : 'update', content: content.slice(0, 80) })
      continue
    }
    if (existing !== undefined) {
      const next = store.update(data.id, patch, scopes)
      if (next !== undefined) {
        index.upsert(next)
        updated += 1
      } else {
        skipped += 1
      }
    } else {
      const built = store.write({
        kind: data.kind,
        scope,
        projectKey,
        content,
        topic: patch.topic,
        tags: patch.tags,
        confidence: patch.confidence,
        importance: patch.importance,
        status: 'active',
      }, { id: data.id })
      if (built.ok === true) {
        index.upsert(built.record)
        imported += 1
      } else {
        skipped += 1
      }
    }
  }
  return { dir, scanned: files.length, imported, updated, skipped, preview }
}

/** Persist the last sync summary next to the memory authority. */
export function writeSyncSummary(root, summary) {
  writeFileSync(join(root, SYNC_FILE), `${JSON.stringify({ ...summary, at: Date.now() }, null, 2)}\n`, { mode: 0o600 })
}

/** Read the last sync summary, or null. */
export function readSyncSummary(root) {
  try {
    const parsed = JSON.parse(readFileSync(join(root, SYNC_FILE), 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}
