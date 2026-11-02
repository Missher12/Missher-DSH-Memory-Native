import assert from 'node:assert/strict'
import test from 'node:test'

import { isCjk, queryTerms, tokenize } from '../host/tokenize.js'

test('latin words are lowercased and split on punctuation', () => {
  assert.deepEqual(tokenize('Hello, World! 2026'), ['hello', 'world', '2026'])
})

test('CJK runs emit unigrams and adjacent bigrams', () => {
  const tokens = tokenize('用户偏好')
  assert.ok(tokens.includes('用'))
  assert.ok(tokens.includes('用户'))
  assert.ok(tokens.includes('户偏'))
  assert.ok(tokens.includes('偏好'))
  assert.ok(!tokens.includes('用户偏'))
})

test('two-character Chinese queries are covered by bigrams', () => {
  assert.ok(tokenize('项目采用存储').includes('采用'))
  assert.ok(tokenize('项目采用存储').includes('存储'))
})

test('mixed text keeps both latin and CJK terms', () => {
  const tokens = tokenize('使用 SQLite 存储')
  assert.ok(tokens.includes('sqlite'))
  assert.ok(tokens.includes('存储'))
  assert.ok(tokens.includes('使'))
})

test('NFKC normalization and case folding apply before tokenizing', () => {
  assert.deepEqual(tokenize('ＡＢＣ １２３'), ['abc', '123'])
})

test('queryTerms deduplicates while tokenize keeps term frequency', () => {
  assert.deepEqual(queryTerms('记忆 记忆 memory'), ['记', '忆', '记忆', 'memory'])
  assert.deepEqual(tokenize('记忆 记忆'), ['记', '忆', '记忆', '记', '忆', '记忆'])
})

test('isCjk recognizes CJK and rejects latin', () => {
  assert.equal(isCjk('中'), true)
  assert.equal(isCjk('a'), false)
  assert.equal(isCjk(''), false)
})
