import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { buildRecord } from '../host/records.js'
import { MemoryStore } from '../host/store.js'
import { openMemoryRuntime } from '../host/startup.js'

const NOW = 1_750_000_000_000
const global = [{ scope: 'global', projectKey: null }]

function fixture(t, { cached = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-materialization-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const standard = buildRecord({ scope: 'global', kind: 'fact', content: '甲项目使用 ALPHA 内容进行检查', confidence: 0.9,
    topic: '原始主题', tags: ['甲标签'] }, { id: 'normal', now: NOW }).record
  const unusual = { 7: 'numeric-first', content: '特殊格式使用 BETA 内容进行检查', extra: { original: true },
    status: 'active', id: 'unusual', revision: 1, kind: 'fact', scope: 'global', projectKey: null, '01': 'preserved' }
  const dir = join(root, 'global')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'memories.jsonl'), `${JSON.stringify(standard)}\n${JSON.stringify(unusual)}\n`)
  const initial = openMemoryRuntime({ root, clock: () => NOW })
  if (!cached) {
    t.after(() => initial.dispose())
    return { root, runtime: initial, standard: JSON.parse(JSON.stringify(standard)), unusual }
  }
  initial.dispose()
  const runtime = openMemoryRuntime({ root, clock: () => NOW })
  assert.equal(runtime.metrics.cacheHit, true)
  t.after(() => runtime.dispose())
  return { root, runtime, standard: JSON.parse(JSON.stringify(standard)), unusual }
}

function sameObservableRecord(actual, expected) {
  assert.deepEqual(Reflect.ownKeys(actual), Reflect.ownKeys(expected))
  assert.deepEqual(Object.keys(actual), Object.keys(expected))
  assert.deepEqual({ ...actual }, { ...expected })
  assert.equal(JSON.stringify(actual), JSON.stringify(expected))
}

test('materialization preserves JSON order and caller operations for normal and unusual records', (t) => {
  const { runtime, standard, unusual } = fixture(t)
  const normal = runtime.store.find('normal', global)
  const odd = runtime.store.find('unusual', global)
  assert.equal(normal.content, standard.content)
  sameObservableRecord(normal, standard)
  assert.equal(odd.content, unusual.content)
  sameObservableRecord(odd, unusual)
  for (const record of [normal, standard]) {
    record.status = 'archived'
    Object.defineProperty(record, 'topic', { value: '新主题', writable: true, enumerable: true, configurable: true })
    delete record.importance
    record.importance = 0.8
    record.extra = 'tail'
  }
  sameObservableRecord(normal, standard)
  assert.equal(runtime.index.search('ALPHA', { now: NOW }).length, 0)
  normal.status = standard.status = 'active'
  assert.equal(runtime.index.searchPage('ALPHA', { now: NOW, topic: '新主题' }).hits[0].record.id, 'normal')
  const inherited = { inheritedMarker: 'ok' }
  Object.setPrototypeOf(odd, inherited)
  assert.equal(odd.inheritedMarker, 'ok')
  Object.setPrototypeOf(odd, Object.prototype)
  sameObservableRecord(odd, unusual)
})

test('cache refresh also rejects uncommitted direct edits on a freshly built store', async (t) => {
  const { root, runtime } = fixture(t, { cached: false })
  assert.equal(runtime.metrics.cacheHit, false)
  const record = runtime.store.find('normal', global)
  record.status = 'archived'
  record.tags.push('未提交')
  assert.equal(runtime.index.search('ALPHA', { now: NOW }).length, 0)
  assert.equal(runtime.store.write({ scope: 'global', kind: 'fact', content: '另一个 DELTA 记录触发缓存更新', confidence: 0.9 },
    { id: 'another', now: NOW }).ok, true)
  await new Promise((resolve) => setTimeout(resolve, 450))
  const authoritative = new MemoryStore({ root }).open().find('normal', global)
  const reopened = openMemoryRuntime({ root, clock: () => NOW })
  t.after(() => reopened.dispose())
  assert.deepEqual(reopened.store.find('normal', global), authoritative)
})

test('cache refresh never persists direct, uncommitted record edits over JSONL', async (t) => {
  const { root, runtime } = fixture(t)
  const record = runtime.store.find('normal', global)
  record.status = 'archived'
  assert.equal(runtime.index.search('ALPHA', { now: NOW }).length, 0)
  const saved = runtime.store.write({ scope: 'global', kind: 'fact', content: '另一个 GAMMA 记录触发缓存更新', confidence: 0.9 },
    { id: 'another', now: NOW })
  assert.equal(saved.ok, true)
  await new Promise((resolve) => setTimeout(resolve, 450))
  const authoritative = new MemoryStore({ root }).open().find('normal', global)
  assert.equal(authoritative.status, 'active')
  const reopened = openMemoryRuntime({ root, clock: () => NOW })
  t.after(() => reopened.dispose())
  assert.equal(reopened.store.find('normal', global).status, authoritative.status)
  assert.equal(reopened.index.search('ALPHA', { now: NOW })[0].record.id, 'normal')
  assert.match(readFileSync(join(root, 'global', 'memories.jsonl'), 'utf8'), /GAMMA/u)
})

test('an explicit compaction commits direct edits and produces a consistent reusable cache', async (t) => {
  const { root, runtime } = fixture(t)
  const record = runtime.store.find('normal', global)
  record.status = 'archived'
  record.tags.push('已提交')
  runtime.store.compact('global', null)
  await new Promise((resolve) => setTimeout(resolve, 450))
  const authoritative = new MemoryStore({ root }).open().find('normal', global)
  assert.equal(authoritative.status, 'archived')
  assert.ok(authoritative.tags.includes('已提交'))
  const reopened = openMemoryRuntime({ root, clock: () => NOW })
  t.after(() => reopened.dispose())
  assert.equal(reopened.metrics.cacheHit, true)
  assert.deepEqual(reopened.store.find('normal', global), authoritative)
})

test('cache refresh excludes uncommitted nested edits even after an explicit index update', async (t) => {
  const { root, runtime } = fixture(t)
  const record = runtime.store.find('normal', global)
  record.tags.push('ORBITTOKEN')
  runtime.index.upsert(record)
  assert.equal(runtime.index.search('ORBITTOKEN', { now: NOW })[0].record.id, 'normal')
  assert.equal(runtime.store.write({ scope: 'global', kind: 'fact', content: '新记录触发后续 EPSILON 缓存更新', confidence: 0.9 },
    { id: 'another', now: NOW }).ok, true)
  await new Promise((resolve) => setTimeout(resolve, 450))
  const reopened = openMemoryRuntime({ root, clock: () => NOW })
  t.after(() => reopened.dispose())
  assert.equal(reopened.index.search('ORBITTOKEN', { now: NOW }).length, 0)
  assert.deepEqual(reopened.store.find('normal', global), new MemoryStore({ root }).open().find('normal', global))
})

test('prototype and property descriptors behave normally before lazy content is read', (t) => {
  const { runtime, unusual } = fixture(t)
  const record = runtime.store.find('unusual', global)
  const expected = { ...unusual }
  const prototype = { topic: '继承主题', inheritedMarker: 'ok' }
  Object.setPrototypeOf(record, prototype)
  Object.setPrototypeOf(expected, prototype)
  assert.equal(record.topic, expected.topic)
  assert.equal(runtime.index.searchPage('BETA', { now: NOW, topic: '继承主题' }).hits[0].record.id, 'unusual')
  sameObservableRecord(record, expected)
  Object.preventExtensions(record)
  Object.preventExtensions(expected)
  assert.equal(Object.isExtensible(record), Object.isExtensible(expected))
  assert.equal(Reflect.set(record, 'newProperty', 1), Reflect.set(expected, 'newProperty', 1))
  assert.deepEqual(Object.getOwnPropertyDescriptors(record), Object.getOwnPropertyDescriptors(expected))
})

test('valid noncanonical JSONL formatting still creates a reusable cache', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-materialization-jsonl-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const dir = join(root, 'global')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'memories.jsonl'), ' { "id" : "white", "kind" : "fact", "content" : "中文和 WHITE 内容", "status" : "active", "revision" : 1, "scope" : "global" } \n')
  const first = openMemoryRuntime({ root, clock: () => NOW })
  first.dispose()
  const reopened = openMemoryRuntime({ root, clock: () => NOW })
  t.after(() => reopened.dispose())
  assert.equal(reopened.metrics.cacheHit, true)
  assert.equal(reopened.index.search('WHITE', { now: NOW })[0].record.id, 'white')
})

test('compaction indexes committed content and tags before and after cached reopen', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-compact-recall-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const store = new MemoryStore({ root, clock: () => NOW }).open()
  assert.equal(store.write({ scope: 'global', kind: 'fact', content: 'Original ALPHATOKEN fact', confidence: 0.9 },
    { id: 'committed', now: NOW }).ok, true)
  const initial = openMemoryRuntime({ root, clock: () => NOW })
  initial.dispose()
  const runtime = openMemoryRuntime({ root, clock: () => NOW })
  t.after(() => runtime.dispose())
  assert.equal(runtime.metrics.cacheHit, true)
  const record = runtime.store.find('committed', global)
  record.content = 'Updated BETATOKEN fact'
  record.tags.push('GAMMATOKEN')
  runtime.store.compact('global', null)
  assert.equal(runtime.index.search('BETATOKEN', { now: NOW })[0]?.record.id, 'committed')
  assert.equal(runtime.index.search('GAMMATOKEN', { now: NOW })[0]?.record.id, 'committed')
  assert.equal(runtime.index.search('ALPHATOKEN', { now: NOW }).length, 0)
  await new Promise(resolve => setTimeout(resolve, 450))
  const reopened = openMemoryRuntime({ root, clock: () => NOW })
  t.after(() => reopened.dispose())
  assert.equal(reopened.metrics.cacheHit, true)
  assert.equal(reopened.store.find('committed', global).content, 'Updated BETATOKEN fact')
  assert.equal(reopened.index.search('BETATOKEN', { now: NOW })[0]?.record.id, 'committed')
  assert.equal(reopened.index.search('GAMMATOKEN', { now: NOW })[0]?.record.id, 'committed')
  assert.equal(reopened.index.search('ALPHATOKEN', { now: NOW }).length, 0)
})

test('compaction also reindexes direct content edits in a freshly built store', async (t) => {
  const { root, runtime } = fixture(t, { cached: false })
  const record = runtime.store.find('normal', global)
  record.content = 'Fresh DELTATOKEN committed content'
  runtime.store.compact('global', null)
  assert.equal(runtime.index.search('DELTATOKEN', { now: NOW })[0]?.record.id, 'normal')
  assert.equal(runtime.index.search('ALPHA', { now: NOW }).length, 0)
  await new Promise(resolve => setTimeout(resolve, 450))
  const reopened = openMemoryRuntime({ root, clock: () => NOW })
  t.after(() => reopened.dispose())
  assert.equal(reopened.metrics.cacheHit, true)
  assert.equal(reopened.index.search('DELTATOKEN', { now: NOW })[0]?.record.id, 'normal')
  assert.equal(reopened.index.search('ALPHA', { now: NOW }).length, 0)
})

test('older cache formats are rebuilt from the authority before search', (t) => {
  const { root, runtime } = fixture(t)
  runtime.dispose()
  const cache = join(root, 'derived-index-v1.bin')
  const bytes = readFileSync(cache)
  const headerLength = bytes.readUInt32BE(0)
  const header = JSON.parse(bytes.subarray(4, 4 + headerLength).toString('utf8'))
  header.format = 6
  const encoded = Buffer.from(JSON.stringify(header))
  const size = Buffer.allocUnsafe(4)
  size.writeUInt32BE(encoded.length)
  writeFileSync(cache, Buffer.concat([size, encoded, bytes.subarray(4 + headerLength)]))
  const reopened = openMemoryRuntime({ root, clock: () => NOW })
  t.after(() => reopened.dispose())
  assert.equal(reopened.metrics.cacheHit, false)
  assert.equal(reopened.index.search('ALPHA', { now: NOW })[0]?.record.id, 'normal')
})
