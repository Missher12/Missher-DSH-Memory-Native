/** Project-private original passages. Grants are authority; the index is disposable. */
import { createHash } from 'node:crypto'
import { on } from 'node:events'
import { mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { availableParallelism } from 'node:os'
import { join } from 'node:path'
import { setImmediate as yieldToHost } from 'node:timers/promises'
import { Worker } from 'node:worker_threads'
import { canReadSource, readSource, readCaptureTasks, updateCaptureTask } from './capture-journal.js'
import { readAuthorityIntent } from './authority-intent.js'
import { atomicWritePrivate, withFileLock } from './persistence.js'
import { isValidProjectKey } from './paths.js'
import { looksSensitive } from './records.js'
import { estimateTokens } from './recall.js'
import { MemoryIndex } from './search.js'
import { readSourceCache, readSourceCacheAsync, sameSourceCacheDirectories, sourceCacheAuthority, SOURCE_PASSAGE_DESCRIPTOR,
  writeSourceCache } from './source-passage-cache.js'
import { analyzeUserMessageControls, explicitRememberText } from './user-controls.js'
import { sourceSentenceBreaks, sourceSentences } from './sentences.js'
import { sourceAvailableAt, sourceTimeReference } from './source-time.js'

const sourcePattern = /^src_[a-f0-9]{24}$/u
const READER_QUESTION = /,\s*(?:have|do|did|can|could|would|will|are|were)\s+you\b[^?？]*[?？]$/iu
const NON_STATEMENT_PREFIX = /^(?:["'“‘「『]|(?:if|unless|when|assuming|suppose|imagine|hypothetically|given|what if|have|has|had|do|does|did|can|could|would|should|will|are|were|was|is|please|tell me)\b)/iu
export const DEEP_RECALL_TOKEN_LIMIT = 50000
const hash = text => createHash('sha256').update(text).digest('hex')
const directory = (root, projectKey) => join(root, 'capture', 'recall-grants', projectKey)

function waitForPreparation(pending, signal) {
  if (!signal) return pending
  return new Promise(resolve => {
    const done = ready => {
      signal.removeEventListener('abort', abort)
      resolve(ready)
    }
    const abort = () => done(false)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    pending.then(done, () => done(false))
  })
}
const originalDirectory = root => join(root, 'capture', 'sources')
const sourceLock = (root, sourceId) => join(root, 'capture', 'source-locks', `${sourceId}.lock`)

export function withSourceRecallLock(root, sourceId, callback) {
  if (!sourcePattern.test(sourceId ?? '')) throw new TypeError('source id is invalid')
  const lockDir = join(root, 'capture', 'source-locks')
  mkdirSync(lockDir, { recursive: true, mode: 0o700 })
  return withFileLock(sourceLock(root, sourceId), callback)
}
export function isRecallSourceStatement(text) {
  const value = (explicitRememberText(text) ?? text).trim()
  return value.length > 3 && !/[？?]/u.test(value) &&
    !/^(?:>|\x60\x60\x60|引用|举例|例如|比方|假设|虚构)/u.test(value) &&
    !/^(?:请|帮我|麻烦|能不能|是不是|是否|what\b|which\b|who\b|when\b|where\b|why\b|how\b)/iu.test(value) &&
    !/(?:是什么|是多少|为什么|多少|多久|吗|呢)[。\s]*$/u.test(value)
}

/** Keep a complete statement followed by a separate question to the reader. */
export function sourceStatementExcerpt(sentence, allowQuestionTail = true) {
  if (isRecallSourceStatement(sentence)) return sentence
  if (!allowQuestionTail) return null
  const question = READER_QUESTION.exec(sentence)
  if (!question) return null
  const statement = sentence.slice(0, question.index).trimEnd()
  return !NON_STATEMENT_PREFIX.test(statement) && isRecallSourceStatement(statement) ? statement : null
}

const hasStatement = text => sourceSentences(text).some(sentence => sourceStatementExcerpt(sentence) !== null)
const permitted = source => source?.role === 'user' && source.sourceKind === 'user' &&
  typeof source.text === 'string' && !looksSensitive(source.text) &&
  hasStatement(explicitRememberText(source.text) ?? source.text) &&
  !analyzeUserMessageControls(source.text).noSaveDirective &&
  !/^\s*(?:>|```|引用(?:示例|内容)?[:：]|虚构(?:测试|验收)?(?:材料|资料))/u.test(source.text)

export function canGrantSourceRecall(root, source, projectKey) {
  return isValidProjectKey(projectKey) && source?.projectKey === projectKey &&
    sourcePattern.test(source?.id ?? '') && permitted(source) && canReadSource(root, source.id)
}

/** Called only after turn-level opt-out checks, never merely because a file exists. */
export function grantSourceRecall(root, source, projectKey, { remembered = false, locked = false } = {}) {
  if (source?.id && !locked) return withSourceRecallLock(root, source.id,
    () => grantSourceRecall(root, source, projectKey, { remembered, locked: true }))
  if (!canGrantSourceRecall(root, source, projectKey)) return false
  const dir = directory(root, projectKey)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const file = join(dir, source.id + '.json')
  const textHash = hash(source.text)
  try {
    const existing = JSON.parse(readFileSync(file, 'utf8'))
    if (existing.version === 1 && existing.sourceId === source.id && existing.projectKey === projectKey && existing.textHash === textHash &&
        (!remembered || existing.remembered === true)) return true
  } catch {}
  atomicWritePrivate(file, JSON.stringify({
    version: 1, sourceId: source.id, projectKey, textHash, grantedAt: Date.now(),
    ...(remembered ? { remembered: true } : {}),
  }) + '\n')
  return true
}

export function hasSourceRecallGrant(root, sourceId, projectKey) {
  return sourcePattern.test(sourceId ?? '') && readGrantedSource(root, sourceId, projectKey) !== null
}

export function readGrantedSource(root, sourceId, projectKey, allowBlocked = false) {
  if (!isValidProjectKey(projectKey) || !sourcePattern.test(sourceId) || (!allowBlocked && !canReadSource(root, sourceId))) return null
  try {
    const grant = JSON.parse(readFileSync(join(directory(root, projectKey), sourceId + '.json'), 'utf8'))
    if (grant.version !== 1 || grant.sourceId !== sourceId || grant.projectKey !== projectKey) return null
    const source = readSource(root, sourceId, { includeVerifiedHash: true })
    if (source?.projectKey !== projectKey || source.textHash !== grant.textHash || !permitted(source)) return null
    return { ...source, remembered: grant.remembered === true || explicitRememberText(source.text) !== null }
  } catch { return null }
}

function sourcePassage(source, from, to, sourceHash, timing) {
  const content = source.text.slice(from, to)
  const contentHash = from === 0 && to === source.text.length ? sourceHash : hash(content)
  return { id: `source:${source.id}:${from}:${to}`, kind: 'source', scope: 'project', projectKey: source.projectKey, status: 'active',
    content, contentHash, sourceHash, sourceLength: source.text.length, revision: 1, confidence: 1, importance: .5,
    tags: [], observedAt: source.at, updatedAt: source.at, validFrom: null, validTo: null,
    ...(sourcePattern.test(source.previousUserSourceId ?? '') ? { previousUserSourceId: source.previousUserSourceId } : {}),
    evidenceRole: 'user', remembered: source.remembered, sourceRefs: [{ sourceId: source.id, sessionId: source.sessionId,
      messageId: source.messageId, role: 'user', sourceKind: 'user', from, to, ...timing, excerpt: content }] }
}

function passages(source) {
  const records = [], text = source.text, sourceHash = source.textHash
  const timing = sourceTimeReference(source)
  for (let from = 0; from < text.length;) {
    let to = Math.min(text.length, from + 420)
    if (to < text.length) {
      const endings = [...text.slice(from + 210, to).matchAll(/[。！？\n]/gu)]
      if (endings.length) to = from + 210 + endings.at(-1).index + 1
      if (/[\uDC00-\uDFFF]/u.test(text[to])) to--
    }
    records.push(sourcePassage(source, from, to, sourceHash, timing))
    if (to === text.length) break
    from = Math.max(from + 1, to - 64)
    if (/[\uDC00-\uDFFF]/u.test(text[from])) from--
  }
  return records
}

export class SourcePassageIndex {
  #root
  #projects = new Map()
  #workers = new Set()
  constructor(root) { this.#root = root }
  clear() {
    this.#projects.clear()
    for (const worker of this.#workers) void worker.terminate().catch(() => {})
  }
  #emptyProject() {
    return { index: new MemoryIndex(), records: new Map(), sources: new Map(), sessions: new Map(),
      stamp: null, intent: null, pending: null, invalidated: new Set(), projection: null, listsReady: true }
  }
  #newProject(projectKey) {
    const cached = this.#emptyProject()
    this.#projects.set(projectKey, cached)
    if (this.#projects.size > 4) this.#projects.delete(this.#projects.keys().next().value)
    return cached
  }

  #state(projectKey) {
    try {
      const intent = readAuthorityIntent(this.#root)
      const dir = statSync(directory(this.#root, projectKey), { bigint: true, throwIfNoEntry: false })
      const stamp = dir ? [dir.dev, dir.ino, dir.mtimeNs, dir.ctimeNs].join(':') : 'absent'
      return { stamp, intent }
    } catch { return null }
  }

  #current(cached, state, projectKey) {
    return cached?.stamp === state.stamp && cached.intent === state.intent &&
      (!cached.projection || sourceCacheAuthority(this.#root, projectKey) === cached.projection.authority)
  }

  #attachCache(cached, projection, state) {
    cached.projection = projection
    cached.index = projection.index
    cached.listsReady = false
    cached.stamp = state.stamp
    cached.intent = state.intent
    return cached
  }

  #loadLists(cached) {
    if (cached.listsReady) return
    for (const record of cached.projection.records()) {
      const { sourceId, sessionId } = record.sourceRefs[0]
      cached.records.set(record.id, record)
      let source = cached.sources.get(sourceId)
      if (!source) {
        source = { sessionId, records: [] }
        cached.sources.set(sourceId, source)
        let session = cached.sessions.get(sessionId)
        if (!session) cached.sessions.set(sessionId, session = new Map())
        session.set(sourceId, source.records)
      }
      source.records.push(record)
    }
    cached.listsReady = true
  }

  async #persistCache(projectKey, cached, authority) {
    if (cached.sources.size < 4096 || !authority) return
    await yieldToHost()
    if (this.#projects.get(projectKey) !== cached || sourceCacheAuthority(this.#root, projectKey) !== authority) return
    const snapshot = cached.index.snapshot()
    const immutable = { ...snapshot, slots: snapshot.slots.slice(), lengths: snapshot.lengths.slice(),
      termNames: snapshot.termNames.slice(), df: snapshot.df.slice(), slotById: new Map(snapshot.slotById) }
    await writeSourceCache(this.#root, projectKey, authority, immutable, cached.sources.size, cached.projection?.key)
  }

  #currentGrants(grants, originals) {
    if (!originals) return grants
    const files = new Set(originals)
    return grants.filter(name => name.endsWith('.json') && files.has(name) &&
      !files.has(name.slice(0, -5) + '.recall-blocked'))
  }

  #removeSource(cached, sourceId) {
    const source = cached.sources.get(sourceId)
    if (!source) return
    for (const record of source.records) {
      cached.records.delete(record.id)
      cached.index.remove(record.id)
    }
    cached.sources.delete(sourceId)
    const session = cached.sessions.get(source.sessionId)
    session.delete(sourceId)
    if (!session.size) cached.sessions.delete(source.sessionId)
  }

  invalidateSources(sourceIds = []) {
    for (const cached of this.#projects.values()) {
      this.#loadLists(cached)
      for (const sourceId of sourceIds) {
        if (cached.pending) cached.invalidated.add(sourceId)
        this.#removeSource(cached, sourceId)
      }
    }
  }

  #unseenGrants(cached, files) {
    this.#loadLists(cached)
    const present = new Set(files.filter(name => name.endsWith('.json') && sourcePattern.test(name.slice(0,-5))).map(name => name.slice(0,-5)))
    for (const sourceId of cached.sources.keys()) {
      if (!present.has(sourceId)) this.#removeSource(cached, sourceId)
    }
    return [...present].filter(sourceId => !cached.sources.has(sourceId))
  }

  #addSource(cached, source) {
    if (!source || cached.invalidated.has(source.id)) return
    const { id: sourceId, sessionId } = source
    const records = passages(source)
    for (const record of records) {
      cached.records.set(record.id, record)
      cached.index.upsert(record)
    }
    cached.sources.set(sourceId, { sessionId, records })
    let session = cached.sessions.get(sessionId)
    if (!session) cached.sessions.set(sessionId, session = new Map())
    session.set(sourceId, records)
  }

  async *#readInWorkers(projectKey, ids, width) {
    const readers = []
    try {
      for (let slot = 0; slot < width; slot++) {
        const worker = new Worker(new URL('./source-passage-worker.js', import.meta.url), {
          workerData: { root: this.#root, projectKey }, execArgv: [],
        })
        this.#workers.add(worker)
        readers.push({ worker, messages: on(worker, 'message', { close: ['exit'] }) })
      }
      const batchSize = 128
      const batchCount = Math.ceil(ids.length / batchSize)
      const readAhead = width * 2
      const send = batch => {
        const start = batch * batchSize
        readers[batch % width].worker.postMessage(ids.slice(start, start + batchSize))
      }
      // Keep at most two batches per reader and apply results in input order.
      for (let batch = 0; batch < Math.min(batchCount, readAhead); batch++) send(batch)
      for (let batch = 0; batch < batchCount; batch++) {
        const response = await readers[batch % width].messages.next()
        if (response.done) throw new Error('original passage reader stopped early')
        if (batch + readAhead < batchCount) send(batch + readAhead)
        yield* response.value[0]
      }
    } finally {
      await Promise.allSettled(readers.map(({ worker }) => worker.terminate()))
      for (const { worker } of readers) this.#workers.delete(worker)
    }
  }

  async *#readMissing(cached, projectKey, ids, installed = cached) {
    const cores = availableParallelism()
    if (!this.#workers.size && ids.length >= 4096 && cores > 2) {
      const width = cores >= 8 && ids.length >= 32768 ? 4 : 2
      try {
        yield* this.#readInWorkers(projectKey, ids, width)
        return
      } catch {
        // An unavailable worker must not make the original archive unreadable.
        if (this.#projects.get(projectKey) !== installed) return
      }
    }
    for (const id of ids) {
      if (!cached.sources.has(id) && !cached.invalidated.has(id)) yield readGrantedSource(this.#root, id, projectKey)
    }
  }

  #refresh(projectKey, rebuild = false) {
    if (!isValidProjectKey(projectKey)) return null
    const state = this.#state(projectKey)
    if (!state) return null
    let cached = this.#projects.get(projectKey)
    if (!rebuild && this.#current(cached, state, projectKey)) return cached
    const authority = !rebuild && sourceCacheAuthority(this.#root, projectKey)
    // Synchronous callers still see a complete view, even if a different
    // caller was building a view incrementally.
    if (rebuild || !cached || cached.pending ||
        cached.projection && !sameSourceCacheDirectories(cached.projection.authority, authority)) cached = this.#newProject(projectKey)
    if (!rebuild && !cached.projection && cached.sources.size === 0) {
      const projection = readSourceCache(this.#root, projectKey, authority)
      if (projection) {
        this.#attachCache(cached, projection, state)
        if (projection.authority === authority) return cached
      }
    }
    cached.stamp = null
    try {
      const files = state.stamp === 'absent' ? [] : readdirSync(directory(this.#root, projectKey))
      const originals = cached.projection ? readdirSync(originalDirectory(this.#root)) : null
      for (const id of this.#unseenGrants(cached, this.#currentGrants(files, originals))) {
        this.#addSource(cached, readGrantedSource(this.#root, id, projectKey))
      }
    } catch { return null }
    if (cached.projection && sourceCacheAuthority(this.#root, projectKey) !== authority) return this.#refresh(projectKey, true)
    if (cached.projection) cached.projection.authority = authority
    cached.stamp = state.stamp
    cached.intent = state.intent
    return cached
  }

  async #build(projectKey, cached, installed = cached) {
    const materializing = installed !== cached
    for (let attempt = 0; attempt < 3; attempt++) {
      const state = this.#state(projectKey)
      if (!state || this.#projects.get(projectKey) !== installed) return false
      if (this.#current(cached, state, projectKey)) return true
      const fresh = !cached.projection && cached.sources.size === 0
      cached.stamp = null
      const authority = sourceCacheAuthority(this.#root, projectKey)
      if (materializing && !authority) return false
      if (cached.projection && !sameSourceCacheDirectories(cached.projection.authority, authority)) return false
      if (authority && fresh && !materializing) {
        const projection = await readSourceCacheAsync(this.#root, projectKey, authority)
        if (this.#projects.get(projectKey) !== installed) return false
        if (projection) {
          this.#attachCache(cached, projection, state)
          if (projection.authority === authority) return true
          cached.stamp = null
        }
      }
      let checked = 0, deadline = performance.now() + 12
      try {
        const [files, originals] = await Promise.all([
          state.stamp === 'absent' ? [] : readdir(directory(this.#root, projectKey)),
          cached.projection || materializing ? readdir(originalDirectory(this.#root)) : null,
        ])
        if (this.#projects.get(projectKey) !== installed) return false
        const newIds = this.#unseenGrants(cached, this.#currentGrants(files, originals))
        for await (const source of this.#readMissing(cached, projectKey, newIds, installed)) {
          if (this.#projects.get(projectKey) !== installed) return false
          this.#addSource(cached, source)
          if (++checked < 64 && performance.now() < deadline) continue
          await yieldToHost()
          checked = 0
          deadline = performance.now() + 12
        }
      } catch (error) {
        if (error?.code !== 'ENOENT') return false
        continue
      }
      const after = this.#state(projectKey)
      if (this.#projects.get(projectKey) !== installed) return false
      if (after?.stamp === state.stamp && after.intent === state.intent &&
          (!cached.projection && !materializing || sourceCacheAuthority(this.#root, projectKey) === authority)) {
        cached.stamp = state.stamp
        cached.intent = state.intent
        if (cached.projection) cached.projection.authority = authority
        if (materializing) this.#projects.set(projectKey, cached)
        else if (fresh || cached.projection) void this.#persistCache(projectKey, cached, authority).catch(() => {})
        return true
      }
    }
    return false
  }

  /** Prepare original passages without monopolizing the native host's event loop. */
  async prepare(projectKey, signal) {
    if (!isValidProjectKey(projectKey) || signal?.aborted) return false
    let cached = this.#projects.get(projectKey)
    if (!cached || cached.projection &&
        !sameSourceCacheDirectories(cached.projection.authority, sourceCacheAuthority(this.#root, projectKey))) {
      cached = this.#newProject(projectKey)
    }
    cached.pending ??= this.#build(projectKey, cached).finally(() => {
      cached.pending = null
      cached.invalidated.clear()
    })
    return waitForPreparation(cached.pending, signal)
  }

  hasProjection(projectKey) { return Boolean(this.#projects.get(projectKey)?.projection) }

  async semanticCandidates(projectKey, { now = Date.now(), signal } = {}) {
    if (!await this.prepare(projectKey, signal)) return null
    const projected = this.#projects.get(projectKey)
    if (projected?.projection) {
      // Rank-only callers keep using the projection while the full view is prepared.
      projected.materialization ??= this.#build(projectKey, this.#emptyProject(), projected).finally(() => {
        projected.materialization = null
      })
      if (!await waitForPreparation(projected.materialization, signal)) return null
    }
    const cached = this.#projects.get(projectKey)
    const state = this.#state(projectKey)
    if (!cached || !state || !this.#current(cached, state, projectKey) || cached.projection) return null
    const authority = sourceCacheAuthority(this.#root, projectKey)
    const candidates = []
    const readable = new Map()
    let deadline = performance.now() + 12
    for (const record of cached.records.values()) {
      if (signal?.aborted || this.#projects.get(projectKey) !== cached) return null
      const ref = record.sourceRefs[0]
      if (sourceAvailableAt(ref, now)) {
        if (!readable.has(ref.sourceId)) readable.set(ref.sourceId, canReadSource(this.#root, ref.sourceId))
        if (readable.get(ref.sourceId)) candidates.push({ record, score: 0, matched: [], termScores: [] })
      }
      if (performance.now() < deadline) continue
      await yieldToHost()
      deadline = performance.now() + 12
    }
    const after = this.#state(projectKey)
    return !signal?.aborted && this.#projects.get(projectKey) === cached && after &&
      this.#current(cached, after, projectKey) && sourceCacheAuthority(this.#root, projectKey) === authority ? candidates : null
  }
  validate(hit, projectKey) {
    return this.validateMany([hit], projectKey).length === 1
  }
  validateMany(hits, projectKey, { refreshRemembered = false, now = Date.now() } = {}) {
    const sources = new Map(), valid = []
    for (const hit of Array.isArray(hits) ? hits : []) {
      const record = hit?.record ?? hit, ref = record?.sourceRefs?.[0]
      if (record?.scope !== 'project' || record.projectKey !== projectKey || record.kind !== 'source' ||
          !sourceAvailableAt(ref, now) || !Number.isSafeInteger(ref.from) ||
          !Number.isSafeInteger(ref.to) || ref.from < 0 || ref.to <= ref.from) continue
      if (!sources.has(ref.sourceId)) {
        sources.set(ref.sourceId, readGrantedSource(this.#root, ref.sourceId, projectKey))
      }
      const source = sources.get(ref.sourceId)
      if (!source) continue
      const timing = sourceTimeReference(source)
      const wholeSource = ref.from === 0 && ref.to === source.text.length
      const previous = sourcePattern.test(source.previousUserSourceId ?? '') ? source.previousUserSourceId : undefined
      const descriptor = record[SOURCE_PASSAGE_DESCRIPTOR] === true
      const content = source.text.slice(ref.from, ref.to)
      if (record.id !== `source:${source.id}:${ref.from}:${ref.to}` || record.sourceHash !== source.textHash ||
          ref.sessionId !== source.sessionId || ref.messageId !== source.messageId ||
          ref.to > source.text.length || !descriptor && content !== record.content ||
          record.contentHash !== (wholeSource ? source.textHash : hash(content)) || ref.at !== timing.at ||
          ref.eventTime !== timing.eventTime || ref.timeZone !== timing.timeZone || ref.eventSeq !== timing.eventSeq ||
          record.previousUserSourceId !== previous) continue
      if (descriptor) {
        const materialized = sourcePassage(source, ref.from, ref.to, source.textHash, timing)
        valid.push(hit.record ? { ...hit, record: materialized } : materialized)
        continue
      }
      // Promotions keep the original passage ID and can occur after indexing.
      if (refreshRemembered && record.remembered !== source.remembered) {
        const refreshed = { ...record, remembered: source.remembered }
        valid.push(hit.record ? { ...hit, record: refreshed } : refreshed)
      } else valid.push(hit)
    }
    return valid
  }
  candidates(projectKey, { now = Date.now() } = {}) {
    let cached = this.#refresh(projectKey)
    if (cached?.projection) cached = this.#refresh(projectKey, true)
    if (!cached) return []
    return [...cached.records.values()].filter(record => {
      const ref = record.sourceRefs[0]
      return sourceAvailableAt(ref, now) && canReadSource(this.#root, ref.sourceId)
    })
      .map(record => ({ record, score: 0, matched: [], termScores: [] }))
  }
  #rankOptions(projectKey, now, limit) {
    const readable = new Map()
    return {
      projectKey, scopes: ['project'], statuses: ['active'], now, limit,
      eligible: record => sourceAvailableAt(record.sourceRefs[0], now),
      acceptRanked: record => {
        const { sourceId } = record.sourceRefs[0]
        if (!readable.has(sourceId)) readable.set(sourceId, canReadSource(this.#root, sourceId))
        return readable.get(sourceId)
      },
    }
  }
  search(query, { projectKey, now = Date.now(), limit = 40 } = {}) {
    const cached = this.#refresh(projectKey)
    if (!cached) return []
    const options = this.#rankOptions(projectKey, now, limit)
    const ranked = cached.index.search(query, options)
    const valid = this.validateMany(ranked, projectKey, { refreshRemembered: true, now })
    if (!cached.projection || valid.length === ranked.length) return valid
    const rebuilt = this.#refresh(projectKey, true)
    return rebuilt ? this.validateMany(rebuilt.index.search(query, options), projectKey, { refreshRemembered: true, now }) : []
  }

  /** Restore a sentence clipped by the lexical index, with the original bytes rechecked. */
  completeSentences(hit, projectKey) {
    const { record } = hit
    const ref = record.sourceRefs[0]
    if (ref.from === 0 && ref.to === record.sourceLength) return hit
    const original = readGrantedSource(this.#root, ref.sourceId, projectKey)
    if (!original || original.text.length !== record.sourceLength || original.textHash !== record.sourceHash ||
        original.text.slice(ref.from, ref.to) !== record.content) return null
    const start = Math.max(0, ref.from - 180), end = Math.min(original.text.length, ref.to + 180)
    const breaks = sourceSentenceBreaks(original.text.slice(start, end)).map(point => start + point.index + 1)
    if (start === 0) breaks.unshift(0)
    if (end === original.text.length) breaks.push(end)
    const from = breaks.findLast(position => position <= ref.from) ?? breaks[0]
    const to = breaks.find(position => position >= ref.to) ?? breaks.at(-1)
    if (!(from < to && from < ref.to && to > ref.from)) return null
    return { ...hit, record: sourcePassage(original, from, to, record.sourceHash, sourceTimeReference(original)) }
  }

  /** Authorized neighbors in this session. Capture time is not message order. */
  #neighborMessages(hit, projectKey, direction, limit, now) {
    const ref = hit.record.sourceRefs[0]
    const cached = this.#refresh(projectKey)
    let session = cached?.sessions.get(ref.sessionId)
    if (cached?.projection && !cached.listsReady) {
      session = new Map()
      for (const record of cached.projection.records(ref.sessionId)) {
        const { sourceId } = record.sourceRefs[0]
        if (!session.has(sourceId)) session.set(sourceId, [])
        session.get(sourceId).push(record)
      }
    }
    if (!session) return []
    const found = new Set()
    for (const clock of ['eventSeq', 'eventTime']) {
      if (!Number.isSafeInteger(ref[clock])) continue
      const earlier = [...session.values()].filter(([record]) => {
        const source = record.sourceRefs[0]
        if (!sourceAvailableAt(source, now)) return false
        if (clock === 'eventTime' && Number.isSafeInteger(ref.eventSeq) && Number.isSafeInteger(source.eventSeq)) return false
        return Number.isSafeInteger(source[clock]) && direction * (source[clock] - ref[clock]) > 0
      }).sort(([left], [right]) => direction * (left.sourceRefs[0][clock] - right.sourceRefs[0][clock]))
      for (const records of earlier.slice(0, limit)) for (const record of records) found.add(record)
    }
    const hits = [...found].map(record => ({ record }))
    const verified = this.validateMany(hits, projectKey, { refreshRemembered: true, now })
    let tokens = 0
    for (const { record } of verified) {
      tokens += estimateTokens(record.content)
      if (tokens > DEEP_RECALL_TOKEN_LIMIT) return []
    }
    return verified
  }

  previousMessages(hit, projectKey, { now = Date.now() } = {}) {
    return this.#neighborMessages(hit, projectKey, -1, 6, now)
  }
  followingMessages(hit, projectKey, { now = Date.now(), limit = 1 } = {}) {
    return this.#neighborMessages(hit, projectKey, 1, Math.max(0, Math.min(6, limit)), now)
  }

  /** Read the exact predecessor after its identity has been established. */
  precedingUserMessage(hit, sourceId, projectKey, now) {
    const ref = hit.record.sourceRefs[0]
    const previous = readGrantedSource(this.#root, sourceId, projectKey)
    if (!previous || previous.sessionId !== ref.sessionId || previous.id === ref.sourceId || previous.text.length > 1600 ||
        !Number.isSafeInteger(previous.eventTime) || !Number.isSafeInteger(ref.eventTime) ||
        previous.eventTime > ref.eventTime || !Number.isSafeInteger(previous.eventSeq) ||
        !Number.isSafeInteger(ref.eventSeq) || previous.eventSeq >= ref.eventSeq) return null
    const timing = sourceTimeReference(previous)
    return sourceAvailableAt(timing, now) ? { record: sourcePassage(previous, 0, previous.text.length, previous.textHash, timing) } : null
  }

  /** Inspect ranked passages within the shared local search budget. */
  findEvidence(queries, { projectKey, now = Date.now(), maxTokens = DEEP_RECALL_TOKEN_LIMIT, match, distinctKey,
    lookupQuery, wholeSentences = false, acceptOriginal = false, isCandidate, allMatches = false,
    maxMatchesPerQuery, maxRankedPassages = 1024 }) {
    const cached = this.#refresh(projectKey)
    const budget = Math.min(DEEP_RECALL_TOKEN_LIMIT, Math.max(0, Math.floor(maxTokens)))
    if (!cached || !budget || queries.length === 0) return {
      matches: [], tokens: 0, ...(allMatches ? { incomplete: !budget } : {}),
    }
    const limit = Math.min(maxRankedPassages, budget)
    const rankOptions = this.#rankOptions(projectKey, now, limit + Number(allMatches))
    const lanes = queries.map(query => ({ query, hits: cached.index.search(lookupQuery?.(query) ?? query, rankOptions),
      found: [], keys: new Set(), candidate: null, done: false, visited: 0 }))
    const matched = new Map()
    const expanded = new Map()
    const hydrated = new Map()
    let tokens = 0, budgetOmitted = false, invalidDescriptor = false
    for (let rank = 0; rank < limit && tokens < budget; rank++) {
      let pending = false
      for (const lane of lanes) {
        const original = lane.hits[rank]
        if (!original || lane.done) continue
        pending = true
        lane.visited++
        let hit = original
        if (hit.record[SOURCE_PASSAGE_DESCRIPTOR]) {
          if (!hydrated.has(hit.record.id)) hydrated.set(hit.record.id, this.validateMany([hit], projectKey, { now })[0])
          hit = hydrated.get(hit.record.id)
          if (!hit) { invalidDescriptor = true; continue }
        }
        if (wholeSentences) {
          if (!expanded.has(original.record.id)) expanded.set(original.record.id, this.completeSentences(hit, projectKey))
          hit = expanded.get(original.record.id)
        }
        if (!hit) continue
        if (!canReadSource(this.#root, hit.record.sourceRefs[0].sourceId)) continue
        const cost = estimateTokens(hit.record.content)
        if (tokens + cost > budget) { budgetOmitted = true; continue }
        tokens += cost
        const evidence = match(lane.query, hit)
        if (!evidence) continue
        const key = distinctKey?.(lane.query, evidence)
        if (key !== undefined && lane.keys.has(key)) continue
        if (!matched.has(hit.record.id)) {
          matched.set(hit.record.id, this.validateMany([hit], projectKey, { refreshRemembered: true, now })[0])
        }
        const verified = matched.get(hit.record.id)
        if (!verified) continue
        const found = { ...evidence, record: { ...evidence.record, remembered: verified.record.remembered } }
        if (isCandidate?.(evidence) || (key !== undefined && !acceptOriginal && !verified.record.remembered)) {
          lane.candidate ??= found
          continue
        }
        lane.found.push(found)
        lane.keys.add(key)
        lane.done = !allMatches && lane.found.length >= (maxMatchesPerQuery ?? (key === undefined ? 1 : 2))
      }
      if (!pending) break
    }
    return { matches: lanes.flatMap(lane => (lane.found.length ? lane.found : [lane.candidate].filter(Boolean))
      .map(hit => ({ query: lane.query, hit }))), tokens,
      ...(allMatches ? { incomplete: invalidDescriptor || budgetOmitted || lanes.some(lane => lane.visited < lane.hits.length) } : {}) }
  }
}

/** Forgetting an original passage blocks its entire source, including extracted facts. */
export function forgetSourcePassage(root, id, projectKey, store, index) {
  const match = /^source:(src_[a-f0-9]{24}):\d+:\d+$/u.exec(id)
  if (!match) return null
  return withSourceRecallLock(root, match[1], () => {
    if (!readGrantedSource(root, match[1], projectKey, true)) return null
    for (const record of store.revokeSource(match[1], projectKey)) index.remove(record.id)
    for (const task of readCaptureTasks(root)) {
      if (task.projectKey !== projectKey || !task.sourceIds?.includes(match[1]) ||
          task.status !== 'pending' || task.callState !== 'not-sent') continue
      updateCaptureTask(root, task.id, { status: 'skipped', reason: '用户已遗忘该原始消息，未发送的提炼任务已撤销' })
    }
    return { id, status: 'deleted', revision: 1 }
  })
}
