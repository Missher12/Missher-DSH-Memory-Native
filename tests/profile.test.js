import assert from 'node:assert/strict'
import test from 'node:test'

import { buildRecord } from '../host/records.js'
import { deriveProfile, formatProfileLines } from '../host/profile.js'

const NOW = 1_700_000_000_000

function record(overrides = {}) {
  const built = buildRecord({
    kind: 'preference',
    scope: 'global',
    content: '用户偏好简洁直接的中文回答',
    confidence: 0.9,
    importance: 0.7,
    ...overrides,
  }, { now: NOW, autoApproveConfidence: 0.75 })
  assert.equal(built.ok, true)
  return built.record
}

test('deriveProfile groups similar same-topic records into one trait with evidence', () => {
  const a = record({ topic: '沟通', content: '用户偏好简洁直接的中文回答' })
  const b = record({ topic: '沟通', content: '用户偏好简洁直接的回复', confidence: 0.8 })
  const other = record({ topic: '存储', content: '项目使用 JSONL 作为权威存储', kind: 'fact' })

  const profile = deriveProfile([a, b, other])
  assert.equal(profile.total, 1)
  const chatting = profile.traits.find((trait) => trait.topic === '沟通')
  assert.equal(chatting.evidenceCount, 2)
  assert.equal(chatting.confidence, 0.9)
  assert.deepEqual(chatting.evidence.map((item) => item.id).sort(), [a.id, b.id].sort())
})

test('deriveProfile merges similar statements without a topic and keeps kinds apart', () => {
  const a = record({ content: '用户偏好简洁直接的表达方式' })
  const b = record({ content: '用户偏好简洁、直接的表达方式。', confidence: 0.85 })
  const fact = record({ kind: 'fact', content: '用户偏好简洁直接的表达方式', confidence: 0.9 })

  const profile = deriveProfile([a, b, fact])
  assert.equal(profile.total, 1)
  assert.equal(profile.traits[0].kind, 'preference')
  assert.equal(profile.traits[0].evidenceCount, 2)
})

test('deriveProfile ignores低置信、非 active 与其它类型', () => {
  const low = record({ confidence: 0.4 })
  const archived = { ...record(), status: 'archived' }
  const fact = record({ kind: 'fact' })
  const profile = deriveProfile([low, archived, fact])
  assert.equal(profile.total, 0)
  assert.deepEqual(profile.traits, [])
})

test('deriveProfile applies a 60-day recency half-life to ranking', () => {
  const fresh = record({ content: '用户偏好中文回复', topic: '语言', confidence: 0.7, status: 'active' })
  const old = record({ content: '用户偏好深色主题', topic: '界面', confidence: 0.9 })
  const oldRecord = { ...old, updatedAt: NOW - 60 * 86_400_000, observedAt: NOW - 60 * 86_400_000 }
  const profile = deriveProfile([fresh, oldRecord], { now: NOW })
  assert.equal(profile.total, 2)
  assert.equal(profile.traits[0].statement, '用户偏好中文回复')
  assert.ok(profile.traits.every((trait) => trait.kind === 'preference'))
})

test('formatProfileLines bounds the injected profile text', () => {
  const traits = [
    { kind: 'preference', statement: '用户偏好中文', confidence: 0.9, evidenceCount: 3 },
    { kind: 'decision', statement: '项目采用 JSONL', confidence: 0.8, evidenceCount: 1 },
  ]
  const lines = formatProfileLines(traits, { limit: 1, maxChars: 100 })
  assert.equal(lines.length, 1)
  assert.match(lines[0], /用户偏好中文/u)
})


test('formatProfileLines can omit evidence metadata for injection', () => {
  const lines = formatProfileLines([
    { kind: 'preference', statement: '用户偏好简洁直接的表达方式', confidence: 0.95, evidenceCount: 3 },
  ], { limit: 1, compact: true })
  assert.deepEqual(lines, ['- [preference] 用户偏好简洁直接的表达方式'])
})


test('deriveProfile keeps antonym and negated preferences apart', () => {
  const dark = record({ topic: '界面', content: '用户偏好深色主题' })
  const light = record({ topic: '界面', content: '用户偏好浅色主题' })
  const must = record({ topic: '交付', content: '交付前必须跑测试' })
  const mustNot = record({ topic: '交付', content: '交付前不必跑测试' })
  const profile = deriveProfile([dark, light, must, mustNot])
  assert.equal(profile.total, 4)
  assert.ok(profile.traits.every((trait) => trait.evidenceCount === 1))
})

test('deriveProfile keeps same-topic but unrelated preferences apart', () => {
  const group = record({ topic: '面板', content: '面板设置区按组呈现，每组带标题' })
  const tooltip = record({ topic: '面板', content: '热力图 tooltip 不能溢出卡片' })
  const profile = deriveProfile([group, tooltip])
  assert.equal(profile.total, 2)
})
