/**
 * Compare legacy full scans with incremental summaries and a warm per-session report refresh.
 * Run: node scripts/bench-activity.mjs
 * Optional: BENCH_RECORDS=50000 BENCH_ROUNDS=35
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { buildRecord } from '../host/records.js'
import { computeActivity, computeStats } from '../host/remote-contract.js'
import { projectIdentity } from '../host/paths.js'
import { createRecallReportStore } from '../host/recall-reports.js'
import { MemoryStore } from '../host/store.js'

const RECORD_COUNT = Number(process.env.BENCH_RECORDS) > 0 ? Number(process.env.BENCH_RECORDS) : 50_000
const ROUNDS = Number(process.env.BENCH_ROUNDS) > 0 ? Number(process.env.BENCH_ROUNDS) : 35
const root = mkdtempSync(join(tmpdir(), 'dsh-memory-activity-bench-'))
const projectKey = projectIdentity(join(root, 'benchmark-project')).key
const projectPath = join(root, 'projects', projectKey, 'memories.jsonl')
const now = Date.now()
const DAY = 86_400_000
const scopes = [{ scope: 'project', projectKey }]

function recordAt(index) {
  const built = buildRecord({
    id: `mem_bench_${String(index).padStart(6, '0')}`,
    kind: ['fact', 'decision', 'preference', 'episode'][index % 4],
    scope: 'project', projectKey,
    content: `Benchmark memory ${index}: the project keeps a verified operational fact.`,
    confidence: .8,
  }, { now: now - (index % 1000) * DAY, autoApproveConfidence: .7 })
  if (!built.ok) throw new Error(built.reason)
  return built.record
}

function timings(fn, rounds = ROUNDS) {
  for (let i = 0; i < 5; i++) fn()
  const samples = []
  for (let i = 0; i < rounds; i++) {
    const started = performance.now()
    fn()
    samples.push(performance.now() - started)
  }
  samples.sort((a, b) => a - b)
  return { p50Ms: Number(samples[Math.floor(samples.length * .5)].toFixed(2)),
    p95Ms: Number(samples[Math.min(samples.length - 1, Math.floor(samples.length * .95))].toFixed(2)) }
}

try {
  mkdirSync(dirname(projectPath), { recursive: true })
  const lines = []
  for (let i = 0; i < RECORD_COUNT; i++) lines.push(JSON.stringify(recordAt(i)))
  writeFileSync(projectPath, `${lines.join('\n')}\n`, { mode: 0o600 })

  const store = new MemoryStore({ root }).open()
  const reportStore = createRecallReportStore(root, 'f'.repeat(64))
  const reportSession = 'benchmark-session'
  const seededReport = { at: now, projectKey, turnKey: 'id:benchmark', outcome: 'completed', total: 1,
    questions: [{ query: 'benchmark query', hits: [], injected: [], notInjected: [], answerCoverage: 'unverified', answerExcerpt: null }],
    localDeepRecall: null }
  reportStore.write(reportSession, projectKey, seededReport)
  assert.deepEqual(reportStore.get(reportSession, projectKey), seededReport, 'seed one warm current-session report')
  const backend = { root, store, index: { upsert() {}, remove() {} }, config: {},
    getLastRecall: (sessionId, requestedProject) => sessionId === reportSession && requestedProject === projectKey
      ? reportStore.get(sessionId, projectKey) : null }
  const legacyStore = new Proxy(store, {
    get(target, key) {
      if (key === 'aggregateStats' || key === 'activitySummary') return undefined
      const value = Reflect.get(target, key, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  const legacyBackend = { ...backend, store: legacyStore }
  const statsInput = { scope: 'project', projectKey, sessionId: reportSession }
  const activityInput = { ...statsInput, days: 371 }
  const equalSummaries = label => {
    const currentStats = computeStats(backend, statsInput)
    const scannedStats = computeStats(legacyBackend, statsInput)
    for (const field of ['active', 'candidate', 'archived', 'superseded', 'total', 'deleted', 'avgConfidence', 'lastCapturedAt']) {
      assert.equal(currentStats[field], scannedStats[field], `${label}: stats.${field}`)
    }
    assert.deepEqual(currentStats.kinds, scannedStats.kinds, `${label}: stats.kinds`)
    assert.deepEqual(currentStats.lastRecall, scannedStats.lastRecall, `${label}: stats.lastRecall`)
    const currentActivity = computeActivity(backend, activityInput)
    const scannedActivity = computeActivity(legacyBackend, activityInput)
    assert.deepEqual(currentActivity, scannedActivity, `${label}: activity`)
    return { stats: currentStats, activity: currentActivity }
  }

  equalSummaries('before benchmark') // Seed the lazy aggregate before timing warm requests.
  const timingsResult = {
    records: RECORD_COUNT,
    rounds: ROUNDS,
    lastRecall: { warmSessionRead: timings(() => reportStore.get(reportSession, projectKey)) },
    stats: { legacyFullScan: timings(() => computeStats(legacyBackend, statsInput)),
      incremental: timings(() => computeStats(backend, statsInput)) },
    activity: { legacyFullScan: timings(() => computeActivity(legacyBackend, activityInput)),
      incremental: timings(() => computeActivity(backend, activityInput)) },
  }

  const before = equalSummaries('before mutations')
  const created = store.write({ kind: 'fact', scope: 'project', projectKey, content: 'Benchmark mutation: a newly added fact is counted.', confidence: .9 },
    { id: 'mem_bench_created', now })
  assert.equal(created.ok, true)
  const afterCreate = equalSummaries('create')
  assert.equal(afterCreate.stats.total, before.stats.total + 1)
  const edited = store.update('mem_bench_000000', { content: 'Benchmark mutation: the first fact was edited.', status: 'archived' }, scopes)
  assert.ok(edited)
  const afterEdit = equalSummaries('edit')
  assert.equal(afterEdit.stats.total, afterCreate.stats.total)
  assert.equal(afterEdit.stats.archived, afterCreate.stats.archived + 1)
  const deleted = store.remove('mem_bench_000001', scopes)
  assert.ok(deleted)
  const afterDelete = equalSummaries('delete')
  assert.equal(afterDelete.stats.total, afterEdit.stats.total - 1)
  assert.equal(afterDelete.stats.deleted, afterEdit.stats.deleted + 1)

  console.log(JSON.stringify({ ...timingsResult, mutations: {
    total: [before.stats.total, afterCreate.stats.total, afterEdit.stats.total, afterDelete.stats.total],
    archived: afterDelete.stats.archived, deleted: afterDelete.stats.deleted,
    exactSummaryParity: true,
  } }, null, 2))
} finally {
  rmSync(root, { recursive: true, force: true })
}
