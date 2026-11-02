import assert from 'node:assert/strict'
import test from 'node:test'

import { buildRecord, nextRevision } from '../host/records.js'
import { MemoryIndex } from '../host/search.js'

const NOW = 1_700_000_000_000
const KEY = 'DSH-Memory-abc'

function record(overrides = {}) {
  const built = buildRecord({
    kind: 'fact',
    scope: 'project',
    projectKey: KEY,
    content: '该仓库使用 pnpm 并要求 Node 22 以上',
    tags: ['pnpm'],
    confidence: 0.9,
    importance: 0.7,
    ...overrides,
  }, { now: NOW, autoApproveConfidence: 0.75 })
  assert.equal(built.ok, true)
  return built.record
}

test('Chinese two-character queries match', () => {
  const index = new MemoryIndex().rebuild([
    record({ content: '项目采用 SQLite 存储记忆' }),
    record({ content: '用户偏好中文回复，代码注释用英文' }),
  ])
  const hits = index.search('存储', { now: NOW, projectKey: KEY })
  assert.equal(hits.length, 1)
  assert.match(hits[0].record.content, /存储/u)

  const hits2 = index.search('中文', { now: NOW, projectKey: KEY })
  assert.equal(hits2.length, 1)
  assert.match(hits2[0].record.content, /中文/u)
})

test('latin terms match case-insensitively', () => {
  const index = new MemoryIndex().rebuild([record()])
  assert.equal(index.search('PNPM', { now: NOW, projectKey: KEY }).length, 1)
  assert.equal(index.search('sqlite', { now: NOW, projectKey: KEY }).length, 0)
})

test('candidates are excluded unless requested', () => {
  const index = new MemoryIndex().rebuild([record({ confidence: 0.4 })])
  assert.equal(index.size, 1)
  assert.equal(index.search('pnpm', { now: NOW, projectKey: KEY }).length, 0)
  assert.equal(index.search('pnpm', { now: NOW, projectKey: KEY, statuses: ['candidate'] }).length, 1)
})

test('expired facts are excluded', () => {
  const expired = nextRevision(record(), { validTo: NOW - 1000 }, NOW)
  const index = new MemoryIndex().rebuild([expired])
  assert.equal(index.search('pnpm', { now: NOW, projectKey: KEY }).length, 0)

  const future = nextRevision(record(), { validTo: NOW + 1000 }, NOW)
  const index2 = new MemoryIndex().rebuild([future])
  assert.equal(index2.search('pnpm', { now: NOW, projectKey: KEY }).length, 1)
})

test('records from another project are filtered out', () => {
  const index = new MemoryIndex().rebuild([record()])
  assert.equal(index.search('pnpm', { now: NOW, projectKey: 'other-project' }).length, 0)
  assert.equal(index.search('pnpm', { now: NOW, projectKey: KEY }).length, 1)
})

test('higher term frequency ranks first', () => {
  const index = new MemoryIndex().rebuild([
    record({ content: '记忆 存储 存储 存储 检索' }),
    record({ content: '记忆 存储 检索' }),
  ])
  const hits = index.search('存储', { now: NOW, projectKey: KEY })
  assert.equal(hits.length, 2)
  assert.ok(hits[0].score > hits[1].score)
  assert.match(hits[0].record.content, /存储 存储 存储/u)
})

test('upsert and remove keep the index consistent', () => {
  const first = record()
  const index = new MemoryIndex().rebuild([first])
  assert.equal(index.size, 1)

  index.upsert(nextRevision(first, { content: '该仓库使用 SQLite 存储', tags: [] }, NOW))
  assert.equal(index.size, 1)
  assert.equal(index.search('sqlite', { now: NOW, projectKey: KEY }).length, 1)
  assert.equal(index.search('pnpm', { now: NOW, projectKey: KEY }).length, 0)

  index.remove(first.id)
  assert.equal(index.size, 0)
  assert.equal(index.search('sqlite', { now: NOW, projectKey: KEY }).length, 0)
})

test('empty query returns no hits', () => {
  const index = new MemoryIndex().rebuild([record()])
  assert.deepEqual(index.search('   ', { now: NOW, projectKey: KEY }), [])
})
