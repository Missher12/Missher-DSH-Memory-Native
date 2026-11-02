import assert from 'node:assert/strict'
import test from 'node:test'

import { buildExtractionPrompt, parseExtraction } from '../host/extract.js'

test('prompt contains rules, existing memories and the transcript', () => {
  const prompt = buildExtractionPrompt({
    transcript: '用户：这个仓库用 pnpm。',
    existing: [{ id: 'mem_1', kind: 'fact', status: 'active', content: '仓库使用 npm' }],
    now: 1,
  })
  assert.match(prompt, /preference/u)
  assert.match(prompt, /\[mem_1\]/u)
  assert.match(prompt, /这个仓库用 pnpm/u)
})

test('parse accepts fenced JSON surrounded by prose', () => {
  const parsed = parseExtraction('好的，结果如下：\n```json\n{"memories":[{"op":"ADD","kind":"fact","scope":"project","content":"该仓库使用 pnpm","tags":["pnpm"],"confidence":0.9}]}\n```\n以上。')
  assert.equal(parsed.items.length, 1)
  assert.equal(parsed.items[0].content, '该仓库使用 pnpm')
  assert.equal(parsed.items[0].op, 'ADD')
})

test('parse skips NOOP items and unknown operations', () => {
  const parsed = parseExtraction(JSON.stringify({ memories: [
    { op: 'NOOP', content: '无价值' },
    { op: 'EXPLODE', content: '未知操作' },
    { op: 'ADD', kind: 'preference', content: '用户偏好中文回复', confidence: 0.8 },
  ] }))
  assert.equal(parsed.items.length, 1)
  assert.equal(parsed.items[0].kind, 'preference')
})

test('parse caps the number of items', () => {
  const memories = Array.from({ length: 20 }, (_, index) => ({ op: 'ADD', content: `事实 ${index}`, confidence: 0.9 }))
  const parsed = parseExtraction(JSON.stringify({ memories }))
  assert.equal(parsed.items.length, 8)
})

test('parse rejects unusable output', () => {
  assert.throws(() => parseExtraction('没有 JSON'), /no JSON object/u)
  assert.throws(() => parseExtraction('{broken'), /not valid JSON|no JSON object/u)
  assert.throws(() => parseExtraction('{"result":[]}'), /no memories array/u)
})

test('parse defaults missing fields safely', () => {
  const parsed = parseExtraction('{"memories":[{"content":"使用 SQLite 存储"}]}')
  assert.equal(parsed.items.length, 1)
  assert.equal(parsed.items[0].op, 'ADD')
  assert.equal(parsed.items[0].kind, 'fact')
  assert.equal(parsed.items[0].scope, 'project')
  assert.equal(parsed.items[0].confidence, 0.5)
})
