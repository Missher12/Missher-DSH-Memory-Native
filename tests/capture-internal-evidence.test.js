import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { CapturePipeline } from '../host/capture.js'
import { readCaptureTasks, readSource } from '../host/capture-journal.js'
import { resolveConfig } from '../host/config.js'
import { MemoryIndex } from '../host/search.js'
import { MemoryStore } from '../host/store.js'

const NOW = 1_800_000_000_000
const CWD = '/tmp/internal-evidence-project'

async function pending(root, messages, minTurnChars = 0) {
  const store = new MemoryStore({ root, clock: () => NOW }).open()
  const holder = { llm: { async resolveModelInfo() { return {} } } }
  const pipeline = new CapturePipeline({
    store, index: new MemoryIndex().rebuild(store.listAll()),
    config: resolveConfig({ capture: { minTurnChars, maxCallsPerDay: 0 } }),
    clock: () => NOW, ctx: { get: () => holder.llm },
  })
  const session = { id: 'internal-session', header: { cwd: CWD }, requestHeader: () => ({ config: { provider: 'qa', model: 'fake' } }) }
  let seq = 1
  for (const message of messages) {
    const data = message.role === 'assistant'
      ? { message: { id: `a-${seq}`, role: 'assistant', source: { kind: message.kind ?? 'model' }, content: [{ type: 'text', text: message.text }] } }
      : { id: `u-${seq}`, role: 'user', source: { kind: message.kind ?? 'user' }, content: [{ type: 'text', text: message.text }] }
    pipeline.observe(session, { type: message.role === 'assistant' ? 'assistant/message' : 'user/message', seq, time: NOW + seq, data })
    seq += 1
  }
  pipeline.observe(session, { type: 'turn/end', seq, time: NOW + seq, data: { reason: { kind: 'completed' } } })
  await pipeline.flush()
  const task = readCaptureTasks(root)[0]
  return { store, pipeline, task, holder, sources: (task?.sourceIds ?? []).map((id) => readSource(root, id)) }
}

async function apply(root, task, pipeline, holder, item, sourceIds) {
  let calls = 0
  const llm = { async resolveModelInfo() { return {} }, async *stream() {
    calls += 1
    yield { type: 'text-delta', text: JSON.stringify({ memories: [{ ...item, evidence: sourceIds }], complete: true }) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  } }
  pipeline.setConfig(resolveConfig({ capture: { minTurnChars: 0, maxCallsPerDay: 100 } }))
  holder.llm = llm
  const retryResult = pipeline.retry(task.id)
  assert.equal(retryResult.ok, true)
  await pipeline.flush()
  return calls
}

test('internal memory evidence cannot become a user fact even when cited with a user question', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-internal-evidence-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const { store, pipeline, task, holder, sources } = await pending(root, [
    { role: 'user', text: '我们之前聊了什么？结束标记是什么？' },
    { role: 'user', kind: 'memory', text: '内部旧记忆：结束标记是 INTERNAL-SECRET-77。' },
  ])
  const user = sources.find((source) => source.sourceKind === 'user')
  const internal = sources.find((source) => source.sourceKind === 'memory')
  assert.ok(user && internal)
  await apply(root, task, pipeline, holder, {
    op: 'ADD', kind: 'fact', scope: 'global', content: '结束标记是 INTERNAL-SECRET-77', confidence: 0.95, importance: 0.8,
  }, [user.id, internal.id])
  assert.equal(store.listAll().filter((record) => record.status === 'active').length, 0)
  assert.equal(store.listAll({ includeDeleted: true }).some((record) => record.content.includes('INTERNAL-SECRET-77')), false)
})

test('mixed user question plus assistant suggestion is not confirmed user evidence', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-mixed-evidence-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const { store, pipeline, task, holder, sources } = await pending(root, [
    { role: 'user', text: '当前项目结束标记是什么？' },
    { role: 'assistant', text: '建议结束标记为 ASSIST-VALUE-55。' },
  ])
  const user = sources.find((source) => source.role === 'user')
  const assistant = sources.find((source) => source.role === 'assistant')
  await apply(root, task, pipeline, holder, {
    op: 'ADD', kind: 'fact', scope: 'global', content: '结束标记为 ASSIST-VALUE-55', confidence: 0.95, importance: 0.8,
  }, [user.id, assistant.id])
  assert.equal(store.listAll().filter((record) => record.status === 'active').length, 0)
  assert.equal(store.listAll().filter((record) => record.status === 'candidate').length, 1)
})

test('an internal Chinese preference is rejected even when the user question shares topic words', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-internal-chinese-evidence-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const { store, pipeline, task, holder, sources } = await pending(root, [
    { role: 'user', text: '我的回答长度偏好是什么？' },
    { role: 'user', kind: 'memory', text: '用户的回答长度偏好是简短。' },
  ])
  await apply(root, task, pipeline, holder, {
    op: 'ADD', kind: 'preference', scope: 'global', content: '用户的回答长度偏好是简短', confidence: 0.95, importance: 0.8,
  }, sources.map((source) => source.id))
  assert.equal(store.listAll().length, 0)
})

test('a genuine user fact still saves with an internal memory injection in the same turn', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-genuine-evidence-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const { store, pipeline, task, holder, sources } = await pending(root, [
    { role: 'user', text: '当前项目结束标记是 USER-VALUE-99。' },
    { role: 'user', kind: 'memory', text: '内部旧记忆：结束标记是 INTERNAL-OLD-11。' },
  ])
  const user = sources.find((source) => source.sourceKind === 'user')
  await apply(root, task, pipeline, holder, {
    op: 'ADD', kind: 'fact', scope: 'global', content: '结束标记是 USER-VALUE-99', confidence: 0.95, importance: 0.8,
  }, [user.id])
  const active = store.listAll().filter((record) => record.status === 'active')
  assert.equal(active.length, 1)
  assert.equal(active[0].content, '结束标记是 USER-VALUE-99')
  assert.equal(active[0].observedAt, user.at)
})

test('a decision cites the complete original sentences, including negation and reason, past the segment header', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-decision-quote-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const decision = '我决定先别升级 Node 24。'
  const reason = '因为转换器还不兼容。'
  const text = '🗂 这一段只是旧日报。'.repeat(32) + decision + reason
  const { store, pipeline, task, holder, sources } = await pending(root, [{ role: 'user', text }])
  const id = sources[0].id
  await apply(root, task, pipeline, holder, { kind: 'decision', scope: 'project',
    content: '升级 Node 24，因为转换器还不兼容', confidence: .95,
    quotes: [{ sourceId: id, text: '升级 Node 24' }, { sourceId: id, text: reason }] }, [id])
  const [record] = store.listAll()
  assert.equal(record.status, 'active')
  assert.equal(record.content, decision + ' ' + reason)
  assert.deepEqual(record.sourceRefs.map(r => text.slice(r.from, r.to)), [decision, reason])
  assert.equal(record.sourceRefs[0].from, text.indexOf(decision))
})

test('a matching source id does not authorize a different numeric value or unit', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-value-proof-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const text = '归档保留 114 天。'
  const { store, pipeline, task, holder, sources } = await pending(root, [{ role: 'user', text }])
  const id = sources[0].id
  await apply(root, task, pipeline, holder, { kind: 'fact', scope: 'project',
    content: '归档保留 14 年', confidence: .95, quotes: [{ sourceId: id, text }] }, [id])
  assert.ok(store.listAll().every(record => record.status !== 'active'))
})

test('ordinary short decisions use the normal budget; questions and an opt-out do not enqueue work', async (t) => {
  for (const [text, eligible] of [
    ['我们决定把压缩窗口改到 05:10，因为午后线路很拥堵。', true],
    ['如果我们决定改到 05:10 会更好吗？', false],
    ['我们决定改到 05:10？', false],
    ['我们决定改到 05:10。不要保存这次对话。', false],
  ]) {
    const root = mkdtempSync(join(tmpdir(), 'dsh-short-decision-'))
    t.after(() => rmSync(root, { recursive: true, force: true }))
    const { task } = await pending(root, [{ role: 'user', text }], 200)
    assert.equal(Boolean(task), eligible, text)
    if (task) { assert.equal(task.explicit, false); assert.equal(task.attempts, 0); assert.equal(task.status, 'pending') }
  }
})
