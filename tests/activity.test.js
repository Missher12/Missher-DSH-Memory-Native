import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createPanelBackend } from '../host/remote.js'
import { computeActivity, computeStats, localDayKey } from '../host/remote-contract.js'
import { buildRecord } from '../host/records.js'
import { MemoryStore } from '../host/store.js'

const DAY = 86_400_000
const KEY = 'DSH-Memory-abc'

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-memory-activity-'))
  if (t !== undefined && typeof t.after === 'function') t.after(() => rmSync(root, { recursive: true, force: true }))
  const store = new MemoryStore({ root }).open()
  const backend = createPanelBackend({ store, index: { upsert() {}, remove() {}, search() { return [] } }, config: {}, root })
  return { root, store, backend }
}

/** A timestamp `days` days ago; always in the past, even just after midnight. */
function daysAgo(days) {
  return Date.now() - days * DAY - 1_000
}

function seed(store, at, overrides = {}) {
  const built = store.write({
    kind: 'fact',
    scope: 'project',
    projectKey: KEY,
    content: '记忆活动测试记录',
    ...overrides,
  }, { now: at })
  assert.equal(built.ok, true)
  return built.record
}

test('computeActivity groups records by local day and reports totals', (t) => {
  const { store, backend } = setup(t)
  seed(store, daysAgo(0), { kind: 'fact' })
  seed(store, daysAgo(0), { kind: 'preference', content: '用户偏好中文回复' })
  seed(store, daysAgo(2), { kind: 'episode' })

  const result = computeActivity(backend, { scope: 'project', projectKey: KEY })
  assert.equal(result.scope, 'project')
  assert.equal(result.projectKey, KEY)
  assert.equal(result.total, 3)
  assert.equal(result.activeDays, 2)
  assert.deepEqual(result.days.map((day) => day.date), [localDayKey(daysAgo(2)), localDayKey(daysAgo(0))].sort())
  const today = result.days.find((day) => day.date === localDayKey(daysAgo(0)))
  assert.equal(today.count, 2)
  assert.equal(today.fact, 1)
  assert.equal(today.preference, 1)
  assert.equal(today.episode, 0)
})

test('computeActivity excludes tombstones and records outside the window', (t) => {
  const { store, backend } = setup(t)
  const deleted = seed(store, daysAgo(1), { content: '将被删除的记录' })
  store.remove(deleted.id, [{ scope: 'project', projectKey: KEY }])
  seed(store, daysAgo(400), { content: '一年前的旧记录' })
  seed(store, daysAgo(3), { content: '窗口内的记录' })

  const result = computeActivity(backend, { scope: 'project', projectKey: KEY })
  assert.equal(result.total, 1)
  assert.deepEqual(result.days.map((day) => day.date), [localDayKey(daysAgo(3))])
})

test('computeActivity respects scope and the day window parameter', (t) => {
  const { store, backend } = setup(t)
  seed(store, daysAgo(0), { content: '项目记忆记录' })
  seed(store, daysAgo(0), { scope: 'global', projectKey: null, content: '全局记忆记录' })

  const global = computeActivity(backend, { scope: 'global' })
  assert.equal(global.scope, 'global')
  assert.equal(global.projectKey, null)
  assert.equal(global.total, 1)

  const project = computeActivity(backend, { scope: 'project', projectKey: KEY, days: 30 })
  assert.equal(project.total, 1)

  assert.equal(computeActivity(backend, { scope: 'project', projectKey: KEY, days: 1 }).total, 1)
  assert.throws(
    () => computeActivity(backend, { scope: 'project', projectKey: KEY, days: 'many' }),
    (error) => error.name === 'PanelInputError',
  )
})

test('computeActivity returns an empty shape for an unknown project', (t) => {
  const { backend } = setup(t)
  const result = computeActivity(backend, { scope: 'project', projectKey: 'DSH-None-000' })
  assert.deepEqual(result, { scope: 'project', projectKey: 'DSH-None-000', days: [], total: 0, activeDays: 0 })
})

test('localDayKey formats dates in local calendar time', () => {
  const date = new Date(2026, 9, 31, 23, 59, 59)
  assert.equal(localDayKey(date.getTime()), '2026-10-31')
  assert.equal(localDayKey(new Date(2026, 0, 1, 0, 0, 0).getTime()), '2026-01-01')
})

test('incremental store summaries preserve counts through activation, edit, archive, supersede, delete, import and reopen', (t) => {
  const { root, store, backend } = setup(t)
  assert.equal(typeof store.aggregateStats, 'function')
  assert.equal(typeof store.activitySummary, 'function')
  const fact = seed(store, Date.now(), { confidence: .9, content: '基础记录用于计数。' })
  const candidate = seed(store, Date.now(), { status: 'candidate', content: '候选记录用于计数。' })
  assert.equal(computeStats(backend, { scope: 'project', projectKey: KEY }).active, 1)
  assert.equal(computeStats(backend, { scope: 'project', projectKey: KEY }).candidate, 1)

  store.update(candidate.id, { status: 'active' }, [{ scope: 'project', projectKey: KEY }])
  store.update(fact.id, { content: '编辑后的基础记录用于计数。' }, [{ scope: 'project', projectKey: KEY }])
  let stats = computeStats(backend, { scope: 'project', projectKey: KEY })
  assert.equal(stats.active, 2)
  assert.equal(stats.candidate, 0)
  assert.equal(computeActivity(backend, { scope: 'project', projectKey: KEY }).total, 2)

  store.update(fact.id, { status: 'archived' }, [{ scope: 'project', projectKey: KEY }])
  stats = computeStats(backend, { scope: 'project', projectKey: KEY })
  assert.equal(stats.active, 1)
  assert.equal(stats.archived, 1)

  const replacement = buildRecord({ kind: 'fact', scope: 'project', projectKey: KEY,
    confidence: .9, content: '替换后的记录用于计数。' }, { id: 'mem_replacement_for_activity' })
  assert.equal(replacement.ok, true)
  store.replace(candidate.id, replacement.record)
  stats = computeStats(backend, { scope: 'project', projectKey: KEY })
  assert.equal(stats.active, 1)
  assert.equal(stats.archived, 1)
  assert.equal(stats.superseded, 1)
  assert.equal(computeActivity(backend, { scope: 'project', projectKey: KEY }).total, 3)

  store.remove(replacement.record.id, [{ scope: 'project', projectKey: KEY }])
  stats = computeStats(backend, { scope: 'project', projectKey: KEY })
  assert.equal(stats.deleted, 1)
  assert.equal(stats.archived, 1)
  assert.equal(stats.total, 2)
  assert.equal(computeActivity(backend, { scope: 'project', projectKey: KEY }).total, 2)

  const imported = store.write({ kind: 'decision', scope: 'project', projectKey: KEY,
    content: '导入后的决策用于计数。' }, { id: 'mem_imported_for_activity' })
  assert.equal(imported.ok, true)
  store.remove(imported.record.id, [{ scope: 'project', projectKey: KEY }])
  const reopened = new MemoryStore({ root }).open()
  const importRecord = { ...imported.record, id: 'mem_bulk_import_for_activity', revision: 1 }
  assert.equal(reopened.importData({ schemaVersion: 2, global: [], projects: { [KEY]: [importRecord] } }).imported, 1)
  backend.store = reopened
  stats = computeStats(backend, { scope: 'project', projectKey: KEY })
  assert.equal(stats.total, 3)
  assert.equal(stats.active, 0)
  assert.equal(stats.candidate, 1)
  assert.equal(stats.deleted, 2)
  assert.equal(computeActivity(backend, { scope: 'project', projectKey: KEY }).total, 3)

  const afterReopen = new MemoryStore({ root }).open()
  backend.store = afterReopen
  stats = computeStats(backend, { scope: 'project', projectKey: KEY })
  assert.equal(stats.total, 3)
  assert.equal(stats.active, 0)
  assert.equal(stats.candidate, 1)
  assert.equal(stats.archived, 1)
  assert.equal(stats.superseded, 1)
  assert.equal(stats.deleted, 2)
  assert.equal(computeActivity(backend, { scope: 'project', projectKey: KEY }).total, 3)
})

test('stats follows the trusted host session and otherwise chooses a browseable project', async t => {
  const { root, store } = setup(t)
  seed(store, Date.now(), { content: '可浏览项目的真实记忆。' })
  const emptyProject = 'DSH-Memory-empty'
  const deleted = seed(store, Date.now() + 1, { projectKey: emptyProject, content: '已遗忘的合成项目记录。' })
  store.remove(deleted.id, [{ scope: 'project', projectKey: emptyProject }])
  const trustedProject = 'DSH-Memory-current-session'
  const index = { upsert() {}, remove() {}, search() { return [] } }
  const backend = createPanelBackend({ store, index, config: {}, root,
    getSessionProjectKey: async id => id === 'trusted-session' ? trustedProject : null,
    getLastRecallAsync: async (input, hostProjectKey) => hostProjectKey &&
      (!input?.projectKey || input.projectKey === hostProjectKey) ? { projectKey: hostProjectKey } : null,
  })

  const trusted = await backend.stats({ scope: 'project', sessionId: 'trusted-session' })
  assert.equal(trusted.currentProjectKey, trustedProject)
  assert.equal(trusted.lastRecall.projectKey, trustedProject)

  const unknown = await backend.stats({ scope: 'project', sessionId: 'unknown-session' })
  assert.equal(unknown.currentProjectKey, KEY)
  assert.equal(unknown.lastRecall, null)
  assert.deepEqual(unknown.browseableProjectKeys, [KEY])

  const inconsistent = await backend.stats({ scope: 'project', sessionId: 'trusted-session', projectKey: KEY })
  assert.equal(inconsistent.currentProjectKey, trustedProject)
  assert.equal(inconsistent.lastRecall, null,
    'a client project hint cannot rebind a recall report to a different host session project')
})
