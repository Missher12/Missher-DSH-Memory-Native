import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import test from 'node:test'

import { resolveConfig } from '../host/config.js'
import { createCompleteBackup, verifyBackup } from '../host/backup.js'
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

test('maintenance archives only stale low-confidence episodes', async (t) => {
  const { root, store, config } = setup(t)
  const stale = writeEpisode(store, '很久以前的低置信度经验记录', { now: NOW - 200 * DAY, confidence: 0.5 })
  const recent = writeEpisode(store, '最近的低置信度经验记录', { now: NOW - 5 * DAY, confidence: 0.5 })
  const strong = writeEpisode(store, '很久以前的高置信度经验记录', { now: NOW - 200 * DAY, confidence: 0.9 })
  const pinned = writeEpisode(store, '很久以前的固定经验记录', { now: NOW - 200 * DAY, confidence: 0.5, pinned: true })

  const summary = await runMaintenance({ store, config, now: NOW })
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

test('maintenance can be disabled by config', async (t) => {
  const { store } = setup(t)
  const config = resolveConfig({ maintenance: { enabled: false } })
  writeEpisode(store, '不会被归档的旧经验记录', { now: NOW - 200 * DAY, confidence: 0.5 })
  const summary = await runMaintenance({ store, config, now: NOW })
  assert.equal(summary.skipped, true)
  assert.equal(summary.archived, 0)
  assert.equal(store.list('project', KEY)[0].status, 'active')
})

test('backup scheduling uses the verified creation time, including clock rollback', async t => {
  const { store, config } = setup(t)
  const first = await runMaintenance({ store, config, now: NOW })
  assert.ok(first.backedUp)
  assert.equal((await runMaintenance({ store, config, now: NOW + 1000 })).backedUp, null)
  assert.ok((await runMaintenance({ store, config, now: NOW - DAY })).backedUp)
})

test('failed backup reports the failure and does not prune previous recovery files', async t => {
  const { root, store, config } = setup(t), dir = join(root, 'backups')
  mkdirSync(dir)
  for (let i = 0; i < 9; i++) writeFileSync(join(dir, `memories-old-${i}.json`), '{}')
  store.backup = async () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }) }
  const summary = await runMaintenance({ store, config, now: NOW })
  assert.equal(summary.backedUp, null)
  assert.equal(summary.backupError.code, 'backup-failed')
  assert.equal(summary.pruned, 0)
  assert.equal(readdirSync(dir).length, 9)
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

function seedSmallNotes(root) {
  const notes = join(root, 'knowledge')
  mkdirSync(notes, { recursive: true })
  for (let i = 0; i < 128; i++) writeFileSync(join(notes, `note-${i}.md`), `# Knowledge note ${i}\n`)
}

test('automatic maintenance keeps one verified backup of each format within its retention limit', async t => {
  const { root, store } = setup(t)
  seedSmallNotes(root)
  const compatible = await createCompleteBackup(root, NOW, 'compatible')
  const olderFast = await createCompleteBackup(root, NOW + 1000, 'fast')
  const newestFast = await createCompleteBackup(root, NOW + 2000, 'fast')
  const corruptFast = await createCompleteBackup(root, NOW + 3000, 'fast')
  for (const [index, path] of [compatible, olderFast, newestFast, corruptFast].entries()) {
    const date = new Date(NOW + index * 1000)
    utimesSync(path, date, date)
  }
  const payloads = join(corruptFast, 'payloads')
  writeFileSync(join(payloads, readdirSync(payloads)[0]), 'broken')

  const config = resolveConfig({ maintenance: { backupKeep: 2 } })
  const result = await runMaintenance({ store, config, now: NOW + 4000 })
  assert.equal(result.backedUp, null)
  assert.equal(result.pruned, 2)
  assert.deepEqual(readdirSync(join(root, 'backups')).sort(), [basename(compatible), basename(newestFast)].sort())
  assert.equal((await verifyBackup(compatible)).version, 2)
  assert.equal((await verifyBackup(newestFast)).version, 4)

  const one = resolveConfig({ maintenance: { backupKeep: 1 } })
  assert.equal((await runMaintenance({ store, config: one, now: NOW + 5000 })).pruned, 1)
  assert.deepEqual(readdirSync(join(root, 'backups')), [basename(newestFast)])
})

test('a recent packed knowledge backup does not postpone the daily compatible backup', async t => {
  const { root, store } = setup(t)
  seedSmallNotes(root)
  const fast = await createCompleteBackup(root, NOW, 'fast')
  assert.equal((await verifyBackup(fast)).version, 4)

  const config = resolveConfig({ maintenance: { backupKeep: 2 } })
  const result = await runMaintenance({ store, config, now: NOW + 1000 })
  assert.equal(result.backupError, null)
  assert.ok(result.backedUp)
  assert.equal((await verifyBackup(result.backedUp)).version, 2)
  assert.deepEqual(readdirSync(join(root, 'backups')).sort(), [basename(fast), basename(result.backedUp)].sort())
})
