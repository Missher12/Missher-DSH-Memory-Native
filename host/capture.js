/**
 * Automatic capture pipeline with a durable source/task journal.
 *
 * Every allowed user/assistant message is written to `capture/sources` before it
 * can be lost; each extraction segment becomes a persistent task keyed by a
 * deterministic id. Long turns are split without truncating or dropping text,
 * and every segment gets a task — even when today's call budget is exhausted, in
 * which case the task stays `pending` instead of pretending success.
 *
 * A model request is marked `requested` before it is sent and `completed` only
 * after a terminal chunk; a crash or transport error in between becomes
 * `unknown` and is never retried automatically. Tasks are applied with evidence
 * refs and a `captureKey`, so replaying a task cannot duplicate a memory.
 *
 * @module dsh-memory/host/capture
 */

import { MAX_MEMORIES_PER_PASS, buildExtractionPrompt, parseExtraction } from './extract.js'
import {
  captureJournalHealth,
  captureStorageStatus,
  compressCaptureSources,
  captureTaskIdOf,
  compactCaptureLedgers,
  countCaptureTasks,
  readCaptureTasks,
  readTurnIntakes,
  recoverCaptureTasks,
  reconcileReplacements,
  saveSource,
  readSource,
  canReadSource,
  turnIdOf,
  updateCaptureTask,
  updateTurnIntake,
  writeCaptureTask,
  writeTurnIntake,
} from './capture-journal.js'
import { projectIdentity } from './paths.js'
import { estimateTokens } from './recall.js'
import { buildRecord, contentHashOf, mergeSourceRefs } from './records.js'
import { tokenize } from './tokenize.js'
import { analyzeUserMessageControls } from './user-controls.js'
import { grantSourceRecall } from './source-passages.js'
import { readRecallSelection, readRecallSelections, recallSelectionId, writeRecallSelection } from './recall-journal.js'
import { buildRecallSelectionPrompt } from './recall-selection.js'

const SIMILARITY_THRESHOLD = 0.9
const PREFERENCE_SIMILARITY_THRESHOLD = 0.85
const CONFLICT_SIMILARITY_THRESHOLD = 0.7
const EXPLICIT_MEMORY_PATTERN = /记住|记一下|记下这个|别忘|以后都|从现在起|remember (?:this|that)|don'?t forget|from now on/iu
const LOW_EFFORT_ORDER = ['off', 'none', 'minimal', 'low']
const MAX_EVIDENCE_EXCERPT = 240

// Short confirmed decisions qualify for normal (budgeted) capture. Only a
// direct assertion counts; questions, hypotheticals and opt-outs still skip.
function isOrdinaryDecision(source) {
  if (!isDirectUserSource(source) || memoryOptOut(source)) return false
  return (source.text.match(/[^。！？!?\n]+[？?]?/gu) ?? []).some(sentence =>
    !/(?:如果|假如|要不要|是否|能不能|要是|可能|打个比方|假设|吗\s*$|[？?]|should we|what if)/iu.test(sentence) &&
    /(?:我(?:们)?(?:已)?决定|我们(?:就|改用)|定为|改为|改成|改到|改在|从今(?:起|以后)|以后(?:都|统一)|先(?:别|不)(?:升|改|迁移)|we decided|we(?:'ll| will) (?:switch|use))/iu.test(sentence))
}

// Use enclosing sentences so an extractor cannot quote "升级" out of
// "不要升级". Offsets refer to the stored original JS string (UTF-16).
function locateSourceSentence(entry, needle) {
  const { source, from, to } = entry
  const start = source.text.indexOf(needle, from)
  if (start < from || start + needle.length > to || source.text.indexOf(needle, start + 1) >= 0 ||
      source.text.indexOf(needle) !== start) return null
  const end = start + needle.length
  const boundary = /[。！？!?；;\n]|\.(?=\s|$)/gu
  let left = 0, right = source.text.length
  for (const match of source.text.matchAll(boundary)) {
    if (match.index + 1 <= start) left = match.index + 1
    else if (match.index >= end - 1) { right = match.index + 1; break }
  }
  while (left < start && /\s/u.test(source.text[left])) left++
  if (left < from || right > to || right - left > MAX_EVIDENCE_EXCERPT) return null
  return { from: left, to: right, excerpt: source.text.slice(left, right) }
}
const MIN_CONTINUATION_CHARS = 1200
const MAX_CONTINUATION_DEPTH = 4
const MAX_COMPLETION_ROUNDS = 2
const RECOVERY_OUTPUT_TOKENS = 4096

function emptyCapacityResult(task) {
  return task.callState === 'completed' && !String(task.resultText ?? '').trim() &&
    (['max-tokens', 'length'].includes(task.resultFinishKind) || /输出预算耗尽且无可用文本/u.test(task.reason ?? ''))
}

function sameRoute(a, b) {
  return a?.provider === b?.provider && a?.model === b?.model && a?.reasoningEffort === b?.reasoningEffort
}

function memoryOptOut(source) {
  if (!isDirectUserSource(source)) return false
  const head = source.text.slice(0, 600)
  return analyzeUserMessageControls(head).noSaveDirective ||
    (/虚构(?:测试|验收)?(?:材料|资料)/u.test(head) && /测试|验收/u.test(head) && !EXPLICIT_MEMORY_PATTERN.test(head))
}

function textOfContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
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

/** Shared-token coverage of a statement against a source segment. */
function coverage(statement, source) {
  const a = new Set(tokenize(statement))
  if (a.size === 0) return { ratio: 0, shared: 0 }
  const b = new Set(tokenize(source))
  let shared = 0
  for (const token of a) if (b.has(token)) shared += 1
  return { ratio: shared / a.size, shared }
}

function hasEvidenceMatch(value) {
  return value.shared >= 2 && value.ratio >= 0.08
}

/** A user question that merely shares topic words cannot confirm a value. */
function hasDirectUserSupport(statement, source) {
  const value = coverage(statement, source)
  if (!hasEvidenceMatch(value)) return false
  const sourceText = String(source ?? '').toLowerCase()
  for (const entity of entitiesOf(statement)) {
    if (!sourceText.includes(entity.toLowerCase())) return false
  }
  const literals = text => [...text.matchAll(/\d+(?:[.:：]\d+)*(?:\s*(?:毫秒|秒钟?|分钟|小时|天|个月|年|次|mib|gib|mb|gb|ms|%))?/giu)]
    .map(match => match[0].replace(/\s+/gu, '').replace(/：/gu, ':').toLowerCase())
  const available = literals(sourceText)
  for (const value of literals(statement)) {
    if (!available.some(sourceValue => sourceValue === value ||
        (/^[\d.:]+$/u.test(value) && sourceValue.match(/^[\d.:]+/u)?.[0] === value))) return false
  }
  return true
}

const NEGATION_PATTERN = /(?:不|没|别|勿|禁止|never|\bnot\b|\bno\b)/iu

function entitiesOf(text) {
  return new Set(String(text ?? '').match(/\b[A-Za-z][A-Za-z0-9_.-]{1,}\b/gu) ?? [])
}

function differentNamedServices(left, right) {
  const names = text => [...String(text).matchAll(/(?:服务|实例|集群)\s*[-:：]?\s*([A-Za-z][\w-]*)|\b([A-Za-z][\w-]*)\s*(?:服务|实例|集群)/giu)]
    .map(match => (match[1] ?? match[2]).toLowerCase())
  const a = names(left), b = names(right)
  return a.length > 0 && b.length > 0 && !a.some(name => b.includes(name))
}

function disjointEntities(left, right) {
  if (differentNamedServices(left, right)) return true
  const a = entitiesOf(left)
  const b = entitiesOf(right)
  if (a.size === 0 || b.size === 0) return false
  for (const value of a) if (b.has(value)) return false
  return true
}

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

function dayKey(ms) {
  const date = new Date(ms)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function nextDayStart(ms) {
  const date = new Date(ms)
  date.setHours(24, 0, 0, 0)
  return date.getTime()
}

// Older receipts used UTC dates. Interpret their original call timestamp;
// never reset an already-spent allowance merely because the plugin upgraded.
function receiptDay(day, at, calendar) {
  return calendar !== 'local' && Number.isFinite(at) && new Date(at).toISOString().slice(0, 10) === day
    ? dayKey(at) : day
}

function combineSignals(...signals) {
  const active = signals.filter(signal => signal !== null && typeof signal === 'object' &&
    typeof signal.addEventListener === 'function' && typeof signal.aborted === 'boolean')
  if (active.length <= 1) return active[0]
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(active)
  const controller = new AbortController()
  for (const signal of active) {
    if (signal.aborted) controller.abort(signal.reason)
    else signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true })
  }
  return controller.signal
}

// Explicit/manual calls bypass the automatic allowance. Preserve automatic
// calls separately so a later manual retry cannot erase their budget usage.
function automaticBudget(task) {
  if (typeof task.automaticCallDay === 'string' && Number.isInteger(task.automaticCalls)) {
    return { day: receiptDay(task.automaticCallDay, task.automaticCallAt ?? task.lastCallAt, task.budgetReservation?.calendar),
      calls: Math.max(0, task.automaticCalls) }
  }
  return typeof task.lastCallAt === 'number' && !task.explicit && !task.manual
    ? { day: dayKey(task.lastCallAt), calls: 1 }
    : { day: null, calls: 0 }
}

/** Normalize provider usage without inventing zeros for missing fields. */
function normalizeUsage(value) {
  if (value === null || typeof value !== 'object') return null
  const pick = (...names) => {
    for (const name of names) {
      const candidate = value[name]
      if (Number.isInteger(candidate) && candidate >= 0) return candidate
    }
    return undefined
  }
  const input = pick('inputTokens', 'input_tokens', 'promptTokens', 'prompt_tokens')
  const output = pick('outputTokens', 'output_tokens', 'completionTokens', 'completion_tokens')
  const total = pick('totalTokens', 'total_tokens')
  if (input === undefined && output === undefined && total === undefined) return null
  return {
    ...(input === undefined ? {} : { inputTokens: input }),
    ...(output === undefined ? {} : { outputTokens: output }),
    ...(total === undefined ? {} : { totalTokens: total }),
  }
}

/**
 * Split source messages into segment entries without truncating text.
 * Each entry records the source id plus a character range into that source.
 */
export function segmentSources(root, sources, maxChars) {
  const limit = Math.max(1000, Number.isInteger(maxChars) ? maxChars : 8000)
  const segments = []
  let current = []
  let size = 0
  const flush = () => {
    if (current.length > 0) {
      segments.push(current)
      current = []
      size = 0
    }
  }
  for (const ref of sources) {
    const source = readSource(root, ref.sourceId)
    if (source === null) continue
    let offset = 0
    while (offset < source.text.length) {
      const room = Math.max(500, limit - size - 64)
      let end = Math.min(source.text.length, offset + room)
      // Prefer a newline boundary to keep an entry readable, without dropping text.
      if (end < source.text.length) {
        const newline = source.text.lastIndexOf('\n', end)
        if (newline > offset + 100) end = newline + 1
      }
      const entry = {
        sourceId: source.id,
        sessionId: source.sessionId,
        messageId: source.messageId ?? null,
        role: source.role,
        at: source.at,
        from: offset,
        to: end,
        text: source.text.slice(offset, end),
      }
      const lineChars = sourceIdLine(entry).length + 2
      if (current.length > 0 && size + lineChars > limit) flush()
      current.push(entry)
      size += lineChars
      offset = end
    }
  }
  flush()
  return segments
}

function sourceLabel(source) {
  if (source.role === 'assistant') return '助手'
  if (source.sourceKind === 'user') return '用户'
  return `内部上下文（${source.sourceKind ?? 'unknown'}）`
}

/** Only native user messages are confirming evidence; internal user-role rows are not. */
function isDirectUserSource(source) {
  return source.role === 'user' && (source.sourceKind === 'user' || source.sourceKind === 'unknown')
}

function isModelEvidenceSource(entry) {
  return !memoryOptOut(entry.source) && (isDirectUserSource(entry.source) || entry.source.role === 'assistant')
}

function sourceIdLine(entry) {
  return `[${entry.sourceId}] ${sourceLabel(entry)}：${entry.text}`
}

/** Split a task's covered source ranges into two contiguous children. */
function splitRanges(entries) {
  const total = entries.reduce((sum, entry) => sum + (entry.to - entry.from), 0)
  if (total < MIN_CONTINUATION_CHARS * 2) return null
  const target = Math.floor(total / 2)
  const left = []
  const right = []
  let seen = 0
  let split = false
  for (const entry of entries) {
    const length = entry.to - entry.from
    if (split) {
      right.push({ ...entry })
      continue
    }
    if (seen + length <= target) {
      left.push({ ...entry })
      seen += length
      continue
    }
    const cut = target - seen
    if (cut > 0) left.push({ ...entry, to: entry.from + cut })
    if (entry.from + cut < entry.to) right.push({ ...entry, from: entry.from + cut })
    split = true
    seen += length
  }
  if (left.length === 0 || right.length === 0) return null
  return [left, right]
}

export class CapturePipeline {
  #store
  #index
  #config
  #ctx
  #clock
  #onWrite
  #logger
  #onExtraction
  #onUsage
  #buffers = new Map()
  #queue = Promise.resolve()
  #draining = null
  #resuming = null
  #selectionCalls = new Map()
  #callsToday = 0
  #day = ''
  #disposed = false
  #abort = new AbortController()
  #budgetTimer = null
  #budgetWakeAt = null

  constructor(options) {
    this.#store = options.store
    this.#index = options.index
    this.#config = options.config
    this.#ctx = options.ctx
    this.#clock = typeof options.clock === 'function' ? options.clock : () => Date.now()
    this.#onWrite = typeof options.onWrite === 'function' ? options.onWrite : () => {}
    this.#logger = options.logger
    this.#onExtraction = typeof options.onExtraction === 'function' ? options.onExtraction : () => {}
    this.#onUsage = typeof options.onUsage === 'function' ? options.onUsage : () => {}
    const root = this.#store?.root
    if (typeof root === 'string' && root !== '') {
      recoverCaptureTasks(root)
      const reconciled = reconcileReplacements(root, this.#store, this.#clock())
      for (const record of reconciled) this.#index.upsert(record)
      const today = dayKey(this.#clock())
      this.#day = today
      const extractionCalls = readCaptureTasks(root).reduce((total, task) => {
        const usage = automaticBudget(task)
        return total + (usage.day === today ? usage.calls : 0)
      }, 0)
      const recallCalls = readRecallSelections(root, today).reduce((total, task) => {
        const reservation = task.budgetReservation
        const day = receiptDay(reservation?.day ?? task.automaticCallDay ?? null, reservation?.at ?? task.requestedAt, reservation?.calendar)
        const calls = Number.isInteger(reservation?.calls) ? reservation.calls :
          Number.isInteger(task.automaticCalls) ? task.automaticCalls : 0
        if (reservation?.state === 'released' || task.callState === 'not-sent') return total
        return total + (day === today ? Math.max(0, calls) : 0)
      }, 0)
      this.#callsToday = extractionCalls + recallCalls
    }
  }

  setConfig(config) {
    if (config !== null && typeof config === 'object') {
      const changed = config.capture.enabled !== this.#config.capture.enabled ||
        config.capture.maxCallsPerDay !== this.#config.capture.maxCallsPerDay
      this.#config = config
      if (changed) this.#scheduleDrain()
    }
  }

  /** One bounded, journaled evidence-selection request for a real user turn. */
  async selectRecall(input = {}) {
    const root = this.#store?.root
    const sessionId = typeof input.session?.id === 'string' ? input.session.id : ''
    const id = recallSelectionId(sessionId, input.turnKey)
    if (typeof root !== 'string' || id === null) return { state: 'not-sent', callState: 'not-sent', usage: null, resultText: '' }
    const inflight = this.#selectionCalls.get(id)
    if (inflight) return inflight
    const request = this.#selectRecallOnce(root, id, input)
    this.#selectionCalls.set(id, request)
    try {
      return await request
    } finally {
      if (this.#selectionCalls.get(id) === request) this.#selectionCalls.delete(id)
    }
  }

  async #selectRecallOnce(root, id, input) {
    const previous = readRecallSelection(root, id)
    if (previous !== null) {
      if (previous.callState === 'requested') {
        const unknown = { ...previous, state: 'unknown', callState: 'unknown', updatedAt: this.#clock(),
          reason: '上次选择请求已发送但没有可用回执；不会自动重试' }
        writeRecallSelection(root, unknown)
        return { ...unknown, reused: true }
      }
      return { ...previous, state: previous.state ?? previous.callState, reused: true }
    }

    if (input.signal?.aborted === true) {
      return { state: 'not-sent', callState: 'not-sent', route: null, usage: null, resultText: '' }
    }

    let route
    try { route = await this.#resolveRecallRoute(input.session, input.modelSelection) } catch { route = undefined }
    const llm = this.#getLlm()
    if (input.signal?.aborted === true || route === undefined || typeof llm?.stream !== 'function') {
      return { state: 'not-sent', callState: 'not-sent', route: null, usage: null, resultText: '' }
    }
    const promptLimit = Math.min(4000, this.#config.extraction.maxInputTokens)
    const built = buildRecallSelectionPrompt({
      query: input.query,
      slots: input.slots,
      candidates: input.candidates,
      maxInputTokens: promptLimit,
    })
    if (built.candidates.length === 0 || built.slots.length === 0 || built.promptTokens > promptLimit) {
      return { state: 'not-sent', callState: 'not-sent', route, usage: null, resultText: '', promptTokens: built.promptTokens }
    }
    // Some current-host models count reasoning against the output cap too.
    // Respect a smaller user limit, but do not hard-truncate them at 800.
    const maxTokens = Math.min(4096, this.#config.extraction.maxOutputTokens)
    if (input.signal?.aborted === true) {
      return { state: 'not-sent', callState: 'not-sent', route, usage: null, resultText: '', promptTokens: built.promptTokens }
    }
    const reservation = this.#reserveCall(built.promptTokens, maxTokens)
    if (reservation === null) {
      return { state: 'not-sent', callState: 'not-sent', route, usage: null, resultText: '',
        promptTokens: built.promptTokens, reason: '今日提取调用预算已用尽' }
    }
    const requested = {
      id, state: 'requested', callState: 'requested', route, requestedAt: this.#clock(),
      promptTokens: built.promptTokens, maxTokens,
      budgetReservation: { ...reservation, state: 'reserved' },
      slotKeys: built.slots,
      candidateRefs: built.candidates.map(candidate => ({ id: candidate.id, revision: candidate.revision })),
    }
    try {
      writeRecallSelection(root, requested)
    } catch (error) {
      this.#releaseCall(reservation)
      return { state: 'not-sent', callState: 'not-sent', route, usage: null, resultText: '',
        promptTokens: built.promptTokens, reason: `选择回执无法保存，未发送请求：${error instanceof Error ? error.message : String(error)}` }
    }
    if (input.signal?.aborted === true) {
      this.#releaseCall(reservation)
      const receipt = {
        ...requested, state: 'not-sent', callState: 'not-sent', completedAt: this.#clock(), resultText: '', usage: null,
        budgetReservation: { ...requested.budgetReservation, state: 'released', calls: 0 },
        reason: '请求发送前，本轮已取消',
      }
      writeRecallSelection(root, receipt)
      return receipt
    }
    let result = null
    try {
      result = await this.#collect(route, built.prompt, maxTokens, input.signal)
      const state = result.finishKind === 'stop' && result.truncated !== true ? 'completed' : 'failed'
      const completedAt = this.#clock()
      const usage = normalizeUsage(result.usage)
      const receipt = {
        ...requested, state, callState: 'completed', resultText: String(result.text ?? '').slice(0, 16000),
        finishKind: result.finishKind ?? null, usage,
        budgetReservation: this.#settledReservation(reservation, usage),
        completedAt, reason: state === 'completed' ? null : '模型选择输出未完整结束；不会自动重试',
      }
      writeRecallSelection(root, receipt)
      this.#recordUsage({ at: completedAt, promptTokens: built.promptTokens, usage, outcome: state })
      return receipt
    } catch (error) {
      if (error?.notSent === true) {
        this.#releaseCall(reservation)
        const receipt = {
          ...requested, state: 'not-sent', callState: 'not-sent', completedAt: this.#clock(), resultText: '', usage: null,
          budgetReservation: { ...requested.budgetReservation, state: 'released', calls: 0 },
          reason: '请求发送前，本轮已取消',
        }
        writeRecallSelection(root, receipt)
        return receipt
      }
      const completed = error?.completed === true || result !== null
      const usage = normalizeUsage(error?.usage) ?? normalizeUsage(result?.usage)
      const selectionCompleted = result?.finishKind === 'stop' && result?.truncated !== true
      const state = selectionCompleted ? 'completed' : completed ? 'failed' : 'unknown'
      const completedAt = completed ? this.#clock() : null
      const receipt = {
        ...requested, state, callState: completed ? 'completed' : 'unknown',
        resultText: String(result?.text ?? '').slice(0, 16000),
        finishKind: result?.finishKind ?? error?.finishKind ?? null, usage,
        budgetReservation: completed ? this.#settledReservation(reservation, usage) : requested.budgetReservation,
        completedAt,
        reason: selectionCompleted ? null : completed ? `模型已结束但选择输出不可用：${error instanceof Error ? error.message : String(error)}`
          : `模型选择回执未知：${error instanceof Error ? error.message : String(error)}；不会自动重试`,
      }
      writeRecallSelection(root, receipt)
      this.#recordUsage({ at: completedAt ?? this.#clock(), promptTokens: built.promptTokens, usage, outcome: state })
      return receipt
    }
  }

  /** Feed one session event. Full text is journaled before it can be lost. */
  observe(session, event) {
    if (this.#disposed || session === undefined || event === undefined) return
    const sessionId = typeof session.id === 'string' ? session.id : undefined
    if (sessionId === undefined) return
    if (event.type === 'user/message') {
      const text = textOfContent(event.data?.content)
      if (text !== '') this.#push(session, event, 'user', text)
      return
    }
    if (event.type === 'assistant/message') {
      const text = textOfContent(event.data?.message?.content)
      if (text !== '') this.#push(session, event, 'assistant', text)
      return
    }
    if (event.type === 'turn/end') {
      const buffered = this.#buffers.get(sessionId)
      this.#buffers.delete(sessionId)
      if (buffered === undefined || buffered.sources.length === 0) return
      if (event.data?.reason?.kind !== 'completed') return
      try {
        this.#acceptTurn(session, buffered.sources)
      } catch (error) {
        this.#logger?.warn?.(`[dsh-memory] turn intake not persisted: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  /** Abort the in-flight request; journaled sources and tasks survive. */
  dispose() {
    this.#disposed = true
    clearTimeout(this.#budgetTimer)
    this.#budgetTimer = null
    this.#budgetWakeAt = null
    this.#abort.abort()
    this.#buffers.clear()
  }

  /** Await the extraction chain and drain any pending journaled tasks. */
  async flush() {
    await this.#queue
    await this.#processPendingIntakes()
    await this.#drain()
  }

  /** Resume pending turn intakes and tasks after a plugin restart or timer tick. */
  async resume() {
    if (this.#resuming !== null) return this.#resuming
    this.#resuming = (async () => {
      await this.#processPendingIntakes()
      await this.#drain()
    })()
    try {
      await this.#resuming
    } finally {
      this.#resuming = null
    }
  }

  /** Panel/status view: task counts without exposing source text. */
  status() {
    const root = this.#store?.root
    if (typeof root !== 'string') return { counts: countCaptureTasks([]), tasks: [] }
    const allTasks = readCaptureTasks(root)
    const tasks = allTasks.slice(-200).map((task) => ({
      id: task.id,
      status: task.status,
      callState: task.callState,
      segmentIndex: task.segment?.index ?? null,
      total: task.segment?.total ?? null,
      attempts: task.attempts ?? 0,
      parentTaskId: task.parentTaskId ?? null,
      continuationTaskIds: task.continuationTaskIds ?? [],
      recoveryOf: task.recoveryOf ?? null,
      reason: task.reason ?? null,
      waitReason: task.waitReason ?? null,
      resumeAt: task.status === 'pending' ? task.resumeAt ?? null : null,
      updatedAt: task.updatedAt ?? null,
    }))
    const intakes = readTurnIntakes(root)
    const health = captureJournalHealth(root)
    return {
      counts: countCaptureTasks(allTasks),
      tasks,
      budget: this.#budgetStatus(allTasks),
      health,
      degraded: health.corruptTasks > 0 || intakes.corrupt > 0,
      storage: captureStorageStatus(root),
      intakes: {
        total: intakes.intakes.length,
        pending: intakes.intakes.filter((intake) => intake.status === 'pending').length,
        corrupt: intakes.corrupt,
      },
    }
  }

  /** Transparent source compression + ledger compaction; never deletes user原文. */
  maintain(options = {}) {
    const root = this.#store?.root
    if (typeof root !== 'string') return { pruned: null, storage: null }
    // User message originals are evidence, not garbage: compress them losslessly
    // and keep their ids. Only ledgers are compacted (latest revision per id).
    const compressed = compressCaptureSources(root)
    const compacted = compactCaptureLedgers(root)
    return { pruned: null, compressed: { ...compressed, compacted }, storage: captureStorageStatus(root) }
  }

  /** Explicit retry for an unknown/failed task; never called automatically. */
  retry(taskId, options = {}) {
    const root = this.#store?.root
    if (typeof root !== 'string') return { ok: false, reason: 'storage unavailable' }
    const task = readCaptureTasks(root).find((entry) => entry.id === taskId)
    if (task === undefined) return { ok: false, reason: 'task not found' }
    if (task.status === 'running') return { ok: false, reason: 'task is still running' }
    if (task.status === 'done') return { ok: false, reason: 'task already finished' }
    if (task.status === 'unknown' && options.confirmUnknown !== true) {
      return { ok: false, reason: 'unknown result needs confirmUnknown=true before retrying' }
    }
    const previousBudget = automaticBudget(task)
    if ((task.automaticCallDay === undefined || task.automaticCallAt === undefined) && previousBudget.calls > 0) {
      updateCaptureTask(root, taskId, { automaticCallDay: previousBudget.day, automaticCalls: previousBudget.calls,
        automaticCallAt: task.automaticCallAt ?? task.lastCallAt })
    }
    const partial = task.status === 'partial' || task.partial === true
    if (partial && Array.isArray(task.continuationTaskIds) && task.continuationTaskIds.length > 0) {
      const retried = this.#retryOpenChildren(root, task, new Set())
      this.#scheduleDrain()
      return { ok: true, id: taskId, continuation: true, retried }
    }
    if (partial && emptyCapacityResult(task)) {
      if (task.recoveryOf) return { ok: false, reason: '增大输出额度后仍无正文；请先修正宿主模型配置，不能继续重复收费' }
      // Keep the old paid receipt immutable; a deterministic child represents
      // the explicit, changed-capacity attempt on just this unfinished range.
      const outputTokenLimit = Math.min(32000, Math.max(RECOVERY_OUTPUT_TOKENS, (task.requestMaxTokens ?? 800) * 4, this.#config.extraction.maxOutputTokens))
      if (outputTokenLimit <= (task.requestMaxTokens ?? 800)) return { ok: false, reason: '已达到输出额度上限，请先修正模型配置' }
      const id = captureTaskIdOf({ sessionId: task.sessionId, turnKey: `${task.id}:capacity-recovery`, segmentIndex: 0, sourceIds: task.sourceIds, total: 1 })
      if (!readCaptureTasks(root).some(entry => entry.id === id)) writeCaptureTask(root, {
        id, sessionId: task.sessionId, projectKey: task.projectKey,
        turnKey: `${task.id}:capacity-recovery`, parentTaskId: task.id, recoveryOf: task.id,
        segment: task.segment, sourceIds: task.sourceIds, route: task.route,
        appliedContents: this.#appliedContents(task), outputTokenLimit,
        status: 'pending', callState: 'not-sent', attempts: 0, manual: true,
        reason: '显式恢复已确认无正文的缺失范围，保留旧调用回执', createdAt: this.#clock(),
      })
      updateCaptureTask(root, taskId, { continuationTaskIds: [id], retryAt: this.#clock() })
      this.#scheduleDrain()
      return { ok: true, id: taskId, continuationTaskIds: [id], recovery: true }
    }
    // A completed saved truncated result must be replayed locally (and split by
    // the normal apply path), never cleared and re-sent as the whole parent.
    const savedTruncated = task.resultTruncated === true && typeof task.resultText === 'string' &&
      task.resultText.trim() !== '' && task.callState === 'completed'
    if (savedTruncated) {
      updateCaptureTask(root, taskId, {
        status: 'pending',
        callState: 'completed',
        reason: 'local replay of the saved truncated result; no parent request re-sent',
        retryAt: this.#clock(),
        manual: true,
        completion: true,
        replay: true,
      })
      this.#scheduleDrain()
      return { ok: true, id: taskId, replay: true }
    }
    if (partial) {
      const retryTask = { ...task, manual: true, appliedContents: this.#appliedContents(task) }
      const continuation = this.#scheduleContinuations(retryTask, task.segment?.entries ?? [])
      if (continuation.length > 0) {
        updateCaptureTask(root, taskId, { continuationTaskIds: continuation, manual: true, retryAt: this.#clock() })
        this.#scheduleDrain()
        return { ok: true, id: taskId, continuation: true, continuationTaskIds: continuation }
      }
      const completion = this.#scheduleCompletion(retryTask, task.segment?.entries ?? [], this.#appliedContents(task))
      if (completion.length > 0) {
        updateCaptureTask(root, taskId, { continuationTaskIds: completion, manual: true, retryAt: this.#clock() })
        this.#scheduleDrain()
        return { ok: true, id: taskId, completion: true, continuationTaskIds: completion }
      }
      return { ok: false, reason: '已达有界补全上限或没有可用范围；保留旧结果，不重复付费重发' }
    }
    const clearStoredResult = partial || task.resultParseFailed === true || !String(task.resultText ?? '')
    updateCaptureTask(root, taskId, {
      status: 'pending',
      callState: clearStoredResult ? 'not-sent' : 'completed',
      reason: partial ? 'manual completion of a partial extraction' : 'manual retry requested',
      retryAt: this.#clock(),
      manual: true,
      waitReason: null,
      resumeAt: null,
      completion: partial,
      ...(clearStoredResult
        ? { resultText: undefined, resultTruncated: undefined, resultUsage: undefined, resultParseFailed: undefined, replay: false }
        : { replay: true }),
    })
    this.#scheduleDrain()
    return { ok: true, id: taskId }
  }

  /** Recover already-paid item texts for a bounded completion prompt. */
  #appliedContents(task) {
    if (Array.isArray(task.appliedContents)) {
      return [...new Set(task.appliedContents.filter((item) => typeof item === 'string' && item.trim() !== ''))].slice(0, 20)
    }
    try {
      const parsed = parseExtraction(String(task.resultText ?? ''))
      return [...new Set(parsed.items.map((item) => item.content))].slice(0, 20)
    } catch {
      return []
    }
  }

  /** Bounded "missing only" pass for a dense segment that cannot be split further. */
  #scheduleCompletion(task, entries, appliedContents) {
    const root = this.#store?.root
    if (typeof root !== 'string') return []
    const tasks = readCaptureTasks(root)
    let depth = task.completionDepth ?? 0
    // Old versions spent completion rounds on empty output. Discount those
    // proven-empty ancestors once; new children carry the normalized budget.
    if (task.completionBudgetVersion !== 1 && depth > 0) {
      const seen = new Set()
      let parent = tasks.find(entry => entry.id === task.parentTaskId)
      while (parent?.completionOf && !seen.has(parent.id)) {
        seen.add(parent.id)
        if (emptyCapacityResult(parent)) depth = Math.max(0, depth - 1)
        parent = tasks.find(entry => entry.id === parent.parentTaskId)
      }
    }
    if (depth >= MAX_COMPLETION_ROUNDS) return []
    const ranges = entries.map((entry) => ({ sourceId: entry.sourceId, from: entry.from, to: entry.to }))
    if (ranges.length === 0) return []
    const sourceIds = [...new Set(ranges.map((entry) => entry.sourceId))]
    const id = captureTaskIdOf({
      sessionId: task.sessionId,
      turnKey: `${task.id}:completion${depth + 1}`,
      segmentIndex: 0,
      sourceIds,
      total: 1,
    })
    if (!tasks.some((entry) => entry.id === id)) {
      writeCaptureTask(root, {
        id,
        sessionId: task.sessionId,
        projectKey: task.projectKey,
        turnKey: `${task.id}:completion${depth + 1}`,
        parentTaskId: task.id,
        completionOf: task.completionOf ?? task.id,
        completionDepth: depth + 1,
        completionBudgetVersion: 1,
        completion: true,
        outputTokenLimit: task.outputTokenLimit,
        appliedContents: [...new Set([...appliedContents, ...(task.appliedContents ?? [])])].slice(0, 20),
        segment: { index: 0, total: 1, entries: ranges },
        sourceIds,
        status: 'pending',
        callState: 'not-sent',
        attempts: 0,
        explicit: task.explicit === true,
        manual: task.manual === true,
        route: task.route ?? null,
        reason: '有界遗漏补全',
        createdAt: this.#clock(),
      })
    }
    return [id]
  }

  /** Retry only unfinished descendants of a partial parent; never re-send done work. */
  #retryOpenChildren(root, task, seen) {
    if (seen.has(task.id)) return 0
    seen.add(task.id)
    let touched = 0
    const tasks = readCaptureTasks(root)
    for (const childId of Array.isArray(task.continuationTaskIds) ? task.continuationTaskIds : []) {
      const child = tasks.find((entry) => entry.id === childId)
      if (child === undefined || ['done', 'skipped', 'running', 'unknown'].includes(child.status)) continue
      if (Array.isArray(child.continuationTaskIds) && child.continuationTaskIds.length > 0) {
        touched += this.#retryOpenChildren(root, child, seen)
        continue
      }
      // Use the same paid-result/completion rules as a direct leaf retry.
      if (this.retry(child.id).ok) touched += 1
    }
    return touched
  }

  #push(session, event, role, text) {
    if (!this.#config.capture.enabled) return
    const root = this.#store?.root
    if (typeof root !== 'string') return
    const now = this.#clock()
    const message = role === 'user' ? event.data : event.data?.message
    const messageId = typeof message?.id === 'string' ? message.id : null
    const sourceKind = typeof message?.source?.kind === 'string' ? message.source.kind : 'unknown'
    const sourceForm = typeof message?.source?.form === 'string' ? message.source.form : undefined
    let source
    try {
      source = saveSource(root, {
        sessionId: session.id,
        messageId,
        projectKey: typeof session.header?.cwd === 'string' ? projectIdentity(session.header.cwd).key : null,
        sourceKind,
        sourceForm,
        eventSeq: event.seq,
        eventTime: event.time,
        role,
        at: now,
        text,
      })
    } catch (error) {
      this.#logger?.warn?.(`[dsh-memory] source not persisted: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    let buffer = this.#buffers.get(session.id)
    if (buffer === undefined) {
      buffer = { sources: [] }
      this.#buffers.set(session.id, buffer)
    }
    buffer.sources.push({ ...source, sourceId: source.id })
  }

  #acceptTurn(session, sources) {
    if (this.#disposed) return
    const root = this.#store?.root
    if (typeof root !== 'string') return
    const cwd = typeof session.header?.cwd === 'string' ? session.header.cwd : undefined
    if (cwd === undefined) return
    const sourceRecords = sources.map((source) => readSource(root, source.sourceId)).filter((source) => source !== null)
    if (sourceRecords.length === 0) return
    const chars = sourceRecords.reduce((sum, source) => sum + source.text.length, 0)
    const explicit = sourceRecords.some((source) => source.role === 'user' && source.sourceKind === 'user' && EXPLICIT_MEMORY_PATTERN.test(source.text))
    const noSave = sourceRecords.some((source) =>
      source.role === 'user' && source.sourceKind === 'user' && analyzeUserMessageControls(source.text).noSaveDirective)
    const identity = projectIdentity(cwd)
    const id = turnIdOf({ sessionId: session.id, sourceIds: sourceRecords.map((source) => source.id) })
    const existing = readTurnIntakes(root).intakes.find((intake) => intake.id === id && intake.status !== 'failed')
    if (existing !== undefined) return
    const skipped = !this.#config.capture.enabled
      ? 'capture disabled'
      : noSave
        ? '明确要求不保存当前问答，已跳过提炼'
        : chars < this.#config.capture.minTurnChars && !explicit && !sourceRecords.some(isOrdinaryDecision) ? 'turn shorter than capture.minTurnChars' : null
    const intake = writeTurnIntake(root, {
      id,
      sessionId: session.id,
      projectKey: identity.key,
      cwd,
      sourceIds: sourceRecords.map((source) => source.id),
      chars,
      explicit,
      route: this.#routeFromSession(session),
      status: skipped === null ? 'pending' : 'skipped',
      reason: skipped,
      createdAt: this.#clock(),
    })
    // Source retrieval is independent of extraction quota, but uses the same
    // completed-turn consent. Never retroactively authorize old journal files.
    if (this.#config.capture.enabled && !noSave) {
      for (const source of sourceRecords) {
        try { if (!memoryOptOut(source)) grantSourceRecall(root, source, identity.key) }
        catch (error) { this.#logger?.warn?.(`[dsh-memory] source indexing grant failed: ${error.message}`) }
      }
    }
    if (intake.status === 'pending') this.#enqueueIntake(intake)
  }

  /** Synchronous route hint from the session header; never invents a provider. */
  #routeFromSession(session) {
    const extraction = this.#config.extraction
    if (extraction.provider !== null && extraction.model !== null) {
      return { provider: extraction.provider, model: extraction.model }
    }
    try {
      const header = session.requestHeader?.()?.config
      if (header !== undefined && typeof header.provider === 'string' && typeof header.model === 'string') {
        return { provider: header.provider, model: header.model }
      }
    } catch {
      // Fall through to the default route at processing time.
    }
    return null
  }

  #enqueueIntake(intake) {
    this.#queue = this.#queue
      .then(() => this.#processIntake(intake))
      .catch((error) => {
        this.#logger?.warn?.(`[dsh-memory] capture scheduling failed: ${error instanceof Error ? error.message : String(error)}`)
      })
  }

  async #processPendingIntakes() {
    const root = this.#store?.root
    if (typeof root !== 'string') return
    const { intakes } = readTurnIntakes(root)
    for (const intake of intakes) {
      if (intake.status !== 'pending') continue
      await this.#processIntake(intake)
    }
  }

  async #processIntake(intake) {
    if (this.#disposed) return
    if (!this.#config.capture.enabled) return
    const root = this.#store?.root
    if (typeof root !== 'string') return
    const sources = intake.sourceIds.map((id) => ({ sourceId: id }))
    const maxChars = Math.max(4000, Math.min(16000, Math.round((this.#config.extraction.maxInputTokens ?? 12000) * 1.33)))
    const segments = segmentSources(root, sources, maxChars)
    if (segments.length === 0) {
      updateTurnIntake(root, intake.id, { status: 'failed', reason: '来源原文无法回读' })
      return
    }
    for (let index = 0; index < segments.length; index += 1) {
      const entries = segments[index]
      const id = captureTaskIdOf({
        sessionId: intake.sessionId,
        turnKey: intake.id,
        segmentIndex: index,
        sourceIds: entries.map((entry) => entry.sourceId),
        total: segments.length,
      })
      if (readCaptureTasks(root).some((task) => task.id === id)) continue
      writeCaptureTask(root, {
        id,
        sessionId: intake.sessionId,
        projectKey: intake.projectKey,
        turnKey: intake.id,
        segment: {
          index,
          total: segments.length,
          entries: entries.map((entry) => ({ sourceId: entry.sourceId, from: entry.from, to: entry.to })),
        },
        sourceIds: [...new Set(entries.map((entry) => entry.sourceId))],
        status: 'pending',
        callState: 'not-sent',
        attempts: 0,
        explicit: intake.explicit === true,
        route: intake.route ?? null,
        reason: intake.route === null ? '模型路由暂不可用' : null,
        createdAt: this.#clock(),
      })
    }
    updateTurnIntake(root, intake.id, { status: 'done', reason: null })
    await this.#drain()
  }

  async #drain() {
    if (this.#disposed) return
    if (this.#draining !== null) return this.#draining
    const root = this.#store?.root
    if (typeof root !== 'string') return
    this.#draining = (async () => {
      this.#settleAll(root)
      const processed = new Set()
      for (;;) {
        if (this.#disposed) return
        const task = readCaptureTasks(root).find((entry) => entry.status === 'pending' && !processed.has(entry.id))
        if (task === undefined) break
        processed.add(task.id)
        try {
          await this.#processTask(task)
        } catch (error) {
          // A journal write or unexpected error must not escape into the turn.
          this.#logger?.warn?.(`[dsh-memory] capture task ${task.id} failed: ${error instanceof Error ? error.message : String(error)}`)
          try {
            updateCaptureTask(root, task.id, {
              status: 'failed',
              reason: `任务处理异常：${error instanceof Error ? error.message : String(error)}；请检查后重试`,
            })
          } catch {
            // The journal itself may be unavailable; keep the turn alive.
          }
        }
      }
      this.#settleAll(root)
    })()
    try {
      await this.#draining
    } finally {
      this.#draining = null
      this.#scheduleBudgetWake()
    }
  }

  #scheduleDrain() {
    this.#queue = this.#queue.then(() => this.#drain()).catch(() => {})
  }

  async #processTask(task) {
    const root = this.#store?.root
    if (typeof root !== 'string') return
    if (!this.#config.capture.enabled) return
    if (['unknown', 'requested'].includes(task.callState)) {
      updateCaptureTask(root, task.id, { status: 'unknown', callState: 'unknown',
        reason: '已有请求但没有可核验的完成回执，不自动重发' })
      return
    }
    if (typeof task.resultText === 'string') {
      await this.#replayStoredResult(task)
      return
    }
    // Polls and ordinary turns must not rebuild the same prompt or append the
    // same wait revision while the allowance is still exhausted.
    if (task.waitReason === 'daily-budget' && !task.explicit && !task.manual && this.#budgetExhausted()) {
      this.#deferBudget(task)
      return
    }
    let route = task.route
    if (route === null || route === undefined) {
      route = await this.#defaultRoute()
      if (route === undefined) {
        updateCaptureTask(root, task.id, { status: 'pending', reason: '模型路由暂不可用' })
        return
      }
      updateCaptureTask(root, task.id, { route })
    }
    if (route.reasoningEffort === undefined) {
      const effort = await this.#effortFor(route.provider, route.model, this.#config.extraction.reasoningEffort)
      if (effort.reasoningEffort !== undefined) {
        route = { ...route, ...effort }
        updateCaptureTask(root, task.id, { route })
      }
    }
    if (!this.#config.capture.enabled) return
    const explicit = task.explicit === true
    const entries = []
    for (const ref of task.segment.entries) {
      const source = readSource(root, ref.sourceId)
      if (source === null) {
        updateCaptureTask(root, task.id, { status: 'failed', callState: 'not-sent', reason: '来源原文无法回读，未发送模型请求' })
        return
      }
      entries.push({ ...ref, source })
    }
    const modelEntries = entries.filter(isModelEvidenceSource)
    const forgottenSources = this.#deletedSourceIds()
    if (entries.some((entry) => forgottenSources.has(entry.source.id) || !canReadSource(root, entry.source.id))) {
      updateCaptureTask(root, task.id, {
        status: 'skipped',
        callState: 'not-sent',
        reason: '来源已随用户遗忘进入 tombstone，后台任务不再提炼',
      })
      return
    }
    // Internal context (runtime/skill/memory/tool/bridge/time) is useful
    // context but is not user-authored evidence. Do not spend a model request
    // on a segment that contains no direct user message.
    const hasUserEvidence = modelEntries.some((entry) => isDirectUserSource(entry.source))
    if (!hasUserEvidence) {
      updateCaptureTask(root, task.id, {
        status: 'skipped',
        callState: 'not-sent',
        reason: entries.some(entry => memoryOptOut(entry.source))
          ? '明确不保存或仅供验收的虚构资料，来源保留但不提炼；未请求模型'
          : '该段仅含内部上下文或桥接/助手内容，没有用户直接证据；未请求模型',
      })
      return
    }
    const transcript = modelEntries.map((entry) => {
      const text = entry.source.text.slice(entry.from, entry.to)
      const stamp = typeof entry.source.at === 'number' && Number.isFinite(entry.source.at)
        ? new Date(entry.source.at).toISOString()
        : '时间未知'
      return `[${entry.source.id}] ${sourceLabel(entry.source)}（来源时间 ${stamp}）：${text}`
    }).join('\n\n')
    // A later range still needs the bounded beginning of the same user message:
    // otherwise a tail of neutral filler loses the original "remember this"
    // intent. This context is explanatory only and never evidence.
    const contextBySource = new Map()
    for (const entry of modelEntries) {
      if (entry.from <= 0 || contextBySource.has(entry.source.id)) continue
      contextBySource.set(entry.source.id, {
        sourceId: entry.source.id,
        role: entry.source.role,
        sourceKind: entry.source.sourceKind,
        text: entry.source.text.slice(0, 600),
      })
    }
    const context = [...contextBySource.values()]
    const lastUser = [...modelEntries].reverse().find((entry) => isDirectUserSource(entry.source))
    const lastUserText = lastUser === undefined ? '' : lastUser.source.text.slice(lastUser.from, lastUser.to)
    const identity = { key: task.projectKey }
    const sourceIds = new Set(modelEntries.map((entry) => entry.source.id))
    const sameSource = (this.#store?.listAll() ?? [])
      .filter((record) => (record.status === 'active' || record.status === 'candidate') &&
        (record.scope === 'global' || record.projectKey === identity.key) &&
        (Array.isArray(record.sourceRefs) ? record.sourceRefs : []).some((ref) => sourceIds.has(ref.sourceId)))
      .slice(0, 6)
    const searched = this.#index.search(lastUserText, {
      statuses: ['active', 'candidate'],
      projectKey: identity.key,
      scopes: ['project', 'global'],
      now: this.#clock(),
      limit: 10,
    }).map((hit) => hit.record)
    const seenExisting = new Set()
    const existing = []
    for (const record of [...sameSource, ...searched]) {
      if (seenExisting.has(record.id)) continue
      seenExisting.add(record.id)
      existing.push(record)
    }
    let prompt
    try {
      prompt = buildExtractionPrompt({
        transcript,
        existing,
        context,
        explicit: task.explicit === true,
        applied: Array.isArray(task.appliedContents) ? task.appliedContents : [],
        now: this.#clock(),
      })
    } catch (error) {
      updateCaptureTask(root, task.id, { status: 'failed', callState: 'not-sent', reason: `提示词构建失败: ${error instanceof Error ? error.message : String(error)}` })
      return
    }
    const promptTokens = estimateTokens(prompt)
    const routeTasks = readCaptureTasks(root).filter(entry => sameRoute(entry.route, route) && entry.lastCallAt !== undefined)
    const latest = routeTasks.reduce((last, entry) => !last || entry.lastCallAt >= last.lastCallAt ? entry : last, null)
    // The cap includes provider reasoning on some routes, even when the host
    // advertises "off". Reuse headroom that actually produced a complete reply.
    const provenLimit = routeTasks.reduce((limit, entry) => entry.resultFinishKind === 'stop' && entry.status === 'done'
      ? Math.max(limit, entry.requestMaxTokens ?? 0) : limit, 0)
    const maxTokens = Math.min(32000, Math.max(task.outputTokenLimit ?? 0, provenLimit,
      this.#config.extraction.maxOutputTokens * (task.completion === true || task.completionDepth > 0 ? 2 : 1)))
    if (latest && emptyCapacityResult(latest) && maxTokens <= (latest.requestMaxTokens ?? 800)) {
      updateCaptureTask(root, task.id, { status: 'pending', callState: 'not-sent', reason: '同模型输出额度耗尽且无正文，暂停连续调用；请先恢复失败段或修正模型配置' })
      return
    }
    const automaticReservation = !explicit && task.manual !== true
      ? this.#reserveCall(promptTokens, maxTokens)
      : null
    if (!explicit && task.manual !== true && automaticReservation === null) {
      this.#deferBudget(task)
      return
    }
    const budget = automaticBudget(task)
    const callDay = automaticReservation?.day ?? dayKey(this.#clock())
    try {
      updateCaptureTask(root, task.id, {
        status: 'running',
        callState: 'requested',
        attempts: (task.attempts ?? 0) + 1,
        lastCallAt: this.#clock(),
        startedAt: this.#clock(),
        requestMaxTokens: maxTokens,
        promptTokens,
        reason: null,
        waitReason: null,
        resumeAt: null,
        ...(automaticReservation === null ? {} : {
          automaticCallDay: callDay,
          automaticCallAt: automaticReservation.at,
          automaticCalls: (budget.day === callDay ? budget.calls : 0) + 1,
          budgetReservation: { ...automaticReservation, state: 'reserved' },
        }),
      })
    } catch (error) {
      this.#releaseCall(automaticReservation)
      throw error
    }
    let result
    try {
      result = await this.#collect(route, prompt, maxTokens)
    } catch (error) {
      // A stream that ended with a terminal but unusable reason is a known
      // failure; a transport drop after the request was sent is unknown.
      if (error?.completed === true) {
        const receipt = { resultFinishKind: error.finishKind, resultUsage: error.usage ?? null,
          reasoningChars: error.reasoningChars ?? 0, promptTokens, transcriptChars: transcript.length, completedAt: this.#clock(),
          ...(automaticReservation === null ? {} : {
            budgetReservation: this.#settledReservation(automaticReservation, normalizeUsage(error.usage)),
          }) }
        // No text means splitting input has demonstrated no progress. Stop this
        // route rather than spending the daily allowance on an empty tree.
        if (error.finishKind === 'max-tokens' || error.finishKind === 'length') {
          updateCaptureTask(root, task.id, {
            ...receipt,
            status: 'partial',
            callState: 'completed',
            reason: '输出预算耗尽且无可用文本，已暂停连续调用；可显式增大额度恢复缺失段',
          })
        } else updateCaptureTask(root, task.id, {
          ...receipt,
          status: 'failed',
          callState: 'completed',
          reason: `模型已结束但输出不可用：${error instanceof Error ? error.message : String(error)}；不会自动重试`,
        })
        this.#onExtraction({ at: this.#clock(), taskId: task.id, promptTokens, estimatedPromptTokens: promptTokens,
          transcriptChars: transcript.length, chunks: 1, calls: 1, truncated: ['max-tokens', 'length'].includes(error.finishKind) ? 1 : 0,
          items: 0, applied: 0, rejected: 0, usage: receipt.resultUsage, status: ['max-tokens', 'length'].includes(error.finishKind) ? 'partial' : 'failed' })
        return
      }
      // The request may have reached the provider. Keep the task for an explicit
      // human decision instead of silently charging again.
      updateCaptureTask(root, task.id, {
        status: 'unknown',
        callState: 'unknown',
        reason: `模型提取结果未知：${error instanceof Error ? error.message : String(error)}；请确认后手动重试`,
      })
      this.#logger?.warn?.('[dsh-memory] extraction result unknown; task left for explicit retry')
      this.#onExtraction({
        at: this.#clock(),
        taskId: task.id,
        promptTokens,
        estimatedPromptTokens: promptTokens,
        transcriptChars: transcript.length,
        chunks: 1,
        calls: 1,
        truncated: 0,
        items: 0,
        applied: 0,
        rejected: 0,
        usage: null,
        status: 'unknown',
      })
      return
    }
    if (this.#disposed) return
    // Persist the paid result before any parse/apply step. If the process dies
    // here, recovery replays this text locally instead of calling the model.
    updateCaptureTask(root, task.id, {
      callState: 'completed',
      reason: null,
      resultText: result.text,
      resultTruncated: result.truncated === true,
      resultUsage: result.usage ?? null,
      resultFinishKind: result.finishKind,
      reasoningChars: result.reasoningChars,
      promptTokens,
      transcriptChars: transcript.length,
      ...(automaticReservation === null ? {} : {
        budgetReservation: this.#settledReservation(automaticReservation, normalizeUsage(result.usage)),
      }),
    })
    await this.#applyStoredResult(task, result.text, {
      truncated: result.truncated === true,
      usage: result.usage ?? null,
    }, entries, { promptTokens, transcriptChars: transcript.length, calls: 1 })
  }

  async #replayStoredResult(task) {
    const root = this.#store?.root
    if (typeof root !== 'string') return
    const entries = []
    for (const ref of task.segment?.entries ?? []) {
      const source = readSource(root, ref.sourceId)
      if (source === null) {
        updateCaptureTask(root, task.id, { status: 'failed', callState: 'completed', reason: '已保存结果无法重放：来源原文不可读；不会重发模型请求' })
        return
      }
      entries.push({ ...ref, source })
    }
    if (entries.some(entry => memoryOptOut(entry.source)) &&
        !entries.some(entry => isDirectUserSource(entry.source) && !memoryOptOut(entry.source))) {
      updateCaptureTask(root, task.id, { status: 'skipped', callState: 'completed',
        reason: '来源不允许保存记忆，保留已付费回执但不应用；未重发模型请求' })
      return
    }
    await this.#applyStoredResult(task, task.resultText, {
      truncated: task.resultTruncated === true,
      usage: task.resultUsage ?? null,
    }, entries, {
      promptTokens: task.promptTokens ?? 0,
      transcriptChars: task.transcriptChars ?? 0,
      calls: 0,
      replayed: true,
    })
  }

  async #applyStoredResult(task, resultText, meta, entries, info) {
    const root = this.#store?.root
    if (typeof root !== 'string') return
    if (entries.some(entry => !canReadSource(root, entry.source.id))) {
      updateCaptureTask(root, task.id, { status: 'skipped', callState: 'completed',
        reason: '原文已撤销检索授权，保留已付费结果但不再写入记忆',
        result: { items: 0, applied: 0, rejected: 0, truncated: false } })
      return
    }
    let parsed
    try {
      parsed = parseExtraction(resultText)
    } catch (error) {
      if (meta.truncated === true) {
        // A known truncated response may contain prose/reasoning but no complete
        // JSON (or no JSON at all). Preserve that paid result and split the
        // covered range instead of failing the whole extraction.
        let continuationTaskIds = this.#scheduleContinuations(task, entries)
        if (continuationTaskIds.length === 0) continuationTaskIds = this.#scheduleCompletion(task, entries, this.#appliedContents(task))
        updateCaptureTask(root, task.id, {
          status: 'partial',
          callState: 'completed',
          reason: continuationTaskIds.length > 0
            ? `输出已截断且没有可解析条目，已应用 0 条并创建 ${continuationTaskIds.length} 个有界补全/子段任务`
            : '输出已截断且没有可解析条目，已到有界补全上限；保留真实 partial 状态',
          result: { items: 0, applied: 0, rejected: 0, truncated: true },
          continuationTaskIds,
          promptTokens: info.promptTokens,
          transcriptChars: info.transcriptChars,
          completedAt: this.#clock(),
        })
        this.#onExtraction({
          at: this.#clock(),
          taskId: task.id,
          promptTokens: info.promptTokens,
          estimatedPromptTokens: info.promptTokens,
          transcriptChars: info.transcriptChars,
          chunks: 1,
          calls: info.calls ?? 0,
          truncated: 1,
          items: 0,
          applied: 0,
          rejected: 0,
          usage: meta.usage ?? null,
          replayed: info.replayed === true,
          status: 'partial',
        })
        return
      }
      updateCaptureTask(root, task.id, {
        status: 'failed',
        callState: 'completed',
        resultParseFailed: true,
        reason: `模型已返回但结果无法解析：${error instanceof Error ? error.message : String(error)}；不会自动重试`,
      })
      return
    }
    const scopeInfo = {
      grants: [],
      scopes: [{ scope: 'global', projectKey: null }, { scope: 'project', projectKey: task.projectKey }],
      identity: { key: task.projectKey },
      session: { id: task.sessionId },
      entries,
      task,
    }
    let applied = 0
    let rejected = 0
    try {
      const appliedResult = this.#apply(parsed.items, scopeInfo)
      applied = appliedResult.applied
      rejected = appliedResult.rejected
    } catch (error) {
      updateCaptureTask(root, task.id, {
        status: 'failed',
        callState: 'completed',
        reason: `写入失败：${error instanceof Error ? error.message : String(error)}；旧记录保持有效，不会自动重试`,
      })
      return
    }
    const hitCap = parsed.items.length >= MAX_MEMORIES_PER_PASS
    // complete:true is authoritative even with exactly four items. Provider
    // truncation always wins; old results without a marker stay conservative.
    const unresolved = meta.truncated === true || parsed.complete === false ||
      (parsed.complete === undefined && hitCap)
    const appliedContents = [...new Set([
      ...this.#appliedContents(task),
      ...parsed.items.map((item) => item.content),
    ])].slice(0, 20)
    let continuationTaskIds = unresolved ? this.#scheduleContinuations({ ...task, appliedContents }, entries) : []
    if (unresolved && continuationTaskIds.length === 0) {
      const noProgress = applied === 0 && task.completionOf !== undefined
      if (!noProgress) continuationTaskIds = this.#scheduleCompletion(task, entries, appliedContents)
    }
    const partial = unresolved
    updateCaptureTask(root, task.id, {
      status: partial ? 'partial' : 'done',
      callState: 'completed',
      reason: partial
        ? continuationTaskIds.length > 0
          ? `输出未完整（截断/complete=false 或旧 4 条上限），已应用 ${applied} 条并创建 ${continuationTaskIds.length} 个有界补全/子段任务`
          : applied === 0 && task.completionOf !== undefined
            ? '补全轮无进展，停止自动补全并保留真实 partial 状态'
            : '输出未完整且已到有界补全上限/无法拆分；保留真实 partial 状态'
        : null,
      result: { items: parsed.items.length, applied, rejected, truncated: partial, complete: parsed.complete ?? null },
      sourceGrants: [...(task.sourceGrants ?? []), ...scopeInfo.grants],
      appliedContents,
      continuationTaskIds,
      promptTokens: info.promptTokens,
      transcriptChars: info.transcriptChars,
      completedAt: this.#clock(),
    })
    this.#onExtraction({
      at: this.#clock(),
      taskId: task.id,
      promptTokens: info.promptTokens,
      estimatedPromptTokens: info.promptTokens,
      transcriptChars: info.transcriptChars,
      chunks: 1,
      calls: info.calls ?? 0,
      truncated: partial ? 1 : 0,
      items: parsed.items.length,
      applied,
      rejected,
      usage: meta.usage ?? null,
      replayed: info.replayed === true,
      status: partial ? 'partial' : 'done',
    })
    if (applied > 0) {
      this.#logger?.info?.(`[dsh-memory] captured ${applied} memory item(s) for ${task.projectKey}`)
      this.#onWrite()
    }
  }

  /** Mark partial parents done only when every direct child is done. */
  #settleAll(root) {
    for (let pass = 0; pass < 32; pass += 1) {
      const tasks = readCaptureTasks(root)
      const byId = new Map(tasks.map((task) => [task.id, task]))
      let changed = false
      for (const parent of tasks) {
        if (parent.status !== 'partial') continue
        const children = Array.isArray(parent.continuationTaskIds) ? parent.continuationTaskIds : []
        if (children.length === 0) continue
        if (!children.every((id) => ['done', 'skipped'].includes(byId.get(id)?.status))) continue
        updateCaptureTask(root, parent.id, {
          status: 'done',
          callState: 'completed',
          reason: '所有子段已覆盖完成',
          completedAt: this.#clock(),
        })
        changed = true
      }
      if (!changed) return
    }
  }

  /** Create durable child tasks for the two halves of a capped/truncated range. */
  #scheduleContinuations(task, entries, appliedContents = []) {
    if (Array.isArray(task.continuationTaskIds) && task.continuationTaskIds.length > 0) {
      return task.continuationTaskIds
    }
    if ((task.depth ?? 0) >= MAX_CONTINUATION_DEPTH) return []
    const halves = splitRanges(entries)
    if (halves === null) return []
    const root = this.#store?.root
    if (typeof root !== 'string') return []
    const existing = new Set(readCaptureTasks(root).map((entry) => entry.id))
    const ids = []
    for (let index = 0; index < halves.length; index += 1) {
      const ranges = halves[index].map((entry) => ({ sourceId: entry.sourceId, from: entry.from, to: entry.to }))
      const sourceIds = [...new Set(ranges.map((entry) => entry.sourceId))]
      const id = captureTaskIdOf({
        sessionId: task.sessionId,
        turnKey: `${task.id}:c${index}`,
        segmentIndex: 0,
        sourceIds,
        total: halves.length,
      })
      ids.push(id)
      if (existing.has(id)) continue
      writeCaptureTask(root, {
        id,
        sessionId: task.sessionId,
        projectKey: task.projectKey,
        turnKey: `${task.id}:c${index}`,
        parentTaskId: task.id,
        depth: (task.depth ?? 0) + 1,
        appliedContents: Array.isArray(task.appliedContents) ? [...task.appliedContents] : [],
        outputTokenLimit: task.outputTokenLimit,
        segment: { index, total: halves.length, entries: ranges },
        sourceIds,
        status: 'pending',
        callState: 'not-sent',
        attempts: 0,
        explicit: task.explicit === true,
        manual: task.manual === true,
        route: task.route ?? null,
        reason: null,
        createdAt: this.#clock(),
      })
    }
    return ids
  }

  #deletedSourceIds() {
    const ids = new Set()
    for (const record of this.#store.listAll({ includeDeleted: true })) {
      if (record.status !== 'deleted') continue
      for (const ref of Array.isArray(record.sourceRefs) ? record.sourceRefs : []) {
        if (typeof ref.sourceId === 'string') ids.add(ref.sourceId)
      }
    }
    return ids
  }

  #budgetExhausted() {
    const day = dayKey(this.#clock())
    if (day !== this.#day) {
      this.#day = day
      this.#callsToday = 0
    }
    return this.#callsToday >= this.#config.capture.maxCallsPerDay
  }

  #budgetStatus(tasks) {
    const exhausted = this.#budgetExhausted()
    const limit = this.#config.capture.maxCallsPerDay
    const waiting = tasks.filter(task => task.status === 'pending' && task.waitReason === 'daily-budget' && !task.manual && !task.explicit).length
    return { used: this.#callsToday, limit, remaining: Math.max(0, limit - this.#callsToday), waiting,
      resetAt: nextDayStart(this.#clock()),
      resumeAt: waiting > 0 && exhausted && limit > 0 && this.#config.capture.enabled ? nextDayStart(this.#clock()) : null }
  }

  #deferBudget(task) {
    const limit = this.#config.capture.maxCallsPerDay
    const patch = { status: 'pending', callState: 'not-sent', waitReason: 'daily-budget',
      resumeAt: limit > 0 ? nextDayStart(this.#clock()) : null,
      reason: limit > 0 ? '今日自动调用预算已用尽，本地时间零点自动继续' : '自动调用额度为 0；调整额度或显式恢复后继续' }
    if (Object.entries(patch).some(([key, value]) => task[key] !== value)) updateCaptureTask(this.#store.root, task.id, patch)
  }

  #scheduleBudgetWake() {
    const status = this.#budgetStatus(readCaptureTasks(this.#store.root))
    const at = this.#disposed ? null : status.resumeAt
    if (at === this.#budgetWakeAt) return
    clearTimeout(this.#budgetTimer)
    this.#budgetTimer = null
    this.#budgetWakeAt = at
    if (at === null) return
    this.#budgetTimer = setTimeout(() => {
      this.#budgetTimer = null
      this.#budgetWakeAt = null
      this.resume().catch(error => this.#logger?.warn?.(`[dsh-memory] budget resume failed: ${error.message}`))
    }, Math.max(1, at - this.#clock()))
    this.#budgetTimer.unref?.()
  }

  #reserveCall(promptTokens, outputTokens) {
    if (this.#budgetExhausted()) return null
    this.#callsToday += 1
    return {
      day: this.#day,
      at: this.#clock(),
      calendar: 'local',
      calls: 1,
      promptTokens,
      outputTokens,
      totalTokens: promptTokens + outputTokens,
    }
  }

  #releaseCall(reservation) {
    if (reservation?.day === this.#day && this.#callsToday > 0) this.#callsToday -= reservation.calls ?? 1
  }

  #settledReservation(reservation, usage) {
    const actualTokens = usage?.totalTokens ?? (
      Number.isInteger(usage?.inputTokens) && Number.isInteger(usage?.outputTokens)
        ? usage.inputTokens + usage.outputTokens
        : null
    )
    return { ...reservation, state: 'settled', usage: usage ?? null, actualTokens }
  }

  #recordUsage({ at, promptTokens, usage, outcome }) {
    try {
      this.#onUsage({ at, promptTokens, usage: usage ?? null, outcome, calls: 1, items: 0, applied: 0 })
    } catch {
      // Usage reporting is advisory and must never affect the host turn.
    }
  }

  #getLlm() {
    try {
      return this.#ctx.get('llm')
    } catch {
      return undefined
    }
  }

  async #defaultRoute() {
    let selection
    try {
      selection = this.#ctx.get('agentDefaultModel')?.currentSelection?.()
    } catch {
      selection = undefined
    }
    if (selection !== undefined && typeof selection.provider === 'string' && typeof selection.model === 'string') {
      return { provider: selection.provider, model: selection.model, ...(await this.#effortFor(selection.provider, selection.model, this.#config.extraction.reasoningEffort)) }
    }
    return undefined
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

  async #resolveRecallRoute(session, modelSelection) {
    if (typeof modelSelection?.provider === 'string' && modelSelection.provider !== '' &&
        typeof modelSelection.model === 'string' && modelSelection.model !== '') {
      return {
        provider: modelSelection.provider,
        model: modelSelection.model,
        ...(typeof modelSelection.reasoningEffort === 'string' && modelSelection.reasoningEffort !== ''
          ? { reasoningEffort: modelSelection.reasoningEffort }
          : {}),
      }
    }
    return this.#resolveRoute(session)
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

  async #collect(route, prompt, maxTokens, requestSignal = undefined) {
    const llm = this.#getLlm()
    const signal = combineSignals(this.#abort.signal, requestSignal)
    if (signal?.aborted === true) {
      const error = new Error('request aborted before provider call')
      error.name = 'AbortError'
      error.notSent = true
      throw error
    }
    let text = ''
    let finish
    let usage = null
    let reasoningChars = 0
    for await (const chunk of llm.stream({
      provider: route.provider,
      model: route.model,
      ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      maxTokens: maxTokens ?? this.#config.extraction.maxOutputTokens,
      signal,
    })) {
      if (chunk.type === 'text-delta') text += chunk.text
      else if (chunk.type === 'reasoning-delta') reasoningChars += String(chunk.text ?? '').length
      else if (chunk.type === 'finish') {
        finish = chunk.reason
        usage = normalizeUsage(chunk.usage) ?? usage
      } else if (chunk.type === 'usage') {
        usage = normalizeUsage(chunk.usage ?? chunk) ?? usage
      }
      if (chunk.usage !== undefined && chunk.type !== 'usage') usage = normalizeUsage(chunk.usage) ?? usage
    }
    if ((finish?.kind === 'length' || finish?.kind === 'max-tokens') && text.trim() !== '') {
      return { text, truncated: true, usage, finishKind: finish.kind, reasoningChars }
    }
    if (finish?.kind !== 'stop') {
      const error = new Error(`extraction stream ended with ${finish?.kind ?? 'missing-finish'}`)
      error.uncertain = true
      error.finishKind = finish?.kind ?? 'missing-finish'
      // A missing finish means the transport may still be in flight; any
      // terminal finish receipt (including length/max-tokens) is a known end.
      error.completed = finish !== undefined
      error.usage = usage
      error.reasoningChars = reasoningChars
      throw error
    }
    return { text, truncated: false, usage, finishKind: finish.kind, reasoningChars }
  }

  /** Fold a near-identical statement into the existing record (same kind/scope/topic). */
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
        // Same topic is required for automatic folding; different entities with
        // similar wording must not overwrite each other by similarity alone.
        if (record.topic !== null && existing.topic !== null && record.topic !== existing.topic) continue
        // Different named objects with the same kind must not be folded by
        // wording similarity alone (e.g. service A port vs service B port).
        if (disjointEntities(record.content, existing.content)) continue
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

  #evidenceFor(item, entries) {
    const explicitIds = Array.isArray(item.evidence) ? item.evidence.filter((id) => typeof id === 'string') : []
    // Internal user-role rows are audit context, never extraction evidence.
    const allowed = entries.filter(isModelEvidenceSource)
    const explicit = allowed.filter((entry) => explicitIds.includes(entry.source.id))
    // If the model explicitly cited only internal rows, do not fall back to a
    // different source that merely happens to share words.
    const candidates = explicitIds.length > 0 ? explicit : allowed
    const refFor = (entry, span) => ({
      sessionId: entry.source.sessionId, messageId: entry.source.messageId ?? undefined,
      sourceId: entry.source.id, role: entry.source.role,
      sourceKind: entry.source.sourceKind ?? 'unknown', sourceForm: entry.source.sourceForm,
      at: entry.source.at, ...span,
    })
    const quotes = item.quotes ?? []
    const precise = []
    for (const quote of quotes) {
      const entry = candidates.find(entry => entry.source.id === quote.sourceId && isDirectUserSource(entry.source) &&
        quote.text && entry.source.text.slice(entry.from, entry.to).includes(quote.text))
      if (!entry) continue
      const span = locateSourceSentence(entry, quote.text)
      if (span && !precise.some(ref => ref.sourceId === entry.source.id && ref.from === span.from))
        precise.push(refFor(entry, span))
    }
    const grounded = precise.map(ref => ref.excerpt).join(' ')
    if (precise.length && hasDirectUserSupport(item.content, grounded)) {
      return { refs: precise, role: 'user', grounded }
    }
    // Older stored results did not request quotes. Use a unique supporting
    // sentence when available, otherwise retain just the message reference.
    let best, span, bestScore = 0
    for (const entry of candidates) {
      const text = entry.source.text.slice(entry.from, entry.to)
      const direct = isDirectUserSource(entry.source)
      const score = coverage(item.content, text)
      if (!(direct ? hasDirectUserSupport(item.content, text) : hasEvidenceMatch(score)) || score.ratio <= bestScore) continue
      best = entry
      bestScore = score.ratio
      span = locateSourceSentence(entry, item.content)
      if (!span) {
        const matches = text.match(/[^。！？!?；;\n]+/gu) ?? []
        const supporting = matches.map(sentence => sentence.trim()).filter(sentence => sentence &&
          hasDirectUserSupport(item.content, sentence) && (matches.length === 1 || coverage(item.content, sentence).ratio >= 0.55))
        if (supporting.length === 1) span = locateSourceSentence(entry, supporting[0])
      }
    }
    if (!best) return { refs: [], role: 'unknown' }
    const role = isDirectUserSource(best.source) ? 'user' : best.source.role
    return { refs: [refFor(best, span)], role, grounded: span?.excerpt }
  }

  #apply(items, { scopes, identity, session, entries, task, grants }) {
    const now = this.#clock()
    const root = this.#store?.root
    // Finish any interrupted replacement before applying another pass, so a
    // local retry sees one effective record instead of two conflicting actives.
    const reconciled = reconcileReplacements(root, this.#store, now)
    for (const record of reconciled) this.#index.upsert(record)
    const all = this.#store.listAll({ includeDeleted: true })
    const scopeIdOf = (scope, projectKey) => scope === 'global' ? 'global' : `project:${projectKey}`
    const seenByScope = new Map()
    const deletedHashesByScope = new Map()
    const deletedSources = new Set()
    const captureKeys = new Set()
    const deletedIds = new Set()
    for (const record of all) {
      if (record.captureKey !== null && record.captureKey !== undefined) captureKeys.add(record.captureKey)
      const scopeId = scopeIdOf(record.scope, record.projectKey)
      if (record.status === 'deleted') {
        deletedIds.add(record.id)
        if (!deletedHashesByScope.has(scopeId)) deletedHashesByScope.set(scopeId, new Map())
        const deletedAt = Math.max(record.observedAt ?? 0, record.updatedAt ?? 0, record.createdAt ?? 0)
        const priorDeletedAt = deletedHashesByScope.get(scopeId).get(record.contentHash) ?? 0
        deletedHashesByScope.get(scopeId).set(record.contentHash, Math.max(priorDeletedAt, deletedAt))
        for (const ref of Array.isArray(record.sourceRefs) ? record.sourceRefs : []) {
          if (typeof ref.sourceId === 'string') deletedSources.add(ref.sourceId)
        }
      }
      if (record.status === 'active' || record.status === 'candidate') {
        if (!seenByScope.has(scopeId)) seenByScope.set(scopeId, new Map())
        seenByScope.get(scopeId).set(record.contentHash, record)
      }
    }
    const publish = record => {
      this.#index.upsert(record)
      if (record.status !== 'active' || record.scope !== 'project' || record.quoted ||
          record.evidenceRole !== 'user' || record.captureTaskId !== task.id) return
      for (const ref of record.sourceRefs ?? []) {
        if (ref.role === 'user' && ref.sourceKind === 'user' && Number.isSafeInteger(ref.from) &&
            Number.isSafeInteger(ref.to) && task.sourceIds.includes(ref.sourceId)) {
          grants.push({ id: record.id, revision: record.revision, hash: record.contentHash,
            sourceId: ref.sourceId, from: ref.from, to: ref.to })
        }
      }
    }
    let applied = 0
    let rejected = 0
    for (let index = 0; index < items.length; index += 1) {
      const extracted = items[index]
      const evidence = this.#evidenceFor(extracted, entries)
      // A decision carries the actual words including its cause, conditions and
      // polarity. A message-level reference alone cannot confirm a decision.
      const needsOriginal = extracted.kind === 'decision' ||
        /因为|由于|为了|原因是|because|in order to/iu.test(extracted.content) ||
        (evidence.grounded && NEGATION_PATTERN.test(evidence.grounded) !== NEGATION_PATTERN.test(extracted.content))
      const item = needsOriginal && evidence.role === 'user' && evidence.grounded && evidence.grounded.length <= 500
        ? { ...extracted, content: evidence.grounded } : extracted
      const itemKey = `${task.id}:${index}:${contentHashOf(extracted.content)}`
      if (captureKeys.has(itemKey)) continue
      const explicitIds = Array.isArray(item.evidence) ? item.evidence : []
      const citedInternal = entries.some((entry) => explicitIds.includes(entry.source.id) &&
        entry.source.role === 'user' && !isModelEvidenceSource(entry))
      // An internal citation invalidates the claim even if a user question
      // overlaps its topic. Word overlap cannot authorize an injected value.
      if (citedInternal) {
        rejected += 1
        continue
      }
      const scope = item.kind === 'preference' && item.scope !== 'project' ? 'global' : item.scope === 'global' ? 'global' : 'project'
      const scopeId = scopeIdOf(scope, scope === 'project' ? identity.key : null)
      const seen = seenByScope.get(scopeId) ?? new Map()
      seenByScope.set(scopeId, seen)
      const deletedHashes = deletedHashesByScope.get(scopeId) ?? new Map()
      // Forgetting is source-aware: a paraphrase from the same deleted source
      // must not be revived by a pending task. Other sources stay independent.
      if (evidence.refs.some((ref) => deletedSources.has(ref.sourceId) || !canReadSource(this.#store.root, ref.sourceId))) continue
      // Observation time comes from the selected user evidence, not from the
      // recovery/processing clock. A missing time is conservative.
      const userTimes = evidence.refs
        .filter((ref) => ref.role === 'user' && typeof ref.at === 'number' && Number.isFinite(ref.at))
        .map((ref) => Math.floor(ref.at))
      const anyTimes = evidence.refs
        .filter((ref) => typeof ref.at === 'number' && Number.isFinite(ref.at))
        .map((ref) => Math.floor(ref.at))
      const hasKnownUserTime = userTimes.length > 0
      const observedAt = hasKnownUserTime
        ? Math.max(...userTimes)
        : anyTimes.length > 0 ? Math.max(...anyTimes) : now
      const contentHash = contentHashOf(item.content)
      const deletedAt = deletedHashes.get(contentHash)
      // Forgetting blocks both manual retry and old-source recovery. Only a
      // genuinely newer explicit user source may re-authorize the same content.
      const userReauthorized = task.explicit === true && deletedAt !== undefined && hasKnownUserTime && observedAt > deletedAt
      if (deletedAt !== undefined && !userReauthorized) continue
      const appendHistoricalCandidate = () => {
        const historical = buildRecord({
          ...base,
          supersedesId: null,
          status: 'candidate',
        }, { now, observedAt, autoApproveConfidence: this.#config.capture.autoApproveConfidence })
        if (historical.ok !== true) return false
        if (seen.has(historical.record.contentHash) || captureKeys.has(itemKey)) return true
        this.#store.append(historical.record)
        this.#index.upsert(historical.record)
        seen.set(historical.record.contentHash, historical.record)
        captureKeys.add(itemKey)
        applied += 1
        return true
      }
      const unconfirmed = evidence.role !== 'user' || item.quoted === true || (needsOriginal && item === extracted)
      const target = items[index].targetId === null ? undefined : this.#store.find(item.targetId, scopes)
      const safeTarget = target !== undefined && !unconfirmed && target.kind === item.kind && target.scope === scope && !differentNamedServices(target.content, item.content) &&
        (scope !== 'project' || target.projectKey === identity.key) && !deletedIds.has(target.id) && (target.status === 'active' || target.status === 'candidate') ? target : undefined
      const sourceRefs = evidence.refs
      const base = {
        kind: item.kind,
        scope,
        projectKey: scope === 'project' ? identity.key : null,
        content: item.content,
        topic: item.topic,
        tags: item.tags,
        sourceRefs,
        confidence: unconfirmed ? Math.min(item.confidence, 0.5) : item.confidence,
        importance: unconfirmed ? Math.min(item.importance, 0.5) : item.importance,
        validFrom: item.validFrom,
        validTo: item.validTo,
        evidenceRole: evidence.role,
        quoted: item.quoted === true,
        captureKey: itemKey,
        captureTaskId: task.id,
      }
      // UPDATE/merge must retain the earlier evidence trail, but an old source
      // must never overwrite a record observed later than that source.
      if (safeTarget && observedAt < (safeTarget.observedAt ?? safeTarget.createdAt ?? 0)) {
        appendHistoricalCandidate()
        continue
      }
      if (item.op === 'UPDATE' && safeTarget !== undefined) {
        const updated = this.#store.update(safeTarget.id, {
          content: item.content,
          tags: item.tags,
          ...(item.topic === null || item.topic === undefined ? {} : { topic: item.topic }),
          confidence: item.confidence,
          importance: item.importance,
          sourceRefs: mergeSourceRefs(sourceRefs, safeTarget.sourceRefs),
          evidenceRole: evidence.role,
          captureKey: itemKey,
          captureTaskId: task.id,
          quoted: item.quoted === true,
          observedAt,
        }, scopes)
        if (updated !== undefined) {
          publish(updated)
          seen.set(updated.contentHash, updated)
          captureKeys.add(itemKey)
          applied += 1
        } else {
          rejected += 1
        }
        continue
      }
      // Both authority revisions commit together before publishing to the index.
      if (item.op === 'SUPERSEDE' && safeTarget !== undefined) {
        const built = buildRecord({
          ...base,
          supersedesId: safeTarget.id,
          status: unconfirmed ? 'candidate' : undefined,
        }, { now, observedAt, autoApproveConfidence: this.#config.capture.autoApproveConfidence })
        if (built.ok !== true) {
          rejected += 1
          this.#logger?.warn?.(`[dsh-memory] supersede replacement rejected: ${built.reason}`)
          continue
        }
        const committed = this.#store.replace(safeTarget.id, built.record)
        this.#index.upsert(committed.previous)
        publish(committed.record)
        seen.set(built.record.contentHash, built.record)
        captureKeys.add(itemKey)
        applied += 1
        continue
      }
      const built = buildRecord({
        ...base,
        supersedesId: null,
        status: unconfirmed ? 'candidate' : undefined,
      }, { now, observedAt, autoApproveConfidence: this.#config.capture.autoApproveConfidence })
      if (built.ok !== true) {
        rejected += 1
        this.#logger?.warn?.(`[dsh-memory] dropped candidate: ${built.reason}`)
        continue
      }
      if (captureKeys.has(itemKey) || seen.has(built.record.contentHash)) continue
      const similar = unconfirmed ? undefined : this.#findSimilar(built.record)
      if (similar !== undefined && observedAt < (similar.record.observedAt ?? similar.record.createdAt ?? 0)) {
        appendHistoricalCandidate()
        continue
      }
      if (similar !== undefined && similar.mode === 'supersede') {
        const builtReplacement = buildRecord({
          ...base,
          supersedesId: similar.record.id,
          status: undefined,
        }, { now, observedAt, autoApproveConfidence: this.#config.capture.autoApproveConfidence })
        if (builtReplacement.ok !== true) {
          rejected += 1
          continue
        }
        const committed = this.#store.replace(similar.record.id, builtReplacement.record)
        this.#index.upsert(committed.previous)
        publish(committed.record)
        captureKeys.add(itemKey)
        applied += 1
        continue
      }
      if (similar !== undefined) {
        const merged = this.#store.update(similar.record.id, {
          content: built.record.content.length > similar.record.content.length ? built.record.content : similar.record.content,
          tags: [...new Set([...(Array.isArray(similar.record.tags) ? similar.record.tags : []), ...built.record.tags])],
          confidence: Math.min(1, Math.max(similar.record.confidence, built.record.confidence) + 0.05),
          importance: Math.max(similar.record.importance, built.record.importance),
          sourceRefs: mergeSourceRefs(built.record.sourceRefs, similar.record.sourceRefs),
          evidenceRole: evidence.role,
          captureKey: itemKey,
          captureTaskId: task.id,
          observedAt: Math.max(observedAt, similar.record.observedAt ?? 0),
        }, scopes)
        if (merged !== undefined) {
          publish(merged)
          seen.set(merged.contentHash, merged)
          captureKeys.add(itemKey)
          applied += 1
          continue
        }
      }
      this.#store.append(built.record)
      publish(built.record)
      captureKeys.add(itemKey)
      seen.set(built.record.contentHash, built.record)
      applied += 1
    }
    return { applied, rejected }
  }
}
