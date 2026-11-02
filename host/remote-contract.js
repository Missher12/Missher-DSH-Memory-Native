/**
 * Settings → Memory panel wire contract and pure panel operations.
 *
 * The Host exposes the panel over the Typert Remote gateway (`dshMemory/*`).
 * No Typert code generator runs for this plugin, so the protocol used here is
 * the documented source-reflection mode: one public instance method per
 * endpoint, one `input` argument carrying the request object. The Client half
 * hand-authors the matching descriptors (strict codecs are required for
 * `$mount`; they are not used for boundary parsing in source mode).
 *
 * Everything in this module is pure with respect to Cordis: it receives the
 * existing `MemoryStore` / `MemoryIndex` instances and never owns them, so the
 * capture pipeline and the panel always read and write the same authority.
 *
 * @module dsh-memory/host/remote-contract
 */

import { statSync } from 'node:fs'

import { isValidProjectKey, scopePaths } from './paths.js'
import { deriveProfile } from './profile.js'
import { readMaintenance } from './maintenance.js'
import { MEMORY_KINDS } from './records.js'

/** Package identity shared by the client contribution and diagnostics. */
export const PANEL_PACKAGE = '@missher/dsh-memory'
/** Cordis service key and Typert Remote namespace. */
export const PANEL_SERVICE = 'dshMemory'
export const PANEL_NAMESPACE = 'dshMemory'
/** Every endpoint the panel mounts, in declaration order. */
export const PANEL_METHODS = Object.freeze(['list', 'stats', 'activity', 'profile', 'update', 'removeMemory', 'rebuildIndex', 'updateSettings', 'exportData', 'importData', 'backup'])
/** The single JSON argument wire field of every endpoint. */
export const PANEL_INPUT_WIRE = 'input'
/** Maximum records returned by one `list` call. */
export const PANEL_LIMIT = Object.freeze({ default: 100, max: 200 })
/** Statuses the panel can filter on (tombstones stay hidden). */
export const PANEL_FILTER_STATUSES = Object.freeze(['active', 'candidate', 'archived', 'superseded'])
/** Statuses a panel edit may write; deletion has its own endpoint. */
export const PANEL_PATCH_STATUSES = Object.freeze(['active', 'candidate', 'archived'])
/** Fields a panel edit may change. */
export const PANEL_PATCH_FIELDS = Object.freeze(['content', 'topic', 'tags', 'status', 'importance', 'pinned'])
/** Query length bound; the panel sends trimmed user text. */
export const PANEL_QUERY_LIMIT = 200

/** A request the panel can fix; the message is shown to the user as-is. */
export class PanelInputError extends Error {
  constructor(message) {
    super(message)
    this.name = 'PanelInputError'
    this.code = 'invalid-input'
  }
}

function asObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function optionalText(value, field, limit) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new PanelInputError(`${field} must be a string`)
  const text = value.trim().slice(0, limit)
  return text === '' ? undefined : text
}

function optionalInteger(value, field, fallback, min, max) {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new PanelInputError(`${field} must be a number`)
  return Math.min(max, Math.max(min, Math.floor(value)))
}

/**
 * Resolve the scope selector of a request.
 * @param {unknown} raw
 * @returns {{ scope: 'global' | 'project', projectKey: string | null }}
 */
export function normalizeScope(raw) {
  const input = asObject(raw)
  const scope = input.scope === 'global' ? 'global' : input.scope === 'project' || input.scope === undefined ? 'project' : null
  if (scope === null) throw new PanelInputError('scope must be "project" or "global"')
  if (scope === 'global') return { scope: 'global', projectKey: null }
  const key = input.projectKey
  if (key === undefined || key === null || key === '') return { scope: 'project', projectKey: null }
  if (!isValidProjectKey(key)) throw new PanelInputError('projectKey is not a valid project key')
  return { scope: 'project', projectKey: key }
}

/** Latest modification time of a project's authority file, or 0 when absent. */
function projectTouchedAt(root, projectKey) {
  try {
    return statSync(scopePaths(root, 'project', projectKey).file).mtimeMs
  } catch {
    return 0
  }
}

/**
 * Best current project: the project whose authority file was touched last.
 * Capture only writes for the active project, so this tracks the workspace
 * the user is actually working in without depending on a UI service.
 * @param {{ listProjects: () => string[], root: string }} store
 * @returns {string | null}
 */
export function currentProjectKey(store) {
  const root = store.root
  const keys = store.listProjects()
  let best = null
  let bestTime = -1
  for (const key of keys) {
    const time = projectTouchedAt(root, key)
    if (time > bestTime) {
      best = key
      bestTime = time
    }
  }
  return best
}

/** Project one internal record into the panel's JSON shape. */
export function projectRecord(record) {
  return {
    id: record.id,
    kind: record.kind,
    scope: record.scope,
    projectKey: record.projectKey ?? null,
    content: record.content,
    topic: record.topic ?? null,
    tags: Array.isArray(record.tags) ? [...record.tags] : [],
    confidence: typeof record.confidence === 'number' ? record.confidence : 0.5,
    importance: typeof record.importance === 'number' ? record.importance : 0.5,
    status: record.status,
    pinned: record.pinned === true,
    revision: record.revision,
    createdAt: record.createdAt ?? null,
    updatedAt: record.updatedAt ?? null,
    observedAt: record.observedAt ?? null,
    validFrom: record.validFrom ?? null,
    validTo: record.validTo ?? null,
    recallCount: record.recallCount ?? 0,
    lastRecalledAt: record.lastRecalledAt ?? null,
    supersedesId: record.supersedesId ?? null,
  }
}

/**
 * Filtered projection of one scope, optionally ranked by the shared index.
 * @param {{ store: object, index: object }} backend
 * @param {unknown} raw
 */
export function listMemories(backend, raw) {
  const input = asObject(raw)
  const { scope, projectKey } = normalizeScope(input)
  const status = optionalText(input.status, 'status', 40)
  if (status !== undefined && !PANEL_FILTER_STATUSES.includes(status)) {
    throw new PanelInputError(`status must be one of ${PANEL_FILTER_STATUSES.join(', ')}`)
  }
  const kind = optionalText(input.kind, 'kind', 40)
  if (kind !== undefined && !MEMORY_KINDS.includes(kind)) {
    throw new PanelInputError(`kind must be one of ${MEMORY_KINDS.join(', ')}`)
  }
  const query = optionalText(input.query, 'query', PANEL_QUERY_LIMIT)
  const limit = optionalInteger(input.limit, 'limit', PANEL_LIMIT.default, 1, PANEL_LIMIT.max)
  const offset = optionalInteger(input.offset, 'offset', 0, 0, 100000)
  const resolvedProjectKey = scope === 'project' ? (projectKey ?? currentProjectKey(backend.store)) : null

  if (scope === 'project' && resolvedProjectKey === null) {
    return {
      scope,
      projectKey: null,
      currentProjectKey: null,
      items: [],
      shown: 0,
      total: 0,
      offset,
      kindCounts: { preference: 0, fact: 0, decision: 0, episode: 0 },
    }
  }

  const statuses = status === undefined ? [...PANEL_FILTER_STATUSES] : [status]
  let records
  if (query !== undefined) {
    const hits = backend.index.search(query, {
      statuses,
      scopes: [scope],
      projectKey: scope === 'project' ? resolvedProjectKey : null,
      now: Date.now(),
      limit: PANEL_LIMIT.max,
    })
    records = hits.map((hit) => hit.record)
  } else {
    records = backend.store.list(scope, scope === 'project' ? resolvedProjectKey : null).filter((record) => {
      return statuses.includes(record.status)
    })
  }

  const kindCounts = { preference: 0, fact: 0, decision: 0, episode: 0 }
  const filtered = records.filter((record) => {
    if (Object.hasOwn(kindCounts, record.kind)) kindCounts[record.kind] += 1
    return kind === undefined || record.kind === kind
  })
  const total = filtered.length
  const start = Math.min(offset, total)
  return {
    scope,
    projectKey: resolvedProjectKey,
    currentProjectKey: currentProjectKey(backend.store),
    items: filtered.slice(start, start + limit).map(projectRecord),
    shown: Math.min(limit, total - start),
    total,
    offset,
    kindCounts,
  }
}

/**
 * Header counters and read-only capture/injection state.
 * @param {{ store: object, config: object }} backend
 */
export function computeStats(backend, raw) {
  const input = asObject(raw)
  const { scope, projectKey } = normalizeScope(input)
  const records = backend.store.listAll()
  const counts = { active: 0, candidate: 0, archived: 0, superseded: 0 }
  const kinds = { preference: 0, fact: 0, decision: 0, episode: 0 }
  let confidenceSum = 0
  let confidenceCount = 0
  let lastCapturedAt = 0
  for (const record of records) {
    if (Object.hasOwn(counts, record.status)) counts[record.status] += 1
    if (Object.hasOwn(kinds, record.kind) && (record.status === 'active' || record.status === 'candidate')) {
      kinds[record.kind] += 1
    }
    if (record.status === 'active' || record.status === 'candidate') {
      if (typeof record.confidence === 'number' && Number.isFinite(record.confidence)) {
        confidenceSum += record.confidence
        confidenceCount += 1
      }
    }
    const at = typeof record.updatedAt === 'number' ? record.updatedAt : record.observedAt
    if (typeof at === 'number' && at > lastCapturedAt) lastCapturedAt = at
  }
  const current = currentProjectKey(backend.store)
  return {
    active: counts.active,
    candidate: counts.candidate,
    archived: counts.archived,
    superseded: counts.superseded,
    total: records.length,
    projects: backend.store.listProjects().length,
    kinds,
    currentProjectKey: current,
    scope,
    projectKey: scope === 'project' ? (projectKey ?? current) : null,
    avgConfidence: confidenceCount === 0 ? null : Math.round((confidenceSum / confidenceCount) * 100) / 100,
    lastCapturedAt: lastCapturedAt === 0 ? null : lastCapturedAt,
    maintenance: backend.root ? readMaintenance(backend.root) : null,
    captureEnabled: backend.config?.capture?.enabled === true,
    injectEnabled: backend.config?.inject?.enabled === true,
    injectMaxTokens: backend.config?.inject?.maxTokens ?? null,
    retentionEpisodeDays: backend.config?.retention?.episodeDays ?? null,
    maintenanceEnabled: backend.config?.maintenance?.enabled === true,
  }
}

const DAY_MS = 86_400_000

/** Local calendar day of a timestamp, as `YYYY-MM-DD`. */
export function localDayKey(ms) {
  const date = new Date(ms)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/**
 * Daily memory activity for the panel's contribution-style heatmap.
 * Counts non-tombstone records by their last update time inside the window.
 * @param {{ store: object }} backend
 * @param {unknown} raw
 */
export function computeActivity(backend, raw) {
  const input = asObject(raw)
  const { scope, projectKey } = normalizeScope(input)
  const days = optionalInteger(input.days, 'days', 371, 30, 730)
  const resolvedProjectKey = scope === 'project' ? (projectKey ?? currentProjectKey(backend.store)) : null
  if (scope === 'project' && resolvedProjectKey === null) {
    return { scope, projectKey: null, days: [], total: 0, activeDays: 0 }
  }
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const start = today.getTime() - (days - 1) * DAY_MS
  const buckets = new Map()
  let total = 0
  for (const record of backend.store.list(scope, resolvedProjectKey)) {
    if (record.status === 'deleted') continue
    const at = typeof record.updatedAt === 'number' ? record.updatedAt : record.observedAt
    if (typeof at !== 'number' || at < start) continue
    const key = localDayKey(at)
    const bucket = buckets.get(key) ?? { date: key, count: 0, preference: 0, fact: 0, decision: 0, episode: 0 }
    bucket.count += 1
    if (Object.hasOwn(bucket, record.kind)) bucket[record.kind] += 1
    buckets.set(key, bucket)
    total += 1
  }
  const list = [...buckets.values()].sort((left, right) => left.date.localeCompare(right.date))
  return { scope, projectKey: resolvedProjectKey, days: list, total, activeDays: list.length }
}

/**
 * L3 profile: evidence-backed traits derived from preference/decision records.
 * @param {{ store: object }} backend
 * @param {unknown} raw
 */
export function computeProfile(backend, raw) {
  const input = asObject(raw)
  const limit = optionalInteger(input.limit, 'limit', 10, 1, 50)
  return deriveProfile(backend.store.listAll(), { limit, now: Date.now() })
}

const PANEL_SETTINGS_FIELDS = Object.freeze([
  'captureEnabled',
  'injectEnabled',
  'injectMaxTokens',
  'retentionEpisodeDays',
  'maintenanceEnabled',
])

/**
 * Persist user-editable settings; the activation callback re-resolves config
 * and swaps it into the live capture/recall pipeline.
 * @param {{ applySettings?: Function, config: object }} backend
 * @param {unknown} raw
 */
export function updateSettings(backend, raw) {
  const input = asObject(raw)
  const patch = {}
  for (const field of Object.keys(input)) {
    if (!PANEL_SETTINGS_FIELDS.includes(field)) {
      throw new PanelInputError(`settings has unsupported field: ${field}`)
    }
    const value = input[field]
    if (field === 'injectMaxTokens' || field === 'retentionEpisodeDays') {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new PanelInputError(`${field} must be a number`)
      }
    } else if (typeof value !== 'boolean') {
      throw new PanelInputError(`${field} must be a boolean`)
    }
    patch[field] = value
  }
  if (Object.keys(patch).length === 0) throw new PanelInputError('settings patch must change at least one field')
  if (typeof backend.applySettings !== 'function') throw new PanelInputError('settings are read-only')
  const saved = backend.applySettings(patch)
  return {
    settings: saved,
    injectMaxTokens: backend.config?.inject?.maxTokens ?? null,
    retentionEpisodeDays: backend.config?.retention?.episodeDays ?? null,
  }
}

/** Export every current record as a JSON payload the panel can download. */
export function exportData(backend) {
  return backend.store.exportData()
}

/** Import a previously exported payload; newer revisions win, the index is rebuilt. */
export function importData(backend, raw) {
  const input = asObject(raw)
  const payload = input.payload
  if (payload === null || typeof payload !== 'object') throw new PanelInputError('payload must be an export object')
  const dryRun = input.dryRun === true
  const result = backend.store.importData(payload, { dryRun })
  if (!dryRun) backend.index.rebuild(backend.store.listAll())
  return result
}

/** Write a timestamped backup next to the authority and return its path. */
export function createBackup(backend) {
  return { path: backend.store.backup() }
}

function normalizePatch(raw) {
  const patch = asObject(raw)
  const fields = Object.keys(patch)
  if (fields.length === 0) throw new PanelInputError('patch must change at least one field')
  const unknown = fields.filter((field) => !PANEL_PATCH_FIELDS.includes(field))
  if (unknown.length > 0) throw new PanelInputError(`patch has unsupported field(s): ${unknown.join(', ')}`)
  const out = {}
  if (patch.content !== undefined) {
    if (typeof patch.content !== 'string') throw new PanelInputError('content must be a string')
    out.content = patch.content
  }
  if (patch.topic !== undefined) {
    if (patch.topic !== null && typeof patch.topic !== 'string') throw new PanelInputError('topic must be a string or null')
    out.topic = patch.topic
  }
  if (patch.tags !== undefined) {
    if (!Array.isArray(patch.tags) || patch.tags.some((tag) => typeof tag !== 'string')) {
      throw new PanelInputError('tags must be an array of strings')
    }
    out.tags = patch.tags
  }
  if (patch.status !== undefined) {
    if (!PANEL_PATCH_STATUSES.includes(patch.status)) {
      throw new PanelInputError(`status must be one of ${PANEL_PATCH_STATUSES.join(', ')}`)
    }
    out.status = patch.status
  }
  if (patch.importance !== undefined) {
    if (typeof patch.importance !== 'number' || !Number.isFinite(patch.importance)) {
      throw new PanelInputError('importance must be a number')
    }
    out.importance = Math.min(1, Math.max(0, patch.importance))
  }
  if (patch.pinned !== undefined) {
    if (typeof patch.pinned !== 'boolean') throw new PanelInputError('pinned must be a boolean')
    out.pinned = patch.pinned
  }
  return out
}

function normalizeTarget(raw) {
  const input = asObject(raw)
  const id = input.id
  if (typeof id !== 'string' || id.trim() === '') throw new PanelInputError('id must be a non-empty string')
  const { scope, projectKey } = normalizeScope(input)
  if (scope === 'project' && projectKey === null) throw new PanelInputError('project key is required for a project-scoped record')
  return { id: id.trim(), scope, projectKey, scopes: [{ scope, projectKey }] }
}

/**
 * Append a new revision and keep the shared index in step with the pipeline.
 * @param {{ store: object, index: object }} backend
 * @param {unknown} raw
 */
export function applyUpdate(backend, raw) {
  const input = asObject(raw)
  const target = normalizeTarget(input)
  const patch = normalizePatch(input.patch)
  const current = backend.store.find(target.id, target.scopes)
  if (current === undefined) throw new PanelInputError('memory not found in the requested scope')

  // User actions are feedback: approving a candidate raises its confidence,
  // editing or pinning raises importance so the memory wins future recalls.
  const next = { ...patch }
  let importance = current.importance ?? 0.5
  if (patch.status === 'active' && current.status === 'candidate') {
    next.confidence = Math.min(1, (current.confidence ?? 0.5) + 0.1)
    importance = Math.min(1, importance + 0.05)
  }
  if (patch.content !== undefined && patch.content !== current.content) {
    importance = Math.min(1, importance + 0.05)
  }
  if (patch.pinned === true) importance = Math.max(importance, 0.9)
  if (importance !== (current.importance ?? 0.5)) next.importance = importance

  let updated
  try {
    updated = backend.store.update(target.id, next, target.scopes)
  } catch (error) {
    throw new PanelInputError(error instanceof Error ? error.message : String(error))
  }
  if (updated === undefined) throw new PanelInputError('memory not found in the requested scope')
  backend.index.upsert(updated)
  return { record: projectRecord(updated) }
}

/**
 * Soft-delete one record: the JSONL keeps a tombstone, the index drops it.
 * @param {{ store: object, index: object }} backend
 * @param {unknown} raw
 */
export function applyRemove(backend, raw) {
  const target = normalizeTarget(asObject(raw))
  const removed = backend.store.remove(target.id, target.scopes)
  if (removed === undefined) throw new PanelInputError('memory not found in the requested scope')
  backend.index.remove(target.id)
  return { id: target.id, status: removed.status, revision: removed.revision }
}

/**
 * Rebuild the in-memory index from the JSONL authority.
 * @param {{ store: object, index: object }} backend
 */
export function rebuildMemoryIndex(backend) {
  backend.index.rebuild(backend.store.listAll())
  return { indexed: backend.index.size }
}
