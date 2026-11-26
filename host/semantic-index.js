/** Derived, profile-local vectors. Search results always point back to live authority. */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, appendFile, writeFile, rename, stat } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { join } from 'node:path'
import { isValidProjectKey } from './paths.js'
import { EMBEDDING_MODEL, LocalEmbedding } from './embedding.js'

const digest = text => createHash('sha256').update(text).digest('hex')
const encode = vector => Buffer.from(new Float32Array(vector).buffer).toString('base64')
function decode(text) {
  if (typeof text !== 'string' || text.length !== 2048) return null
  const bytes = Buffer.from(text, 'base64')
  if (bytes.length !== 1536) return null
  const vector = new Float32Array(new Uint8Array(bytes).buffer)
  const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0))
  return vector.every(Number.isFinite) && norm > .99 && norm < 1.01 ? vector : null
}

const eligible = (record, projectKey) => record.scope === 'global' ||
  record.scope === 'project' && record.projectKey === projectKey
const indexable = (record, projectKey) => eligible(record, projectKey) &&
  ['active', 'superseded'].includes(record.status) && !record.quoted
export const STRONG_SEMANTIC_SCORE = 0.8

function* passageWindows(section, keepStatements) {
  for (let start = 0; start < section.length;) {
    let end = Math.min(start + 420, section.length)
    if (keepStatements && end < section.length) {
      const boundary = section.lastIndexOf('\n', end)
      if (boundary > start) end = boundary
    }
    yield [start, section.slice(start, end)]
    if (end === section.length) return
    start = keepStatements && section[end] === '\n' ? end + 1 : end - 64
  }
}

export class SemanticRecallIndex {
  #root
  #engine
  #engineFactory
  #enabled
  #projects = new Map()
  #running = null
  #preparing = null
  #prepareGeneration = 0
  #prepareAction = null
  #disposed = false
  #error = null
  #options
  #retryAt = 0
  #preparedChunks = 0

  constructor(root, options = {}) {
    this.#root = root
    this.#enabled = options.enabled !== false
    this.#options = options
    this.#engineFactory = () => options.engine ?? new LocalEmbedding(options)
    this.#engine = this.#engineFactory()
  }

  status() {
    let indexed = 0, total = 0, queued = 0
    for (const scope of this.#projects.values()) {
      total += scope.entries.size
      queued += scope.pending.size
      for (const key of scope.entries.keys()) if (scope.vectors.has(key)) indexed++
    }
    return { model: EMBEDDING_MODEL, state: !this.#enabled ? 'disabled'
      : this.#preparing ? (this.#prepareAction === 'import' ? 'importing' : 'preparing')
      : this.#error ? 'failed'
      : this.#engine.state !== 'ready' ? this.#engine.state : indexed < total ? 'indexing' : 'ready',
      indexed, total, queued, preparedChunks: this.#preparedChunks,
      progress: this.#engine.progress ?? null,
      error: this.#error || this.#engine.error ? 'model-preparation-failed' : null }
  }

  prepare({ action = 'prepare', sourceDir } = {}) {
    if (!this.#enabled || this.#disposed) throw new Error('本地语义召回当前不可用')
    if (action === 'cancel') {
      this.#prepareGeneration++
      this.#engine.cancel?.()
      this.#preparing = null
      this.#prepareAction = null
      this.#error = null
      return this.status()
    }
    if (!['prepare', 'retry', 'import'].includes(action)) throw new Error('无效的模型准备操作')
    if (this.#preparing && action === 'prepare') return this.status()
    if (this.#preparing) this.#engine.cancel?.()
    this.#error = null
    this.#retryAt = 0
    const previous = this.#preparing
    const generation = ++this.#prepareGeneration
    const task = (async () => {
      await previous?.catch(() => {})
      if (generation !== this.#prepareGeneration || this.#disposed) return
      await this.#runPreparation(action, sourceDir, generation)
    })().catch(error => {
      if (generation === this.#prepareGeneration && !this.#disposed && error?.name !== 'AbortError') {
        this.#error = error instanceof Error ? error.message : '本地语义模型准备失败'
        this.#retryAt = Date.now() + 60000
      }
    }).finally(() => { if (generation === this.#prepareGeneration) { this.#preparing = null; this.#prepareAction = null } })
    this.#preparing = task
    this.#prepareAction = action
    return this.status()
  }

  async #runPreparation(action, sourceDir, generation) {
    if (action === 'retry') {
      this.#engine.dispose?.()
      this.#engine = this.#engineFactory()
      this.#error = null
      this.#retryAt = 0
    }
    if (action === 'import') {
      if (typeof sourceDir !== 'string' || sourceDir.trim() === '') throw new Error('请选择模型文件夹')
      await this.#engine.importModel?.(sourceDir)
    } else {
      await this.#engine.prepare?.()
    }
    if (generation !== this.#prepareGeneration || this.#disposed) return
    this.#error = null
    this.#pump()
  }

  async #scope(projectKey) {
    if (this.#projects.has(projectKey)) return this.#projects.get(projectKey)
    const file = join(this.#root, '.cache', 'semantic', EMBEDDING_MODEL, projectKey + '.jsonl')
    const scope = { file, entries: new Map(), records: new Map(), vectors: new Map(), pending: new Map(), queue: [], datedSearches: new Set(),
      queueCursor: 0, queueDead: 0, reconciled: false, loading: null, persistTail: Promise.resolve(), tombstones: 0, bytes: 0 }
    this.#projects.set(projectKey, scope)
    scope.loading = (async () => {
      try {
        const info = await stat(file)
        scope.bytes = info.size
        const input = createReadStream(file), lines = createInterface({ input, crlfDelay: Infinity })
        for await (const line of lines) {
          if (this.#disposed) { lines.close(); input.destroy(); return }
          try {
            const item = JSON.parse(line)
            if (!/^[a-f0-9]{64}$/u.test(item.key)) continue
            if (item.deleted === true) { scope.vectors.delete(item.key); continue }
            const vector = decode(item.vector)
            if (vector) scope.vectors.set(item.key, vector)
          } catch { /* A derived interrupted tail is rebuilt from authority. */ }
        }
      } catch (error) { if (error.code !== 'ENOENT') scope.cacheError = error.message }
    })()
    await scope.loading
    return scope
  }

  async #append(scope, rows) {
    if (this.#disposed || rows.length === 0) return
    const data = rows.map(row => JSON.stringify(row) + '\n').join('')
    scope.persistTail = scope.persistTail.then(async () => {
      if (this.#disposed) return
      await mkdir(join(scope.file, '..'), { recursive: true, mode: 0o700 })
      await appendFile(scope.file, data, { mode: 0o600 })
      scope.bytes += Buffer.byteLength(data)
    })
    await scope.persistTail
  }

  async #tombstone(scope, keys) {
    if (!keys.length) return
    scope.tombstones += keys.length
    await this.#append(scope, keys.map(key => ({ key, deleted: true })))
    if (scope.tombstones < 256 || this.#disposed) return
    const compacted = [...scope.vectors].map(([key, vector]) => ({ key, vector: encode(vector) }))
    scope.persistTail = scope.persistTail.then(async () => {
      if (this.#disposed) return
      await mkdir(join(scope.file, '..'), { recursive: true, mode: 0o700 })
      const temporary = scope.file + '.' + process.pid + '.tmp'
      const data = compacted.map(row => JSON.stringify(row) + '\n').join('')
      await writeFile(temporary, data, { mode: 0o600 })
      await rename(temporary, scope.file)
      scope.bytes = Buffer.byteLength(data)
      scope.tombstones = 0
    })
    await scope.persistTail
  }

  #enqueue(scope, key, entry) {
    if (scope.vectors.has(key) || (entry.datedOnly && !entry.record.noteReferenceTimes?.some(Number.isFinite))) return
    if (scope.pending.has(key)) {
      scope.pending.set(key, entry)
      return
    }
    scope.pending.set(key, entry)
    scope.queue.push(key)
  }

  #compactQueue(scope) {
    const remaining = scope.queue.length - scope.queueCursor
    if (scope.queueCursor < 1024 && scope.queueDead < 1024 && scope.queueDead <= remaining / 2) return
    scope.queue = scope.queue.slice(scope.queueCursor).filter(key => scope.pending.has(key))
    scope.queueCursor = 0
    scope.queueDead = 0
  }

  #removeRecord(scope, id, retired) {
    const previous = scope.records.get(id)
    if (!previous) return
    for (const key of previous.keys) {
      scope.entries.delete(key)
      if (scope.pending.delete(key)) scope.queueDead++
      if (scope.vectors.delete(key)) retired.push(key)
    }
    scope.records.delete(id)
    this.#compactQueue(scope)
  }

  #datedNoteInUse(scope, record) {
    if (record.kind !== 'knowledge') return null
    for (const notes of scope.datedSearches) {
      const note = notes.get(record.id)
      if (note?.noteReferenceTimes?.some(Number.isFinite) && note.revision === record.revision &&
          note.contentHash === record.contentHash) return note
    }
    return null
  }

  #reconcile(scope, records, projectKey, partial) {
    const seen = new Set(), retired = []
    for (const record of records) {
      if (!indexable(record, projectKey)) continue
      seen.add(record.id)
      const previous = scope.records.get(record.id)
      const contentHash = typeof record.contentHash === 'string' ? record.contentHash : digest(String(record.content ?? ''))
      const unchanged = previous && previous.revision === record.revision && previous.contentHash === contentHash &&
        previous.status === record.status && previous.quoted === record.quoted
      if (unchanged) {
        const indexedRecord = this.#datedNoteInUse(scope, record) ?? record
        for (const key of previous.keys) {
          const entry = scope.entries.get(key)
          if (entry) {
            entry.record = indexedRecord
            if (!scope.vectors.has(key)) this.#enqueue(scope, key, entry)
          }
        }
        previous.record = indexedRecord
        continue
      }
      this.#removeRecord(scope, record.id, retired)
      const keys = [], later = [], sections = record.semanticSections ?? [String(record.content ?? '')]
      const knowledge = record.kind === 'knowledge'
      let offset = 0
      for (const part of sections) {
        const section = typeof part === 'string' ? part : part.text
        const datedOnly = typeof part !== 'string' && part.datedOnly === true
        for (const [from, text] of passageWindows(section, knowledge)) {
          const key = digest(`${record.id}\0${record.revision}\0${contentHash}\0${offset + from}\0${text}`)
          const entry = { record, text, datedOnly }
          keys.push(key)
          scope.entries.set(key, entry)
          if (knowledge && from > 0) later.push(key)
          else this.#enqueue(scope, key, entry)
          this.#preparedChunks++
        }
        offset += section.length
      }
      // Make the first passage of every section available before indexing
      // the rest of a long section in the same note.
      for (const key of later) this.#enqueue(scope, key, scope.entries.get(key))
      scope.records.set(record.id, { record, revision: record.revision, contentHash, status: record.status, quoted: record.quoted, keys })
    }
    // A date filter omits rows that are still authoritative for other turns.
    if (partial) return retired
    for (const [id, saved] of scope.records) {
      if (!seen.has(id) && !this.#datedNoteInUse(scope, saved.record)) this.#removeRecord(scope, id, retired)
    }
    if (!scope.reconciled) {
      for (const key of scope.vectors.keys()) if (!scope.entries.has(key) && scope.vectors.delete(key)) retired.push(key)
      scope.reconciled = true
    }
    return retired
  }

  #live(record, projectKey) {
    if (!eligible(record, projectKey) || !['active', 'superseded'].includes(record.status) || record.quoted) return false
    try { return typeof this.#options.isLive !== 'function' || this.#options.isLive(record, projectKey) === true }
    catch { return false }
  }

  #liveMany(hits, projectKey) {
    const eligibleHits = hits.filter(({ record }) => eligible(record, projectKey) &&
      ['active', 'superseded'].includes(record.status) && !record.quoted)
    if (typeof this.#options.isLiveMany !== 'function') return new Set(eligibleHits.filter(hit => this.#live(hit.record, projectKey)))
    try { return new Set(this.#options.isLiveMany(eligibleHits, projectKey)) }
    catch { return new Set() }
  }

  #takeBatch() {
    const scopes = [...this.#projects.entries()]
    const cleanup = []
    for (const [projectKey, scope] of scopes) {
      const retired = []
      const batch = []
      while (scope.queueCursor < scope.queue.length && batch.length < 4) {
        const key = scope.queue[scope.queueCursor++], entry = scope.pending.get(key)
        if (!entry) continue
        scope.pending.delete(key)
        if (scope.entries.get(key) !== entry || scope.vectors.has(key)) continue
        if (entry.datedOnly && !entry.record.noteReferenceTimes?.some(Number.isFinite)) continue
        if (!this.#live(entry.record, projectKey)) {
          this.#removeRecord(scope, entry.record.id, retired)
          continue
        }
        batch.push([key, entry])
      }
      this.#compactQueue(scope)
      if (retired.length) cleanup.push({ scope, keys: retired })
      if (batch.length) return { scope, projectKey, batch, cleanup }
    }
    return cleanup.length ? { cleanup } : null
  }

  #pump() {
    if (this.#running || this.#disposed || this.#error || !this.#enabled) return
    this.#running = (async () => {
      for (;;) {
        if (this.#disposed) return
        const work = this.#takeBatch()
        if (!work) return
        for (const item of work.cleanup ?? []) await this.#tombstone(item.scope, item.keys)
        if (!work.batch) continue
        const { scope, projectKey, batch } = work
        let vectors
        try { vectors = await this.#engine.embed(batch.map(([, entry]) => entry.text), 'passage') }
        catch (error) {
          for (const [key, entry] of batch) if (scope.entries.get(key) === entry && !scope.vectors.has(key)) this.#enqueue(scope, key, entry)
          throw error
        }
        if (this.#disposed) return
        const rows = [], retired = []
        for (let i = 0; i < batch.length; i++) {
          const [key, entry] = batch[i]
          if (scope.entries.get(key) !== entry || !this.#live(entry.record, projectKey)) {
            if (scope.entries.get(key) === entry) this.#removeRecord(scope, entry.record.id, retired)
            continue
          }
          const vector = decode(encode(vectors[i]))
          if (!vector) throw new Error('本地语义模型返回无效向量')
          scope.vectors.set(key, vector)
          rows.push({ key, vector: encode(vector) })
        }
        await this.#append(scope, rows)
        for (const [key, entry] of batch) {
          if (scope.entries.get(key) !== entry || !this.#live(entry.record, projectKey)) {
            if (scope.vectors.delete(key)) retired.push(key)
          }
        }
        await this.#tombstone(scope, [...new Set(retired)])
        await new Promise(resolve => setTimeout(resolve, 0))
      }
    })().catch(error => {
      if (!this.#disposed && error?.name !== 'AbortError') { this.#error = error.message; this.#retryAt = Date.now() + 60000 }
    }).finally(() => { this.#running = null })
  }

  async #readyForDeferredCorpus(signal, waitMs) {
    const engine = this.#engine
    if (engine.state === 'ready' || typeof engine.prepare !== 'function') return true
    let timer, stop
    const deadline = new Promise(resolve => {
      stop = () => resolve(false)
      timer = setTimeout(stop, waitMs)
    })
    signal?.addEventListener('abort', stop, { once: true })
    try {
      return await Promise.race([deadline, Promise.resolve().then(() => engine.prepare()).then(() => true, error => {
        if (this.#engine === engine && !this.#disposed && !signal?.aborted && error?.name !== 'AbortError') {
          this.#error = error instanceof Error ? error.message : '本地语义模型准备失败'
          this.#retryAt = Date.now() + 60000
        }
        return false
      })])
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', stop)
    }
  }

  async search(queries, records, { projectKey, signal, waitMs = 6000, eligibleForQuery, recordForQuery,
    partial = false, deferCorpus = false } = {}) {
    if (!this.#enabled || this.#disposed || signal?.aborted || !isValidProjectKey(projectKey)) return queries.map(() => [])
    if (this.#error && Date.now() >= this.#retryAt) {
      this.#engine.dispose?.()
      this.#engine = this.#engineFactory()
      this.#error = null
    }
    // A projected source archive is only expanded if local embeddings can use it.
    if (deferCorpus && (this.#error || !await this.#readyForDeferredCorpus(signal, waitMs))) return queries.map(() => [])
    if (signal?.aborted || this.#disposed) return queries.map(() => [])
    const corpus = typeof records === 'function' ? await records() : records
    if (!corpus || signal?.aborted || this.#disposed) return queries.map(() => [])
    const positions = queries.map((_, index) => index).filter(index =>
      !eligibleForQuery || corpus.some(record => indexable(record, projectKey) && eligibleForQuery(record, index)))
    if (partial && (corpus.length === 0 || positions.length === 0)) return queries.map(() => [])
    const scope = await this.#scope(projectKey)
    await scope.loading
    if (signal?.aborted || this.#disposed) return queries.map(() => [])
    // Passage vectors are shared. Each request keeps its own authorized date view.
    const notes = new Map()
    let hasDatedNotes = false
    for (const record of corpus) {
      if (record.kind !== 'knowledge' || !indexable(record, projectKey)) continue
      notes.set(record.id, record)
      hasDatedNotes ||= record.noteReferenceTimes?.some(Number.isFinite) === true
    }
    const requestedRecord = record => {
      if (record?.kind !== 'knowledge') return record
      const requested = notes.get(record.id)
      return requested?.revision === record.revision && requested.contentHash === record.contentHash ? requested : null
    }
    if (hasDatedNotes) scope.datedSearches.add(notes)
    let timer, stopWaiting
    try {
      const retired = this.#reconcile(scope, corpus, projectKey, partial)
      await this.#tombstone(scope, retired)
      if (!scope.entries.size || this.#error || positions.length === 0 || signal?.aborted || this.#disposed) return queries.map(() => [])
      const keys = partial ? [...new Set(corpus.flatMap(record =>
        indexable(record, projectKey) ? scope.records.get(record.id)?.keys ?? [] : []))] : null
      this.#pump()
      const timeout = new Promise(resolve => {
        stopWaiting = () => resolve(null)
        timer = setTimeout(stopWaiting, waitMs)
      })
      signal?.addEventListener?.('abort', stopWaiting, { once: true })
      const vectors = await Promise.race([
        this.#engine.embed(positions.map(index => queries[index]), 'query').catch(error => {
          if (error?.name !== 'AbortError') { this.#error = error.message; this.#retryAt = Date.now() + 60000 }
          return null
        }),
        timeout,
      ])
      if (!vectors || signal?.aborted || this.#disposed) return queries.map(() => [])
      const rank = () => {
        const results = queries.map(() => [])
        positions.forEach((queryIndex, index) => {
          results[queryIndex] = this.#rank(scope, vectors[index], projectKey,
            eligibleForQuery && ((record, datedOnly) => eligibleForQuery(record, queryIndex, datedOnly)), keys,
            recordForQuery && (record => recordForQuery(record, queryIndex)), requestedRecord)
        })
        return results
      }
      const hits = rank()
      const missing = positions.filter(index => !hits[index].some(hit => hit.score >= STRONG_SEMANTIC_SCORE))
      const indexing = this.#running
      if (indexing && missing.length) {
        for (const key of keys ?? scope.entries.keys()) {
          const entry = scope.entries.get(key)
          const requested = requestedRecord(entry?.record)
          if (!requested || scope.vectors.has(key) ||
              (eligibleForQuery && !missing.some(index => eligibleForQuery(requested, index, entry.datedOnly)))) continue
          // The query can finish before its first passages are indexed.
          // Spend only what remains of the same search budget on those passages.
          await Promise.race([indexing, timeout])
          if (signal?.aborted || this.#disposed) return queries.map(() => [])
          return rank()
        }
      }
      return hits
    } finally {
      if (hasDatedNotes) scope.datedSearches.delete(notes)
      clearTimeout(timer)
      if (stopWaiting) signal?.removeEventListener?.('abort', stopWaiting)
    }
  }

  #rank(scope, vector, projectKey, eligibleForQuery, keys, recordForQuery, requestedRecord) {
    const hits = new Map()
    for (const key of keys ?? scope.vectors.keys()) {
      const candidate = scope.vectors.get(key)
      const entry = scope.entries.get(key)
      const requested = requestedRecord(entry?.record)
      if (!candidate || !requested || eligibleForQuery && !eligibleForQuery(requested, entry.datedOnly)) continue
      const score = candidate.reduce((sum, value, i) => sum + value * vector[i], 0)
      if (score < .7 || (hits.get(entry.record.id)?.score ?? 0) >= score) continue
      const record = recordForQuery ? recordForQuery(requested) : requested
      hits.set(record.id, { record: { ...record, recallContent: entry.text },
        score, semantic: true, matched: [], termScores: [] })
    }
    const ranked = [...hits.values()].sort((a, b) => b.score - a.score)
    const live = []
    for (let offset = 0; offset < ranked.length && live.length < 20; offset += 24) {
      const batch = ranked.slice(offset, offset + 24)
      const current = this.#liveMany(batch, projectKey)
      for (const hit of batch) if (current.has(hit)) live.push(hit)
    }
    return live.slice(0, 20)
  }

  async settle() {
    const preparation = this.#preparing
    await preparation?.catch(() => {})
    await this.#running
  }
  dispose() { this.#disposed = true; this.#prepareGeneration++; this.#preparing = null; this.#engine.dispose?.() }
}
