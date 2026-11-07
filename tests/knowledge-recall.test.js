import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { KnowledgeRecallIndex } from '../host/knowledge-recall.js'
import { promoteMemoryToKnowledge, readKnowledgeNote, saveKnowledgeNote } from '../host/knowledge.js'
import { MemoryStore } from '../host/store.js'

const PROJECT = 'project-alpha'

function setup(t, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-memory-knowledge-recall-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const now = Date.now()
  const store = new MemoryStore({ root, clock: () => now }).open()
  const saved = store.write({
    id: 'mem_scope01', kind: 'fact', scope: 'project', projectKey: PROJECT,
    content: 'Production database uses PostgreSQL 16 for the primary application service.',
    status: 'active', confidence: 0.95, ...overrides,
  }, { now })
  assert.equal(saved.ok, true)
  const file = promoteMemoryToKnowledge(root, saved.record)
  const index = new KnowledgeRecallIndex(root, store)
  return { root, now, store, file, index, record: saved.record }
}

test('linked knowledge notes inherit parent effective time and quotation eligibility', (t) => {
  const future = setup(t, { validFrom: Date.now() + 60_000 })
  assert.equal(future.index.search('PostgreSQL', { projectKey: PROJECT, now: future.now }).length, 0)

  const expired = setup(t)
  const oldHit = expired.index.search('PostgreSQL', { projectKey: PROJECT, now: expired.now })[0]
  assert.ok(oldHit)
  expired.store.update(expired.record.id, { validTo: expired.now - 1 }, [{ scope: 'project', projectKey: PROJECT }])
  assert.equal(expired.index.validate(oldHit, PROJECT, expired.now), false)
  assert.equal(expired.index.search('PostgreSQL', { projectKey: PROJECT, now: expired.now }).length, 0)

  const quoted = setup(t, { quoted: true })
  assert.equal(quoted.index.search('PostgreSQL', { projectKey: PROJECT, now: quoted.now }).length, 0)
})

test('sensitive note edits are rejected by direct search validation', (t) => {
  const { root, now, index, file } = setup(t)
  const hit = index.search('PostgreSQL', { projectKey: PROJECT, now })[0]
  assert.ok(hit)
  const note = readKnowledgeNote(root, file.split('/').at(-1))
  saveKnowledgeNote(root, {
    file: note.file, title: 'PostgreSQL api_key=private-example-token', body: note.body,
    topic: note.topic, tags: note.tags, expectedMtimeMs: note.mtimeMs,
  })
  assert.equal(index.validate(hit, PROJECT, now), false)
  index.refresh()
  assert.equal(index.search('PostgreSQL', { projectKey: PROJECT, now }).length, 0)
})
