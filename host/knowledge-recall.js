import { createHash } from 'node:crypto'
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { isKnowledgeFile, knowledgeScopeWithinMemory, KNOWLEDGE_DIR, readKnowledgeNote } from './knowledge.js'
import { looksSensitive } from './records.js'
import { MemoryIndex } from './search.js'

function digest(note) {
  return createHash('sha256').update(JSON.stringify([
    note.file, note.title, note.body, note.topic, note.tags, note.scope, note.projectKey, note.memoryId, note.mtimeMs,
  ])).digest('hex')
}

function noteRecord(note) {
  const body = [note.title, note.body].filter(Boolean).join('\n')
  return {
    id: `note:${note.file}`,
    kind: 'knowledge',
    scope: note.scope,
    projectKey: note.projectKey,
    content: body,
    topic: note.topic,
    tags: note.tags,
    status: 'active',
    confidence: 1,
    importance: 0.6,
    revision: 1,
    observedAt: note.mtimeMs,
    validFrom: null,
    validTo: null,
    createdAt: note.mtimeMs,
    updatedAt: note.mtimeMs,
    contentHash: digest(note),
    noteFile: note.file,
    noteTitle: note.title,
    noteQuote: note.body || note.title,
    noteDigest: digest(note),
    memoryId: note.memoryId,
  }
}

/** Incremental note lookup: scan at startup and after edits, never per prompt. */
export class KnowledgeRecallIndex {
  #root
  #store
  #index = new MemoryIndex()
  #notes = new Map()
  #signatures = new Map()

  constructor(root, store) {
    this.#root = root
    this.#store = store
    this.rebuild()
  }

  get size() { return this.#index.size }
  idfOf(term) { return this.#index.idfOf(term) }

  rebuild() {
    this.#index.rebuild([])
    this.#notes.clear()
    this.#signatures.clear()
    this.refresh()
    return this
  }

  refresh() {
    let files = []
    try { files = readdirSync(join(this.#root, KNOWLEDGE_DIR)).filter(isKnowledgeFile) } catch { files = [] }
    const present = new Set(files)
    for (const file of files) this.#refreshFile(file)
    for (const file of this.#signatures.keys()) {
      if (present.has(file)) continue
      this.#index.remove(`note:${file}`)
      this.#notes.delete(file)
      this.#signatures.delete(file)
    }
    return this
  }

  #refreshFile(file, force = false) {
    const id = `note:${file}`
    let signature
    try {
      const stat = statSync(join(this.#root, KNOWLEDGE_DIR, file))
      signature = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`
      if (!force && this.#signatures.get(file) === signature) return
    } catch {
      this.#index.remove(id)
      this.#notes.delete(file)
      this.#signatures.delete(file)
      return
    }
    this.#index.remove(id)
    this.#notes.delete(file)
    this.#signatures.set(file, signature)
    try {
      const note = readKnowledgeNote(this.#root, file)
      const record = noteRecord(note)
      this.#notes.set(file, { note, record })
      this.#index.upsert(record)
    } catch {
      // Invalid or removed files remain visible to the editor only if its own
      // listing accepts them; they are never recall evidence.
    }
  }

  #eligible(note, projectKey, now = Date.now()) {
    if (note.scope === 'project' && note.projectKey !== projectKey) return false
    if (note.scope !== 'project' && note.scope !== 'global') return false
    if (looksSensitive(`${note.title ?? ''}\n${note.body ?? ''}`)) return false
    if (note.memoryId === null) return true
    const linked = this.#store.find(note.memoryId, [
      { scope: 'global', projectKey: null },
      { scope: 'project', projectKey: note.projectKey ?? projectKey },
    ])
    return linked !== undefined && linked.status === 'active' &&
      linked.quoted !== true &&
      (!Number.isFinite(linked.validFrom) || linked.validFrom <= now) &&
      (!Number.isFinite(linked.validTo) || linked.validTo > now) &&
      !looksSensitive(linked.content) &&
      knowledgeScopeWithinMemory(note.scope, note.projectKey, linked.scope, linked.projectKey)
  }

  validate(hit, projectKey, now = Date.now()) {
    const file = hit?.record?.noteFile
    const snapshot = this.#notes.get(file)
    if (!snapshot || !this.#eligible(snapshot.note, projectKey, now)) return false
    try {
      const current = readKnowledgeNote(this.#root, file)
      if (digest(current) !== hit.record.noteDigest) {
        this.#refreshFile(file, true)
        return false
      }
      return this.#eligible(current, projectKey, now)
    } catch {
      this.#refreshFile(file, true)
      return false
    }
  }

  candidates(projectKey, options = {}) {
    const now = options.now ?? Date.now()
    const limit = Number.isInteger(options.limit) ? Math.max(1, options.limit) : 40
    return [...this.#notes.values()]
      .filter(({ note }) => this.#eligible(note, projectKey, now) && note.mtimeMs <= now)
      .sort((left, right) => right.note.mtimeMs - left.note.mtimeMs || left.note.file.localeCompare(right.note.file))
      .slice(0, limit)
      .map(({ record }) => ({ record, score: 0, matched: [], termScores: [] }))
  }

  search(query, options = {}) {
    const projectKey = options.projectKey
    const candidates = this.#index.search(query, {
      statuses: ['active'],
      scopes: ['project', 'global'],
      projectKey,
      now: options.now,
      limit: options.limit ?? 40,
    })
    const hits = []
    for (const hit of candidates) {
      const note = this.#notes.get(hit.record.noteFile)?.note
      if (!note || !this.#eligible(note, projectKey, options.now ?? Date.now())) continue
      const text = `${note.title}\n${note.body}`
      const matched = hit.matched.filter(term => text.toLocaleLowerCase().includes(term.toLocaleLowerCase()))
      if (matched.length === 0) continue
      const terms = new Set(matched)
      const termScores = hit.termScores.filter(item => terms.has(item.term))
      const record = { ...hit.record, content: text, noteQuote: bestQuote(note, matched) }
      hits.push({ ...hit, record, matched, termScores })
    }
    return hits
  }
}

function bestQuote(note, matched) {
  const candidates = `${note.title}\n${note.body}`
    .split(/(?<=[。！？!?])\s*|\r?\n+/u)
    .map(value => value.trim())
    .filter(Boolean)
  const score = value => matched.reduce((total, term) => total + (value.toLocaleLowerCase().includes(term.toLocaleLowerCase()) ? 1 : 0), 0)
  const best = candidates.map((value, index) => ({ value, index, score: score(value) }))
    .sort((left, right) => right.score - left.score || left.index - right.index)[0]
  return best?.value ?? note.title
}
