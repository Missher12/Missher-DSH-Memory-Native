/**
 * Automatic capture pipeline.
 *
 * Observes `session/event`, buffers the current turn's user/assistant text, and
 * on `turn/end` schedules one background extraction pass through the Host LLM.
 * Extraction output is applied as ADDs / UPDATEs / SUPERSEDEs against the JSONL
 * authority; exact duplicate statements are dropped and credential-looking text
 * is rejected by `records.buildRecord`.
 *
 * The pipeline never throws into the session: every failure is logged and the
 * conversation continues. The LLM route follows the committed session header,
 * then plugin config, then the Host default; background passes downgrade the
 * reasoning effort so extraction does not inherit an interactive `max`.
 *
 * @module dsh-memory/host/capture
 */

import { buildExtractionPrompt, parseExtraction } from './extract.js'
import { projectIdentity } from './paths.js'
import { buildRecord } from './records.js'
import { tokenize } from './tokenize.js'

const MAX_BUFFER_MESSAGES = 40
const MAX_MESSAGE_CHARS = 4000
/** One long turn is extracted in at most this many chunks. */
const MAX_EXTRACTION_CHUNKS = 3
/** Jaccard overlap above which a new item is folded into an existing record. */
const SIMILARITY_THRESHOLD = 0.9
/** Preference/decision statements tolerate a slightly looser merge (gray zone). */
const PREFERENCE_SIMILARITY_THRESHOLD = 0.85
/** Similarity at which a value/negation conflict is treated as a correction (SUPERSEDE). */
const CONFLICT_SIMILARITY_THRESHOLD = 0.7
/** Buffer size that triggers an in-turn extraction, so very long turns are not lost. */
const INCREMENTAL_CHARS = 20000
/** Maximum in-turn extraction passes per turn. */
const MAX_INCREMENTAL_PER_TURN = 2
const EXPLICIT_MEMORY_PATTERN = /记住|记一下|记下这个|别忘|以后都|从现在起|remember (?:this|that)|don'?t forget|from now on/iu
const LOW_EFFORT_ORDER = ['off', 'none', 'minimal', 'low']

function textOfContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

function truncate(text, limit) {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n…（已截断）`
}

/** Token-set Jaccard overlap of two statements, used to collapse near duplicates. */
function similarity(left, right) {
  const a = new Set(tokenize(left))
  const b = new Set(tokenize(right))
  if (a.size === 0 || b.size === 0) return 0
  let shared = 0
  for (const token of a) if (b.has(token)) shared += 1
  return shared / (a.size + b.size - shared)
}

const NEGATION_PATTERN = /(?:不|没|别|勿|禁止|never|\bnot\b|\bno\b)/iu

function numbersOf(text) {
  return new Set(String(text ?? '').match(/\d+(?:\.\d+)?/gu) ?? [])
}

/** Whether two similar statements carry conflicting values or polarity. */
function conflictingValues(left, right) {
  const a = numbersOf(left)
  const b = numbersOf(right)
  for (const value of a) if (!b.has(value)) return true
  for (const value of b) if (!a.has(value)) return true
  return NEGATION_PATTERN.test(String(left)) !== NEGATION_PATTERN.test(String(right))
}

/** Split a buffered turn into extraction chunks bounded by the configured input budget. */
function chunkMessages(messages, maxChars) {
  const chunks = []
  let current = []
  let size = 0
  for (const message of messages) {
    const line = `${message.role === 'user' ? '用户' : '助手'}：${message.text}`
    if (current.length > 0 && size + line.length > maxChars) {
      chunks.push(current)
      current = []
      size = 0
    }
    current.push({ message, line })
    size += line.length + 2
  }
  if (current.length > 0) chunks.push(current)
  return chunks
}

export class CapturePipeline {
  #store
  #index
  #config
  #ctx
  #clock
  #onWrite
  #logger
  #buffers = new Map()
  #queue = Promise.resolve()
  #callsToday = 0
  #day = ''
  #disposed = false
  #abort = new AbortController()

  /**
   * @param {{ store: import('./store.js').MemoryStore, index: import('./search.js').MemoryIndex, config: object,
   *   ctx: object, clock?: () => number, onWrite?: () => void, logger?: object }} options
   */
  constructor(options) {
    this.#store = options.store
    this.#index = options.index
    this.#config = options.config
    this.#ctx = options.ctx
    this.#clock = typeof options.clock === 'function' ? options.clock : () => Date.now()
    this.#onWrite = typeof options.onWrite === 'function' ? options.onWrite : () => {}
    this.#logger = options.logger
  }

  /** Replace the live config so panel settings apply without a restart. */
  setConfig(config) {
    if (config !== null && typeof config === 'object') this.#config = config
  }

  /** Feed one session event. Buffering is cheap; extraction is scheduled on turn/end. */
  observe(session, event) {
    if (this.#disposed || session === undefined || event === undefined) return
    const sessionId = typeof session.id === 'string' ? session.id : undefined
    if (sessionId === undefined) return
    if (event.type === 'user/message') {
      const text = textOfContent(event.data?.content)
      if (text !== '') this.#push(session, 'user', text)
      return
    }
    if (event.type === 'assistant/message') {
      const text = textOfContent(event.data?.message?.content)
      if (text !== '') this.#push(session, 'assistant', text)
      return
    }
    if (event.type === 'turn/end') {
      const buffered = this.#buffers.get(sessionId)
      this.#buffers.delete(sessionId)
      if (buffered === undefined || buffered.messages.length === 0) return
      this.#schedule(session, buffered.messages, event.data?.reason)
    }
  }

  /** Abort any in-flight extraction; buffered turns are dropped. */
  dispose() {
    this.#disposed = true
    this.#abort.abort()
    this.#buffers.clear()
  }

  /** Await the current extraction chain (tests and graceful shutdown). */
  flush() {
    return this.#queue
  }

  #push(session, role, text) {
    const sessionId = session.id
    let buffer = this.#buffers.get(sessionId)
    if (buffer === undefined) {
      buffer = { messages: [], chars: 0, extracts: 0 }
      this.#buffers.set(sessionId, buffer)
    }
    const message = { role, text: truncate(text, MAX_MESSAGE_CHARS) }
    buffer.messages.push(message)
    buffer.chars += message.text.length
    while (buffer.messages.length > MAX_BUFFER_MESSAGES || (buffer.chars > 60000 && buffer.messages.length > 1)) {
      const dropped = buffer.messages.shift()
      buffer.chars -= dropped.text.length
    }
    // Very long turns are captured in segments before turn/end, so context
    // compaction or an interrupted turn cannot lose the early exchanges.
    if (buffer.chars >= INCREMENTAL_CHARS && buffer.extracts < MAX_INCREMENTAL_PER_TURN) {
      const prefix = buffer.messages.slice()
      if (this.#schedule(session, prefix, undefined)) {
        buffer.messages = []
        buffer.chars = 0
        buffer.extracts += 1
      }
    }
  }

  #schedule(session, messages, reason) {
    if (!this.#config.capture.enabled) return false
    if (reason !== undefined && reason?.kind !== 'completed') return false
    const llm = this.#getLlm()
    if (llm === undefined) return false

    const transcript = messages.map((message) => `${message.role === 'user' ? '用户' : '助手'}：${message.text}`).join('\n\n')
    const explicit = messages.some((message) => message.role === 'user' && EXPLICIT_MEMORY_PATTERN.test(message.text))
    if (transcript.length < this.#config.capture.minTurnChars && !explicit) return false
    if (!explicit && !this.#admitCall()) {
      this.#logger?.warn?.('[dsh-memory] capture budget exhausted for today; skipping extraction')
      return false
    }

    this.#queue = this.#queue
      .then(() => this.#run(session, messages, transcript, explicit))
      .catch((error) => {
        this.#logger?.warn?.(`[dsh-memory] capture failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    return true
  }

  #admitCall() {
    const day = new Date(this.#clock()).toISOString().slice(0, 10)
    if (day !== this.#day) {
      this.#day = day
      this.#callsToday = 0
    }
    if (this.#callsToday >= this.#config.capture.maxCallsPerDay) return false
    this.#callsToday += 1
    return true
  }

  async #run(session, messages, transcript, explicit) {
    if (this.#disposed) return
    const cwd = typeof session.header?.cwd === 'string' ? session.header.cwd : undefined
    if (cwd === undefined) return
    const identity = projectIdentity(cwd)
    const route = await this.#resolveRoute(session)
    if (route === undefined) {
      this.#logger?.warn?.('[dsh-memory] no LLM route available; skipping extraction')
      return
    }
    const scopes = [{ scope: 'global', projectKey: null }, { scope: 'project', projectKey: identity.key }]
    const maxChars = Math.max(6000, (this.#config.extraction.maxInputTokens ?? 12000) * 2)
    const chunks = chunkMessages(messages, maxChars)
    const selected = chunks.slice(0, MAX_EXTRACTION_CHUNKS)
    if (chunks.length > selected.length) {
      this.#logger?.warn?.(`[dsh-memory] turn too long for one extraction (${chunks.length} chunks); extracting the first ${selected.length}`)
    }
    const items = []
    let calls = 0
    for (const chunk of selected) {
      if (calls > 0 && !explicit && !this.#admitCall()) {
        this.#logger?.warn?.('[dsh-memory] capture budget exhausted mid-turn; remaining chunks skipped')
        break
      }
      calls += 1
      const chunkTranscript = chunk.map((entry) => entry.line).join('\n\n')
      const lastUser = [...chunk].reverse().find((entry) => entry.message.role === 'user')?.message.text ?? ''
      const existing = this.#index.search(lastUser, {
        statuses: ['active', 'candidate'],
        projectKey: identity.key,
        scopes: ['project', 'global'],
        now: this.#clock(),
        limit: 10,
      }).map((hit) => hit.record)
      const prompt = buildExtractionPrompt({ transcript: chunkTranscript, existing, now: this.#clock() })
      const text = await this.#collect(route, prompt)
      if (this.#disposed) return
      const parsed = parseExtraction(text)
      if (parsed.items.length > 0) items.push(...parsed.items)
    }
    if (items.length === 0) {
      this.#logger?.info?.('[dsh-memory] extraction: nothing to store')
      return
    }
    const applied = this.#apply(items, { scopes, identity, session, explicit })
    if (applied > 0) this.#logger?.info?.(`[dsh-memory] captured ${applied} memory item(s) for ${identity.key}`)
  }

  #getLlm() {
    try {
      return this.#ctx.get('llm')
    } catch {
      return undefined
    }
  }

  async #resolveRoute(session) {
    const extraction = this.#config.extraction
    const explicit = extraction.provider !== null && extraction.model !== null
      ? { provider: extraction.provider, model: extraction.model }
      : undefined
    if (explicit !== undefined) {
      return { ...explicit, ...(await this.#effortFor(explicit.provider, explicit.model, extraction.reasoningEffort)) }
    }
    let header
    try {
      header = session.requestHeader?.()?.config
    } catch {
      header = undefined
    }
    if (header !== undefined && typeof header.provider === 'string' && typeof header.model === 'string') {
      return { provider: header.provider, model: header.model, ...(await this.#effortFor(header.provider, header.model, extraction.reasoningEffort)) }
    }
    let selection
    try {
      selection = this.#ctx.get('agentDefaultModel')?.currentSelection?.()
    } catch {
      selection = undefined
    }
    if (selection !== undefined && typeof selection.provider === 'string' && typeof selection.model === 'string') {
      return { provider: selection.provider, model: selection.model, ...(await this.#effortFor(selection.provider, selection.model, extraction.reasoningEffort)) }
    }
    return undefined
  }

  async #effortFor(provider, model, configured) {
    if (typeof configured === 'string' && configured !== '') return { reasoningEffort: configured }
    const llm = this.#getLlm()
    try {
      const info = await llm.resolveModelInfo(provider, model, this.#abort.signal)
      const offered = new Set((info?.reasoning?.efforts ?? []).map((effort) => effort.id))
      const picked = LOW_EFFORT_ORDER.find((id) => offered.has(id))
      return picked === undefined ? {} : { reasoningEffort: picked }
    } catch {
      return {}
    }
  }

  async #collect(route, prompt) {
    const llm = this.#getLlm()
    let text = ''
    let finish
    for await (const chunk of llm.stream({
      provider: route.provider,
      model: route.model,
      ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      maxTokens: this.#config.extraction.maxOutputTokens,
      signal: this.#abort.signal,
    })) {
      if (chunk.type === 'text-delta') text += chunk.text
      else if (chunk.type === 'finish') finish = chunk.reason
    }
    if (finish?.kind !== 'stop') throw new Error(`extraction stream ended with ${finish?.kind ?? 'missing-finish'}`)
    return text
  }

  /** Fold a near-identical statement into the existing record (same kind and scope). */
  #findSimilar(record) {
    const scopes = [{ scope: record.scope, projectKey: record.projectKey ?? null }]
    const strict = record.kind === 'preference' || record.kind === 'decision'
    const threshold = strict ? PREFERENCE_SIMILARITY_THRESHOLD : SIMILARITY_THRESHOLD
    const minRatio = strict ? 0.75 : 0.6
    let best
    let bestScore = threshold
    let conflictBest
    let conflictScore = CONFLICT_SIMILARITY_THRESHOLD
    for (const scope of scopes) {
      for (const existing of this.#store.list(scope.scope, scope.projectKey)) {
        if (existing.status !== 'active' && existing.status !== 'candidate') continue
        if (existing.kind !== record.kind) continue
        const shorter = Math.min(existing.content.length, record.content.length)
        const longer = Math.max(existing.content.length, record.content.length)
        if (longer === 0 || shorter / longer < minRatio) continue
        const score = similarity(existing.content, record.content)
        if (score >= bestScore) {
          best = existing
          bestScore = score
        } else if (score >= CONFLICT_SIMILARITY_THRESHOLD && conflictBest === undefined && conflictingValues(existing.content, record.content)) {
          conflictBest = existing
          conflictScore = score
        }
      }
    }
    if (best === undefined && conflictBest !== undefined) {
      return { record: conflictBest, mode: 'supersede' }
    }
    if (best === undefined) return undefined
    if (conflictingValues(best.content, record.content)) {
      return { record: best, mode: 'supersede' }
    }
    return { record: best, mode: 'merge' }
  }

  #apply(items, { scopes, identity, session, explicit }) {
    const now = this.#clock()
    const seen = new Map()
    for (const scope of scopes) {
      for (const record of this.#store.list(scope.scope, scope.projectKey)) seen.set(record.contentHash, record)
    }
    let applied = 0
    for (const item of items) {
      const scope = item.kind === 'preference' && item.scope !== 'project' ? 'global' : item.scope === 'global' ? 'global' : 'project'
      const target = item.targetId === null ? undefined : this.#store.find(item.targetId, scopes)
      if (item.op === 'SUPERSEDE' && target !== undefined) {
        const superseded = this.#store.update(target.id, { status: 'superseded' }, scopes)
        if (superseded !== undefined) this.#index.upsert(superseded)
      }
      if (item.op === 'UPDATE' && target !== undefined) {
        const updated = this.#store.update(target.id, {
          content: item.content,
          tags: item.tags,
          ...(item.topic === null || item.topic === undefined ? {} : { topic: item.topic }),
          confidence: item.confidence,
          importance: item.importance,
          observedAt: now,
        }, scopes)
        if (updated !== undefined) {
          this.#index.upsert(updated)
          seen.set(updated.contentHash, updated)
          applied += 1
        }
        continue
      }
      const built = buildRecord({
        kind: item.kind,
        scope,
        projectKey: scope === 'project' ? identity.key : null,
        content: item.content,
        topic: item.topic,
        tags: item.tags,
        sourceRefs: [{ sessionId: session.id }],
        confidence: explicit ? Math.max(item.confidence, 0.8) : item.confidence,
        importance: explicit ? Math.max(item.importance, 0.7) : item.importance,
        validFrom: item.validFrom,
        validTo: item.validTo,
        supersedesId: item.op === 'SUPERSEDE' && target !== undefined ? target.id : null,
      }, { now, autoApproveConfidence: this.#config.capture.autoApproveConfidence })
      if (built.ok !== true) {
        this.#logger?.warn?.(`[dsh-memory] dropped candidate: ${built.reason}`)
        continue
      }
      if (seen.has(built.record.contentHash)) continue
      const similar = this.#findSimilar(built.record)
      if (similar !== undefined && similar.mode === 'supersede') {
        const superseded = this.#store.update(similar.record.id, { status: 'superseded', validTo: now }, scopes)
        if (superseded !== undefined) this.#index.upsert(superseded)
        const replacement = { ...built.record, supersedesId: similar.record.id }
        this.#store.append(replacement)
        this.#index.upsert(replacement)
        seen.set(replacement.contentHash, replacement)
        applied += 1
        continue
      }
      if (similar !== undefined) {
        const merged = this.#store.update(similar.record.id, {
          content: built.record.content.length > similar.record.content.length ? built.record.content : similar.record.content,
          tags: [...new Set([...(Array.isArray(similar.record.tags) ? similar.record.tags : []), ...built.record.tags])],
          confidence: Math.min(1, Math.max(similar.record.confidence, built.record.confidence) + 0.05),
          importance: Math.max(similar.record.importance, built.record.importance),
          observedAt: now,
        }, scopes)
        if (merged !== undefined) {
          this.#index.upsert(merged)
          seen.set(merged.contentHash, merged)
          applied += 1
          continue
        }
      }
      this.#store.append(built.record)
      this.#index.upsert(built.record)
      seen.set(built.record.contentHash, built.record)
      applied += 1
    }
    if (applied > 0) this.#onWrite()
    return applied
  }
}
