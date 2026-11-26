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
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { randomUUID } from 'node:crypto'

import { parseFrontmatter } from './frontmatter.js'
import { KNOWLEDGE_DIR, extractWikiLinks, isKnowledgeFile, knowledgeBinding, parseKnowledgeNote, readKnowledgeBinding, splitNoteBody } from './knowledge.js'
import { hasKnowledgeLink, knowledgeLineageAllowed, withKnowledgeWriter } from './knowledge-authority.js'
import { isValidProjectKey } from './paths.js'
import { buildRecord, isValidMemoryId, MEMORY_KINDS, MEMORY_STATUSES, nextRevision } from './records.js'
import { MemoryStore } from './store.js'
import { noteDigest, obsidianSyncStateFile, readExportedKnowledge, serializeMemory, writeExportedKnowledge } from './obsidian-note.js'
export { serializeMemory } from './obsidian-note.js'

export const DEFAULT_FOLDER = 'DSH Memory'
export const INDEX_FILE = '_index.md'
export const SYNC_FILE = 'obsidian-sync.json'

/** Validate the vault path + folder and return the absolute target directory. */
export function resolveObsidianTarget(vaultPath, folder) {
  if (typeof vaultPath !== 'string' || vaultPath.trim() === '') throw new Error('vault path is required')
  const vault = resolve(vaultPath.trim())
  if (!existsSync(vault)) throw new Error('vault path does not exist')
  if (!statSync(vault).isDirectory()) throw new Error('vault path is not a directory')
  const realVault = realpathSync(vault)
  const name = typeof folder === 'string' && folder.trim() !== '' ? folder.trim() : DEFAULT_FOLDER
  if (isAbsolute(name)) throw new Error('folder must be relative to the vault')
  const dir = resolve(vault, name)
  const rel = relative(vault, dir)
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('folder must stay inside the vault')
  let existing = dir
  while (!existsSync(existing)) {
    const parent = dirname(existing)
    if (parent === existing) throw new Error('folder must stay inside the vault')
    existing = parent
  }
  if (!statSync(existing).isDirectory()) throw new Error('folder path is not a directory')
  const realExisting = realpathSync(existing)
  const actualRelative = relative(realVault, realExisting)
  if (actualRelative === '..' || actualRelative.startsWith(`..${sep}`) || isAbsolute(actualRelative)) {
    throw new Error('folder must stay inside the vault')
  }
  return { vault, dir }
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
  const authority = new Map(store.listAll({ includeDeleted: true }).map(record => [record.id, record]))
  const purged = store.purgedIds()
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
    if (!isValidMemoryId(data.id) || purged.has(data.id) || content === '') {
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
    const existing = authority.get(data.id)
    if (existing && (existing.status === 'deleted' || existing.scope !== scope || (existing.projectKey ?? null) !== projectKey)) {
      skipped += 1
      continue
    }
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
    let next
    if (existing !== undefined) {
      try { next = nextRevision(existing, patch) } catch {
        skipped += 1
        continue
      }
      if (Object.keys(patch).every((key) => isDeepStrictEqual(existing[key], next[key]))) {
        skipped += 1
        continue
      }
    }
    if (dryRun) {
      preview.push({ file: name, id: data.id, action: existing === undefined ? 'create' : 'update', content: content.slice(0, 80) })
      continue
    }
    if (!next) {
      const built = buildRecord({ ...patch, scope, projectKey }, { id: data.id })
      if (!built.ok) { skipped += 1; continue }
      next = built.record
    }
    const result = store.append(next, { importOnly: true })
    if (!result.changed) { skipped += 1; continue }
    authority.set(data.id, result.record)
    index.upsert(result.record)
    if (existing) updated += 1
    else imported += 1
  }
  return { dir, scanned: files.length, imported, updated, skipped, preview }
}

/** Skill/knowledge notes live in `<vault>/<folder>/knowledge`. */
export const KNOWLEDGE_SUBDIR = 'knowledge'

/** Absolute vault directory that mirrors `<root>/knowledge`. */
export function knowledgeVaultDir(vaultPath, folder) {
  const parent = resolveObsidianTarget(vaultPath, folder)
  const dir = resolveObsidianTarget(parent.vault, join(relative(parent.vault, parent.dir), KNOWLEDGE_SUBDIR)).dir
  if (existsSync(dir) && lstatSync(dir).isSymbolicLink()) throw new Error('知识同步目录不能是符号链接')
  return dir
}

function readVaultKnowledgeNote(file, permits) {
  const name = basename(file)
  if (!isKnowledgeFile(name)) return null
  const text = readFileSync(file, 'utf8')
  const { data, body } = parseKnowledgeNote(text)
  if (data.dsh_knowledge !== true) return null
  const binding = knowledgeBinding(data)
  if (permits && !permits(binding, name)) return null
  const { title } = splitNoteBody(body)
  return {
    file: name,
    memoryId: binding.memoryId,
    scope: binding.scope,
    projectKey: binding.projectKey,
    topic: typeof data.topic === 'string' ? data.topic : null,
    tags: Array.isArray(data.tags) ? data.tags : [],
    title: title === '' ? name : title,
    body,
    links: extractWikiLinks(body),
    source: 'vault',
  }
}

function vaultKnowledgePermit(root, destination, authority) {
  const stateFile = obsidianSyncStateFile(root, destination)
  let entries = {}
  try {
    if (!lstatSync(stateFile).isFile()) throw new Error('Obsidian 同步状态必须为普通文件。')
    const state = JSON.parse(readFileSync(stateFile, 'utf8'))
    if (state?.version !== 1 || !state.entries || typeof state.entries !== 'object') throw new Error('Obsidian 同步状态无效。')
    entries = state.entries
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  return (binding, name, localBinding = null) => {
    const baseline = entries[`knowledge:${name}`]
    const previous = baseline?.file === `knowledge/${name}` && Array.isArray(baseline.knowledgeLinks)
      ? baseline.knowledgeLinks.filter(note => note && typeof note === 'object') : []
    let counterpart = localBinding
    if (counterpart === null) {
      try { counterpart = readKnowledgeBinding(join(root, KNOWLEDGE_DIR, name)) }
      catch (error) { if (error?.code !== 'ENOENT') return false }
    }
    if (counterpart && hasKnowledgeLink(counterpart)) previous.push(counterpart)
    return knowledgeLineageAllowed(authority, binding, previous)
  }
}

/** Read knowledge notes the user authored or copied into the vault. */
export function listVaultKnowledgeNotes(vaultPath, folder, permits, { root, authority } = {}) {
  try {
    const dir = knowledgeVaultDir(vaultPath, folder)
    if (!existsSync(dir)) return []
    const tracked = root && authority ? vaultKnowledgePermit(root, dirname(dir), authority) : null
    const allowed = (binding, name) => (!permits || permits(binding, name)) && (!tracked || tracked(binding, name))
    const notes = []
    for (const name of readdirSync(dir).filter((item) => item.endsWith('.md') && !item.startsWith('_'))) {
      try {
        if (!lstatSync(join(dir, name)).isFile()) continue
        const note = readVaultKnowledgeNote(join(dir, name), allowed)
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
  const store = options.store ?? new MemoryStore({ root: options.root })
  return withKnowledgeWriter(store, authority => {
    const result = { dir, total: 0, written: 0, skipped: 0, conflicts: 0 }
    const target = dirname(dir)
    const receipts = readExportedKnowledge(options.root, target)
    const permits = vaultKnowledgePermit(options.root, target, authority)
    for (const name of knowledgeNames(source)) {
      result.total++
      const text = readableKnowledge(join(source, name), (binding, file) => permits(binding, file, binding))
      if (text === null) { result.skipped++; continue }
      const action = publishNewKnowledge(join(dir, name), text)
      if (action === 'copied') receipts.set(KNOWLEDGE_SUBDIR + '/' + name, noteDigest(text))
      result[action === 'copied' ? 'written' : action === 'unchanged' ? 'skipped' : 'conflicts']++
    }
    if (result.written) writeExportedKnowledge(options.root, target, receipts)
    return result
  })
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
  if (!lstatSync(target).isDirectory()) throw new Error('知识同步目录不能是符号链接')
  const store = options.store ?? new MemoryStore({ root: options.root })
  return withKnowledgeWriter(store, authority => {
    const files = knowledgeNames(dir)
    const permits = vaultKnowledgePermit(options.root, dirname(dir), authority)
    const result = { dir, scanned: files.length, imported: 0, skipped: 0, conflicts: 0 }
    for (const name of files) {
      const text = readableKnowledge(join(dir, name), permits)
      if (text === null) { result.skipped++; continue }
      const action = publishNewKnowledge(join(target, name), text)
      result[action === 'copied' ? 'imported' : action === 'unchanged' ? 'skipped' : 'conflicts']++
    }
    return result
  })
}

function knowledgeNames(dir) {
  if (!lstatSync(dir).isDirectory()) throw new Error('知识同步目录不能是符号链接')
  return readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isFile() && isKnowledgeFile(entry.name) && !entry.name.startsWith('_')).map(entry => entry.name)
}

function readableKnowledge(path, permits) {
  try {
    if (!lstatSync(path).isFile()) return null
    const text = readFileSync(path, 'utf8')
    const { data } = parseKnowledgeNote(text)
    return data.dsh_knowledge === true && permits(knowledgeBinding(data), basename(path)) ? text : null
  } catch { return null }
}

export function publishNewKnowledge(file, text) {
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    if (!existsSync(file)) {
      writeFileSync(temporary, text, { mode: 0o600, flag: 'wx' })
      linkSync(temporary, file)
      return 'copied'
    }
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
  } finally {
    try { unlinkSync(temporary) } catch (error) { if (error?.code !== 'ENOENT') throw error }
  }
  return lstatSync(file).isFile() && readFileSync(file, 'utf8') === text ? 'unchanged' : 'conflict'
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
