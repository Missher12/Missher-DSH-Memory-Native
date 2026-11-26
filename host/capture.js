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

import { join } from 'node:path'
import { MAX_MEMORIES_PER_PASS, buildExtractionPrompt, parseExtraction } from './extract.js'
import {
  CAPTURE_DIR,
  SOURCE_DIR,
  discardTurnSources,
  captureJournalHealth,
  captureStorageStatus,
  compressCaptureSources,
  compressCaptureSourcesInBatches,
  captureTaskIdOf,
  compactCaptureLedgers,
  countCaptureTasks,
  readCaptureTasks,
  readTurnIntakes,
  NO_SAVE_REASON,
  recoverCaptureTasks,
  reconcileReplacements,
  saveSource,
  readSource,
  sourceIdOf,
  canReadSource,
  turnIdOf,
  updateCaptureTask,
  updateTurnIntake,
  writeCaptureTask,
  writeTurnIntake,
} from './capture-journal.js'
import { projectIdentity } from './paths.js'
import { estimateTokens } from './recall.js'
import { looksSensitive } from './records.js'
import { analyzeUserMessageControls, explicitRememberText, isBareRemember } from './user-controls.js'
import { grantSourceRecall, hasSourceRecallGrant } from './source-passages.js'
import { readRecallSelection, readRecallSelections, recallSelectionId, writeRecallSelection } from './recall-journal.js'
import { buildRecallSelectionPrompt, parseRecallSelectionResult, recallSelectionKey, recallSelectionSlotDigest } from './recall-selection.js'
import { MIN_CONTINUATION_CHARS, MAX_CONTINUATION_DEPTH, MAX_COMPLETION_ROUNDS, RECOVERY_OUTPUT_TOKENS,
  emptyCapacityResult, sameRoute, dayKey, nextDayStart, receiptDay, combineSignals, automaticBudget,
  normalizeUsage, splitRanges } from './capture-budget.js'
import { EXPLICIT_MEMORY_PATTERN, isOrdinaryDecision, memoryOptOut, sourceLabel, isDirectUserSource, isModelEvidenceSource, sourceIdLine } from './capture-evidence.js'
import { CaptureApplyCoordinator } from './capture-apply.js'
import { CaptureSourceFootprint } from './capture-source-footprint.js'
import { sourceEventTime } from './source-time.js'

const SENSITIVE_REASON = '本轮含疑似凭据，未保存原文或请求提炼'
const LOW_EFFORT_ORDER = ['off', 'none', 'minimal', 'low']
const MODEL_FINISHES = new Set(['stop', 'max-tokens', 'length', 'tool-calls'])
const CONFIRMED_REJECTIONS = new Set([
  'NO_ADAPTER', 'MISSING_CREDENTIAL', 'INVALID_CREDENTIAL',
  'AUTH', 'ACCOUNT_SIGN_IN_REQUIRED', 'ACCOUNT_TOKEN_INVALID',
  'ACCOUNT_QUOTA', 'QUOTA', 'RATE_LIMIT', 'CONTEXT_WINDOW_EXCEEDED',
  'UNKNOWN_MODEL', 'MODEL_UNSUPPORTED', 'CONTENT_REFUSED', 'EMPTY_RESPONSE',
])

function textOfContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

const isNativeUserInput = message => message?.role === 'user' && message.source?.kind === 'user' &&
  typeof message.id === 'string' && message.id !== ''

/** Resolve the immediate admitted user message using the authoritative session order. */
export function precedingUserSourceId(session, ref) {
  const { sessionId, messageId, eventSeq, sourceId } = ref
  const boundary = session.inheritedEventCount
  if (session.id !== sessionId || typeof session.eventAt !== 'function' || !Number.isSafeInteger(boundary) ||
      !Number.isSafeInteger(eventSeq) || eventSeq <= boundary) return null
  const idFor = message => sourceIdOf({ sessionId, messageId: message.id, role: 'user', text: textOfContent(message.content) })
  const current = session.eventAt(eventSeq)
  if (current?.type !== 'user/message' || current.seq !== eventSeq || !isNativeUserInput(current.data) ||
      current.data.id !== messageId || idFor(current.data) !== sourceId) return null
  // Count native events, including user turns the memory layer never saved.
  for (let seq = eventSeq - 1; seq >= Math.max(boundary, eventSeq - 4096); seq--) {
    const event = session.eventAt(seq)
    if (!event || event.seq !== seq) return null
    if (event.type !== 'user/message') continue
    if (isNativeUserInput(event.data)) return idFor(event.data)
    // The host commits these context messages using the user role. Only
    // skip known synthetic kinds; a real omitted user input is a boundary.
    if (event.data?.source?.kind !== 'runtime-context' && event.data?.source?.kind !== 'memory') return null
  }
  return null
}

function previousUserInput(observation, event, command) {
  const events = observation.events
  const first = observation.inheritedEventCount
  const eligible = message => isNativeUserInput(message) && message.id !== command.id &&
    !isBareRemember(textOfContent(message.content))
  if (event.seq < first) return null
  let submission = event.type === 'agent/inbox/spliced' ? event : null
  if (submission === null) {
    for (let seq = event.seq - 1; seq >= first; seq--) {
      const row = events[seq]
      if (row?.type === 'agent/inbox/spliced' && row.data.inserted.some(message => message.id === command.id)) {
        submission = row
        break
      }
    }
  }
  let admitted = null
  for (let seq = submission?.seq ?? event.seq - 1; seq >= first; seq--) {
    const row = events[seq]
    if (submission && row?.type === 'agent/inbox/spliced') {
      const inserted = row.data.inserted
      const end = seq === submission.seq ? inserted.findIndex(message => message.id === command.id) : inserted.length
      for (let index = end - 1; index >= 0; index--) {
        if (eligible(inserted[index])) return { ...row, data: inserted[index] }
      }
    }
    if (admitted === null && row?.type === 'user/message' && eligible(row.data)) admitted = row
  }
  return admitted
}

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
  #applyCoordinator
  #sourceFootprint
  #buffers = new Map()
  #remembering = new WeakMap()
  #queuedUserTimes = new WeakMap()
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
    this.#applyCoordinator = new CaptureApplyCoordinator({ store: this.#store, index: this.#index,
      config: this.#config, clock: this.#clock, logger: this.#logger })
    const root = this.#store?.root
    if (typeof root === 'string' && root !== '') {
      this.#sourceFootprint = new CaptureSourceFootprint(join(root, CAPTURE_DIR, SOURCE_DIR))
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
      this.#applyCoordinator.setConfig(config)
      if (changed) this.#scheduleDrain()
    }
  }

  /** One bounded, journaled evidence-selection request for a real user turn. */
  async selectRecall(input = {}) {
    const root = this.#store?.root
    const sessionId = typeof input.session?.id === 'string' ? input.session.id : ''
    const id = recallSelectionId(sessionId, input.turnKey)
    if (typeof root !== 'string' || id === null || looksSensitive(input.query) ||
        analyzeUserMessageControls(input.query).noSaveDirective) {
      return { state: 'not-sent', callState: 'not-sent', usage: null, resultText: '' }
    }
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
    const reuse = previous => !previous || previous.callState === 'requested'
      ? { ...previous, state: 'unknown', callState: 'unknown', reused: true,
        reason: '上次选择请求已发送但没有可用回执；不会自动重试' }
      : { ...previous, state: previous.state ?? previous.callState, reused: true }
    const previous = readRecallSelection(root, id)
    if (previous !== null) return reuse(previous)

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
      slotDigest: recallSelectionSlotDigest(built.slots),
      candidateRefs: [...new Map(built.candidates.map(({ id, revision }) => [id, { id, revision }])).values()],
    }
    try {
      if (!writeRecallSelection(root, requested, { createOnly: true })) {
        this.#releaseCall(reservation)
        return reuse(readRecallSelection(root, id))
      }
    } catch (error) {
      this.#releaseCall(reservation)
      return { state: 'not-sent', callState: 'not-sent', route, usage: null, resultText: '',
        promptTokens: built.promptTokens, reason: `选择回执无法保存，未发送请求：${error instanceof Error ? error.message : String(error)}` }
    }
    if (input.signal?.aborted === true) {
      this.#releaseCall(reservation)
      const receipt = {
        ...requested, state: 'not-sent', callState: 'not-sent', completedAt: this.#clock(), usage: null,
        budgetReservation: { ...requested.budgetReservation, state: 'released', calls: 0 },
        reason: '请求发送前，本轮已取消',
      }
      writeRecallSelection(root, receipt)
      return receipt
    }
    const recordsById = new Map(input.candidates.filter(Boolean).map(item => {
      const record = item.record ?? item
      return [record.id, record]
    }))
    const selectionRefs = (text, state) => state === 'completed'
      ? parseRecallSelectionResult(text, built.slots, built.candidates).flatMap(selection => {
        const { slot, id, revision, quote } = selection
        const record = recordsById.get(id)
        const start = String(record?.content ?? '').indexOf(quote)
        return start < 0 ? [] : [{ slot, id, revision, scope: record.scope, projectKey: record.projectKey ?? null,
          start, length: quote.length, digest: recallSelectionKey(selection) }]
      }) : []
    let result = null
    try {
      result = await this.#collect(route, built.prompt, maxTokens, input.signal)
      const state = result.finishKind === 'stop' && result.truncated !== true ? 'completed' : 'failed'
      const completedAt = this.#clock()
      const usage = normalizeUsage(result.usage)
      const resultText = String(result.text ?? '').slice(0, 16000)
      const receipt = {
        ...requested, state, callState: 'completed', selectionRefs: selectionRefs(resultText, state),
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
          ...requested, state: 'not-sent', callState: 'not-sent', completedAt: this.#clock(), usage: null,
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
      const resultText = String(result?.text ?? '').slice(0, 16000)
      const receipt = {
        ...requested, state, callState: completed ? 'completed' : 'unknown',
        selectionRefs: selectionRefs(resultText, state),
        finishKind: result?.finishKind ?? error?.finishKind ?? null, usage,
        budgetReservation: completed ? this.#settledReservation(reservation, usage) : requested.budgetReservation,
        completedAt,
        reason: selectionCompleted ? null : completed ? '模型已结束但选择输出不可用；不会自动重试'
          : '模型选择回执未知；不会自动重试',
      }
      writeRecallSelection(root, receipt)
      this.#recordUsage({ at: completedAt ?? this.#clock(), promptTokens: built.promptTokens, usage, outcome: state })
      return receipt
    }
  }

  /** Keep ordinary sources provisional until the turn's privacy intent is known. */
  observe(session, event) {
    if (this.#disposed || session === undefined || event === undefined) return
    const sessionId = typeof session.id === 'string' ? session.id : undefined
    if (sessionId === undefined) return
    if (event.type === 'agent/inbox/spliced') {
      if (!this.#config.capture.enabled) return
      const messages = (event.data?.inserted ?? []).filter(isNativeUserInput)
        .map(message => ({ message, text: textOfContent(message.content) }))
      if (messages.some(({ text }) => looksSensitive(text) || analyzeUserMessageControls(text).noSaveDirective)) return
      const eventTime = sourceEventTime(event.time)
      if (eventTime !== undefined && messages.length) {
        const times = this.#queuedUserTimes.get(session) ?? new Map()
        for (const { message } of messages) {
          if (!times.has(message.id)) times.set(message.id, { eventTime, timeZone: message.source.clientTimeZone })
        }
        while (times.size > 64) times.delete(times.keys().next().value)
        this.#queuedUserTimes.set(session, times)
      }
      for (const { message, text } of messages) {
        if (isBareRemember(text)) this.#startRemembering(session, event, message)
        else if (explicitRememberText(text) !== null) this.#persistMessage(this.#messageInput(session, { ...event, data: message }, 'user', text))
      }
      return
    }
    if (event.type === 'user/message') {
      const text = textOfContent(event.data?.content)
      const times = this.#queuedUserTimes.get(session), messageId = event.data?.id
      const submission = times?.get(messageId)
      times?.delete(messageId)
      if (this.#config.capture.enabled && !this.#buffers.get(sessionId)?.privacy &&
          isNativeUserInput(event.data) && isBareRemember(text)) {
        this.#startRemembering(session, event, event.data)
      }
      if (text !== '') this.#push(session, event, 'user', text, submission)
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
      try {
        this.#acceptTurn(session, buffered, event.data?.reason?.kind === 'completed')
      } catch (error) {
        this.#logger?.warn?.(`[dsh-memory] turn intake not persisted: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  /** Complete the local save before the chat model responds to the command. */
  waitForRemembering(session, messages) {
    const jobs = this.#remembering.get(session)
    if (!jobs) return undefined
    const pending = messages.map(message => jobs.get(message.id)).filter(Boolean)
    return pending.length ? Promise.all(pending) : undefined
  }

  #startRemembering(session, event, message) {
    let jobs = this.#remembering.get(session)
    if (!jobs) {
      jobs = new Map()
      this.#remembering.set(session, jobs)
    }
    if (jobs.has(message.id)) return
    jobs.set(message.id, this.#rememberPrevious(session, event, message).catch(error => {
      this.#logger?.warn?.(`[dsh-memory] previous message could not be remembered: ${error.message}`)
    }))
    if (jobs.size > 64) jobs.delete(jobs.keys().next().value)
  }

  async #rememberPrevious(session, event, command) {
    const root = this.#store?.root
    const cwd = session.header?.cwd
    if (typeof root !== 'string' || typeof cwd !== 'string') return
    const projectKey = projectIdentity(cwd).key
    const query = this.#ctx?.get?.('sessionQuery')
    let previous
    const haveNativeHistory = typeof query?.observeSession === 'function' && Number.isSafeInteger(event.seq)
    if (haveNativeHistory) {
      const observation = await query.observeSession(session.id, { projectionMode: 'none', signal: this.#abort.signal })
      try {
        if (typeof observation.header?.cwd === 'string' && projectIdentity(observation.header.cwd).key !== projectKey) return
        previous = previousUserInput(observation, event, command)
      } finally {
        observation[Symbol.dispose]()
      }
    } else {
      const data = session.deriveMessages?.().findLast(message => isNativeUserInput(message) &&
        message.id !== command.id && !isBareRemember(textOfContent(message.content)))
      if (data) previous = { data }
    }
    if (!previous || this.#disposed || !this.#config.capture.enabled || this.#buffers.get(session.id)?.privacy) return
    const text = textOfContent(previous.data.content)
    if (!text || looksSensitive(text) || memoryOptOut({ role: 'user', sourceKind: 'user', text })) return
    const id = sourceIdOf({ sessionId: session.id, role: 'user', messageId: previous.data.id, text })
    if (!canReadSource(root, id)) return
    const existing = readSource(root, id)
    if (existing && (existing.sessionId !== session.id || existing.projectKey !== projectKey || existing.text !== text)) return
    if (readTurnIntakes(root).intakes.some(intake => intake.sessionId === session.id &&
        intake.reason === NO_SAVE_REASON && intake.sourceIds?.includes(id))) return
    if (!existing && (!haveNativeHistory || !this.#persistMessage(this.#messageInput(session, previous, 'user', text)))) return
    const source = existing ?? readSource(root, id)
    grantSourceRecall(root, source, projectKey, { remembered: true })
  }

  /** Abort the in-flight request; journaled sources and tasks survive. */
  dispose() {
    this.#disposed = true
    this.#sourceFootprint?.dispose()
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
    const footprint = this.#sourceFootprint?.read()
    return {
      counts: countCaptureTasks(allTasks),
      tasks,
      budget: this.#budgetStatus(allTasks),
      health,
      degraded: health.corruptTasks > 0 || intakes.corrupt > 0,
      storageState: footprint?.state ?? 'unavailable',
      storage: footprint?.sources ? captureStorageStatus(root, footprint.sources) : null,
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

  async maintainInBackground() {
    const root = this.#store?.root
    if (typeof root !== 'string') return
    const shouldContinue = () => !this.#disposed && this.#config.maintenance.enabled
    await compressCaptureSourcesInBatches(root, shouldContinue)
    if (shouldContinue()) compactCaptureLedgers(root)
  }

  /** Explicit retry for an unknown/failed task; never called automatically. */
  retry(taskId, options = {}) {
    const root = this.#store?.root
    if (typeof root !== 'string') return { ok: false, reason: 'storage unavailable' }
    const task = readCaptureTasks(root).find((entry) => entry.id === taskId)
    if (task === undefined) return { ok: false, reason: 'task not found' }
    if (task.revokedOnRestore === true) return { ok: false, reason: '来源受禁存凭据保护，不能重新提炼' }
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
        ? { resultText: undefined, resultTruncated: undefined, resultUsage: undefined, resultParseFailed: undefined,
            resultFinishKind: undefined, resultFailureCode: undefined, replay: false }
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

  #messageInput(session, event, role, text, submission) {
    const message = role === 'user' ? event.data : event.data?.message
    const messageId = typeof message?.id === 'string' ? message.id : null
    const sourceKind = typeof message?.source?.kind === 'string' ? message.source.kind : 'unknown'
    const sourceForm = typeof message?.source?.form === 'string' ? message.source.form : undefined
    const projectKey = typeof session.header?.cwd === 'string' ? projectIdentity(session.header.cwd).key : null
    const input = {
      sessionId: session.id,
      messageId,
      projectKey,
      sourceKind,
      sourceForm,
      eventSeq: event.seq,
      eventTime: submission?.eventTime ?? event.time,
      // Admission can occur long after submission, including after restart.
      timeZone: submission?.timeZone ?? (event.type === 'agent/inbox/spliced' ? message?.source?.clientTimeZone : undefined),
      role,
      at: this.#clock(),
      text,
    }
    const id = sourceIdOf(input)
    if (role === 'user' && sourceKind === 'user' && event.type === 'user/message' && this.#store?.root && projectKey) {
      const previous = precedingUserSourceId(session, { ...input, sourceId: id })
      if (previous && hasSourceRecallGrant(this.#store.root, previous, projectKey)) {
        return { ...input, id, previousUserSourceId: previous }
      }
    }
    return { ...input, id }
  }

  #persistMessage(input) {
    const root = this.#store?.root
    if (typeof root !== 'string' || !canReadSource(root, input.id) || looksSensitive(input.text)) return
    let source
    try {
      source = saveSource(root, input)
    } catch (error) {
      this.#logger?.warn?.(`[dsh-memory] source not persisted: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    const { role, sourceKind, text, projectKey } = input
    if (source.projectKey !== projectKey) return
    if (role === 'user' && sourceKind === 'user' && explicitRememberText(text) !== null) {
      try { grantSourceRecall(root, { ...source, text, projectKey }, projectKey) }
      catch (error) { this.#logger?.warn?.(`[dsh-memory] explicit memory could not be enabled: ${error.message}`) }
    }
    return source
  }

  #push(session, event, role, text, submission) {
    if (!this.#config.capture.enabled) return
    const source = this.#messageInput(session, event, role, text, submission)
    let buffer = this.#buffers.get(session.id)
    if (buffer === undefined) {
      buffer = { sources: [], privacy: null }
      this.#buffers.set(session.id, buffer)
    }
    buffer.sources.push(source)
    const reason = isDirectUserSource(source) && analyzeUserMessageControls(text).noSaveDirective ? NO_SAVE_REASON
      : looksSensitive(text) ? SENSITIVE_REASON : null
    const root = this.#store?.root
    if (reason && typeof root === 'string' && (!buffer.privacy || reason === NO_SAVE_REASON)) {
      buffer.privacy = reason
      // Explicit commands may already have been made available before the reply.
      discardTurnSources(root, buffer.sources.map(item => item.id))
    } else if (!buffer.privacy && role === 'user' && source.sourceKind === 'user' && explicitRememberText(text) !== null) {
      this.#persistMessage(source)
    }
  }

  #acceptTurn(session, buffer, completed) {
    if (this.#disposed) return
    const root = this.#store?.root
    if (typeof root !== 'string') return
    const cwd = typeof session.header?.cwd === 'string' ? session.header.cwd : undefined
    if (cwd === undefined) return
    const { sources, privacy } = buffer
    const identity = projectIdentity(cwd)
    const sourceRecords = privacy ? sources : sources.filter(source => source.projectKey === identity.key && this.#persistMessage(source))
    if (sourceRecords.length === 0) return
    if (privacy) discardTurnSources(root, sourceRecords.map(source => source.id))
    else if (!completed) return
    const chars = sourceRecords.reduce((sum, source) => sum + source.text.length, 0)
    const explicit = sourceRecords.some((source) => source.role === 'user' && source.sourceKind === 'user' && EXPLICIT_MEMORY_PATTERN.test(source.text))
    const userSources = sourceRecords.filter(isDirectUserSource)
    const bareOnly = userSources.length > 0 && userSources.every(source => isBareRemember(source.text))
    const id = turnIdOf({ sessionId: session.id, sourceIds: sourceRecords.map((source) => source.id) })
    const existing = readTurnIntakes(root).intakes.find((intake) => intake.id === id && intake.status !== 'failed')
    if (existing !== undefined) return
    let skipped = privacy
    if (!skipped && !this.#config.capture.enabled) skipped = 'capture disabled'
    if (!skipped && bareOnly) skipped = '仅包含记住指令，原文按来源处理'
    if (!skipped && chars < this.#config.capture.minTurnChars && !explicit && !sourceRecords.some(isOrdinaryDecision)) {
      skipped = 'turn shorter than capture.minTurnChars'
    }
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
    if (this.#config.capture.enabled && !privacy) {
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
    const taskSourceIds = new Set(task.sourceIds ?? task.segment?.entries?.map(ref => ref.sourceId) ?? [])
    const intakes = readTurnIntakes(root).intakes
    const intake = intakes.find(entry => entry.id === task.turnKey)
    const denied = intakes.some(entry => [NO_SAVE_REASON, SENSITIVE_REASON].includes(entry.reason) &&
      (entry === intake || entry.sourceIds?.some(id => taskSourceIds.has(id))))
    if (denied || [...(intake?.sourceIds ?? taskSourceIds)].some(id => {
      const source = readSource(root, id)
      return source && (looksSensitive(source.text) ||
        isDirectUserSource(source) && analyzeUserMessageControls(source.text).noSaveDirective)
    })) {
      updateCaptureTask(root, task.id, { status: 'skipped',
        reason: '来源含疑似凭据或已明确禁存，未请求提炼或应用旧回执' })
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
      if (seenExisting.has(record.id) || looksSensitive(record.content) ||
          record.sourceRefs?.some(ref => !canReadSource(root, ref.sourceId))) continue
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
        applied: Array.isArray(task.appliedContents) ? task.appliedContents.filter(content => !looksSensitive(content)) : [],
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
      // Only a provider outcome, not a host-side stream failure, settles the call.
      if (error?.completed === true) {
        const receipt = { resultFinishKind: error.finishKind, resultUsage: error.usage ?? null,
          ...(error.failureCode === undefined ? {} : { resultFailureCode: error.failureCode }),
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
        resultFinishKind: error?.finishKind,
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
      const appliedResult = this.#applyCoordinator.apply(parsed.items, scopeInfo)
      applied = appliedResult.applied
      rejected = appliedResult.rejected
    } catch (error) {
      updateCaptureTask(root, task.id, {
        status: error?.code === 'source-revoked' ? 'skipped' : 'failed',
        callState: 'completed',
        reason: error?.code === 'source-revoked' ? '写入前原文已遗忘，保留已付费回执，不再写入'
          : `写入失败：${error instanceof Error ? error.message : String(error)}；旧记录保持有效，不会自动重试`,
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
    try {
      for await (const chunk of llm.stream({
        provider: route.provider,
        model: route.model,
        ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        maxTokens: maxTokens ?? this.#config.extraction.maxOutputTokens,
        signal,
      })) {
        // DSH may emit a second finish for a failure in adapter cleanup. Keep
        // the model's first terminal result and continue reading accounting.
        if (!MODEL_FINISHES.has(finish?.kind)) {
          if (chunk.type === 'text-delta') text += chunk.text
          else if (chunk.type === 'reasoning-delta') reasoningChars += String(chunk.text ?? '').length
          else if (chunk.type === 'finish') finish = chunk.reason
        }
        if (chunk.type === 'usage') usage = normalizeUsage(chunk.usage ?? chunk) ?? usage
        else if (chunk.usage !== undefined) usage = normalizeUsage(chunk.usage) ?? usage
      }
    } catch (error) {
      if (!MODEL_FINISHES.has(finish?.kind)) throw error
    }
    if ((finish?.kind === 'length' || finish?.kind === 'max-tokens') && text.trim() !== '') {
      return { text, truncated: true, usage, finishKind: finish.kind, reasoningChars }
    }
    if (finish?.kind !== 'stop') {
      const code = finish?.failure?.code
      const refused = finish?.kind === 'error' && usage === null && text === '' && reasoningChars === 0 &&
        CONFIRMED_REJECTIONS.has(code)
      const error = new Error(`extraction stream ended with ${finish?.kind ?? 'missing-finish'}`)
      error.finishKind = finish?.kind ?? 'missing-finish'
      error.completed = MODEL_FINISHES.has(finish?.kind) || refused
      if (refused) error.failureCode = code
      error.usage = usage
      error.reasoningChars = reasoningChars
      throw error
    }
    return { text, truncated: false, usage, finishKind: finish.kind, reasoningChars }
  }


}
