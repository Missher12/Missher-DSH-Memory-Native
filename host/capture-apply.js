import { canReadSource, reconcileReplacements } from './capture-journal.js'
import { buildRecord, contentHashOf, mergeSourceRefs } from './records.js'
import { similarity, coverage, hasEvidenceMatch, hasDirectUserSupport, locateSourceSentence,
  NEGATION_PATTERN, conflictingValues, differentNamedServices, disjointEntities, isDirectUserSource,
  isModelEvidenceSource } from './capture-evidence.js'
import { sourceTimeReference } from './source-time.js'

const SIMILARITY_THRESHOLD = 0.9
const PREFERENCE_SIMILARITY_THRESHOLD = 0.85
const CONFLICT_SIMILARITY_THRESHOLD = 0.7

export class CaptureApplyCoordinator {
  #store
  #index
  #config
  #clock
  #logger

  constructor({ store, index, config, clock, logger }) {
    this.#store = store
    this.#index = index
    this.#config = config
    this.#clock = clock
    this.#logger = logger
  }

  setConfig(config) {
    this.#config = config
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
      ...sourceTimeReference(entry.source), ...span,
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

  apply(items, { scopes, identity, session, entries, task, grants }) {
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
      const sourceGuard = { sourceIds: evidence.refs.map(ref => ref.sourceId) }
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
        this.#store.append(historical.record, sourceGuard)
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
        }, scopes, sourceGuard)
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
        const committed = this.#store.replace(safeTarget.id, built.record, sourceGuard)
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
        const committed = this.#store.replace(similar.record.id, builtReplacement.record, sourceGuard)
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
        }, scopes, sourceGuard)
        if (merged !== undefined) {
          publish(merged)
          seen.set(merged.contentHash, merged)
          captureKeys.add(itemKey)
          applied += 1
          continue
        }
      }
      this.#store.append(built.record, sourceGuard)
      publish(built.record)
      captureKeys.add(itemKey)
      seen.set(built.record.contentHash, built.record)
      applied += 1
    }
    return { applied, rejected }
  }
}
