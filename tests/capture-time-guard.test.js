import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { CapturePipeline } from '../host/capture.js'
import { readCaptureTasks } from '../host/capture-journal.js'
import { resolveConfig } from '../host/config.js'
import { projectIdentity } from '../host/paths.js'
import { buildRecord } from '../host/records.js'
import { MemoryIndex } from '../host/search.js'
import { MemoryStore } from '../host/store.js'

const CWD = '/tmp/time-guard-project'
const KEY = projectIdentity(CWD).key
const T1 = 1_700_000_000_000
const T2 = T1 + 86_400_000

function fakeLlm(items) {
  return {
    async resolveModelInfo() { return {} },
    async *stream() {
      yield { type: 'text-delta', text: JSON.stringify({ memories: items }) }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
}

async function pendingTask(root, store, index, text, llm, sessionId) {
  const pipeline = new CapturePipeline({
    store, index: index ?? new MemoryIndex().rebuild(store.listAll()),
    config: resolveConfig({ capture: { minTurnChars: 0, maxCallsPerDay: 0 } }),
    clock: () => T1,
    ctx: { get: () => llm },
  })
  const session = { id: sessionId, header: { cwd: CWD }, requestHeader: () => ({ config: { provider: 'qa', model: 'fake' } }) }
  pipeline.observe(session, { type: 'user/message', seq: 1, time: T1, data: { id: `${sessionId}-1`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] } })
  pipeline.observe(session, { type: 'turn/end', seq: 2, time: T1, data: { reason: { kind: 'completed' } } })
  await pipeline.flush()
  return { pipeline, task: readCaptureTasks(root)[0] }
}

test('stale-source UPDATE/SUPERSEDE/auto-merge cannot overwrite newer observations', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-time-guard-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const store = new MemoryStore({ root, clock: () => T2 }).open()
  const index = new MemoryIndex()
  const oldText = '旧来源：项目使用 Node 22，项目使用 npm，项目部署版本为 1.0。'
  const llm = fakeLlm([])
  const { pipeline, task } = await pendingTask(root, store, index, oldText, llm, 'old-session')
  const sourceId = task.sourceIds[0]
  const targets = [
    buildRecord({ kind: 'fact', scope: 'project', projectKey: KEY, content: '项目使用 Node 24', confidence: 0.95, status: 'active' }, { now: T2, observedAt: T2, id: 'mem_new_node' }).record,
    buildRecord({ kind: 'fact', scope: 'project', projectKey: KEY, content: '项目使用 pnpm', confidence: 0.95, status: 'active' }, { now: T2, observedAt: T2, id: 'mem_new_pm' }).record,
    buildRecord({ kind: 'fact', scope: 'project', projectKey: KEY, content: '项目部署版本为 2.0', confidence: 0.95, status: 'active' }, { now: T2, observedAt: T2, id: 'mem_new_pref' }).record,
  ]
  for (const record of targets) { store.append(record); index.upsert(record) }
  const items = [
    { op: 'UPDATE', targetId: 'mem_new_node', kind: 'fact', scope: 'project', content: '项目使用 Node 22', confidence: 0.9, importance: 0.7, evidence: [sourceId] },
    { op: 'SUPERSEDE', targetId: 'mem_new_pm', kind: 'fact', scope: 'project', content: '项目使用 npm', confidence: 0.9, importance: 0.7, evidence: [sourceId] },
    { op: 'ADD', kind: 'fact', scope: 'project', content: '项目部署版本为 1.0', confidence: 0.9, importance: 0.7, evidence: [sourceId] },
  ]
  llm.stream = async function* () {
    yield { type: 'text-delta', text: JSON.stringify({ memories: items }) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  pipeline.setConfig(resolveConfig({ capture: { minTurnChars: 0, maxCallsPerDay: 100 } }))
  assert.equal(pipeline.retry(task.id).ok, true)
  await pipeline.flush()
  for (const target of targets) {
    const record = store.find(target.id, [{ scope: target.scope, projectKey: target.projectKey }])
    assert.equal(record.status, 'active')
    assert.equal(record.content, target.content)
    assert.equal(record.observedAt, T2)
  }
  const all = store.listAll({ includeDeleted: true })
  for (const oldContent of ['项目使用 Node 22', '项目使用 npm', '项目部署版本为 1.0']) {
    const historical = all.find((record) => record.content === oldContent)
    assert.ok(historical, `old fact should be preserved as history/candidate: ${oldContent}`)
    assert.equal(historical.status, 'candidate')
    assert.equal(historical.observedAt, T1)
  }
})

test('manual recovery cannot revive content the user deleted', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-time-guard-tombstone-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const store = new MemoryStore({ root, clock: () => T1 }).open()
  const index = new MemoryIndex()
  const text = '这个项目使用已删除的旧方案。'
  const llm = fakeLlm([])
  const { pipeline, task } = await pendingTask(root, store, index, text, llm, 'tombstone-session')
  const sourceId = task.sourceIds[0]
  const existing = buildRecord({ kind: 'fact', scope: 'project', projectKey: KEY, content: '这个项目使用已删除的旧方案。', confidence: 0.95, status: 'active' }, { now: T2, observedAt: T2, id: 'mem_deleted_guard' }).record
  store.append(existing)
  index.upsert(existing)
  store.remove(existing.id, [{ scope: 'project', projectKey: KEY }])
  index.remove(existing.id)
  llm.stream = async function* () {
    yield { type: 'text-delta', text: JSON.stringify({ memories: [{ op: 'ADD', kind: 'fact', scope: 'project', content: existing.content, confidence: 0.9, importance: 0.7, evidence: [sourceId] }] }) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  pipeline.setConfig(resolveConfig({ capture: { minTurnChars: 0, maxCallsPerDay: 100 } }))
  assert.equal(pipeline.retry(task.id).ok, true)
  await pipeline.flush()
  const deleted = store.find(existing.id, [{ scope: 'project', projectKey: KEY }])
  assert.equal(deleted.status, 'deleted')
  assert.equal(store.listAll().some((record) => record.content === existing.content), false)
})
