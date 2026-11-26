import { createHash } from 'node:crypto'
import { readdirSync } from 'node:fs'
import { lstat, readdir } from 'node:fs/promises'
import { availableParallelism } from 'node:os'
import { join } from 'node:path'
import { setImmediate as yieldToHost } from 'node:timers/promises'
import { Worker } from 'node:worker_threads'
import { isKnowledgeFile, knowledgeFileSignature, KNOWLEDGE_DIR, readKnowledgeSnapshot } from './knowledge.js'
import { hasKnowledgeLink, knowledgeAuthority } from './knowledge-authority.js'
import {
  directoryBucket, hasDirectoryCache, knowledgePeriod, matchesKnowledgePeriod, readDirectoryEntry, readDirectoryRoutes,
  writeDirectoryRoutes,
} from './knowledge-directory-cache.js'
import { looksSensitive } from './records.js'
import { isEffectiveAt } from './recall.js'
import { MemoryIndex } from './search.js'
import { sourceSentences } from './sentences.js'
import { queryTerms } from './tokenize.js'

const MARKDOWN_HEADING = /^ {0,3}(#{1,6})\s+(.+)$/u
const MARKDOWN_FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/u
const SETEXT_UNDERLINE = /^ {0,3}(=+|-+)[ \t]*$/u
const MARKDOWN_DIVIDER = /^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/u
const MARKDOWN_CONTAINER = /^ {0,3}(?:[><]|(?:[-+*]|\d{1,9}[.)])(?:[ \t]|$))/u
const INDENTED_LINE = /^(?: {4}|\t)/u

function samePeriod(left, right) {
  return left === right || (left != null && right != null &&
    left[0] === right[0] && left[1] === right[1] && left[2] === right[2])
}

function titleText(title) {
  return title.replace(/^#+\s+/u, '').trim()
}

function labelPattern(label) {
  const escaped = label.normalize('NFKC').replace(/[\\^$.*+?()[\]{}|]/gu, '\\$&')
  return new RegExp(/^[a-z0-9_]/iu.test(label)
    ? `(?<![a-z0-9_])${escaped}(?![a-z0-9_])` : escaped, 'iu')
}

/** An explicit current alias can name its note's subject, never its answer. */
export function matchKnowledgeAlias(query, record) {
  const title = titleText(record.noteTitle ?? '')
  if (title === '') return null
  const normalized = query.normalize('NFKC')
  for (const alias of record.noteAliases ?? []) {
    const pattern = labelPattern(alias)
    if (pattern.test(normalized)) return { alias, query: normalized.replace(pattern, () => title) }
  }
  return null
}

function digest(note) {
  return createHash('sha256').update(JSON.stringify([
    note.file, note.title, note.body, note.topic, note.tags, note.aliases, note.scope, note.projectKey, note.memoryId, note.mtimeMs,
    note.quoted, note.status, note.validFrom, note.validTo, note.memoryScope, note.memoryProjectKey,
  ])).digest('hex')
}

function noteRecord(note) {
  const body = [note.title, note.body].filter(Boolean).join('\n')
  const version = digest(note)
  return {
    id: `note:${note.file}`,
    kind: 'knowledge',
    scope: note.scope,
    projectKey: note.projectKey,
    content: body,
    topic: note.topic,
    tags: note.tags,
    status: note.status,
    confidence: 1,
    importance: 0.6,
    revision: 1,
    observedAt: note.mtimeMs,
    quoted: note.quoted,
    validFrom: note.validFrom,
    validTo: note.validTo,
    createdAt: note.mtimeMs,
    updatedAt: note.mtimeMs,
    contentHash: version,
    noteFile: note.file,
    noteTitle: note.title,
    noteAliases: [...note.aliases].sort((left, right) => right.length - left.length),
    noteQuote: note.body || note.title,
    noteDigest: version,
    memoryId: note.memoryId,
    memoryScope: note.memoryScope,
    memoryProjectKey: note.memoryProjectKey,
  }
}

/** Build the directory from Markdown and load bodies within the requested scope. */
export class KnowledgeRecallIndex {
  #root
  #store
  #files = new Map()
  #groups = new Map()
  #scopes = new Map()
  #routeHints
  #directoryTimer = null
  #directoryWrite = Promise.resolve()
  #directoryDirty = false
  #background
  #pending = null
  #refreshRequested = false
  #directoryFailure = null
  #workers = new Set()
  #disposed = false

  constructor(root, store, { background = false } = {}) {
    this.#root = root
    this.#store = store
    this.#background = background
    this.#routeHints = background ? null : readDirectoryRoutes(root)
    this.refresh()
  }

  statistics(projectKey) {
    const index = this.#scopes.get(projectKey)?.index
    return { indexSize: index?.size ?? 0, idfOf: term => index?.idfOf(term) ?? null }
  }

  refresh() {
    if (this.#disposed) return this
    if (this.#background) {
      this.#refreshRequested = true
      if (this.#pending === null) {
        this.#directoryFailure = null
        this.#pending = this.#scanInBackground().catch(error => { this.#directoryFailure = error }).finally(() => {
          this.#pending = null
          if (this.#refreshRequested && !this.#disposed) this.refresh()
          else if (this.#directoryDirty) this.#scheduleDirectoryCache()
        })
      }
      return this
    }
    let files = []
    try { files = readdirSync(join(this.#root, KNOWLEDGE_DIR)).filter(isKnowledgeFile) } catch { files = [] }
    const routes = this.#routeHints
    this.#routeHints = null
    for (const file of files) this.#refreshFile(file, false, routes)
    this.#finishDirectory(files, routes?.size ?? 0)
    return this
  }

  async waitUntilReady(signal) {
    while (this.#pending !== null && !this.#disposed && !signal?.aborted) {
      if (!signal) { await this.#pending; continue }
      const { promise, resolve } = Promise.withResolvers()
      signal.addEventListener('abort', resolve, { once: true })
      try { await Promise.race([this.#pending, promise]) }
      finally { signal.removeEventListener('abort', resolve) }
    }
    if (this.#disposed || signal?.aborted) return false
    if (this.#directoryFailure) throw this.#directoryFailure
    return true
  }

  async #scanInBackground() {
    const directory = join(this.#root, KNOWLEDGE_DIR)
    const directorySignature = async () => {
      try {
        const info = await lstat(directory)
        return info.isDirectory() ? knowledgeFileSignature(info) : null
      } catch { return null }
    }
    while (this.#refreshRequested && !this.#disposed) {
      this.#refreshRequested = false
      const signature = await directorySignature()
      let files = []
      if (signature !== null) try { files = (await readdir(directory)).filter(isKnowledgeFile) } catch { /* Directory moved. */ }
      if (this.#disposed) return
      let cachedRoutes = 0
      if (files.length > 64) {
        const parallelism = availableParallelism()
        let workerCount = files.length >= 8192 && parallelism > 2 ? 2 : 1
        // A rebuild parses every header. With a cache, additional workers
        // would each decode the same directory before scanning their files.
        if (files.length >= 32768 && parallelism >= 8 && !hasDirectoryCache(this.#root)) workerCount = 4
        const size = Math.ceil(files.length / workerCount)
        const batches = workerCount === 1 ? [files]
          : Array.from({ length: workerCount }, (_, i) => files.slice(i * size, (i + 1) * size))
        const completed = await Promise.allSettled(batches.map(batch => this.#scanFiles(batch)))
        if (this.#disposed) return
        if (completed.every(result => result.status === 'fulfilled')) {
          cachedRoutes = Math.max(...completed.map(result => result.value))
        } else {
          cachedRoutes = await this.#scanInSlices(files)
        }
      } else {
        cachedRoutes = await this.#scanInSlices(files)
      }
      if (this.#disposed) return
      this.#finishDirectory(files, cachedRoutes)
      if (await directorySignature() !== signature) this.#refreshRequested = true
    }
  }

  #scanFiles(files) {
    return new Promise((resolve, reject) => {
      const worker = new Worker(new URL('./knowledge-directory-worker.js', import.meta.url), {
        workerData: { root: this.#root, files }, execArgv: [],
      })
      this.#workers.add(worker)
      worker.on('message', ({ entries, done, cachedRoutes }) => {
        if (this.#disposed) return
        try {
          for (const [file, entry] of entries) {
            const previous = this.#files.get(file)
            const { signature, header, hint } = entry
            if (previous?.signature === signature && (previous?.header || (!header &&
                (!hint || (hint.bucket === previous?.bucket && samePeriod(hint.period, previous?.period)))))) continue
            this.#replace(file, signature, header, hint)
          }
          if (done) resolve(cachedRoutes)
          else worker.postMessage('next')
        } catch (error) { reject(error); void worker.terminate().catch(() => {}) }
      })
      worker.once('error', reject)
      worker.once('exit', () => {
        this.#workers.delete(worker)
        reject(new Error('knowledge directory worker stopped before returning its result'))
      })
    })
  }

  async #scanInSlices(files) {
    const routes = readDirectoryRoutes(this.#root)
    for (let i = 0; i < files.length && !this.#disposed; i++) {
      this.#refreshFile(files[i], false, routes)
      if (i % 32 === 31 && i + 1 < files.length) await yieldToHost()
    }
    return routes?.size ?? 0
  }

  #finishDirectory(files, cachedRoutes) {
    const present = new Set(files)
    for (const file of this.#files.keys()) if (!present.has(file)) this.#replace(file)
    if (cachedRoutes > [...this.#groups.values()].reduce((total, group) => total + group.size, 0)) this.#scheduleDirectoryCache()
  }

  dispose() {
    this.#disposed = true
    clearTimeout(this.#directoryTimer)
    this.#directoryTimer = null
    for (const worker of this.#workers) void worker.terminate().catch(() => {})
  }

  #scheduleDirectoryCache() {
    if (this.#disposed) return
    if (this.#pending !== null) { this.#directoryDirty = true; return }
    if (this.#directoryTimer !== null) return
    this.#directoryDirty = false
    this.#directoryTimer = setTimeout(() => {
      this.#directoryTimer = null
      this.#directoryWrite = this.#directoryWrite
        .then(() => writeDirectoryRoutes(this.#root, this.#files))
        .catch(() => { /* The next startup can rebuild from Markdown. */ })
    }, 100)
    this.#directoryTimer.unref?.()
  }

  #replace(file, signature, header, hint) {
    const previous = this.#files.get(file)
    if (previous?.bucket !== undefined) {
      const group = this.#groups.get(previous.bucket)
      group.delete(file)
      if (group.size === 0) this.#groups.delete(previous.bucket)
    }
    for (const cache of this.#scopes.values()) {
      if (cache.notes.delete(file)) cache.index.remove(`note:${file}`)
    }
    if (header && header.scope !== 'project' && header.scope !== 'global') header = undefined
    const bucket = header ? directoryBucket(header.projectKey) : hint?.bucket
    const period = header ? knowledgePeriod(header) : hint?.period ?? null
    if (hint === undefined && (previous?.bucket !== bucket || (bucket !== undefined &&
        (previous?.signature !== signature || !samePeriod(previous?.period, period))))) {
      this.#scheduleDirectoryCache()
    }
    if (signature === undefined) { this.#files.delete(file); return }
    if (bucket !== undefined) {
      const group = this.#groups.get(bucket) ?? new Set()
      group.add(file)
      this.#groups.set(bucket, group)
    }
    this.#files.set(file, { signature, bucket, header, period })
  }

  #refreshFile(file, force = false, routes = null) {
    const entry = readDirectoryEntry(this.#root, file, routes, force ? undefined : this.#files.get(file)?.signature)
    if (entry) this.#replace(file, entry.signature, entry.header, entry.hint)
  }

  #labels(file) {
    const entry = this.#files.get(file)
    const header = entry?.header
    if (!header) return []
    return entry.labels ??= [...new Set([titleText(header.title), header.topic, ...header.aliases, ...header.tags])]
      .filter(label => label.length >= 2 && !looksSensitive(label)).map(labelPattern)
  }

  #scope(projectKey) {
    const cache = this.#scopes.get(projectKey) ?? { notes: new Map(), index: new MemoryIndex() }
    this.#scopes.delete(projectKey)
    this.#scopes.set(projectKey, cache)
    if (this.#scopes.size > 4) this.#scopes.delete(this.#scopes.keys().next().value)
    return cache
  }

  #visibleFiles(projectKey, eligible, matchesPeriod, refresh = false) {
    const files = [...(this.#groups.get('global') ?? [])]
    if (typeof projectKey === 'string') files.push(...(this.#groups.get(directoryBucket(projectKey)) ?? []))
    return files.filter(file => {
      const entry = this.#files.get(file)
      // An excluded period skips reading the header only if its file signature
      // still matches. Candidates always read their own header.
      if (!entry?.header) this.#refreshFile(file, !entry?.period || matchesPeriod(entry.period))
      else if (refresh) this.#refreshFile(file)
      const header = this.#files.get(file)?.header
      return header && eligible(header)
    })
  }

  #readNote(file) {
    const note = readKnowledgeSnapshot(this.#root, file)
    const previous = this.#files.get(file)
    if (!previous?.header || note.signature !== previous.signature) {
      const { body: _body, ...header } = note
      this.#replace(file, note.signature, header)
    }
    return note
  }

  #hydrate(cache, file, eligible, snapshot = null) {
    if (cache.notes.has(file)) return cache.notes.get(file)
    try {
      const note = snapshot ?? this.#readNote(file)
      if (!eligible(note)) return null
      const record = noteRecord(note)
      const sentences = noteSentences(record.content)
      const value = { note, record, sentences }
      cache.notes.set(file, value)
      cache.index.upsert({ ...record, tags: [...record.tags, ...record.noteAliases] })
      return value
    } catch {
      this.#refreshFile(file, true)
      return null
    }
  }

  #valueGroups(cache, file, projectKey, now, authority) {
    this.#refreshFile(file)
    const existing = this.#files.get(file)?.valueGroups
    if (existing) return { groups: existing, snapshot: null }
    const groups = new Set()
    try {
      const hydrated = cache.notes.get(file)
      const note = hydrated?.note ?? this.#readNote(file)
      if (!this.#eligible(note, projectKey, now, authority)) return { groups, snapshot: null }
      const record = { scope: note.scope, projectKey: note.projectKey, noteTitle: note.title }
      for (const passage of hydrated?.sentences ?? noteSentences(note.title + '\n' + note.body)) {
        for (const claim of comparableKnowledgeClaims(record, passage)) groups.add(claim.group)
      }
      this.#files.get(file).valueGroups = groups
      return { groups, snapshot: note }
    } catch {
      this.#refreshFile(file, true)
      return { groups, snapshot: null }
    }
  }

  #eligible(note, projectKey, now, authority, asOf = null) {
    if (!note) return false
    if (note.scope === 'project' && note.projectKey !== projectKey) return false
    if (note.scope !== 'project' && note.scope !== 'global') return false
    const at = asOf ?? now
    if (!matchesKnowledgePeriod(knowledgePeriod(note), now, asOf)) return false
    if (looksSensitive([note.title, note.body, ...note.aliases].join('\n'))) return false
    if (!hasKnowledgeLink(note)) return true
    const { allowed, parent: linked } = authority(note)
    return allowed && (linked.status === 'active' ||
      (asOf !== null && linked.status === 'superseded' && isEffectiveAt(linked, asOf))) &&
      linked.quoted !== true &&
      (!Number.isFinite(linked.validFrom) || linked.validFrom <= at) &&
      (!Number.isFinite(linked.validTo) || linked.validTo > at) &&
      !looksSensitive(linked.content)
  }

  validate(hit, projectKey, now = Date.now()) {
    return this.validateMany([hit], projectKey, now).length === 1
  }

  validateMany(hits, projectKey, now = Date.now()) {
    const input = Array.isArray(hits) ? hits : []
    const files = new Map(), valid = [], stale = new Set()
    const authority = knowledgeAuthority(this.#store)
    const projectBucket = typeof projectKey === 'string' ? directoryBucket(projectKey) : null
    for (const hit of input) {
      const file = hit?.record?.noteFile
      if (typeof file !== 'string') continue
      const entry = this.#files.get(file)
      if (!entry || (entry.bucket !== 'global' && entry.bucket !== projectBucket)) continue
      const times = hit.record.noteReferenceTimes ?? [null]
      const permitted = note => times.every(asOf => this.#eligible(note, projectKey, now, authority, asOf))
      if (entry.header && !permitted(entry.header)) continue
      if (!files.has(file)) {
        try {
          const current = this.#readNote(file)
          files.set(file, { note: current, digest: digest(current) })
        } catch { files.set(file, null) }
      }
      const current = files.get(file)
      if (!current || current.digest !== hit.record.noteDigest || !permitted(current.note)) continue
      valid.push(hit)
    }
    for (const [file, current] of files) if (!current) stale.add(file)
    for (const hit of input) {
      const file = hit?.record?.noteFile, current = files.get(file)
      if (current && current.digest !== hit.record.noteDigest) stale.add(file)
    }
    for (const file of stale) this.#refreshFile(file, true)
    return valid
  }

  candidates(projectKey, options = {}) {
    const now = options.now ?? Date.now()
    const limit = Number.isInteger(options.limit) ? Math.max(1, options.limit) : 40
    const eligible = typeof options.eligible === 'function' ? options.eligible : null
    const cache = this.#scope(projectKey), records = [], authority = knowledgeAuthority(this.#store)
    const times = [...new Set(options.referenceTimes ?? [null])]
    const allowed = (note, at) => this.#eligible(note, projectKey, now, authority, at)
    const visible = note => (!eligible || eligible(note)) && times.some(at => allowed(note, at))
    const files = this.#visibleFiles(projectKey, visible, period => times.some(at => matchesKnowledgePeriod(period, now, at)),
      eligible !== null || times.some(Number.isFinite))
      .map(file => this.#files.get(file).header)
      .filter(note => note.mtimeMs <= now)
      .sort((left, right) => right.mtimeMs - left.mtimeMs || left.file.localeCompare(right.file))
    for (const note of files) {
      const value = this.#hydrate(cache, note.file, visible)
      if (!value || (eligible && !eligible(value.record))) continue
      value.semanticSections ??= knowledgeSemanticSections(value.sentences, value.record.noteTitle)
      const semanticSections = value.semanticSections
      if (semanticSections.length === 0) continue
      const hasCurrentSection = semanticSections.some(section => !section.datedOnly)
      const noteReferenceTimes = times.filter(at => (at !== null || hasCurrentSection) && allowed(value.note, at))
      if (noteReferenceTimes.length === 0) continue
      records.push({ record: { ...value.record, semanticSections, noteReferenceTimes }, score: 0, matched: [], termScores: [] })
      if (records.length >= limit) break
    }
    return records
  }

  search(query, options = {}) {
    const projectKey = options.projectKey, now = options.now ?? Date.now()
    const asOf = Number.isFinite(options.asOf) ? options.asOf : null
    const limit = options.limit ?? 40
    const terms = queryTerms(query)
    if (terms.length === 0) return []
    const authority = knowledgeAuthority(this.#store)
    const visible = note => this.#eligible(note, projectKey, now, authority, asOf)
    const cache = this.#scope(projectKey)
    const files = this.#visibleFiles(projectKey, visible, period => matchesKnowledgePeriod(period, now, asOf), asOf !== null)
    const verify = typeof options.verify === 'function' ? options.verify : null
    const admissible = value => value && visible(value.note)
    if (verify && options.requireUnique) {
      let match = null
      // A title match alone cannot establish which earlier version was last.
      // Look for conflicting excerpts in all notes the current scope may read.
      for (const file of files) {
        const value = this.#hydrate(cache, file, visible)
        if (!admissible(value)) continue
        for (const passage of value.sentences) {
          if (!verify(value.record, passage.quote, passage.section, passage)) continue
          if (match && match.passage.quote !== passage.quote) return []
          match ??= { value, passage }
        }
      }
      if (!match) return []
      const score = quoteScore(match.passage.normalized, terms)
      return [knowledgeHit(match.value, { ...match.passage, score }, terms, null, query, asOf)]
    }
    const quotes = new Map()
    const check = value => {
      if (!admissible(value)) return null
      if (!quotes.has(value.record.id)) quotes.set(value.record.id, findQuote(value, terms, verify, asOf))
      return quotes.get(value.record.id)
    }
    if (verify) {
      const normalized = String(query).normalize('NFKC')
      const located = files.filter(file => this.#labels(file).some(label => label.test(normalized)))
      const hits = []
      for (const file of located) {
        const value = this.#hydrate(cache, file, visible)
        const quote = check(value)
        if (quote) hits.push(knowledgeHit(value, quote, terms, null, query, asOf))
      }
      // A directory hit is sufficient only when its actual text supports this
      // question. Misses scan bodies in the authorized project and global scope.
      if (hits.length > 0) {
        const plan = options.valuePlan
        if (isComparableKnowledgePlan(plan)) {
          const referenceGroups = new Set(hits.flatMap(({ record }) => record.notePassages.flatMap(passage =>
            comparableKnowledgeClaims(record, passage).filter(claim => claim.detail === plan.detail).map(claim => claim.group))))
          const locatedFiles = new Set(located)
          const scopes = new Set(hits.map(hit => hit.record.projectKey))
          if (referenceGroups.size) for (const file of files) {
            if (locatedFiles.has(file) || !scopes.has(this.#files.get(file)?.header?.projectKey)) continue
            const { groups, snapshot } = this.#valueGroups(cache, file, projectKey, now, authority)
            if (![...referenceGroups].some(group => groups.has(group))) continue
            const value = this.#hydrate(cache, file, visible, snapshot)
            if (!admissible(value)) continue
            const quote = findQuote(value, terms, (record, quote, section, passage) =>
              comparableKnowledgeClaims(record, passage).some(claim => claim.detail === plan.detail && referenceGroups.has(claim.group)) &&
              verify(record, quote, section, passage))
            if (quote) hits.push(knowledgeHit(value, quote, terms, null, query, asOf))
          }
          const preferred = []
          for (const entries of knowledgeValueConflicts(plan, hits)) {
            const values = new Set()
            for (const { hit, key } of entries) {
              if (values.has(key)) continue
              values.add(key)
              preferred.push(hit)
            }
          }
          const sorted = hits.sort((left, right) => right.score - left.score)
          return [...new Set([...preferred, ...sorted])].slice(0, limit)
        }
        return hits.sort((left, right) => right.score - left.score).slice(0, limit)
      }
    }
    for (const file of files) this.#hydrate(cache, file, visible)
    const candidates = cache.index.search(query, {
      statuses: asOf === null ? ['active'] : ['active', 'superseded'],
      includeExpired: asOf !== null,
      scopes: ['project', 'global'],
      projectKey,
      now,
      limit,
      eligible: record => check(cache.notes.get(record.noteFile)) !== null,
    })
    return candidates.map(hit => knowledgeHit(cache.notes.get(hit.record.noteFile), quotes.get(hit.record.id),
      hit.matched, hit, verify ? query : null, asOf))
  }
}

function quoteScore(normalized, terms) {
  return terms.reduce((total, term) => total + (normalized.includes(term) ? (term.length > 1 ? 2 : 1) : 0), 0)
}

function tableCells(line) {
  if (!line?.includes('|') || /^(?: {4}|\t)/u.test(line)) return null
  return line.trim().replace(/^\||(?<!\\)\|$/gu, '').split(/(?<!\\)\|/u).map(cell => cell.trim())
}

function retentionTable(line, cells, nextLine) {
  if (!cells || cells.length < 2) return null
  const divider = tableCells(nextLine)
  if (divider?.length !== cells.length || !divider.every(cell => /^:?-{3,}:?$/u.test(cell))) return null
  const column = pattern => cells.flatMap((cell, index) => pattern.test(cell.normalize('NFKC')) ? [index] : [])
  const subjects = column(/^(?:任务(?:名称)?|名称|对象|项目(?:名称)?)$/u)
  const retention = column(/^(?:保留(?:期限|时间|时长)?|留存(?:期限|时长)?|保存期限)$/u)
  if (subjects.length !== 1 || retention.length !== 1) return null
  const reasons = column(/^(?:(?:调整|修改|更改|变更)原因|原因(?:说明)?)$/u)
  return { header: line.trim(), width: cells.length, subject: subjects[0], retention: retention[0],
    reason: reasons.length === 1 ? reasons[0] : null }
}

function markdownBlocks(lines) {
  const blocks = new Map()
  let paragraphStart = null, fence = null, container = false
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    const fenceMatch = MARKDOWN_FENCE.exec(line)
    if (fence) {
      if (fenceMatch?.[1].startsWith(fence.marker) && fenceMatch[2].trim() === '') {
        blocks.set(fence.start, { end: index })
        fence = null
      }
      continue
    }
    if (fenceMatch) {
      fence = { marker: fenceMatch[1], start: index }
      paragraphStart = null
      container = false
      continue
    }
    const heading = MARKDOWN_HEADING.exec(line)
    if (heading) {
      blocks.set(index, { level: heading[1].length, title: heading[2].trim(), end: index })
      paragraphStart = null
      container = false
      continue
    }
    const underline = SETEXT_UNDERLINE.exec(line)
    if (underline && paragraphStart !== null) {
      const title = lines.slice(paragraphStart, index).map(row => row.trim()).join(' ')
      blocks.set(paragraphStart, { level: underline[1][0] === '=' ? 1 : 2, title, end: index })
      paragraphStart = null
      continue
    }
    if (line.trim() === '' || MARKDOWN_DIVIDER.test(line)) {
      paragraphStart = null
      container = false
    } else if (MARKDOWN_CONTAINER.test(line)) {
      // Lazy continuations of a list or quote cannot start a top-level heading.
      paragraphStart = null
      container = true
    } else if (line.trimStart().startsWith('|')) {
      paragraphStart = null
    } else if (!container && paragraphStart === null && !INDENTED_LINE.test(line)) {
      paragraphStart = index
    }
  }
  if (fence) blocks.set(fence.start, { end: lines.length - 1 })
  return blocks
}

function noteSentences(text) {
  const headings = [], sentences = [], seen = new Set()
  const lines = text.split(/\r?\n/u)
  const blocks = markdownBlocks(lines)
  let section = '', table = null
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    const block = blocks.get(index)
    if (block) {
      if (block.level !== undefined) {
        headings.length = block.level
        headings[block.level - 1] = block.title
        section = headings.filter(Boolean).join(' / ')
      }
      index = block.end
      table = null
      continue
    }
    const cells = tableCells(line)
    const layout = retentionTable(line, cells, lines[index + 1])
    if (layout) { table = layout; index++; continue }
    if (table && cells?.length === table.width && !/^\s*>/u.test(line)) {
      const quote = line.trim(), key = section + '\n' + table.header + '\n' + quote
      if (!seen.has(key)) {
        const subject = cells[table.subject], value = cells[table.retention]
        seen.add(key)
        sentences.push({ quote, section, normalized: quote.normalize('NFKC').toLowerCase(), tableHeader: table.header,
          tableSubject: subject, retention: value || null,
          ...(table.reason === null ? {} : { tableReason: cells[table.reason] || null }) })
      }
      continue
    }
    table = null
    const key = section + '\n' + line
    if (line.trim() === '' || /^\s*>/u.test(line) || seen.has(key)) continue
    // Repeated table rows and log lines in the same section count once.
    seen.add(key)
    for (const quote of sourceSentences(line)) {
      sentences.push({ quote, section, normalized: quote.normalize('NFKC').toLowerCase() })
    }
  }
  return sentences
}

function knowledgeSemanticSections(passages, noteTitle) {
  const sections = []
  let heading, lines = null
  for (const { section, quote } of passages) {
    if (isHistoricalKnowledgeSection(section, noteTitle)) { lines = null; continue }
    if (lines === null || section !== heading) {
      heading = section
      lines = []
      sections.push({ lines, datedOnly: isHistoricalKnowledgeSection(section) })
    }
    lines.push(quote)
  }
  return sections.map(({ lines, datedOnly }) => ({ text: lines.join('\n'), datedOnly }))
}

export function matchingKnowledgeTableRows(record, quote) {
  if (!record.content.includes('|')) return []
  return noteSentences(record.content).filter(passage => passage.tableHeader &&
    (passage.quote.includes(quote) || quote.includes(passage.quote)))
}

const CLOCK_VALUE = /(?<![\d:])(?:[01]?\d|2[0-3]):[0-5]\d(?![\d:])/gu
const RETENTION_DURATION = /^(\d+(?:\.\d+)?)\s*(天|日|周|星期|个月|月|年|小时|分钟|秒)$/u
const RETENTION_STATEMENT = /((?:保留|留存|保存)(?:期限|时间|时长)?\s*(?:[:：]|为|是)?\s*)(\d+(?:\.\d+)?\s*(?:天|日|周|星期|个月|月|年|小时|分钟|秒))/gu
const DURATION_SCALE = { 秒: 1, 分钟: 60, 小时: 3600, 天: 86400, 日: 86400, 周: 604800, 星期: 604800 }

function isExcludedClaim(text, matched) {
  const before = text.slice(0, matched.index).split(/[，,。;；!?！？]/u).at(-1)
  const after = text.slice(matched.index + matched[0].length).split(/[，,。;；!?！？]/u)[0]
  const excluded = /(?:不会|不再|不在|未曾|并非|不是|拒绝|取消|(?:至多|至少|最多|最少|大约)|\b(?:not|never|won't|at (?:most|least))\b)/iu
  const explicitVerb = /^(?:\s*的?\s*)?(?:不执行|不启动|不会运行|不保留|已取消|以上|以下|以内|左右)/u
  return excluded.test(before) || explicitVerb.test(after) || /(?:不|未|停止)\s*$/u.test(before)
}

function normalizedClaim(detail, value) {
  if (!value) return null
  if (detail === 'clock') {
    const clock = /^(\d{1,2}):([0-5]\d)$/u.exec(value)
    return clock && { family: 'clock', key: `${Number(clock[1])}:${clock[2]}`, value }
  }
  const duration = RETENTION_DURATION.exec(value)
  if (!duration) return null
  const [, amount, unit] = duration
  const scale = DURATION_SCALE[unit]
  const key = Number(amount) * (scale ?? (unit === '年' ? 12 : 1))
  return Number.isFinite(key) ? { family: scale ? 'fixed' : 'calendar', key, value } : null
}

function comparableKnowledgeClaims(record, passage) {
  if (isHistoricalKnowledgeSection(passage.section)) return []
  const text = passage.quote.normalize('NFKC')
  const clock = [...text.matchAll(CLOCK_VALUE)]
  const retention = [...text.matchAll(RETENTION_STATEMENT)]
  let time = clock.length === 1 && !isExcludedClaim(text, clock[0]) ? clock[0][0] : null
  let duration = retention.length === 1 && !isExcludedClaim(text, retention[0]) ? retention[0][2] : null
  let template = text
  if (passage.tableHeader) {
    const columns = tableCells(passage.tableHeader), values = tableCells(text)
    const timeColumn = columns.findIndex(label => /^(?:(?:每日|每天)?(?:执行|启动|调度|运行)(?:时间|时刻))$/u.test(label))
    const timeCell = values[timeColumn]
    time = timeCell && /^\d{1,2}:[0-5]\d$/u.test(timeCell) && clock.length === 1 ? timeCell : null
    duration = passage.retention?.normalize('NFKC') ?? null
    if (time) template = template.replace(time, '<time>')
    if (duration && RETENTION_DURATION.test(duration) && values.filter(value => value === duration).length === 1) {
      template = template.replace(duration, '<duration>')
    }
    template = passage.tableHeader + '\n' + template
  } else {
    if (time) template = template.replace(CLOCK_VALUE, '<time>')
    if (duration) template = template.replace(RETENTION_STATEMENT, '$1<duration>')
  }
  if (!time && !duration) return []
  // Preserve headings that qualify the statement, such as weekdays and weekends.
  const title = titleText(record.noteTitle ?? '')
  const section = passage.section.startsWith(title + ' / ') ? passage.section.slice(title.length + 3) : passage.section
  const context = [record.scope, record.projectKey, section, template.replace(/每日/gu, '每天').normalize('NFKC').toLowerCase().replace(/\s+/gu, '')]
  return [['clock', time], ['retention', duration]].flatMap(([detail, value]) => {
    const claim = normalizedClaim(detail, value)
    if (!claim) return []
    const group = createHash('sha256').update(JSON.stringify([detail, claim.family, ...context])).digest('hex')
    return [{ ...claim, detail, group }]
  })
}

function isComparableKnowledgePlan(plan) {
  return plan?.timeIntent?.kind === 'current' && plan.entityTerms?.length > 0 && ['clock', 'retention'].includes(plan.detail)
}

export function knowledgeValueConflicts(plan, hits) {
  if (!isComparableKnowledgePlan(plan) || hits.length < 2) return []
  const groups = new Map()
  for (const hit of hits) {
    const record = hit.record
    for (const passage of record.notePassages ?? []) {
      const claim = comparableKnowledgeClaims(record, passage).find(item => item.detail === plan.detail)
      if (!claim) continue
      const members = groups.get(claim.group) ?? []
      members.push({ hit, key: claim.key, value: claim.value, quote: passage.quote })
      groups.set(claim.group, members)
    }
  }
  return [...groups.values()].filter(members => new Set(members.map(member => member.key)).size > 1 &&
    new Set(members.map(member => member.hit.record.id)).size > 1)
}

const OLD_HEADING = /^(?:历史(?:方案|记录|设置|配置|变更|版本|策略)?|旧(?:版(?:的?(?:方案|配置|设置|策略|规则))?|方案|配置|设置|策略|规则)|退役(?:方案|配置|设置|记录)?|废弃(?:的?(?:方案|配置|设置|规则))?|已(?:停用|作废|废止|弃用|废弃)(?:的?(?:方案|配置|设置|策略|规则|版本))?|(?:historical|superseded|deprecated|retired|previous)(?:\s+(?:policy|settings?|configuration|plan|version|procedure|rules?|record))?)(?=$|[\s:：()（）\[\]【】—–-])/iu
const HEADING_STATUS = /[([【]\s*([^\])】]+?)\s*[)\]】]$/u

/** Headings describe the excerpt, independently of the note's active status. */
export function isHistoricalKnowledgeSection(section, noteTitle) {
  if (typeof section !== 'string') return false
  const parts = section.split(' / ')
  if (typeof noteTitle === 'string' && parts[0] === titleText(noteTitle)) parts.shift()
  return parts.some(part => {
    const title = part.normalize('NFKC').trim().replace(/^[【[(]\s*/u, '')
    const status = HEADING_STATUS.exec(title)?.[1]
    return OLD_HEADING.test(title) || (status !== undefined && OLD_HEADING.test(status))
  })
}

export function isCurrentKnowledgeQuote(record, quote, dated = false) {
  if (typeof quote !== 'string' || !quote.trim()) return false
  const current = noteSentences(String(record?.content ?? ''))
    .filter(sentence => !isHistoricalKnowledgeSection(sentence.section, dated ? record.noteTitle : undefined))
  const headings = new Set()
  for (const { section } of current) for (const heading of section.split(' / ')) headings.add(heading)
  // A semantic excerpt can start with a heading from the same current section.
  const lines = quote.split(/\r?\n/u)
  const blocks = markdownBlocks(lines)
  const parts = []
  for (let index = 0; index < lines.length; index++) {
    const block = blocks.get(index)
    if (block?.level !== undefined) {
      if (!headings.has(block.title)) return false
      index = block.end
    } else parts.push(...sourceSentences(lines[index]))
  }
  return parts.length > 0 && parts.every(part => current.some(sentence => sentence.quote.includes(part)))
}

function findQuote(value, terms, verify, asOf = null) {
  let best = null
  for (const sentence of value.sentences) {
    const score = quoteScore(sentence.normalized, terms)
    if (score <= (best?.score ?? (verify ? -1 : 0))) continue
    const allowed = verify ? verify(value.record, sentence.quote, sentence.section, sentence)
      : !isHistoricalKnowledgeSection(sentence.section, asOf === null ? undefined : value.record.noteTitle)
    if (!allowed) continue
    best = { ...sentence, score }
  }
  return best
}

function knowledgeHit(value, quote, terms, hit, verifiedQuery, asOf) {
  const text = verifiedQuery === null ? value.record.content.normalize('NFKC').toLowerCase() : quote.normalized
  const matched = terms.filter(term => text.includes(term))
  const alias = verifiedQuery === null ? null : matchKnowledgeAlias(verifiedQuery, value.record)
  return { score: hit?.score ?? Math.max(1, quote.score), matched,
    termScores: hit?.termScores.filter(item => matched.includes(item.term)) ?? [],
    record: { ...value.record, noteQuote: quote.quote, ...(asOf == null ? {} : { noteReferenceTimes: [asOf] }), ...(verifiedQuery !== null
      ? { recallQuote: quote.quote, notePassages: [{ quote: quote.quote, section: quote.section,
        ...(quote.tableHeader ? { tableHeader: quote.tableHeader, tableSubject: quote.tableSubject,
          retention: quote.retention, tableReason: quote.tableReason } : {}) }],
        ...(alias ? { matchedNoteAlias: alias.alias } : {}) }
      : {}) } }
}
