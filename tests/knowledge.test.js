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
  assert.equal(graph.nodes.length, 10)
  assert.equal(graph.memoryCount, 20)
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

test('buildKnowledgeGraph preserves topic hubs and includes profile traits', () => {
  const records = Array.from({ length: 60 }, (_, index) => record(`m${index}`, { topic: 'topic' + index }))
  const traits = [{ id: 'trait_1', statement: '用户偏好简洁回答', confidence: 0.9, evidence: [{ id: 'm0' }] }]
  const graph = buildKnowledgeGraph(records, { traits })
  assert.equal(graph.hubs.length, 61)
  assert.ok(graph.hubs.some((hub) => hub.label === '用户画像'))
  assert.ok(graph.hubs.some((hub) => hub.label === 'topic59'))
  assert.ok(graph.nodes.some((node) => node.type === 'trait'))
  assert.ok(graph.edges.some((edge) => edge.type === 'profile'))
})

test('all small topics remain distinct and note links include notes, topics, unresolved targets and backlinks',()=>{
 const records=Array.from({length:60},(_,i)=>record('m'+i,{topic:'topic'+i}))
 const notes=[{file:'A.md',title:'# A',topic:'topic59',body:'[[B#标题|别名]] [[topic59]] [[未创建]]'}, {file:'B.md',title:'# B',topic:'topic58',body:'[[A]]'}]
 const graph=buildKnowledgeGraph(records,{notes,maxNodes:100})
 assert.equal(graph.hubs.filter(h=>h.label.startsWith('topic')).length,60)
 assert.ok(graph.edges.some(e=>e.type==='wiki'&&e.source==='note:A.md'&&e.target==='note:B.md'))
 assert.ok(graph.edges.some(e=>e.type==='wiki'&&e.source==='note:B.md'&&e.target==='note:A.md'))
 assert.ok(graph.edges.some(e=>e.type==='wiki'&&e.target==='topic:topic59'))
 assert.ok(graph.nodes.some(n=>n.type==='unresolved'&&n.label==='未创建'))
 assert.ok(graph.edges.every(e=>e.source!==null&&e.target!==null))
})

test('graph pages and search reach every record beyond the old cap',()=>{
 const records=Array.from({length:1250},(_,i)=>record('m'+i,{topic:'topic'+i,content:'完整记忆'+i}))
 const ids=new Set()
 for(let offset=0;offset<1250;offset+=200){
  const graph=buildKnowledgeGraph(records,{maxNodes:200,offset})
  assert.equal(graph.total,1250)
  graph.nodes.forEach(n=>ids.add(n.id))
 }
 assert.equal(ids.size,1250)
 const found=buildKnowledgeGraph(records,{maxNodes:10,query:'完整记忆1249'})
 assert.ok(found.nodes.some(n=>n.id==='m1249'))
})

test('Obsidian paths, Markdown links and memory-note links resolve to the actual note',()=>{
 const graph=buildKnowledgeGraph([record('mem_linkqa',{content:'记忆内也有 [[A note]] 双链',topic:'小主题'})],{notes:[
  {file:'A note.md',title:'# A note',body:'[[DSH Memory/knowledge/B#说明|别名]] [另一个](B.md#说明)'},
  {file:'B.md',title:'# B',body:'[[mem_linkqa]]'}]})
 assert.ok(graph.edges.some(e=>e.source==='mem_linkqa'&&e.target==='note:A note.md'&&e.type==='wiki'))
 assert.ok(graph.edges.some(e=>e.source==='note:A note.md'&&e.target==='note:B.md'&&e.type==='wiki'))
 assert.ok(graph.edges.some(e=>e.source==='note:B.md'&&e.target==='mem_linkqa'&&e.type==='wiki'))
})

test('graph clamps a stale page after records disappear',()=>{
 const graph=buildKnowledgeGraph([record('left')],{maxNodes:10,offset:100})
 assert.equal(graph.offset,0);assert.equal(graph.nodes[0].id,'left');assert.equal(graph.nextOffset,null)
})
