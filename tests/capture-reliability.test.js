import assert from 'node:assert/strict'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { CapturePipeline } from '../host/capture.js'
import {
  captureTaskIdOf,
  readCaptureTasks,
  readSource,
  readTurnIntakes,
  saveSource,
  writeCaptureTask,
} from '../host/capture-journal.js'
import { resolveConfig } from '../host/config.js'
import { projectIdentity } from '../host/paths.js'
import { MemoryIndex } from '../host/search.js'
import { MemoryStore } from '../host/store.js'

const NOW = 1_700_000_000_000
const CWD = '/tmp/capture-reliability'

function replyFor(items) {
  return JSON.stringify({ memories: items })
}

function fakeLlm(reply, options = {}) {
  let calls = 0
  const stream = async function* (input) {
    calls += 1
    if (options.failAt === calls) throw new Error('network reset before any delta')
    if (options.failAfterDeltaAt === calls) {
      yield { type: 'text-delta', text: '{"memories":[' }
      throw new Error('network reset after request was sent')
    }
    const text = typeof reply === 'function' ? reply(calls, input) : reply
    yield { type: 'text-delta', text }
    yield { type: 'finish', reason: { kind: options.finishKind ?? 'stop' }, usage: options.usage }
  }
  return {
    calls: () => calls,
    async resolveModelInfo() { return { reasoning: { efforts: [{ id: 'max' }, { id: 'low' }] } } },
    stream,
  }
}

function makePipeline(root, t, options = {}) {
  const clock = typeof options.clock === 'function' ? options.clock : () => NOW
  const store = new MemoryStore({ root, clock }).open()
  const index = new MemoryIndex().rebuild(store.listAll())
  const llm = options.llm ?? fakeLlm(options.reply ?? replyFor([]))
  const config = resolveConfig({ capture: { minTurnChars: 0, ...(options.capture ?? {}) }, ...(options.config ?? {}) })
  const pipeline = new CapturePipeline({
    store,
    index,
    config,
    ctx: { get: (key) => (key === 'llm' ? llm : undefined), logger: { info() {}, warn() {} } },
    clock,
    onExtraction: options.onExtraction,
  })
  return { store, index, llm, pipeline, config }
}

function sessionFor(id = 'session-a') {
  return {
    id,
    header: { cwd: CWD },
    requestHeader: () => ({ config: { provider: 'deepseek', model: 'chat' } }),
  }
}

function feed(pipeline, session, user, assistant = '好的。', options = {}) {
  pipeline.observe(session, {
    type: 'user/message',
    data: { id: options.userId, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: user }] },
  })
  pipeline.observe(session, {
    type: 'assistant/message',
    data: { message: { id: options.assistantId, role: 'assistant', source: { kind: 'assistant' }, content: [{ type: 'text', text: assistant }] } },
  })
  pipeline.observe(session, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
}

test('a long message is journaled in full and every segment is extracted', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-capture-reliable-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const long = 'A'.repeat(9000)
  const { pipeline, llm } = makePipeline(root, t, {
    config: { extraction: { maxInputTokens: 1000 } },
    reply: (call) => replyFor([{
      op: 'ADD', kind: 'fact', scope: 'project', content: `长消息分段提取事实第${call}条`, confidence: 0.8,
    }]),
  })
  feed(pipeline, sessionFor(), long)
  await pipeline.flush()

  assert.ok(llm.calls() >= 3, `expected all segments, got ${llm.calls()}`)
  const tasks = readCaptureTasks(root)
  assert.equal(tasks.length, llm.calls())
  assert.ok(tasks.every((task) => task.status === 'done'))
  const ids = [...new Set(tasks.flatMap((task) => task.sourceIds))]
  const sourceFiles = readdirSync(join(root, 'capture', 'sources')).filter((name) => name.endsWith('.json'))
  assert.equal(sourceFiles.length, 2)
  const persisted = ids.map((id) => readSource(root, id))
  assert.ok(persisted.some((source) => source.text === long))
  assert.ok(!persisted.some((source) => source.text.includes('已截断')))
})

test('budget exhaustion leaves tasks pending and resume finishes them', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-capture-budget-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const long = 'B'.repeat(9000)
  const { pipeline, llm } = makePipeline(root, t, {
    config: { extraction: { maxInputTokens: 1000 } },
    capture: { maxCallsPerDay: 1 },
    reply: (call) => replyFor([{ op: 'ADD', kind: 'fact', scope: 'project', content: `预算恢复事实第${call}条`, confidence: 0.8 }]),
  })
  feed(pipeline, sessionFor(), long)
  await pipeline.flush()
  assert.equal(llm.calls(), 1)
  const pending = readCaptureTasks(root).filter((task) => task.status === 'pending')
  assert.ok(pending.length >= 1)
  assert.match(pending[0].reason, /预算/u)

  pipeline.setConfig(resolveConfig({ capture: { minTurnChars: 0, maxCallsPerDay: 20 }, extraction: { maxInputTokens: 1000 } }))
  // Host lifecycle hook, not a test-only flush.
  await pipeline.resume()
  assert.ok(llm.calls() >= 3)
  assert.ok(readCaptureTasks(root).every((task) => task.status === 'done'))
})

test('a request with an unknown result is not retried automatically', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-capture-unknown-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const llm = fakeLlm(() => replyFor([]), { failAfterDeltaAt: 1 })
  const { pipeline } = makePipeline(root, t, { llm })
  feed(pipeline, sessionFor(), '记住：这个仓库要求 Node 22。')
  await pipeline.flush()
  const task = readCaptureTasks(root)[0]
  assert.equal(task.status, 'unknown')
  assert.equal(task.callState, 'unknown')
  assert.match(task.reason, /结果未知/u)
  await pipeline.flush()
  assert.equal(llm.calls(), 1)
  assert.equal(readCaptureTasks(root)[0].status, 'unknown')
  assert.equal(pipeline.retry(task.id).ok, false)
  assert.equal(pipeline.retry(task.id, { confirmUnknown: true }).ok, true)
  await pipeline.flush()
  assert.equal(llm.calls(), 2)
  assert.equal(readCaptureTasks(root)[0].status, 'done')
})

test('restart recovery marks requested tasks unknown and drains not-sent tasks', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-capture-restart-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const source = saveSource(root, { sessionId: 'session-a', messageId: 'm1', role: 'user', at: NOW, text: '记住：重启恢复测试。' })
  const source2 = saveSource(root, { sessionId: 'session-a', messageId: 'm2', role: 'user', at: NOW, text: '另一条重启恢复测试。' })
  const base = {
    sessionId: 'session-a',
    projectKey: projectIdentity(CWD).key,
    turnKey: 'restart',
    total: 2,
    sourceIds: [source.id],
    explicit: true,
    route: { provider: 'deepseek', model: 'chat' },
    attempts: 1,
  }
  const requested = {
    ...base,
    id: captureTaskIdOf({ sessionId: 'session-a', turnKey: 'restart', segmentIndex: 0, sourceIds: [source.id], total: 2 }),
    segment: { index: 0, total: 2, entries: [{ sourceId: source.id, from: 0, to: source.chars }] },
    status: 'running',
    callState: 'requested',
    lastCallAt: NOW,
  }
  const notSent = {
    ...base,
    id: captureTaskIdOf({ sessionId: 'session-a', turnKey: 'restart', segmentIndex: 1, sourceIds: [source2.id], total: 2 }),
    segment: { index: 1, total: 2, entries: [{ sourceId: source2.id, from: 0, to: source2.chars }] },
    status: 'running',
    callState: 'not-sent',
    route: { provider: 'deepseek', model: 'chat' },
  }
  writeCaptureTask(root, requested)
  writeCaptureTask(root, notSent)

  const { pipeline, llm } = makePipeline(root, t, { reply: replyFor([{ op: 'ADD', kind: 'fact', scope: 'project', content: '重启恢复测试事实', confidence: 0.9 }]) })
  const afterRecovery = readCaptureTasks(root)
  assert.equal(afterRecovery.find((task) => task.id === requested.id).status, 'unknown')
  assert.equal(afterRecovery.find((task) => task.id === notSent.id).status, 'pending')
  await pipeline.resume()
  assert.equal(llm.calls(), 1)
  assert.equal(readCaptureTasks(root).find((task) => task.id === notSent.id).status, 'done')
  assert.equal(readCaptureTasks(root).find((task) => task.id === requested.id).status, 'unknown')
})

test('replaying the same turn does not duplicate records or calls', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-capture-idempotent-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const { store, pipeline, llm } = makePipeline(root, t, {
    reply: replyFor([{ op: 'ADD', kind: 'fact', scope: 'project', content: '该仓库使用 pnpm 并要求 Node 22 以上', confidence: 0.9 }]),
  })
  const session = sessionFor()
  feed(pipeline, session, '记住：这个仓库用 pnpm，要求 Node 22 以上。', '好的。', { userId: 'u1', assistantId: 'a1' })
  await pipeline.flush()
  feed(pipeline, session, '记住：这个仓库用 pnpm，要求 Node 22 以上。', '好的。', { userId: 'u1', assistantId: 'a1' })
  await pipeline.flush()
  assert.equal(llm.calls(), 1)
  assert.equal(store.list('project', projectIdentity(CWD).key).length, 1)
  assert.equal(readCaptureTasks(root).length, 1)
})

test('assistant-only statements stay candidate and carry assistant evidence', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-capture-evidence-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const { store, pipeline } = makePipeline(root, t, {
    reply: replyFor([{ op: 'ADD', kind: 'fact', scope: 'project', content: 'Node 22 是项目的运行时要求', confidence: 0.95 }]),
  })
  feed(pipeline, sessionFor(), '你好，今天天气不错。', 'Node 22 是项目的运行时要求。', { userId: 'u1', assistantId: 'a1' })
  await pipeline.flush()
  const records = store.list('project', projectIdentity(CWD).key)
  assert.equal(records.length, 1)
  assert.equal(records[0].status, 'candidate')
  assert.equal(records[0].evidenceRole, 'assistant')
  assert.equal(records[0].sourceRefs[0].role, 'assistant')
  assert.equal(records[0].sourceRefs[0].messageId, 'a1')
  assert.match(records[0].sourceRefs[0].excerpt, /Node 22/u)
})

test('user statements keep a persistent source reference', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-capture-source-ref-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const { store, pipeline } = makePipeline(root, t, {
    reply: replyFor([{ op: 'ADD', kind: 'preference', scope: 'global', content: '用户要求所有回复使用中文', confidence: 0.9 }]),
  })
  feed(pipeline, sessionFor(), '以后所有回复都用中文。', '好的。', { userId: 'u1', assistantId: 'a1' })
  await pipeline.flush()
  const record = store.list('global', null)[0]
  assert.equal(record.evidenceRole, 'user')
  assert.equal(record.sourceRefs[0].role, 'user')
  assert.equal(record.sourceRefs[0].sessionId, 'session-a')
  assert.equal(record.sourceRefs[0].messageId, 'u1')
  assert.ok(record.sourceRefs[0].sourceId.startsWith('src_'))
  assert.match(record.sourceRefs[0].excerpt, /中文/u)
})

test('a rejected supersede replacement leaves the old record active', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-capture-supersede-fail-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const { store, pipeline } = makePipeline(root, t, { reply: replyFor([]) })
  const key = projectIdentity(CWD).key
  const old = store.write({ kind: 'fact', scope: 'project', projectKey: key, content: '该仓库要求 Node 22 以上', topic: '依赖', confidence: 0.9 }).record
  store.write({ kind: 'fact', scope: 'project', projectKey: key, content: '该仓库要求 Node 24 以上', topic: '依赖', confidence: 0.9 })
  const index = new MemoryIndex().rebuild(store.listAll())
  const longContent = '该仓库要求 Node 24 以上'.repeat(40)
  const llm = fakeLlm(replyFor([{ op: 'SUPERSEDE', targetId: old.id, kind: 'fact', scope: 'project', content: longContent, topic: '依赖', confidence: 0.9 }]))
  const pipeline2 = new CapturePipeline({
    store, index, config: resolveConfig({ capture: { minTurnChars: 0 } }),
    ctx: { get: (key2) => (key2 === 'llm' ? llm : undefined), logger: { info() {}, warn() {} } },
    clock: () => NOW,
  })
  feed(pipeline2, sessionFor(), '更正：该仓库现在要求 Node 24 以上。')
  await pipeline2.flush()
  assert.equal(store.find(old.id, [{ scope: 'project', projectKey: key }]).status, 'active')
  const current = store.list('project', key).find((record) => record.status === 'active' && record.content.includes('Node 24'))
  assert.ok(current !== undefined)
  const task = readCaptureTasks(root)[0]
  assert.equal(task.status, 'done')
  assert.equal(task.result.rejected, 1)
})

test('a forgotten statement is not resurrected by a pending task', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-capture-forget-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const { store, pipeline } = makePipeline(root, t, {
    reply: replyFor([{ op: 'ADD', kind: 'fact', scope: 'project', content: '该仓库使用 pnpm 管理依赖', confidence: 0.9 }]),
    capture: { maxCallsPerDay: 0 },
  })
  feed(pipeline, sessionFor(), '这个仓库用 pnpm 管理依赖。', '好的。', { userId: 'u1' })
  await pipeline.flush()
  assert.equal(store.listAll().length, 0)
  // Create a target tombstone manually, then let the pending task run.
  const seeded = store.write({ kind: 'fact', scope: 'project', projectKey: projectIdentity(CWD).key, content: '该仓库使用 pnpm 管理依赖', confidence: 0.9 }).record
  store.remove(seeded.id, [{ scope: 'project', projectKey: projectIdentity(CWD).key }])
  pipeline.setConfig(resolveConfig({ capture: { minTurnChars: 0, maxCallsPerDay: 10 } }))
  await pipeline.flush()
  const live = store.listAll().filter((record) => record.status !== 'deleted')
  assert.equal(live.length, 0)
  assert.equal(store.find(seeded.id, [{ scope: 'project', projectKey: projectIdentity(CWD).key }]).status, 'deleted')
})

test('A to B to A keeps history and the latest A active', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-capture-aba-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const contents = ['该仓库要求 Node 22 以上', '该仓库要求 Node 24 以上', '该仓库要求 Node 22 以上']
  const llm = fakeLlm((call) => replyFor([{ op: 'ADD', kind: 'fact', scope: 'project', content: contents[Math.min(call, 3) - 1], confidence: 0.9 }]))
  const { store, pipeline } = makePipeline(root, t, { llm })
  for (const text of ['记住：仓库要求 Node 22。', '更正：仓库要求 Node 24。', '改回：仓库还是要求 Node 22。']) {
    feed(pipeline, sessionFor(), text)
    await pipeline.flush()
  }
  const records = store.list('project', projectIdentity(CWD).key)
  assert.equal(records.length, 3)
  assert.equal(records.filter((record) => record.status === 'active').length, 1)
  assert.match(records.find((record) => record.status === 'active').content, /Node 22/u)
  assert.equal(records.filter((record) => record.status === 'superseded').length, 2)
})

test('provider usage is reported separately from the prompt estimate', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-capture-usage-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const seen = []
  const llm = fakeLlm(replyFor([{ op: 'ADD', kind: 'fact', scope: 'project', content: '该仓库使用 pnpm 并要求 Node 22 以上', confidence: 0.9 }]), {
    usage: { inputTokens: 640, outputTokens: 88, totalTokens: 728 },
  })
  const { pipeline } = makePipeline(root, t, { llm, onExtraction: (stats) => seen.push(stats) })
  feed(pipeline, sessionFor(), '记住：这个仓库用 pnpm，要求 Node 22 以上。')
  await pipeline.flush()
  assert.equal(seen.length, 1)
  assert.ok(seen[0].promptTokens > 0)
  assert.deepEqual(seen[0].usage, { inputTokens: 640, outputTokens: 88, totalTokens: 728 })
})

test('quoted user material is stored as candidate, not confirmed fact', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-capture-quoted-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const { store, pipeline } = makePipeline(root, t, {
    reply: replyFor([{ op: 'ADD', kind: 'fact', scope: 'project', content: 'Node 22 是项目的运行时要求', confidence: 0.95, quoted: true }]),
  })
  feed(pipeline, sessionFor(), '文档里说：“Node 22 是项目的运行时要求”。', '好的。')
  await pipeline.flush()
  const record = store.list('project', projectIdentity(CWD).key)[0]
  assert.equal(record.status, 'candidate')
  assert.equal(record.quoted, true)
})

test('different named objects are not superseded only because numbers differ', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-capture-entities-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const reply = (call) => replyFor([{
    op: 'ADD', kind: 'fact', scope: 'project', confidence: 0.9,
    content: call === 1 ? '服务 Alpha 端口 8080' : '服务 Beta 端口 9090',
  }])
  const { store, pipeline } = makePipeline(root, t, { reply })
  feed(pipeline, sessionFor(), '记住：服务 Alpha 端口 8080。')
  await pipeline.flush()
  feed(pipeline, sessionFor(), '记住：服务 Beta 端口 9090。')
  await pipeline.flush()
  const records = store.list('project', projectIdentity(CWD).key)
  assert.equal(records.length, 2)
  assert.ok(records.every((record) => record.status === 'active'))
})


test('capture disabled writes no source files', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-capture-off-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const { pipeline, llm } = makePipeline(root, t, {
    reply: replyFor([{ op: 'ADD', kind: 'fact', scope: 'project', content: '关闭采集不应写入', confidence: 0.9 }]),
    capture: { enabled: false },
  })
  feed(pipeline, sessionFor(), '记住：关闭采集测试。')
  await pipeline.flush()
  assert.equal(llm.calls(), 0)
  assert.equal(readCaptureTasks(root).length, 0)
  assert.ok(!existsSync(join(root, 'capture', 'sources')))
})

test('a missing source fails the task without sending a model request', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-capture-missing-source-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const { pipeline, llm } = makePipeline(root, t, {
    reply: replyFor([{ op: 'ADD', kind: 'fact', scope: 'project', content: '不应生成', confidence: 0.9 }]),
    capture: { maxCallsPerDay: 0 },
  })
  feed(pipeline, sessionFor(), '这个仓库用 pnpm 管理依赖。')
  await pipeline.flush()
  const task = readCaptureTasks(root)[0]
  assert.equal(task.status, 'pending')
  const sourceFile = join(root, 'capture', 'sources', `${task.sourceIds[0]}.json`)
  unlinkSync(sourceFile)
  pipeline.setConfig(resolveConfig({ capture: { minTurnChars: 0, maxCallsPerDay: 10 } }))
  await pipeline.flush()
  assert.equal(llm.calls(), 0)
  const failed = readCaptureTasks(root)[0]
  assert.equal(failed.status, 'failed')
  assert.equal(failed.callState, 'not-sent')
  assert.match(failed.reason, /来源原文无法回读/u)
})

test('a write failure during supersede leaves the old record active', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-capture-write-fail-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const { store, index, pipeline } = makePipeline(root, t, {
    reply: replyFor([{ op: 'SUPERSEDE', kind: 'fact', scope: 'project', content: '该仓库要求 Node 24 以上', confidence: 0.9 }]),
  })
  const key = projectIdentity(CWD).key
  const old = store.write({ kind: 'fact', scope: 'project', projectKey: key, content: '该仓库要求 Node 22 以上', confidence: 0.9 }).record
  const original = store.replace.bind(store)
  let failed = false
  store.replace = (targetId, record) => {
    if (!failed && targetId === old.id) {
      failed = true
      throw new Error('simulated disk failure')
    }
    return original(targetId, record)
  }
  feed(pipeline, sessionFor(), '更正：该仓库要求 Node 24 以上。')
  await pipeline.flush()
  const after = store.find(old.id, [{ scope: 'project', projectKey: key }])
  assert.equal(after.status, 'active')
  assert.equal(failed, true)
  const task = readCaptureTasks(root)[0]
  assert.equal(task.status, 'failed')
  assert.match(task.reason, /旧记录保持有效/u)
  assert.equal(store.list('project', key).filter((record) => record.status === 'active').length, 1)
})

test('a negation replaces the earlier statement and keeps both revisions', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-capture-negation-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const reply = (call) => replyFor([{
    op: 'ADD', kind: 'preference', scope: 'global', confidence: 0.9,
    content: call === 1 ? '用户接受使用 npm 管理依赖' : '用户不接受使用 npm 管理依赖',
  }])
  const { store, pipeline } = makePipeline(root, t, { reply })
  feed(pipeline, sessionFor(), '以后可以用 npm 管理依赖。')
  await pipeline.flush()
  feed(pipeline, sessionFor(), '以后不要用 npm 管理依赖。')
  await pipeline.flush()
  const records = store.list('global', null)
  assert.equal(records.length, 2)
  assert.equal(records.filter((record) => record.status === 'active').length, 1)
  assert.equal(records.filter((record) => record.status === 'superseded').length, 1)
  assert.match(records.find((record) => record.status === 'active').content, /不接受/u)
})

test('a terminal but unusable model response is a known failure, not unknown', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-capture-known-failure-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const llm = fakeLlm(() => replyFor([]), { finishKind: 'error' })
  const { pipeline } = makePipeline(root, t, { llm })
  feed(pipeline, sessionFor(), '这个仓库用 pnpm 管理依赖。')
  await pipeline.flush()
  const task = readCaptureTasks(root)[0]
  assert.equal(task.status, 'failed')
  assert.equal(task.callState, 'completed')
  assert.match(task.reason, /输出不可用/u)
  assert.equal(llm.calls(), 1)
})


test('capture.minTurnChars is enforced and explicit short turns still pass', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-capture-min-chars-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const { pipeline, llm } = makePipeline(root, t, {
    capture: { minTurnChars: 100 },
    reply: replyFor([{ op: 'ADD', kind: 'fact', scope: 'project', content: '短轮显式记忆', confidence: 0.9 }]),
  })
  feed(pipeline, sessionFor(), '简短的一句话。', '好的。', { userId: 'short-1' })
  await pipeline.flush()
  assert.equal(llm.calls(), 0)
  assert.equal(readCaptureTasks(root).length, 0)
  const skipped = readTurnIntakes(root).intakes[0]
  assert.equal(skipped.status, 'skipped')
  assert.match(skipped.reason, /minTurnChars/u)

  feed(pipeline, sessionFor(), '记住：简短但显式要求记忆。', '好的。', { userId: 'short-2' })
  await pipeline.flush()
  assert.equal(llm.calls(), 1)
  assert.equal(readCaptureTasks(root).length, 1)
})

test('corrupt task journal lines are reported as degraded instead of silently complete', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-capture-corrupt-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const { pipeline } = makePipeline(root, t)
  mkdirSync(join(root, 'capture'), { recursive: true })
  appendFileSync(join(root, 'capture', 'capture-tasks.jsonl'), 'not json\n', { encoding: 'utf8' })
  const status = pipeline.status()
  assert.equal(status.health.corruptTasks, 1)
  assert.equal(status.degraded, true)
})

test('a persisted completed result is replayed locally without another model call', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-capture-replay-result-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const source = saveSource(root, { sessionId: 'session-a', messageId: 'm1', role: 'user', at: NOW, text: '这个仓库使用 pnpm 管理依赖。' })
  const taskId = captureTaskIdOf({ sessionId: 'session-a', turnKey: 'replay', segmentIndex: 0, sourceIds: [source.id], total: 1 })
  writeCaptureTask(root, {
    id: taskId,
    sessionId: 'session-a',
    projectKey: projectIdentity(CWD).key,
    turnKey: 'replay',
    segment: { index: 0, total: 1, entries: [{ sourceId: source.id, from: 0, to: source.chars }] },
    sourceIds: [source.id],
    status: 'running',
    callState: 'completed',
    attempts: 1,
    route: { provider: 'qa', model: 'fake' },
    resultText: JSON.stringify({ memories: [{ op: 'ADD', kind: 'fact', scope: 'project', content: '该仓库使用 pnpm 管理依赖', confidence: 0.9 }] }),
    resultTruncated: false,
    promptTokens: 50,
    transcriptChars: source.chars,
  })
  const { store, pipeline, llm } = makePipeline(root, t, { reply: replyFor([]) })
  await pipeline.resume()
  assert.equal(llm.calls(), 0)
  assert.equal(readCaptureTasks(root)[0].status, 'done')
  assert.equal(store.list('project', projectIdentity(CWD).key).length, 1)
})

test('explicit re-provide after deletion is allowed while background revival stays blocked', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-capture-reauthorize-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  let current = NOW
  const { store, pipeline } = makePipeline(root, t, {
    clock: () => current,
    reply: replyFor([{ op: 'ADD', kind: 'fact', scope: 'project', content: '该仓库使用 pnpm 管理依赖', confidence: 0.9 }]),
  })
  feed(pipeline, sessionFor(), '记住：这个仓库用 pnpm 管理依赖。', '好的。', { userId: 'u1' })
  await pipeline.flush()
  const key = projectIdentity(CWD).key
  const record = store.list('project', key)[0]
  store.remove(record.id, [{ scope: 'project', projectKey: key }])
  current = NOW + 1000
  feed(pipeline, sessionFor(), '记住：这个仓库用 pnpm 管理依赖。', '好的。', { userId: 'u2' })
  await pipeline.flush()
  assert.equal(store.list('project', key).length, 1)
})
