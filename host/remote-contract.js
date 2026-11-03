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
import { buildKnowledgeGraph, listKnowledgeNotes, promoteMemoryToKnowledge } from './knowledge.js'
import { readMaintenance } from './maintenance.js'
import { exportToObsidian, importFromObsidian, readSyncSummary, writeSyncSummary } from './obsidian.js'
import { tokenize } from './tokenize.js'
import { MEMORY_KINDS } from './records.js'

/** Package identity shared by the client contribution and diagnostics. */
export const PANEL_PACKAGE = '@missher/dsh-memory'
/** Cordis service key and Typert Remote namespace. */
export const PANEL_SERVICE = 'dshMemory'
export const PANEL_NAMESPACE = 'dshMemory'
/** Every endpoint the panel mounts, in declaration order. */
export const PANEL_METHODS = Object.freeze(['list', 'stats', 'activity', 'profile', 'update', 'removeMemory', 'rebuildIndex', 'updateSettings', 'exportData', 'importData', 'backup', 'restoreMemory', 'purgeMemory', 'history', 'restoreRevision', 'bulkAction', 'topicSuggestions', 'mergeTopics', 'obsidianExport', 'obsidianImport', 'obsidianStatus', 'knowledgeGraph', 'knowledgePromote', 'knowledgeList'])
/** The single JSON argument wire field of every endpoint. */
export const PANEL_INPUT_WIRE = 'input'
/** Maximum records returned by one `list` call. */
export const PANEL_LIMIT = Object.freeze({ default: 100, max: 200 })
/** Statuses the panel can filter on (tombstones stay hidden). */
export const PANEL_FILTER_STATUSES = Object.freeze(['active', 'candidate', 'archived', 'superseded', 'deleted'])
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
  const topic = optionalText(input.topic, 'topic', 48)
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
      topicCounts: { __none__: 0 },
    }
  }

  const statuses = status === undefined ? PANEL_FILTER_STATUSES.filter((value) => value !== 'deleted') : [status]
  let records
  if (status === 'deleted') {
    records = backend.store.list(scope, scope === 'project' ? resolvedProjectKey : null, { includeDeleted: true })
      .filter((record) => record.status === 'deleted')
    if (query !== undefined) {
      const needle = query.toLowerCase()
      records = records.filter((record) => String(record.content ?? '').toLowerCase().includes(needle))
    }
  } else if (query !== undefined) {
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
  const topicCounts = { __none__: 0 }
  const byKind = records.filter((record) => {
    if (Object.hasOwn(kindCounts, record.kind)) kindCounts[record.kind] += 1
    return kind === undefined || record.kind === kind
  })
  for (const record of byKind) {
    const value = typeof record.topic === 'string' && record.topic !== '' ? record.topic : null
    if (value === null) topicCounts.__none__ += 1
    else topicCounts[value] = (topicCounts[value] ?? 0) + 1
  }
  const filtered = topic === undefined
    ? byKind
    : byKind.filter((record) => {
      const value = typeof record.topic === 'string' && record.topic !== '' ? record.topic : null
      return topic === '__none__' ? value === null : value === topic
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
    topicCounts,
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
    lastInjection: typeof backend.getLastInjection === 'function' ? backend.getLastInjection() : null,
    captureEnabled: backend.config?.capture?.enabled === true,
    injectEnabled: backend.config?.inject?.enabled === true,
    injectMaxTokens: backend.config?.inject?.maxTokens ?? null,
    retentionEpisodeDays: backend.config?.retention?.episodeDays ?? null,
    maintenanceEnabled: backend.config?.maintenance?.enabled === true,
    obsidianVaultPath: backend.config?.obsidian?.vaultPath ?? null,
    obsidianFolder: backend.config?.obsidian?.folder ?? 'DSH Memory',
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
  'obsidianVaultPath',
  'obsidianFolder',
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
    } else if (field === 'obsidianVaultPath' || field === 'obsidianFolder') {
      if (typeof value !== 'string') throw new PanelInputError(`${field} must be a string`)
      if (field === 'obsidianVaultPath' && value.length > 1024) throw new PanelInputError('obsidianVaultPath is too long')
      if (field === 'obsidianFolder' && value.length > 64) throw new PanelInputError('obsidianFolder is too long')
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

/** Restore a tombstoned record to active. */
export function restoreMemory(backend, raw) {
  const target = normalizeTarget(raw)
  const current = backend.store.find(target.id, target.scopes)
  if (current === undefined) throw new PanelInputError('memory not found in the requested scope')
  if (current.status !== 'deleted') throw new PanelInputError('only deleted memories can be restored')
  const updated = backend.store.update(target.id, { status: 'active' }, target.scopes)
  backend.index.upsert(updated)
  return { record: projectRecord(updated) }
}

/** Restore one historical revision as a new active revision. */
export function restoreRevision(backend, raw) {
  const target = normalizeTarget(raw)
  const input = asObject(raw)
  const revision = optionalInteger(input.revision, 'revision', 1, 1, 1_000_000)
  const current = backend.store.find(target.id, target.scopes)
  if (current === undefined) throw new PanelInputError('memory not found in the requested scope')
  const candidate = backend.store.history(target.id, target.scopes).find((record) => record.revision === revision)
  if (candidate === undefined) throw new PanelInputError('revision not found')
  const updated = backend.store.update(target.id, {
    content: candidate.content,
    topic: candidate.topic ?? null,
    tags: Array.isArray(candidate.tags) ? candidate.tags : [],
    importance: candidate.importance ?? 0.5,
    pinned: candidate.pinned === true,
    status: 'active',
  }, target.scopes)
  backend.index.upsert(updated)
  return { record: projectRecord(updated) }
}

/** Physically delete every revision; only tombstones are purgeable. */
export function purgeMemory(backend, raw) {
  const target = normalizeTarget(raw)
  const current = backend.store.find(target.id, target.scopes)
  if (current === undefined) throw new PanelInputError('memory not found in the requested scope')
  if (current.status !== 'deleted') throw new PanelInputError('only deleted memories can be purged')
  const purged = backend.store.purge(target.id, target.scopes)
  if (!purged) throw new PanelInputError('memory could not be purged')
  backend.index.remove(target.id)
  return { purged: true, id: target.id }
}

/** Revision history for one record, newest first. */
export function memoryHistory(backend, raw) {
  const target = normalizeTarget(raw)
  const current = backend.store.find(target.id, target.scopes)
  if (current === undefined) throw new PanelInputError('memory not found in the requested scope')
  const revisions = backend.store.history(target.id, target.scopes).map((record) => ({
    revision: record.revision,
    status: record.status,
    content: record.content,
    topic: record.topic ?? null,
    tags: Array.isArray(record.tags) ? record.tags : [],
    importance: record.importance ?? null,
    confidence: record.confidence ?? null,
    pinned: record.pinned === true,
    updatedAt: record.updatedAt ?? record.observedAt ?? null,
  }))
  return { id: target.id, scope: target.scope, projectKey: target.projectKey, revisions }
}

/** Archive, delete, restore or tag many records; atomic rolls back on any failure. */
export function bulkAction(backend, raw) {
  const input = asObject(raw)
  const action = input.action
  if (!['archive', 'delete', 'restore', 'tag'].includes(action)) {
    throw new PanelInputError('action must be one of archive, delete, restore, tag')
  }
  if (!Array.isArray(input.ids) || input.ids.length === 0 || input.ids.length > 200) {
    throw new PanelInputError('ids must contain 1..200 record ids')
  }
  let tags = null
  if (action === 'tag') {
    if (!Array.isArray(input.tags) || input.tags.length === 0 || input.tags.length > 10) {
      throw new PanelInputError('tags must contain 1..10 tag names')
    }
    tags = input.tags.map((tag) => {
      if (typeof tag !== 'string' || tag.trim() === '' || tag.trim().length > 24) {
        throw new PanelInputError('each tag must be a non-empty string of at most 24 characters')
      }
      return tag.trim()
    })
  }
  const atomic = input.atomic !== false
  const { scope, projectKey } = normalizeScope(input)
  if (scope === 'project' && projectKey === null) throw new PanelInputError('project key is required for a project-scoped bulk action')
  const scopes = [{ scope, projectKey }]
  const previous = new Map()
  const updated = []
  const failed = []
  for (const rawId of input.ids) {
    if (typeof rawId !== 'string' || rawId.trim() === '') {
      failed.push({ id: String(rawId), reason: 'id must be a non-empty string' })
      if (atomic) break
      continue
    }
    const id = rawId.trim()
    try {
      const current = backend.store.find(id, scopes)
      if (current === undefined) {
        failed.push({ id, reason: 'memory not found in the requested scope' })
        if (atomic) break
        continue
      }
      let next
      if (action === 'archive') next = backend.store.update(id, { status: 'archived' }, scopes)
      else if (action === 'delete') next = backend.store.remove(id, scopes)
      else if (action === 'restore') {
        if (current.status !== 'deleted') {
          failed.push({ id, reason: 'only deleted memories can be restored' })
          if (atomic) break
          continue
        }
        next = backend.store.update(id, { status: 'active' }, scopes)
      } else {
        const merged = [...new Set([...(Array.isArray(current.tags) ? current.tags : []), ...tags])]
        next = backend.store.update(id, { tags: merged }, scopes)
      }
      if (next === undefined) {
        failed.push({ id, reason: 'memory not found in the requested scope' })
        if (atomic) break
        continue
      }
      previous.set(id, current)
      if (next.status === 'deleted') backend.index.remove(id)
      else backend.index.upsert(next)
      updated.push(id)
    } catch (error) {
      failed.push({ id, reason: error instanceof Error ? error.message : String(error) })
      if (atomic) break
    }
  }

  let rolledBack = false
  let rollbackFailed = []
  if (atomic && failed.length > 0 && updated.length > 0) {
    rolledBack = true
    for (const id of updated) {
      const before = previous.get(id)
      try {
        const next = backend.store.update(id, {
          status: before.status,
          tags: before.tags,
          topic: before.topic ?? null,
          importance: before.importance ?? 0.5,
          pinned: before.pinned === true,
        }, scopes)
        if (next !== undefined) {
          if (next.status === 'deleted') backend.index.remove(id)
          else backend.index.upsert(next)
        } else {
          rollbackFailed.push(id)
        }
      } catch {
        rollbackFailed.push(id)
      }
    }
    updated.length = 0
  }
  return { action, updated, failed, rolledBack, rollbackFailed, updatedCount: updated.length, failedCount: failed.length }
}

/** Suggest topic names that differ only slightly (bigram similarity or containment). */
export function topicSuggestions(backend, raw) {
  const input = asObject(raw)
  const { scope, projectKey } = normalizeScope(input)
  if (scope === 'project' && projectKey === null) throw new PanelInputError('project key is required for a project-scoped topic query')
  const records = backend.store.list(scope, scope === 'project' ? projectKey : null)
  const counts = new Map()
  for (const record of records) {
    const topic = typeof record.topic === 'string' && record.topic.trim() !== '' ? record.topic.trim() : null
    if (topic !== null) counts.set(topic, (counts.get(topic) ?? 0) + 1)
  }
  const topics = [...counts.keys()].sort()
  const suggestions = []
  for (let i = 0; i < topics.length; i += 1) {
    for (let j = i + 1; j < topics.length; j += 1) {
      const left = topics[i]
      const right = topics[j]
      const a = new Set(tokenize(left).filter((token) => token.length >= 2))
      const b = new Set(tokenize(right).filter((token) => token.length >= 2))
      let shared = 0
      for (const token of a) if (b.has(token)) shared += 1
      const union = a.size + b.size - shared
      const similarity = union === 0 ? 0 : shared / union
      const contained = left.includes(right) || right.includes(left)
      if (similarity >= 0.5 || contained) {
        suggestions.push({
          from: left,
          to: right,
          fromCount: counts.get(left),
          toCount: counts.get(right),
          similarity: Math.round(similarity * 100) / 100,
        })
      }
    }
  }
  suggestions.sort((left, right) => right.similarity - left.similarity)
  return { scope, projectKey: scope === 'project' ? projectKey : null, suggestions: suggestions.slice(0, 20), topicCount: counts.size }
}

/** Merge one topic into another for every record in the scope. */
export function mergeTopics(backend, raw) {
  const input = asObject(raw)
  const { scope, projectKey } = normalizeScope(input)
  if (scope === 'project' && projectKey === null) throw new PanelInputError('project key is required for a project-scoped topic merge')
  const from = optionalText(input.from, 'from', 48)
  const to = optionalText(input.to, 'to', 48)
  if (from === undefined || to === undefined || from === to) throw new PanelInputError('from and to must be different topic names')
  const records = backend.store.list(scope, scope === 'project' ? projectKey : null)
  let merged = 0
  for (const record of records) {
    if (record.topic !== from) continue
    const updated = backend.store.update(record.id, { topic: to }, [{ scope, projectKey: scope === 'project' ? projectKey : null }])
    if (updated !== undefined) {
      backend.index.upsert(updated)
      merged += 1
    }
  }
  return { from, to, merged }
}

/** Resolve Obsidian path settings from the request or the live config. */
function obsidianTargetFrom(backend, input) {
  const vaultPath = optionalText(input.vaultPath, 'vaultPath', 1024) ?? backend.config?.obsidian?.vaultPath ?? null
  if (vaultPath === null) throw new PanelInputError('Obsidian vault path is not configured')
  const folder = optionalText(input.folder, 'folder', 64) ?? backend.config?.obsidian?.folder ?? 'DSH Memory'
  return { vaultPath, folder }
}

/** Export memories to the Obsidian vault as one Markdown file each. */
export function obsidianExport(backend, raw) {
  const input = asObject(raw)
  const { vaultPath, folder } = obsidianTargetFrom(backend, input)
  let summary
  try {
    summary = exportToObsidian({ store: backend.store, vaultPath, folder })
  } catch (error) {
    throw new PanelInputError(error instanceof Error ? error.message : String(error))
  }
  try {
    writeSyncSummary(backend.root, { direction: 'export', ...summary })
  } catch {
    // The sync summary is advisory.
  }
  return summary
}

/** Import Markdown notes back into memory (dryRun previews without writing). */
export function obsidianImport(backend, raw) {
  const input = asObject(raw)
  const { vaultPath, folder } = obsidianTargetFrom(backend, input)
  let summary
  try {
    summary = importFromObsidian({
      store: backend.store,
      index: backend.index,
      vaultPath,
      folder,
      dryRun: input.dryRun === true,
    })
  } catch (error) {
    throw new PanelInputError(error instanceof Error ? error.message : String(error))
  }
  if (input.dryRun !== true) {
    try {
      writeSyncSummary(backend.root, { direction: 'import', ...summary })
    } catch {
      // The sync summary is advisory.
    }
  }
  return summary
}

/** Current Obsidian configuration + last sync summary. */
export function obsidianStatus(backend) {
  return {
    vaultPath: backend.config?.obsidian?.vaultPath ?? null,
    folder: backend.config?.obsidian?.folder ?? 'DSH Memory',
    lastSync: backend.root ? readSyncSummary(backend.root) : null,
  }
}

/** Topic-oriented graph for the panel's knowledge map. */
export function knowledgeGraph(backend, raw) {
  const input = asObject(raw)
  let records
  if (input.scope === 'all') {
    records = backend.store.listAll()
  } else {
    const { scope, projectKey } = normalizeScope(input)
    const resolvedProjectKey = scope === 'project' ? (projectKey ?? currentProjectKey(backend.store)) : null
    records = scope === 'global'
      ? backend.store.list('global', null)
      : resolvedProjectKey === null ? [] : backend.store.list('project', resolvedProjectKey)
  }
  const limit = Number.isInteger(input.limit) ? Math.min(1000, Math.max(10, input.limit)) : 400
  const notes = backend.root === null ? [] : listKnowledgeNotes(backend.root)
  const profile = deriveProfile(records, { limit: 12 })
  return buildKnowledgeGraph(records, { maxNodes: limit, notes, traits: profile.traits })
}

/** Promote one memory into a long-term Markdown knowledge note. */
export function knowledgePromote(backend, raw) {
  const target = normalizeTarget(raw)
  const record = backend.store.find(target.id, target.scopes)
  if (record === undefined) throw new PanelInputError('memory not found in the requested scope')
  if (record.status === 'deleted') throw new PanelInputError('cannot promote a deleted memory')
  if (backend.root === null) throw new PanelInputError('memory root is unavailable')
  try {
    const path = promoteMemoryToKnowledge(backend.root, record)
    return { ok: true, path, id: record.id }
  } catch (error) {
    throw new PanelInputError(error instanceof Error ? error.message : String(error))
  }
}

/** List promoted long-term knowledge notes for the knowledge base tab. */
export function knowledgeList(backend) {
  const notes = backend.root === null ? [] : listKnowledgeNotes(backend.root)
  return {
    notes: notes.map((note) => ({
      file: note.file,
      memoryId: note.memoryId,
      topic: note.topic,
      tags: note.tags,
      title: note.title,
    })),
    total: notes.length,
    vaultPath: backend.config?.obsidian?.vaultPath ?? null,
    folder: backend.config?.obsidian?.folder ?? 'DSH Memory',
  }
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
