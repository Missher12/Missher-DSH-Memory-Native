import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MemoryStore } from '../host/store.js'
import { isValidProjectKey } from '../host/paths.js'

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'memory-import-integrity-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const store = new MemoryStore({ root }).open()
  const row = store.write({ kind: 'fact', scope: 'global', content: '完整导入验证用的原有事实。', confidence: .9 }).record
  return { root, store, row }
}
const payload = records => ({ schemaVersion: 2, global: records, projects: {} })

test('invalid later import rows reject the entire input before any mutation', t => {
  const { root, store, row } = setup(t), file = join(root, 'global', 'memories.jsonl'), before = readFileSync(file)
  const valid = { ...row, id: 'mem_new_valid', content: '这条有效记录也必须等待整批校验。' }
  for (const invalid of [
    { ...row, id: 'mem_bad', kind: 'invented' },
    { ...row, id: 'mem_bad', revision: -1 },
    { ...row, id: '../outside' },
    { ...row, id: 'mem_bad', content: 42 },
    { ...row, id: 'mem_bad', confidence: 4 },
  ]) {
    assert.throws(() => store.importData(payload([valid, invalid])), /导入|记录/u)
    assert.deepEqual(readFileSync(file), before)
  }
})

test('future schemas and unsafe or contradictory scope containers cannot be imported', t => {
  const { root, store, row } = setup(t), file = join(root, 'global', 'memories.jsonl'), before = readFileSync(file)
  assert.throws(() => store.importData({ ...payload([row]), schemaVersion: 999 }), /版本/u)
  for (const key of ['.', '..', '__proto__']) {
    assert.equal(isValidProjectKey(key), false)
    assert.throws(() => store.importData({ schemaVersion: 2, global: [], projects: Object.fromEntries([[key, [{ ...row, scope: 'project', projectKey: key }]]]) }), /范围|项目/u)
  }
  assert.throws(() => store.importData(payload([{ ...row, scope: 'project', projectKey: 'other-project' }])), /范围/u)
  assert.deepEqual(readFileSync(file), before)
})

test('ordinary import cannot resurrect a locally deleted memory even with a higher revision', t => {
  const { store, row } = setup(t)
  store.remove(row.id, [{ scope: 'global' }])
  const incoming = payload([{ ...row, revision: 999 }])
  assert.equal(store.importData(incoming, { dryRun: true }).imported, 0)
  const result = store.importData(incoming)
  assert.equal(result.imported, 0); assert.equal(result.protectedDeleted, 1)
  assert.equal(store.find(row.id).status, 'deleted')
})
