import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { buildKnowledgeGraph, promoteMemoryToKnowledge, readKnowledgeNote } from '../host/knowledge.js'
import {
  exportKnowledgeToVault,
  importKnowledgeFromVault,
  knowledgeVaultDir,
  listVaultKnowledgeNotes,
} from '../host/obsidian.js'

const RECORD = {
  id: 'mem_sync01',
  kind: 'fact',
  scope: 'project',
  topic: '存储',
  tags: ['jsonl'],
  content: '记忆采用 JSONL 作为权威存储。',
  status: 'active',
  confidence: 0.9,
  importance: 0.7,
}

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-memory-knowledge-sync-'))
  const vault = mkdtempSync(join(tmpdir(), 'dsh-memory-vault-'))
  t.after(() => {
    rmSync(root, { recursive: true, force: true })
    rmSync(vault, { recursive: true, force: true })
  })
  const local = promoteMemoryToKnowledge(root, RECORD)
  return { root, vault, local, folder: 'DSH Memory' }
}

function options(ctx) {
  return { root: ctx.root, vaultPath: ctx.vault, folder: ctx.folder }
}

test('export copies knowledge notes and skips identical files', (t) => {
  const ctx = setup(t)
  const first = exportKnowledgeToVault(options(ctx))
  assert.equal(first.total, 1)
  assert.equal(first.written, 1)
  assert.equal(first.skipped, 0)
  const target = join(knowledgeVaultDir(ctx.vault, ctx.folder), `${RECORD.id}.md`)
  assert.equal(readFileSync(target, 'utf8'), readFileSync(ctx.local, 'utf8'))
  const second = exportKnowledgeToVault(options(ctx))
  assert.equal(second.written, 0)
  assert.equal(second.skipped, 1)
})

test('import copies new vault notes but reports conflicts instead of overwriting', (t) => {
  const ctx = setup(t)
  exportKnowledgeToVault(options(ctx))
  const vaultFile = join(knowledgeVaultDir(ctx.vault, ctx.folder), `${RECORD.id}.md`)
  const edited = readFileSync(vaultFile, 'utf8').replace('记忆采用 JSONL 作为权威存储。', '外部修改过的标题')
  writeFileSync(vaultFile, edited)

  const conflict = importKnowledgeFromVault(options(ctx))
  assert.equal(conflict.conflicts, 1)
  assert.equal(conflict.imported, 0)
  assert.equal(readKnowledgeNote(ctx.root, `${RECORD.id}.md`).title, '记忆采用 JSONL 作为权威存储。')

  rmSync(ctx.local)
  const imported = importKnowledgeFromVault(options(ctx))
  assert.equal(imported.imported, 1)
  assert.equal(imported.conflicts, 0)
  assert.equal(readKnowledgeNote(ctx.root, `${RECORD.id}.md`).title, '外部修改过的标题')
})

test('non-knowledge and private vault files are skipped', (t) => {
  const ctx = setup(t)
  const dir = knowledgeVaultDir(ctx.vault, ctx.folder)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'plain.md'), '# just a note\n')
  writeFileSync(join(dir, '_index.md'), '# index\n')
  writeFileSync(join(dir, 'bad-name.txt'), 'ignored')
  const result = importKnowledgeFromVault(options(ctx))
  assert.equal(result.imported, 0)
  assert.equal(result.conflicts, 0)
  assert.equal(listVaultKnowledgeNotes(ctx.vault, ctx.folder).length, 0)
})

test('vault listing exposes title, topic, tags and wiki links', (t) => {
  const ctx = setup(t)
  exportKnowledgeToVault(options(ctx))
  const notes = listVaultKnowledgeNotes(ctx.vault, ctx.folder)
  assert.equal(notes.length, 1)
  assert.equal(notes[0].source, 'vault')
  assert.equal(notes[0].file, `${RECORD.id}.md`)
  assert.equal(notes[0].title, '记忆采用 JSONL 作为权威存储。')
  assert.equal(notes[0].topic, '存储')
  assert.deepEqual(notes[0].links, ['存储'])
})

test('graph adds vault nodes and wiki edges to existing topic hubs', () => {
  const records = [{ id: 'mem_1', kind: 'fact', topic: '存储', status: 'active', content: 'x', tags: [], confidence: 0.9, updatedAt: 1 }]
  const notes = [
    { file: 'local.md', source: 'knowledge', title: '本地知识', topic: '存储', links: ['存储'] },
    { file: 'vault.md', source: 'vault', title: 'Vault 知识', topic: '存储', links: ['存储', '不存在的主题'] },
  ]
  const graph = buildKnowledgeGraph(records, { notes })
  const vault = graph.nodes.find((node) => node.id === 'vault:vault.md')
  assert.ok(vault !== undefined)
  assert.equal(vault.kind, 'vault')
  const wiki = graph.edges.filter((edge) => edge.type === 'wiki')
  assert.equal(wiki.length, 2)
  assert.ok(wiki.every((edge) => edge.target === 'topic:存储'))
})
