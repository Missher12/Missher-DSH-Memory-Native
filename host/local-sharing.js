/** Local HTTP/MCP clients over the existing DSH authority. */
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createRecallReportStore } from './recall-reports.js'
import { createPanelBackend } from './remote.js'
import { deriveProjectBrief } from './project-brief.js'
import { isValidProjectKey } from './paths.js'
import { openMemoryRuntime } from './startup.js'
import { buildRecord, CONTENT_LIMITS, looksSensitive } from './records.js'
import { formatSceneBlock } from './scene-format.js'
import { canReadSource } from './capture-journal.js'
import { canGrantSourceRecall, DEEP_RECALL_TOKEN_LIMIT, grantSourceRecall, isRecallSourceStatement, SourcePassageIndex, withSourceRecallLock } from './source-passages.js'
import { saveSource, sourceIdOf } from './capture-journal.js'
import { analyzeUserMessageControls, explicitRememberText } from './user-controls.js'
import { clearLastUsersForSources } from './local-sharing-hook-state.js'
import { conflictsRecallProject, recallNamedProjectTerms, recallTimeIntent } from './recall.js'
import { calendarEventEvidence, calendarEventWindow, calendarOrderEvidence, calendarWindowEvidence, calendarWindowPrompt } from './calendar-recall.js'
import { directPassageEvidence, findAdviceEvidence, findRecentTimeMeasures, isSafeRecallRecord, slotEvidence } from './recall-flow.js'
import { usesLatestTimeEvidence } from './time-measure-recall.js'
import { retrieveDeclaredCount } from './declared-count.js'
import { retrieveElapsed } from './elapsed-recall.js'
import { retrieveDurationAtEvent } from './duration-at-event-recall.js'
import { retrieveReportedCounters } from './counter-recall.js'
import { eventAgeQuery, retrieveEventAge } from './event-age-recall.js'
import { eventCountQuery, retrieveEventCount } from './event-count-recall.js'
import { marketSalesQuery, retrieveMarketSales } from './market-sales-recall.js'
import { expenseQuery, retrieveExpenses } from './dated-expenses-recall.js'
import { personalFundraisingQuery, retrievePersonalFundraising } from './personal-fundraising-recall.js'
import { normalizeClientTimeZone, sourceEventTime } from './source-time.js'
import { readDataOwner } from './storage-boundary.js'

const hash = value => createHash('sha256').update(value).digest('hex')
const localTimeZone = () => normalizeClientTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone)

function projectKeyOf(input, boundProjectKey) {
  const requested = input ?? boundProjectKey
  if (!isValidProjectKey(requested)) throw new TypeError('a valid project key is required')
  if (boundProjectKey !== null && requested !== boundProjectKey) throw new Error('request is outside the client bound project')
  return requested
}

function asResult(hit) {
  return { id: hit.record.id, revision: hit.record.revision, kind: hit.record.kind,
    scope: hit.record.scope, projectKey: hit.record.projectKey ?? null, content: hit.record.content,
    score: hit.score, verified: hit.record.unverifiedRecall !== true,
    sourceRefs: (hit.record.sourceRefs ?? []).map(ref => ({ ...ref })) }
}

function sharedReceiptEvidence(passages, reports, query, key, now, limit) {
  const { questionText } = analyzeUserMessageControls(query)
  const sales = marketSalesQuery(questionText)
  const fundraising = sales ? null : personalFundraisingQuery(questionText)
  const expenses = sales || fundraising ? null : expenseQuery(questionText, { eventTime: now, timeZone: localTimeZone() })
  if (!sales && !fundraising && !expenses) return null
  const retrieve = sales ? retrieveMarketSales : fundraising ? retrievePersonalFundraising : retrieveExpenses
  const named = recallNamedProjectTerms(query)
  const result = retrieve(passages, sales ?? fundraising ?? expenses, { projectKey: key, now, maxTokens: 360,
    maxItems: Math.min(6, limit), scanLimit: DEEP_RECALL_TOKEN_LIMIT, accepts: hit => !conflictsRecallProject(hit, named) })
  const hits = result.injected.flatMap(({ row, text, selectedQuote }) => {
    const sourceRefs = filteredRefs(row.hit.record.sourceRefs, reports)
    return sourceRefs.length ? [{ ...asResult(row.hit), content: text, sourceRefs, selectedQuote }] : []
  })
  if (hits.length !== result.injected.length) return { hits: [] }
  const proof = sales ? { marketSales: result.marketSales }
    : fundraising ? { personalFundraising: result.personalFundraising } : { expenses: result.expenses }
  const withheldHits = hits.length ? [] : result.hits.flatMap(hit => {
    const sourceRefs = filteredRefs(hit.record.sourceRefs, reports)
    return sourceRefs.length ? [{ ...asResult(hit), sourceRefs }] : []
  })
  return { hits, withheldHits, ...proof, countExplanation: result.summary }
}

function sharedActivityEvidence(passages, reports, slot, key, now, limit) {
  if (slot.quantity || slot.personalQuestion || slot.calendarComparison || slot.eventOrder || slot.declaredCount || slot.elapsed) return null
  const { questionText } = analyzeUserMessageControls(slot.query)
  const clock = { eventTime: now, timeZone: localTimeZone() }
  const window = calendarEventWindow(questionText, clock)
  if (window) {
    if (!window.bounds) return { hits: [] }
    const projectTerms = recallNamedProjectTerms(slot.query)
    const eligible = new Map()
    for (const hit of passages.search(window.search, { projectKey: key, now, limit: 40 })) {
      if (hit.record.sourceRefs[0].eventTime > now ||
          !isSafeRecallRecord(hit.record, key, { kind: 'current', at: now }, now) ||
          conflictsRecallProject(hit, projectTerms)) continue
      const evidence = calendarWindowEvidence(hit.record, window)
      if (!evidence || !isRecallSourceStatement(evidence.quote)) continue
      const refs = filteredRefs(hit.record.sourceRefs, reports)
      const sourceId = refs[0]?.sourceId
      if (!sourceId || eligible.has(sourceId)) continue
      eligible.set(sourceId, { hit, evidence, refs })
    }
    const all = [...eligible.values()]
    const named = all.filter(item => item.evidence.namesObject)
    const chosen = named.length ? named.slice(0, Math.min(3, limit)) : all.slice(0, 1)
    return { hits: chosen.map(({ hit, evidence, refs }) => ({ ...asResult(hit), content: evidence.quote,
      selectedQuote: evidence.quote, sourceRefs: refs, eventPeriod: evidence.period, resolvedEvent: evidence.resolved, resolvedLanguage: window.language,
      verified: Boolean(evidence.namesObject && hit.record.remembered) })),
      eventWindow: { bounds: window.bounds, referenceDay: window.referenceDay },
      countExplanation: chosen.length ? calendarWindowPrompt(window) : undefined }
  }

  const age = eventAgeQuery(questionText)
  if (age) {
    const named = recallNamedProjectTerms(slot.query)
    const result = retrieveEventAge(passages, age, { projectKey: key, clock, maxTokens: 360,
      maxItems: Math.min(6, limit), scanLimit: DEEP_RECALL_TOKEN_LIMIT, accepts: hit => !conflictsRecallProject(hit, named) })
    if (result.hits.length || result.budgetOmitted) {
      const hits = result.injected.flatMap(({ row, text, selectedQuote }) => {
        const sourceRefs = filteredRefs(row.hit.record.sourceRefs, reports)
        return sourceRefs.length ? [{ ...asResult(row.hit), content: text, sourceRefs, selectedQuote }] : []
      })
      const withheldHits = hits.length ? [] : result.hits.flatMap(hit => {
        const sourceRefs = filteredRefs(hit.record.sourceRefs, reports)
        return sourceRefs.length ? [{ ...asResult(hit), sourceRefs }] : []
      })
      return { hits, withheldHits, eventAge: hits.length ? result.eventAge : { days: null } }
    }
  }
  const count = eventCountQuery(questionText, clock)
  if (!count) return null
  const result = retrieveEventCount(passages, count, { projectKey: key, now, maxTokens: 360,
    maxItems: Math.min(6, limit), scanLimit: DEEP_RECALL_TOKEN_LIMIT })
  const grouped = new Map()
  for (const { row, period } of result.injected) {
    const sourceRefs = filteredRefs(row.hit.record.sourceRefs, reports)
    if (!sourceRefs.length) return { hits: [] }
    const previous = grouped.get(row.hit.record.id)
    if (previous) {
      previous.content += '\n- ' + period + ' · ' + row.quote
      previous.selectedQuote += '\n' + row.quote
    } else {
      grouped.set(row.hit.record.id, { ...asResult(row.hit), content: row.quote, sourceRefs,
        selectedQuote: row.quote, eventPeriod: period })
    }
  }
  const hits = [...grouped.values()]
  return { hits, eventCount: result.count, countExplanation: hits.length ? result.text.split('\n', 1)[0] : undefined,
    ...(count.dinnerParty && hits.length ? { eventCountContext: result.text } : {}) }
}

function memoSegments(text) {
  const segments = []
  for (let from = 0; from < text.length;) {
    let to = Math.min(text.length, from + 420)
    if (to < text.length) {
      const tail = text.slice(from + 220, to)
      const matches = [...tail.matchAll(/[。！？.!?\n]/gu)]
      if (matches.length) to = from + 220 + matches.at(-1).index + 1
    }
    segments.push({ from, to, content: text.slice(from, to) })
    from = to
  }
  if (segments.length > 1 && segments.at(-1).content.length < CONTENT_LIMITS.min) {
    segments.at(-2).to = segments.at(-1).to
    segments.at(-2).content = text.slice(segments.at(-2).from, segments.at(-2).to)
    segments.pop()
  }
  return segments
}

function filteredRefs(refs, reports) {
  return reports.filterSourceRefs(refs ?? []).map(ref => ({ ...ref }))
}

function authorizedSourceProjects(root) {
  const grantRoot = join(root, 'capture', 'recall-grants')
  const sourceRoot = join(root, 'capture', 'sources')
  let projects = []
  try { projects = readdirSync(grantRoot, { withFileTypes: true }) } catch (error) { if (error?.code !== 'ENOENT') throw error }
  const found = []
  for (const project of projects) {
    if (!project.isDirectory() || !isValidProjectKey(project.name)) continue
    let grants = []
    try { grants = readdirSync(join(grantRoot, project.name)) } catch { continue }
    for (const name of grants) {
      const sourceId = /^src_[a-f0-9]{24}\.json$/u.test(name) ? name.slice(0, -5) : null
      if (!sourceId) continue
      try {
        const grant = JSON.parse(readFileSync(join(grantRoot, project.name, name), 'utf8'))
        const metadataFile = join(sourceRoot, `${sourceId}.json`)
        const stat = lstatSync(metadataFile)
        if (!stat.isFile() || stat.isSymbolicLink()) continue
        const metadata = JSON.parse(readFileSync(metadataFile, 'utf8'))
        if (grant.version === 1 && grant.sourceId === sourceId && grant.projectKey === project.name &&
            typeof grant.textHash === 'string' && metadata.id === sourceId && metadata.projectKey === project.name &&
            metadata.textHash === grant.textHash && metadata.role === 'user' && metadata.sourceKind === 'user' &&
            canReadSource(root, sourceId)) {
          found.push(project.name)
          break
        }
      } catch { /* Missing, revoked, or malformed source grants do not expose a project. */ }
    }
  }
  return found
}

/**
 * Compose independent local clients over the same JSONL/L0 profile used by DSH.
 * A projectKey makes an MCP process permanently project-bound; the browser
 * process may inspect any validated project after authenticating as admin.
 */
export function createLocalSharingService({ root, profileIdentity = null, projectKey = null, clock = () => Date.now() }) {
  const dataRoot = resolve(root)
  const owner = readDataOwner(dataRoot)
  if (profileIdentity !== null && owner.identity !== profileIdentity) {
    throw new Error('configured profile identity does not match this memory root')
  }
  if (projectKey !== null && !isValidProjectKey(projectKey)) throw new TypeError('bound project key is invalid')
  const identity = profileIdentity ?? owner.identity
  const reports = createRecallReportStore(dataRoot, identity)
  const runtime = openMemoryRuntime({ root: dataRoot, clock,
    onRecallRevoke: targets => reports.invalidateReferences(targets) })
  const passages = new SourcePassageIndex(dataRoot)
  const panel = createPanelBackend({ store: runtime.store, index: runtime.index, root: dataRoot, config: {} })

  function assertProject(input) { return projectKeyOf(input, projectKey) }
  function refresh(key) {
    runtime.refreshScope('global', null)
    runtime.refreshScope('project', key)
  }
  function recordsFor(key) {
    refresh(key)
    return runtime.store.list('project', key)
  }

  function saveRemembered({ text, remembered, client, sessionId, messageId, key, submission }) {
    if (typeof text !== 'string' || text.length > 20_000) throw new TypeError('original user message is required')
    if (looksSensitive(text) || analyzeUserMessageControls(text).noSaveDirective) {
      throw new Error('the user message is private or contains likely credentials')
    }
    if (typeof remembered !== 'string' || !isRecallSourceStatement(remembered)) {
      throw new Error('remembered content is not an eligible user statement')
    }
    if (remembered.length < CONTENT_LIMITS.min || remembered.length > 20_000) {
      throw new TypeError(`remembered content must contain ${CONTENT_LIMITS.min}-20000 characters`)
    }
    if (typeof sessionId !== 'string' || sessionId.trim() === '' || sessionId.length > 160) {
      throw new TypeError('client session id is required')
    }
    const clientName = String(client).trim().slice(0, 40)
    if (!/^[a-z0-9._-]+$/iu.test(clientName)) throw new TypeError('client name is invalid')
    const sourceSession = `${clientName}:${sessionId}`
    const at = clock()
    const memoOffset = text.indexOf(remembered)
    if (memoOffset < 0) throw new Error('remembered text could not be bound to the original user message')
    const chunks = memoSegments(remembered)
    const submittedAt = sourceEventTime(submission ? submission.eventTime : at)
    // Identity-less writes must retain content-based deduplication.
    const hasMessageId = typeof messageId === 'string' && messageId !== ''
    const eventTime = hasMessageId && submittedAt !== undefined && submittedAt <= at ? submittedAt : undefined
    const timeZone = eventTime === undefined ? undefined : submission ? normalizeClientTimeZone(submission.timeZone) : localTimeZone()
    const sourceInput = { sessionId: sourceSession, messageId, role: 'user', sourceKind: 'user',
      sourceForm: clientName, projectKey: key, text, at, eventTime, timeZone }
    const sourceId = sourceIdOf(sourceInput)
    return withSourceRecallLock(dataRoot, sourceId, () => {
      const original = { ...sourceInput, id: sourceId }
      if (!canGrantSourceRecall(dataRoot, original, key)) {
        throw new Error('original message did not pass the source authorization checks')
      }
      const records = chunks.map((chunk, index) => {
        const id = `mem_${hash(`${key}\0${sourceId}\0${index}`).slice(0, 24)}`
        const from = memoOffset + chunk.from
        const to = Math.min(text.length, from + Math.min(240, chunk.content.length))
        const excerpt = text.slice(from, to)
        const built = buildRecord({ kind: 'fact', scope: 'project', projectKey: key, content: chunk.content,
          tags: ['explicit-memory'], confidence: 1, importance: .85, evidenceRole: 'user',
          sourceRefs: [{ sourceId, sessionId: sourceSession, messageId, role: 'user',
            sourceKind: 'user', sourceForm: clientName, at, from, to, excerpt }] }, { id, now: at })
        if (!built.ok) throw new Error(built.reason)
        return built.record
      })
      const source = saveSource(dataRoot, sourceInput)
      if (source.projectKey !== key) throw new Error('source belongs to a different project')
      const saved = runtime.store.appendBatch(records)
      let originalAuthorized = false
      // Publish the grant after the records commit. A retry can finish this step with the same source and record IDs.
      try { originalAuthorized = grantSourceRecall(dataRoot, original, key, { remembered: true, locked: true }) }
      catch { /* the committed records and original remain available for retry */ }
      const results = saved.map(record => asResult({ record, score: 0 }))
      return { ...results[0], records: results, sourceId: source.id, originalChars: text.length, originalAuthorized }
    })
  }

  return {
    root: dataRoot,
    profileIdentity: identity,
    projectKey,
    reports,
    projects() { return [...new Set([...runtime.store.listProjects(), ...authorizedSourceProjects(dataRoot), ...reports.listProjects()])].sort() },
    list(input = {}) {
      const key = assertProject(input.projectKey)
      refresh(key)
      return panel.list({ ...input, scope: 'project', projectKey: key })
    },
    brief(input = {}) {
      const key = assertProject(input.projectKey)
      refresh(key)
      const brief = deriveProjectBrief(runtime.store, { ...input, projectKey: key, now: clock() })
      for (const section of brief.sections) for (const item of section.items) item.sourceRefs = filteredRefs(item.sourceRefs, reports)
      return brief
    },
    scenes(input = {}) {
      const key = assertProject(input.projectKey)
      const records = recordsFor(key)
      const groups = new Map()
      for (const record of records) {
        if (record.status !== 'active' && record.status !== 'candidate') continue
        const name = record.topic || record.tags?.[0] || record.kind
        if (!groups.has(name)) groups.set(name, [])
        groups.get(name).push(record)
      }
      return [...groups].map(([name, items]) => {
        const timestamp = values => values.length ? new Date(values.reduce((min, value) => Math.min(min, value), Infinity)).toISOString() : ''
        const updated = values => values.length ? new Date(values.reduce((max, value) => Math.max(max, value), -Infinity)).toISOString() : ''
        const createdAt = items.map(record => record.createdAt).filter(Number.isFinite)
        const updatedAt = items.map(record => record.updatedAt).filter(Number.isFinite)
        const summary = `${name} · ${items.length} 条现有记忆`
        const content = items.map(record => `- [${record.id}@${record.revision}] ${record.content}`).join('\n')
        const meta = { created: timestamp(createdAt), updated: updated(updatedAt), summary, heat: Math.min(100, items.length) }
        const filename = `${hash(`${key}\0${name}`).slice(0, 20)}.md`
        return { filename, title: name, meta, content, records: items.map(record => ({ id: record.id,
          revision: record.revision, sourceRefs: filteredRefs(record.sourceRefs, reports) })),
          text: formatSceneBlock(meta, content) }
      })
    },
    coreRules() {
      runtime.refreshScope('global', null)
      return runtime.store.list('global', null).filter(record => record.status === 'active' &&
        (record.kind === 'preference' || record.kind === 'decision')).map(record => ({
        id: record.id, revision: record.revision, kind: record.kind, content: record.content,
        sourceRefs: filteredRefs(record.sourceRefs, reports),
      }))
    },
    search(query, requestedProjectKey, limit = 12, recall = null) {
      const key = assertProject(requestedProjectKey)
      if (typeof query !== 'string' || query.trim() === '' || query.length > 1000) throw new TypeError('query must contain 1-1000 characters')
      if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new TypeError('limit must be from 1 to 50')
      refresh(key)
      const now = clock()
      const dateLookup = recall?.slot?.detail === 'event-date'
      const timeIntent = recall ? recallTimeIntent(dateLookup ? '' : query, now) : null
      const historical = timeIntent !== null && timeIntent.kind !== 'current'
      const fetchLimit = recall ? 40 : limit
      const slot = recall ? { ...recall.slot, query, timeIntent } : null
      if (slot && !recall.hasSubquestions) {
        const receipts = sharedReceiptEvidence(passages, reports, slot.query, key, now, limit)
        if (receipts) return { projectKey: key, query, ...receipts }
        const activity = sharedActivityEvidence(passages, reports, slot, key, now, limit)
        if (activity) return { projectKey: key, query, ...activity }
      }
      if (usesLatestTimeEvidence(slot?.timeMeasure) && !historical) {
        const recent = findRecentTimeMeasures(passages, [slot], key, now)
        const hits = recent.matches.flatMap(({ hit, verified }) => {
          const sourceRefs = filteredRefs(hit.record.sourceRefs, reports)
          const quote = hit.record.recallQuote
          return verified && sourceRefs.length ? [{ ...asResult(hit), content: quote, selectedQuote: quote, sourceRefs,
            timeMeasureValues: hit.record.recallTimeMeasures.map(measure => measure.value) }] : []
        })
        if (recent.incomplete || recent.matches.length > 1 || (recent.matches.length > 0 && hits.length === 0)) {
          return { projectKey: key, query, hits: [], withheldHits: hits,
            countExplanation: slot.timeMeasure.mode === 'race-best'
              ? 'The latest personal best cannot be verified from available memories.'
              : 'The latest cumulative time cannot be verified from available memories.' }
        }
        if (hits.length || slot.timeMeasure.mode === 'race-best') return { projectKey: key, query, hits }
      }
      const memoryHits = runtime.index.search(slot?.searchQuery ?? query, { projectKey: key, scopes: ['project', 'global'],
        statuses: historical ? ['active', 'superseded'] : ['active'], includeExpired: historical, now, limit: fetchLimit })
      if ((slot?.declaredCount || slot?.elapsed) && !historical) {
        const projectTerms = recallNamedProjectTerms(query)
        const options = {
          projectKey: key, now, maxTokens: 360, maxItems: Math.min(6, limit),
          accepts: hit => !conflictsRecallProject(hit, projectTerms),
        }
        const result = slot.elapsed ? retrieveElapsed(passages, slot.elapsed, options)
          : retrieveDeclaredCount(passages, slot.declaredCount, {
            ...options, query, storedHits: memoryHits.filter(hit => isSafeRecallRecord(hit.record, key, timeIntent, now) &&
              slotEvidence(slot, [hit], recall.hasSubquestions).length > 0),
          })
        const hits = result.injected.flatMap(({ row, quote }) => {
          const sourceRefs = filteredRefs(row.hit.record.sourceRefs, reports)
          return row.hit.record.kind === 'source' && sourceRefs.length === 0 ? [] :
            [{ ...asResult(row.hit), content: quote, sourceRefs, selectedQuote: quote }]
        })
        const complete = hits.length > 0 && hits.length === result.injected.length
        const withheldHits = result.injected.length ? [] : result.hits.flatMap(hit => {
          const sourceRefs = filteredRefs(hit.record.sourceRefs, reports)
          return hit.record.kind === 'source' && !sourceRefs.length ? [] : [{ ...asResult(hit), sourceRefs }]
        })
        return { projectKey: key, query, hits: complete ? hits : [], withheldHits,
          countExplanation: complete || withheldHits.length ? result.explanation : undefined,
          ...(slot.elapsed ? { elapsed: complete ? result.elapsed : null }
            : { declaredCount: { ...result.declaredCount, value: complete ? result.declaredCount.value : null } }) }
      }
      const advice = slot?.personalQuestion?.adviceTopic
      const exactLookup = advice || slot?.personalQuestion?.receivedGift ? slot.searchQuery : null
      const acceptableMemories = advice ? memoryHits.filter(hit => isSafeRecallRecord(hit.record, key, timeIntent, now) &&
        slotEvidence(slot, [hit], recall.hasSubquestions).length > 0) : memoryHits
      let sourceHits = []
      if (!historical) {
        sourceHits = advice ? findAdviceEvidence(passages, slot, key, {
          maxItems: limit, represented: acceptableMemories,
        }).matches.map(({ hit }) => hit)
          : passages.search(exactLookup ?? (dateLookup && !slot.eventOrder ? slot.searchQuery : undefined) ?? query,
            { projectKey: key, now, limit: fetchLimit })
      }
      const unique = new Map()
      for (const hit of [...acceptableMemories, ...sourceHits]) unique.set(hit.record.id, hit)
      const hits = []
      const byOriginal = new Map()
      const coalesceOriginals = !dateLookup && !slot?.eventOrder
      for (const hit of [...unique.values()].sort((a, b) => b.score - a.score)) {
        if (!coalesceOriginals && hits.length >= limit) break
        if (slot && !isSafeRecallRecord(hit.record, key, timeIntent, now)) continue
        const original = slot && hit.record.kind === 'source'
          ? (advice ? hit : directPassageEvidence(slot, hit, recall.hasSubquestions)) : null
        if (slot && (hit.record.kind === 'source' ? !original : slotEvidence(slot, [hit], recall.hasSubquestions).length === 0)) continue
        const sourceRefs = filteredRefs(hit.record.sourceRefs, reports)
        if (hit.record.kind === 'source' && sourceRefs.length === 0) continue
        const proof = slot?.eventOrder ? calendarOrderEvidence(hit.record, slot.eventOrder, slot.query, slot.entityTerms)
          : dateLookup ? calendarEventEvidence(hit.record, slot.query, slot.entityTerms, { allowReturnBounds: true, personalSince: slot.personalSince }) : null
        const originalQuote = exactLookup ? original?.record.recallQuote : undefined
        const result = { ...asResult(hit), sourceRefs, ...(proof ? { content: proof.quote, observedAt: hit.record.observedAt } : {}),
          ...(Number.isSafeInteger(proof?.day) ? { calendarDay: proof.day, calendarRelative: proof.relative === true } : {}),
          ...(originalQuote ? { content: originalQuote, selectedQuote: originalQuote } : {}) }
        if (coalesceOriginals && sourceRefs.length === 1) {
          const content = result.kind === 'source' ? explicitRememberText(result.content) ?? result.content : result.content
          const fingerprint = JSON.stringify([result.scope, result.projectKey, result.verified, sourceRefs[0].sourceId, content.trim()])
          const position = byOriginal.get(fingerprint)
          if (position !== undefined) {
            const previous = hits[position]
            if (previous.kind === 'source' && result.kind !== 'source') {
              hits[position] = { ...result, sourceRefs: previous.sourceRefs, score: previous.score }
            } else if (previous.kind !== 'source' && result.kind === 'source') {
              previous.sourceRefs = sourceRefs
            }
            continue
          }
          if (hits.length < limit) byOriginal.set(fingerprint, hits.length)
        }
        if (hits.length < limit) hits.push(result)
      }
      return { projectKey: key, query, hits }
    },
    recallDurationAtEvent(plan, requestedProjectKey) {
      const key = assertProject(requestedProjectKey)
      refresh(key)
      const result = retrieveDurationAtEvent(passages, plan, {
        projectKey: key, now: clock(), maxTokens: 360, maxItems: 2, scanLimit: DEEP_RECALL_TOKEN_LIMIT,
      })
      const originals = new Map()
      for (const hit of result.hits) {
        const sourceRefs = filteredRefs(hit.record.sourceRefs, reports)
        if (!sourceRefs.length) return { hits: [], injected: [], duration: { days: null, conditional: false }, context: '' }
        originals.set(hit.record.id, { ...asResult(hit), sourceRefs })
      }
      const injected = result.injected.map(({ row, text, selectedQuote }) => ({
        ...originals.get(row.hit.record.id), content: text, selectedQuote,
      }))
      return { hits: [...originals.values()], injected, duration: result.duration, context: result.text }
    },
    recallCounters(group, requestedProjectKey, query) {
      const key = assertProject(requestedProjectKey)
      refresh(key)
      const projectTerms = recallNamedProjectTerms(query)
      const now = clock()
      const result = retrieveReportedCounters(passages, group, {
        projectKey: key, now, maxTokens: 360, maxItems: 6, standalone: { index: runtime.index, store: runtime.store },
        accepts: hit => isSafeRecallRecord(hit.record, key, { kind: 'current', at: now }, now) &&
          !conflictsRecallProject(hit, projectTerms),
      })
      const read = hit => {
        const sourceRefs = filteredRefs(hit.record.sourceRefs, reports)
        return sourceRefs.length || hit.record.kind !== 'source' ? { ...asResult(hit), sourceRefs } : null
      }
      const hits = result.hits.map(read).filter(Boolean)
      const injected = result.injected.flatMap(({ row, quote }) => {
        const record = read(row.hit)
        return record ? [{ ...record, content: quote, selectedQuote: quote }] : []
      })
      const valid = injected.length === result.injected.length
      return { hits, injected: valid ? injected : [], summary: valid && injected.length ? result.summary : '',
        counterSlots: valid ? result.counterSlots : result.counterSlots.map(slot => ({ ...slot, value: null, injectedIds: [] })),
        quantityCheck: valid ? result.quantityCheck : { ...result.quantityCheck, result: null } }
    },
    recentReports(requestedProjectKey, limit = 20, offset = 0) {
      const key = assertProject(requestedProjectKey)
      return reports.listRecent(key, limit, offset)
    },
    remember({ text, client = 'local', sessionId, messageId = null, requestedProjectKey } = {}) {
      const key = assertProject(requestedProjectKey)
      const remembered = explicitRememberText(text)
      if (remembered === null) throw new Error('only a clear user message that explicitly says to remember its content can be saved')
      return saveRemembered({ text, remembered, client, sessionId, messageId, key })
    },
    rememberPrevious({ text, client = 'local', sessionId, messageId = null, requestedProjectKey, eventTime, timeZone } = {}) {
      const key = assertProject(requestedProjectKey)
      if (typeof text !== 'string' || text.length > 20_000 || !isRecallSourceStatement(text)) {
        throw new Error('the previous user message is not eligible to remember')
      }
      const remembered = explicitRememberText(text) ?? text
      return saveRemembered({ text, remembered, client, sessionId, messageId, key, submission: { eventTime, timeZone } })
    },
    forget(id, requestedProjectKey) {
      const key = assertProject(requestedProjectKey)
      if (typeof id !== 'string' || id.trim() === '') throw new TypeError('memory id is required')
      refresh(key)
      const current = runtime.store.find(id.trim(), [{ scope: 'project', projectKey: key }])
      const result = panel.removeMemory({ id: id.trim(), scope: 'project', projectKey: key })
      const sourceTarget = /^source:(src_[a-f0-9]{24}):/u.exec(id.trim())?.[1]
      const sourceIds = [...new Set([...(current?.sourceRefs ?? []).map(ref => ref?.sourceId), sourceTarget]
        .filter(value => typeof value === 'string'))]
      clearLastUsersForSources(dataRoot, sourceIds)
      return result
    },
    close() { runtime.dispose() },
  }
}
