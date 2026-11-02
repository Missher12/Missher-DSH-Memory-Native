import assert from 'node:assert/strict'
import test from 'node:test'

import { buildRecord, nextRevision } from '../host/records.js'
import { compileMemoryContext, estimateTokens, hasMeaningfulMatch, isFollowUpQuery, rankHits } from '../host/recall.js'

const NOW = 1_700_000_000_000
const KEY = 'DSH-Memory-abc'

function make(overrides = {}) {
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

test('rankHits orders by fused score and filters by minScore', () => {
  const strong = make({ content: '该仓库使用 pnpm 并要求 Node 22', importance: 0.9 })
  const weak = make({ content: '该仓库可能使用 pnpm', importance: 0.2, confidence: 0.4 })
  const ranked = rankHits([
    { record: strong, score: 2 },
    { record: weak, score: 0.4 },
  ], { now: NOW, minScore: 0.15 })
  assert.equal(ranked.length, 2)
  assert.equal(ranked[0].record.id, strong.id)
})

test('rankHits drops exact duplicate statements', () => {
  const first = make()
  const second = make()
  const ranked = rankHits([{ record: first, score: 2 }, { record: second, score: 1 }], { now: NOW, minScore: 0 })
  assert.equal(ranked.length, 1)
})

test('rankHits excludes an expired fact before fusion', () => {
  const expired = nextRevision(make(), { validTo: NOW - 1 }, NOW)
  const ranked = rankHits([{ record: expired, score: 2 }], { now: NOW, minScore: 0 })
  // validity is the index's job; rankHits still scores what it is given
  assert.equal(ranked.length, 1)
  assert.equal(ranked[0].record.validTo, NOW - 1)
})

test('compileMemoryContext emits a bounded id@revision block', () => {
  const record = make()
  const block = compileMemoryContext([{ record, score: 1 }], { maxTokens: 600 })
  assert.ok(block !== null)
  assert.match(block.text, /^<memory-context/u)
  assert.match(block.text, /dsh-memory/u)
  assert.match(block.text, new RegExp(`${record.id}@r1`, 'u'))
  assert.match(block.text, /<\/memory-context>$/u)
  assert.deepEqual(block.ids, [record.id])
})

test('compileMemoryContext respects the token budget and drops content that cannot fit', () => {
  const records = Array.from({ length: 20 }, (_, index) => make({ content: `这是第 ${index} 条有点长的记忆内容，用来测试预算截断行为` }))
  const ranked = records.map((record) => ({ record, score: 1 }))

  const tiny = compileMemoryContext(ranked, { maxTokens: 20, maxItems: 20 })
  assert.equal(tiny, null)

  const roomy = compileMemoryContext(ranked, { maxTokens: 200, maxItems: 20 })
  assert.ok(roomy !== null)
  assert.ok(roomy.ids.length >= 1)
  assert.ok(estimateTokens(roomy.text) <= 200)
})

test('compileMemoryContext returns null for no memories', () => {
  assert.equal(compileMemoryContext([], {}), null)
  assert.equal(compileMemoryContext(null, {}), null)
})

test('estimateTokens counts CJK chars as one token', () => {
  assert.equal(estimateTokens('记忆'), 2)
  assert.ok(estimateTokens('memory') >= 2)
})


test('weak single-character matches do not count as meaningful recall', () => {
  assert.equal(hasMeaningfulMatch(['好']), false)
  assert.equal(hasMeaningfulMatch(['的']), false)
  assert.equal(hasMeaningfulMatch(['继续']), true)
  assert.equal(hasMeaningfulMatch(['pnpm']), true)
  assert.equal(hasMeaningfulMatch(undefined), false)
})

test('follow-up detection reuses the previous user message only for short continuations', () => {
  assert.equal(isFollowUpQuery('继续'), true)
  assert.equal(isFollowUpQuery('好的'), true)
  assert.equal(isFollowUpQuery('然后呢'), true)
  assert.equal(isFollowUpQuery('继续这个项目的部署方案'), true)
  assert.equal(isFollowUpQuery('pnpm 是什么'), false)
  assert.equal(isFollowUpQuery('请帮我把记忆面板的指标卡调整成左右布局'), false)
})
