import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { CapturePipeline } from '../host/capture.js'
import { readCaptureTasks, writeCaptureTask } from '../host/capture-journal.js'
import { resolveConfig } from '../host/config.js'
import { projectIdentity } from '../host/paths.js'
import { MemoryIndex } from '../host/search.js'
import { MemoryStore } from '../host/store.js'

const NOW = 1_800_000_000_000
const CWD = '/tmp/completeness-project'

function makeFakeLlm(markers) {
  let calls = 0
  return {
    calls: () => calls,
    async resolveModelInfo() { return {} },
    async *stream({ messages }) {
      calls += 1
      const prompt = messages[0].content[0].text
      const transcript = prompt.split('## 本次对话')[1] ?? ''
      const found = markers.filter((marker) => transcript.includes(marker))
      const selected = found.slice(0, 4)
      const memories = selected.map((marker, index) => ({
        op: 'ADD', kind: 'fact', scope: 'project', content: `${marker} 是本项目已确认的事实`, confidence: 0.95, importance: 0.7,
      }))
      yield { type: 'text-delta', text: JSON.stringify({ memories }) }
      yield { type: 'finish', reason: { kind: found.length > 4 ? 'length' : 'stop' } }
    },
  }
}

test('a long turn split into three segments covers head/middle/tail facts across capped child tasks', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-completeness-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const markers = Array.from({ length: 10 }, (_, index) => `QA-FACT-${String(index + 1).padStart(2, '0')}`)
  const filler = '这是一段不含事实标记的填充文本。'.repeat(200)
  const text = markers.map((marker) => `${marker}：验收事实。${filler}`).join('')
  const llm = makeFakeLlm(markers)
  const store = new MemoryStore({ root, clock: () => NOW }).open()
  const index = new MemoryIndex().rebuild(store.listAll())
  const config = resolveConfig({ capture: { minTurnChars: 0, maxCallsPerDay: 100 } })
  const pipeline = new CapturePipeline({
    store, index, config, clock: () => NOW,
    ctx: { get: () => llm },
  })
  const session = {
    id: 'session-completeness',
    header: { cwd: CWD },
    requestHeader: () => ({ config: { provider: 'qa', model: 'fake' } }),
  }
  pipeline.observe(session, { type: 'user/message', seq: 1, time: NOW, data: { id: 'msg-1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] } })
  pipeline.observe(session, { type: 'assistant/message', seq: 2, time: NOW, data: { message: { id: 'msg-2', role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text: '收到。' }] } } })
  pipeline.observe(session, { type: 'turn/end', seq: 3, time: NOW, data: { reason: { kind: 'completed' } } })
  await pipeline.flush()

  const tasks = readCaptureTasks(root)
  assert.ok(new Set(tasks.map((task) => task.segment?.entries?.[0]?.sourceId)).size >= 1)
  assert.ok(tasks.length >= 4, `expected segment + continuation tasks, got ${tasks.length}`)
  assert.ok(tasks.some((task) => task.parentTaskId !== undefined), 'cap/truncation must create child tasks')
  assert.ok(tasks.some((task) => (task.segment?.entries?.length ?? 0) > 0))
  const records = store.listAll().filter((record) => record.status === 'active')
  for (const marker of markers) {
    assert.ok(records.some((record) => record.content.includes(marker)), `missing ${marker}`)
  }
  assert.equal(new Set(records.map((record) => record.id)).size, records.length)
  assert.ok(llm.calls() >= 3)
  assert.equal(projectIdentity(CWD).key, tasks[0].projectKey)
})

test('known empty max-tokens output preserves the receipt without paid recursive splitting', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-empty-max-tokens-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  let calls = 0
  const llm = {
    async resolveModelInfo() { return {} },
    async *stream() {
      calls += 1
      yield { type: 'finish', reason: { kind: 'max-tokens' }, usage: { inputTokens: 100, outputTokens: 0, totalTokens: 100 } }
    },
  }
  const store = new MemoryStore({ root, clock: () => NOW }).open()
  const index = new MemoryIndex().rebuild(store.listAll())
  const pipeline = new CapturePipeline({
    store, index,
    config: resolveConfig({ capture: { minTurnChars: 0, maxCallsPerDay: 100 } }),
    clock: () => NOW,
    ctx: { get: () => llm },
  })
  const session = { id: 'session-empty-max', header: { cwd: '/tmp/empty-max-project' }, requestHeader: () => ({ config: { provider: 'qa', model: 'fake' } }) }
  const text = '空输出预算测试。'.repeat(300)
  pipeline.observe(session, { type: 'user/message', seq: 1, time: NOW, data: { id: 'empty-1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] } })
  pipeline.observe(session, { type: 'turn/end', seq: 2, time: NOW, data: { reason: { kind: 'completed' } } })
  await pipeline.flush()
  const tasks = readCaptureTasks(root)
  assert.equal(tasks.length, 1)
  assert.ok(tasks.every((task) => task.status === 'partial'))
  assert.ok(tasks.every((task) => task.callState === 'completed'))
  assert.equal(tasks[0].resultUsage.totalTokens, 100)
  assert.equal(tasks[0].resultFinishKind, 'max-tokens')
  assert.equal(calls, 1)
})

test('internal-only segments are skipped without a paid model request', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-internal-only-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  let calls = 0
  const llm = { async resolveModelInfo() { return {} }, async *stream() { calls += 1; yield { type: 'finish', reason: { kind: 'stop' } } } }
  const store = new MemoryStore({ root, clock: () => NOW }).open()
  const pipeline = new CapturePipeline({
    store, index: new MemoryIndex(), config: resolveConfig({ capture: { minTurnChars: 0, maxCallsPerDay: 100 } }),
    clock: () => NOW, ctx: { get: () => llm },
  })
  const session = { id: 'session-internal-only', header: { cwd: '/tmp/internal-only-project' }, requestHeader: () => ({ config: { provider: 'qa', model: 'mock' } }) }
  pipeline.observe(session, {
    type: 'user/message', seq: 1, time: NOW,
    data: { id: 'internal-1', role: 'user', source: { kind: 'runtime-context' }, content: [{ type: 'text', text: '当前工作目录与工具说明，不含用户事实。'.repeat(200) }] },
  })
  pipeline.observe(session, {
    type: 'assistant/message', seq: 2, time: NOW,
    data: { message: { id: 'internal-2', role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text: '收到。' }] } },
  })
  pipeline.observe(session, { type: 'turn/end', seq: 3, time: NOW, data: { reason: { kind: 'completed' } } })
  await pipeline.flush()
  const tasks = readCaptureTasks(root)
  assert.ok(tasks.length >= 1)
  assert.ok(tasks.every((task) => task.status === 'skipped'))
  assert.equal(calls, 0)
})

test('parent settlement cascades through multilevel done children but stops at failed/unknown/leaf partial', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-settle-parents-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const store = new MemoryStore({ root, clock: () => NOW }).open()
  const pipeline = new CapturePipeline({
    store, index: new MemoryIndex(), config: resolveConfig({ capture: { minTurnChars: 0 } }),
    clock: () => NOW, ctx: { get: () => ({ async resolveModelInfo() { return {} } }) },
  })
  const idMap = { parent: '1', child: '2', 'leaf-a': '3', 'leaf-b': '4', parent2: '5', child2: '6', parent3: '7', child3: '8', parent4: '9', leaf4: 'a' }
  const id = (name) => `cap_${idMap[name].repeat(24)}`
  const task = (id, status, children = []) => ({
    id, sessionId: 's', projectKey: 'p', turnKey: id,
    segment: { index: 0, total: 1, entries: [] }, sourceIds: [],
    status, callState: 'completed', attempts: 1, explicit: true, route: null, createdAt: NOW,
    continuationTaskIds: children,
  })
  writeCaptureTask(root, task(id('parent'), 'partial', [id('child')]))
  writeCaptureTask(root, task(id('child'), 'partial', [id('leaf-a'), id('leaf-b')]))
  writeCaptureTask(root, task(id('leaf-a'), 'done'))
  writeCaptureTask(root, task(id('leaf-b'), 'done'))
  await pipeline.resume()
  let tasks = readCaptureTasks(root)
  assert.equal(tasks.find((entry) => entry.id === id('child')).status, 'done')
  assert.equal(tasks.find((entry) => entry.id === id('parent')).status, 'done')

  const root2 = mkdtempSync(join(tmpdir(), 'dsh-settle-blocked-'))
  t.after(() => rmSync(root2, { recursive: true, force: true }))
  const store2 = new MemoryStore({ root: root2, clock: () => NOW }).open()
  const pipeline2 = new CapturePipeline({
    store: store2, index: new MemoryIndex(), config: resolveConfig({ capture: { minTurnChars: 0 } }),
    clock: () => NOW, ctx: { get: () => ({ async resolveModelInfo() { return {} } }) },
  })
  writeCaptureTask(root2, task(id('parent2'), 'partial', [id('child2')]))
  writeCaptureTask(root2, task(id('child2'), 'failed'))
  writeCaptureTask(root2, task(id('parent3'), 'partial', [id('child3')]))
  writeCaptureTask(root2, task(id('child3'), 'unknown'))
  writeCaptureTask(root2, task(id('parent4'), 'partial', [id('leaf4')]))
  writeCaptureTask(root2, task(id('leaf4'), 'partial'))
  await pipeline2.resume()
  tasks = readCaptureTasks(root2)
  assert.equal(tasks.find((entry) => entry.id === id('parent2')).status, 'partial')
  assert.equal(tasks.find((entry) => entry.id === id('parent3')).status, 'partial')
  assert.equal(tasks.find((entry) => entry.id === id('parent4')).status, 'partial')
})

test('a terminal length receipt with empty text is known, not unknown', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-empty-length-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const llm = { async resolveModelInfo() { return {} }, async *stream() { yield { type: 'finish', reason: { kind: 'length' } } } }
  const store = new MemoryStore({ root, clock: () => NOW }).open()
  const pipeline = new CapturePipeline({
    store, index: new MemoryIndex(), config: resolveConfig({ capture: { minTurnChars: 0 } }),
    clock: () => NOW, ctx: { get: () => llm },
  })
  const session = { id: 'session-empty-length', header: { cwd: '/tmp/empty-length-project' }, requestHeader: () => ({ config: { provider: 'qa', model: 'fake' } }) }
  pipeline.observe(session, { type: 'user/message', seq: 1, time: NOW, data: { id: 'length-1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '长度终止回执测试。'.repeat(200) }] } })
  pipeline.observe(session, { type: 'turn/end', seq: 2, time: NOW, data: { reason: { kind: 'completed' } } })
  await pipeline.flush()
  const tasks = readCaptureTasks(root)
  assert.ok(tasks.length > 0)
  assert.equal(tasks.some((task) => task.status === 'unknown'), false)
  assert.ok(tasks.every((task) => task.callState === 'completed'))
})

test('a truncated non-JSON completion preserves the paid result and splits instead of failed', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-truncated-no-json-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  let calls = 0
  const llm = {
    async resolveModelInfo() { return {} },
    async *stream() {
      calls += 1
      if (calls === 1) {
        yield { type: 'text-delta', text: '模型先输出了解释性文字，但没有开始 JSON。'.repeat(40) }
        yield { type: 'finish', reason: { kind: 'length' }, usage: { inputTokens: 100, outputTokens: 800, totalTokens: 900 } }
      } else {
        yield { type: 'text-delta', text: '{"memories":[]}' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    },
  }
  const reports = []
  const store = new MemoryStore({ root, clock: () => NOW }).open()
  const pipeline = new CapturePipeline({
    store, index: new MemoryIndex(), config: resolveConfig({ capture: { minTurnChars: 0, maxCallsPerDay: 100 } }),
    clock: () => NOW, ctx: { get: () => llm }, onExtraction: (report) => reports.push(report),
  })
  const session = { id: 'session-truncated-no-json', header: { cwd: '/tmp/truncated-no-json-project' }, requestHeader: () => ({ config: { provider: 'qa', model: 'fake' } }) }
  pipeline.observe(session, {
    type: 'user/message', seq: 1, time: NOW,
    data: { id: 'trunc-1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '截断无 JSON 测试。'.repeat(220) }] },
  })
  pipeline.observe(session, { type: 'turn/end', seq: 2, time: NOW, data: { reason: { kind: 'completed' } } })
  await pipeline.flush()
  const tasks = readCaptureTasks(root)
  const parent = tasks.find((task) => task.continuationTaskIds?.length > 0)
  assert.ok(parent)
  assert.equal(parent.resultTruncated, true)
  assert.match(parent.resultText, /解释性文字/u)
  assert.equal(parent.resultUsage.totalTokens, 900)
  assert.ok(tasks.filter((task) => task.parentTaskId === parent.id).every((task) => task.status === 'done'))
  assert.equal(tasks.find((task) => task.id === parent.id).status, 'done')
  const parentReport = reports.find((report) => report.taskId === parent.id)
  assert.ok(parentReport)
  assert.equal(parentReport.calls, 1)
  assert.equal(parentReport.usage.totalTokens, 900)
})
