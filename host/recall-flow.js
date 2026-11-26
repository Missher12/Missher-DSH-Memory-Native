import { createHash, randomUUID } from 'node:crypto'
import { memoryBudgetFor } from './context-budget.js'
import { projectIdentity } from './paths.js'
import { selectOpeningBrief } from './project-brief.js'
import { describeQuantities, quantityEvidence, quantityProofKey, quantityResultCovered, unsupportedQuantityResult } from './quantity-recall.js'
import { deliveredDiscountFact, describeDiscount, discountEvidenceRows, findDiscountEvidence } from './purchase-recall.js'
import { recallReportReferences, recallReportSessionKey } from './recall-reports.js'
import { adaptiveInjectionBudget, classifyRecallHits, compileMemoryContext, conflictsRecallProject, explicitlyAsksCurrentTime, formatMemoryLine, hasContentMatch, isEffectiveAt, isFollowUpQuery, isHistoricalQuery, isPreferenceQuery, isQualifiedValueCandidate, matchesRecallAttribute, matchesRecallEntity, rankHits, recallAnchorTerms, recallDecisionAnswer, recallHasDecisionReasonEvidence, recallHasHandoffEvidence, recallNamedProjectTerms, recallSubjectTerms, recallQueryPlan, recallRelationAnswer, recallTimeIntent } from './recall.js'
import { agreedCalendarDate, calendarDateKey, calendarEventEvidence, calendarEventWindow, calendarIntervalFromProofs, calendarOrderDateKey, calendarOrderEvidence, calendarOrderPeriod, calendarParticipant, calendarParticipantAnchor, calendarWindowEvidence, preferCalendarOrderEvidence } from './calendar-recall.js'
import { openTimelineQuery, retrieveTimeline } from './timeline-recall.js'
import { marketSalesQuery, retrieveMarketSales } from './market-sales-recall.js'
import { expenseQuery, retrieveExpenses } from './dated-expenses-recall.js'
import { personalFundraisingQuery, retrievePersonalFundraising } from './personal-fundraising-recall.js'
import { eventCountQuery, retrieveEventCount } from './event-count-recall.js'
import { durationAtEventQuery, retrieveDurationAtEvent } from './duration-at-event-recall.js'
import { eventAgeQuery, retrieveEventAge } from './event-age-recall.js'
import { containsEventLocation, eventLocationQuery, retrieveEventLocation } from './event-location-recall.js'
import { declaredCountFacts, retrieveDeclaredCount } from './declared-count.js'
import { precedingUserSourceId } from './capture.js'
import { timeMeasureEvidence, timeMeasureFacts, timeMeasureValueKey, usesLatestTimeEvidence } from './time-measure-recall.js'
import { isCurrentKnowledgeQuote, isHistoricalKnowledgeSection, knowledgeValueConflicts, matchingKnowledgeTableRows, matchKnowledgeAlias } from './knowledge-recall.js'
import { knowledgeAuthority } from './knowledge-authority.js'
import { sourceSentences } from './sentences.js'
import { stateFieldEvidence, stateFieldSearch, stateValueKey } from './state-recall.js'
import { normalizeClientTimeZone, sourceEventTime } from './source-time.js'
import { analyzeUserMessageControls, isBareRemember } from './user-controls.js'
import { adjacentAdviceEvidence, personalSourceQuestion, personalSourceEvidence, sourceQuoteStartsAtSentence, sourceResolver } from './source-recall.js'
import { DEEP_RECALL_TOKEN_LIMIT, isRecallSourceStatement, sourceStatementExcerpt } from './source-passages.js'
import { writeGateLog } from './gate-log.js'
import { deriveProfile, formatProfileLines } from './profile.js'
import { appendUsage } from './usage-log.js'
import { looksSensitive } from './records.js'
import { contextualRecallQuote, recallSelectionSlotDigest, recoverRecallSelectionRefs } from './recall-selection.js'
import { estimateTokens, MAX_RECALL_LOOKUPS, recallUnitProperty } from './recall.js'
import { assessAnswerCoverage } from './answer-coverage.js'
import { elapsedQuery, retrieveElapsed } from './elapsed-recall.js'
import { counterReportQuestions, reportedCounterQuery, retrieveReportedCounters } from './counter-recall.js'
import { STRONG_SEMANTIC_SCORE } from './semantic-index.js'

const PLUGIN = 'dsh-memory'
const CONTEXT_USAGE_SESSION_LIMIT = 128
const RECALL_REPORT_SESSION_LIMIT = 128
const ADVICE_EVIDENCE_LIMIT = 3

async function resolveCountPredecessors(ctx, projectKey, refs, signal) {
  const history = ctx.get?.('sessionQuery')
  const found = new Map()
  if (typeof history?.inspectSession !== 'function' || signal?.aborted) return found
  const bySession = new Map()
  const recent = [...refs].sort((a, b) => (b.eventTime ?? -Infinity) - (a.eventTime ?? -Infinity))
  for (const ref of recent) {
    if (!Number.isSafeInteger(ref.eventSeq) || !ref.messageId) continue
    if (!bySession.has(ref.sessionId) && bySession.size < 4) bySession.set(ref.sessionId, new Map())
    const group = bySession.get(ref.sessionId)
    if (group && group.size < 4) group.set(ref.sourceId, ref)
  }
  await Promise.all([...bySession].map(async ([id, group]) => {
    try {
      const previous = await history.inspectSession(id, session => {
        const cwd = session.header?.cwd
        if (typeof cwd !== 'string' || projectIdentity(cwd).key !== projectKey) return []
        return [...group].map(([sourceId, ref]) => [sourceId, precedingUserSourceId(session, ref)])
      }, signal)
      for (const [sourceId, preceding] of previous) if (preceding) found.set(sourceId, preceding)
    } catch {
      // A missing or corrupt host transcript leaves its quantity unverified.
    }
  }))
  return found
}

/** Solid text of one message, ignoring non-text blocks. */
function textOf(message) {
  if (message === null || typeof message !== 'object') return ''
  const content = message.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

/** Whether a message is one of this plugin's injected memory blocks. */
function isMemoryMessage(message) {
  return message?.source?.kind === 'memory' && message?.source?.plugin === PLUGIN
}

/** User-role messages carrying another source are host/plugin context, not questions. */
function isUserQuestionMessage(message) {
  if (message?.role !== 'user') return false
  const source = message.source
  return source === undefined || source === null || source.kind === 'user'
}

/** Build the synthetic context message; `source` is the idempotency marker. */
function makeMemoryMessage(text) {
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    content: Object.freeze([{ type: 'text', text }]),
    source: Object.freeze({ kind: 'memory', plugin: PLUGIN }),
  })
}

/** Resolve the session behind an agent without relying on private fields alone. */
function sessionOf(ctx, agent) {
  if (agent === null || typeof agent !== 'object') return undefined
  try {
    const session = agent.session
    if (session !== undefined) return session
  } catch {
    // Session context is optional; a host getter must not prevent `next()`.
  }
  try {
    return ctx.sessions?.get?.(agent.id) ?? ctx.get('sessions')?.get?.(agent.id)
  } catch {
    return undefined
  }
}

function sessionProjectKey(session, expectedId) {
  if (session === null || typeof session !== 'object') return null
  const header = session.header
  const sessionId = session.id ?? header?.id ?? header?.sessionId
  if (typeof sessionId === 'string' && sessionId !== expectedId) return null
  const cwd = typeof header?.cwd === 'string' ? header.cwd : typeof session.cwd === 'string' ? session.cwd : null
  return cwd ? projectIdentity(cwd).key : null
}

export function liveSessionProjectKey(ctx, sessionId) {
  try {
    const loadedSession = ctx.sessions?.get?.(sessionId) ?? ctx.get('sessions')?.get?.(sessionId)
    return sessionProjectKey(loadedSession, sessionId)
  } catch { return null }
}

export async function hostSessionProjectKey(ctx, sessionId) {
  const loaded = liveSessionProjectKey(ctx, sessionId)
  if (loaded !== null) return loaded
  let persistence
  try { persistence = ctx.get('sessionPersistence') } catch {}
  if (typeof persistence?.stat !== 'function') return null
  try {
    const metadata = await persistence.stat(sessionId)
    return metadata === undefined || metadata === null ? null : sessionProjectKey(metadata, sessionId)
  } catch { return null }
}

/** Test-only observer; normal Host activation never resolves a diagnostic service. */
function traceRecall(observer, event) {
  try {
    observer(event)
  } catch {
    // Diagnostics must never affect a host turn.
  }
}

const RECALL_QUESTION_PATTERN = /[？?]|(?:什么|哪(?:个|些|种|款)?|谁|何时|何地|何原因|为何|为什么|怎么|如何|多少|多久|几(?:个|次|天|秒|号|年)?|几点|是否|what\s|which\s|who\s|when\s|where\s|why\s|how\s)/iu
const NAMED_OBJECT_PATTERN = /(?:[\p{Script=Han}]{1,8}(?:路由器|快照|设备|服务|任务|组件|系统|作业|主机|模块|数据库|缓存|容器|集群|接口))|\b[A-Z][A-Za-z0-9_.-]{1,}\b/u

function turnKeyOf(message, messages, query, previousQuery) {
  for (const field of ['id', 'messageId', 'eventId']) {
    if (typeof message?.[field] === 'string' && message[field] !== '') return `${field}:${message[field]}`
  }
  for (const field of ['seq', 'eventSeq', 'time', 'timestamp', 'createdAt']) {
    if (Number.isSafeInteger(message?.[field]) || Number.isFinite(message?.[field])) return `${field}:${message[field]}`
  }
  const digest = createHash('sha256').update(`${previousQuery ?? ''}\0${query}`).digest('hex').slice(0, 20)
  return `fallback:${messages.length}:${digest}`
}

function setRecallReport(reports, sessionId, report) {
  if (typeof sessionId !== 'string' || sessionId === '') return
  reports.delete(sessionId)
  reports.set(sessionId, report)
  while (reports.size > RECALL_REPORT_SESSION_LIMIT) reports.delete(reports.keys().next().value)
}

const privateRecallQuery = query => looksSensitive(query) || analyzeUserMessageControls(query).noSaveDirective

function beginRecallTurn(reports, turns, generations, sessionId, { turnKey, projectKey, query, startSeq, turnId }) {
  if (typeof sessionId !== 'string' || sessionId === '') return null
  const current = turns.get(sessionId)
  const sameTurn = current?.projectKey === projectKey && (current.turnKey === turnKey ||
    current.query === query && Number.isSafeInteger(startSeq) && current.startSeq === startSeq)
  if (sameTurn) {
    current.turnKey = turnKey
    current.query = query
    current.private ||= privateRecallQuery(query)
    if (Number.isSafeInteger(startSeq) && (!Number.isSafeInteger(current.startSeq) || startSeq < current.startSeq)) current.startSeq = startSeq
    current.turnId ??= turnId
    return current
  }
  const generation = (generations.get(sessionId) ?? 0) + 1
  generations.delete(sessionId)
  generations.set(sessionId, generation)
  while (generations.size > RECALL_REPORT_SESSION_LIMIT) generations.delete(generations.keys().next().value)
  const next = { generation, turnKey, projectKey, query, assistantText: null, private: privateRecallQuery(query),
    ...(Number.isSafeInteger(startSeq) ? { startSeq } : {}), ...(turnId === undefined ? {} : { turnId }) }
  turns.set(sessionId, next)
  setRecallReport(reports, sessionId, null)
  return next
}

function visibleAssistantText(event) {
  if (event?.type !== 'assistant/message') return null
  const message = event.data?.message
  if (message?.role !== 'assistant' || message.visible === false || message.candidate === true) return null
  if (/analysis|reasoning|candidate|tool/iu.test(String(message.channel ?? ''))) return null
  const sourceKind = String(message.source?.kind ?? '').toLowerCase()
  if (['candidate', 'tool', 'reasoning', 'analysis', 'memory', 'system'].includes(sourceKind)) return null
  const text = textOf(message).trim()
  return text === '' ? null : text.slice(0, 16_000)
}

function completeRecallTurn(reports, turns, generations, session, event, persistReport, logger) {
  const sessionId = typeof session?.id === 'string' ? session.id : undefined
  if (sessionId === undefined) return
  const turn = turns.get(sessionId)
  if (event?.type === 'user/message' || event?.type === 'agent/inbox/spliced') {
    const messages = event.type === 'user/message' ? [event.data] : (event.data?.inserted ?? [])
    const latest = [...messages].reverse().find(isUserQuestionMessage)
    if (latest) {
      const text = textOf(latest).trim()
      const key = turnKeyOf(latest, messages, text, undefined)
      const cwd = typeof session?.header?.cwd === 'string' ? session.header.cwd : undefined
      const projectKey = cwd ? projectIdentity(cwd).key : null
      const observed = beginRecallTurn(reports, turns, generations, sessionId, {
        turnKey: key, projectKey, query: text,
        startSeq: Number.isSafeInteger(event.seq) ? event.seq : latest.seq,
        turnId: event.data?.turnId ?? event.turnId,
      })
      if (observed) {
        observed.private ||= messages.filter(isUserQuestionMessage).some(message => privateRecallQuery(textOf(message)))
        const time = sourceEventTime(event.time)
        if (time !== undefined) observed.questionAt = Math.min(time, observed.questionAt ?? time)
      }
    }
    return
  }
  if (event?.type === 'assistant/message') {
    const text = visibleAssistantText(event)
    if (turn && text !== null && generations.get(sessionId) === turn.generation &&
        (!Number.isSafeInteger(turn.startSeq) || !Number.isSafeInteger(event.seq) || event.seq >= turn.startSeq)) {
      turn.assistantText = text
      turn.private ||= looksSensitive(text)
      turn.turnId ??= event.data?.turnId ?? event.turnId
    }
    return
  }
  if (event?.type !== 'turn/end') return
  if (turn !== undefined && generations.get(sessionId) === turn.generation) {
    const eventSeq = Number.isSafeInteger(event.seq) ? event.seq : undefined
    const eventTurnId = event.data?.turnId ?? event.turnId
    if ((Number.isSafeInteger(turn.startSeq) && Number.isSafeInteger(eventSeq) && eventSeq < turn.startSeq) ||
        (turn.turnId !== undefined && eventTurnId !== undefined && turn.turnId !== eventTurnId)) return
    const cwd = typeof session?.header?.cwd === 'string' ? session.header.cwd : undefined
    const projectKey = cwd ? projectIdentity(cwd).key : null
    const report = reports.get(sessionId)
    if (report && report.outcome === 'pending' && report.turnKey === turn.turnKey &&
        report.projectKey === turn.projectKey && report.projectKey === projectKey) {
      const completed = event.data?.reason?.kind === 'completed'
      const answerObserved = typeof turn.assistantText === 'string' && turn.assistantText.trim() !== ''
      const questions = report.questions.map(question => completed
        ? { ...question, answerObserved, ...assessAnswerCoverage(question, turn.assistantText, report.questions) }
        : { ...question, answerObserved, answerCoverage: 'aborted', answerExcerpt: null })
      const questionResult = report.quantityCheck ? { ...report.quantityCheck,
        answerCoverage: !completed ? 'aborted' : report.quantityCheck.result === null
          ? unsupportedQuantityResult(report.quantityCheck, turn.assistantText) ? 'unverified' : 'no-evidence'
          : quantityResultCovered(report.quantityCheck, turn.assistantText) ? 'covered' : 'unverified',
      } : null
      const finalized = { ...report, outcome: completed ? 'completed' : 'aborted', questions,
        ...(questionResult ? { quantityCheck: questionResult } : {}) }
      let persisted
      try { if (!turn.private) persisted = persistReport?.(sessionId, finalized) }
      catch (error) { logger?.warn?.(`[dsh-memory] recall report save failed: ${error instanceof Error ? error.message : String(error)}`) }
      if (persisted === false) reports.delete(sessionId)
      else setRecallReport(reports, sessionId, finalized)
    }
  }
  if (turns.get(sessionId) === turn) turns.delete(sessionId)
}

function isRecallQuestion(query) {
  return RECALL_QUESTION_PATTERN.test(String(query ?? ''))
}

function openingContinuationSubject(query, session, step) {
  if (isRecallQuestion(query) || (step !== undefined && step !== 1)) return null
  const subject = /^(?:(?:继续|接着)(?:改(?:一下)?|做|处理|调整|优化|完善)?\s*|(?:continue|resume|get back to)\s+(?:(?:working on|with|the)\s+)*)([\p{L}\p{N}][\p{L}\p{N} ._/-]{1,47})[。.!！]?$/iu.exec(query)?.[1]?.trim()
  if (!subject || typeof session?.snapshotEvents !== 'function' ||
      session.inheritedEventCount > 0 || !Number.isInteger(session.seq) || session.seq > 64) return null
  // The native log survives reopening and compaction. The incoming user message
  // may still be in the claimed batch when the first pre-step runs.
  const events = session.snapshotEvents(0, session.seq)
  if (events.some(event => ['step/start', 'assistant/message', 'turn/end'].includes(event.type))) return null
  return events.filter(event => event.type === 'user/message' && isUserQuestionMessage({
    role: 'user', source: event.data?.source ?? event.data?.message?.source,
  })).length <= 1 ? subject : null
}

export function isSafeRecallRecord(record, projectKey, timeIntent, now) {
  if (!record || typeof record.id !== 'string' || record.quoted === true || looksSensitive(record.content)) return false
  if (record.scope === 'project' ? record.projectKey !== projectKey : record.scope !== 'global') return false
  return matchesRecallTime(record, timeIntent, now)
}

function matchesRecallTime(record, timeIntent, now = timeIntent.at) {
  if (timeIntent.kind === 'current') {
    return record.status === 'active' && (record.validFrom == null || record.validFrom <= now) &&
      (record.validTo == null || record.validTo > now)
  }
  if (timeIntent.kind === 'history') return record.status === 'superseded'
  return ['active', 'superseded'].includes(record.status) && isEffectiveAt(record, timeIntent.at)
}

function recallSearchOptions(projectKey, timeIntents, now) {
  const historical = timeIntents.some(time => time.kind !== 'current')
  const supersededOnly = historical && timeIntents.every(time => time.kind === 'history')
  return {
    statuses: supersededOnly ? ['superseded'] : historical ? ['active', 'superseded'] : ['active'],
    includeExpired: historical,
    scopes: ['project', 'global'], projectKey, now, limit: 40,
    // A different effective period must not consume the date-specific result page.
    eligible: historical && !supersededOnly ? record => timeIntents.some(time => matchesRecallTime(record, time, now)) : undefined,
  }
}

function recallCandidatePool({ plans, index, knowledgeIndex, passageIndex, semanticLists = [], store, projectKey, now }) {
  const lanesByAttempt = plans.map((plan, i) => {
    const query = plan.searchQuery ?? plan.query
    const time = plan.timeIntent
    const lanes = [index.search(query, recallSearchOptions(projectKey, [time], now))]
    if (time.kind === 'current') lanes.push(knowledgeIndex.search(query, { projectKey, now, limit: 40 }),
      passageIndex.search(query, { projectKey, now, limit: 40 }))
    lanes.push(semanticLists[i] ?? [])
    return lanes
  })
  const validSourceHits = new Set(passageIndex.validateMany(
    lanesByAttempt.flat(2).filter(hit => hit.record.kind === 'source'), projectKey, { now },
  ))
  const allowed = (hit, times) => {
    const record = hit.record
    return times.some(time => isSafeRecallRecord(record, projectKey, time, now)) &&
      (record.kind !== 'knowledge' || knowledgeIndex.validate(hit, projectKey, now)) &&
      (record.kind !== 'source' || validSourceHits.has(hit))
  }
  const lists = lanesByAttempt.map((lanes, attemptIndex) => {
    const times = [plans[attemptIndex].timeIntent]
    const fused = new Map()
    for (const lane of lanes) lane.forEach((hit, rank) => {
      if (!allowed(hit, times)) return
      const old = fused.get(hit.record.id)
      fused.set(hit.record.id, { ...hit, score: (old?.score ?? 0) + 1 / (60 + rank),
        semanticScore: hit.semantic ? hit.score : 0 })
    })
    return [...fused.values()].sort((a,b) => b.score-a.score)
  })
  // Allocate candidates to every question before filling secondary choices.
  const byId = new Map()
  for (let rank = 0; rank < 40; rank++) lists.forEach((list, index) => {
    const hit = list[rank]
    if (!hit) return
    let candidate = byId.get(hit.record.id)
    if (!candidate) {
      if (byId.size >= 48) return
      candidate = { ...hit, matchesByQuery: new Map() }
      byId.set(hit.record.id, candidate)
    }
    candidate.matchesByQuery.set(plans[index].query, hit)
  })
  // Compatibility fallback while the local vector cache is still warming.
  const timeIntents = plans.map(plan => plan.timeIntent)
  for (const record of [...store.list('project', projectKey).slice(0,80), ...store.list('global',null).slice(0,80)]) {
    if (byId.size >= 48) break
    const hit = { record, score: -1, matched: [], termScores: [] }
    if (!byId.has(record.id) && allowed(hit, timeIntents)) byId.set(record.id, hit)
  }
  return [...byId.values()]
}

function knowledgeSlot(plan, record) {
  if (record.kind !== 'knowledge' || plan.requiresRelationTrace || plan.detail === 'event-date') return plan
  const alias = matchKnowledgeAlias(plan.query, record)
  if (!alias) return plan
  const { query } = alias
  const expanded = recallQueryPlan(query, undefined, false, { calendar: false })
  const shape = expanded.find(item => item.role === plan.role && item.detail === plan.detail) ?? expanded[0]
  return { ...plan, query, entityTerms: shape?.entityTerms ?? plan.entityTerms }
}

function eventDateProof(hit, plan) {
  if (plan.eventOrder) return calendarOrderEvidence(hit.record, plan.eventOrder, plan.query, plan.entityTerms)
  const linked = hit.calendarLinks?.find(link => link.query === plan.query)
  if (linked) return linked.proof
  const record = hit.calendarLinks?.length
    ? { ...hit.record, recallQuote: undefined, sourceRefs: hit.record.sourceRefs.slice(0, 1) }
    : hit.record
  return calendarEventEvidence(record, plan.query, plan.entityTerms, { allowReturnBounds: true, personalSince: plan.personalSince })
}

function asksForEffectiveKnowledge(plan) {
  return explicitlyAsksCurrentTime(plan.query) || (plan.timeIntent ?? recallTimeIntent(plan.query)).kind !== 'history'
}

function asksForHistoricalKnowledge(plan) {
  return plan.timeIntent?.kind === 'history' && Boolean(plan.detail && plan.entityTerms?.length) &&
    !explicitlyAsksCurrentTime(plan.query) &&
    /旧版|上一版|原来|以前|曾经|之前|此前|\b(?:previously|previous version|used to|before the change)\b/iu.test(plan.query)
}

const ADJACENT_PROPERTY_DETAILS = new Set(['name', 'floor', 'clock', 'retention', 'reason'])
const ORIGINAL_REFERENCE = /^(?:it|its)\b|^(?:它|该(?<object>设备|快照|任务|服务|系统|作业|路由器|组件|模块|主机|日志|队列|策略))/iu
const POSSIBLE_OTHER_OBJECT = /[,，:：;；"“”]|\b(?:and|or|both|with|alongside|replac(?:e[ds]?|ing)|compared|versus)\b|、|以及|或者|还有|另外|另一|同时|与|和|替代|更换|相比/u
const UNCERTAIN_REFERENCE = /(?:可能|假设|比如|例如|预计|试算|拟定|计划|曾经|以前|从前|拟将|停用|下线|(?:不|未)(?:再|会|执行|保留|确定|确认))|\b(?:if|unless|suppose|imagine|might|maybe|perhaps|could|would|planning|hypothetical|previously|used to|formerly|not|never|disabled)\b|n['’]t\b/iu

function canUseAdjacentProperty(plan) {
  return plan.timeIntent?.kind === 'current' && !plan.requiresRelationTrace &&
    (ADJACENT_PROPERTY_DETAILS.has(plan.detail) || recallUnitProperty(plan.query) === 'display')
}

function supportsAdjacentProperty(plan, hit, anchors) {
  const { kind, content, sourceRefs } = hit.record
  if (kind !== 'source' || anchors.length === 0 || !canUseAdjacentProperty(plan) ||
      sourceRefs?.length !== 1 || content.length > 480) return false
  const sentences = sourceSentences(content)
  const [named, referred] = sentences
  if (sentences.length !== 2) return false
  const reference = ORIGINAL_REFERENCE.exec(referred)
  const object = reference?.groups.object
  if (!reference || object && !named.includes(object) ||
      POSSIBLE_OTHER_OBJECT.test(named.toLowerCase()) || UNCERTAIN_REFERENCE.test(named) ||
      UNCERTAIN_REFERENCE.test(referred.split(/因为|由于|\bbecause\b/iu, 1)[0]) ||
      !sentences.every(isRecallSourceStatement)) return false
  if (!sourceQuoteStartsAtSentence(sourceRefs[0], content)) return false
  const candidate = text => ({ ...hit, record: { ...hit.record, content: text } })
  return matchesRecallEntity(candidate(named), anchors) &&
    matchesRecallAttribute(candidate(referred), plan.query, plan.detail, [])
}

export function slotEvidence(plan, hits, hasSubquestions) {
  return hits.filter(hit => {
    const slot = knowledgeSlot(plan, hit.record)
    if (hit.candidateSlots?.includes(plan.query)) return false
    if (slot.stateField && hit.record.kind === 'source') return hit.selectedSlots?.includes(plan.query) === true
    if (slot.timeMeasure && hit.record.kind === 'source' && hit.record.sourceRefs[0]?.eventTime > slot.timeIntent?.at) return false
    if (slot.eventWindow && hit.record.kind === 'source') return hit.eventWindowProof === slot.query
    const historicalNote = hit.record.kind === 'knowledge' && asksForHistoricalKnowledge(slot)
    if (historicalNote) {
      if (hit.record.status !== 'active' || !hit.record.notePassages?.some(passage => isHistoricalKnowledgeSection(passage.section))) return false
    } else if (slot.timeIntent && !matchesRecallTime(hit.record, slot.timeIntent)) return false
    if (!hasSubquestions && slot.coverageRequired === false) return true
    const quote = hit.record.recallQuote ?? (hit.record.kind === 'knowledge' ? hit.record.noteQuote : undefined)
    const evidence = typeof quote === 'string'
      ? { ...hit, record: { ...hit.record, content: quote } }
      : hit
    const effectiveKnowledge = hit.record.kind === 'knowledge' && asksForEffectiveKnowledge(slot)
    const dated = slot.timeIntent?.kind === 'as-of'
    const passages = hit.record.kind === 'knowledge' ? hit.record.notePassages ?? [] : []
    const projectTerms = recallNamedProjectTerms(slot.query)
    if (conflictsRecallProject(hit.record.kind === 'knowledge' ? evidence : hit, projectTerms)) return false
    if (slot.personalQuestion?.receivedGift) {
      const { kind, content, sourceRefs } = evidence.record
      return (kind !== 'source' || (sourceRefs?.length === 1 && sourceQuoteStartsAtSentence(sourceRefs[0], content) &&
        !(sourceRefs[0].eventTime > slot.timeIntent?.at))) &&
        personalSourceEvidence(slot.personalQuestion, content)
    }
    if (slot.stateField) return Boolean(stateFieldEvidence(slot.stateField, evidence.record.content)?.value)
    if (slot.detail === 'event-date') return eventDateProof(hit, slot) !== null
    if (slot.requiresRelationTrace) {
      if (effectiveKnowledge && !isCurrentKnowledgeQuote(hit.record, quote, dated)) return false
      if (!Array.isArray(slot.bridgeTerms) || slot.bridgeTerms.length === 0) return false
      const clauses = String(evidence.record.content ?? '').split(/[;；。！？!?\n]+/u)
      const connected = clauses.some(clause => {
        const text = clause.toLowerCase()
        if (slot.relationType === 'decision-reason') {
          return slot.bridgeTerms.every(term => text.includes(term.toLowerCase())) &&
            slot.bridgeTerms.every(term => recallHasDecisionReasonEvidence(clause, term))
        }
        const relationMatches = slot.relationCueGroups?.length
          ? slot.relationCueGroups.every(group => group.some(term => text.includes(term)))
          : slot.relationTerms.every(term => text.includes(term.toLowerCase()))
        return slot.bridgeTerms.every(term => text.includes(term.toLowerCase())) && relationMatches &&
          slot.bridgeTerms.every(term => recallHasHandoffEvidence(clause, term))
      })
      if (!connected) return false
      if (hit.selectedSlots?.includes(plan.query)) return true
      const anchors = recallAnchorTerms(slot.query)
      return anchors.length === 0 || matchesRecallEntity(evidence, anchors)
    }
    if (hit.selectedSlots?.includes(plan.query)) return true
    const anchors = recallAnchorTerms(slot.query)
    const subjects = slot.role === 'subquestion' ? slot.entityTerms : recallSubjectTerms(slot.query)
    const supports = evidenceHit => {
      if (slot.declaredCount) return declaredCountFacts(slot.declaredCount, evidenceHit.record.content).length > 0
      if (slot.quantity) return quantityEvidence(slot, evidenceHit.record.content) !== null
      if (slot.timeMeasure) return timeMeasureEvidence(slot.timeMeasure, evidenceHit.record.content) !== null
      if (slot.personalQuestion && evidenceHit.record.kind === 'source') {
        const { content, sourceRefs } = evidenceHit.record
        return sourceRefs?.length === 1 && sourceQuoteStartsAtSentence(sourceRefs[0], content) &&
          !(slot.personalQuestion.adviceTopic && sourceRefs[0].eventTime > slot.timeIntent?.at) &&
          (personalSourceEvidence(slot.personalQuestion, content) ||
            adjacentAdviceEvidence(slot.personalQuestion, slot.query, sourceRefs[0], content))
      }
      if (supportsAdjacentProperty(slot, evidenceHit, anchors)) return true
      if (anchors.length === 0 && subjects.length > 0) {
        const text = String(evidenceHit.record.content).toLowerCase()
        const matched = subjects.filter(term => text.includes(term.toLowerCase())).length
        if (matched / subjects.length < 0.6) return false
      }
      return (anchors.length === 0 || matchesRecallEntity(evidenceHit, anchors)) &&
        matchesRecallAttribute(evidenceHit, slot.query, slot.detail, anchors)
    }
    if (!passages.length || typeof quote !== 'string') {
      return (!effectiveKnowledge || isCurrentKnowledgeQuote(hit.record, quote, dated)) && supports(evidence)
    }
    return passages.some(passage => {
      if (!quote.includes(passage.quote)) return false
      if (passage.verified === false || (passage.question !== undefined && passage.question !== plan.query)) return false
      const historical = isHistoricalKnowledgeSection(passage.section, dated ? hit.record.noteTitle : undefined)
      if ((effectiveKnowledge && historical) || (historicalNote && !historical)) return false
      const row = { ...evidence, record: { ...evidence.record, content: passage.quote } }
      if (conflictsRecallProject(row, projectTerms)) return false
      if (passage.question === plan.query) return true
      const tableValue = slot.detail === 'retention' ? passage.retention : slot.detail === 'reason' ? passage.tableReason : undefined
      if (passage.tableHeader && tableValue !== undefined) {
        if (!passage.tableSubject || !tableValue) return false
        const label = slot.detail === 'retention' ? '保留期限' : '原因'
        return supports({ ...evidence, record: { ...evidence.record, content: `${passage.tableSubject}，${label}：${tableValue}` } })
      }
      if (supports(row)) return true
      if (!passage.section || (!slot.quantity && !matchesRecallAttribute(row, slot.query, slot.detail, []))) return false
      // The heading identifies an unlabeled row. The row still has to
      // provide the requested value or reason.
      return supports({ ...row, record: { ...row.record, content: passage.section + '，' + passage.quote } })
    })
  })
}

function keepRecallHit(byId, hit) {
  const previous = byId.get(hit.record.id)
  const best = !previous || hit.score > previous.score ? hit : previous
  if (hit.record.kind === 'knowledge' && previous && previous.record.noteDigest === hit.record.noteDigest) {
    const passages = item => item.record.notePassages ?? []
    const notePassages = [...new Map([...passages(previous), ...passages(hit)]
      .map(passage => [JSON.stringify([passage.question, passage.section, passage.tableHeader, passage.quote]), passage])).values()]
    if (notePassages.length > 0) {
      const recallQuote = [...new Set(notePassages.map(passage => passage.quote))].join('\n')
      const matchedNoteAlias = best.record.matchedNoteAlias ?? previous.record.matchedNoteAlias ?? hit.record.matchedNoteAlias
      const candidateSlots = [...new Set([...(previous.candidateSlots ?? []), ...(hit.candidateSlots ?? [])])]
      const unverifiedRecall = notePassages.every(passage => passage.verified === false)
      const previousTimes = previous.record.noteReferenceTimes, newTimes = hit.record.noteReferenceTimes
      const noteReferenceTimes = previousTimes || newTimes ? [...new Set([...(previousTimes ?? [null]), ...(newTimes ?? [null])])] : undefined
      byId.set(hit.record.id, { ...best, candidateSlots,
        record: { ...best.record, notePassages, recallQuote, matchedNoteAlias, unverifiedRecall, noteReferenceTimes } })
      return
    }
  }
  byId.set(hit.record.id, best)
}

function sameRelationScope(left, right, projectKey) {
  if (left?.scope !== right?.scope) return false
  if (left.scope === 'global') return true
  return left.scope === 'project' && left.projectKey === projectKey && right.projectKey === projectKey
}

function selectionFitsSlot(slot, candidate, quote) {
  const hit = { record: { ...candidate.record, content: quote } }
  if (conflictsRecallProject(candidate, recallNamedProjectTerms(slot.query))) return false
  if (slot.personalQuestion && (slot.personalQuestion.receivedGift || candidate.record.kind === 'source')) {
    const record = { ...candidate.record, recallQuote: quote }
    return slotEvidence(slot, [{ record }], true).length > 0
  }
  // A verbatim citation has to support the requested subject and property.
  if (slot.detail && slot.detail !== 'event-date' && !slot.quantity && !slot.requiresRelationTrace) {
    const record = { ...candidate.record, recallQuote: quote, notePassages: [] }
    return slotEvidence(slot, [{ record }], true).length > 0
  }
  if (candidate.record.kind === 'knowledge' && asksForEffectiveKnowledge(slot) &&
      !isCurrentKnowledgeQuote(candidate.record, quote, slot.timeIntent?.kind === 'as-of')) return false
  if (slot.detail === 'event-date') return eventDateProof({ record: { ...hit.record, recallQuote: quote } }, slot) !== null
  if (slot.quantity) return quantityEvidence(slot, quote) !== null
  if (slot.requiresRelationTrace) return slotEvidence(slot, [hit], true).length > 0
  if (recallUnitProperty(slot.query)) return slotEvidence(slot, [hit], true).length > 0
  // A verified model selection can connect paraphrases without shared words.
  // Specific value/property questions retain their stricter entity/unit checks.
  if (candidate.semantic && !slot.detail && !/版本|多少|多久|数量|阈值|上限|下限|\bversion\b|how many|how much|limit|threshold/iu.test(slot.query)) return true
  if (NAMED_OBJECT_PATTERN.test(slot.query)) {
    if (!matchesRecallEntity(hit, slot.entityTerms)) return false
    return matchesRecallAttribute(hit, slot.query, slot.detail, slot.entityTerms)
  }
  return matchesRecallAttribute(hit, slot.query, slot.detail, [])
}

export function directPassageEvidence(plan, hit, hasSubquestions, acceptsQuote = null) {
  const whole = hit.record.content
  if (plan.stateField) {
    const proof = stateFieldEvidence(plan.stateField, whole)
    if (!proof || conflictsRecallProject(hit, recallNamedProjectTerms(plan.query))) return null
    if (proof.conflicting) return { ...hit, stateFieldConflict: true }
    if (!isRecallSourceStatement(proof.quote)) return null
    return { ...hit, stateFieldValue: proof.value, record: { ...hit.record, recallQuote: proof.quote } }
  }
  if (plan.declaredCount) {
    const facts = declaredCountFacts(plan.declaredCount, whole)
    if (!facts.length || new Set(facts.map(fact => fact.value)).size !== 1 ||
        conflictsRecallProject(hit, recallNamedProjectTerms(plan.query))) return null
    return { ...hit, record: { ...hit.record, recallQuote: facts[0].quote } }
  }
  if (plan.timeMeasure) {
    const proof = timeMeasureEvidence(plan.timeMeasure, whole)
    if (!proof || !isRecallSourceStatement(proof.quote) ||
        hit.record.sourceRefs[0]?.eventTime > plan.timeIntent?.at ||
        conflictsRecallProject(hit, recallNamedProjectTerms(plan.query))) return null
    return measuredPassage(plan, hit, proof)
  }
  if (plan.quantity) {
    const proof = quantityEvidence(plan, whole, { includeRelated: Boolean(plan.quantity.scope) })
    const evidence = proof ? { ...hit, quantityProof: proof, record: { ...hit.record, recallQuote: proof.quote } } : null
    return evidence && isRecallSourceStatement(proof.quote) &&
      (proof.related || slotEvidence(plan, [evidence], hasSubquestions).length > 0) ? evidence : null
  }
  if (plan.detail === 'event-date') {
    const proof = eventDateProof(hit, plan)
    return proof && isRecallSourceStatement(proof.quote) && !conflictsRecallProject(hit, recallNamedProjectTerms(plan.query))
      ? { ...hit, record: { ...hit.record, recallQuote: proof.quote } } : null
  }
  const matches = text => (!acceptsQuote || acceptsQuote(text)) &&
    slotEvidence(plan, [{ ...hit, record: { ...hit.record, recallQuote: text } }], hasSubquestions).length > 0
  const sentences = sourceSentences(whole)
  const startsAtMessage = hit.record.sourceRefs[0]?.from === 0
  // The start of an overlapping passage may be missing a conditional prefix.
  const statements = sentences.map((sentence, index) => sourceStatementExcerpt(sentence, startsAtMessage || index > 0))
  const property = recallUnitProperty(plan.query)
  let quote = statements.filter(Boolean).sort((a, b) => a.length - b.length).find(matches)
  if (!quote && (property === 'network' || canUseAdjacentProperty(plan))) {
    let offset = 0
    for (let index = 0; index + 1 < sentences.length; index++) {
      const first = sentences[index], second = sentences[index + 1]
      const start = whole.indexOf(first, offset)
      offset = start + first.length
      if ((!startsAtMessage && index === 0) || statements[index] !== first || statements[index + 1] !== second) continue
      const end = whole.indexOf(second, offset) + second.length
      const pair = whole.slice(start, end)
      if (pair.length <= 480 && matches(pair)) { quote = pair; break }
    }
  }
  if (!quote && property === null && statements.every((statement, index) => statement === sentences[index]) && matches(whole)) quote = whole
  return quote ? { ...hit, record: { ...hit.record, recallQuote: quote } } : null
}

function adviceQuoteKey(text) {
  return text.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim().replace(/[.!?。！？]+$/u, '')
}

export function findAdviceEvidence(passageIndex, plan, projectKey, {
  maxTokens, maxItems = ADVICE_EVIDENCE_LIMIT, represented = [],
} = {}) {
  const remaining = Math.min(ADVICE_EVIDENCE_LIMIT, maxItems - represented.length)
  if (remaining <= 0) return { matches: [], tokens: 0 }
  const covered = represented.filter(({ record }) => record.unverifiedRecall !== true).map(({ record }) => {
    const statements = sourceSentences(record.recallQuote ?? record.noteQuote ?? record.content).map(adviceQuoteKey)
    const requests = statements.map(line =>
      /\b(?:i|we|the user) (?:asked|am asking|are asking) for (?:suggestions?|recommendations?|advice) (?:for|on|about) (.+)$/u.exec(line)?.[1])
    return { statements, requests, sourceIds: new Set(record.sourceRefs?.map(ref => ref.sourceId)) }
  })
  return passageIndex.findEvidence([plan.query], {
    projectKey, now: plan.timeIntent.at, maxTokens, lookupQuery: () => plan.searchQuery,
    maxMatchesPerQuery: remaining, maxRankedPassages: 40,
    wholeSentences: true, acceptOriginal: true,
    match: (_, hit) => directPassageEvidence(plan, hit, false, text => {
      const quote = adviceQuoteKey(text)
      const subject = /\b(?:looking|shopping|searching) for (.+)$/u.exec(quote)?.[1]
      const sourceId = hit.record.sourceRefs[0].sourceId
      return !covered.some(record => record.statements.includes(quote) ||
        (subject && record.sourceIds.has(sourceId) && record.requests.includes(subject)))
    }),
    distinctKey: (_, hit) => adviceQuoteKey(hit.record.recallQuote),
  })
}

function measuredPassage(plan, hit, proof, at, disputed = false) {
  const { detail, subject, period, mode, language } = plan.timeMeasure
  return { ...hit, record: { ...hit.record, recallQuote: proof.quote,
    recallTimeMeasures: [{ ...proof, query: plan.query, detail, subject, period, mode, at, disputed, language }] } }
}

function distinctMeasurements(rows) {
  const byValue = new Map()
  for (const row of rows) {
    const key = timeMeasureValueKey(row.proof.value)
    const previous = byValue.get(key)
    if (!previous || (row.hit.record.remembered && !previous.hit.record.remembered)) byValue.set(key, row)
  }
  return [...byValue.values()].slice(0, 2)
}

function latestMeasurements(rows) {
  const latest = Math.max(...rows.map(row => row.at))
  return distinctMeasurements(rows.filter(row => row.at === latest))
}

function pickTimeMeasures(plan, rows) {
  const proved = rows.filter(row => !row.proof.unconfirmedVenue)
  if (plan.mode === 'stay' || plan.mode === 'task') return distinctMeasurements(proved)
  const current = latestMeasurements(proved.filter(row => row.proof.period !== 'previous'))
  if (plan.period !== 'previous') return current
  const explicit = latestMeasurements(proved.filter(row => row.proof.period === 'previous'))
  if (explicit.length || current.length !== 1) return explicit
  const currentState = current[0]
  const earlier = rows.filter(row => row.at < currentState.at && row.proof.value !== currentState.proof.value)
  const confirmed = latestMeasurements(earlier.filter(row => !row.proof.unconfirmedVenue))
  return confirmed.length ? confirmed : latestMeasurements(earlier)
}

export function findRecentTimeMeasures(passageIndex, plans, projectKey, now) {
  // A before/after pair scans the same originals once. Distinct subjects split one search budget.
  const groupKey = ({ timeMeasure }) => {
    const { period: _period, ...scope } = timeMeasure
    return JSON.stringify(scope)
  }
  const groupQuery = new Map(), byQuery = new Map()
  for (const plan of plans) {
    const group = groupKey(plan)
    if (groupQuery.has(group)) continue
    groupQuery.set(group, plan.query)
    byQuery.set(plan.query, plan)
  }
  const scan = passageIndex.findEvidence([...byQuery.keys()], {
    projectKey, now, wholeSentences: true, allMatches: true, acceptOriginal: true,
    lookupQuery: query => byQuery.get(query).searchQuery,
    match: (query, hit) => {
      if (conflictsRecallProject(hit, recallNamedProjectTerms(query))) return null
      const { eventTime, at } = hit.record.sourceRefs[0]
      const facts = timeMeasureFacts(byQuery.get(query).timeMeasure, hit.record.content).filter(fact => isRecallSourceStatement(fact.quote))
      return facts.length ? { ...hit, facts, statedAt: eventTime ?? at } : null
    },
    distinctKey: (_, hit) => hit.record.id,
  })
  const sourcesByQuery = new Map()
  for (const { query, hit } of scan.matches) {
    if (!sourcesByQuery.has(query)) sourcesByQuery.set(query, [])
    sourcesByQuery.get(query).push(...hit.facts.map(proof => ({ proof, hit, at: hit.statedAt })))
  }
  const matches = plans.flatMap(plan => {
    if (usesLatestTimeEvidence(plan.timeMeasure) && scan.incomplete) return []
    const chosen = pickTimeMeasures(plan.timeMeasure, sourcesByQuery.get(groupQuery.get(groupKey(plan))) ?? [])
    const disputed = chosen.length > 1
    return chosen.map(({ hit, proof, at }) => ({
      plan, hit: measuredPassage(plan, hit, proof, at, disputed),
      verified: (hit.record.remembered || usesLatestTimeEvidence(plan.timeMeasure)) && !proof.unconfirmedVenue,
    }))
  })
  return { ...scan, matches }
}

function linkedCalendarEvidence(plan, hit, participant, passageIndex, projectKey, now) {
  if (!participant) return null
  const proof = calendarEventEvidence(hit.record, plan.query, plan.entityTerms, { participant })
  if (!proof || !isRecallSourceStatement(proof.quote)) return null
  const anchor = calendarParticipantAnchor(passageIndex.previousMessages(hit, projectKey, { now }), participant)
  if (!anchor || conflictsRecallProject(anchor.hit, recallNamedProjectTerms(plan.query))) return null
  const quote = `${anchor.quote}；${proof.quote}`
  return { ...hit, calendarLinks: [{ query: plan.query, participant, proof: { ...proof, quote }, anchor: anchor.hit }],
    record: { ...hit.record, recallQuote: quote } }
}

function appendPassageEvidence(hitsById, hit, plan, verified = hit.record.remembered) {
  const previous = hitsById.get(hit.record.id)
  const precedingQuote = previous?.record.recallQuote
  const quotes = [...new Set([...(previous?.passageQuotes ?? (precedingQuote ? [precedingQuote] : [])), hit.record.recallQuote])]
  const field = verified ? 'selectedSlots' : 'candidateSlots'
  const calendarLinks = [...(previous?.calendarLinks ?? []), ...(hit.calendarLinks ?? [])]
  const measurements = [...(previous?.record.recallTimeMeasures ?? []), ...(hit.record.recallTimeMeasures ?? [])]
  const saved = { ...hit, ...previous, passageQuotes: quotes,
    record: { ...hit.record, unverifiedRecall: measurements.length > 0 && previous ? previous.record.unverifiedRecall && !verified : !verified,
      recallQuote: quotes.join('；'), ...(measurements.length ? { recallTimeMeasures: measurements } : {}),
      ...(calendarLinks.length ? { sourceRefs: [...new Map([hit.record.sourceRefs[0], ...calendarLinks.map(link => link.anchor.record.sourceRefs[0])]
        .map(ref => [ref.sourceId, ref])).values()] } : {}) },
    ...(calendarLinks.length ? { calendarLinks } : {}),
    [field]: [...new Set([...(previous?.[field] ?? []), plan.query])] }
  hitsById.set(hit.record.id, saved)
  return saved
}

function recallEvidenceReport(hit, filterSourceRefs, noteAuthority) {
  const record = hit.record
  return {
    id: record.id,
    revision: record.revision,
    kind: record.kind,
    scope: record.scope,
    projectKey: record.projectKey ?? null,
    observedAt: record.observedAt ?? null,
    validFrom: record.validFrom ?? null,
    validTo: record.validTo ?? null,
    sourceRefs: filterSourceRefs(record.sourceRefs ?? []).slice(0, 3).map(ref => ({
      sourceId: ref.sourceId, sessionId: ref.sessionId ?? null, messageId: ref.messageId ?? null,
      role: ref.role ?? null, sourceKind: ref.sourceKind ?? null, from: ref.from ?? null,
      to: ref.to ?? null, at: ref.at ?? null, excerpt: ref.excerpt ?? null,
      ...(ref.eventTime === undefined ? {} : { eventTime: ref.eventTime }),
      ...(ref.timeZone ? { timeZone: ref.timeZone } : {}),
    })),
    ...(record.kind === 'knowledge' ? {
      noteFile: record.noteFile, noteTitle: record.noteTitle, updatedAt: record.updatedAt ?? null,
      noteAuthority: noteAuthority(record),
    } : {}),
  }
}

function occurrenceRecallReport({ timeline, identity, query, turnKey, now, semantic, hits, injected }) {
  const delivered = new Set(injected.map(item => item.id))
  const evidence = items => items.length ? [{ query, evidence: items }] : []
  if (timeline.counterSlots) {
    const questions = counterReportQuestions(timeline.counterSlots, hits, injected)
    const items = field => questions.filter(question => question[field].length)
      .map(question => ({ query: question.query, evidence: question[field] }))
    const missing = questions.filter(question => !question.injected.length).map(question => question.query)
    return { at: now, projectKey: identity.key, turnKey, outcome: 'pending', total: questions.length, questions,
      quantityCheck: timeline.quantityCheck, retrieved: items('hits'), covered: items('injected'), candidates: [],
      missing, unresolved: missing, budgetOmitted: timeline.budgetOmitted ? missing : [], deferred: [],
      providerState: 'not-needed', completionState: 'not-needed', provider: null, usage: null,
      estimatedPromptTokens: null, reason: null, semantic,
      localDeepRecall: { queries: questions.map(question => question.query), tokens: timeline.scannedTokens, limit: DEEP_RECALL_TOKEN_LIMIT } }
  }
  return {
    at: now, projectKey: identity.key, turnKey, outcome: 'pending', total: 1,
    questions: [{
      query, entityTerms: [], ...(timeline.expenses !== undefined
        ? { detail: 'dated-expenses', expenses: timeline.expenses }
        : timeline.personalFundraising !== undefined
        ? { detail: 'personal-fundraising', personalFundraising: timeline.personalFundraising }
        : timeline.marketSales !== undefined
        ? { detail: 'market-sales', marketSales: timeline.marketSales }
        : timeline.count
        ? { detail: 'event-count', eventCount: timeline.count }
        : timeline.duration ? { detail: 'duration-at-event', durationAtEvent: timeline.duration }
          : timeline.eventAge ? { detail: 'event-age', eventAge: timeline.eventAge }
            : timeline.eventLocation ? { detail: 'event-location', eventLocation: timeline.eventLocation }
              : timeline.declaredCount ? { detail: 'declared-count', declaredCount: timeline.declaredCount }
                : timeline.elapsed !== undefined ? { detail: 'elapsed-interval', elapsed: timeline.elapsed }
                  : { detail: 'timeline', timeline: { complete: timeline.complete, order: timeline.order } }),
      hits, injected, notInjected: hits.filter(item => !delivered.has(item.id)),
      answerCoverage: 'pending', answerExcerpt: null,
    }],
    retrieved: evidence(hits), covered: evidence(timeline.complete ? injected : []), candidates: [],
    missing: injected.length && (!timeline.declaredCount || timeline.complete) ? [] : [query],
    unresolved: timeline.complete ? [] : [query],
    budgetOmitted: timeline.budgetOmitted ? [query] : [], deferred: [],
    providerState: 'not-needed', completionState: 'not-needed',
    provider: null, usage: null, estimatedPromptTokens: null, reason: null, semantic,
    localDeepRecall: { queries: [query], tokens: timeline.scannedTokens, limit: DEEP_RECALL_TOKEN_LIMIT },
  }
}

function verifiedKnowledgeConflicts(conflicts, hitsById) {
  return conflicts.flatMap(({ query, entries }) => {
    const current = entries.filter(({ hit }) => hitsById.get(hit.record.id)?.record.noteDigest === hit.record.noteDigest)
    const members = [...new Set(current.map(({ hit }) => hit.record.id))]
    const alternatives = new Map()
    for (const { hit, key, value, quote } of current) {
      const id = hit.record.id
      const displayed = formatMemoryLine(hitsById.get(id).record).normalize('NFKC').replace(/\s+/gu, ' ')
      if (!alternatives.has(key) || alternatives.get(key).id === null) {
        alternatives.set(key, { id: displayed.includes(quote.normalize('NFKC').replace(/\s+/gu, ' ')) ? id : null, value })
      }
    }
    return members.length > 1 && alternatives.size > 1 ? [{ query, members, alternatives: [...alternatives.values()] }] : []
  })
}


export function createRecallFlow({ ctx, getConfig, root, store, index, runtime, passageIndex,
  recallReportStore, capture, knowledgeIndex, sourceIndex, semanticIndex, hookHealth,
  recallObserver, resolveSessionProjectKey }) {
  const config = new Proxy({}, { get: (_target, key) => getConfig()?.[key] })
  let lastInjection = null
  let recallAttempts = 0
  let recallFailures = 0
  let lexicalRuns = 0
  let lexicalFailures = 0
  let injectionCount = 0
  const lastRecallBySession = new Map()
  const recallTurnBySession = new Map()
  const recallGenerationBySession = new Map()
  const contextUsageBySession = new Map()
  const noteAuthority = record => {
    if (!record.memoryId) return null
    const { parent } = knowledgeAuthority(store, { refresh: false })(record)
    return parent ? { id: parent.id, scope: parent.scope, projectKey: parent.projectKey, revision: parent.revision }
      : { id: record.memoryId, scope: record.scope, projectKey: record.projectKey }
  }
  const invalidateReferences = targets => {
    const affected = recallReportStore?.invalidateReferences(targets) ?? new Set()
    for (const [sessionId, report] of lastRecallBySession) {
      if (affected.has(recallReportSessionKey(sessionId)) || recallReportReferences(report, targets)) lastRecallBySession.delete(sessionId)
    }
    for (const [sessionId, turn] of recallTurnBySession) {
      const references = turn.evidenceRefs ?? []
      if (recallReportReferences(references, targets) || turn.recallInProgress && references.length === 0 && targets.reason === 'delete') {
        turn.invalidated = true
        lastRecallBySession.delete(sessionId)
      }
    }
    passageIndex?.invalidateSources(targets.sourceIds)
    return affected
  }
  const registerHooks = () => {
  try {
    ctx.on('session/event', (session, event) => {
      hookHealth.events++
      try {
        completeRecallTurn(lastRecallBySession, recallTurnBySession, recallGenerationBySession, session, event,
          (sessionId, report) => recallReportStore.write(sessionId, report.projectKey, report), ctx.logger)
      } catch (error) {
        ctx.logger?.warn?.(`[dsh-memory] recall report update failed: ${error instanceof Error ? error.message : String(error)}`)
      }
      const source = event?.data?.source ?? event?.data?.message?.source
      if (event?.type === 'user/message' && (source === undefined || source === null || source.kind === 'user')) hookHealth.userMessages++
      try {
        capture.observe(session, event)
      } catch (error) {
        ctx.logger?.warn?.(`[dsh-memory] capture skipped: ${error instanceof Error ? error.message : String(error)}`)
      }
    })
    hookHealth.sessionEventRegistered = true
  } catch { hookHealth.sessionEventRegistered = false }

  try {
    ctx.on('agent/pre-step', async (payload, next) => {
    const payloadMessages = Array.isArray(payload?.messages) ? payload.messages : []
    const preStepSession = sessionOf(ctx, payload?.agent)
    const preStepSessionId = typeof preStepSession?.id === 'string' ? preStepSession.id : undefined
    const preStepUser = [...payloadMessages].reverse().find(isUserQuestionMessage)
    const preStepQuery = textOf(preStepUser).trim()
    const preStepPreviousUser = payloadMessages.slice(0, Math.max(0, payloadMessages.lastIndexOf(preStepUser)))
      .findLast(message => isUserQuestionMessage(message) && !isMemoryMessage(message) && textOf(message).trim() !== '')
    const preStepPreviousQuery = preStepPreviousUser ? textOf(preStepPreviousUser).trim() : undefined
    const preStepCwd = typeof preStepSession?.header?.cwd === 'string' ? preStepSession.header.cwd : undefined
    const preStepTurn = preStepSessionId !== undefined && preStepCwd !== undefined && preStepQuery !== ''
      ? beginRecallTurn(lastRecallBySession, recallTurnBySession, recallGenerationBySession, preStepSessionId, {
        turnKey: turnKeyOf(preStepUser, payloadMessages, preStepQuery, preStepPreviousQuery),
        projectKey: projectIdentity(preStepCwd).key,
        query: preStepQuery,
        startSeq: preStepUser?.seq,
        turnId: payload?.turnId,
      }) : null
    const preStepGeneration = preStepTurn?.generation
    if (preStepTurn !== null) preStepTurn.recallInProgress = true
    hookHealth.preSteps++
    let decision
    let activeRecallGeneration = preStepGeneration
    try { decision = await next() } catch (error) {
      if (preStepTurn !== null) preStepTurn.recallInProgress = false
      recallFailures++
      throw error
    }
    if (decision === null || typeof decision !== 'object' || decision.kind !== 'enter') {
      if (preStepTurn !== null) preStepTurn.recallInProgress = false
      return decision
    }

    const decidedMessages = Array.isArray(decision.messages) ? decision.messages : payloadMessages
    const previous = decidedMessages.filter(isMemoryMessage)
    const retained = decidedMessages.filter((message) => !isMemoryMessage(message))
    const withoutPrevious = previous.length === 0 ? decision : { ...decision, messages: retained }

    let sessionId
    let deliveredBlock = null
    let contextBudget = config.inject.maxTokens
    try {
      if (payload?.signal?.aborted === true) return withoutPrevious
      const session = sessionOf(ctx, payload?.agent)
      sessionId = typeof session?.id === 'string' ? session.id : undefined
      const remembering = capture.waitForRemembering(session, payloadMessages)
      if (remembering) await remembering
      if (!config.inject.enabled) return withoutPrevious
      recallAttempts++
      if (preStepCwd) runtime.synchronize(projectIdentity(preStepCwd).key)

    const cwd = typeof session?.header?.cwd === 'string' ? session.header.cwd : undefined
    if (cwd === undefined) return withoutPrevious

    const userTexts = []
    let latestUserMessage = null
    for (let i = payloadMessages.length - 1; i >= 0 && userTexts.length < 2; i -= 1) {
      const message = payloadMessages[i]
      if (!isUserQuestionMessage(message) || isMemoryMessage(message)) continue
      const text = textOf(message).trim()
      if (text !== '') {
        userTexts.push(text)
        latestUserMessage ??= message
      }
    }
    const query = userTexts[0] ?? ''
    if (query === '' || isBareRemember(query) || looksSensitive(query)) return withoutPrevious
    const identity = projectIdentity(cwd)
    const availableMemoryTokens = await memoryBudgetFor(ctx, {
      agent: payload.agent, session, selection: payload.modelSelection, messages: retained,
      maxTokens: config.inject.maxTokens, signal: payload.signal,
    })
    contextBudget = availableMemoryTokens
    if (availableMemoryTokens === 0 || payload.signal?.aborted) return withoutPrevious
    const previousQuery = privateRecallQuery(userTexts[1]) ? undefined : userTexts[1]
    const turnKey = turnKeyOf(latestUserMessage, payloadMessages, query, previousQuery)
    const activeTurn = sessionId === undefined ? null : beginRecallTurn(lastRecallBySession, recallTurnBySession, recallGenerationBySession, sessionId, {
      turnKey, projectKey: identity.key, query, startSeq: latestUserMessage?.seq, turnId: payload?.turnId,
    })
    if (preStepGeneration !== undefined && activeTurn?.generation !== preStepGeneration) return withoutPrevious
    const turnGeneration = activeTurn?.generation
    if (activeTurn !== null) activeTurn.recallInProgress = true
    activeRecallGeneration = turnGeneration
    const controls = analyzeUserMessageControls(query)
    const followUp = previousQuery !== undefined && isFollowUpQuery(controls.retrievalQuery)
    const openingSubject = config.inject.openingProjectKey === identity.key && userTexts.length === 1
      ? openingContinuationSubject(controls.retrievalQuery, session, payload.step) : null
    let originalsPrepared = false
    const prepareOriginals = async ({ requireReady = false } = {}) => {
      if (!originalsPrepared) {
        const prepared = await passageIndex.prepare(identity.key, payload.signal)
        originalsPrepared = prepared || !requireReady
      }
      return originalsPrepared && !payload.signal?.aborted && !activeTurn?.invalidated
    }

    const now = Date.now()
    const deliver = (block, { beforeQuestion, gate }) => {
      if (recallObserver !== null) traceRecall(recallObserver, {
        phase: 'inject', status: 'injected', ids: block.ids, text: block.text, tokens: block.estimatedTokens, budget: contextBudget,
      })
      appendUsage(root, { at: now, kind: 'inject', tokens: block.estimatedTokens, items: block.itemCount, budget: contextBudget })
      lastInjection = { at: now, tokens: block.estimatedTokens, items: block.itemCount, budget: contextBudget, followUp, gate }
      injectionCount++
      const context = makeMemoryMessage(block.text)
      const position = beforeQuestion
        ? retained.findLastIndex(message => isUserQuestionMessage(message) && textOf(message).trim() !== '') : -1
      deliveredBlock = block
      return { ...decision, messages: position < 0 ? [...retained, context]
        : [...retained.slice(0, position), context, ...retained.slice(position)] }
    }
    const deliverOriginalReport = timeline => {
      if (payload.signal?.aborted || activeTurn?.invalidated) return withoutPrevious
      const proofs = new Map(timeline.hits.map(hit => [hit.record.id, {
        ...recallEvidenceReport(hit, refs => recallReportStore.filterSourceRefs(refs), noteAuthority), verified: true,
      }]))
      if ([...proofs.values()].some(proof => proof.kind === 'source' && !proof.sourceRefs.length)) return withoutPrevious
      const hits = [...proofs.values()]
      const injected = timeline.injected.map(({ row, period, text, selectedQuote }) => ({
        ...proofs.get(row.hit.record.id), text, ...(period ? { eventPeriod: period } : {}),
        ...(selectedQuote ? { selectedQuote } : {}),
      }))
      if (activeTurn) {
        activeTurn.evidenceRefs = hits
        setRecallReport(lastRecallBySession, sessionId, occurrenceRecallReport({
          timeline, identity, query, turnKey, now, semantic: semanticIndex.status(), hits, injected,
        }))
      }
      if (!timeline.text) return withoutPrevious
      return deliver({
        ids: [...new Set(injected.map(item => item.id))], profileIds: [], text: timeline.text,
        estimatedTokens: estimateTokens(timeline.text), itemCount: injected.length,
      }, { beforeQuestion: true, gate: { auto: hits.length, gray: 0 } })
    }
    const originalOptions = { projectKey: identity.key, now, maxTokens: availableMemoryTokens,
      maxItems: config.inject.maxItems, scanLimit: DEEP_RECALL_TOKEN_LIMIT, skipCapture: controls.noSaveDirective }
    const elapsed = !followUp ? elapsedQuery(controls.questionText) : null
    if (elapsed) {
      if (!await prepareOriginals()) return withoutPrevious
      const projectTerms = recallNamedProjectTerms(query)
      return deliverOriginalReport(retrieveElapsed(passageIndex, elapsed, {
        ...originalOptions, queryTimeZone: normalizeClientTimeZone(latestUserMessage?.source?.clientTimeZone),
        accepts: hit => !conflictsRecallProject(hit, projectTerms),
      }))
    }
    const sales = !followUp ? marketSalesQuery(controls.questionText) : null
    const fundraising = !followUp && !sales ? personalFundraisingQuery(controls.questionText) : null
    if (sales || fundraising) {
      if (!await prepareOriginals()) return withoutPrevious
      const namedProjects = recallNamedProjectTerms(query)
      const retrieve = sales ? retrieveMarketSales : retrievePersonalFundraising
      return deliverOriginalReport(retrieve(passageIndex, sales ?? fundraising, {
        ...originalOptions,
        accepts: hit => !conflictsRecallProject(hit, namedProjects),
      }))
    }
    const counterGroup = !followUp ? reportedCounterQuery(controls.questionText) : null
    if (counterGroup) {
      if (!await prepareOriginals()) return withoutPrevious
      const namedProjects = recallNamedProjectTerms(query)
      const counters = retrieveReportedCounters(passageIndex, counterGroup, {
        ...originalOptions, standalone: { index, store },
        accepts: hit => isSafeRecallRecord(hit.record, identity.key, { kind: 'current', at: now }, now) &&
          !conflictsRecallProject(hit, namedProjects),
      })
      return deliverOriginalReport(counters)
    }
    const occurrenceClock = {
      eventTime: now, timeZone: normalizeClientTimeZone(latestUserMessage?.source?.clientTimeZone),
    }
    const expenses = !followUp ? expenseQuery(controls.questionText, occurrenceClock) : null
    if (expenses) {
      if (!await prepareOriginals()) return withoutPrevious
      const namedProjects = recallNamedProjectTerms(query)
      return deliverOriginalReport(retrieveExpenses(passageIndex, expenses, {
        ...originalOptions, accepts: hit => !conflictsRecallProject(hit, namedProjects),
      }))
    }
    const timelinePlan = openTimelineQuery(controls.questionText, occurrenceClock)
    const countPlan = timelinePlan ? null : eventCountQuery(controls.questionText, occurrenceClock)
    const durationPlan = timelinePlan || countPlan ? null : durationAtEventQuery(controls.questionText)
    if (timelinePlan || countPlan || durationPlan) {
      if (!await prepareOriginals()) return withoutPrevious
      const retrieve = timelinePlan ? retrieveTimeline : countPlan ? retrieveEventCount : retrieveDurationAtEvent
      return deliverOriginalReport(retrieve(passageIndex, timelinePlan ?? countPlan ?? durationPlan, originalOptions))
    }
    let previousDeepRecall = null
    const agePlan = eventAgeQuery(controls.questionText)
    if (agePlan) {
      if (!await prepareOriginals()) return withoutPrevious
      const namedProjects = recallNamedProjectTerms(query)
      const age = retrieveEventAge(passageIndex, agePlan, { ...originalOptions,
        clock: { ...occurrenceClock, eventTime: Math.min(now, activeTurn?.questionAt ?? now) },
        accepts: hit => !conflictsRecallProject(hit, namedProjects),
      })
      if (age.hits.length || age.budgetOmitted) return deliverOriginalReport(age)
      previousDeepRecall = { queries: [query], tokens: age.scannedTokens, limit: DEEP_RECALL_TOKEN_LIMIT }
    }
    if (!await knowledgeIndex.waitUntilReady(payload.signal) || activeTurn?.invalidated) return withoutPrevious
    const lexicalSearch = (...args) => {
      try {
        const result = index.search(...args)
        lexicalRuns++
        return result
      } catch (error) { lexicalFailures++; throw error }
    }
    let queryPlan = recallQueryPlan(query, previousQuery, followUp)
    const pricePlans = new Map(queryPlan.filter(plan => plan.quantity?.scope?.role === 'item-price').map(plan => [plan.query, plan]))
    let priceScan = null
    const pricesDated = pricePlans.size > 0 && (recallTimeIntent(query, now).kind !== 'current' ||
      [...pricePlans.values()].some(plan => recallTimeIntent(plan.query, now).kind !== 'current'))
    if (pricesDated) {
      queryPlan = recallQueryPlan(query, previousQuery, followUp, { itemPrices: false })
    } else if (pricePlans.size) {
      if (!await prepareOriginals()) return withoutPrevious
      const options = { projectKey: identity.key, now, limit: 40 }
      priceScan = passageIndex.findEvidence([...pricePlans.keys()], {
        projectKey: identity.key, now, wholeSentences: true, acceptOriginal: true,
        lookupQuery: question => pricePlans.get(question).searchQuery,
        match: (question, hit) => hit.record.sourceRefs[0].eventTime > now
          ? null : directPassageEvidence(pricePlans.get(question), hit, true),
        distinctKey: (_, hit) => quantityProofKey(hit.quantityProof),
      })
      const hasStoredPrice = () => [...pricePlans.values()].some(plan => [
        ...lexicalSearch(plan.searchQuery, { ...options, statuses: ['active'], scopes: ['project', 'global'] }),
        ...knowledgeIndex.search(plan.searchQuery, options),
      ].some(hit => isSafeRecallRecord(hit.record, identity.key, { kind: 'current', at: now }, now) &&
        !conflictsRecallProject(hit, recallNamedProjectTerms(plan.query)) && quantityEvidence(plan, hit.record.content)))
      // An explicit spending question keeps its receipt requirement, including when nothing qualifies.
      const requiresSpender = [...pricePlans.values()].some(plan => plan.quantity.scope.spender)
      if (!requiresSpender && !priceScan.matches.length && !hasStoredPrice()) {
        previousDeepRecall = { queries: [...pricePlans.keys()], tokens: priceScan.tokens, limit: DEEP_RECALL_TOKEN_LIMIT }
        priceScan = null
        queryPlan = recallQueryPlan(query, previousQuery, followUp, { itemPrices: false })
      }
    }
    let comparison = queryPlan[0]?.calendarComparison
    const requestedDiscount = queryPlan[0]?.discount
    if ((comparison || requestedDiscount) && !await prepareOriginals()) return withoutPrevious
    const foundDiscount = requestedDiscount ? findDiscountEvidence(passageIndex, requestedDiscount, queryPlan[0].query, identity.key, now) : null
    const discountEvidence = foundDiscount?.candidates.some(Boolean) ? foundDiscount : null
    const discount = discountEvidence ? requestedDiscount : null
    if (requestedDiscount && !discountEvidence) {
      queryPlan = recallQueryPlan(query, previousQuery, followUp, { purchase: false })
    }
    const eventWindow = !comparison && !discount && !followUp && !queryPlan.some(plan => plan.quantity) ? calendarEventWindow(analyzeUserMessageControls(query).questionText, {
      eventTime: now, timeZone: normalizeClientTimeZone(latestUserMessage?.source?.clientTimeZone),
    }) : null
    if (eventWindow && queryPlan[0]) queryPlan = [{ ...queryPlan[0], eventWindow }]
    const calendarHits = new Map()
    if (comparison) {
      const calendarAt = comparison.personalSince ? Math.min(now, activeTurn?.questionAt ?? now) : now
      for (const plan of queryPlan.filter(item => item.detail === 'event-date')) {
        const options = { projectKey: identity.key, now: calendarAt, limit: 40 }
        const participant = comparison.order || comparison.personalSince ? null : calendarParticipant(plan.query)
        const original = passageIndex.search(plan.searchQuery ?? plan.query, options)
        if (participant) original.push(...passageIndex.search('started working with her worked with him', options))
        const source = [...new Map(original.map(hit => [hit.record.id, hit])).values()]
          .filter(hit => comparison.order || comparison.personalSince
            ? !(hit.record.sourceRefs[0].eventTime > calendarAt) : hit.record.remembered)
          .map(hit => directPassageEvidence(plan, hit, true) ??
            linkedCalendarEvidence(plan, hit, participant, passageIndex, identity.key, now)).filter(Boolean)
        const records = lexicalSearch(plan.query, { ...options, statuses: ['active'], scopes: ['project', 'global'] })
        const knowledge = knowledgeIndex.search(plan.query, options)
        const dates = new Map(), namedProjects = recallNamedProjectTerms(plan.query)
        for (const hit of [...source, ...records, ...knowledge]) {
          if (hit.record.kind === 'preference' || conflictsRecallProject(hit, namedProjects) ||
              !isSafeRecallRecord(hit.record, identity.key, { kind: 'current', at: now }, now)) continue
          const proof = eventDateProof(hit, plan)
          if (!proof) continue
          const key = comparison.order ? calendarOrderDateKey(proof) : calendarDateKey(proof)
          const existing = dates.get(key)
          if (existing) {
            const source = hit.record.kind === 'source', previousSource = existing.hit.record.kind === 'source'
            if (!comparison.order || (source === previousSource
              ? !preferCalendarOrderEvidence(proof, existing.proof) : !source)) continue
          }
          dates.set(key, { hit: { ...hit, score: 1, record: { ...hit.record, recallQuote: proof.quote } }, proof })
          if (dates.size === 2) break
        }
        calendarHits.set(plan.query, [...dates.values()].map(entry => entry.hit))
      }
      // A personal interval with a missing endpoint can still use the ordinary recall evidence.
      const hasDate = [...calendarHits.values()].map(hits => hits.length > 0)
      if (!comparison.order && (!hasDate.some(Boolean) || (comparison.requiresBothDates && !hasDate.every(Boolean)))) {
        comparison = undefined
        queryPlan = recallQueryPlan(query, previousQuery, followUp, { calendar: false })
      }
    }
    const queryTimeIntent = recallTimeIntent(query, now)
    const historicalFollowUp = followUp && isHistoricalQuery(previousQuery)
    const carriedTime = historicalFollowUp ? recallTimeIntent(previousQuery, now) : queryTimeIntent
    const childPlans = queryPlan.filter(item => item.role === 'subquestion')
    const hasCurrentPart = childPlans.some(item => explicitlyAsksCurrentTime(item.query))
    let sharedTime = carriedTime
    for (const item of childPlans) {
      if (item.detail === 'event-date' || item.purchasePrice || item.timeMeasure) {
        item.timeIntent = { kind: 'current', at: now }
        continue
      }
      const ownTime = recallTimeIntent(item.query, now)
      const explicit = ownTime.kind !== 'current' || explicitlyAsksCurrentTime(item.query)
      if (explicit) sharedTime = ownTime
      item.timeIntent = !explicit && hasCurrentPart ? recallTimeIntent('', now) : sharedTime
    }
    const slotPlans = childPlans.length > 0 ? childPlans : queryPlan.filter(item => item.role === 'root').slice(0, 1)
    for (const item of slotPlans) {
      if (item.stateField) {
        item.timeIntent = item.stateField.phase === 'previous' ? { kind: 'history', at: null } : { kind: 'current', at: now }
        item.searchQuery = stateFieldSearch(item.stateField)
      }
      item.timeIntent ??= item.timeMeasure ? { kind: 'current', at: now } : carriedTime
      item.coverageRequired = isRecallQuestion(query)
      if (item.coverageRequired && item.timeIntent.kind === 'current' && !item.detail) item.personalQuestion ??= personalSourceQuestion(item.query)
      if ((item.personalQuestion?.receivedGift || item.personalQuestion?.adviceTopic) && item.timeIntent.kind === 'current') {
        item.timeIntent = { kind: 'current', at: Math.min(now, activeTurn?.questionAt ?? now) }
      }
    }
    const slotTimes = slotPlans.map(item => item.timeIntent)
    const hasSubquestions = childPlans.length > 0
    const quantityQuestion = childPlans.some(plan => plan.quantity)
    const scopedQuantity = childPlans.some(plan => plan.quantity?.scope)
    const hasStateFields = slotPlans.some(plan => plan.stateField)
    const searchPlan = queryPlan.slice(0, MAX_RECALL_LOOKUPS + 1)
    const attempts = searchPlan.map((item) => item.query)
    const hitsById = new Map()
    const knownValueConflicts = []
    let valueConflicts = []
    const relatedQuantities = new Map()
    const rootAcceptedById = new Map()
    const subquestionPrimaryIds = []
    const qualifiedValueIds = []
    const relationSupportIds = []
    const grayById = new Map()
    let gateThresholds = null
    let readSupportingSource
    const sourceHits = new Map()
    const timeMeasurePlans = slotPlans.filter(plan => plan.timeMeasure && plan.timeIntent.kind === 'current')
    const timeMeasureSearchPlans = timeMeasurePlans.slice(0, MAX_RECALL_LOOKUPS)
    if ((timeMeasureSearchPlans.length || eventWindow?.bounds) && !await prepareOriginals()) return withoutPrevious
    const latestTimeMeasure = timeMeasureSearchPlans.find(plan => usesLatestTimeEvidence(plan.timeMeasure))?.timeMeasure.mode
    const timeMeasureAt = latestTimeMeasure ? Math.min(now, activeTurn?.questionAt ?? now) : now
    const timeMeasureScan = timeMeasureSearchPlans.length
      ? findRecentTimeMeasures(passageIndex, timeMeasureSearchPlans, identity.key, timeMeasureAt) : null
    const incompleteLatestTime = latestTimeMeasure && timeMeasureScan?.incomplete
    const measuredQueries = new Set()
    for (const { plan, hit, verified } of timeMeasureScan?.matches ?? []) {
      const saved = appendPassageEvidence(hitsById, hit, plan, verified)
      measuredQueries.add(plan.query)
      if (hasSubquestions) {
        if (!subquestionPrimaryIds.includes(saved.record.id)) subquestionPrimaryIds.push(saved.record.id)
      } else rootAcceptedById.set(saved.record.id, saved)
    }
    if (eventWindow?.bounds) {
      const plan = slotPlans[0]
      const candidates = passageIndex.search(eventWindow.search, { projectKey: identity.key, now, limit: 40 })
      const proofs = new Map()
      for (const hit of candidates) {
        if (!isSafeRecallRecord(hit.record, identity.key, { kind: 'current', at: now }, now) ||
            conflictsRecallProject(hit, recallNamedProjectTerms(plan.query)) || hit.record.sourceRefs[0].eventTime > now) continue
        const proof = calendarWindowEvidence(hit.record, eventWindow)
        if (!proof || !isRecallSourceStatement(proof.quote)) continue
        const id = hit.record.sourceRefs[0].sourceId
        if (!proofs.has(id)) proofs.set(id, { hit, proof })
      }
      const named = [...proofs.values()].filter(item => item.proof.namesObject)
      // Keep plausible paraphrases separate from object-and-date evidence.
      for (const { hit, proof } of named.length ? named.slice(0, 3) : [...proofs.values()].slice(0, 1)) {
        const saved = appendPassageEvidence(hitsById, { ...hit, eventWindowProof: plan.query, record: { ...hit.record,
          recallQuote: proof.quote, recallEventPeriod: proof.period,
          ...(proof.resolved ? { recallResolvedEvent: proof.resolved, recallResolvedLanguage: eventWindow.language } : {}) } }, plan, proof.namesObject && hit.record.remembered)
        rootAcceptedById.set(saved.record.id, saved)
      }
    }
    for (let attemptIndex = 0; attemptIndex < attempts.length; attemptIndex += 1) {
      const attempt = attempts[attemptIndex]
      const planItem = searchPlan[attemptIndex]
      if (measuredQueries.has(attempt) || planItem.timeMeasure?.mode === 'race-best' ||
          (timeMeasurePlans.length > 1 && planItem.role === 'root') ||
          (incompleteLatestTime && usesLatestTimeEvidence(planItem.timeMeasure))) continue
      if (discountEvidence) {
        if (planItem.purchasePrice) {
          const fact = discountEvidence.candidates[planItem.purchasePrice === 'list' ? 0 : 1]
          for (const { hit, quote } of discountEvidenceRows(fact)) {
            const saved = appendPassageEvidence(hitsById, { ...hit, record: { ...hit.record, recallQuote: quote } }, planItem, true)
            if (!subquestionPrimaryIds.includes(saved.record.id)) subquestionPrimaryIds.push(saved.record.id)
          }
        }
        continue
      }
      if ((comparison || quantityQuestion) && planItem.role === 'root') continue
      const eventDates = comparison ? calendarHits.get(attempt) : null
      if (eventDates?.length) {
        for (const hit of eventDates) {
          if (hit.record.kind === 'source') appendPassageEvidence(hitsById, hit, planItem,
            Boolean(comparison.order || comparison.personalSince || hit.record.remembered))
          else {
            const previous = hitsById.get(hit.record.id)
            const quotes = [...new Set([...(previous?.record.recallQuote?.split('；') ?? []), hit.record.recallQuote])]
            hitsById.set(hit.record.id, { ...hit, record: { ...hit.record, recallQuote: quotes.join('；') } })
          }
          if (!subquestionPrimaryIds.includes(hit.record.id)) subquestionPrimaryIds.push(hit.record.id)
        }
        continue
      }
      if (comparison?.order) continue
      const attemptTimeIntent = recallTimeIntent(attempt, now)
      const timeIntent = planItem.timeIntent ?? (carriedTime.kind !== 'current' ? carriedTime : attemptTimeIntent)
      const attemptTimes = planItem.role === 'root' ? slotTimes : [timeIntent]
      const lookup = planItem.personalQuestion?.receivedGift ? planItem.searchQuery : attempt
      let candidate = lexicalSearch(lookup, recallSearchOptions(identity.key, attemptTimes, now))
      let groundedKnowledge = []
      const options = { projectKey: identity.key, now, limit: 40 }
      const plan = { ...planItem, timeIntent }
      const historicalNote = asksForHistoricalKnowledge(plan)
      const datedNote = timeIntent.kind === 'as-of' && !plan.requiresRelationTrace
      if (isRecallQuestion(query)) {
        // Each question needs its own verified excerpt.
        if ((plan.role === 'subquestion' || (plan.role === 'root' && !hasSubquestions)) &&
            (timeIntent.kind === 'current' || historicalNote || datedNote)) {
          groundedKnowledge = knowledgeIndex.search(lookup, {
            ...options,
            valuePlan: plan,
            requireUnique: historicalNote,
            asOf: datedNote ? timeIntent.at : undefined,
            verify: (record, quote, _section, passage) => isRecallSourceStatement(quote.replace(/^(?:[-*+]|\d+\.)\s+/u, '')) &&
              slotEvidence(plan, [{ record: { ...record, recallQuote: quote, notePassages: [passage] } }],
                hasSubquestions).length > 0,
          })
        }
      } else if (attemptTimes.some(time => time.kind === 'current')) {
        candidate = [...candidate, ...knowledgeIndex.search(attempt, options)]
      }
      candidate = candidate.filter(hit => attemptTimes.some(time => isSafeRecallRecord(hit.record, identity.key, time, now)))
      if (recallObserver !== null) traceRecall(recallObserver, { phase: 'search', query: attempt, ids: candidate.map((hit) => hit.record.id) })
      let scoped = candidate
      const namedProjects = planItem.role === 'root' ? recallNamedProjectTerms(attempt) : []
      if (planItem.role === 'root' && (planItem.entityTerms.length > 0 || namedProjects.length > 0)) {
        scoped = candidate.filter(hit => !conflictsRecallProject(hit, namedProjects) &&
          (planItem.entityTerms.length === 0 || matchesRecallAttribute(hit, attempt, planItem.detail, planItem.entityTerms)))
        if (recallObserver !== null) traceRecall(recallObserver, {
          phase: 'scope', query: attempt, entityTerms: planItem.entityTerms,
          ids: scoped.map((hit) => hit.record.id), excludedIds: candidate.filter((hit) => !scoped.includes(hit)).map((hit) => hit.record.id),
        })
      } else if (planItem.role === 'root' && childPlans.length > 0) {
        scoped = candidate.filter(hit => childPlans.some(item => slotEvidence(item, [hit], true).length > 0))
        if (recallObserver !== null) traceRecall(recallObserver, {
          phase: 'scope', query: attempt, entityTerms: [],
          ids: scoped.map((hit) => hit.record.id), excludedIds: candidate.filter((hit) => !scoped.includes(hit)).map((hit) => hit.record.id),
        })
      } else if (planItem.role === 'root' && isRecallQuestion(query)) {
        scoped = candidate.filter(hit => slotEvidence(planItem, [hit], false).length > 0)
      } else if (planItem.role === 'subquestion') {
        scoped = candidate.filter(hit => planItem.quantity || planItem.requiresRelationTrace || matchesRecallEntity(hit, planItem.entityTerms))
        if (recallObserver !== null) traceRecall(recallObserver, {
          phase: 'scope', query: attempt, entityTerms: planItem.entityTerms,
          ids: scoped.map((hit) => hit.record.id), excludedIds: candidate.filter((hit) => !scoped.includes(hit)).map((hit) => hit.record.id),
        })
        const attributeMatches = scoped.filter(hit => planItem.timeMeasure
          ? slotEvidence(planItem, [hit], true).length > 0
          : matchesRecallAttribute(hit, attempt, planItem.detail, planItem.entityTerms, planItem.quantity))
        if (recallObserver !== null) traceRecall(recallObserver, {
          phase: 'attribute', query: attempt,
          ids: attributeMatches.map((hit) => hit.record.id), excludedIds: scoped.filter((hit) => !attributeMatches.includes(hit)).map((hit) => hit.record.id),
        })
        if (!attributeMatches.length && planItem.detail && scoped.length && timeIntent.kind === 'current') {
          readSupportingSource ??= sourceResolver(root, store, identity.key, now)
          const evidence = readSupportingSource(planItem, scoped)
          if (evidence) {
            const quotes = sourceHits.get(evidence.record.id) ?? []
            if (!quotes.some(other => other.record.content === evidence.record.content)) quotes.push(evidence)
            sourceHits.set(evidence.record.id, quotes)
            attributeMatches.push(evidence)
            if (recallObserver) traceRecall(recallObserver, {phase:'source', id:evidence.record.id, detail:planItem.detail})
          }
        }
        scoped = attributeMatches
      }
      const meaningful = scoped.filter((hit) => hasContentMatch(hit.matched) &&
        (hit.record.kind !== 'preference' || isPreferenceQuery(attempt)))
      if (recallObserver !== null) traceRecall(recallObserver, { phase: 'content', query: attempt, ids: meaningful.map((hit) => hit.record.id) })
      if (meaningful.length === 0 && groundedKnowledge.length === 0) continue
      // IDF scores are relative to their own corpus. A small note index cannot
      // be judged against the much larger memory index's rarity threshold.
      const memoryClassified = classifyRecallHits(meaningful.filter(hit => hit.record.kind !== 'knowledge'), attempt, {
        indexSize: index.size, idfOf: term => index.idfOf(term),
      })
      const noteClassified = classifyRecallHits(meaningful.filter(hit => hit.record.kind === 'knowledge'),
        attempt, knowledgeIndex.statistics(identity.key))
      const classified = { ...memoryClassified,
        auto: [...memoryClassified.auto, ...noteClassified.auto, ...groundedKnowledge],
        gray: [...memoryClassified.gray, ...noteClassified.gray],
      }
      const autoIds = new Set(classified.auto.map((hit) => hit.record.id))
      const grayIds = new Set(classified.gray.map((hit) => hit.record.id))
      // A named object and a verified value in the same sentence are stronger
      // evidence than lexical rarity in a small or repetitive project corpus.
      const qualifiedGray = planItem.detail
        ? meaningful.filter(hit => !autoIds.has(hit.record.id))
        : planItem.role === 'subquestion' ? classified.gray.filter(hit => isQualifiedValueCandidate(hit, attempt)) : []
      const qualifiedIds = new Set(qualifiedGray.map((hit) => hit.record.id))
      if (recallObserver !== null) traceRecall(recallObserver, {
        phase: 'gate', query: attempt,
        autoIds: [...autoIds], grayIds: [...grayIds], qualifiedIds: [...qualifiedIds],
        dropIds: meaningful.filter((hit) => !autoIds.has(hit.record.id) && !grayIds.has(hit.record.id)).map((hit) => hit.record.id),
      })
      if (gateThresholds === null && classified.gray.length > 0) gateThresholds = classified.thresholds
      const topScore = Math.max(0, ...classified.auto.map((hit) => hit.score))
      const normalizeHit = (hit, qualifiedValue = false) => {
        const normalizedScore = topScore > 0 ? hit.score / topScore : 0
        return { ...hit, score: normalizedScore, qualifiedValue }
      }
      for (const entries of knowledgeValueConflicts({ ...planItem, timeIntent }, groundedKnowledge)) {
        knownValueConflicts.push({ query: planItem.query, entries })
        for (const { hit } of entries) keepRecallHit(hitsById, normalizeHit(hit))
      }
      if (planItem.role === 'subquestion') {
        const autoHits = classified.auto.map((hit) => normalizeHit(hit))
        const qualifiedHits = [...classified.auto, ...qualifiedGray]
          .filter((hit) => isQualifiedValueCandidate(hit, attempt))
          .sort((left, right) => right.score - left.score)
          .map((hit) => normalizeHit(hit, true))
        const qualifiedPrimary = qualifiedGray.length ? normalizeHit(qualifiedGray[0], true) : undefined
        const primary = planItem.detail ? (autoHits[0] ?? qualifiedPrimary) : (qualifiedPrimary ?? autoHits[0])
        if (primary !== undefined) {
          if (!subquestionPrimaryIds.includes(primary.record.id)) subquestionPrimaryIds.push(primary.record.id)
          keepRecallHit(hitsById, primary)
        }
        for (const hit of qualifiedHits) {
          if (hit.record.id === primary?.record.id || subquestionPrimaryIds.includes(hit.record.id) || qualifiedValueIds.includes(hit.record.id)) continue
          qualifiedValueIds.push(hit.record.id)
          keepRecallHit(hitsById, hit)
        }
      } else {
        for (const hit of classified.auto) {
          if (childPlans.length > 0 && !childPlans.some(item => slotEvidence(item, [hit], true).length > 0)) continue
          const normalized = normalizeHit(hit)
          keepRecallHit(rootAcceptedById, normalized)
          keepRecallHit(hitsById, normalized)
        }
      }
      for (const hit of classified.gray) {
        if (!grayById.has(hit.record.id)) grayById.set(hit.record.id, hit)
      }
    }
    const relationSearch = (searchQuery, timeIntent) => {
      const found = lexicalSearch(searchQuery, recallSearchOptions(identity.key, [timeIntent], now))
      if (timeIntent.kind === 'current') {
        found.push(...knowledgeIndex.search(searchQuery, { projectKey: identity.key, now, limit: 40 }),
          ...passageIndex.search(searchQuery, { projectKey: identity.key, now, limit: 40 }),
          ...sourceIndex.search(searchQuery, { projectKey: identity.key, now, limit: 40 }))
      }
      const validSourceHits = new Set(passageIndex.validateMany(
        found.filter(hit => hit.record.kind === 'source'), identity.key, { now },
      ))
      const byId = new Map()
      for (const hit of found) {
        if (!isSafeRecallRecord(hit.record, identity.key, timeIntent, now)) continue
        if (hit.record.kind === 'knowledge' && !knowledgeIndex.validate(hit, identity.key, now)) continue
        if (hit.record.kind === 'source' && !validSourceHits.has(hit)) continue
        const previous = byId.get(hit.record.id)
        if (!previous || hit.score > previous.score) byId.set(hit.record.id, hit)
      }
      return [...byId.values()]
    }
    const groundRelationCandidate = (plan, hit) => {
      if (!isSafeRecallRecord(hit.record, identity.key, plan.timeIntent, now)) return null
      if (hit.record.kind === 'source') return passageIndex.validate(hit, identity.key) ? hit : null
      if (hit.record.kind === 'knowledge') {
        if (asksForEffectiveKnowledge(plan) &&
            !isCurrentKnowledgeQuote(hit.record, hit.record.recallQuote ?? hit.record.noteQuote, plan.timeIntent?.kind === 'as-of')) return null
        return knowledgeIndex.validate(hit, identity.key, now) ? hit : null
      }
      const scopes = hit.record.scope === 'global'
        ? [{ scope: 'global', projectKey: null }]
        : [{ scope: 'project', projectKey: identity.key }]
      const current = store.find(hit.record.id, scopes)
      if (!current || current.revision !== hit.record.revision || current.contentHash !== hit.record.contentHash ||
          !isSafeRecallRecord(current, identity.key, plan.timeIntent, now)) return null
      if (!Array.isArray(current.sourceRefs) || current.sourceRefs.length === 0) return hit
      readSupportingSource ??= sourceResolver(root, store, identity.key, now)
      const grounded = readSupportingSource(plan, [hit])
      if (!grounded) return null
      const quotes = sourceHits.get(current.id) ?? []
      if (!quotes.some(other => other.record.content === grounded.record.content)) quotes.push(grounded)
      sourceHits.set(current.id, quotes)
      return grounded
    }
    for (const plan of slotPlans.filter(item => item.requiresRelationTrace)) {
      const sourcePlan = slotPlans.find(item => item.query === plan.relationSourceQuery)
      const seedPlan = sourcePlan ?? (plan.relationSeedQuery ? {
        query: plan.relationSeedQuery,
        role: 'root',
        entityTerms: recallSubjectTerms(plan.relationSeedQuery),
        timeIntent: plan.timeIntent,
      } : null)
      if (!seedPlan) continue
      if ((seedPlan.timeIntent.kind === 'current' || plan.timeIntent.kind === 'current') &&
          !await prepareOriginals()) return withoutPrevious
      let seeds = sourcePlan ? slotEvidence(sourcePlan, [...hitsById.values()], hasSubquestions) : []
      if (seeds.length === 0) seeds = relationSearch(seedPlan.query, seedPlan.timeIntent)
      seeds = seeds.filter(hit => isSafeRecallRecord(hit.record, identity.key, seedPlan.timeIntent, now))
      const byAnswer = new Map()
      for (const seed of seeds) {
        const grounded = groundRelationCandidate(seedPlan, seed)
        if (!grounded || !sameRelationScope(grounded.record, seed.record, identity.key)) continue
        const quote = grounded.record.recallQuote ?? grounded.record.content
        const answer = plan.relationType === 'decision-reason'
          ? recallDecisionAnswer(seedPlan.query, quote)
          : recallRelationAnswer(seedPlan.query, quote)
        if (answer === null) continue
        const matches = byAnswer.get(answer) ?? []
        matches.push(grounded)
        byAnswer.set(answer, matches)
      }
      if (byAnswer.size !== 1) continue
      const [bridge, matchingSeeds] = byAnswer.entries().next().value
      plan.bridgeTerms = [bridge]
      const support = matchingSeeds[0]
      plan.relationSeedHit = support
      plan.relationSeedPlan = seedPlan
      plan.searchQuery = `${bridge} ${plan.query}`
      const candidates = new Map([...hitsById.values()].map(hit => [hit.record.id, hit]))
      for (const hit of relationSearch(plan.searchQuery, plan.timeIntent)) candidates.set(hit.record.id, hit)
      const connected = []
      for (const hit of candidates.values()) {
        if (!sameRelationScope(support.record, hit.record, identity.key) ||
            !isSafeRecallRecord(hit.record, identity.key, plan.timeIntent, now)) continue
        const grounded = groundRelationCandidate(plan, hit)
        if (!grounded || !slotEvidence(plan, [grounded], hasSubquestions).length) continue
        connected.push(grounded)
      }
      if (connected.length === 0) continue
      const addRelationSupport = targetId => {
        if (targetId === support.record.id) return
        const existing = hitsById.get(support.record.id) ?? support
        const links = existing.relationSupportFor ?? []
        const relationSupportFor = links.some(link => link.targetId === targetId)
          ? links
          : [...links, { targetId, timeIntent: seedPlan.timeIntent }]
        hitsById.set(support.record.id, { ...existing, relationSupportFor })
        if (!relationSupportIds.includes(support.record.id)) relationSupportIds.push(support.record.id)
        if (hasSubquestions && !subquestionPrimaryIds.includes(support.record.id)) subquestionPrimaryIds.push(support.record.id)
      }
      if (!hitsById.has(support.record.id)) {
        addRelationSupport(connected[0].record.id)
      }
      for (const hit of connected) {
        addRelationSupport(hit.record.id)
        const linked = hit.record.id === support.record.id ? hit : {
          ...hit,
          selectedSlots: [...new Set([...(hit.selectedSlots ?? []), plan.query])],
          relationFromId: support.record.id,
          relationFromRevision: support.record.revision,
          relationFromTimeIntent: seedPlan.timeIntent,
        }
        hitsById.set(linked.record.id, linked)
        if (hasSubquestions) {
          if (!subquestionPrimaryIds.includes(linked.record.id)) subquestionPrimaryIds.push(linked.record.id)
        } else rootAcceptedById.set(linked.record.id, linked)
      }
    }
    let coverage = slotPlans.map(plan => slotEvidence(plan, [...hitsById.values()], hasSubquestions))
    let missingSlots = slotPlans.map((plan, index) => ({ plan, index })).filter(entry => coverage[entry.index].length === 0)
    const locationPlan = !followUp && !hasSubquestions && slotPlans[0]?.timeIntent.kind === 'current'
      ? eventLocationQuery(controls.questionText) : null
    if (locationPlan && !coverage[0].some(({ record }) =>
      containsEventLocation(record.recallQuote ?? record.content, locationPlan))) {
      if (!await prepareOriginals()) return withoutPrevious
      const namedProjects = recallNamedProjectTerms(query)
      const location = retrieveEventLocation(passageIndex, locationPlan, {
        ...originalOptions,
        now: Math.min(now, activeTurn?.questionAt ?? now),
        accepts: hit => !conflictsRecallProject(hit, namedProjects),
      })
      if (location.eventLocation) return deliverOriginalReport(location)
      if (location.scannedTokens > 0) previousDeepRecall = { queries: [query], tokens: location.scannedTokens, limit: DEEP_RECALL_TOKEN_LIMIT }
    }
    const declaredCount = slotPlans[0]?.declaredCount
    if (declaredCount) {
      if (!await prepareOriginals()) return withoutPrevious
      const projectTerms = recallNamedProjectTerms(query)
      const questionAt = Math.min(now, activeTurn?.questionAt ?? now)
      const readStored = () => {
        runtime.synchronize(identity.key)
        return coverage[0].filter(hit => {
          if (hit.record.unverifiedRecall === true || hit.record.sourceRefs?.some(ref => ref.eventTime > questionAt)) return false
          if (hit.record.kind === 'knowledge') return knowledgeIndex.validate(hit, identity.key)
          const { id, scope, projectKey, revision, contentHash } = hit.record
          const record = store.find(id, [{ scope, projectKey }])
          return record?.revision === revision && record?.contentHash === contentHash &&
            isSafeRecallRecord(record, identity.key, { kind: 'current', at: questionAt }, questionAt)
        })
      }
      return deliverOriginalReport(await retrieveDeclaredCount(passageIndex, declaredCount,
        { ...originalOptions, now: questionAt, query, readStored, memoryOnly: controls.memoryOnlyDirective,
          resolvePrevious: refs => resolveCountPredecessors(ctx, identity.key, refs, payload.signal),
          accepts: hit => !conflictsRecallProject(hit, projectTerms) }))
    }
    let completionReceipt = null
    let candidatePool = []
    const localPassages = new Map()
    let localDeepRecall = timeMeasureScan
      ? { queries: timeMeasureSearchPlans.map(plan => plan.query), tokens: timeMeasureScan.tokens, limit: DEEP_RECALL_TOKEN_LIMIT } : previousDeepRecall
    const noteInFlightEvidence = () => {
      if (activeTurn === null) return
      const records = [...hitsById.values(), ...relatedQuantities.values(), ...candidatePool].map(hit => hit.record)
      activeTurn.evidenceRefs = [...new Map(records.map(record => [`${record.id}\0${record.revision}`, {
        id: record.id, revision: record.revision, scope: record.scope, projectKey: record.projectKey,
        sourceRefs: (record.sourceRefs ?? []).map(({ sourceId }) => ({ sourceId })),
        ...(record.kind === 'knowledge' ? { noteAuthority: noteAuthority(record) } : {}),
      }])).values()]
    }
    const advice = !hasSubquestions && slotPlans[0]?.personalQuestion?.adviceTopic &&
      slotPlans[0].timeIntent.kind === 'current' ? slotPlans[0] : null
    const represented = advice ? coverage[0] : []
    const supplementAdvice = advice && represented.length > 0 && represented.length < config.inject.maxItems
    // Check the original for a conflicting figure before calculating a scoped
    // comparison, even when its compact memory already supplies a value.
    const passagePlans = timeMeasureScan ? [] : (scopedQuantity || supplementAdvice) ? slotPlans : missingSlots.map(entry => entry.plan)
    if (!eventWindow && !discount && passagePlans.length > 0 && isRecallQuestion(query)) {
      const plans = new Map(passagePlans.slice(0, MAX_RECALL_LOOKUPS)
        .filter(plan => (plan.timeIntent.kind === 'current' || plan.stateField) && !plan.requiresRelationTrace)
        .map(plan => [plan.query, plan]))
      if (plans.size > 0) {
        const ready = priceScan || await prepareOriginals({ requireReady: Boolean(supplementAdvice) })
        if (!ready && (!supplementAdvice || payload.signal?.aborted || activeTurn?.invalidated)) return withoutPrevious
        const maxTokens = DEEP_RECALL_TOKEN_LIMIT - (previousDeepRecall?.tokens ?? 0)
        const scan = !ready ? { matches: [], tokens: 0 }
          : priceScan ?? (advice ? findAdviceEvidence(passageIndex, advice, identity.key, {
            maxTokens, maxItems: config.inject.maxItems, represented,
          })
          : passageIndex.findEvidence([...plans.keys()], {
            projectKey: identity.key, now: hasStateFields ? Math.min(now, activeTurn?.questionAt ?? now) : now,
            maxTokens,
            lookupQuery: question => {
              const plan = plans.get(question)
              return scopedQuantity || hasStateFields || comparison?.trips || plan.personalQuestion?.receivedGift || plan.personalQuestion?.adviceTopic
                ? plan.searchQuery : question
            },
            wholeSentences: scopedQuantity || hasStateFields || Boolean(comparison?.trips || comparison?.tasks) || comparison?.action === 'occur',
            acceptOriginal: scopedQuantity || hasStateFields,
            isCandidate: scopedQuantity ? hit => Boolean(hit.quantityProof?.related) : undefined,
            match: (question, hit) => (comparison?.order || scopedQuantity) && hit.record.sourceRefs[0].eventTime > now
              ? null : directPassageEvidence(plans.get(question), hit, hasSubquestions),
            distinctKey: (question, hit) => {
              if (hit.stateFieldConflict) return null
              if (hit.stateFieldValue) return stateValueKey(hit.stateFieldValue)
              const quantity = plans.get(question).quantity
              return quantity ? quantityProofKey(hit.quantityProof, { includeOwner: Boolean(quantity.scope && !quantity.scope.entity) }) : undefined
            },
          }))
        if (ready) localDeepRecall = { queries: [...new Set([...(previousDeepRecall?.queries ?? []), ...plans.keys()])],
          tokens: (previousDeepRecall?.tokens ?? 0) + scan.tokens, limit: DEEP_RECALL_TOKEN_LIMIT }
        const stateCounts = new Map()
        if (hasStateFields) for (const { query: question } of scan.matches) {
          stateCounts.set(question, (stateCounts.get(question) ?? 0) + 1)
        }
        for (const { query: question, hit } of scan.matches) {
          if (hit.quantityProof?.related) { relatedQuantities.set(question, hit); continue }
          const plan = plans.get(question)
          if (plan.stateField && (stateCounts.get(question) !== 1 || hit.stateFieldConflict)) continue
          if (!plan.stateField && !comparison?.order && !scopedQuantity && !hit.record.remembered &&
              !plan.personalQuestion?.receivedGift && !plan.personalQuestion?.adviceTopic) {
            localPassages.set(question, hit)
            continue
          }
          const saved = appendPassageEvidence(hitsById, hit, plan, true)
          if (!hasSubquestions) rootAcceptedById.set(saved.record.id, saved)
        }
        coverage = slotPlans.map(plan => slotEvidence(plan, [...hitsById.values()], hasSubquestions))
        missingSlots = slotPlans.map((plan, index) => ({ plan, index })).filter(entry => coverage[entry.index].length === 0)
      }
    }
    if (!eventWindow && !discount && !comparison?.order && !scopedQuantity && !hasStateFields &&
        !timeMeasureScan?.matches.length && !incompleteLatestTime && latestTimeMeasure !== 'race-best' && missingSlots.length > 0) {
      const lookupPlans = missingSlots.slice(0, MAX_RECALL_LOOKUPS).map(entry => entry.plan)
      const lookupQueries = lookupPlans.map(plan => plan.searchQuery ?? plan.query)
      const datedOnly = lookupPlans.every(plan => plan.timeIntent.kind !== 'current')
      if (!datedOnly && !await prepareOriginals()) return withoutPrevious
      const partial = lookupPlans.some(plan => plan.timeIntent.kind !== 'current')
      const noteTimes = lookupPlans.map(({ timeIntent }) => timeIntent.kind === 'current' ? null
        : timeIntent.kind === 'as-of' ? timeIntent.at : undefined)
      const eligibleForQuery = (record, position, datedSection = false) => {
        if (record.kind !== 'knowledge') return matchesRecallTime(record, lookupPlans[position].timeIntent, now)
        const at = noteTimes[position]
        return at !== undefined && (!datedSection || at !== null) && record.noteReferenceTimes?.includes(at) === true
      }
      const relevant = datedOnly ? record => lookupPlans.some((_, index) => eligibleForQuery(record, index)) : null
      const semanticCorpus = async () => {
        const passages = datedOnly ? [] : await passageIndex.semanticCandidates(identity.key, { now, signal: payload?.signal })
        if (!passages) return null
        const referenceTimes = noteTimes.filter(at => at !== undefined)
        const notes = referenceTimes.length > 0
          ? knowledgeIndex.candidates(identity.key, { now, limit: Number.MAX_SAFE_INTEGER, referenceTimes }) : []
        return [...store.list('project', identity.key), ...store.list('global', null),
          ...notes.map(hit => hit.record), ...passages.map(hit => hit.record)]
          .filter(record => (!relevant || relevant(record)) && !record.quoted && !looksSensitive(record.content))
      }
      let semanticLists = []
      noteInFlightEvidence()
      try {
        semanticLists = await semanticIndex.search(lookupQueries, semanticCorpus, {
          projectKey: identity.key, signal: payload?.signal,
          eligibleForQuery, partial, deferCorpus: !datedOnly && passageIndex.hasProjection(identity.key),
          recordForQuery: (record, index) => record.kind === 'knowledge'
            ? { ...record, noteReferenceTimes: [noteTimes[index]] } : record,
        })
      } catch (error) { ctx.logger?.warn?.(`[dsh-memory] semantic lookup unavailable: ${error.message}`) }
      if (payload?.signal?.aborted) return withoutPrevious
      candidatePool = recallCandidatePool({
        plans: lookupPlans,
        index, knowledgeIndex, passageIndex, semanticLists, store, projectKey: identity.key,
        now,
      })
      noteInFlightEvidence()
      // Search original user passages only through current active memory source grants.
      // The source resolver checks task completion, scope, exact byte ranges, deletion,
      // opt-out, quotation and sensitive-content guards before it returns a quote.
      if (missingSlots.some(entry => entry.plan.timeIntent.kind === 'current')) {
        readSupportingSource ??= sourceResolver(root, store, identity.key, now)
        for (const entry of missingSlots.slice(0, MAX_RECALL_LOOKUPS)) {
          if (entry.plan.timeIntent.kind !== 'current') continue
          const indexedCandidates = sourceIndex.search(entry.plan.searchQuery ?? entry.plan.query, {
            projectKey: identity.key, now, limit: 40,
          })
          const sourceCandidatesById = new Map()
          for (const hit of [...indexedCandidates, ...candidatePool.filter(item => item.record.kind !== 'knowledge')]) {
            if (!sourceCandidatesById.has(hit.record.id)) sourceCandidatesById.set(hit.record.id, hit)
          }
          const sourceCandidates = [...sourceCandidatesById.values()]
          const evidence = readSupportingSource(entry.plan, sourceCandidates)
          if (!evidence) continue
          if (conflictsRecallProject(evidence, recallNamedProjectTerms(entry.plan.query))) continue
          const hit = { ...evidence, score: Math.max(1, evidence.score ?? 0), matched: [], termScores: [] }
          const quotes = sourceHits.get(hit.record.id) ?? []
          if (!quotes.some(other => other.record.content === hit.record.content)) quotes.push(hit)
          sourceHits.set(hit.record.id, quotes)
          hitsById.set(hit.record.id, hit)
          if (hasSubquestions) {
            if (!subquestionPrimaryIds.includes(hit.record.id)) subquestionPrimaryIds.push(hit.record.id)
          } else rootAcceptedById.set(hit.record.id, hit)
          if (recallObserver) traceRecall(recallObserver, { phase: 'source', id: hit.record.id, query: entry.plan.query })
        }
        coverage = slotPlans.map(plan => slotEvidence(plan, [...hitsById.values()], hasSubquestions))
        missingSlots = slotPlans.map((plan, index) => ({ plan, index })).filter(entry => coverage[entry.index].length === 0)
      }
      const selectionSlots = missingSlots.slice(0, MAX_RECALL_LOOKUPS).filter(entry => !localPassages.has(entry.plan.query))
      if (selectionSlots.length > 0 && isRecallQuestion(query) && !activeTurn?.private && !privateRecallQuery(query)) {
        const missingPlans = selectionSlots.map(entry => entry.plan)
        completionReceipt = await capture.selectRecall({
          session,
          turnKey,
          query,
          slots: missingPlans,
          candidates: candidatePool,
          signal: payload?.signal,
          modelSelection: payload?.modelSelection,
        })
        if (payload?.signal?.aborted === true) return withoutPrevious
        const slotKeysMatch = completionReceipt.slotDigest === recallSelectionSlotDigest(missingPlans)
        const refs = new Map((completionReceipt.candidateRefs ?? []).map(ref => [ref.id, ref.revision]))
        const sentCandidates = candidatePool.filter(hit => refs.get(hit.record.id) === hit.record.revision)
        const selections = slotKeysMatch && completionReceipt.state === 'completed' && Array.isArray(completionReceipt.selectionRefs)
          ? recoverRecallSelectionRefs(completionReceipt.selectionRefs, missingPlans, sentCandidates) : []
        const byId = new Map(sentCandidates.map(hit => [hit.record.id, hit]))
        const quoteListById = new Map()
        for (const selection of selections) {
          const missingSlot = selectionSlots[selection.slot]
          const pooled = byId.get(selection.id)
          if (!missingSlot || !pooled) continue
          const candidate = pooled.matchesByQuery?.get(missingSlot.plan.query) ?? { ...pooled, semantic: false }
          const knowledge = candidate.record.kind === 'knowledge'
          const tableRows = candidate.record.kind === 'knowledge' && ['retention', 'reason'].includes(missingSlot.plan.detail)
            ? matchingKnowledgeTableRows(candidate.record, selection.quote) : []
          if (tableRows.length > 1) continue
          const tableRow = tableRows[0]
          const quote = tableRow?.quote ?? contextualRecallQuote(candidate.record.content, selection.quote,
            knowledge || candidate.record.kind === 'source')
          if (!quote) continue
          const tableRecord = tableRow ? { ...candidate.record, recallQuote: quote, notePassages: [tableRow] } : null
          const supportsSlot = tableRecord ? slotEvidence(missingSlot.plan, [{ record: tableRecord }], true).length > 0
            : selectionFitsSlot(missingSlot.plan, candidate, quote)
          if (!supportsSlot) continue
          if (!matchesRecallTime(candidate.record, missingSlot.plan.timeIntent, now)) continue
          let selectedRecord
          if (candidate.record.kind === 'source') {
            if (!passageIndex.validate(candidate, identity.key) || !candidate.record.content.includes(selection.quote)) continue
            selectedRecord = { ...candidate.record, recallQuote: quote }
          } else if (candidate.record.kind === 'knowledge') {
            if (!knowledgeIndex.validate(candidate, identity.key) || !candidate.record.content.includes(selection.quote)) continue
            const passage = { ...(tableRow ?? { quote, section: '' }), question: missingSlot.plan.query,
              semantic: candidate.semantic === true }
            selectedRecord = { ...candidate.record, noteQuote: quote, recallQuote: quote, notePassages: [passage] }
          } else {
            const scopes = candidate.record.scope === 'global'
              ? [{ scope: 'global', projectKey: null }]
              : [{ scope: 'project', projectKey: identity.key }]
            const current = store.find(candidate.record.id, scopes)
            const selectionTime = missingSlot.plan.timeIntent
            if (!current || current.revision !== selection.revision || current.contentHash !== candidate.record.contentHash ||
                !isSafeRecallRecord(current, identity.key, selectionTime, now) || !current.content.includes(selection.quote)) continue
            selectedRecord = { ...current, recallQuote: quote }
          }
          if (!knowledge && !missingSlot.plan.requiresRelationTrace) {
            const quotes = quoteListById.get(selection.id) ?? []
            if (!quotes.includes(quote)) quotes.push(quote)
            quoteListById.set(selection.id, quotes)
          }
          const hit = { ...candidate, record: selectedRecord, score: Math.max(1, candidate.score ?? 0),
            matched: candidate.matched ?? [], termScores: candidate.termScores ?? [] }
          if (!knowledge || missingSlot.plan.requiresRelationTrace) {
            hit.selectedSlots = [...new Set([...(hitsById.get(selection.id)?.selectedSlots ?? []), missingSlot.plan.query])]
          }
          if (missingSlot.plan.requiresRelationTrace) {
            const relationHit = { ...hit, record: { ...hit.record } }
            delete relationHit.record.recallQuote
            delete relationHit.record.noteQuote
            const grounded = groundRelationCandidate(missingSlot.plan, relationHit)
            const seed = missingSlot.plan.relationSeedHit
            if (!grounded || !seed || !sameRelationScope(seed.record, grounded.record, identity.key)) continue
            hit.record = grounded.record
            hit.relationFromId = seed.record.id
            hit.relationFromRevision = seed.record.revision
            hit.relationFromTimeIntent = missingSlot.plan.relationSeedPlan?.timeIntent
            const existingSeed = hitsById.get(seed.record.id) ?? seed
            const supportLinks = existingSeed.relationSupportFor ?? []
            if (!supportLinks.some(link => link.targetId === hit.record.id)) {
              hitsById.set(seed.record.id, { ...existingSeed, relationSupportFor: [...supportLinks,
                { targetId: hit.record.id, timeIntent: hit.relationFromTimeIntent }] })
              if (!relationSupportIds.includes(seed.record.id)) relationSupportIds.push(seed.record.id)
              if (hasSubquestions && !subquestionPrimaryIds.includes(seed.record.id)) subquestionPrimaryIds.push(seed.record.id)
            }
          }
          if (knowledge && !missingSlot.plan.requiresRelationTrace) keepRecallHit(hitsById, hit)
          else hitsById.set(selection.id, hit)
          if (hasSubquestions) {
            if (!subquestionPrimaryIds.includes(selection.id)) subquestionPrimaryIds.push(selection.id)
          } else rootAcceptedById.set(selection.id, hitsById.get(selection.id))
        }
        for (const [id, quotes] of quoteListById) {
          const hit = hitsById.get(id)
          if (!hit) continue
          const joined = quotes.join('；')
          hitsById.set(id, { ...hit, record: { ...hit.record, recallQuote: joined } })
        }
        coverage = slotPlans.map(plan => slotEvidence(plan, [...hitsById.values()], hasSubquestions))
        missingSlots = slotPlans.map((plan, index) => ({ plan, index })).filter(entry => coverage[entry.index].length === 0)
      }
      // An exact local passage can fill its own slot without a selection request.
      // Semantic-only candidates still use the existing no-send fallback.
      for (const { plan } of missingSlots.slice(0, MAX_RECALL_LOOKUPS)) {
        const localPassage = localPassages.get(plan.query)
        if (localPassage) {
          const saved = appendPassageEvidence(hitsById, localPassage, plan)
          if (!hasSubquestions) rootAcceptedById.set(saved.record.id, saved)
          continue
        }
        if (completionReceipt?.callState !== 'not-sent') continue
        const rankedCandidates = []
        for (const candidate of candidatePool) {
          const hit = candidate.matchesByQuery?.get(plan.query) ?? candidate
          if (!matchesRecallTime(hit.record, plan.timeIntent, now)) continue
          if (hit.record.kind === 'source') {
            const evidence = directPassageEvidence(plan, hit, hasSubquestions)
            if (evidence) rankedCandidates.push({ hit: evidence, score: 2 + hit.score })
            continue
          }
          if (hit.record.kind === 'preference' && !isPreferenceQuery(plan.query)) continue
          // A vector alone cannot tie a global record to this project's question.
          if (hit.record.scope === 'global' && !isPreferenceQuery(plan.query) &&
              !slotEvidence(plan, [hit], hasSubquestions).length) continue
          const score = candidate.matchesByQuery?.get(plan.query)?.semanticScore ?? 0
          if (score >= STRONG_SEMANTIC_SCORE && selectionFitsSlot(plan, hit, hit.record.recallContent ?? hit.record.content)) {
            rankedCandidates.push({ hit, score })
          }
        }
        const candidate = rankedCandidates.sort((a, b) => b.score - a.score)[0]?.hit
        if (!candidate) continue
        if (candidate.record.kind === 'source') {
          const saved = appendPassageEvidence(hitsById, candidate, plan)
          if (!hasSubquestions) rootAcceptedById.set(saved.record.id, saved)
          continue
        }
        const quote = candidate.record.recallContent ?? candidate.record.content
        if (candidate.record.kind === 'knowledge') {
          const record = { ...candidate.record, recallQuote: quote, unverifiedRecall: true,
            notePassages: [{ quote, section: '', question: plan.query, verified: false }] }
          keepRecallHit(hitsById, { ...candidate, record, candidateSlots: [plan.query] })
          if (!hasSubquestions) rootAcceptedById.set(record.id, hitsById.get(record.id))
          else if (!subquestionPrimaryIds.includes(record.id)) subquestionPrimaryIds.push(record.id)
          continue
        }
        const old = hitsById.get(candidate.record.id)
        const quotes = [...new Set([...(old?.candidateQuotes ?? (old?.record.recallQuote ? [old.record.recallQuote] : [])), quote])]
        const hit = { ...candidate, ...old,
          record: { ...(old?.record ?? { ...candidate.record, unverifiedRecall: true }), recallQuote: quotes.join('；') },
          candidateQuotes: quotes,
          candidateSlots: [...new Set([...(old?.candidateSlots ?? []), plan.query])] }
        hitsById.set(hit.record.id, hit)
        if (hasSubquestions) {
          if (!subquestionPrimaryIds.includes(hit.record.id)) subquestionPrimaryIds.push(hit.record.id)
        } else rootAcceptedById.set(hit.record.id, hit)
      }
    }
    const calendarFor = comparison ? injectedIds => {
      const included = new Set(injectedIds)
      const verified = coverage.map(hits => hits.filter(hit => hit.record.unverifiedRecall !== true))
      const proofs = groups => groups.map((hits, index) => hits.map(hit => eventDateProof(hit, slotPlans[index])))
      if (!calendarIntervalFromProofs(comparison, proofs(verified))) return null
      return calendarIntervalFromProofs(comparison, proofs(verified.map(hits => hits.filter(hit => included.has(hit.record.id)))))
    } : undefined
    const quantityFor = discount ? ids => describeDiscount(discount, discountEvidence, ids) : quantityQuestion ? injectedIds => {
      const delivered = new Set(injectedIds), hits = [...hitsById.values()]
      const proofs = slotPlans.map(plan => {
        const candidates = slotEvidence(plan, hits, true).filter(hit => hit.record.unverifiedRecall !== true)
          .map(hit => ({ id: hit.record.id, proof: quantityEvidence(plan, hit.record.recallQuote ?? hit.record.content) }))
          .filter(item => item.proof)
        const agreed = new Set(candidates.map(item => quantityProofKey(item.proof)))
        const owners = new Set(candidates.map(item => item.proof.owner?.toLowerCase()).filter(Boolean))
        if (agreed.size > 1 || plan.quantity.scope && !plan.quantity.scope.entity && owners.size > 1) return { ambiguous: true }
        const verified = candidates.find(item => delivered.has(item.id))?.proof
        if (verified || !plan.quantity.scope) return verified ?? null
        return relatedQuantities.get(plan.query)?.quantityProof ?? null
      })
      return describeQuantities(slotPlans, proofs)
    } : undefined
    const updateLastRecall = (injectedIds = [], quantityCheck = null, calendarCheck = null, calendarEvidence = null,
      renderedWindowLines = null) => {
      const reportEvidence = hit => recallEvidenceReport(hit, sourceRefs => recallReportStore.filterSourceRefs(sourceRefs), noteAuthority)
      coverage = slotPlans.map(plan => slotEvidence(plan, [...hitsById.values()], hasSubquestions))
      missingSlots = slotPlans.map((plan, index) => ({ plan, index })).filter(entry => coverage[entry.index].length === 0)
      if (!isRecallQuestion(query) && hitsById.size === 0) return
      const delivered = new Set(injectedIds)
      const injectedCoverage = coverage.map(hits => hits.filter(hit => delivered.has(hit.record.id)))
      const locationIncomplete = locationPlan && !injectedCoverage[0].some(({ record }) =>
        !record.unverifiedRecall && containsEventLocation(formatMemoryLine(record), locationPlan))
      const answerableCoverage = locationIncomplete ? [[]] : injectedCoverage
      const reportItems = covered => slotPlans.map((plan, index) => ({
        query: plan.query,
        evidence: [...new Map(covered[index].map(hit => [hit.record.id, hit])).values()].map(reportEvidence),
      })).filter(item => item.evidence.length > 0)
      const questions = slotPlans.map((plan, index) => {
        const candidateHits = [...hitsById.values()].filter(hit => hit.candidateSlots?.includes(plan.query))
        const related = [...new Map([...coverage[index], ...candidateHits].map(hit => [hit.record.id, hit])).values()]
        const deliveredHits = related.filter(hit => delivered.has(hit.record.id))
        const notInjected = coverage[index].filter(hit => !delivered.has(hit.record.id))
        const verified = hit => hit.record.unverifiedRecall !== true && !hit.candidateSlots?.includes(plan.query)
        const item = hit => ({ ...reportEvidence(hit), verified: verified(hit) })
        const purchase = plan.purchasePrice ? deliveredDiscountFact(discountEvidence.candidates[index], delivered) : null
        const differentMeasure = relatedQuantities.get(plan.query)
        const conflicts = valueConflicts.filter(group => group.query === plan.query)
        const alternatives = conflicts.flatMap(group => group.alternatives)
        const observed = related.map(item)
        const calendarDate = comparison && !comparison.order && !calendarCheck &&
          deliveredHits.some(verified)
          ? agreedCalendarDate(coverage[index].filter(verified).map(hit => eventDateProof(hit, plan))) : null
        if (differentMeasure && !observed.some(hit => hit.id === differentMeasure.record.id)) {
          observed.push({ ...reportEvidence(differentMeasure), verified: false, measure: differentMeasure.quantityProof.related })
        }
        return {
          query: plan.query,
          detail: plan.detail ?? null,
          ...(plan.stateField ? { stateField: plan.stateField } : {}),
          ...(plan.timeMeasure?.period ? { timeMeasurePeriod: plan.timeMeasure.period } : {}),
          ...(plan.timeMeasure?.mode === 'commute' ? { timeMeasureDirection: true } : {}),
          ...(plan.timeMeasure ? { timeMeasureSubject: plan.timeMeasure.subject } : {}),
          ...(plan.quantity ? { quantity: plan.quantity } : {}),
          ...(plan.purchasePrice ? { purchasePrice: plan.purchasePrice,
            purchaseValue: purchase && (purchase.named || discountEvidence.checked) ? purchase.value.value : null } : {}),
          ...(comparison ? { calendar: calendarCheck } : {}),
          ...(calendarDate ? { calendarDate } : {}),
          ...(plan.eventWindow?.bounds ? { eventWindow: {
            bounds: plan.eventWindow.bounds, referenceDay: plan.eventWindow.referenceDay,
          } } : {}),
          ...(locationIncomplete ? { eventLocationIncomplete: true } : {}),
          ...(conflicts.length ? { valueConflict: true,
            conflictingValues: alternatives.every(entry => delivered.has(entry.id)) ? [...new Set(alternatives.map(entry => entry.value))] : [] } : {}),
          entityTerms: plan.entityTerms ?? [],
          hits: observed,
          injected: deliveredHits.map(hit => {
            const passages = hit.record.notePassages ?? []
            const notePassages = passages.filter(passage => hit.record.recallQuote?.includes(passage.quote) &&
              (passage.question !== undefined ? passage.question === plan.query :
                slotEvidence(plan, [{ record: { ...hit.record, recallQuote: passage.quote, notePassages: [passage] } }], hasSubquestions).length > 0))
            const evidence = notePassages.length > 0
              ? { ...hit.record, notePassages, unverifiedRecall: notePassages.every(passage => passage.verified === false),
                recallQuote: [...new Set(notePassages.map(passage => passage.quote))].join('\n') }
              : hit.record
            const text = calendarEvidence ?? renderedWindowLines?.get(hit.record.id) ?? formatMemoryLine(evidence)
            const measurements = (evidence.recallTimeMeasures ?? []).filter(measure => measure.query === plan.query)
            const itemPriceQuote = plan.quantity?.scope?.role === 'item-price'
              ? quantityEvidence(plan, evidence.recallQuote ?? evidence.content)?.quote : undefined
            const selectedQuote = (measurements[0]?.quote ??
              itemPriceQuote ??
              (plan.stateField ? stateFieldEvidence(plan.stateField, evidence.recallQuote ?? evidence.content)?.quote : undefined) ??
              notePassages.find(passage => passage.semantic && passage.verified !== false)?.quote)
              ?.replace(/\s+/gu, ' ').trim()
            const reasonPhrases = plan.detail === 'reason' ? (evidence.notePassages ?? []).flatMap(passage => {
              const phrase = passage.tableReason?.replace(/\s+/gu, ' ').trim()
              if (!phrase || !text.includes(phrase)) return []
              const proof = { ...hit.record, recallQuote: passage.quote, notePassages: [passage] }
              return slotEvidence(plan, [{ record: proof }], true).length ? [phrase] : []
            }) : []
            return { ...item(hit), text, ...(selectedQuote && text.includes(selectedQuote) ? { selectedQuote } : {}),
              ...(measurements.length ? { timeMeasureValues: [...new Set(measurements.map(measure => measure.value))] } : {}),
              ...(measurements.some(measure => measure.disputed) ? { timeMeasureDisputed: true } : {}),
              ...(reasonPhrases.length ? { reasonPhrases } : {}) }
          }),
          notInjected: notInjected.map(item),
          answerCoverage: 'pending',
          answerExcerpt: null,
        }
      })
      const report = {
        at: now,
        projectKey: identity.key,
        turnKey,
        outcome: 'pending',
        total: slotPlans.length,
        questions,
        ...(quantityCheck ? { quantityCheck } : {}),
        retrieved: reportItems(coverage),
        covered: reportItems(answerableCoverage),
        candidates: slotPlans.map(plan => ({ query: plan.query, evidence: [...hitsById.values()]
          .filter(hit => delivered.has(hit.record.id) && hit.candidateSlots?.includes(plan.query)).map(reportEvidence) }))
          .filter(item => item.evidence.length > 0),
        missing: slotPlans.filter((_, index) => answerableCoverage[index].length === 0).map(plan => plan.query),
        unresolved: locationIncomplete ? [slotPlans[0].query] : missingSlots.map(entry => entry.plan.query),
        budgetOmitted: slotPlans.filter((_, index) => coverage[index].length > 0 && injectedCoverage[index].length === 0).map(plan => plan.query),
        deferred: slotPlans.filter(plan => !searchPlan.includes(plan)).map(plan => plan.query),
        providerState: completionReceipt?.callState ?? (missingSlots.length === 0 ? 'not-needed' : 'not-sent'),
        completionState: completionReceipt?.state ?? (missingSlots.length === 0 ? 'not-needed' : 'not-sent'),
        provider: completionReceipt?.route ? { ...completionReceipt.route } : null,
        usage: completionReceipt?.usage ?? null,
        estimatedPromptTokens: completionReceipt?.promptTokens ?? null,
        reason: completionReceipt?.reason ?? null,
        semantic: semanticIndex.status(),
        localDeepRecall,
      }
      const currentTurn = sessionId === undefined ? null : recallTurnBySession.get(sessionId)
      if (currentTurn && currentTurn.generation === turnGeneration && !currentTurn.invalidated &&
          currentTurn.turnKey === turnKey && currentTurn.projectKey === identity.key) {
        setRecallReport(lastRecallBySession, sessionId, report)
      }
    }
    const appendOpening = (block, itemLimit) => {
      if (!openingSubject || hasSubquestions || payload.signal?.aborted || activeTurn?.invalidated ||
          !config.inject.enabled || config.inject.openingProjectKey !== identity.key) return block
      const remainingItems = itemLimit - (block?.itemCount ?? 0) - (block?.profileIds.length ?? 0)
      const remainingTokens = contextBudget - (block?.estimatedTokens ?? 0) - 4
      if (remainingItems <= 0 || remainingTokens <= 0) return block
      const ending = '\n</memory-context>'
      if (block && !block.text.endsWith(ending)) return block
      const base = block === null ? '<memory-context source="dsh-memory" note="历史资料，仅供项目接续参考。">' :
        block.text.slice(0, -ending.length)
      const wrapperTokens = block === null ? estimateTokens(base + ending) : 0
      runtime.synchronize(identity.key)
      const opening = selectOpeningBrief(store, index, {
        projectKey: identity.key, subject: openingSubject, now, maxTokens: Math.min(92, remainingTokens) - wrapperTokens,
        maxItems: Math.min(3, remainingItems), existing: block,
        eligible: record => isSafeRecallRecord(record, identity.key, { kind: 'current', at: now }, Date.now()) &&
          (!record.sourceRefs?.length || recallReportStore.filterSourceRefs(record.sourceRefs).length === record.sourceRefs.length),
      })
      if (opening === null) return block
      const text = base + '\n' + opening.text + ending
      const estimatedTokens = estimateTokens(text)
      if (estimatedTokens + 4 > contextBudget || estimatedTokens - (block?.estimatedTokens ?? 0) + 4 > 96) return block
      for (const hit of opening.hits) {
        if (!hitsById.has(hit.record.id)) hitsById.set(hit.record.id, { ...hit, candidateSlots: [slotPlans[0].query] })
      }
      noteInFlightEvidence()
      return {
        ...block, text, estimatedTokens,
        ids: [...(block?.ids ?? []), ...opening.hits.map(hit => hit.record.id)],
        profileIds: block?.profileIds ?? [],
        itemCount: (block?.itemCount ?? 0) + opening.hits.length,
      }
    }
    const deliverOpeningOnly = () => {
      const block = appendOpening(null, config.inject.maxItems)
      if (block === null) return withoutPrevious
      updateLastRecall(block.ids)
      return deliver(block, { beforeQuestion: false, gate: { auto: 0, gray: 0 } })
    }
    if (relatedQuantities.size) {
      const authorized = new Set(passageIndex.validateMany([...relatedQuantities.values()], identity.key, { now }))
      for (const [query, hit] of relatedQuantities) if (!authorized.has(hit)) relatedQuantities.delete(query)
      noteInFlightEvidence()
    }
    updateLastRecall()
    const removeRecallHit = id => {
      const dependents = [...hitsById.values()].filter(hit => hit.relationFromId === id).map(hit => hit.record.id)
      hitsById.delete(id)
      rootAcceptedById.delete(id)
      sourceHits.delete(id)
      const primaryIndex = subquestionPrimaryIds.indexOf(id)
      if (primaryIndex >= 0) subquestionPrimaryIds.splice(primaryIndex, 1)
      const qualifiedIndex = qualifiedValueIds.indexOf(id)
      if (qualifiedIndex >= 0) qualifiedValueIds.splice(qualifiedIndex, 1)
      for (const [otherId, hit] of hitsById) {
        if (!hit.relationSupportFor?.some(link => link.targetId === id)) continue
        const relationSupportFor = hit.relationSupportFor.filter(link => link.targetId !== id)
        const { relationSupportFor: _removed, ...withoutLinks } = hit
        hitsById.set(otherId, relationSupportFor.length ? { ...withoutLinks, relationSupportFor } : withoutLinks)
      }
      for (const dependent of dependents) removeRecallHit(dependent)
    }
    if (hitsById.size === 0 && relatedQuantities.size === 0) {
      if (grayById.size > 0) {
        writeGateLog(root, { at: now, query: attempts.join(' | '), ids: [...grayById.keys()], thresholds: gateThresholds })
      }
      const result = deliverOpeningOnly()
      if (result === withoutPrevious && recallObserver !== null) {
        traceRecall(recallObserver, { phase: 'inject', status: 'no-accepted-evidence', ids: [], text: null })
      }
      return result
    }
    const validSourceHits = new Set(passageIndex.validateMany(
      [...hitsById.values()].filter(hit => hit.record.kind === 'source'), identity.key, { now },
    ))
    for (const [id, hit] of hitsById) {
      if (hit.record.kind === 'source') {
        const previous = hit.calendarLinks ? passageIndex.previousMessages(hit, identity.key, { now }) : []
        if (!validSourceHits.has(hit) || hit.calendarLinks?.some(link =>
          calendarParticipantAnchor(previous, link.participant)?.hit.record.id !== link.anchor.record.id)) removeRecallHit(id)
        continue
      }
      if (hit.record.kind === 'knowledge') {
        if (!knowledgeIndex.validate(hit, identity.key)) removeRecallHit(id)
        continue
      }
      if (sourceHits.has(id)) continue
      const scopes = hit.record.scope === 'global'
        ? [{ scope: 'global', projectKey: null }]
        : [{ scope: 'project', projectKey: identity.key }]
      const current = store.find(id, scopes)
      const quotesValid = typeof hit.record.recallQuote !== 'string' || hit.record.recallQuote.split('；')
        .filter(Boolean).every(quote => current?.content.includes(quote))
      const linkedRelationValid = hit.relationFromId === undefined || (() => {
        const support = hitsById.get(hit.relationFromId)
        const relationTime = hit.relationFromTimeIntent ?? slotPlans.find(plan => plan.query === hit.selectedSlots?.at(-1))?.timeIntent
        return support?.record.revision === hit.relationFromRevision && relationTime &&
          sameRelationScope(support.record, current, identity.key) &&
          isSafeRecallRecord(support.record, identity.key, relationTime, now)
      })()
      const validRelationSupport = (hit.relationSupportFor ?? []).some(link => {
        const target = hitsById.get(link.targetId)
        return target?.relationFromId === id && target.relationFromRevision === current?.revision &&
          isSafeRecallRecord(current, identity.key, link.timeIntent, now)
      })
      if (!current || current.revision !== hit.record.revision || current.contentHash !== hit.record.contentHash ||
          !slotPlans.some(plan => isSafeRecallRecord(current, identity.key, plan.timeIntent, now) &&
            (slotEvidence(plan, [hit], hasSubquestions).length > 0 || hit.candidateSlots?.includes(plan.query))) &&
          !validRelationSupport || !quotesValid || !linkedRelationValid) {
        removeRecallHit(id)
      } else {
        hitsById.set(id, { ...hit, record: {
          ...current,
          ...(hit.record.unverifiedRecall ? { unverifiedRecall: true } : {}),
          ...(typeof hit.record.recallQuote === 'string' ? { recallQuote: hit.record.recallQuote } : {}),
        } })
      }
    }
    // A compact record can answer one part and its verified quote another.
    // Preserve both in the same budgeted slot.
    const revalidateSource = sourceResolver(root, store, identity.key, now)
    for (const [id, quotes] of sourceHits) {
      const accepted = hitsById.get(id)
      if (!accepted) continue
      const original = store.find(id, [{scope: 'project', projectKey: identity.key}])
      if (!original || original.status !== 'active' || quotes.some(hit => original.revision !== hit.record.revision)) {
        removeRecallHit(id)
        continue
      }
      const excerpts = quotes.filter(hit => slotPlans.some(plan => {
        if (plan.timeIntent.kind !== 'current') return false
        const fresh = revalidateSource(plan, [hit])
        return fresh?.sourceId === hit.sourceId && fresh.record.content === hit.record.content
      })).map(hit => hit.record.content)
      if (excerpts.length === 0) {
        removeRecallHit(id)
        continue
      }
      const quote = [...new Set([
        ...(typeof accepted.record.recallQuote === 'string' ? accepted.record.recallQuote.split('；') : []),
        ...excerpts,
      ].filter(Boolean))].join('；')
      hitsById.set(id, {...accepted, record: {...original, recallQuote: quote}})
    }
    for (const [id, hit] of [...hitsById]) {
      if (hit.relationFromId === undefined) continue
      const support = hitsById.get(hit.relationFromId)
      const relationTime = hit.relationFromTimeIntent ?? slotPlans.find(plan => plan.query === hit.selectedSlots?.at(-1))?.timeIntent
      if (!support || support.record.revision !== hit.relationFromRevision || !relationTime ||
          !sameRelationScope(support.record, hit.record, identity.key) ||
          !isSafeRecallRecord(support.record, identity.key, relationTime, now)) removeRecallHit(id)
    }
    for (const [id, hit] of [...hitsById]) {
      if (!hit.relationSupportFor) continue
      const relationSupportFor = hit.relationSupportFor.filter(link => {
        const target = hitsById.get(link.targetId)
        return target?.relationFromId === id && target.relationFromRevision === hit.record.revision
      })
      if (relationSupportFor.length) {
        hitsById.set(id, { ...hit, relationSupportFor })
      } else {
        const { relationSupportFor: _removed, ...withoutLinks } = hit
        hitsById.set(id, withoutLinks)
        if (!slotPlans.some(plan => isSafeRecallRecord(hit.record, identity.key, plan.timeIntent, now) &&
            slotEvidence(plan, [hit], hasSubquestions).length > 0)) removeRecallHit(id)
      }
    }
    if (comparison) {
      for (const [id, hit] of hitsById) {
        const proofs = slotPlans.map(plan => eventDateProof(hit, plan)).filter(Boolean)
        if (proofs.length === 0) { removeRecallHit(id); continue }
        const recallQuote = [...new Set(proofs.map(proof => proof.quote))].join('；')
        const proof = proofs.length === 1 && hit.record.kind === 'source' ? proofs[0] : null
        let recallEventPeriod
        if (proof && comparison.order) recallEventPeriod = calendarOrderPeriod(proof)
        else if (Number.isSafeInteger(proof?.latestDay)) recallEventPeriod = calendarOrderPeriod({ from: null, to: proof.latestDay + 1 })
        else if (proof?.relative) recallEventPeriod = agreedCalendarDate([proof])
        hitsById.set(id, { ...hit, record: { ...hit.record, recallQuote, ...(recallEventPeriod ? { recallEventPeriod } : {}) } })
      }
    }
    const comparesEffectiveDate = hasSubquestions && slotPlans.some(plan => plan.timeIntent.kind === 'as-of')
    for (const plan of slotPlans) {
      const labelCurrent = comparesEffectiveDate && plan.timeIntent.kind === 'current'
      if (!labelCurrent && plan.timeIntent.kind !== 'as-of') continue
      const at = plan.timeIntent.at
      for (const hit of slotEvidence(plan, [...hitsById.values()], hasSubquestions)) {
        if (hit.record.unverifiedRecall || hit.record.recallEventPeriod) continue
        if (labelCurrent) {
          hitsById.set(hit.record.id, { ...hit, record: { ...hit.record, recallCurrent: true } })
          continue
        }
        const dates = hit.record.recallEffectiveAt ?? []
        if (!dates.includes(at)) hitsById.set(hit.record.id, { ...hit,
          record: { ...hit.record, recallEffectiveAt: [...dates, at] } })
      }
    }
    valueConflicts = verifiedKnowledgeConflicts(knownValueConflicts, hitsById)
    updateLastRecall()
    if (hitsById.size === 0 && relatedQuantities.size === 0) return deliverOpeningOnly()
    const hits = [...hitsById.values()]
    const budget = hasSubquestions ? availableMemoryTokens : adaptiveInjectionBudget(availableMemoryTokens, hits.length, followUp)
    contextBudget = budget
    const maxItems = followUp && !hasSubquestions ? Math.min(4, config.inject.maxItems) : config.inject.maxItems
    const topicCounts = new Map()
    for (const hit of hits.slice(0, 8)) {
      const topic = hit.record.topic
      if (typeof topic === 'string' && topic !== '') topicCounts.set(topic, (topicCounts.get(topic) ?? 0) + 1)
    }
    const topicHint = [...topicCounts].sort((left, right) => right[1] - left[1])[0]
    const rankedAll = rankHits(hits, {
      now,
      minScore: 0,
      maxItems: hits.length,
      topicHint: topicHint !== undefined && topicHint[1] >= 2 ? topicHint[0] : null,
    }).map(hit => {
      const relation = hitsById.get(hit.record.id)
      return relation?.relationFromId ? { ...hit, relationFromId: relation.relationFromId } : hit
    })
    const rankedById = new Map(rankedAll.map((hit) => [hit.record.id, hit]))
    const rankedRootIds = rankHits([...rootAcceptedById.values()], {
      now, minScore: 0, maxItems: rootAcceptedById.size,
      topicHint: topicHint !== undefined && topicHint[1] >= 2 ? topicHint[0] : null,
    }).map((hit) => hit.record.id)
    const prioritizedIds = [...new Set([...relationSupportIds, ...subquestionPrimaryIds, ...rankedRootIds, ...qualifiedValueIds])]
    const prioritized = prioritizedIds.map((id) => rankedById.get(id)).filter(Boolean)
    const ranked = [...prioritized, ...rankedAll.filter((hit) => !prioritizedIds.includes(hit.record.id))]
    if (recallObserver !== null) traceRecall(recallObserver, {
      phase: 'selection', primaryIds: subquestionPrimaryIds, rootAcceptedIds: rankedRootIds, qualifiedExtraIds: qualifiedValueIds,
    })
    if (recallObserver !== null) traceRecall(recallObserver, { phase: 'rank', ids: ranked.map((hit) => hit.record.id) })
    const preferenceIntent = attempts.some(isPreferenceQuery)
    const profile = preferenceIntent ? deriveProfile(hits.map(hit => hit.record).filter(record =>
      record.kind === 'preference' && record.unverifiedRecall !== true), { limit: 2, now }) : null
    const profileLines = profile === null ? [] : formatProfileLines(profile.traits, { limit: 2, maxChars: 300, compact: true })
    const evidenceSlots = hasSubquestions ? slotPlans.map(plan => {
      const confirmed = slotEvidence(plan, ranked.map(hit => hitsById.get(hit.record.id) ?? hit), true)
      return (confirmed.length ? confirmed : hits.filter(hit => hit.candidateSlots?.includes(plan.query))).map(hit => hit.record.id)
    }) : []
    const occurrenceOrder = comparison?.order && comparison.language === 'en' && ['occur', 'task'].includes(comparison.action)
    const calendarSourceIds = occurrenceOrder ? coverage.flatMap(hits => {
      const evidence = hits.find(hit => hit.record.unverifiedRecall !== true)
      return evidence ? [evidence.record.id] : []
    }) : undefined
    const reasonPlan = hasSubquestions ? slotPlans.find(plan => plan.detail === 'reason') : undefined
    const reasonAnchors = reasonPlan ? recallAnchorTerms(reasonPlan.query) : []
    const explainChange = reasonPlan && ranked.some(hit => {
      const quote = hit.record.recallQuote
      return typeof quote === 'string' && supportsAdjacentProperty(reasonPlan, { record: { ...hit.record, content: quote } }, reasonAnchors)
    })
    let block = compileMemoryContext(ranked, {
      maxTokens: budget,
      maxItems,
      evidenceSlots,
      explainChange,
      evidenceLanguage: hasSubquestions && !/\p{Script=Han}/u.test(query) &&
        ranked.some(hit => hit.record.notePassages?.some(passage => passage.semantic)) ? 'en' : undefined,
      valueConflicts,
      timeMeasure: timeMeasurePlans.some(plan => plan.timeMeasureComparison) ? 'comparison'
        : timeMeasurePlans.some(plan => plan.timeMeasure.mode === 'allocation') ? 'allocation'
          : latestTimeMeasure ?? (timeMeasurePlans.length > 0),
      timeMeasureLanguage: timeMeasurePlans[0]?.timeMeasure.language,
      calendarFor,
      eventWindow,
      calendarOrder: comparison?.order ? comparison : undefined,
      calendarSourceIds,
      discountLanguage: discount?.language,
      quantityScope: scopedQuantity ? slotPlans[0].quantity : undefined,
      quantityQuestion,
      quantityFor,
      profileLimit: 2,
      profileLines,
      skipCapture: analyzeUserMessageControls(query).noSaveDirective,
    })
    block = appendOpening(block, maxItems)
    updateLastRecall([...(block?.ids ?? []), ...(block?.profileIds ?? [])], block?.quantityCheck, block?.calendarCheck,
      block?.calendarEvidence, block?.renderedWindowLines)
    if (block === null) {
      if (recallObserver !== null) traceRecall(recallObserver, { phase: 'inject', status: 'budget-empty', ids: [], text: null, budget })
      return withoutPrevious
    }
    return deliver(block, { beforeQuestion: occurrenceOrder, gate: { auto: hits.length, gray: grayById.size } })
    } catch (error) {
      recallFailures++
      ctx.logger?.warn?.(`[dsh-memory] recall skipped: ${error instanceof Error ? error.message : String(error)}`)
      return withoutPrevious
    } finally {
      const currentTurn = sessionId ? recallTurnBySession.get(sessionId) : null
      if (currentTurn && currentTurn.generation === activeRecallGeneration) currentTurn.recallInProgress = false
      if (sessionId && payload?.signal?.aborted !== true) {
        contextUsageBySession.delete(sessionId)
        contextUsageBySession.set(sessionId, {
          at: Date.now(),
          tokens: deliveredBlock?.estimatedTokens ?? 0,
          items: deliveredBlock ? deliveredBlock.itemCount + deliveredBlock.profileIds.length : 0,
          budget: contextBudget,
        })
        if (contextUsageBySession.size > CONTEXT_USAGE_SESSION_LIMIT) {
          contextUsageBySession.delete(contextUsageBySession.keys().next().value)
        }
      }
    }
  })
    hookHealth.preStepRegistered = true
  } catch { hookHealth.preStepRegistered = false }

  }

  const getLastRecallAsync = async (input, resolvedProjectKey = undefined) => {
    const sessionId = typeof input?.sessionId === 'string' ? input.sessionId : undefined
    if (sessionId === undefined) return null
    if (lastRecallBySession.has(sessionId)) {
      const report = lastRecallBySession.get(sessionId)
      if (report === null) return null
      if (recallReportStore.isInvalidated(report)) {
        lastRecallBySession.delete(sessionId)
        return null
      }
      const projectKey = resolvedProjectKey === undefined ? await resolveSessionProjectKey(sessionId) : resolvedProjectKey
      if (projectKey === null || input?.projectKey !== undefined && input.projectKey !== null && input.projectKey !== '' && input.projectKey !== projectKey) return null
      return report?.projectKey === projectKey ? report : null
    }
    if (!recallReportStore.has(sessionId)) return null
    const projectKey = resolvedProjectKey === undefined ? await resolveSessionProjectKey(sessionId) : resolvedProjectKey
    if (projectKey === null || input?.projectKey !== undefined && input.projectKey !== null && input.projectKey !== '' && input.projectKey !== projectKey) return null
    return recallReportStore.get(sessionId, projectKey)
  }

  return {
    registerHooks,
    invalidateReferences,
    getLastRecallAsync,
    getLastInjection: () => lastInjection,
    getContextUsage: sessionId => contextUsageBySession.get(sessionId),
    getMetrics: () => ({ recallAttempts, recallFailures, lexicalRuns, lexicalFailures, injectionCount }),
  }
}
