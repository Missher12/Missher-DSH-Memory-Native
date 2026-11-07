import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { CapturePipeline } from '../host/capture.js'
import { resolveConfig } from '../host/config.js'
import { MemoryIndex } from '../host/search.js'
import { MemoryStore } from '../host/store.js'
import { buildRecallSelectionPrompt, contextualRecallQuote, parseRecallSelectionResult } from '../host/recall-selection.js'

const CWD = '/tmp/recall-selection-project'

test('selected bare values retain their source object and qualifiers', () => {
  const source = '仅在 beta 环境使用 Node 22 以上，不得用于 production。'
  assert.equal(contextualRecallQuote(source, '22'), source)
  assert.equal(contextualRecallQuote(source, '24'), null)
  const sentence = '青岩数据库使用 MariaDB 11.4.7。'
  assert.equal(contextualRecallQuote('无关段落。'.repeat(150) + sentence, '11.4.7'), sentence)
  assert.equal(contextualRecallQuote('甲'.repeat(800) + '11.4.7', '11.4.7'), null)
})

function setup(t, stream) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-memory-recall-selection-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  let calls = 0
  const prompts = []
  const usage = []
  const llm = {
    async resolveModelInfo() { return {} },
    async *stream(options) {
      calls += 1
      prompts.push(options.messages[0].content[0].text)
      yield* stream(options)
    },
  }
  const create = () => new CapturePipeline({
    store: new MemoryStore({ root }).open(), index: new MemoryIndex(),
    config: resolveConfig({ capture: { enabled: false, maxCallsPerDay: 50 }, extraction: { maxInputTokens: 1000, maxOutputTokens: 800 } }),
    ctx: { get: key => key === 'llm' ? llm : undefined },
    onUsage: entry => usage.push(entry),
  })
  return { root, create, calls: () => calls, prompts, usage, llm }
}

function request(overrides = {}) {
  return {
    session: { id: 'session-1', header: { cwd: CWD }, requestHeader: () => ({ config: { provider: 'host-provider', model: 'host-model' } }) },
    modelSelection: { provider: 'live-provider', model: 'live-model', reasoningEffort: 'low' },
    turnKey: 'message-1',
    query: '关系型持久层最终选用了哪款产品？',
    slots: [{ query: '关系型持久层选用的数据库产品是什么？' }],
    candidates: [{ id: 'mem-db', revision: 3, kind: 'fact', scope: 'project', projectKey: 'recall-project',
      status: 'active', content: '项目采用 PostgreSQL 16.3 作为数据库。', observedAt: 100 }],
    ...overrides,
  }
}

test('recall selection is one bounded current-host call and is persisted per user message', async t => {
  const response = JSON.stringify({ selections: [{ slot: 0, id: 'mem-db', revision: 3, quote: 'PostgreSQL 16.3' }] })
  const env = setup(t, async function* (options) {
    assert.equal(options.provider, 'live-provider')
    assert.equal(options.model, 'live-model')
    assert.equal(options.reasoningEffort, 'low')
    assert.ok(options.maxTokens <= 800)
    yield { type: 'text-delta', text: response }
    yield { type: 'finish', reason: { kind: 'stop' }, usage: { inputTokens: 212, outputTokens: 28, totalTokens: 240 } }
  })
  const pipeline = env.create()
  const first = await pipeline.selectRecall(request())
  assert.equal(first.state, 'completed')
  assert.equal(first.callState, 'completed')
  assert.equal(first.usage.totalTokens, 240)
  assert.equal(first.budgetReservation.state, 'settled')
  assert.equal(first.budgetReservation.actualTokens, 240)
  assert.equal(first.budgetReservation.outputTokens, 800)
  assert.equal(env.usage.length, 1)
  assert.deepEqual(env.usage[0].usage, { inputTokens: 212, outputTokens: 28, totalTokens: 240 })
  assert.equal(env.calls(), 1)
  assert.match(env.prompts[0], /PostgreSQL 16\.3/u)
  const selectionDir = join(env.root, 'recall', 'selection')
  const files = readdirSync(selectionDir)
  assert.equal(files.length, 1)
  assert.equal(statSync(join(selectionDir, files[0])).mode & 0o777, 0o600)

  const repeated = await pipeline.selectRecall(request())
  assert.equal(repeated.resultText, first.resultText)
  assert.equal(repeated.usage.totalTokens, 240)
  assert.equal(env.calls(), 1)
  assert.equal(env.usage.length, 1)
  pipeline.dispose()
  const restarted = env.create()
  const recovered = await restarted.selectRecall(request())
  assert.equal(recovered.resultText, first.resultText)
  assert.equal(env.calls(), 1)
  assert.equal(env.usage.length, 1)
  restarted.dispose()
})

test('recall route falls back to the session request header when the step has no selection', async t => {
  const env = setup(t, async function* (options) {
    assert.equal(options.provider, 'host-provider')
    assert.equal(options.model, 'host-model')
    yield { type: 'text-delta', text: '{"selections":[],"missing":[0]}' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })
  const pipeline = env.create()
  const result = await pipeline.selectRecall(request({ modelSelection: null, turnKey: 'header-fallback' }))
  assert.equal(result.callState, 'completed')
  pipeline.dispose()
})

test('unknown selection receipt is never sent again for the same turn', async t => {
  const env = setup(t, async function* () { throw new Error('connection dropped after request') })
  const pipeline = env.create()
  const first = await pipeline.selectRecall(request())
  assert.equal(first.state, 'unknown')
  assert.equal(first.callState, 'unknown')
  assert.equal(env.calls(), 1)
  const repeated = await pipeline.selectRecall(request())
  assert.equal(repeated.state, 'unknown')
  assert.equal(env.calls(), 1)
  pipeline.dispose()
  const restarted = new CapturePipeline({
    store: new MemoryStore({ root: env.root }).open(), index: new MemoryIndex(),
    config: resolveConfig({ capture: { enabled: false, maxCallsPerDay: 1 }, extraction: { maxInputTokens: 1000, maxOutputTokens: 800 } }),
    ctx: { get: key => key === 'llm' ? env.llm : undefined },
  })
  const exhausted = await restarted.selectRecall(request({ turnKey: 'message-2' }))
  assert.equal(exhausted.callState, 'not-sent')
  assert.equal(env.calls(), 1)
  restarted.dispose()
})

test('recall selection shares the daily extraction call limit and restores it after restart', async t => {
  const response = JSON.stringify({ selections: [{ slot: 0, id: 'mem-db', revision: 3, quote: 'PostgreSQL 16.3' }] })
  const env = setup(t, async function* () {
    yield { type: 'text-delta', text: response }
    yield { type: 'finish', reason: { kind: 'stop' }, usage: { inputTokens: 17, outputTokens: 4, totalTokens: 21 } }
  })
  const limited = () => new CapturePipeline({
    store: new MemoryStore({ root: env.root }).open(), index: new MemoryIndex(),
    config: resolveConfig({ capture: { enabled: false, maxCallsPerDay: 1 }, extraction: { maxInputTokens: 1000, maxOutputTokens: 800 } }),
    ctx: { get: key => key === 'llm' ? env.llm : undefined },
  })
  const firstPipeline = limited()
  const first = await firstPipeline.selectRecall(request())
  assert.equal(first.callState, 'completed')
  assert.equal(first.budgetReservation.calls, 1)
  assert.equal(env.calls(), 1)
  firstPipeline.dispose()

  const restarted = limited()
  const exhausted = await restarted.selectRecall(request({ turnKey: 'message-2' }))
  assert.equal(exhausted.callState, 'not-sent')
  assert.match(exhausted.reason, /预算已用尽/u)
  assert.equal(env.calls(), 1)
  restarted.dispose()
})

test('an in-flight extraction reserves the shared call allowance before recall can send', async t => {
  let extractionStarted
  const started = new Promise(resolve => { extractionStarted = resolve })
  let continueExtraction
  const blocked = new Promise(resolve => { continueExtraction = resolve })
  const env = setup(t, async function* (options) {
    const prompt = options.messages[0].content[0].text
    if (prompt.startsWith('你是记忆证据选择器')) {
      yield { type: 'text-delta', text: '{"selections":[],"missing":[0]}' }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    extractionStarted()
    await blocked
    yield { type: 'text-delta', text: '{"memories":[]}' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })
  const pipeline = new CapturePipeline({
    store: new MemoryStore({ root: env.root }).open(), index: new MemoryIndex(),
    config: resolveConfig({ capture: { enabled: true, minTurnChars: 0, maxCallsPerDay: 1 }, extraction: { maxInputTokens: 1000, maxOutputTokens: 800 } }),
    ctx: { get: key => key === 'llm' ? env.llm : undefined },
  })
  const session = {
    id: 'session-1', header: { cwd: CWD },
    requestHeader: () => ({ config: { provider: 'host-provider', model: 'host-model' } }),
  }
  pipeline.observe(session, { type: 'user/message', data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '仓库每周一运行集成测试。' }] } })
  pipeline.observe(session, { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: '好的。' }] } } })
  pipeline.observe(session, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  const flushing = pipeline.flush()
  await started
  assert.equal(env.calls(), 1)
  const denied = await pipeline.selectRecall(request({ turnKey: 'while-extraction' }))
  assert.equal(denied.callState, 'not-sent')
  assert.equal(env.calls(), 1)
  continueExtraction()
  await flushing
  pipeline.dispose()
})

test('selection prompt is bounded and only exact candidate quotes survive validation', () => {
  const candidates = Array.from({ length: 20 }, (_, index) => ({
    id: `mem-${index}`, revision: 1, kind: 'fact', scope: 'project', projectKey: 'recall-project',
    status: 'active', content: `候选 ${index}：${'较长证据文本'.repeat(60)}`,
  }))
  const built = buildRecallSelectionPrompt({ query: '哪个产品？', slots: [{ query: '数据库产品是什么？' }], candidates, maxInputTokens: 1000 })
  assert.ok(built.candidates.length > 0 && built.candidates.length < candidates.length)
  assert.ok(built.promptTokens <= 1000)
  const selected = parseRecallSelectionResult(JSON.stringify({ selections: [
    { slot: 0, id: 'mem-0', revision: 1, quote: '候选 0' },
    { slot: 0, id: 'not-in-prompt', revision: 1, quote: '可信内容' },
    { slot: 0, id: 'mem-0', revision: 1, quote: '模型补写的答案' },
  ] }), [{ query: '数据库产品是什么？' }], built.candidates)
  assert.deepEqual(selected, [{ slot: 0, id: 'mem-0', revision: 1, quote: '候选 0' }])
})

test('a pre-cancelled request does not reserve a call or invoke the provider', async t => {
  const env = setup(t, async function* () {
    throw new Error('provider should not be called')
  })
  const pipeline = env.create()
  const controller = new AbortController()
  controller.abort()
  const receipt = await pipeline.selectRecall(request({ signal: controller.signal }))
  assert.equal(receipt.callState, 'not-sent')
  assert.equal(env.calls(), 0)
  assert.equal(env.usage.length, 0)
  pipeline.dispose()
})

test('cancellation during provider streaming becomes unknown and keeps its shared reservation', async t => {
  let startCall
  const started = new Promise(resolve => { startCall = resolve })
  const env = setup(t, async function* (options) {
    startCall()
    await new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true }))
    throw new Error('provider stream cancelled')
  })
  const pipeline = env.create()
  const controller = new AbortController()
  const pending = pipeline.selectRecall(request({ signal: controller.signal }))
  await started
  controller.abort()
  const receipt = await pending
  assert.equal(receipt.callState, 'unknown')
  assert.equal(receipt.budgetReservation.state, 'reserved')
  assert.equal(env.calls(), 1)
  assert.equal(env.usage.length, 1)
  pipeline.dispose()

  const restarted = new CapturePipeline({
    store: new MemoryStore({ root: env.root }).open(), index: new MemoryIndex(),
    config: resolveConfig({ capture: { enabled: false, maxCallsPerDay: 1 }, extraction: { maxInputTokens: 1000, maxOutputTokens: 800 } }),
    ctx: { get: key => key === 'llm' ? env.llm : undefined },
  })
  const exhausted = await restarted.selectRecall(request({ turnKey: 'message-2' }))
  assert.equal(exhausted.callState, 'not-sent')
  assert.equal(env.calls(), 1)
  restarted.dispose()
})
