import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { apply } from '../index.js'
import { projectIdentity } from '../host/paths.js'
import { MemoryStore } from '../host/store.js'

/** Minimal Cordis-like context: enough for apply() to wire the Host half. */
function fakeContext(root) {
  const listeners = []
  const effects = []
  const handlers = {}
  return {
    listeners,
    effects,
    handlers,
    ctx: {
      get(key) {
        if (key === 'dshHomePath') return () => root
        return undefined
      },
      on(name, handler) {
        listeners.push(name)
        handlers[name] = handler
        return () => {}
      },
      effect(factory) {
        effects.push(factory)
        return () => {}
      },
      logger: { info() {}, warn() {} },
    },
  }
}

test('apply wires capture and recall on a minimal context', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-memory-activation-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const { ctx, listeners, effects } = fakeContext(root)

  assert.doesNotThrow(() => apply(ctx, { dataDir: join(root, 'data') }))
  assert.ok(listeners.includes('session/event'), 'capture listens to session/event')
  assert.ok(listeners.includes('agent/pre-step'), 'recall listens to agent/pre-step')
  assert.ok(effects.length >= 1, 'capture registers a disposal effect')
  assert.ok(existsSync(join(root, 'data')), 'the data root is created at activation')

  // wirePanel() resolves asynchronously; give it a tick to settle on the
  // "unavailable" path of this context instead of rejecting into the void.
  await new Promise((resolve) => setTimeout(resolve, 50))
  const diagnostic = join(root, 'data', 'panel-transport.json')
  assert.ok(existsSync(diagnostic), 'panel transport diagnostic is written')
})

test('apply is a no-op when disabled', () => {
  const { ctx, listeners } = fakeContext(tmpdir())
  apply(ctx, { enabled: false })
  assert.deepEqual(listeners, [])
})

test('apply disables itself instead of throwing when storage cannot open', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-memory-activation-bad-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const blocked = join(root, 'data')
  writeFileSync(blocked, 'not a directory')
  const { ctx, listeners } = fakeContext(root)
  assert.doesNotThrow(() => apply(ctx, { dataDir: blocked }))
  assert.deepEqual(listeners, [], 'no hooks are registered when storage is unavailable')
  await new Promise((resolve) => setTimeout(resolve, 20))
})


test('pre-step failures never break the turn', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-memory-activation-hook-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const { ctx, handlers } = fakeContext(root)
  apply(ctx, { dataDir: join(root, 'data') })
  const decision = { kind: 'enter', messages: [] }
  const agent = {}
  Object.defineProperty(agent, 'session', { get() { throw new Error('session exploded') } })
  const result = await handlers['agent/pre-step']({ agent, messages: [] }, async () => decision)
  assert.deepEqual(result, decision)
})

test('production pre-step injects both required facts for a pnpm and Node compound query', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-memory-compound-'))
  const dataDir = join(root, 'data')
  const cwd = join(root, 'project')
  const projectKey = projectIdentity(cwd).key
  const store = new MemoryStore({ root: dataDir }).open()
  const fixtures = [
    { id: 'mem_compound_pnpm', content: '会话 A 决定项目使用 pnpm 管理依赖', tags: ['pnpm'] },
    { id: 'mem_compound_node', content: '会话 B 记录运行时 Node 版本要求是 22 以上', tags: ['node'] },
    { id: 'mem_compound_decoy_pnpm', content: 'pnpm-lock.yaml 描述项目依赖树', tags: ['pnpm'] },
    { id: 'mem_compound_decoy_node', content: 'Node 版本按运行时配置确定，未记录具体值', tags: ['node'] },
    { id: 'mem_compound_profile', kind: 'preference', scope: 'global', content: '用户偏好技术回答很长，先解释背景再详尽展开各项方案', tags: ['回答'] },
  ]
  for (const fixture of fixtures) {
    const scope = fixture.scope ?? 'project'
    const written = store.write({
      ...fixture, kind: fixture.kind ?? 'fact', scope,
      projectKey: scope === 'global' ? null : projectKey,
      confidence: 0.9,
    })
    assert.equal(written.ok, true)
  }
  const { ctx, handlers, effects } = fakeContext(root)
  t.after(() => {
    for (const effect of effects) {
      try { effect()?.() } catch {}
    }
    rmSync(root, { recursive: true, force: true })
  })
  apply(ctx, { dataDir, capture: { enabled: false }, maintenance: { enabled: false } })
  const messages = [
    { role: 'user', source: { kind: 'user' }, content: 'pnpm 依赖和 Node 版本' },
    { role: 'user', source: { kind: 'runtime-context' }, content: '内部提示：量子计算芯片价格' },
    { role: 'user', source: { kind: 'memory', plugin: 'third-party-fixture' }, content: 'Node 99' },
  ]
  const decision = { kind: 'enter', messages }
  const result = await handlers['agent/pre-step']({
    agent: { session: { header: { cwd } } }, messages,
  }, async () => decision)
  const injected = result.messages
    .filter((message) => message?.source?.kind === 'memory' && message?.source?.plugin === 'dsh-memory')
    .flatMap((message) => Array.isArray(message.content) ? message.content : [])
    .filter((block) => block?.type === 'text')
    .map((block) => block.text)
    .join('\n')
  assert.match(injected, /pnpm 管理依赖/u)
  assert.match(injected, /Node 版本要求是 22 以上/u)
  assert.doesNotMatch(injected, /Node 99|量子计算芯片价格|用户偏好技术回答/u)
})

test('production pre-step scopes child recalls to the requested entity and attribute', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-memory-entity-scope-'))
  const dataDir = join(root, 'data')
  const cwd = join(root, 'project')
  const projectKey = projectIdentity(cwd).key
  const store = new MemoryStore({ root: dataDir }).open()
  const fixtures = [
    { id: 'mem_alpha_temperature', content: '甲设备温度应保持在 18℃ 左右', tags: ['甲设备', '温度'] },
    { id: 'mem_alpha_humidity', content: '甲设备湿度控制在 45% 到 55% 之间', tags: ['甲设备', '湿度'] },
    { id: 'mem_beta_humidity', content: '乙设备湿度保持在 80% 以上', tags: ['乙设备', '湿度'] },
    { id: 'mem_alpha_port', content: '甲设备 Node 服务端口至少为 7419', tags: ['甲设备', 'Node', '端口'] },
  ]
  for (const fixture of fixtures) {
    const written = store.write({ ...fixture, kind: 'fact', scope: 'project', projectKey, confidence: 0.9 })
    assert.equal(written.ok, true)
  }
  const { ctx, handlers, effects } = fakeContext(root)
  t.after(() => {
    for (const effect of effects) {
      try { effect()?.() } catch {}
    }
    rmSync(root, { recursive: true, force: true })
  })
  const trace = []
  apply(ctx, { dataDir, inject: { maxItems: 2 }, capture: { enabled: false }, maintenance: { enabled: false } }, {
    recallObserver: (event) => trace.push(event),
  })
  const messages = [{ role: 'user', source: { kind: 'user' }, content: '甲设备温度和湿度' }]
  const result = await handlers['agent/pre-step']({
    agent: { session: { header: { cwd } } }, messages,
  }, async () => ({ kind: 'enter', messages }))
  const injected = result.messages
    .filter((message) => message?.source?.kind === 'memory' && message?.source?.plugin === 'dsh-memory')
    .flatMap((message) => Array.isArray(message.content) ? message.content : [])
    .filter((block) => block?.type === 'text')
    .map((block) => block.text)
    .join('\n')
  assert.match(injected, /甲设备温度/u)
  assert.match(injected, /甲设备湿度/u)
  assert.doesNotMatch(injected, /乙设备湿度|Node 服务端口/u)
  const humidityScope = trace.find((event) => event.phase === 'scope' && event.query === '甲设备 湿度')
  assert.ok(humidityScope)
  assert.ok(humidityScope.excludedIds.includes('mem_beta_humidity'))
})

test('production pre-step recalls both locked values from the exact natural prompt', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-memory-natural-values-'))
  const dataDir = join(root, 'data')
  const cwd = join(root, 'project')
  const projectKey = projectIdentity(cwd).key
  const store = new MemoryStore({ root: dataDir }).open()
  const fixtures = [
    { id: 'mem_natural_pnpm', content: '当前项目约定：安装依赖统一使用 pnpm，并锁定确切版本 9.12.3，仅对当前项目有效。', tags: ['pnpm', '版本锁定', '9.12.3'] },
    { id: 'mem_natural_node', content: '当前项目运行环境决定：Node.js 运行时固定为 22.13.1，仅对当前项目有效。', tags: ['Node.js', '运行时', '版本锁定', '22.13.1'] },
    { id: 'mem_natural_global_tool_preference', kind: 'preference', scope: 'global', content: '用户偏好通过 Node.js 工具查询项目状态，不要直接读本地文件。', tags: ['Node.js', '工具'] },
  ]
  for (const fixture of fixtures) {
    const scope = fixture.scope ?? 'project'
    const written = store.write({
      ...fixture, kind: fixture.kind ?? 'fact', scope,
      projectKey: scope === 'global' ? null : projectKey,
      confidence: 0.95,
    })
    assert.equal(written.ok, true)
  }
  const { ctx, handlers, effects } = fakeContext(root)
  t.after(() => {
    for (const effect of effects) {
      try { effect()?.() } catch {}
    }
    rmSync(root, { recursive: true, force: true })
  })
  const trace = []
  apply(ctx, { dataDir, capture: { enabled: false }, maintenance: { enabled: false } }, {
    recallObserver: (event) => trace.push(event),
  })
  const prompt = '这个项目的 pnpm 和 Node 版本分别是多少？只根据已有记忆，每项用“工具名：版本号”回答。没有依据的那项就写不记得。不要调用工具，也不要保存这次问答。'
  const messages = [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: prompt }] }]
  const result = await handlers['agent/pre-step']({
    agent: { session: { header: { cwd } } }, messages,
  }, async () => ({ kind: 'enter', messages }))
  const injected = result.messages
    .filter((message) => message?.source?.kind === 'memory' && message?.source?.plugin === 'dsh-memory')
    .flatMap((message) => Array.isArray(message.content) ? message.content : [])
    .filter((block) => block?.type === 'text')
    .map((block) => block.text)
    .join('\n')
  assert.match(injected, /pnpm.{0,40}9\.12\.3/u)
  assert.match(injected, /Node\.js.{0,40}22\.13\.1/u)
  assert.doesNotMatch(injected, /Node\.js 工具查询|工具名|不记得/u)
  assert.ok(trace.filter((event) => event.phase === 'search').length <= 4)
  assert.ok(result.messages.some((message) => message === messages[0]), 'the original user message stays unchanged')
})

test('clock, retention and reason share an object without picking another job’s clock', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-memory-time-'))
  const dataDir = join(root, 'data'), cwd = join(root, 'work')
  const store = new MemoryStore({ root: dataDir }).open()
  for (const content of ['数据库快照在 02:41 执行。', '快照保留 17 天。',
    '快照改期是为了避开校对窗口。', '日报任务在 05:08 开始，为了错开出账。', '日报保留 90 天。']) {
    assert.ok(store.write({ content, scope: 'project', projectKey: projectIdentity(cwd).key, kind: 'fact', confidence: .95 }).ok)
  }
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const { ctx, handlers } = fakeContext(root)
  apply(ctx, { dataDir, capture: { enabled: false }, maintenance: { enabled: false } })
  const messages = [{ role: 'user', source: { kind: 'user' }, content: '快照几点开始、保留多久、为什么改？' }]
  const turn = await handlers['agent/pre-step']({ agent: { session: { header: { cwd } } }, messages },
    async () => ({ kind: 'enter', messages }))
  const block = turn.messages.filter(m => m.source?.kind === 'memory').flatMap(m => m.content.map(b => b.text)).join('\n')
  for (const value of ['02:41', '17 天', '校对窗口']) assert.ok(block.includes(value), block)
  assert.doesNotMatch(block, /05:08|90 天|出账/)
})

test('production pre-step rejects wrong-object and wrong-attribute root hits', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-memory-root-scope-'))
  const dataDir = join(root, 'data'), cwd = join(root, 'work')
  const projectKey = projectIdentity(cwd).key
  const store = new MemoryStore({ root: dataDir }).open()
  const fixtures = [
    { id: 'mem_root_temp', content: '白鹭路由器的温度上限是 21℃。', tags: ['白鹭路由器', '温度', '上限'] },
    { id: 'mem_root_humidity', content: '白鹭路由器的湿度上限是 55%。', tags: ['白鹭路由器', '湿度', '上限'] },
    { id: 'mem_root_wrong_object', content: '灰鹭路由器的温度上限是 45℃。', tags: ['白鹭路由器', '温度', '上限'] },
    { id: 'mem_root_wrong_attribute', content: '白鹭路由器的 Node 服务端口至少为 7419。', tags: ['白鹭路由器', '湿度', '上限'] },
  ]
  for (const fixture of fixtures) {
    assert.equal(store.write({ ...fixture, kind: 'fact', scope: 'project', projectKey, confidence: 0.95 }).ok, true)
  }
  const { ctx, handlers, effects } = fakeContext(root)
  t.after(() => {
    for (const effect of effects) { try { effect()?.() } catch {} }
    rmSync(root, { recursive: true, force: true })
  })
  apply(ctx, { dataDir, capture: { enabled: false }, maintenance: { enabled: false } })
  const ask = async (content) => {
    const messages = [{ role: 'user', source: { kind: 'user' }, content }]
    const turn = await handlers['agent/pre-step']({ agent: { session: { header: { cwd } } }, messages },
      async () => ({ kind: 'enter', messages }))
    return turn.messages.filter(m => m.source?.kind === 'memory').flatMap(m => m.content.map(b => b.text)).join('\n')
  }

  const rootResult = await ask('白鹭路由器温度上限是多少？')
  assert.match(rootResult, /白鹭路由器的温度上限是 21℃/u)
  assert.doesNotMatch(rootResult, /灰鹭路由器|7419|55%/u)

  const compoundResult = await ask('白鹭路由器温度和湿度上限分别是多少？')
  assert.match(compoundResult, /白鹭路由器的温度上限是 21℃/u)
  assert.match(compoundResult, /白鹭路由器的湿度上限是 55%/u)
  assert.doesNotMatch(compoundResult, /灰鹭路由器|7419/u)
})

test('production pre-step resolves historical facts by effective time, not observation time', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-memory-effective-time-'))
  const dataDir = join(root, 'data'), cwd = join(root, 'work')
  const projectKey = projectIdentity(cwd).key
  const now = Date.now(), day = 86_400_000
  const store = new MemoryStore({ root: dataDir }).open()
  const old = store.write({
    id: 'mem_time_old', kind: 'fact', scope: 'project', projectKey,
    content: '白鹭快照每天 05:43 生成，当时保留期限为 17 天。', confidence: 0.95,
    validFrom: now - 50 * day, validTo: now - 10 * day,
  }, { now, observedAt: now - 51 * day })
  assert.equal(old.ok, true)
  assert.ok(store.update(old.record.id, { status: 'superseded', validTo: now - 10 * day }, [{ scope: 'project', projectKey }]))
  assert.equal(store.write({
    id: 'mem_time_current', kind: 'fact', scope: 'project', projectKey,
    content: '白鹭快照每天 06:20 生成，当前保留期限为 29 天。', confidence: 0.95,
    validFrom: now - 10 * day,
  }, { now, observedAt: now - 51 * day }).ok, true)
  assert.equal(store.write({
    id: 'mem_time_future', kind: 'fact', scope: 'project', projectKey,
    content: '白鹭快照未来保留期限将调整为 90 天。', confidence: 0.95,
    validFrom: now + 5 * day,
  }, { now, observedAt: now - 60 * day }).ok, true)
  assert.equal(store.write({
    id: 'mem_time_unknown', kind: 'fact', scope: 'project', projectKey,
    content: '翠鸟快照保留期限为 12 天。', confidence: 0.95,
  }, { now, observedAt: now - 50 * day }).ok, true)
  assert.ok(store.update('mem_time_unknown', { status: 'superseded' }, [{ scope: 'project', projectKey }]))

  const { ctx, handlers, effects } = fakeContext(root)
  t.after(() => {
    for (const effect of effects) { try { effect()?.() } catch {} }
    rmSync(root, { recursive: true, force: true })
  })
  apply(ctx, { dataDir, capture: { enabled: false }, maintenance: { enabled: false } })
  const ask = async (content) => {
    const messages = [{ role: 'user', source: { kind: 'user' }, content }]
    const turn = await handlers['agent/pre-step']({ agent: { session: { header: { cwd } } }, messages },
      async () => ({ kind: 'enter', messages }))
    return turn.messages.filter(m => m.source?.kind === 'memory').flatMap(m => m.content.map(b => b.text)).join('\n')
  }

  const current = await ask('现在白鹭快照保留期限是多少？')
  assert.match(current, /29 天/u)
  assert.doesNotMatch(current, /17 天|90 天/u)

  const target = new Date(now - 21 * day)
  const date = `${target.getFullYear()}年${target.getMonth() + 1}月${target.getDate()}日`
  const historical = await ask(`${date}白鹭快照保留期限是多少？`)
  assert.match(historical, /17 天/u)
  assert.doesNotMatch(historical, /29 天|90 天/u)

  const compoundHistory = await ask('三周前白鹭快照几点生成，保留期限是多少？')
  assert.match(compoundHistory, /05:43/u)
  assert.match(compoundHistory, /17 天/u)
  assert.doesNotMatch(compoundHistory, /06:20|29 天|90 天/u)

  const unknownTime = await ask('三周前翠鸟快照保留期限是多少？')
  assert.doesNotMatch(unknownTime, /12 天/u)
})

test('production pre-step retrieves only explicitly scoped knowledge notes', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-memory-knowledge-recall-'))
  const dataDir = join(root, 'data'), cwd = join(root, 'project'), otherCwd = join(root, 'other')
  const projectKey = projectIdentity(cwd).key
  const notes = join(dataDir, 'knowledge')
  mkdirSync(notes, { recursive: true })
  writeFileSync(join(notes, 'build-tool.md'), [
    '---', 'dsh_knowledge: true', 'scope: "project"', `projectKey: "${projectKey}"`,
    'topic: "构建"', 'tags: ["白鹭项目", "Vite"]', '---', '',
    '白鹭项目的构建工具是 Vite 8.4.2。', '',
  ].join('\n'))
  writeFileSync(join(notes, 'legacy.md'), [
    '---', 'dsh_knowledge: true', 'topic: "迁移"', 'tags: ["白鹭项目", "legacy"]', '---', '',
    '白鹭项目以前用 Rollup 4.0。', '',
  ].join('\n'))
  const { ctx, handlers, effects } = fakeContext(root)
  t.after(() => {
    for (const effect of effects) { try { effect()?.() } catch {} }
    rmSync(root, { recursive: true, force: true })
  })
  apply(ctx, { dataDir, capture: { enabled: false }, maintenance: { enabled: false } })
  const ask = async (dir) => {
    const messages = [{ role: 'user', source: { kind: 'user' }, content: '白鹭项目的构建工具是什么版本？' }]
    const turn = await handlers['agent/pre-step']({ agent: { session: { header: { cwd: dir } } }, messages },
      async () => ({ kind: 'enter', messages }))
    return turn.messages.filter(m => m.source?.kind === 'memory').flatMap(m => m.content.map(b => b.text)).join('\n')
  }
  const local = await ask(cwd)
  assert.match(local, /Vite 8\.4\.2/u)
  assert.doesNotMatch(local, /Rollup 4\.0/u)
  assert.equal(await ask(otherCwd), '', 'project notes do not cross into another project')
})

test('pre-step follows the selected model and does not inject after the host cancels the call', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-memory-recall-cancel-'))
  const dataDir = join(root, 'data'), cwd = join(root, 'project')
  const projectKey = projectIdentity(cwd).key
  const store = new MemoryStore({ root: dataDir }).open()
  assert.equal(store.write({
    id: 'mem_cancel01', kind: 'fact', scope: 'project', projectKey,
    content: '发布验收记录里安排 PostgreSQL 16 于周五进行最后核对。', status: 'active', confidence: 0.95,
  }).ok, true)

  let signalAtProvider, cancelProvider
  const providerStarted = new Promise(resolve => { signalAtProvider = resolve })
  const providerGate = new Promise(resolve => { cancelProvider = resolve })
  let providerCalls = 0
  const llm = {
    async resolveModelInfo() { return {} },
    async *stream(options) {
      providerCalls += 1
      assert.equal(options.provider, 'selected-provider')
      assert.equal(options.model, 'selected-model')
      signalAtProvider(options.signal)
      await providerGate
      throw new Error('host cancelled current turn')
    },
  }
  const { ctx, handlers, effects } = fakeContext(root)
  const originalGet = ctx.get.bind(ctx)
  ctx.get = (key) => key === 'llm' ? llm : originalGet(key)
  t.after(() => {
    for (const effect of effects) { try { effect()?.() } catch {} }
    rmSync(root, { recursive: true, force: true })
  })
  apply(ctx, { dataDir, capture: { enabled: false }, maintenance: { enabled: false } })
  const controller = new AbortController()
  const messages = [{ role: 'user', source: { kind: 'user' }, content: '系统维护窗口的负责人是谁？' }]
  const pending = handlers['agent/pre-step']({
    agent: { session: { id: 'session-cancel', header: { cwd } } }, messages, signal: controller.signal,
    modelSelection: { provider: 'selected-provider', model: 'selected-model', reasoningEffort: 'low' },
  }, async () => ({ kind: 'enter', messages }))
  const streamSignal = await providerStarted
  controller.abort()
  cancelProvider()
  assert.equal(streamSignal.aborted, true)
  const result = await pending
  assert.equal(providerCalls, 1)
  assert.equal(result.messages.some(message => message?.source?.kind === 'memory' && message?.source?.plugin === 'dsh-memory'), false)
})
