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

import { appendFileSync, readFileSync, renameSync, statSync, utimesSync, writeFileSync, unlinkSync } from 'node:fs'
import { openMemoryRuntime } from '../host/startup.js'
import { MemoryIndex } from '../host/search.js'
import { buildRecord } from '../host/records.js'
import { computeActivity, computeProfile, computeStats, knowledgeGraph } from '../host/remote-contract.js'
import { createPanelBackend } from '../host/remote.js'
import { deriveProfile } from '../host/profile.js'
import { packRecords } from '../host/cache-records.js'
import { packCache, unpackCache } from '../host/cache-binary.js'

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

function storedCache(root) {
  const cache = readFileSync(join(root, 'derived-index-v1.bin'))
  const payloadOffset = Math.ceil((4 + cache.readUInt32BE(0)) / 8) * 8
  return unpackCache(cache.subarray(payloadOffset))
}

test('fresh cache restores full records, profile, scoring and project isolation', (t) => {
  const root = createFixture(t)
  const first = openMemoryRuntime({ root, clock: () => fixedNow })
  assert.equal(first.metrics.cacheHit, false)
  const packed = storedCache(root).index
  assert.ok(packed.docs.freqs instanceof Uint8Array)
  assert.ok(packed.postings.slots instanceof Uint8Array)
  assert.ok(packed.postings.freqs instanceof Uint8Array)
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

test('cache scopes without aggregates can be updated before first stats and aggregates stay out of the cache', (t) => {
  const root = createFixture(t)
  const initial = openMemoryRuntime({ root, clock: () => fixedNow })
  initial.dispose()
  const runtime = openMemoryRuntime({ root, clock: () => fixedNow })
  t.after(() => runtime.dispose())
  assert.equal(runtime.metrics.cacheHit, true)
  assert.equal(runtime.store.snapshot().get('project:project-a').aggregate, null)

  runtime.store.update('a', { content: 'OMEGA cached update before statistics' }, scopeA)
  assert.ok(runtime.store.write({ kind: 'fact', scope: 'project', projectKey: 'project-a', confidence: .9,
    content: 'Added before the first aggregate is built.' }, { id: 'added-before-stats', now: fixedNow }).ok)
  const backend = createPanelBackend({ store: runtime.store, index: runtime.index, config: {}, root })
  const stats = computeStats(backend, { scope: 'project', projectKey: 'project-a' })
  assert.equal(stats.total, 4)
  assert.equal(stats.active, 4)
  assert.equal(computeActivity(backend, { scope: 'project', projectKey: 'project-a', days: 730 }).total, 2)

  const packed = packRecords(runtime.store.snapshot(), runtime.index.snapshot(), runtime.graph())
  assert.ok(packed.scopes.every(([, state]) => !Object.hasOwn(state, 'aggregate')))
})

test('packed postings pick a wider array before a value would overflow', (t) => {
  const root = createFixture(t)
  const runtime = openMemoryRuntime({ root, clock: () => fixedNow })
  t.after(() => runtime.dispose())
  const packed = storedCache(root)
  const values = Uint32Array.of(0, 255, 256, 65535, 65536, 100000)
  const cases = [
    { sample: values.subarray(0, 2), type: Uint8Array },
    { sample: values.subarray(0, 4), type: Uint16Array },
    { sample: values, type: Uint32Array },
  ]
  for (const { sample, type } of cases) {
    const postings = { ...packed.index.postings, slots: sample, freqs: sample }
    const decoded = unpackCache(packCache({ ...packed, index: { ...packed.index, postings } })).index.postings
    assert.deepEqual(decoded.slots, type.from(sample))
    assert.deepEqual(decoded.freqs, type.from(sample))
  }
})

test('packed dates and index lookups preserve complete values and slot ownership', (t) => {
  const root = createFixture(t)
  const store = new MemoryStore({ root }).open()
  for (let i = 0; i < 24; i++) {
    assert.ok(store.write({
      scope: 'project', projectKey: 'project-a', kind: 'fact', confidence: 0.9,
      content: `Archived experiment record ${i}`, validFrom: i % 2 === 0 ? fixedNow - i : null,
    }, { id: `date-${i}`, now: fixedNow + i + 1 }).ok)
  }
  const runtime = openMemoryRuntime({ root, clock: () => fixedNow })
  t.after(() => runtime.dispose())
  const checkpoint = storedCache(root)
  const dateValues = checkpoint.records.columns.find(column => column.values.includes(fixedNow + 24))?.values
  assert.ok(dateValues instanceof Float64Array)
  assert.ok(dateValues.includes(fixedNow + 1))
  const validFrom = checkpoint.records.columns.find(column => column.values.includes(fixedNow - 22))?.values
  assert.ok(Array.isArray(validFrom))
  assert.ok(validFrom.includes(null))

  // Old stores can contain the same ID in more than one slot. Preserve the
  // lookup after removal even if an earlier occurrence is still in the index.
  const a = runtime.store.find('a', scopeA)
  const b = runtime.store.find('b', scopeB)
  const index = new MemoryIndex().rebuild([a, a, b])
  assert.ok(index.remove(a.id))
  const packed = packRecords(runtime.store.snapshot(), index.snapshot(), runtime.graph())
  const decoded = unpackCache(packCache({ ...packed, profile: checkpoint.profile }))
  assert.deepEqual(decoded.index.slotById, packed.index.slotById)
  assert.deepEqual(decoded.index.termIds, packed.index.termIds)
  assert.deepEqual(decoded.index.slots, packed.index.slots)
  assert.equal(decoded.index.slotById.has(a.id), false)

  const reopened = openMemoryRuntime({ root, clock: () => fixedNow })
  t.after(() => reopened.dispose())
  assert.equal(reopened.metrics.cacheHit, true)
  assert.deepEqual(reopened.store.find('date-23', scopeA), store.find('date-23', scopeA))
})

test('write callbacks keep the index current without enumerating the whole library for views', (t) => {
  const root = createFixture(t)
  const runtime = openMemoryRuntime({ root, clock: () => fixedNow })
  t.after(() => runtime.dispose())
  let listCalls = 0
  const listAll = runtime.store.listAll.bind(runtime.store)
  runtime.store.listAll = (...args) => { listCalls++; return listAll(...args) }

  const replacement = buildRecord({ scope: 'project', projectKey: 'project-a', kind: 'fact',
    content: '新的替换记录提供 ZETA 功能', confidence: .9 }, { now: fixedNow, id: 'replacement' })
  assert.ok(replacement.ok)
  runtime.store.replace('a', replacement.record)
  runtime.store.remove('g', globalScope)
  assert.equal(search(runtime, 'ZETA').hits[0].record.id, 'replacement')
  assert.equal(search(runtime, '保留原文').hits.some(hit => hit.record.id === 'g'), false)
  assert.equal(listCalls, 0)

  const graph = runtime.graph()
  assert.equal(graph.total, 3)
  assert.ok(graph.records.some(record => record.id === 'replacement'))
  assert.ok(!graph.records.some(record => record.id === 'g'))
  assert.equal(runtime.profile(2, fixedNow).total, 0)
})

test('cached search honors validFrom for present and missing timestamps', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-memory-cache-valid-from-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const store = new MemoryStore({ root, clock: () => fixedNow }).open()
  assert.ok(store.write({ id: 'future', scope: 'project', projectKey: 'project-a', kind: 'fact',
    content: 'FUTURE-CACHE-VALUE', validFrom: fixedNow + 1000, confidence: 0.9 }, { id: 'future' }).ok)
  const dir = join(root, 'projects', 'project-a')
  mkdirSync(dir, { recursive: true })
  const legacy = { id: 'missing-time', kind: 'fact', status: 'active', revision: 1, scope: 'project',
    projectKey: 'project-a', content: 'MISSING-TIME-VALUE', updatedAt: fixedNow }
  writeFileSync(join(dir, 'memories.jsonl'), `${JSON.stringify(legacy)}\n`, { flag: 'a' })
  const first = openMemoryRuntime({ root, clock: () => fixedNow })
  assert.equal(search(first, 'FUTURE-CACHE-VALUE').hits.some(hit => hit.record.id === 'future'), false)
  assert.equal(search(first, 'MISSING-TIME-VALUE').hits[0].record.id, 'missing-time')
  first.dispose()
  await new Promise(resolve => setTimeout(resolve, 450))
  const reopened = openMemoryRuntime({ root, clock: () => fixedNow })
  t.after(() => reopened.dispose())
  assert.equal(reopened.metrics.cacheHit, true)
  assert.equal(search(reopened, 'FUTURE-CACHE-VALUE').hits.some(hit => hit.record.id === 'future'), false)
  assert.equal(search(reopened, 'MISSING-TIME-VALUE').hits[0].record.id, 'missing-time')
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
  const staged = join(root, 'derived-index-v1.bin.100.00000000-0000-4000-8000-000000000000.tmp')
  writeFileSync(staged, readFileSync(join(root, 'derived-index-v1.bin')))
  assert.equal(runtime.store.purge('b', scopeB), true)
  assert.equal(existsSync(join(root, 'derived-index-v1.bin')), false, 'purge invalidates the copy containing that record immediately')
  assert.equal(existsSync(staged), false, 'purge also removes any abandoned staged copy')
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

test('a small append keeps the checkpoint and replays through the ordinary startup path', async (t) => {
  const root = createFixture(t), cache = join(root, 'derived-index-v1.bin')
  const runtime = openMemoryRuntime({ root, clock: () => fixedNow })
  t.after(() => runtime.dispose())
  const before = statSync(cache, { bigint: true })
  runtime.store.update('a', { content: 'CHECKPOINT-NEXT 普通项目修订' }, scopeA)
  runtime.store.update('g', { content: '我希望查看新版原文。' }, globalScope)
  assert.ok(runtime.store.write({ kind: 'fact', scope: 'project', projectKey: 'new-project',
    content: 'NEW-SCOPE-DELTA 外来项目', confidence: .9 }, { id: 'new-scope-record' }).ok)
  await new Promise(resolve => setTimeout(resolve, 420))
  const after = statSync(cache, { bigint: true })
  assert.deepEqual([after.ino, after.mtimeNs, after.size], [before.ino, before.mtimeNs, before.size])
  runtime.dispose()
  const reopened = openMemoryRuntime({ root, clock: () => fixedNow })
  t.after(() => reopened.dispose())
  assert.equal(reopened.metrics.cacheHit, true)
  assert.equal(reopened.metrics.replayedRevisions, 3)
  assert.equal(search(reopened, 'CHECKPOINT-NEXT').hits[0]?.record.id, 'a')
  assert.deepEqual(search(reopened, 'ALPHA').hits, [])
  assert.deepEqual(search(reopened, 'NEW-SCOPE-DELTA').hits, [])
  assert.equal(search(reopened, 'NEW-SCOPE-DELTA', 'new-project').hits[0]?.record.id, 'new-scope-record')
  assert.equal(reopened.store.find('b', scopeB).revision, 1)
  assert.deepEqual(reopened.profile(10, fixedNow), deriveProfile(reopened.store.listAll(), { now: fixedNow, limit: 10 }))
  assert.ok(reopened.graph().records.some(record => record.id === 'a' && record.content.includes('CHECKPOINT-NEXT')))
})

test('an append atop rewritten bytes and an incomplete trailing line both fall back to the authority', (t) => {
  for (const mode of ['rewritten-prefix', 'partial-last-line']) {
    const root = createFixture(t)
    openMemoryRuntime({ root, clock: () => fixedNow }).dispose()
    const file = join(root, 'projects', 'project-a', 'memories.jsonl')
    const stamp = statSync(file)
    const original = readFileSync(file, 'utf8')
    if (mode === 'rewritten-prefix') {
      // Keep this inode and restore the mtime. Growing a file is only a hint.
      const edited = original.replace('ALPHA old', 'OMEGA new')
      assert.equal(Buffer.byteLength(edited), Buffer.byteLength(original))
      const row = { ...JSON.parse(original), id: 'new-theta', content: 'NEW-THETA' }
      writeFileSync(file, edited + JSON.stringify(row) + '\n')
      utimesSync(file, stamp.atime, stamp.mtime)
      assert.equal(statSync(file).ino, stamp.ino)
    } else {
      appendFileSync(file, '{"id":"truncated","revision":2')
    }
    const reopened = openMemoryRuntime({ root, clock: () => fixedNow })
    try {
      assert.equal(reopened.metrics.cacheHit, false)
      if (mode === 'rewritten-prefix') {
        assert.deepEqual(search(reopened, 'ALPHA').hits, [])
        assert.equal(search(reopened, 'OMEGA').hits[0]?.record?.id, 'a')
        assert.equal(reopened.store.find('new-theta', scopeA).content, 'NEW-THETA')
      } else {
        assert.equal(search(reopened, 'ALPHA').hits[0]?.record?.id, 'a')
        assert.equal(reopened.store.find('truncated', scopeA), undefined)
      }
    } finally { reopened.dispose() }
  }
})

test('a large group of appends is folded into the next checkpoint', async (t) => {
  const root = createFixture(t), cache = join(root, 'derived-index-v1.bin')
  const runtime = openMemoryRuntime({ root, clock: () => fixedNow })
  t.after(() => runtime.dispose())
  const before = statSync(cache, { bigint: true }).ino
  const batch = Array.from({ length: 513 }, (_, i) => buildRecord({
    ...scopeA[0], kind: 'fact', content: 'BOUNDED-CHECKPOINT entry ' + i, confidence: .9,
  }, { id: 'capped-entry-' + i, now: fixedNow }).record)
  assert.equal(runtime.store.appendBatch(batch).length, 513)
  await new Promise(resolve => setTimeout(resolve, 500))
  assert.notEqual(statSync(cache, { bigint: true }).ino, before)
  runtime.dispose()
  const reopened = openMemoryRuntime({ root, clock: () => fixedNow })
  t.after(() => reopened.dispose())
  assert.equal(reopened.metrics.cacheHit, true)
  assert.equal(reopened.metrics.replayedRevisions, 0)
  assert.equal(reopened.store.find('capped-entry-512', scopeA).content, 'BOUNDED-CHECKPOINT entry 512')
  assert.equal(reopened.store.find('capped-entry-512', scopeB), undefined)
})

test('refreshing one externally changed project updates its search index without scanning the whole store', t => {
  const root = createFixture(t)
  const runtime = openMemoryRuntime({ root, clock: () => fixedNow })
  t.after(() => runtime.dispose())
  const writer = new MemoryStore({ root, clock: () => fixedNow }).open()
  assert.ok(writer.write({ id: 'external-a', scope: 'project', projectKey: 'project-a', kind: 'fact',
    content: 'CROSS-PROCESS-SHARED-VALUE', confidence: .9 }, { id: 'external-a', now: fixedNow }).ok)

  let listAllCalls = 0
  const listAll = runtime.store.listAll.bind(runtime.store)
  runtime.store.listAll = (...args) => { listAllCalls++; return listAll(...args) }
  let listProjectsCalls = 0
  const listProjects = runtime.store.listProjects.bind(runtime.store)
  runtime.store.listProjects = (...args) => { listProjectsCalls++; return listProjects(...args) }
  assert.equal(runtime.refreshScope('project', 'project-a'), true)
  assert.equal(listAllCalls, 0, 'routine project refresh must not invoke the full-store rebuild path')
  assert.equal(search(runtime, 'CROSS-PROCESS-SHARED-VALUE', 'project-a').hits[0].record.id, 'external-a')
  assert.equal(runtime.synchronize('project-a'), true, 'the next native DSH sync must refresh only the active project and global scope')
  assert.equal(listProjectsCalls, 0, 'active-project refresh must not enumerate every project')
  assert.equal(listAllCalls, 0, 'the active-project sync must not rebuild the whole store')
  assert.equal(search(runtime, 'CROSS-PROCESS-SHARED-VALUE', 'project-a').hits[0].record.id, 'external-a')
  assert.equal(runtime.refreshScope('project', 'project-a'), false, 'unchanged file stamps are a cheap no-op')
  runtime.store.listProjects = listProjects
  assert.equal(runtime.synchronize('project-a'), false)
  assert.equal(listAllCalls, 0)
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
  assert.ok(storedCache(root).index.postings.freqs instanceof Uint32Array)
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
