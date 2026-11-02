import assert from 'node:assert/strict'
import test from 'node:test'

import { buildRecord, contentHashOf, looksSensitive, nextRevision } from '../host/records.js'

const NOW = 1_700_000_000_000

function base(overrides = {}) {
  return {
    kind: 'fact',
    scope: 'project',
    projectKey: 'DSH-Memory-abc',
    content: '该仓库使用 pnpm 并要求 Node 22 以上',
    tags: ['pnpm', 'node'],
    sourceRefs: [{ sessionId: 's1', messageId: 'm1' }],
    confidence: 0.9,
    importance: 0.7,
    ...overrides,
  }
}

test('a confident fact becomes active', () => {
  const built = buildRecord(base(), { now: NOW, id: 'mem_test', autoApproveConfidence: 0.75 })
  assert.equal(built.ok, true)
  assert.equal(built.record.status, 'active')
  assert.equal(built.record.revision, 1)
  assert.equal(built.record.projectKey, 'DSH-Memory-abc')
  assert.equal(built.record.contentHash, contentHashOf(base().content))
})

test('a low-confidence fact stays a candidate', () => {
  const built = buildRecord(base({ confidence: 0.4 }), { now: NOW, autoApproveConfidence: 0.75 })
  assert.equal(built.ok, true)
  assert.equal(built.record.status, 'candidate')
})

test('global scope clears the project key and project scope requires one', () => {
  const global = buildRecord(base({ scope: 'global' }), { now: NOW })
  assert.equal(global.ok, true)
  assert.equal(global.record.projectKey, null)

  const missing = buildRecord(base({ projectKey: '' }), { now: NOW })
  assert.equal(missing.ok, false)
})

test('content is normalized, limited and checked for credentials', () => {
  const padded = buildRecord(base({ content: '  使用   SQLite \n 存储  ' }), { now: NOW })
  assert.equal(padded.ok, true)
  assert.equal(padded.record.content, '使用 SQLite 存储')

  assert.equal(buildRecord(base({ content: '短' }), { now: NOW }).ok, false)
  assert.equal(buildRecord(base({ content: 'x'.repeat(600) }), { now: NOW }).ok, false)
  assert.equal(buildRecord(base({ content: 'api_key = sk-abcdefghijklmnopqrstuvwxyz' }), { now: NOW }).ok, false)
  assert.equal(looksSensitive('Bearer abcdefghijklmnopqrstuvwxyz'), true)
})

test('invalid kind, scope and time range are rejected', () => {
  assert.equal(buildRecord(base({ kind: 'gossip' }), { now: NOW }).ok, false)
  assert.equal(buildRecord(base({ scope: 'session' }), { now: NOW }).ok, false)
  assert.equal(buildRecord(base({ validFrom: 100, validTo: 50 }), { now: NOW }).ok, false)
})

test('tags are deduplicated and capped', () => {
  const built = buildRecord(base({ tags: ['a', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'] }), { now: NOW })
  assert.equal(built.ok, true)
  assert.deepEqual(built.record.tags, ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'])
})

test('nextRevision increments revision and updates the hash', () => {
  const built = buildRecord(base(), { now: NOW, id: 'mem_test' })
  assert.equal(built.ok, true)
  const next = nextRevision(built.record, { content: '该仓库使用 pnpm 并推荐 Node 24' }, NOW + 1000)
  assert.equal(next.revision, 2)
  assert.equal(next.updatedAt, NOW + 1000)
  assert.notEqual(next.contentHash, built.record.contentHash)
  assert.equal(next.content, '该仓库使用 pnpm 并推荐 Node 24')
})

test('nextRevision rejects a change with credential content', () => {
  const built = buildRecord(base(), { now: NOW, id: 'mem_test' })
  assert.equal(built.ok, true)
  assert.throws(() => nextRevision(built.record, { content: 'password = hunter2hunter2' }, NOW))
})
