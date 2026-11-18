import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { exportToObsidian } from '../host/obsidian.js'
import { createRecallReportStore } from '../host/recall-reports.js'
import { createPanelBackend } from '../host/remote.js'
import { MemoryStore } from '../host/store.js'

const PROFILE = 'a'.repeat(64)
const PROJECT = 'b'.repeat(64)
const SOURCE_A = 'src_0123456789abcdef01234567'
const SOURCE_B = 'src_abcdef0123456789abcdef01'

function report(query, id, sourceId, outcome = 'completed') {
  return {
    at: 10, projectKey: PROJECT, turnKey: `id:${query}`, outcome, total: 1,
    questions: [{ query, hits: [{ id, revision: 1, sourceRefs: [{ sourceId, excerpt: `原文 ${query}` }] }],
      injected: [{ id, revision: 1, sourceRefs: [{ sourceId, excerpt: `原文 ${query}` }], text: `注入 ${query}` }],
      notInjected: [], answerCoverage: 'covered', answerExcerpt: `答案 ${query}` }],
  }
}

function rootFor(t) {
  const root = fs.mkdtempSync(join(tmpdir(), 'memory-recall-reports-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

test('per-session report writes are private, replace atomically, and reject pending reports', t => {
  const root = rootFor(t)
  const store = createRecallReportStore(root, PROFILE)
  const first = report('alpha', 'mem_alpha', SOURCE_A)
  store.write('private-session-a', PROJECT, first)
  const reportsDir = join(root, 'recall-reports')
  const files = fs.readdirSync(reportsDir)
  assert.equal(files.length, 1)
  assert.equal(files.some(name => name.includes('private-session-a')), false)
  assert.equal(fs.statSync(reportsDir).mode & 0o777, 0o700)
  assert.equal(fs.statSync(join(reportsDir, files[0])).mode & 0o777, 0o600)
  assert.deepEqual(store.get('private-session-a', PROJECT), first)
  assert.equal(store.get('private-session-a', 'c'.repeat(64)), null)
  assert.equal(createRecallReportStore(root, 'd'.repeat(64)).get('private-session-a', PROJECT), null)

  const write = fs.writeSync
  let injected = 0
  fs.writeSync = (fd, data, ...args) => {
    if (String(data).includes('replacement')) {
      injected++
      throw Object.assign(new Error('simulated interrupted report replacement'), { code: 'EIO' })
    }
    return write(fd, data, ...args)
  }
  syncBuiltinESMExports()
  try {
    assert.throws(() => store.write('private-session-a', PROJECT, report('replacement', 'mem_replacement', SOURCE_A)), /interrupted/u)
  } finally {
    fs.writeSync = write
    syncBuiltinESMExports()
  }
  assert.equal(injected, 1)
  assert.deepEqual(store.get('private-session-a', PROJECT), first)
  assert.throws(() => store.write('private-session-a', PROJECT, { ...first, outcome: 'pending' }), /finalized/u)
  assert.deepEqual(createRecallReportStore(root, PROFILE).get('private-session-a', PROJECT), first)
})

test('forget tombstones references, removes only affected reports, and blocks late writes after restart', t => {
  const root = rootFor(t)
  const store = createRecallReportStore(root, PROFILE)
  store.write('session-a', PROJECT, report('alpha', 'mem_alpha', SOURCE_A))
  store.write('session-b', PROJECT, report('beta', 'mem_beta', SOURCE_B))
  store.write('session-c', PROJECT, report('gamma', 'mem_gamma', SOURCE_A))

  store.invalidateReferences({ recordIds: ['mem_alpha'] })
  assert.equal(store.get('session-a', PROJECT), null)
  assert.ok(store.get('session-b', PROJECT))
  assert.ok(store.get('session-c', PROJECT))
  assert.equal(store.write('session-a', PROJECT, report('late alpha', 'mem_alpha', SOURCE_A)), false)
  assert.equal(createRecallReportStore(root, PROFILE).get('session-a', PROJECT), null)

  store.invalidateReferences({ sourceIds: [SOURCE_A] })
  assert.equal(store.get('session-c', PROJECT), null)
  assert.ok(store.get('session-b', PROJECT))
})

test('cached reports in another instance and leftover files obey the persisted forget ledger', t => {
  const root = rootFor(t)
  const writer = createRecallReportStore(root, PROFILE)
  const reader = createRecallReportStore(root, PROFILE)
  const oldReport = report('source fact', 'mem_source', SOURCE_A)
  writer.write('session-stale', PROJECT, oldReport)
  assert.deepEqual(reader.get('session-stale', PROJECT), oldReport)

  writer.invalidateReferences({ sourceIds: [SOURCE_A] })
  assert.equal(reader.get('session-stale', PROJECT), null, 'a changed ledger invalidates another instance cache')

  const key = createHash('sha256').update('session-stale').digest('hex')
  fs.writeFileSync(join(root, 'recall-reports', `${key}.json`), JSON.stringify({
    version: 1, sessionKey: key, profileIdentity: PROFILE, projectKey: PROJECT, report: oldReport,
  }), { mode: 0o600 })
  assert.equal(createRecallReportStore(root, PROFILE).get('session-stale', PROJECT), null,
    'a report left behind after a crash cannot override a persisted forget')
})

test('missing and corrupt report reads are memoized, and uncertain files are removed on forget', t => {
  const root = rootFor(t)
  const store = createRecallReportStore(root, PROFILE)
  const originalRead = fs.readFileSync
  let reads = 0
  fs.readFileSync = (...args) => { reads++; return originalRead(...args) }
  syncBuiltinESMExports()
  try {
    assert.equal(store.get('missing-session', PROJECT), null)
    assert.equal(store.get('missing-session', PROJECT), null)
    assert.equal(reads, 1)
  } finally {
    fs.readFileSync = originalRead
    syncBuiltinESMExports()
  }

  store.write('corrupt-session', PROJECT, report('corrupt', 'mem_corrupt', SOURCE_A))
  const file = join(root, 'recall-reports', fs.readdirSync(join(root, 'recall-reports')).find(name => name.endsWith('.json')))
  fs.writeFileSync(file, '{broken', { mode: 0o600 })
  const reader = createRecallReportStore(root, PROFILE)
  assert.equal(reader.get('corrupt-session', PROJECT), null)
  assert.equal(reader.get('corrupt-session', PROJECT), null)
  reader.invalidateReferences({ recordIds: ['mem_corrupt'] })
  assert.equal(fs.existsSync(file), false)

  const key = createHash('sha256').update('malformed-session').digest('hex')
  fs.writeFileSync(join(root, 'recall-reports', `${key}.json`), JSON.stringify({
    version: 1, sessionKey: key, profileIdentity: PROFILE, projectKey: PROJECT,
    report: { ...report('malformed', 'mem_malformed', SOURCE_A), questions: [{
      query: 'malformed', hits: {}, injected: [null], notInjected: [], answerCoverage: 'covered', answerExcerpt: null,
    }] },
  }), { mode: 0o600 })
  assert.equal(createRecallReportStore(root, PROFILE).get('malformed-session', PROJECT), null)
})

test('session reports stay out of JSON export, Obsidian export, and complete backups', async t => {
  const root = rootFor(t)
  const memories = new MemoryStore({ root }).open()
  memories.write({ id: 'mem_export_fixture', kind: 'fact', scope: 'project', projectKey: PROJECT,
    content: '日常记忆内容保留在现有迁移路径。', confidence: .9 })
  const marker = 'session-only report question 7d5a'
  createRecallReportStore(root, PROFILE).write('export-session', PROJECT, report(marker, 'mem_export_fixture', SOURCE_A))

  assert.doesNotMatch(JSON.stringify(memories.exportData()), /session-only report question/u)
  const vault = join(root, 'vault')
  fs.mkdirSync(vault, { recursive: true })
  const obsidian = exportToObsidian({ store: memories, vaultPath: vault, folder: 'DSH Memory' })
  const notes = fs.readdirSync(obsidian.dir).filter(name => name.endsWith('.md'))
    .map(name => fs.readFileSync(join(obsidian.dir, name), 'utf8')).join('\n')
  assert.doesNotMatch(notes, /session-only report question/u)

  const backup = await memories.backup()
  const manifest = JSON.parse(fs.readFileSync(join(backup, 'manifest.json'), 'utf8'))
  assert.equal(manifest.files.some(file => file.path.startsWith('recall-reports/')), false)
  const backupText = manifest.files.map(file => fs.readFileSync(join(backup, 'files', file.path), 'utf8')).join('\n')
  assert.doesNotMatch(backupText, /session-only report question/u)
})

test('bulk deletion invalidates reports tied to the revoked source and leaves other sources readable cold', t => {
  const root = rootFor(t)
  const memories = new MemoryStore({ root }).open()
  const reports = createRecallReportStore(root, PROFILE)
  for (const [id, sourceId] of [['mem_delete_a', SOURCE_A], ['mem_same_source', SOURCE_A], ['mem_unrelated', SOURCE_B]]) {
    memories.write({ id, kind: 'fact', scope: 'project', projectKey: PROJECT, sourceRefs: [{ sourceId }], content: `证据 ${id}`, confidence: .9 })
  }
  reports.write('session-a', PROJECT, report('alpha', 'mem_delete_a', SOURCE_A))
  reports.write('session-same-source', PROJECT, report('same source', 'mem_same_source', SOURCE_A))
  reports.write('session-b', PROJECT, report('beta', 'mem_unrelated', SOURCE_B))
  memories.setLifecycle({ onRecallRevoke: targets => reports.invalidateReferences(targets) })
  const backend = createPanelBackend({ root, store: memories, index: { upsert() {}, remove() {} }, config: {} })

  const result = backend.bulkAction({ action: 'delete', ids: ['mem_delete_a'], scope: 'project', projectKey: PROJECT })
  assert.deepEqual(result.updated, ['mem_delete_a'])
  const cold = createRecallReportStore(root, PROFILE)
  assert.equal(cold.get('session-a', PROJECT), null)
  assert.equal(cold.get('session-same-source', PROJECT), null)
  assert.ok(cold.get('session-b', PROJECT))
})

test('a rolled-back batch keeps report revocation when the source barrier remains in effect', t => {
  const root = rootFor(t)
  const memories = new MemoryStore({ root }).open()
  const reports = createRecallReportStore(root, PROFILE)
  memories.write({ id: 'mem_rollback', kind: 'fact', scope: 'project', projectKey: PROJECT,
    sourceRefs: [{ sourceId: SOURCE_A }], content: '可恢复的记忆事实。', confidence: .9 })
  reports.write('session-rollback', PROJECT, report('rollback', 'mem_rollback', SOURCE_A))
  memories.setLifecycle({ onRecallRevoke: targets => reports.invalidateReferences(targets) })
  const backend = createPanelBackend({ root, store: memories, index: { upsert() {}, remove() {} }, config: {} })

  const result = backend.bulkAction({ action: 'delete', ids: ['mem_rollback', 'missing'], scope: 'project', projectKey: PROJECT })
  assert.equal(result.rolledBack, true)
  assert.equal(memories.find('mem_rollback', [{ scope: 'project', projectKey: PROJECT }]).status, 'active')
  assert.equal(createRecallReportStore(root, PROFILE).get('session-rollback', PROJECT), null)
})

test('permanent deletion removes a stale same-source report file before cold reads', t => {
  const root = rootFor(t)
  const memories = new MemoryStore({ root }).open()
  const reports = createRecallReportStore(root, PROFILE)
  memories.write({ id: 'mem_purge', kind: 'fact', scope: 'project', projectKey: PROJECT,
    sourceRefs: [{ sourceId: SOURCE_A }], content: '待永久删除的派生证据。', confidence: .9 })
  const lastReport = report('purge source', 'mem_purge', SOURCE_A)
  reports.write('session-purge', PROJECT, lastReport)
  memories.setLifecycle({ onRecallRevoke: targets => reports.invalidateReferences(targets) })
  const backend = createPanelBackend({ root, store: memories, index: { upsert() {}, remove() {} }, config: {},
    invalidateRecallReferences: targets => reports.invalidateReferences(targets) })
  backend.removeMemory({ id: 'mem_purge', scope: 'project', projectKey: PROJECT })

  const key = createHash('sha256').update('session-purge').digest('hex')
  const file = join(root, 'recall-reports', `${key}.json`)
  fs.writeFileSync(file, JSON.stringify({ version: 1, sessionKey: key, profileIdentity: PROFILE, projectKey: PROJECT, report: lastReport }), { mode: 0o600 })
  assert.equal(memories.find('mem_purge', [{ scope: 'project', projectKey: PROJECT }]).status, 'deleted')
  assert.equal(backend.purgeMemory({ id: 'mem_purge', scope: 'project', projectKey: PROJECT }).purged, true)
  assert.equal(fs.existsSync(file), false)
  assert.equal(createRecallReportStore(root, PROFILE).get('session-purge', PROJECT), null)
})

test('editing a recoverable record retires its old report revision but permits the new revision', t => {
  const root = rootFor(t)
  const memories = new MemoryStore({ root }).open()
  const reports = createRecallReportStore(root, PROFILE)
  const record = memories.write({ id: 'mem_editable', kind: 'fact', scope: 'project', projectKey: PROJECT,
    content: '第一版手写事实。', confidence: .9 }).record
  const makeReport = (revision, content) => ({ at: 10, projectKey: PROJECT, turnKey: `rev:${revision}`, outcome: 'completed', total: 1,
    questions: [{ query: `版本 ${revision}`, hits: [{ id: record.id, revision, sourceRefs: [] }],
      injected: [{ id: record.id, revision, sourceRefs: [], text: content }], notInjected: [],
      answerCoverage: 'covered', answerExcerpt: content }] })
  const oldReport = makeReport(record.revision, record.content)
  reports.write('session-editable', PROJECT, oldReport)
  const sessionKey = createHash('sha256').update('session-editable').digest('hex')
  const reportFile = join(root, 'recall-reports', `${sessionKey}.json`)
  const oldFile = fs.readFileSync(reportFile)
  memories.setLifecycle({ onRecallRevoke: targets => reports.invalidateReferences(targets) })

  const updated = memories.update(record.id, { content: '第二版手写事实。' }, [{ scope: 'project', projectKey: PROJECT }])
  assert.equal(updated.revision, 2)
  assert.equal(reports.get('session-editable', PROJECT), null)
  fs.writeFileSync(reportFile, oldFile, { mode: 0o600 })
  const cold = createRecallReportStore(root, PROFILE)
  assert.equal(cold.get('session-editable', PROJECT), null)
  assert.equal(cold.write('session-editable', PROJECT, oldReport), false)
  const currentReport = makeReport(updated.revision, updated.content)
  assert.equal(reports.write('session-editable', PROJECT, currentReport), true)
  assert.deepEqual(createRecallReportStore(root, PROFILE).get('session-editable', PROJECT), currentReport)
  const deleted = memories.remove(record.id, [{ scope: 'project', projectKey: PROJECT }])
  assert.equal(deleted.revision, 3)
  assert.equal(reports.get('session-editable', PROJECT), null)
  const restored = memories.update(record.id, { status: 'active' }, [{ scope: 'project', projectKey: PROJECT }])
  assert.equal(restored.revision, 4)
  assert.equal(reports.write('session-editable', PROJECT, makeReport(restored.revision, restored.content)), true)

  const sourced = memories.write({ id: 'mem_source_edit', kind: 'fact', scope: 'project', projectKey: PROJECT,
    sourceRefs: [{ sourceId: SOURCE_B }], content: '旧来源证据。', confidence: .9 }).record
  reports.write('session-source-edit', PROJECT, report('source edit', sourced.id, SOURCE_B))
  const sourcedUpdate = memories.update(sourced.id, { content: '新正文仍携带旧来源字段。' }, [{ scope: 'project', projectKey: PROJECT }])
  const staleSourceReport = report('stale source edit', sourced.id, SOURCE_B)
  const revise = question => ({ ...question,
    hits: question.hits.map(item => ({ ...item, revision: sourcedUpdate.revision })),
    injected: question.injected.map(item => ({ ...item, revision: sourcedUpdate.revision })),
    notInjected: question.notInjected.map(item => ({ ...item, revision: sourcedUpdate.revision })) })
  assert.equal(reports.get('session-source-edit', PROJECT), null)
  assert.equal(reports.write('session-source-edit', PROJECT, { ...staleSourceReport, questions: staleSourceReport.questions.map(revise) }), false)
})
