import assert from 'node:assert/strict'
import test from 'node:test'

import { buildKnowledgeGraph, listKnowledgeNotes, promoteMemoryToKnowledge } from '../host/knowledge.js'

function record(id, overrides = {}) {
  return {
    id,
    kind: 'fact',
    status: 'active',
    content: `记忆 ${id}`,
    topic: null,
    tags: [],
    confidence: 0.8,
    updatedAt: 1,
    ...overrides,
  }
}

test('buildKnowledgeGraph groups by topic and links shared tags', () => {
  const graph = buildKnowledgeGraph([
    record('a', { topic: '存储', tags: ['jsonl'] }),
    record('b', { topic: '存储', tags: ['jsonl', 'node'] }),
    record('c', { topic: '面板', tags: ['node'] }),
    record('d', { tags: [] }),
    record('e', { status: 'deleted', topic: '存储' }),
  ])
  assert.equal(graph.memoryCount, 4)
  assert.equal(graph.topicCount, 3)
  assert.deepEqual(graph.hubs.map((hub) => hub.label).sort(), ['未分类', '存储', '面板'].sort())
  assert.equal(graph.hubs.find((hub) => hub.label === '存储').count, 2)
  assert.ok(graph.edges.some((edge) => edge.type === 'tag' && edge.label === 'jsonl'))
  assert.ok(graph.edges.some((edge) => edge.type === 'tag' && edge.label === 'node'))
  assert.ok(graph.edges.every((edge) => edge.type === 'topic' || edge.type === 'tag'))
})

test('buildKnowledgeGraph truncates at the node limit', () => {
  const records = Array.from({ length: 20 }, (_, index) => record(`m${index}`, { topic: 't' + (index % 4) }))
  const graph = buildKnowledgeGraph(records, { maxNodes: 10 })
  assert.equal(graph.memoryCount, 10)
  assert.equal(graph.truncated, true)
})

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('promoteMemoryToKnowledge writes a markdown note and the graph includes it', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-memory-knowledge-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const memory = record('mem_promote1', { topic: '存储', tags: ['jsonl'], content: '长期保存的知识内容' })
  const file = promoteMemoryToKnowledge(root, memory)
  assert.ok(file.endsWith('mem_promote1.md'))
  const notes = listKnowledgeNotes(root)
  assert.equal(notes.length, 1)
  assert.equal(notes[0].memoryId, 'mem_promote1')
  const graph = buildKnowledgeGraph([memory], { notes })
  assert.ok(graph.nodes.some((node) => node.type === 'note'))
  assert.ok(graph.edges.some((edge) => edge.type === 'knowledge'))
})

test('buildKnowledgeGraph caps topic hubs and includes profile traits', () => {
  const records = Array.from({ length: 60 }, (_, index) => record(`m${index}`, { topic: 'topic' + index }))
  const traits = [{ id: 'trait_1', statement: '用户偏好简洁回答', confidence: 0.9, evidence: [{ id: 'm0' }] }]
  const graph = buildKnowledgeGraph(records, { traits })
  assert.ok(graph.hubs.length <= 25)
  assert.ok(graph.hubs.some((hub) => hub.label === '用户画像'))
  assert.ok(graph.hubs.some((hub) => hub.label === '其他'))
  assert.ok(graph.nodes.some((node) => node.type === 'trait'))
  assert.ok(graph.edges.some((edge) => edge.type === 'profile'))
})
