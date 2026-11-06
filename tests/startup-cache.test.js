import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { apply } from '../index.js'
import { MemoryStore } from '../host/store.js'

function context() {
  const handlers = {}
  return { handlers, ctx: {
    get() {}, on(name, handler) { handlers[name] = handler }, effect() {},
    logger: { info() {}, warn() {} },
  } }
}

test('normal activation creates a reusable derived cache beside the authority', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-memory-cache-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const store = new MemoryStore({ root }).open()
  assert.ok(store.write({ scope: 'global', kind: 'fact', content: '持久测试选择中文输出', confidence: 0.9 }).ok)
  const { ctx, handlers } = context()
  apply(ctx, { dataDir: root })
  assert.equal(typeof handlers['agent/pre-step'], 'function')
  assert.equal(existsSync(join(root, 'derived-index-v1.bin')), true)
  await new Promise(resolve => setTimeout(resolve, 20))
})

import { readFileSync, renameSync, statSync, utimesSync, writeFileSync, unlinkSync } from 'node:fs'
import { openMemoryRuntime } from '../host/startup.js'
import { MemoryIndex } from '../host/search.js'
import { buildRecord } from '../host/records.js'
import { computeProfile, knowledgeGraph } from '../host/remote-contract.js'
import { createPanelBackend } from '../host/remote.js'
import { deriveProfile } from '../host/profile.js'

const fixedNow = 1_750_000_000_000
const scopeA = [{ scope: 'project', projectKey: 'project-a' }]
const scopeB = [{ scope: 'project', projectKey: 'project-b' }]
const globalScope = [{ scope: 'global', projectKey: null }]

function createFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-memory-cache-behavior-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const store = new MemoryStore({ root, clock: () => fixedNow }).open()
  for (const input of [
    { id: 'a', scope: 'project', projectKey: 'project-a', content: 'ALPHA old 项目使用中文检索', kind: 'fact' },
    { id: 'b', scope: 'project', projectKey: 'project-b', content: '项目使用中文检索 secretB', kind: 'fact' },
    { id: 'g', scope: 'global', content: '用户偏好中文检索时保留原文', kind: 'preference' },
  ]) {
    const { id, ...rest } = input
    assert.ok(store.write({ ...rest, confidence: 0.9, tags: ['中文'] }, { id }).ok)
  }
  return root
}

const search = (runtime, query, projectKey = 'project-a') => runtime.index.searchPage(query, {
  projectKey, now: fixedNow, limit: 10, offset: 0,
})

test('fresh cache restores full records, profile, scoring and project isolation', (t) => {
  const root = createFixture(t)
  const first = openMemoryRuntime({ root, clock: () => fixedNow })
  assert.equal(first.metrics.cacheHit, false)
  const reference = new MemoryIndex().rebuild(new MemoryStore({ root }).open().listAll())
  first.dispose()
  const reopened = openMemoryRuntime({ root, clock: () => fixedNow })
  t.after(() => reopened.dispose())
  assert.equal(reopened.metrics.cacheHit, true)
  for (const query of ['中文 检索', 'ALPHA old', 'secretB', 'missing']) {
    const options = { projectKey: 'project-a', now: fixedNow, limit: 10, offset: 0 }
    assert.deepEqual(reopened.index.searchPage(query, options), reference.searchPage(query, options))
  }
  assert.deepEqual(search(reopened, 'secretB').hits, [])
  assert.equal(search(reopened, 'secretB', 'project-b').hits[0].record.id, 'b')
  assert.match(reopened.profile(2, fixedNow).traits[0].statement, /保留原文/u)
  assert.deepEqual(reopened.store.find('a', scopeA), new MemoryStore({ root }).open().find('a', scopeA))
})

test('writes, replacement, deletion, import and purge refresh the cache automatically', async (t) => {
  const root = createFixture(t)
  const runtime = openMemoryRuntime({ root, clock: () => fixedNow })
  t.after(() => runtime.dispose())
  runtime.store.update('a', { content: 'OMEGA new 项目改用稳定检索' }, scopeA)
  assert.equal(search(runtime, 'ALPHA').hits.length, 0)
  assert.equal(search(runtime, 'OMEGA').hits[0].record.id, 'a')
  runtime.store.remove('g', globalScope)
  assert.equal(search(runtime, '保留原文').hits.some((hit) => hit.record.id === 'g'), false)
  assert.equal(runtime.profile(2, fixedNow).total, 0)
  const replacement = buildRecord({ scope: 'project', projectKey: 'project-a', kind: 'fact',
    content: '新的替换记录提供 ZETA 功能', confidence: 0.9 }, { id: 'replacement', now: fixedNow })
  assert.ok(replacement.ok)
  runtime.store.replace('a', replacement.record)
  assert.equal(search(runtime, 'OMEGA').hits.length, 0)
  assert.equal(search(runtime, 'ZETA').hits[0].record.id, 'replacement')
  const imported = buildRecord({ scope: 'project', projectKey: 'project-b', kind: 'fact',
    content: '项目乙导入的 SIGMA 记录', confidence: 0.9 }, { id: 'imported', now: fixedNow })
  assert.ok(imported.ok)
  assert.equal(runtime.store.importData({ projects: { 'project-b': [imported.record] } }).imported, 1)
  assert.equal(search(runtime, 'SIGMA').hits.length, 0)
  assert.equal(search(runtime, 'SIGMA', 'project-b').hits[0].record.id, 'imported')
  assert.equal(runtime.store.purge('b', scopeB), true)
  assert.equal(existsSync(join(root, 'derived-index-v1.bin')), false, 'purge invalidates the copy containing that record immediately')
  await new Promise(resolve => setTimeout(resolve, 450))
  const reopened = openMemoryRuntime({ root, clock: () => fixedNow })
  t.after(() => reopened.dispose())
  assert.equal(reopened.metrics.cacheHit, true)
  assert.equal(reopened.store.find('a', scopeA).status, 'superseded')
  assert.equal(reopened.store.find('g', globalScope).status, 'deleted')
  assert.equal(reopened.store.find('b', scopeB), undefined)
  assert.equal(search(reopened, 'ZETA').hits[0].record.id, 'replacement')
  assert.equal(search(reopened, 'SIGMA', 'project-b').hits[0].record.id, 'imported')
  assert.ok(reopened.store.history('a', scopeA).length >= 2)
})

test('corrupt or missing cache and same-size external rewrites recover from the authority', (t) => {
  const root = createFixture(t)
  const live = openMemoryRuntime({ root, clock: () => fixedNow })
  t.after(() => live.dispose())
  const file = join(root, 'projects', 'project-a', 'memories.jsonl')
  const originalStat = statSync(file)
  const original = readFileSync(file, 'utf8')
  const changed = original.replace('ALPHA old', 'OMEGA new')
  assert.equal(Buffer.byteLength(original), Buffer.byteLength(changed))
  writeFileSync(file, changed)
  utimesSync(file, originalStat.atime, originalStat.mtime)
  assert.equal(live.synchronize(), true)
  assert.equal(search(live, 'ALPHA').hits.length, 0)
  assert.equal(search(live, 'OMEGA').hits[0].record.id, 'a')
  live.dispose()
  let rebuilt = openMemoryRuntime({ root, clock: () => fixedNow })
  assert.equal(rebuilt.metrics.cacheHit, false)
  assert.equal(search(rebuilt, 'OMEGA').hits[0].record.id, 'a')
  rebuilt.dispose()
  const cache = join(root, 'derived-index-v1.bin')
  const bytes = readFileSync(cache)
  bytes[bytes.length - 1] ^= 0xff
  writeFileSync(cache, bytes)
  rebuilt = openMemoryRuntime({ root, clock: () => fixedNow })
  assert.equal(rebuilt.metrics.cacheHit, false)
  assert.equal(search(rebuilt, 'OMEGA').hits[0].record.id, 'a')
  rebuilt.dispose()
  unlinkSync(cache)
  rebuilt = openMemoryRuntime({ root, clock: () => fixedNow })
  assert.equal(rebuilt.metrics.cacheHit, false)
  assert.equal(search(rebuilt, 'OMEGA').hits[0].record.id, 'a')
  rebuilt.dispose()
})

test('cached search preserves large term frequencies accepted by the authority', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-memory-cache-long-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const dir = join(root, 'global')
  mkdirSync(dir, { recursive: true })
  const record = { id: 'large', kind: 'fact', status: 'active', revision: 1, scope: 'global', projectKey: null,
    content: 'alpha '.repeat(70_000), updatedAt: fixedNow }
  writeFileSync(join(dir, 'memories.jsonl'), `${JSON.stringify(record)}\n`)
  const first = openMemoryRuntime({ root, clock: () => fixedNow })
  const expected = first.index.search('alpha', { now: fixedNow })[0]
  first.dispose()
  const reopened = openMemoryRuntime({ root, clock: () => fixedNow })
  t.after(() => reopened.dispose())
  assert.equal(reopened.metrics.cacheHit, true)
  const actual = reopened.index.search('alpha', { now: fixedNow })[0]
  assert.equal(actual.score, expected.score)
  assert.deepEqual(actual.termScores, expected.termScores)
  assert.equal(actual.record.content, record.content)
})

test('cached profile and all-scope graph match the original panel computations', (t) => {
  const root = createFixture(t)
  const runtime = openMemoryRuntime({ root, clock: () => fixedNow })
  t.after(() => runtime.dispose())
  const config = { capture: { enabled: false }, inject: { enabled: true }, obsidian: { vaultPath: null } }
  const normal = { store: runtime.store, index: runtime.index, root, config }
  const cached = { ...normal, getProfile: runtime.profile, getGraphRecords: runtime.graph }
  const originalNow = Date.now
  Date.now = () => fixedNow
  try {
    assert.deepEqual(computeProfile(cached, { limit: 3 }), computeProfile(normal, { limit: 3 }))
    assert.deepEqual(knowledgeGraph(cached, { scope: 'all' }), knowledgeGraph(normal, { scope: 'all' }))
  } finally {
    Date.now = originalNow
  }
})

test('panel writes keep a regenerated cache consistent with its shared index', async (t) => {
  const root = createFixture(t)
  const runtime = openMemoryRuntime({ root, clock: () => fixedNow })
  t.after(() => runtime.dispose())
  const backend = createPanelBackend({ store: runtime.store, index: runtime.index, root,
    config: {}, synchronize: runtime.synchronize, getProfile: runtime.profile, getGraphRecords: runtime.graph })
  backend.update({ id: 'a', scope: 'project', projectKey: 'project-a', patch: { content: '面板更新的专用 DELTA 项目事实' } })
  backend.removeMemory({ id: 'g', scope: 'global' })
  assert.equal(search(runtime, 'DELTA').hits[0].record.id, 'a')
  assert.equal(search(runtime, '保留原文').hits.some((hit) => hit.record.id === 'g'), false)
  await new Promise(resolve => setTimeout(resolve, 450))
  const reopened = openMemoryRuntime({ root, clock: () => fixedNow })
  t.after(() => reopened.dispose())
  assert.equal(reopened.metrics.cacheHit, true)
  assert.equal(search(reopened, 'DELTA').hits[0].record.id, 'a')
  assert.equal(reopened.store.find('g', globalScope).status, 'deleted')
})

test('external project creation and authority-file removal are reflected while running', (t) => {
  const root = createFixture(t)
  const runtime = openMemoryRuntime({ root, clock: () => fixedNow })
  t.after(() => runtime.dispose())
  const other = new MemoryStore({ root, clock: () => fixedNow }).open()
  assert.ok(other.write({ scope: 'project', projectKey: 'project-c', kind: 'fact',
    content: '第三项目使用 THETA 编号', confidence: 0.9 }, { id: 'c' }).ok)
  assert.equal(runtime.synchronize(), true)
  assert.equal(search(runtime, 'THETA', 'project-c').hits[0].record.id, 'c')
  assert.equal(search(runtime, 'THETA', 'project-a').hits.length, 0)
  unlinkSync(join(root, 'projects', 'project-b', 'memories.jsonl'))
  assert.equal(runtime.synchronize(), true)
  assert.equal(search(runtime, 'secretB', 'project-b').hits.length, 0)
})

test('a future-dated preference is re-ranked when a cached store is reopened later', (t) => {
  const root = createFixture(t)
  let now = fixedNow
  const store = new MemoryStore({ root, clock: () => now }).open()
  const original = store.find('g', globalScope)
  store.append({ ...original, revision: original.revision + 1, updatedAt: fixedNow + 50_000 })
  const first = openMemoryRuntime({ root, clock: () => now })
  first.dispose()
  now += 100_000
  const reopened = openMemoryRuntime({ root, clock: () => now })
  t.after(() => reopened.dispose())
  assert.equal(reopened.metrics.cacheHit, true)
  assert.deepEqual(reopened.profile(10, now), deriveProfile(reopened.store.listAll(), { now, limit: 10 }))
})

test('a temporary filesystem error during scheduled cache refresh does not escape the timer', async (t) => {
  const root = createFixture(t)
  const runtime = openMemoryRuntime({ root, clock: () => fixedNow })
  t.after(() => runtime.dispose())
  runtime.store.update('a', { content: '临时错误后的 KAPPA 记录' }, scopeA)
  const projects = join(root, 'projects'), moved = join(root, 'projects-moved')
  renameSync(projects, moved)
  writeFileSync(projects, 'temporarily not a directory')
  await new Promise(resolve => setTimeout(resolve, 400))
  unlinkSync(projects)
  renameSync(moved, projects)
  assert.equal(search(runtime, 'KAPPA').hits[0].record.id, 'a')
})
