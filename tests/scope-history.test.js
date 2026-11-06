import assert from 'node:assert/strict'
import test from 'node:test'

import { buildKnowledgeGraph } from '../host/knowledge.js'
import { deriveProfile } from '../host/profile.js'
import { formatMemoryLine, isHistoricalQuery } from '../host/recall.js'
import { buildRecord } from '../host/records.js'
import { MemoryIndex } from '../host/search.js'

const NOW = 1_700_000_000_000
const KEY = 'DSH-Scope-abc'
const OTHER = 'DSH-Other-def'

function record(overrides = {}) {
  const built = buildRecord({
    kind: 'fact',
    scope: 'project',
    projectKey: KEY,
    content: '该仓库要求 Node 22 以上',
    confidence: 0.9,
    ...overrides,
  }, { now: NOW })
  assert.equal(built.ok, true)
  return built.record
}

test('project memories are shared by sessions of the same project but not other projects', () => {
  const shared = record({ content: '项目内跨会话共享的部署约束' })
  const global = record({ scope: 'global', projectKey: null, content: '全局偏好：回答使用中文' })
  const foreign = record({ projectKey: OTHER, content: '其他项目的数据库口令位置' })
  const index = new MemoryIndex().rebuild([shared, global, foreign])
  const options = { statuses: ['active'], scopes: ['project', 'global'], projectKey: KEY, now: NOW, limit: 20 }
  const hits = index.search('部署约束 中文', options).map((hit) => hit.record.id)
  assert.ok(hits.includes(shared.id))
  assert.ok(hits.includes(global.id))
  assert.ok(!hits.includes(foreign.id))
})

test('historical queries can see superseded records while normal recall cannot', () => {
  const old = { ...record({ content: '该仓库要求 Node 22 以上' }), status: 'superseded', validTo: NOW - 1000 }
  const fresh = record({ content: '该仓库要求 Node 24 以上' })
  const index = new MemoryIndex().rebuild([old, fresh])
  const normal = index.search('Node 版本要求', { statuses: ['active'], projectKey: KEY, now: NOW, limit: 10 })
  assert.ok(!normal.some((hit) => hit.record.id === old.id))
  const history = index.search('以前 Node 版本要求', {
    statuses: ['active', 'superseded'],
    includeExpired: true,
    projectKey: KEY,
    now: NOW,
    limit: 10,
  })
  assert.ok(history.some((hit) => hit.record.id === old.id))
  assert.match(formatMemoryLine(old), /历史，已失效/u)
  assert.equal(isHistoricalQuery('以前用的 Node 版本是什么'), true)
  assert.equal(isHistoricalQuery('previously used Node version'), true)
  assert.equal(isHistoricalQuery('现在 Node 版本是什么'), false)
})

test('forgotten preferences disappear from the derived profile and graph', () => {
  const preference = record({ kind: 'preference', scope: 'global', projectKey: null, content: '用户偏好简洁直接的中文回答' })
  assert.equal(deriveProfile([preference], { now: NOW }).traits.length, 1)
  const tombstone = { ...preference, status: 'deleted', revision: 2 }
  assert.equal(deriveProfile([tombstone], { now: NOW }).traits.length, 0)
  const graph = buildKnowledgeGraph([tombstone], { now: NOW })
  assert.equal(graph.nodes.filter((node) => node.type === 'memory').length, 0)
})
