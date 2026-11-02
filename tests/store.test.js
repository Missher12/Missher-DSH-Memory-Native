import assert from 'node:assert/strict'
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { MemoryStore, readJsonl } from '../host/store.js'

const NOW = 1_700_000_000_000
const KEY = 'DSH-Memory-abc'

function makeStore(root, clock = () => NOW) {
  return new MemoryStore({ root, clock }).open()
}

function tempRoot(t) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-memory-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

function writeFact(store, overrides = {}) {
  return store.write({
    kind: 'fact',
    scope: 'project',
    projectKey: KEY,
    content: '该仓库使用 pnpm 并要求 Node 22 以上',
    tags: ['pnpm'],
    confidence: 0.9,
    importance: 0.7,
    ...overrides,
  })
}

test('write persists a record that a fresh store loads', (t) => {
  const root = tempRoot(t)
  const store = makeStore(root)
  const written = writeFact(store)
  assert.equal(written.ok, true)

  const reopened = makeStore(root)
  const records = reopened.list('project', KEY)
  assert.equal(records.length, 1)
  assert.equal(records[0].id, written.record.id)
  assert.equal(records[0].content, '该仓库使用 pnpm 并要求 Node 22 以上')
})

test('update appends a revision and keeps only the latest', (t) => {
  const root = tempRoot(t)
  const store = makeStore(root)
  const written = writeFact(store)
  assert.equal(written.ok, true)

  const updated = store.update(written.record.id, { content: '该仓库使用 pnpm 并要求 Node 24 以上' }, [
    { scope: 'project', projectKey: KEY },
  ])
  assert.equal(updated.revision, 2)

  const reopened = makeStore(root)
  const records = reopened.list('project', KEY)
  assert.equal(records.length, 1)
  assert.equal(records[0].revision, 2)
  assert.equal(records[0].content, '该仓库使用 pnpm 并要求 Node 24 以上')

  const file = join(root, 'projects', KEY, 'memories.jsonl')
  assert.equal(readJsonl(file).lines, 2)
})

test('remove writes a tombstone that hides the record but survives reload', (t) => {
  const root = tempRoot(t)
  const store = makeStore(root)
  const written = writeFact(store)
  assert.equal(written.ok, true)

  const removed = store.remove(written.record.id, [{ scope: 'project', projectKey: KEY }])
  assert.equal(removed.status, 'deleted')
  assert.equal(removed.revision, 2)

  const reopened = makeStore(root)
  assert.equal(reopened.list('project', KEY).length, 0)
  assert.equal(reopened.list('project', KEY, { includeDeleted: true }).length, 1)
})

test('compact rewrites one line per record', (t) => {
  const root = tempRoot(t)
  const store = makeStore(root)
  const first = writeFact(store)
  const second = writeFact(store, { content: '选择 JSONL 作为权威存储' })
  assert.equal(first.ok && second.ok, true)
  store.update(first.record.id, { importance: 0.9 }, [{ scope: 'project', projectKey: KEY }])
  store.update(second.record.id, { importance: 0.8 }, [{ scope: 'project', projectKey: KEY }])

  const file = join(root, 'projects', KEY, 'memories.jsonl')
  assert.equal(readJsonl(file).lines, 4)

  const kept = store.compact('project', KEY)
  assert.equal(kept, 2)
  assert.equal(readJsonl(file).lines, 2)

  const reopened = makeStore(root)
  assert.equal(reopened.list('project', KEY).length, 2)
})

test('global scope lives under global/', (t) => {
  const root = tempRoot(t)
  const store = makeStore(root)
  const written = store.write({ kind: 'preference', scope: 'global', content: '用户偏好中文回复', confidence: 0.9 })
  assert.equal(written.ok, true)
  assert.ok(readFileSync(join(root, 'global', 'memories.jsonl'), 'utf8').includes('用户偏好中文回复'))
})

test('corrupt lines are skipped instead of breaking the store', (t) => {
  const root = tempRoot(t)
  const store = makeStore(root)
  assert.equal(writeFact(store).ok, true)
  const file = join(root, 'projects', KEY, 'memories.jsonl')
  appendFileSync(file, 'not json\n{"id":"broken"}\n')

  const reopened = makeStore(root)
  assert.equal(reopened.list('project', KEY).length, 1)
  const stats = reopened.stats()
  assert.equal(stats[0].corrupt, 2)
})

test('records and the global scope stay separated', (t) => {
  const root = tempRoot(t)
  const store = makeStore(root)
  assert.equal(writeFact(store).ok, true)
  assert.equal(store.write({ kind: 'preference', scope: 'global', content: '用户偏好中文回复', confidence: 0.9 }).ok, true)

  assert.equal(store.list('project', KEY).length, 1)
  assert.equal(store.list('global', null).length, 1)
})

test('two store instances on the same root keep both writes', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-memory-store-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const first = new MemoryStore({ root }).open()
  const second = new MemoryStore({ root }).open()
  const a = first.write({ kind: 'fact', scope: 'project', projectKey: KEY, content: '第一个写入实例的记录' })
  const b = second.write({ kind: 'fact', scope: 'project', projectKey: KEY, content: '第二个写入实例的记录' })
  assert.equal(a.ok, true)
  assert.equal(b.ok, true)
  const reloaded = new MemoryStore({ root }).open()
  assert.equal(reloaded.list('project', KEY).length, 2)
})

test('compaction re-reads before rewriting and keeps concurrent appends', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-memory-store-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const first = new MemoryStore({ root }).open()
  const second = new MemoryStore({ root }).open()
  first.write({ kind: 'fact', scope: 'project', projectKey: KEY, content: '压缩之前的记录内容' })
  second.write({ kind: 'fact', scope: 'project', projectKey: KEY, content: '并发追加的记录内容' })
  first.compact('project', KEY)
  const reloaded = new MemoryStore({ root }).open()
  const contents = reloaded.list('project', KEY).map((record) => record.content)
  assert.equal(contents.length, 2)
  assert.ok(contents.includes('并发追加的记录内容'))
})

test('opening a newer schema version is refused while older versions migrate', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-memory-store-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(join(root, 'meta.json'), JSON.stringify({ schemaVersion: 99 }))
  assert.throws(() => new MemoryStore({ root }).open(), /newer than supported/u)
  writeFileSync(join(root, 'meta.json'), JSON.stringify({ schemaVersion: 1 }))
  const migrated = new MemoryStore({ root }).open()
  const meta = JSON.parse(readFileSync(join(root, 'meta.json'), 'utf8'))
  assert.equal(meta.schemaVersion, 2)
  assert.equal(migrated.listAll().length, 0)
})

test('corrupt lines are quarantined to a diagnostic file', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-memory-store-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const store = new MemoryStore({ root }).open()
  const file = join(root, 'projects', KEY, 'memories.jsonl')
  store.write({ kind: 'fact', scope: 'project', projectKey: KEY, content: '正常记录用于隔离测试' })
  appendFileSync(file, 'this is not json\n')
  const reloaded = new MemoryStore({ root }).open()
  assert.equal(reloaded.list('project', KEY).length, 1)
  const quarantine = join(root, 'corrupt-lines.jsonl')
  assert.ok(existsSync(quarantine))
  assert.match(readFileSync(quarantine, 'utf8'), /this is not json/u)
})

test('export, backup and import round-trip', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-memory-store-'))
  const target = mkdtempSync(join(tmpdir(), 'dsh-memory-store-'))
  t.after(() => {
    rmSync(root, { recursive: true, force: true })
    rmSync(target, { recursive: true, force: true })
  })
  const store = new MemoryStore({ root }).open()
  store.write({ kind: 'preference', scope: 'global', projectKey: null, content: '用户偏好导出导入测试' })
  store.write({ kind: 'fact', scope: 'project', projectKey: KEY, content: '项目事实用于导出测试' })
  const exported = store.exportData()
  assert.equal(exported.global.length, 1)
  assert.equal(exported.projects[KEY].length, 1)

  const backupPath = store.backup()
  assert.ok(existsSync(backupPath))
  assert.ok(JSON.parse(readFileSync(backupPath, 'utf8')).projects[KEY].length === 1)

  const targetStore = new MemoryStore({ root: target }).open()
  const dry = targetStore.importData(exported, { dryRun: true })
  assert.equal(dry.imported, 2)
  assert.equal(targetStore.listAll().length, 0)
  const applied = targetStore.importData(exported)
  assert.equal(applied.imported, 2)
  assert.equal(targetStore.listAll().length, 2)
  const again = targetStore.importData(exported)
  assert.equal(again.imported, 0)
  assert.equal(again.skipped, 2)
})
