import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { CapturePipeline } from '../host/capture.js'
import { readCaptureTasks, updateCaptureTask, writeCaptureTask } from '../host/capture-journal.js'
import { parseExtraction } from '../host/extract.js'
import { resolveConfig } from '../host/config.js'
import { MemoryIndex } from '../host/search.js'
import { MemoryStore } from '../host/store.js'

const CWD = '/tmp/completion-marker-project'
const T = 1_800_000_000_000

function pipelineFor(root, llm) {
  const store = new MemoryStore({ root, clock: () => T }).open()
  return {
    store,
    pipeline: new CapturePipeline({
      store, index: new MemoryIndex().rebuild(store.listAll()),
      config: resolveConfig({ capture: { minTurnChars: 0, maxCallsPerDay: 100 } }),
      clock: () => T, ctx: { get: () => llm },
    }),
  }
}

async function feed(pipeline, text, id = 'completion-msg') {
  const session = { id: 'completion-session', header: { cwd: CWD }, requestHeader: () => ({ config: { provider: 'qa', model: 'fake' } }) }
  pipeline.observe(session, { type: 'user/message', seq: 1, time: T, data: { id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] } })
  pipeline.observe(session, { type: 'turn/end', seq: 2, time: T, data: { reason: { kind: 'completed' } } })
  await pipeline.flush()
}

function item(index, complete) {
  return { op: 'ADD', kind: 'fact', scope: 'project', topic: `主题${index}`, content: `第${index}条独立事实：项目配置项 X${index} 已确认`, confidence: 0.9, importance: 0.7 }
}

test('exactly four items with complete=true are done, not split', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-complete-true-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const items = [0, 1, 2, 3].map((i) => item(i))
  const llm = { async resolveModelInfo() { return {} }, async *stream() {
    yield { type: 'text-delta', text: JSON.stringify({ memories: items, complete: true }) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  } }
  const { store, pipeline } = pipelineFor(root, llm)
  await feed(pipeline, '这一段有四条已确认事实：第0条独立事实：项目配置项 X0 已确认，第1条独立事实：项目配置项 X1 已确认，第2条独立事实：项目配置项 X2 已确认，第3条独立事实：项目配置项 X3 已确认。')
  const tasks = readCaptureTasks(root)
  assert.equal(tasks[0].status, 'done')
  assert.equal(tasks[0].continuationTaskIds?.length ?? 0, 0)
  assert.equal(store.listAll().filter((record) => record.status === 'active').length, 4)
})

test('complete=false on a dense segment uses a bounded applied-only completion prompt', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-complete-false-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  let calls = 0
  const prompts = []
  const llm = { async resolveModelInfo() { return {} }, async *stream({ messages }) {
    calls += 1
    const prompt = messages[0].content[0].text
    prompts.push(prompt)
    if (calls === 1) {
      yield { type: 'text-delta', text: JSON.stringify({ memories: [0, 1, 2, 3].map((i) => item(i)), complete: false }) }
    } else {
      yield { type: 'text-delta', text: JSON.stringify({ memories: [item(4)], complete: true }) }
    }
    yield { type: 'finish', reason: { kind: 'stop' } }
  } }
  const { store, pipeline } = pipelineFor(root, llm)
  await feed(pipeline, '旧段已确认事实：第0条独立事实：项目配置项 X0 已确认，第1条独立事实：项目配置项 X1 已确认，第2条独立事实：项目配置项 X2 已确认，第3条独立事实：项目配置项 X3 已确认，第4条独立事实：项目配置项 X4 已确认。')
  const tasks = readCaptureTasks(root)
  const parent = tasks.find((task) => task.continuationTaskIds?.length > 0)
  assert.ok(parent)
  assert.match(prompts[1], /本段已应用，勿重复/u)
  assert.match(prompts[1], /第0条独立事实/u)
  const child = tasks.find((task) => task.parentTaskId === parent.id)
  assert.equal(child.completionDepth, 1)
  assert.ok(child.appliedContents.includes('第0条独立事实：项目配置项 X0 已确认'))
  assert.equal(child.status, 'done')
  assert.equal(parent.status, 'done')
  assert.equal(store.listAll().filter((record) => record.status === 'active').length, 5)
})

test('provider truncation cannot be made complete by a marker', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-complete-truncated-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const llm = { async resolveModelInfo() { return {} }, async *stream() {
    yield { type: 'text-delta', text: JSON.stringify({ memories: [0, 1, 2, 3].map((i) => item(i)), complete: true }) }
    yield { type: 'finish', reason: { kind: 'length' } }
  } }
  const { pipeline } = pipelineFor(root, llm)
  await feed(pipeline, '截断标记测试。'.repeat(100))
  const tasks = readCaptureTasks(root)
  assert.equal(tasks[0].status, 'partial')
  assert.ok(tasks.some((task) => task.parentTaskId === tasks[0].id))
})

test('a completion round with no new facts stops instead of paying forever', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-complete-no-progress-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const llm = { async resolveModelInfo() { return {} }, async *stream() {
    yield { type: 'text-delta', text: JSON.stringify({ memories: [item(0)], complete: false }) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  } }
  const { pipeline } = pipelineFor(root, llm)
  await feed(pipeline, '旧段已确认事实：第0条独立事实：项目配置项 X0 已确认。')
  const tasks = readCaptureTasks(root)
  const parent = tasks.find((task) => task.continuationTaskIds?.length > 0)
  assert.ok(parent)
  assert.equal(parent.status, 'partial')
  const children = tasks.filter((task) => task.parentTaskId === parent.id)
  assert.ok(children.length >= 1)
  assert.ok(children.every((child) => child.status !== 'running'))
  assert.ok(tasks.filter((task) => task.completionDepth).length <= 2)
})

for (const throughParent of [false, true]) test(`explicit retry of an old unmarked partial keeps its paid result (${throughParent ? 'parent' : 'leaf'})`, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-old-partial-retry-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  let calls = 0
  const llm = { async resolveModelInfo() { return {} }, async *stream() {
    calls += 1
    yield { type: 'text-delta', text: JSON.stringify({ memories: [], complete: true }) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  } }
  const { pipeline } = pipelineFor(root, llm)
  pipeline.setConfig(resolveConfig({ capture: { minTurnChars: 0, maxCallsPerDay: 0 } }))
  await feed(pipeline, '旧 partial 已确认事实：第0条独立事实：项目配置项 X0 已确认。')
  const original = readCaptureTasks(root)[0]
  assert.equal(original.status, 'pending')
  const text = JSON.stringify({ memories: [item(0)] })
  updateCaptureTask(root, original.id, {
    status: 'partial', callState: 'completed', attempts: 1,
    resultText: text, resultTruncated: false, resultParseFailed: false,
    resultUsage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
  })
  pipeline.setConfig(resolveConfig({ capture: { minTurnChars: 0, maxCallsPerDay: 100 } }))
  const outerId = `cap_${'a'.repeat(24)}`
  if (throughParent) writeCaptureTask(root, { ...original, id: outerId, status: 'partial', callState: 'completed', continuationTaskIds: [original.id] })
  assert.equal(pipeline.retry(throughParent ? outerId : original.id).ok, true)
  await pipeline.flush()
  const tasks = readCaptureTasks(root)
  const parent = tasks.find((task) => task.id === original.id)
  assert.equal(parent.attempts, 1)
  assert.equal(parent.resultText, text)
  assert.ok(tasks.some((task) => task.parentTaskId === parent.id && task.completionDepth === 1))
  assert.equal(calls, 1)
})

test('reaching the completion bound cannot clear a paid result and resend the whole segment', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-completion-bound-'))
  t.after(() => rmSync(root, { recursive:true, force:true }))
  let calls=0
  const llm={async resolveModelInfo(){return {}},async *stream(){calls++;yield {type:'text-delta',text:'{"memories":[],"complete":true}'};yield {type:'finish',reason:{kind:'stop'}}}}
  const {pipeline}=pipelineFor(root,llm)
  pipeline.setConfig(resolveConfig({capture:{minTurnChars:0,maxCallsPerDay:0}}))
  await feed(pipeline,'该段已达到有界补全上限，必须保留旧付费证据。')
  const original=readCaptureTasks(root)[0]
  const text='{"memories":[],"complete":false}'
  updateCaptureTask(root,original.id,{status:'partial',callState:'completed',attempts:1,completionDepth:2,resultText:text})
  assert.equal(pipeline.retry(original.id).ok,false)
  await pipeline.flush()
  assert.equal(calls,0)
  assert.equal(readCaptureTasks(root)[0].resultText,text)
})

test('split children receive already extracted facts rather than asking for the same four again', async (t) => {
  const root=mkdtempSync(join(tmpdir(),'dsh-split-applied-'))
  t.after(()=>rmSync(root,{recursive:true,force:true}))
  const prompts=[]
  const llm={async resolveModelInfo(){return {}},async *stream({messages}){
    prompts.push(messages[0].content[0].text)
    yield {type:'text-delta',text:JSON.stringify(prompts.length===1?{memories:[0,1,2,3].map(item),complete:false}:{memories:[],complete:true})}
    yield {type:'finish',reason:{kind:'stop'}}
  }}
  const {pipeline}=pipelineFor(root,llm)
  await feed(pipeline,'该段含已确认项目事实。'.repeat(400))
  assert.ok(prompts.length>1)
  for(const prompt of prompts.slice(1)){assert.match(prompt,/本段已应用，勿重复/u);assert.match(prompt,/配置项 X0/u)}
})

test('a complete marker cannot hide items discarded by the per-pass parser limit', () => {
  const parsed=parseExtraction(JSON.stringify({memories:[0,1,2,3,4].map(item),complete:true}))
  assert.equal(parsed.items.length,4)
  assert.equal(parsed.complete,false)
})
