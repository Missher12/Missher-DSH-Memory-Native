import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CapturePipeline } from '../host/capture.js'
import { readCaptureTasks, updateCaptureTask } from '../host/capture-journal.js'
import { resolveConfig } from '../host/config.js'
import { MemoryStore } from '../host/store.js'
import { MemoryIndex } from '../host/search.js'
import { projectIdentity } from '../host/paths.js'

function fixture(t, { budget = 50, content = '这个仓库使用 pnpm 管理依赖', finish = 'stop' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'codex-memory-review-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  let now = 1_800_000_000_000
  let calls = 0
  const llm = {
    async resolveModelInfo() { return {} },
    async *stream() {
      calls += 1
      yield { type: 'text-delta', text: JSON.stringify({ memories: [{ op: 'ADD', kind: 'fact', scope: 'project', content, confidence: 0.95 }] }) }
      yield { type: 'finish', reason: { kind: finish } }
    },
  }
  const store = new MemoryStore({ root, clock: () => now }).open()
  const index = new MemoryIndex().rebuild(store.listAll())
  const config = (limit = budget) => resolveConfig({ capture: { minTurnChars: 0, maxCallsPerDay: limit } })
  const create = () => new CapturePipeline({ store, index, config: config(), clock: () => now, ctx: { get: () => llm } })
  const session = (cwd = '/tmp/review-a') => ({ id: `session-${cwd}`, header: { cwd }, requestHeader: () => ({ config: { provider: 'qa', model: 'fake' } }) })
  const feed = (pipeline, s = session(), id = 'message-1', text = '这个仓库使用 pnpm 管理依赖。') => {
    pipeline.observe(s, { type: 'user/message', data: { id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] } })
    pipeline.observe(s, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  }
  return { root, store, index, config, create, session, feed, calls: () => calls, advance: () => { now += 1000 } }
}

test('same native message replayed later must not trigger another model call', async t => {
  const f = fixture(t)
  const p = f.create()
  f.feed(p)
  await p.flush()
  f.advance()
  f.feed(p)
  await p.flush()
  assert.equal(f.calls(), 1)
})

for (const mode of ['explicit', 'manual', 'automatic', 'recovered-automatic']) test(`daily automatic allowance keeps ${mode} accounting across restart`, async t => {
  const f = fixture(t, { budget: 1 })
  const p = f.create()
  if (mode === 'manual') p.setConfig(f.config(0))
  f.feed(p, f.session(), 'budget-before', mode === 'explicit' ? '请记住：该项目使用 pnpm 管理依赖。' : '该项目使用 pnpm 管理依赖。')
  await p.flush()
  if (mode === 'manual') {
    assert.equal(p.retry(readCaptureTasks(f.root)[0].id).ok, true)
    await p.flush()
  }
  assert.equal(f.calls(), 1)
  if (mode === 'recovered-automatic') {
    const original = readCaptureTasks(f.root)[0]
    updateCaptureTask(f.root, original.id, { status: 'failed', resultText: undefined,
      automaticCallDay: undefined, automaticCalls: undefined })
    assert.equal(p.retry(original.id).ok, true)
    await p.flush()
    assert.equal(f.calls(), 2)
  }
  p.dispose()
  const next = f.create()
  t.after(() => next.dispose())
  f.feed(next, f.session(), 'budget-after', '该项目构建时使用 pnpm 管理依赖。')
  await next.flush()
  const tasks = readCaptureTasks(f.root)
  assert.equal(f.calls(), mode === 'automatic' ? 1 : 2)
  assert.equal(tasks.filter(t => t.status === 'pending').length, ['automatic', 'recovered-automatic'].includes(mode) ? 1 : 0)
})

test('completed turn survives shutdown before its asynchronous task enqueue', async t => {
  const f = fixture(t)
  const p = f.create()
  f.feed(p)
  p.dispose()
  await p.flush()
  const recovered = f.create()
  await recovered.resume()
  assert.ok(readCaptureTasks(f.root).length > 0, 'persisted source was orphaned: completed turn has no recoverable task')
  assert.equal(f.calls(), 1)
})

test('same project fact must be independently capturable in another project', async t => {
  const f = fixture(t)
  const p = f.create()
  f.feed(p, f.session('/tmp/review-a'))
  await p.flush()
  f.advance()
  f.feed(p, f.session('/tmp/review-b'))
  await p.flush()
  assert.equal(f.store.list('project', projectIdentity('/tmp/review-b').key).length, 1)
})

test('known partial extraction remains explicitly recoverable', async t => {
  const f = fixture(t, { finish: 'length' })
  const p = f.create()
  f.feed(p)
  await p.flush()
  const task = readCaptureTasks(f.root)[0]
  assert.equal(task.status, 'partial')
  assert.equal(p.retry(task.id).ok, true, 'partial is currently treated as already finished')
  await p.flush()
})

test('retry of a saved partial parent resumes only failed children without resetting an in-flight child', async t => {
  const f = fixture(t, { budget: 0 })
  const p = f.create()
  t.after(() => p.dispose())
  f.feed(p, f.session(), 'long-recovery', '用户确认该项目使用 pnpm 管理依赖。'.repeat(160))
  await p.flush()
  const original = readCaptureTasks(f.root)[0]
  updateCaptureTask(f.root, original.id, { status: 'failed', callState: 'completed', attempts: 1,
    resultText: 'Saved truncated response', resultTruncated: true, resultParseFailed: true })
  p.retry(original.id)
  await p.flush()
  const children = readCaptureTasks(f.root).filter(task => task.parentTaskId === original.id)
  assert.equal(children.length, 2)
  assert.ok(children.every(task => task.status === 'done'), 'manual children must bypass the automatic budget')
  updateCaptureTask(f.root, children[0].id, { status: 'failed', resultText: undefined, reason: 'known failure' })
  updateCaptureTask(f.root, children[1].id, { status: 'running', callState: 'requested' })
  updateCaptureTask(f.root, original.id, { status: 'partial' })
  const before = f.calls()
  p.retry(original.id)
  await p.flush()
  const tasks = readCaptureTasks(f.root)
  assert.equal(tasks.find(task => task.id === children[0].id).status, 'done')
  assert.equal(tasks.find(task => task.id === children[1].id).status, 'running')
  assert.equal(f.calls(), before + 1)
  assert.equal(tasks.find(task => task.id === original.id).attempts, 1)
})

test('explicit completion of an older unsplit partial authorizes bounded children', async t => {
  const f = fixture(t, { budget: 0 })
  const p = f.create()
  t.after(() => p.dispose())
  f.feed(p, f.session(), 'old-partial', '用户确认该项目使用 pnpm 管理依赖。'.repeat(160))
  await p.flush()
  const original = readCaptureTasks(f.root)[0]
  updateCaptureTask(f.root, original.id, { status: 'partial', callState: 'completed', attempts: 1,
    resultText: '{"memories":[]}', resultTruncated: false })
  p.retry(original.id)
  await p.flush()
  const tasks = readCaptureTasks(f.root)
  assert.ok(tasks.length > 1)
  assert.ok(tasks.every(task => task.status === 'done'))
  assert.equal(tasks.find(task => task.id === original.id).attempts, 1)
})

test('restart does not resend a known completed provider request', async t => {
  const f = fixture(t, { budget: 0 })
  const p = f.create()
  f.feed(p)
  await p.flush()
  const task = readCaptureTasks(f.root)[0]
  updateCaptureTask(f.root, task.id, { status: 'running', callState: 'completed', attempts: 1 })
  p.dispose()
  const recovered = f.create()
  recovered.setConfig(f.config(10))
  await recovered.resume()
  assert.equal(f.calls(), 0, 'completed -> not-sent caused an automatic duplicate request')
})

test('forgotten source cannot be revived by a pending paraphrase', async t => {
  const f = fixture(t, { budget: 0, content: '本项目的部署地点位于上海' })
  const p = f.create()
  f.feed(p, f.session(), 'm1', '本项目的部署地点是上海。')
  await p.flush()
  const task = readCaptureTasks(f.root)[0]
  const key = projectIdentity(f.session().header.cwd).key
  const record = f.store.write({
    kind: 'fact', scope: 'project', projectKey: key, content: '本项目部署在上海', confidence: 0.9,
    sourceRefs: [{ sourceId: task.sourceIds[0], sessionId: task.sessionId, role: 'user' }],
  }).record
  f.store.remove(record.id, [{ scope: 'project', projectKey: key }])
  p.setConfig(f.config(10))
  await p.flush()
  assert.equal(f.store.list('project', key).length, 0)
})

test('supersede interruption must not leave two current conflicting facts after recovery', async t => {
  const f = fixture(t, { content: '这个仓库要求 Node 24 以上' })
  const key = projectIdentity(f.session().header.cwd).key
  const old = f.store.write({ kind: 'fact', scope: 'project', projectKey: key, content: '这个仓库要求 Node 22 以上', confidence: 0.9 }).record
  const update = f.store.update.bind(f.store)
  f.store.update = (id, patch, scopes) => {
    if (id === old.id && patch.status === 'superseded') throw new Error('simulated failure after replacement append')
    return update(id, patch, scopes)
  }
  const p = f.create()
  f.feed(p, f.session(), 'm1', '更正：这个仓库要求 Node 24 以上。')
  await p.flush()
  p.dispose()
  f.store.update = update
  const recovered = f.create()
  await recovered.resume()
  const active = f.store.list('project', key).filter(record => record.status === 'active')
  assert.equal(active.length, 1)
})

test('live effective memory does not expose contradictory active facts while replacement repair is pending', async t => {
  const f = fixture(t, { content: '这个仓库要求 Node 24 以上' })
  const key = projectIdentity(f.session().header.cwd).key
  const old = f.store.write({ kind: 'fact', scope: 'project', projectKey: key, content: '这个仓库要求 Node 22 以上', confidence: 0.9 }).record
  f.index.upsert(old)
  const update = f.store.update.bind(f.store)
  f.store.update = (id, patch, scopes) => {
    if (id === old.id && patch.status === 'superseded') throw new Error('simulated failure after replacement append')
    return update(id, patch, scopes)
  }
  const p = f.create()
  f.feed(p, f.session(), 'm1', '更正：这个仓库要求 Node 24 以上。')
  await p.flush()
  const active = f.store.list('project', key).filter(record => record.status === 'active')
  assert.equal(active.length, 1, 'current process still exposes both versions before restart')
  const hits = f.index.search('这个仓库要求 Node', { statuses: ['active'], scopes: ['project'], projectKey: key })
  assert.equal(hits.length, 1, 'pre-step index still serves both versions before restart')
})

test('a non-user native message source must not become confirmed user evidence', async t => {
  const f = fixture(t)
  const p = f.create()
  const s = f.session()
  p.observe(s, { type: 'user/message', seq: 7, time: 1_800_000_000_000, data: {
    id: 'context-notice-7', role: 'user',
    source: { kind: 'model-selection', form: 'notice', summary: 'internal context' },
    content: [{ type: 'text', text: '这个仓库使用 pnpm 管理依赖。' }],
  } })
  p.observe(s, { type: 'turn/end', seq: 8, time: 1_800_000_000_100, data: { reason: { kind: 'completed' } } })
  await p.flush()
  const active = f.store.listAll().filter(record => record.status === 'active')
  assert.equal(active.length, 0, 'role=user alone must not certify the message as user-authored')
})
