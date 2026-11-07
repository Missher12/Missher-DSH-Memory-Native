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
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

import { parseFrontmatter } from './frontmatter.js'
import { KNOWLEDGE_DIR, extractWikiLinks, isKnowledgeFile, knowledgeScope, parseKnowledgeNote, splitNoteBody } from './knowledge.js'
import { isValidProjectKey } from './paths.js'
import { MEMORY_KINDS, MEMORY_STATUSES, nextRevision } from './records.js'

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

/** Parse Obsidian properties and body, including block-style YAML lists. */
export function parseMemoryNote(text) {
  const parsed = parseFrontmatter(text)
  return parsed === null ? null : { data: parsed.data, body: parsed.body.trim() }
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
      kind: data.kind,
      content,
      topic: typeof data.topic === 'string' ? data.topic : null,
      tags: Array.isArray(data.tags) ? data.tags.filter((tag) => typeof tag === 'string') : [],
      importance: typeof data.importance === 'number' ? data.importance : 0.5,
      confidence: typeof data.confidence === 'number' ? data.confidence : 0.5,
      status,
    }
    if (existing !== undefined) {
      let normalized
      try { normalized = nextRevision(existing, patch) } catch {
        skipped += 1
        continue
      }
      if (Object.keys(patch).every((key) => isDeepStrictEqual(existing[key], normalized[key]))) {
        skipped += 1
        continue
      }
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
        status: patch.status,
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

/** Skill/knowledge notes live in `<vault>/<folder>/knowledge`. */
export const KNOWLEDGE_SUBDIR = 'knowledge'

/** Absolute vault directory that mirrors `<root>/knowledge`. */
export function knowledgeVaultDir(vaultPath, folder) {
  return join(resolveObsidianTarget(vaultPath, folder).dir, KNOWLEDGE_SUBDIR)
}

function readVaultKnowledgeNote(file) {
  const name = basename(file)
  if (!isKnowledgeFile(name)) return null
  const text = readFileSync(file, 'utf8')
  const { data, body } = parseKnowledgeNote(text)
  if (data.dsh_knowledge !== true) return null
  const { title } = splitNoteBody(body)
  return {
    file: name,
    memoryId: typeof data.memoryId === 'string' ? data.memoryId : null,
    ...knowledgeScope(data),
    topic: typeof data.topic === 'string' ? data.topic : null,
    tags: Array.isArray(data.tags) ? data.tags : [],
    title: title === '' ? name : title,
    body,
    links: extractWikiLinks(body),
    source: 'vault',
  }
}

/** Read knowledge notes the user authored or copied into the vault. */
export function listVaultKnowledgeNotes(vaultPath, folder) {
  try {
    const dir = knowledgeVaultDir(vaultPath, folder)
    if (!existsSync(dir)) return []
    const notes = []
    for (const name of readdirSync(dir).filter((item) => item.endsWith('.md') && !item.startsWith('_'))) {
      try {
        const note = readVaultKnowledgeNote(join(dir, name))
        if (note !== null) notes.push(note)
      } catch {
        // Skip unreadable vault notes.
      }
    }
    return notes
  } catch {
    return []
  }
}

/** Copy `<root>/knowledge/*.md` into `<vault>/<folder>/knowledge`; identical files are skipped. */
export function exportKnowledgeToVault(options) {
  const dir = knowledgeVaultDir(options.vaultPath, options.folder)
  const source = join(options.root, KNOWLEDGE_DIR)
  if (!existsSync(source)) return { dir, total: 0, written: 0, skipped: 0 }
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  let total = 0
  let written = 0
  let skipped = 0
  for (const name of readdirSync(source).filter((item) => item.endsWith('.md') && !item.startsWith('_'))) {
    let content
    try {
      content = readFileSync(join(source, name), 'utf8')
    } catch {
      continue
    }
    total += 1
    const target = join(dir, name)
    let existing = null
    try {
      existing = existsSync(target) ? readFileSync(target, 'utf8') : null
    } catch {
      existing = null
    }
    if (existing === content) {
      skipped += 1
      continue
    }
    writeAtomic(target, content)
    written += 1
  }
  return { dir, total, written, skipped }
}

/**
 * Import vault knowledge notes into `<root>/knowledge`.
 *
 * New files are copied, identical files are skipped, and a file that already
 * exists locally with different content is reported as a conflict instead of
 * overwriting the local edit.
 */
export function importKnowledgeFromVault(options) {
  const dir = knowledgeVaultDir(options.vaultPath, options.folder)
  if (!existsSync(dir)) throw new Error('Obsidian knowledge folder does not exist; export first')
  const target = join(options.root, KNOWLEDGE_DIR)
  mkdirSync(target, { recursive: true, mode: 0o700 })
  const files = readdirSync(dir).filter((name) => name.endsWith('.md') && !name.startsWith('_'))
  let imported = 0
  let skipped = 0
  let conflicts = 0
  for (const name of files) {
    if (!isKnowledgeFile(name)) continue
    let text
    try {
      text = readFileSync(join(dir, name), 'utf8')
      const { data } = parseKnowledgeNote(text)
      if (data.dsh_knowledge !== true) {
        skipped += 1
        continue
      }
    } catch {
      skipped += 1
      continue
    }
    const file = join(target, name)
    if (existsSync(file)) {
      let existing = null
      try {
        existing = readFileSync(file, 'utf8')
      } catch {
        existing = null
      }
      if (existing === text) skipped += 1
      else conflicts += 1
      continue
    }
    writeAtomic(file, text)
    imported += 1
  }
  return { dir, scanned: files.length, imported, skipped, conflicts }
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
