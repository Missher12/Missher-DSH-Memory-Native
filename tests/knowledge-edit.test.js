import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  isKnowledgeFile,
  listKnowledgeNotes,
  promoteMemoryToKnowledge,
  readKnowledgeNote,
  saveKnowledgeNote,
  splitNoteBody,
} from '../host/knowledge.js'

const RECORD = {
  id: 'mem_edit01',
  kind: 'fact',
  scope: 'project',
  topic: '存储',
  tags: ['jsonl', '索引'],
  content: '记忆采用 JSONL 作为权威存储。',
  status: 'active',
  confidence: 0.9,
  importance: 0.7,
}

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-memory-knowledge-edit-'))
  if (t !== undefined && typeof t.after === 'function') {
    t.after(() => rmSync(root, { recursive: true, force: true }))
  }
  const path = promoteMemoryToKnowledge(root, RECORD)
  return { root, path }
}

test('read returns editable title, rest, topic, tags and mtime', (t) => {
  const { root } = setup(t)
  const note = readKnowledgeNote(root, `${RECORD.id}.md`)
  assert.equal(note.title, '记忆采用 JSONL 作为权威存储。')
  assert.match(note.body, /## 关联/u)
  assert.equal(note.topic, '存储')
  assert.deepEqual(note.tags, ['jsonl', '索引'])
  assert.equal(note.memoryId, RECORD.id)
  assert.ok(Number.isFinite(note.mtimeMs) && note.mtimeMs > 0)
})

test('save updates the body, topic, tags and the topic wiki link', (t) => {
  const { root, path } = setup(t)
  const before = readKnowledgeNote(root, `${RECORD.id}.md`)
  const result = saveKnowledgeNote(root, {
    file: `${RECORD.id}.md`,
    title: '记忆的权威存储是 JSONL',
    body: '## 关联\n\n- [[存储]]\n\n补充：索引可重建。',
    topic: '持久化',
    tags: ['jsonl', '索引', '持久化', 'JSONL'],
    expectedMtimeMs: before.mtimeMs,
  })
  assert.equal(result.saved, true)
  assert.equal(result.title, '记忆的权威存储是 JSONL')
  assert.equal(result.topic, '持久化')
  assert.deepEqual(result.tags, ['jsonl', '索引', '持久化'])
  const text = readFileSync(path, 'utf8')
  assert.match(text, /dsh_knowledge: true/u)
  assert.match(text, /memoryId: "mem_edit01"/u)
  assert.match(text, /topic: "持久化"/u)
  assert.match(text, /- \[\[持久化\]\]/u)
  assert.doesNotMatch(text, /\[\[存储\]\]/u)
  assert.match(text, /补充：索引可重建/u)
})

test('a stale mtime returns a conflict and never overwrites', (t) => {
  const { root, path } = setup(t)
  const before = readKnowledgeNote(root, `${RECORD.id}.md`)
  writeFileSync(path, `${readFileSync(path, 'utf8')}\n外部追加\n`)
  const later = new Date(Date.now() + 2000)
  utimesSync(path, later, later)
  const result = saveKnowledgeNote(root, {
    file: `${RECORD.id}.md`,
    title: '面板写入',
    body: '',
    topic: '存储',
    tags: [],
    expectedMtimeMs: before.mtimeMs,
  })
  assert.equal(result.saved, false)
  assert.equal(result.reason, 'conflict')
  assert.equal(result.current.title, '记忆采用 JSONL 作为权威存储。')
  assert.match(readFileSync(path, 'utf8'), /外部追加/u)
})

test('save preserves unknown frontmatter keys', (t) => {
  const { root, path } = setup(t)
  const text = readFileSync(path, 'utf8').replace('createdAt:', 'custom: "keep-me"\ncreatedAt:')
  writeFileSync(path, text)
  const note = readKnowledgeNote(root, `${RECORD.id}.md`)
  saveKnowledgeNote(root, {
    file: `${RECORD.id}.md`,
    title: note.title,
    body: note.body,
    topic: note.topic,
    tags: note.tags,
    expectedMtimeMs: note.mtimeMs,
  })
  const saved = readFileSync(path, 'utf8')
  assert.match(saved, /custom: "keep-me"/u)
  assert.match(saved, /dsh_knowledge: true/u)
})

test('invalid names and empty titles are rejected', (t) => {
  const { root } = setup(t)
  assert.equal(isKnowledgeFile('../escape.md'), false)
  assert.equal(isKnowledgeFile('dir/note.md'), false)
  assert.equal(isKnowledgeFile('note.md'), true)
  assert.throws(() => readKnowledgeNote(root, '../escape.md'), /invalid knowledge note name/u)
  assert.throws(() => saveKnowledgeNote(root, { file: `${RECORD.id}.md`, title: '   ' }), /title is required/u)
  assert.throws(() => saveKnowledgeNote(root, { file: 'missing.md', title: 'x' }), /ENOENT/u)
})

test('splitNoteBody keeps leading blank lines out of the title', () => {
  assert.deepEqual(splitNoteBody('\n\n标题\n\n正文\n'), { title: '标题', rest: '正文' })
  assert.deepEqual(splitNoteBody('   '), { title: '', rest: '' })
})

test('list titles follow the edited first line', (t) => {
  const { root } = setup(t)
  const note = readKnowledgeNote(root, `${RECORD.id}.md`)
  saveKnowledgeNote(root, {
    file: note.file,
    title: '新的标题',
    body: note.body,
    topic: note.topic,
    tags: note.tags,
    expectedMtimeMs: note.mtimeMs,
  })
  const listed = listKnowledgeNotes(root)
  assert.equal(listed.length, 1)
  assert.equal(listed[0].title, '新的标题')
})

test('the saved file mode keeps the note private', (t) => {
  const { root, path } = setup(t)
  const note = readKnowledgeNote(root, `${RECORD.id}.md`)
  saveKnowledgeNote(root, { file: note.file, title: note.title, body: note.body, expectedMtimeMs: note.mtimeMs })
  const mode = statSync(path).mode & 0o777
  assert.equal(mode, 0o600)
})
