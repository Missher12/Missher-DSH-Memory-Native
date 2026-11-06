import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { CapturePipeline } from '../host/capture.js'
import { readCaptureTasks } from '../host/capture-journal.js'
import { resolveConfig } from '../host/config.js'
import { MemoryIndex } from '../host/search.js'
import { MemoryStore } from '../host/store.js'

const CWD = '/tmp/segment-context-project'
const T = 1_800_000_000_000

function make(root) {
  const prompts = []
  const llm = { async resolveModelInfo() { return {} }, async *stream({ messages }) {
    const prompt = messages[0].content[0].text
    prompts.push(prompt)
    const transcript = prompt.split('## 本次对话')[1] ?? ''
    const hasHeadFact = transcript.includes('HEAD-CONFIG-7319')
    const memories = hasHeadFact
      ? [{ op: 'ADD', kind: 'fact', scope: 'project', content: 'HEAD-CONFIG-7319 已确认', confidence: 0.9, importance: 0.7 }]
      : []
    yield { type: 'text-delta', text: JSON.stringify({ memories, complete: true }) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  } }
  return {
    store: new MemoryStore({ root, clock: () => T }).open(),
    pipeline: new CapturePipeline({
      store: new MemoryStore({ root, clock: () => T }).open(), index: new MemoryIndex(),
      config: resolveConfig({ capture: { minTurnChars: 0, maxCallsPerDay: 100 }, extraction: { maxInputTokens: 1000 } }),
      clock: () => T, ctx: { get: () => llm },
    }),
    prompts,
  }
}

async function feed(pipeline, text, id) {
  const session = { id: 'segment-session', header: { cwd: CWD }, requestHeader: () => ({ config: { provider: 'qa', model: 'fake' } }) }
  pipeline.observe(session, { type: 'user/message', seq: 1, time: T, data: { id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] } })
  pipeline.observe(session, { type: 'turn/end', seq: 2, time: T, data: { reason: { kind: 'completed' } } })
  await pipeline.flush()
}

test('later segments keep explicit save intent and a bounded message-head context', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-segment-intent-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const { pipeline, prompts } = make(root)
  const head = '请记住，当前项目配置代号是 HEAD-CONFIG-7319。'
  const tail = '尾部配置标识是 TAIL-CONFIG-4826。'
  await feed(pipeline, `${head}${'中性填充文本。'.repeat(2200)}${tail}`, 'long-intent-1')
  const tasks = readCaptureTasks(root)
  assert.ok(tasks.length >= 2)
  assert.ok(tasks.every((task) => task.explicit === true))
  assert.ok(prompts.some((prompt) => prompt.includes('## 明确保存意图')))
  assert.ok(prompts.some((prompt) => prompt.includes('## 消息开头语境') && prompt.includes('HEAD-CONFIG-7319')))
  assert.ok(tasks.every((task) => task.status === 'done'))
})

test('same-source earlier facts are prioritized in later segment prompts', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-segment-same-source-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const { pipeline, prompts } = make(root)
  const head = '请记住，当前项目配置代号是 HEAD-CONFIG-7319。'
  const tail = '尾部配置标识是 TAIL-CONFIG-4826。'
  await feed(pipeline, `${head}${'中性填充文本。'.repeat(2200)}${tail}`, 'long-same-source-1')
  assert.ok(prompts.length >= 2)
  const laterPrompt = prompts[prompts.length - 1]
  assert.match(laterPrompt, /HEAD-CONFIG-7319 已确认/u)
})

test('explicit=false does not inject the explicit-save section', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-segment-no-intent-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const { pipeline, prompts } = make(root)
  await feed(pipeline, `${'普通填充文本。'.repeat(900)}尾部事实 TAIL-ONLY-9012。`, 'long-no-intent-1')
  assert.ok(prompts.length >= 1)
  assert.ok(prompts.every((prompt) => !prompt.includes('## 明确保存意图')))
})
