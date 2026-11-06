import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { CapturePipeline } from '../host/capture.js'
import { readCaptureTasks } from '../host/capture-journal.js'
import { resolveConfig } from '../host/config.js'
import { projectIdentity } from '../host/paths.js'
import { MemoryIndex } from '../host/search.js'
import { MemoryStore } from '../host/store.js'

test('failed replacement preserves authority and index; retry reuses the saved model result', async t => {
  const root = fs.mkdtempSync(join(tmpdir(), 'memory-atomic-replace-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const key = projectIdentity('/tmp/atomic-replacement').key
  const store = new MemoryStore({ root }).open()
  const old = store.write({ kind: 'fact', scope: 'project', projectKey: key, content: '这个仓库要求 Node 22 以上', confidence: 0.9 }).record
  const index = new MemoryIndex().rebuild(store.listAll())
  const authority = join(root, 'projects', key, 'memories.jsonl')
  const before = fs.readFileSync(authority, 'utf8')
  let calls = 0
  const llm = {
    async resolveModelInfo() { return {} },
    async *stream() {
      calls += 1
      yield { type: 'text-delta', text: JSON.stringify({ memories: [{ op: 'SUPERSEDE', targetId: old.id, kind: 'fact', scope: 'project', content: '这个仓库要求 Node 24 以上', confidence: 0.95 }] }) }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const capture = new CapturePipeline({ store, index, config: resolveConfig({ capture: { minTurnChars: 0 } }), ctx: { get: () => llm } })
  const session = { id: 'atomic-session', header: { cwd: '/tmp/atomic-replacement' }, requestHeader: () => ({ config: { provider: 'qa', model: 'fake' } }) }
  const write = fs.writeSync
  let injected = 0
  fs.writeSync = (fd, data, ...args) => {
    const text = Buffer.isBuffer(data) ? data.toString() : String(data)
    if (text.includes(old.id) && text.includes('"status":"superseded"')) {
      injected += 1
      throw Object.assign(new Error('simulated authority write failure'), { code: 'EIO' })
    }
    return write(fd, data, ...args)
  }
  syncBuiltinESMExports()
  try {
    capture.observe(session, { type: 'user/message', seq: 0, time: Date.now(), data: { id: 'atomic-user', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '更正：这个仓库要求 Node 24 以上。' }] } })
    capture.observe(session, { type: 'turn/end', seq: 1, time: Date.now(), data: { reason: { kind: 'completed' } } })
    await capture.flush()
  } finally {
    fs.writeSync = write
    syncBuiltinESMExports()
  }
  assert.ok(injected > 0, 'the authority write fault must actually occur')
  assert.equal(fs.readFileSync(authority, 'utf8'), before, 'a failed replacement must publish neither half')
  assert.deepEqual(store.list('project', key).filter(record => record.status === 'active').map(record => record.id), [old.id])
  assert.deepEqual(index.search('这个仓库要求 Node', { projectKey: key, scopes: ['project'], statuses: ['active'] }).map(hit => hit.record.id), [old.id])
  const task = readCaptureTasks(root)[0]
  assert.equal(task.status, 'failed')
  assert.equal(capture.retry(task.id).ok, true)
  await capture.flush()
  assert.equal(calls, 1, 'local write recovery must not repeat the paid request')
  const persisted = new MemoryStore({ root }).open()
  const active = persisted.list('project', key).filter(record => record.status === 'active')
  assert.equal(active.length, 1)
  assert.match(active[0].content, /Node 24/)
  assert.equal(persisted.find(old.id, [{ scope: 'project', projectKey: key }]).status, 'superseded')
  assert.equal(persisted.history(old.id, [{ scope: 'project', projectKey: key }]).length, 2)
  assert.equal(readCaptureTasks(root)[0].status, 'done')
})
