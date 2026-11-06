import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { exportToObsidian, importFromObsidian, parseMemoryNote, serializeMemory } from '../host/obsidian.js'
import { MemoryIndex } from '../host/search.js'
import { MemoryStore } from '../host/store.js'

const NOW = 1_700_000_000_000
const KEY = 'DSH-Obsidian-abc12345'

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-memory-obsidian-'))
  const vault = join(root, 'vault')
  rmSync(vault, { recursive: true, force: true })
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(vault, { recursive: true })
  const store = new MemoryStore({ root: join(root, 'data') }).open()
  const index = new MemoryIndex()
  const seed = (overrides) => {
    const built = store.write({
      kind: 'fact',
      scope: 'project',
      projectKey: KEY,
      content: '该仓库使用 pnpm 并要求 Node 24 以上',
      confidence: 0.9,
      importance: 0.7,
      ...overrides,
    }, { now: NOW })
    assert.equal(built.ok, true)
    index.upsert(built.record)
    return built.record
  }
  return { root, vault, store, index, seed }
}

test('export writes one markdown note per memory with frontmatter', (t) => {
  const { vault, store } = setup(t)
  const record = store.write({ kind: 'fact', scope: 'project', projectKey: KEY, content: '导出到 Obsidian 的记忆内容', topic: '存储', tags: ['jsonl'], confidence: 0.9, importance: 0.7 }, { now: NOW }).record
  const first = exportToObsidian({ store, vaultPath: vault, folder: 'DSH Memory' })
  assert.equal(first.written, 1)
  const file = join(vault, 'DSH Memory', `${record.id}.md`)
  const parsed = parseMemoryNote(readFileSync(file, 'utf8'))
  assert.equal(parsed.data.dsh_memory, true)
  assert.equal(parsed.data.id, record.id)
  assert.equal(parsed.data.topic, '存储')
  assert.deepEqual(parsed.data.tags, ['jsonl'])
  assert.match(parsed.body, /导出到 Obsidian/u)
  assert.ok(readdirSync(join(vault, 'DSH Memory')).includes('_index.md'))

  const second = exportToObsidian({ store, vaultPath: vault, folder: 'DSH Memory' })
  assert.equal(second.written, 0)
  assert.equal(second.skipped, 1)
})

test('import updates existing notes by id and creates new ones', (t) => {
  const { vault, store, index, seed } = setup(t)
  const record = seed({ content: '初始内容：使用 pnpm' })
  exportToObsidian({ store, vaultPath: vault, folder: 'DSH Memory' })
  const dir = join(vault, 'DSH Memory')
  const file = join(dir, `${record.id}.md`)
  const text = readFileSync(file, 'utf8').replace('初始内容：使用 pnpm', '修改后的内容：使用 pnpm 与 Node 24')
  writeFileSync(file, text)

  const dry = importFromObsidian({ store, index, vaultPath: vault, folder: 'DSH Memory', dryRun: true })
  assert.equal(dry.updated, 0)
  assert.equal(dry.preview.length, 1)
  assert.equal(dry.preview[0].action, 'update')

  const applied = importFromObsidian({ store, index, vaultPath: vault, folder: 'DSH Memory' })
  assert.equal(applied.updated, 1)
  assert.match(store.find(record.id, [{ scope: 'project', projectKey: KEY }]).content, /Node 24/u)

  const created = serializeMemory({
    ...record,
    id: 'mem_newobsidian01',
    content: '从 Obsidian 新建的一条记忆',
    createdAt: NOW,
    updatedAt: NOW,
  })
  writeFileSync(join(dir, 'mem_newobsidian01.md'), created)
  const createdResult = importFromObsidian({ store, index, vaultPath: vault, folder: 'DSH Memory' })
  assert.equal(createdResult.imported, 1)
  assert.equal(store.find('mem_newobsidian01', [{ scope: 'project', projectKey: KEY }]).content, '从 Obsidian 新建的一条记忆')
})

test('import skips non-DSH notes and path escapes are rejected', (t) => {
  const { vault, store, index } = setup(t)
  const dir = join(vault, 'DSH Memory')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, '普通笔记.md'), '# 普通 Obsidian 笔记\n\n不属于 DSH Memory。\n')
  const result = importFromObsidian({ store, index, vaultPath: vault, folder: 'DSH Memory' })
  assert.equal(result.scanned, 1)
  assert.equal(result.imported, 0)
  assert.equal(result.updated, 0)
  assert.throws(() => exportToObsidian({ store, vaultPath: vault, folder: '../escape' }), /inside the vault/u)
})

test('imports properties rewritten by the Obsidian property editor', (t) => {
  const { vault, store, index, seed } = setup(t)
  const record = seed({ tags: ['original'] })
  exportToObsidian({ store, vaultPath: vault, folder: 'DSH Memory' })
  const file = join(vault, 'DSH Memory', `${record.id}.md`)
  const text = readFileSync(file, 'utf8')
    .replace('tags: ["original"]', 'tags:\n  - dsh-memory-qa\n  - obsidian-ui')
    .replace('topic: null', "topic: 'Obsidian: 往返测试'")
    .replace('kind: fact', 'kind: decision')
  writeFileSync(file, text)
  const result = importFromObsidian({ store, index, vaultPath: vault, folder: 'DSH Memory' })
  assert.equal(result.updated, 1)
  const updated = store.find(record.id, [{ scope: 'project', projectKey: KEY }])
  assert.deepEqual(updated.tags, ['dsh-memory-qa', 'obsidian-ui'])
  assert.equal(updated.topic, 'Obsidian: 往返测试')
  assert.equal(updated.kind, 'decision')
})

test('reimporting identical normalized notes preserves revision and timestamps', (t) => {
  const { vault, store, index, seed } = setup(t)
  const record = seed({ content: '同一条记忆的重复导入保持不变', tags: ['original'] })
  exportToObsidian({ store, vaultPath: vault, folder: 'DSH Memory' })
  const file = join(vault, 'DSH Memory', `${record.id}.md`)
  writeFileSync(file, readFileSync(file, 'utf8').replace(record.content, '同一条记忆的重复导入\n\n保持不变'))
  importFromObsidian({ store, index, vaultPath: vault, folder: 'DSH Memory' })
  const before = store.find(record.id, [{ scope: 'project', projectKey: KEY }])
  const preview = importFromObsidian({ store, index, vaultPath: vault, folder: 'DSH Memory', dryRun: true })
  assert.equal(preview.preview.length, 0)
  const repeated = importFromObsidian({ store, index, vaultPath: vault, folder: 'DSH Memory' })
  assert.equal(repeated.updated, 0)
  assert.equal(repeated.skipped, 1)
  assert.deepEqual(store.find(record.id, [{ scope: 'project', projectKey: KEY }]), before)
})

test('invalid YAML is skipped and a new candidate retains its status', (t) => {
  const { vault, store, index, seed } = setup(t)
  const record = seed()
  exportToObsidian({ store, vaultPath: vault, folder: 'DSH Memory' })
  const dir = join(vault, 'DSH Memory')
  writeFileSync(join(dir, `${record.id}.md`), serializeMemory(record).replace('tags: []', 'tags: [broken'))
  writeFileSync(join(dir, 'mem_candidateqa.md'), serializeMemory({ ...record, id: 'mem_candidateqa', status: 'candidate' }))
  const result = importFromObsidian({ store, index, vaultPath: vault, folder: 'DSH Memory' })
  assert.equal(result.skipped, 1)
  assert.equal(result.imported, 1)
  assert.equal(result.updated, 0)
  assert.deepEqual(store.find(record.id, [{ scope: 'project', projectKey: KEY }]), record)
  assert.equal(store.find('mem_candidateqa', [{ scope: 'project', projectKey: KEY }]).status, 'candidate')
})
