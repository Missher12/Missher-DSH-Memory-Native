import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { CapturePipeline } from '../host/capture.js'
import { resolveConfig } from '../host/config.js'
import { projectIdentity } from '../host/paths.js'
import { MemoryIndex } from '../host/search.js'
import { MemoryStore } from '../host/store.js'

const NOW = 1_700_000_000_000

function fakeLlm(reply) {
  let calls = 0
  const llm = {
    calls: () => calls,
    async resolveModelInfo() {
      return { reasoning: { efforts: [{ id: 'max' }, { id: 'low' }] } }
    },
    async *stream() {
      calls += 1
      const text = typeof reply === 'function' ? reply() : reply
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  return llm
}

function setup(t, { reply, config: overrides = {}, cwd = '/tmp/project-a' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-memory-capture-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const store = new MemoryStore({ root, clock: () => NOW }).open()
  const index = new MemoryIndex().rebuild(store.listAll())
  const llm = fakeLlm(reply)
  const config = resolveConfig({
    capture: { minTurnChars: 0 },
    ...overrides,
  })
  const writes = []
  const capture = new CapturePipeline({
    store,
    index,
    config,
    ctx: { get: (key) => (key === 'llm' ? llm : undefined), logger: { info() {}, warn() {} } },
    clock: () => NOW,
    onWrite: () => writes.push(Date.now()),
  })
  const session = {
    id: 'session-1',
    header: { cwd },
    requestHeader: () => ({ config: { provider: 'deepseek', model: 'chat', reasoningEffort: 'max' } }),
  }
  return { store, index, llm, capture, session, writes, config }
}

function feed(capture, session, userText, assistantText = '好的，我记下了。') {
  capture.observe(session, { type: 'user/message', data: { content: [{ type: 'text', text: userText }] } })
  capture.observe(session, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: assistantText }] } } })
  capture.observe(session, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
}

const REPLY = JSON.stringify({ memories: [
  { op: 'ADD', kind: 'fact', scope: 'project', content: '该仓库使用 pnpm 并要求 Node 22 以上', tags: ['pnpm'], confidence: 0.9, importance: 0.7 },
] })

test('one completed turn produces one active memory', async (t) => {
  const { store, capture, session } = setup(t, { reply: REPLY })
  feed(capture, session, '记住：这个仓库用 pnpm，要求 Node 22 以上。')
  await capture.flush()

  const key = projectIdentity(session.header.cwd).key
  const records = store.list('project', key)
  assert.equal(records.length, 1)
  assert.equal(records[0].status, 'active')
  assert.match(records[0].content, /pnpm/u)
})

test('the reasoning effort is downgraded for the background call', async (t) => {
  const { llm, capture, session } = setup(t, { reply: REPLY })
  const seen = []
  const original = llm.stream
  llm.stream = async function* (options) {
    seen.push(options)
    yield* original(options)
  }
  feed(capture, session, '记住：这个仓库用 pnpm。')
  await capture.flush()
  assert.equal(seen.length, 1)
  assert.equal(seen[0].reasoningEffort, 'low')
})

test('a duplicate statement is not stored twice', async (t) => {
  const { store, capture, session } = setup(t, { reply: REPLY })
  feed(capture, session, '记住：这个仓库用 pnpm。')
  await capture.flush()
  feed(capture, session, '再确认一下，这个仓库用 pnpm。')
  await capture.flush()

  const key = projectIdentity(session.header.cwd).key
  assert.equal(store.list('project', key).length, 1)
})

test('UPDATE rewrites the target record instead of adding a second one', async (t) => {
  const holder = { reply: REPLY }
  const { store, capture, session } = setup(t, { reply: () => holder.reply })
  feed(capture, session, '记住：这个仓库用 pnpm。')
  await capture.flush()
  const key = projectIdentity(session.header.cwd).key
  const first = store.list('project', key)[0]
  assert.ok(first !== undefined)

  holder.reply = JSON.stringify({ memories: [
    { op: 'UPDATE', targetId: first.id, kind: 'fact', scope: 'project', content: '该仓库使用 pnpm 并要求 Node 24 以上', tags: ['pnpm'], confidence: 0.95, importance: 0.8 },
  ] })
  feed(capture, session, '更正：Node 版本要求是 24 以上。')
  await capture.flush()

  const records = store.list('project', key)
  assert.equal(records.length, 1)
  assert.match(records[0].content, /Node 24/u)
  assert.equal(records[0].revision, 2)
})

test('credential-looking content is rejected', async (t) => {
  const reply = JSON.stringify({ memories: [
    { op: 'ADD', kind: 'fact', scope: 'project', content: 'api_key = sk-abcdefghijklmnopqrstuvwxyz', confidence: 0.9 },
  ] })
  const { store, capture, session } = setup(t, { reply })
  feed(capture, session, '记住我的 key')
  await capture.flush()
  assert.equal(store.list('project', projectIdentity(session.header.cwd).key).length, 0)
})

test('budget exhaustion skips non-explicit turns', async (t) => {
  const { llm, capture, session } = setup(t, { reply: REPLY, config: { capture: { minTurnChars: 0, maxCallsPerDay: 0 } } })
  feed(capture, session, '这是一个普通的长对话，没有显式要求记忆。')
  await capture.flush()
  assert.equal(llm.calls(), 0)
})

test('an explicit remember request bypasses the exhausted budget', async (t) => {
  const { llm, capture, session } = setup(t, { reply: REPLY, config: { capture: { minTurnChars: 0, maxCallsPerDay: 0 } } })
  feed(capture, session, '记住：这个仓库用 pnpm。')
  await capture.flush()
  assert.equal(llm.calls(), 1)
})

test('an incomplete turn is ignored', async (t) => {
  const { llm, capture, session } = setup(t, { reply: REPLY })
  capture.observe(session, { type: 'user/message', data: { content: [{ type: 'text', text: '记住：这个仓库用 pnpm。' }] } })
  capture.observe(session, { type: 'turn/end', data: { reason: { kind: 'aborted' } } })
  await capture.flush()
  assert.equal(llm.calls(), 0)
})

test('near-duplicate statements merge into one record and raise confidence', async (t) => {
  let call = 0
  const reply = () => {
    call += 1
    const content = call === 1 ? '用户偏好简洁直接的表达方式' : '用户偏好简洁、直接的表达方式。'
    return JSON.stringify({ memories: [
      { op: 'ADD', kind: 'preference', scope: 'global', content, tags: ['style'], confidence: 0.8, importance: 0.6 },
    ] })
  }
  const { store, capture, session } = setup(t, { reply })
  feed(capture, session, '记住：我喜欢简洁直接的回答。')
  await capture.flush()
  feed(capture, session, '以后回答都简洁直接一点。')
  await capture.flush()

  const preferences = store.listAll().filter((record) => record.kind === 'preference')
  assert.equal(preferences.length, 1)
  assert.ok(preferences[0].confidence >= 0.85)
  assert.match(preferences[0].content, /简洁/u)
})

test('a long turn is extracted in chunks', async (t) => {
  let call = 0
  const reply = () => {
    call += 1
    const content = call === 1 ? '第一段对话涉及项目依赖管理' : '第二段对话涉及部署与版本约束'
    return JSON.stringify({ memories: [
      { op: 'ADD', kind: 'fact', scope: 'project', content, tags: [], confidence: 0.85, importance: 0.6 },
    ] })
  }
  const { store, capture, session, llm } = setup(t, { reply, config: { extraction: { maxInputTokens: 1000 } } })
  const long = '这是一段很长的用户描述，'.repeat(300)
  capture.observe(session, { type: 'user/message', data: { content: [{ type: 'text', text: long }] } })
  capture.observe(session, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '收到，继续。' }] } } })
  capture.observe(session, { type: 'user/message', data: { content: [{ type: 'text', text: long }] } })
  capture.observe(session, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '好的。' }] } } })
  capture.observe(session, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  await capture.flush()

  assert.equal(llm.calls(), 2)
  const records = store.list('project', projectIdentity(session.header.cwd).key)
  assert.equal(records.length, 2)
})

test('the daily budget stops mid-turn chunking', async (t) => {
  const reply = () => JSON.stringify({ memories: [
    { op: 'ADD', kind: 'fact', scope: 'project', content: '预算受限的抽取测试', tags: [], confidence: 0.85, importance: 0.6 },
  ] })
  const { capture, session, llm } = setup(t, { reply, config: { extraction: { maxInputTokens: 1000 }, capture: { maxCallsPerDay: 1 } } })
  const long = '这是一段很长的用户描述，'.repeat(300)
  capture.observe(session, { type: 'user/message', data: { content: [{ type: 'text', text: long }] } })
  capture.observe(session, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '收到。' }] } } })
  capture.observe(session, { type: 'user/message', data: { content: [{ type: 'text', text: long }] } })
  capture.observe(session, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  await capture.flush()

  assert.equal(llm.calls(), 1)
})

test('a very long turn is extracted before turn/end', async (t) => {
  const reply = JSON.stringify({ memories: [
    { op: 'ADD', kind: 'fact', scope: 'project', content: '增量抽取测试记录一条', tags: [], confidence: 0.85, importance: 0.6 },
  ] })
  const { store, capture, session, llm } = setup(t, { reply })
  const long = '这是一段很长的用户描述，'.repeat(300)
  for (let index = 0; index < 6; index += 1) {
    capture.observe(session, { type: 'user/message', data: { content: [{ type: 'text', text: long }] } })
    capture.observe(session, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '收到。' }] } } })
  }
  await capture.flush()

  assert.ok(llm.calls() >= 1)
  const records = store.list('project', projectIdentity(session.header.cwd).key)
  assert.ok(records.length >= 1)
})

test('preferences merge in the 0.85–0.9 gray zone while facts stay separate', async (t) => {
  const statements = [
    '用户偏好简洁、直接、不绕弯子的中文表达方式，避免客套话',
    '用户偏好简洁、直接、不绕弯子的中文表达方式，避免客套语气',
  ]
  const run = async (kind) => {
    let call = 0
    const reply = () => {
      const content = statements[Math.min(call, statements.length - 1)]
      call += 1
      return JSON.stringify({ memories: [
        { op: 'ADD', kind, scope: 'global', content, tags: [], confidence: 0.8, importance: 0.6 },
      ] })
    }
    const setupResult = setup(t, { reply })
    feed(setupResult.capture, setupResult.session, '记住：我喜欢简洁直接的回答。')
    await setupResult.capture.flush()
    feed(setupResult.capture, setupResult.session, '以后都简洁直接一点。')
    await setupResult.capture.flush()
    return setupResult.store.listAll().filter((record) => record.kind === kind)
  }

  const preferences = await run('preference')
  assert.equal(preferences.length, 1)
  assert.ok(Math.abs(preferences[0].confidence - 0.85) < 1e-9)

  const facts = await run('fact')
  assert.equal(facts.length, 2)
})

test('a changed value supersedes the old statement instead of merging', async (t) => {
  let call = 0
  const reply = () => {
    call += 1
    const content = call === 1 ? '该仓库要求 Node 22 以上' : '该仓库要求 Node 24 以上'
    return JSON.stringify({ memories: [
      { op: 'ADD', kind: 'fact', scope: 'project', content, tags: [], confidence: 0.9, importance: 0.7 },
    ] })
  }
  const { store, capture, session } = setup(t, { reply })
  feed(capture, session, '记住：这个仓库要求 Node 22 以上。')
  await capture.flush()
  feed(capture, session, '更正：这个仓库现在要求 Node 24 以上。')
  await capture.flush()

  const records = store.list('project', projectIdentity(session.header.cwd).key)
  assert.equal(records.length, 2)
  const old = records.find((record) => record.content.includes('22'))
  const fresh = records.find((record) => record.content.includes('24'))
  assert.equal(old.status, 'superseded')
  assert.equal(fresh.status, 'active')
  assert.equal(fresh.supersedesId, old.id)
})


test('setConfig disables capture at runtime', async (t) => {
  const { capture, session, llm } = setup(t, { reply: REPLY })
  capture.setConfig(resolveConfig({ capture: { enabled: false } }))
  feed(capture, session, '记住：这个仓库用 pnpm，要求 Node 22 以上。')
  await capture.flush()
  assert.equal(llm.calls(), 0)
})
