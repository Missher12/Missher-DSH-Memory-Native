/**
 * Memory record shape, validation and revision helpers.
 *
 * A record is immutable; every change appends a new revision to the JSONL
 * authority. `status: 'deleted'` is a tombstone revision, never a physical
 * delete inside the log (compaction may drop older revisions, the tombstone
 * stays).
 *
 * @module dsh-memory/host/records
 */

import { createHash, randomUUID } from 'node:crypto'

export const MEMORY_KINDS = Object.freeze(['preference', 'fact', 'decision', 'episode'])
export const MEMORY_SCOPES = Object.freeze(['global', 'project'])
export const MEMORY_STATUSES = Object.freeze(['candidate', 'active', 'superseded', 'archived', 'deleted'])

export const CONTENT_LIMITS = Object.freeze({ min: 5, max: 500 })
export const TAG_LIMITS = Object.freeze({ maxCount: 8, maxLength: 40 })
export const TOPIC_LIMIT = 48
export const SOURCE_REF_LIMIT = 12

const SENSITIVE_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/u,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
  /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token)\s*[:=]\s*\S+/iu,
  /\bBearer\s+[A-Za-z0-9._-]{16,}/u,
]

/** Normalize a memory statement: single line, collapsed whitespace. */
export function normalizeContent(value) {
  return String(value ?? '').replace(/\s+/gu, ' ').trim()
}

/** Normalize an optional topic label (L2 grouping); blank becomes null. */
export function normalizeTopic(value) {
  const text = normalizeContent(value)
  return text === '' ? null : text.slice(0, TOPIC_LIMIT)
}

/** Stable hash of the normalized statement, used for exact-duplicate rejection. */
export function contentHashOf(value) {
  return createHash('sha256').update(normalizeContent(value)).digest('hex')
}

/** Whether a statement looks like it contains a credential or private key. */
export function looksSensitive(value) {
  const text = String(value ?? '')
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(text))
}

/** New opaque memory id; callers may pass their own for tests. */
export function newMemoryId() {
  return `mem_${randomUUID().replace(/-/gu, '').slice(0, 24)}`
}

function clamp01(value, fallback) {
  const number = typeof value === 'number' && Number.isFinite(value) ? value : fallback
  return Math.min(1, Math.max(0, number))
}

function normalizeTags(tags) {
  if (!Array.isArray(tags)) return []
  const seen = new Set()
  const out = []
  for (const tag of tags) {
    const text = normalizeContent(tag).slice(0, TAG_LIMITS.maxLength)
    if (text === '' || seen.has(text)) continue
    seen.add(text)
    out.push(text)
    if (out.length >= TAG_LIMITS.maxCount) break
  }
  return out
}

function normalizeSourceRefs(refs) {
  if (!Array.isArray(refs)) return []
  const out = []
  for (const ref of refs.slice(0, SOURCE_REF_LIMIT)) {
    if (ref === null || typeof ref !== 'object') continue
    const sessionId = typeof ref.sessionId === 'string' ? ref.sessionId : undefined
    const messageId = typeof ref.messageId === 'string' ? ref.messageId : undefined
    const toolCallId = typeof ref.toolCallId === 'string' ? ref.toolCallId : undefined
    if (sessionId === undefined && messageId === undefined && toolCallId === undefined) continue
    out.push({ ...(sessionId === undefined ? {} : { sessionId }), ...(messageId === undefined ? {} : { messageId }), ...(toolCallId === undefined ? {} : { toolCallId }) })
  }
  return out
}

function validateTime(value, field) {
  if (value === null || value === undefined) return null
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`${field} must be a non-negative epoch-ms number or null`)
  return Math.floor(value)
}

/**
 * Validate one extraction candidate and build its first revision.
 * @param {Record<string, unknown>} input
 * @param {{ now?: number, id?: string, defaultStatus?: 'candidate' | 'active', autoApproveConfidence?: number }} [options]
 * @returns {{ ok: true, record: object } | { ok: false, reason: string }}
 */
export function buildRecord(input, options = {}) {
  const source = input !== null && typeof input === 'object' ? input : {}
  const content = normalizeContent(source.content)
  if (content.length < CONTENT_LIMITS.min || content.length > CONTENT_LIMITS.max) {
    return { ok: false, reason: `content length must be ${CONTENT_LIMITS.min}-${CONTENT_LIMITS.max} characters` }
  }
  if (looksSensitive(content)) return { ok: false, reason: 'content looks like a credential or private key' }
  const kind = typeof source.kind === 'string' ? source.kind : ''
  if (!MEMORY_KINDS.includes(kind)) return { ok: false, reason: `kind must be one of ${MEMORY_KINDS.join(', ')}` }
  const scope = typeof source.scope === 'string' ? source.scope : 'project'
  if (!MEMORY_SCOPES.includes(scope)) return { ok: false, reason: `scope must be one of ${MEMORY_SCOPES.join(', ')}` }
  const projectKey = scope === 'global' ? null : (typeof source.projectKey === 'string' ? source.projectKey : '')
  if (scope === 'project' && projectKey === '') return { ok: false, reason: 'project scope requires a projectKey' }

  const now = typeof options.now === 'number' ? options.now : Date.now()
  const confidence = clamp01(source.confidence, 0.5)
  const importance = clamp01(source.importance, 0.5)
  const threshold = typeof options.autoApproveConfidence === 'number' ? options.autoApproveConfidence : 0.75
  const status = source.status === 'active' || source.status === 'candidate'
    ? source.status
    : confidence >= threshold ? 'active' : 'candidate'

  let validFrom = null
  let validTo = null
  try {
    validFrom = validateTime(source.validFrom, 'validFrom')
    validTo = validateTime(source.validTo, 'validTo')
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
  if (validFrom !== null && validTo !== null && validTo < validFrom) return { ok: false, reason: 'validTo cannot precede validFrom' }

  const record = Object.freeze({
    id: typeof options.id === 'string' && options.id !== '' ? options.id : (typeof source.id === 'string' && source.id !== '' ? source.id : newMemoryId()),
    kind,
    scope,
    projectKey,
    content,
    topic: normalizeTopic(source.topic),
    tags: Object.freeze(normalizeTags(source.tags)),
    sourceRefs: Object.freeze(normalizeSourceRefs(source.sourceRefs)),
    observedAt: now,
    validFrom,
    validTo,
    confidence,
    importance,
    status,
    revision: 1,
    supersedesId: typeof source.supersedesId === 'string' ? source.supersedesId : null,
    contentHash: contentHashOf(content),
    recallCount: 0,
    lastRecalledAt: null,
    pinned: source.pinned === true,
    createdAt: now,
    updatedAt: now,
  })
  return { ok: true, record }
}

/**
 * Build the next revision of an existing record.
 * @param {object} record current revision
 * @param {Record<string, unknown>} patch fields to change
 * @param {number} [now]
 */
export function nextRevision(record, patch = {}, now = Date.now()) {
  const merged = { ...record, ...patch }
  const content = normalizeContent(merged.content)
  if (content.length < CONTENT_LIMITS.min || content.length > CONTENT_LIMITS.max) throw new Error('content length out of range')
  if (looksSensitive(content)) throw new Error('content looks like a credential or private key')
  if (!MEMORY_STATUSES.includes(merged.status)) throw new Error('invalid status')
  if (!MEMORY_KINDS.includes(merged.kind)) throw new Error('invalid kind')
  const next = {
    ...record,
    ...patch,
    content,
    topic: normalizeTopic(merged.topic),
    tags: Object.freeze(normalizeTags(merged.tags)),
    sourceRefs: Object.freeze(normalizeSourceRefs(merged.sourceRefs)),
    confidence: clamp01(merged.confidence, record.confidence),
    importance: clamp01(merged.importance, record.importance),
    pinned: merged.pinned === true,
    revision: record.revision + 1,
    contentHash: contentHashOf(content),
    updatedAt: now,
  }
  return Object.freeze(next)
}
