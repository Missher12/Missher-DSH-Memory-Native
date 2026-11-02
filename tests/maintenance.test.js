import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { resolveConfig } from '../host/config.js'
import { pruneBackups, runMaintenance } from '../host/maintenance.js'
import { MemoryStore } from '../host/store.js'

const NOW = 1_700_000_000_000
const DAY = 86_400_000
const KEY = 'DSH-Maint-abc'

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-memory-maintenance-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const store = new MemoryStore({ root, clock: () => NOW }).open()
  const config = resolveConfig({ retention: { episodeDays: 90 }, maintenance: { backupKeep: 7 } })
  return { root, store, config }
}

function writeEpisode(store, content, { now, confidence = 0.5, status = 'active', pinned = false } = {}) {
  const built = store.write({
    kind: 'episode',
    scope: 'project',
    projectKey: KEY,
    content,
    confidence,
    importance: 0.5,
    status,
    pinned,
  }, { now, autoApproveConfidence: 0.75 })
  assert.equal(built.ok, true)
  return built.record
}

test('maintenance archives only stale low-confidence episodes', (t) => {
  const { root, store, config } = setup(t)
  const stale = writeEpisode(store, '很久以前的低置信度经验记录', { now: NOW - 200 * DAY, confidence: 0.5 })
  const recent = writeEpisode(store, '最近的低置信度经验记录', { now: NOW - 5 * DAY, confidence: 0.5 })
  const strong = writeEpisode(store, '很久以前的高置信度经验记录', { now: NOW - 200 * DAY, confidence: 0.9 })
  const pinned = writeEpisode(store, '很久以前的固定经验记录', { now: NOW - 200 * DAY, confidence: 0.5, pinned: true })

  const summary = runMaintenance({ store, config, now: NOW })
  assert.equal(summary.archived, 1)
  const records = store.list('project', KEY, { includeDeleted: true })
  const byId = new Map(records.map((record) => [record.id, record]))
  assert.equal(byId.get(stale.id).status, 'archived')
  assert.equal(byId.get(recent.id).status, 'active')
  assert.equal(byId.get(strong.id).status, 'active')
  assert.equal(byId.get(pinned.id).status, 'active')
  assert.ok(summary.backedUp !== null && existsSync(summary.backedUp))
  const report = JSON.parse(readFileSync(join(root, 'maintenance.json'), 'utf8'))
  assert.equal(report.archived, 1)
})

test('maintenance can be disabled by config', (t) => {
  const { store } = setup(t)
  const config = resolveConfig({ maintenance: { enabled: false } })
  writeEpisode(store, '不会被归档的旧经验记录', { now: NOW - 200 * DAY, confidence: 0.5 })
  const summary = runMaintenance({ store, config, now: NOW })
  assert.equal(summary.skipped, true)
  assert.equal(summary.archived, 0)
  assert.equal(store.list('project', KEY)[0].status, 'active')
})

test('pruneBackups keeps the newest files', (t) => {
  const { root } = setup(t)
  const dir = join(root, 'backups')
  mkdirSync(dir, { recursive: true })
  for (let index = 0; index < 9; index += 1) {
    writeFileSync(join(dir, `memories-test-${index}.json`), '{}')
  }
  const removed = pruneBackups(root, 7)
  assert.equal(removed, 2)
  assert.equal(readdirSync(dir).filter((name) => name.startsWith('memories-')).length, 7)
})
