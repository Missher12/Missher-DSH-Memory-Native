import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { CapturePipeline } from '../host/capture.js'
import { captureTaskIdOf, readTurnIntakes, readCaptureTasks, updateCaptureTask, writeCaptureTask } from '../host/capture-journal.js'
import { resolveConfig } from '../host/config.js'
import { MemoryIndex } from '../host/search.js'
import { MemoryStore } from '../host/store.js'

const NOW = 1_800_000_000_000
function setup(t, stream) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-capacity-recovery-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const store = new MemoryStore({ root, clock: () => NOW }).open()
  const reports = []
  const pipeline = new CapturePipeline({ store, index: new MemoryIndex(),
    config: resolveConfig({ capture: { minTurnChars: 0, maxCallsPerDay: 50 }, extraction: { maxOutputTokens: 800 } }),
    clock: () => NOW, ctx: { get: () => ({ resolveModelInfo: async () => ({}), stream }) },
    onExtraction: value => reports.push(value),
  })
  const feed = async (text, seq = 1) => {
    const session = { id: 'capacity-session', header: { cwd: '/tmp/capacity-project' }, requestHeader: () => ({ config: { provider: 'qa', model: 'reasoning-model' } }) }
    pipeline.observe(session, { type: 'user/message', seq, time: NOW, data: { id: `msg-${seq}`, source: { kind: 'user' }, content: [{ type: 'text', text }] } })
    pipeline.observe(session, { type: 'turn/end', seq: seq + 1, time: NOW, data: { reason: { kind: 'completed' } } })
    await pipeline.flush()
  }
  return { root, store, pipeline, feed, reports }
}

test('empty terminal output keeps usage and stops the route instead of multiplying paid children', async t => {
  let calls = 0
  const { root, feed, reports } = setup(t, async function* () {
    calls++
    yield { type: 'reasoning-delta', text: 'reasoning that consumed the allowance' }
    yield { type: 'finish', reason: { kind: 'max-tokens' }, usage: { inputTokens: 200, outputTokens: 800, totalTokens: 1000 } }
  })
  await feed('这是一项待提炼的项目事实。'.repeat(300))
  await feed('另一轮独立事实：项目发布日为星期三。', 3)
  const tasks = readCaptureTasks(root)
  assert.equal(calls, 1, 'no paid splitting or next-turn retry on a stalled route')
  assert.equal(tasks.length, 2)
  assert.equal(tasks[0].status, 'partial')
  assert.equal(tasks[0].resultFinishKind, 'max-tokens')
  assert.equal(tasks[0].resultUsage.totalTokens, 1000)
  assert.ok(tasks[0].reasoningChars > 0)
  assert.equal(tasks[1].status, 'pending')
  assert.equal(tasks[1].callState, 'not-sent')
  assert.equal(reports[0].usage.totalTokens, 1000)
})

test('explicit recovery preserves the old receipt and completes only one missing leaf with more headroom', async t => {
  const budgets = []
  const { root, feed, pipeline } = setup(t, async function* ({ maxTokens }) {
    budgets.push(maxTokens)
    if (budgets.length === 1) yield { type: 'finish', reason: { kind: 'max-tokens' }, usage: { outputTokens: 800 } }
    else {
      yield { type: 'text-delta', text: '{"memories":[],"complete":true}' }
      yield { type: 'finish', reason: { kind: 'stop' }, usage: { outputTokens: 30 } }
    }
  })
  await feed('历史段没有新增长期事实，保留来源用于核验。')
  const old = readCaptureTasks(root)[0]
  updateCaptureTask(root, old.id, { completionDepth: 2 })
  assert.equal(pipeline.retry(old.id).ok, true)
  assert.equal(pipeline.retry(old.id).ok, true, 'repeated UI/RPC request reuses the recovery child')
  await pipeline.flush()
  const tasks = readCaptureTasks(root)
  assert.equal(budgets.length, 2)
  assert.ok(budgets[1] >= 4096)
  assert.equal(tasks.length, 2)
  assert.ok(tasks.every(t => t.status === 'done'))
  assert.equal(tasks[0].attempts, 1)
  assert.equal(tasks[0].resultUsage.outputTokens, 800)
  assert.equal(tasks[1].recoveryOf, old.id)
  assert.equal(pipeline.retry(old.id).ok, false)
})

test('a second empty terminal stops bounded recovery and unknown children are never re-sent', async t => {
  let calls = 0
  const { root, feed, pipeline } = setup(t, async function* () {
    calls++
    yield { type: 'finish', reason: { kind: 'max-tokens' } }
  })
  await feed('测试没有正文的响应，不得无限重复付费。')
  const parent = readCaptureTasks(root)[0]
  pipeline.retry(parent.id)
  await pipeline.flush()
  const child = readCaptureTasks(root).find(t => t.recoveryOf === parent.id)
  assert.ok(child)
  assert.equal(pipeline.retry(child.id).ok, false)
  assert.equal(calls, 2)
  updateCaptureTask(root, child.id, { status: 'unknown', callState: 'unknown' })
  assert.equal(pipeline.retry(child.id).ok, false)
  pipeline.retry(parent.id)
  await pipeline.flush()
  assert.equal(calls, 2)
})

for (const directive of ['禁止保存记忆', '不得保存到长期记忆']) test(`explicit no-memory material is skipped across source ranges: ${directive}`, async t => {
  let calls = 0
  const { root, feed, store } = setup(t, async function* () { calls++; yield { type: 'finish', reason: { kind: 'stop' } } })
  await feed(`这是虚构测试资料，不是真实用户资料或偏好，${directive}。\n` + '原始资料必须完整保留用于本轮上下文测试。'.repeat(1500))
  assert.equal(calls, 0)
  assert.ok(readCaptureTasks(root).every(t => t.status === 'skipped' && t.callState === 'not-sent'))
  assert.equal(store.listAll().length, 0)
})

test('completion jobs actually receive additional output headroom', async t => {
  const budgets = []
  const { feed } = setup(t, async function* ({ maxTokens }) {
    budgets.push(maxTokens)
    yield { type: 'text-delta', text: JSON.stringify({ memories: [], complete: budgets.length > 1 }) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })
  await feed('这一段需要第二次补全，但不是首次没有正文。')
  assert.equal(budgets.length, 2)
  assert.ok(budgets[1] >= budgets[0] * 2)
})

test('fictional acceptance material has no extraction cost unless the user explicitly asks to remember it', async t => {
  let calls = 0
  const { feed, root } = setup(t, async function* () {
    calls++
    yield { type: 'text-delta', text: '{"memories":[],"complete":true}' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })
  await feed('这是 Context Manager 安装后的原生验收，沿用本会话已有的虚构材料。只回复三条仍可确认的关键事实。')
  assert.equal(calls, 0)
  assert.equal(readCaptureTasks(root)[0].status, 'skipped')
  await feed('这是虚构测试资料，但这次请记住测试用的资料编号 QA-58，稍后要验收跨会话召回。', 3)
  assert.equal(calls, 1)
})

test('replaying an old paid result cannot bypass an explicit no-memory source', async t => {
  let calls = 0
  const { feed, root, pipeline, store } = setup(t, async function* () { calls++ })
  await feed('不得保存到长期记忆。虚构验收项目的编号为 QA-81。')
  // Current intake skips a new opt-out before scheduling. Recreate the old
  // paid receipt explicitly to exercise replay, without sending a model call.
  assert.equal(readCaptureTasks(root).length, 0)
  const intake = readTurnIntakes(root).intakes[0]
  const id = captureTaskIdOf({ sessionId: intake.sessionId, turnKey: intake.id,
    sourceIds: intake.sourceIds, segmentIndex: 0, total: 1 })
  writeCaptureTask(root, { id, sessionId: intake.sessionId, projectKey: intake.projectKey, sourceIds: intake.sourceIds,
    segment: { index: 0, total: 1, entries: [{ sourceId: intake.sourceIds[0], from: 0, to: intake.chars }] },
    status: 'pending', callState: 'completed', attempts: 1,
    resultUsage: { outputTokens: 120 }, resultText: JSON.stringify({ memories: [{
      op: 'ADD', kind: 'fact', scope: 'project', content: '虚构验收项目的编号为 QA-81', confidence: 0.9, evidence: intake.sourceIds,
    }], complete: true }) })
  await pipeline.flush()
  assert.equal(calls, 0)
  assert.equal(store.listAll().length, 0)
  const final = readCaptureTasks(root)[0]
  assert.equal(final.status, 'skipped')
  assert.equal(final.callState, 'completed')
  assert.equal(final.resultUsage.outputTokens, 120)
})

test('legacy empty completion rounds do not exhaust missing-fact completion after the first usable result', async t => {
  const prompts = []
  const { feed, root, pipeline } = setup(t, async function* ({messages}) {
    prompts.push(messages[0].content[0].text)
    const ids = prompts.length === 1 ? [1,2,3,4] : [5]
    yield { type: 'text-delta', text: JSON.stringify({ memories: ids.map(i=>({op:'ADD',kind:'fact',scope:'project',content:`项目独立编号 X${i} 已确认`,confidence:0.9})),complete:prompts.length>1 }) }
    yield { type:'finish',reason:{kind:'stop'} }
  })
  pipeline.setConfig(resolveConfig({capture:{minTurnChars:0,maxCallsPerDay:0},extraction:{maxOutputTokens:800}}))
  await feed('项目独立编号 X1 已确认；项目独立编号 X2 已确认；项目独立编号 X3 已确认；项目独立编号 X4 已确认；项目独立编号 X5 已确认。')
  const parent = readCaptureTasks(root)[0], mid='cap_111111111111111111111111', leaf='cap_222222222222222222222222'
  updateCaptureTask(root,parent.id,{status:'partial',callState:'completed',resultFinishKind:'max-tokens',continuationTaskIds:[mid],attempts:1})
  writeCaptureTask(root,{...parent,id:mid,parentTaskId:parent.id,completionOf:parent.id,completionDepth:1,status:'partial',callState:'completed',resultFinishKind:'max-tokens',continuationTaskIds:[leaf],attempts:1})
  writeCaptureTask(root,{...parent,id:leaf,parentTaskId:mid,completionOf:parent.id,completionDepth:2,status:'pending',callState:'not-sent',attempts:0})
  assert.equal(pipeline.retry(leaf).ok,true)
  await pipeline.flush()
  const tasks=readCaptureTasks(root)
  assert.equal(prompts.length,2)
  assert.ok(prompts[1].includes('项目独立编号 X1 已确认'))
  assert.ok(tasks.every(t=>t.status==='done'))
  assert.equal(tasks.find(t=>t.id===mid).attempts,1)
})
