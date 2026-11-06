/**
 * L3 profile derivation: cluster durable preference memories into
 * evidence-backed user traits. Project decisions are deliberately excluded:
 * they describe the project, not the person.
 *
 * Deterministic and local: no LLM call, no new store. A trait is a view over
 * active preference/decision records; each keeps the record ids it came from
 * (evidence), the strongest statement, the max confidence and the last time new
 * evidence arrived. Traits are ranked by confidence with a 60-day half-life.
 *
 * @module dsh-memory/host/profile
 */

import { tokenize } from './tokenize.js'

export const PROFILE_TRAITS_LIMIT = 10
/** Minimum confidence for a record to contribute to the profile. */
export const PROFILE_MIN_CONFIDENCE = 0.55
/** Bigram Jaccard above which two statements with the same topic are the same trait. */
export const PROFILE_TOPIC_SIMILARITY = 0.5
/** Bigram Jaccard above which two statements with a missing topic are the same trait. */
export const PROFILE_CROSS_SIMILARITY = 0.62
/** Kept for compatibility with older callers/tests. */
export const PROFILE_SIMILARITY = PROFILE_TOPIC_SIMILARITY
/** Profile recency half-life (days), matching the jev-agent-memory design. */
export const PROFILE_HALF_LIFE_DAYS = 60
const EVIDENCE_LIMIT = 8
const PROFILE_KINDS = new Set(['preference'])

const NEGATION_PATTERN = /(?:不|没|别|勿|禁止|never|\bnot\b|\bno\b)/iu
const ANTONYM_PAIRS = Object.freeze([
  ['深', '浅'], ['暗', '亮'], ['可写', '只读'], ['启用', '禁用'], ['允许', '禁止'],
  ['必须', '不必'], ['需要', '无需'], ['喜欢', '讨厌'], ['增', '减'], ['快', '慢'],
  ['大', '小'], ['多', '少'], ['开', '关'],
])

function bigramSet(text) {
  return new Set(tokenize(text).filter((token) => token.length >= 2))
}

function similarity(left, right) {
  const a = bigramSet(left)
  const b = bigramSet(right)
  if (a.size === 0 || b.size === 0) return 0
  let shared = 0
  for (const token of a) if (b.has(token)) shared += 1
  return shared / (a.size + b.size - shared)
}

function numbersOf(text) {
  return new Set(String(text ?? '').match(/\d+(?:\.\d+)?/gu) ?? [])
}

/** Whether two preference statements conflict (polarity, antonyms, values). */
export function profileConflicts(left, right) {
  const a = String(left ?? '')
  const b = String(right ?? '')
  if (NEGATION_PATTERN.test(a) !== NEGATION_PATTERN.test(b)) return true
  for (const [first, second] of ANTONYM_PAIRS) {
    if ((a.includes(first) && b.includes(second)) || (a.includes(second) && b.includes(first))) return true
  }
  const valuesA = numbersOf(a)
  const valuesB = numbersOf(b)
  for (const value of valuesA) if (!valuesB.has(value)) return true
  for (const value of valuesB) if (!valuesA.has(value)) return true
  return false
}

function decay(ageMs) {
  const days = Math.max(0, ageMs) / 86_400_000
  return Math.pow(0.5, days / PROFILE_HALF_LIFE_DAYS)
}

/**
 * Derive profile traits from the live records.
 * @param {object[]} records all records (any scope/status)
 * @param {{ now?: number, limit?: number }} [options]
 * @returns {{ traits: object[], total: number, generatedAt: number }}
 */
export function deriveProfile(records, options = {}) {
  const now = typeof options.now === 'number' ? options.now : Date.now()
  const limit = Number.isInteger(options.limit) ? options.limit : PROFILE_TRAITS_LIMIT
  const candidates = (Array.isArray(records) ? records : [])
    .filter((record) => PROFILE_KINDS.has(record.kind) && record.status === 'active')
    .filter((record) => typeof record.confidence === 'number' && record.confidence >= PROFILE_MIN_CONFIDENCE)
    .sort((left, right) => (right.confidence ?? 0) - (left.confidence ?? 0))

  const traits = []
  // Conflicting numbers or polarity can never share a trait. Partitioning on
  // those exact predicates avoids comparing every numbered preference to every
  // other one, while keeping the original order within each partition.
  const groups = new Map()
  for (const record of candidates) {
    const topic = typeof record.topic === 'string' && record.topic !== '' ? record.topic : null
    const groupKey = JSON.stringify([NEGATION_PATTERN.test(record.content), [...numbersOf(record.content)].sort()])
    let group = groups.get(groupKey)
    if (group === undefined) groups.set(groupKey, group = [])
    let cluster
    for (const candidate of group) {
      if (candidate.kind !== record.kind) continue
      if (profileConflicts(candidate.statement, record.content)) continue
      const same = similarity(candidate.statement, record.content)
      const sameTopic = topic !== null && candidate.topic !== null && topic === candidate.topic
      const topicMissing = topic === null || candidate.topic === null
      const identical = String(candidate.statement).trim() === String(record.content).trim()
      if (identical || (sameTopic && same >= PROFILE_TOPIC_SIMILARITY) || (topicMissing && same >= PROFILE_CROSS_SIMILARITY)) {
        cluster = candidate
        break
      }
    }
    if (cluster === undefined) {
      cluster = {
        id: `trait_${traits.length + 1}`,
        kind: record.kind,
        topic,
        statement: record.content,
        confidence: record.confidence,
        importance: record.importance ?? 0.5,
        lastSeenAt: record.updatedAt ?? record.observedAt ?? now,
        evidence: [{ id: record.id, content: record.content, updatedAt: record.updatedAt ?? record.observedAt ?? now,
          ...(options.profileView === true ? { undated: record.updatedAt == null && record.observedAt == null, order: 0 } : {}) }],
        ...(options.profileView === true ? { undated: record.updatedAt == null && record.observedAt == null } : {}),
      }
      traits.push(cluster)
      group.push(cluster)
      continue
    }
    if (options.profileView === true && record.updatedAt == null && record.observedAt == null) cluster.undated = true
    cluster.evidence.push({ id: record.id, content: record.content, updatedAt: record.updatedAt ?? record.observedAt ?? now,
      ...(options.profileView === true ? { undated: record.updatedAt == null && record.observedAt == null, order: cluster.evidence.length } : {}) })
    if ((record.confidence ?? 0) > cluster.confidence) {
      cluster.confidence = record.confidence
      cluster.statement = record.content
    }
    cluster.importance = Math.max(cluster.importance, record.importance ?? 0)
    const seen = record.updatedAt ?? record.observedAt ?? now
    if (seen > cluster.lastSeenAt) cluster.lastSeenAt = seen
    if (topic !== null && cluster.topic === null) cluster.topic = topic
  }

  for (const trait of traits) {
    trait.evidence.sort((left, right) => right.updatedAt - left.updatedAt)
    if (options.profileView === true) trait.allEvidence = trait.evidence
    const seen = trait.evidence.slice(0, EVIDENCE_LIMIT)
    trait.evidence = seen
    trait.evidenceCount = seen.length
    trait.confidence = Math.round(Math.min(1, trait.confidence) * 100) / 100
    trait.lastSeenAt = trait.lastSeenAt
    trait.score = Math.round(trait.confidence * decay(now - trait.lastSeenAt) * 1000) / 1000
  }
  traits.sort((left, right) => right.score - left.score || right.confidence - left.confidence)
  return { traits: traits.slice(0, limit), total: traits.length, generatedAt: now }
}

/** Prepare profile clusters once, before the first recall and gateway checks. */
export function prepareProfileView(records, now = Date.now()) {
  const traits = deriveProfile(records, { now, limit: records.length, profileView: true }).traits.map((trait) => {
    const { evidence, evidenceCount, score, allEvidence, ...base } = trait
    return { ...base, order: Number(trait.id.slice(6)),
      fixedLastSeen: allEvidence.reduce((value, item) => item.undated ? value : Math.max(value, item.updatedAt), -Infinity),
      allEvidence: allEvidence.map((entry) => {
        if (entry.content !== trait.statement) return entry
        const { content, ...rest } = entry
        return rest
      }) }
  })
  return partitionProfileView(traits, now)
}

/** Advance time-dependent ordering without scanning or clustering records. */
export function advanceProfileView(view, now = Date.now()) {
  if (now >= view.preparedAt && now < view.nextFutureAt) return view
  return partitionProfileView([...view.dated, ...view.undated, ...view.future], now)
}

function partitionProfileView(traits, now) {
  const dated = [], undated = [], future = []
  for (const trait of traits) {
    if (!trait.undated && Number.isFinite(trait.lastSeenAt) && trait.lastSeenAt <= now) dated.push(trait)
    else if (trait.undated) undated.push(trait)
    else future.push(trait)
  }
  undated.sort((a, b) => b.confidence - a.confidence || a.order - b.order)
  future.sort((a, b) => b.confidence - a.confidence || a.order - b.order)
  let nextFutureAt = Infinity
  for (const trait of future) if (Number.isFinite(trait.lastSeenAt)) nextFutureAt = Math.min(nextFutureAt, trait.lastSeenAt)
  let newest = 0
  for (const trait of dated) newest = Math.max(newest, trait.lastSeenAt)
  const halfLife = PROFILE_HALF_LIFE_DAYS * 86_400_000
  dated.sort((a, b) => b.confidence * Math.pow(0.5, (newest - b.lastSeenAt) / halfLife) -
    a.confidence * Math.pow(0.5, (newest - a.lastSeenAt) / halfLife) || a.order - b.order)
  let size = 1
  while (size < dated.length) size *= 2
  const best = new Int32Array(size * 2).fill(-1)
  const better = (a, b) => a < 0 ? b : b < 0 ? a :
    dated[a].confidence !== dated[b].confidence ? (dated[a].confidence > dated[b].confidence ? a : b) :
      (dated[a].order < dated[b].order ? a : b)
  for (let i = 0; i < dated.length; i += 1) best[size + i] = i
  for (let i = size - 1; i > 0; i -= 1) best[i] = better(best[i * 2], best[i * 2 + 1])
  return { dated, undated, future, nextFutureAt, best, size, preparedAt: now, total: traits.length }
}

/** Re-rank the cached clusters at the requested instant without re-clustering. */
export function profileViewResult(view, { limit = PROFILE_TRAITS_LIMIT, now = Date.now() } = {}) {
  const score = (trait) => Math.round(trait.confidence * decay(now - (trait.undated ? now : trait.lastSeenAt)) * 1000) / 1000
  const compare = (a, b) => b.score - a.score || b.trait.confidence - a.trait.confidence || a.trait.order - b.trait.order
  const selected = []
  const consider = (trait) => {
    selected.push({ trait, score: score(trait) })
    selected.sort(compare)
    if (selected.length > limit) selected.pop()
  }
  const { dated, undated, future, best, size } = view
  if (now < view.preparedAt) {
    for (const trait of dated) consider(trait)
  } else {
    const better = (a, b) => a < 0 ? b : b < 0 ? a :
      dated[a].confidence !== dated[b].confidence ? (dated[a].confidence > dated[b].confidence ? a : b) :
        (dated[a].order < dated[b].order ? a : b)
    const rangeBest = (left, right) => {
      let result = -1
      for (left += size, right += size; left < right; left >>= 1, right >>= 1) {
        if (left & 1) result = better(result, best[left++])
        if (right & 1) result = better(result, best[--right])
      }
      return result
    }
    let start = 0
    while (start < dated.length && selected.length < limit) {
      const top = score(dated[start])
      let low = start + 1, high = dated.length
      while (low < high) {
        const middle = (low + high) >> 1
        if (score(dated[middle]) === top) low = middle + 1
        else high = middle
      }
      const intervals = [{ left: start, right: low, index: rangeBest(start, low) }]
      while (intervals.length > 0 && selected.length < limit) {
        let topInterval = 0
        for (let i = 1; i < intervals.length; i += 1) {
          if (better(intervals[i].index, intervals[topInterval].index) === intervals[i].index) topInterval = i
        }
        const { left, right, index } = intervals.splice(topInterval, 1)[0]
        consider(dated[index])
        if (left < index) intervals.push({ left, right: index, index: rangeBest(left, index) })
        if (index + 1 < right) intervals.push({ left: index + 1, right, index: rangeBest(index + 1, right) })
      }
      start = low
    }
  }
  for (const trait of undated.slice(0, limit)) consider(trait)
  const futureCandidates = now < view.preparedAt || now >= view.nextFutureAt ? future : future.slice(0, limit)
  for (const trait of futureCandidates) consider(trait)
  const traits = selected.map(({ trait, score: value }) => {
    const { undated: hasUndated, allEvidence, order, fixedLastSeen, ...result } = trait
    const evidence = allEvidence.map((entry) => ({ ...entry, content: entry.content ?? trait.statement, updatedAt: entry.undated ? now : entry.updatedAt }))
      .sort((a, b) => b.updatedAt - a.updatedAt || a.order - b.order).slice(0, EVIDENCE_LIMIT)
      .map((entry) => ({ id: entry.id, content: entry.content, updatedAt: entry.updatedAt }))
    return { ...result, lastSeenAt: hasUndated ? Math.max(now, fixedLastSeen) : trait.lastSeenAt,
      evidence, evidenceCount: evidence.length, score: value }
  })
  return { traits, total: view.total, generatedAt: now }
}

export function profileViewLines(view, now = Date.now()) {
  return formatProfileLines(profileViewResult(view, { limit: 2, now }).traits, { limit: 2, maxChars: 300, compact: true })
}

/**
 * One-line profile lines for prompt injection (bounded, no instructions).
 * @param {object[]} traits
 * @param {{ limit?: number, maxChars?: number }} [options]
 */
export function formatProfileLines(traits, options = {}) {
  const limit = Number.isInteger(options.limit) ? options.limit : 3
  const maxChars = Number.isInteger(options.maxChars) ? options.maxChars : 600
  const lines = []
  let used = 0
  for (const trait of (Array.isArray(traits) ? traits : []).slice(0, limit)) {
    const line = options.compact === true
      ? `- [${trait.kind}] ${trait.statement}`
      : `- [${trait.kind}] ${trait.statement}（置信度 ${trait.confidence.toFixed(2)}，${trait.evidenceCount} 条证据）`
    if (used + line.length > maxChars) break
    lines.push(line)
    used += line.length + 1
  }
  return lines
}
