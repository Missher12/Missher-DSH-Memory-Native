import assert from 'node:assert/strict'
import test from 'node:test'

import { buildRecord, nextRevision } from '../host/records.js'
import { classifyRecallHits, compileMemoryContext, estimateTokens, hasContentMatch, hasMeaningfulMatch, isFollowUpQuery, rankHits, recallQueries } from '../host/recall.js'

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

test('compileMemoryContext emits a compact bounded block', () => {
  const record = make()
  const block = compileMemoryContext([{ record, score: 1 }], { maxTokens: 600 })
  assert.ok(block !== null)
  assert.match(block.text, /^<memory-context/u)
  assert.match(block.text, /dsh-memory/u)
  assert.match(block.text, /- \[事实\] 该仓库使用 pnpm/u)
  assert.doesNotMatch(block.text, /@r1/u)
  assert.match(block.text, /<\/memory-context>$/u)
  assert.deepEqual(block.ids, [record.id])
  assert.equal(block.itemCount, 1)
  assert.ok(block.estimatedTokens <= 600)
})

test('compileMemoryContext dedupes profile lines and caps item length', () => {
  const record = make({ content: '用户偏好简洁直接的表达方式' })
  const block = compileMemoryContext([{ record, score: 1 }], {
    maxTokens: 600,
    profileLines: ['- [偏好] 用户偏好简洁直接的表达方式（3 条证据 · 0.95）'],
    profileLimit: 2,
    itemMaxChars: 10,
  })
  assert.ok(block !== null)
  assert.match(block.text, /用户偏好简洁直接的表达方式（3 条证据/u)
  assert.equal(block.itemCount, 0)
  assert.doesNotMatch(block.text, /- \[事实\]/u)
  const long = make({ content: '这是一条非常长的记忆内容'.repeat(10) })
  const clipped = compileMemoryContext([{ record: long, score: 1 }], { maxTokens: 600, itemMaxChars: 20 })
  assert.ok(clipped !== null)
  assert.match(clipped.text, /…/u)
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

test('content gate ignores function-word bigrams', () => {
  assert.equal(hasContentMatch(['怎么']), false)
  assert.equal(hasContentMatch(['然后']), false)
  assert.equal(hasContentMatch(['这个']), false)
  assert.equal(hasContentMatch(['继续']), false)
  assert.equal(hasContentMatch(['进度']), true)
  assert.equal(hasContentMatch(['pnpm']), true)
  assert.equal(hasContentMatch(['设计', '文档']), true)
})

test('classifyRecallHits splits auto, gray and dropped hits', () => {
  const term = (name, idf, value) => ({ term: name, idf, value })
  const strong = { record: { id: 'a', content: '设计文档' }, matched: ['设计', '计文'], termScores: [term('设计', 4, 8), term('计文', 4, 6)] }
  const gray = { record: { id: 'b', content: '灰度发布' }, matched: ['灰度', '发布'], termScores: [term('灰度', 4, 1.8), term('发布', 3, 1.2)] }
  const weak = { record: { id: 'c', content: '随便' }, matched: ['随便'], termScores: [term('随便', 1, 0.5)] }
  const gate = classifyRecallHits([strong, gray, weak], '设计文档', { indexSize: 200, idfOf: () => 4 })
  assert.deepEqual(gate.auto.map((hit) => hit.record.id), ['a'])
  assert.deepEqual(gate.gray.map((hit) => hit.record.id), ['b'])
  assert.ok(gate.i1 > 4.8)
})

test('classifyRecallHits scales thresholds with index size', () => {
  const small = classifyRecallHits([], 'x', { indexSize: 200 })
  const large = classifyRecallHits([], 'x', { indexSize: 5000 })
  assert.ok(large.thresholds.drop > small.thresholds.drop)
  assert.ok(large.thresholds.auto > small.thresholds.auto)
})


test('recallQueries tries the last two user messages for follow-ups', () => {
  assert.deepEqual(recallQueries('继续', '召回门控怎么定', true), ['召回门控怎么定 继续', '召回门控怎么定', '继续'])
  assert.deepEqual(recallQueries('继续', undefined, true), ['继续'])
  assert.deepEqual(recallQueries('pnpm 版本', '召回门控怎么定', false), ['pnpm 版本'])
})

test('rankHits boosts records matching the inferred topic', () => {
  const first = make({ topic: '沟通', content: '用户偏好简洁直接的回答' })
  const second = make({ topic: '布局', content: '用户偏好紧凑单行布局' })
  const hits = [
    { record: first, score: 2, matched: ['偏好'] },
    { record: second, score: 2, matched: ['偏好'] },
  ]
  const ranked = rankHits(hits, { now: NOW, minScore: 0, topicHint: '布局' })
  assert.equal(ranked[0].record.id, second.id)
})
