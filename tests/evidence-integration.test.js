import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'
import { apply } from '../index.js'
import { MemoryStore } from '../host/store.js'
import { projectIdentity } from '../host/paths.js'
import { estimateTokens } from '../host/recall.js'
import { saveSource, readSource } from '../host/capture-journal.js'
import { grantSourceRecall } from '../host/source-passages.js'

async function waitForStart(started, label, timeoutMs = 5000) {
  let timer
  try {
    await Promise.race([started, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} did not start within ${timeoutMs}ms`)), timeoutMs)
    })])
  } finally { clearTimeout(timer) }
}

async function setup(t, records = [], llm, testOptions) {
  const root = mkdtempSync(join(tmpdir(), 'memory-evidence-integration-'))
  const dataDir = join(root, 'data'), cwd = join(root, 'project'), key = projectIdentity(cwd).key
  const store = new MemoryStore({ root: dataDir }).open(), handlers = {}, effects = [], warnings = []
  for (const row of records) {
    assert.ok(store.write({ kind: 'fact', scope: 'project', projectKey: key, confidence: .95, ...row }).ok)
    if (row.status === 'superseded') store.update(row.id, { status: row.status }, [{ scope: 'project', projectKey: key }])
  }
  let onRoute
  const routeReady = new Promise(resolve => { onRoute = resolve })
  const webServer = { register(route) { onRoute(route); return () => {} } }
  apply({ get: name => name === 'webServer' ? webServer : name === 'llm' ? llm : testOptions?.host?.[name],
    on: (name, fn) => { handlers[name] = fn; return () => {} },
    effect: factory => { effects.push(factory); return () => {} }, logger: { warn(...args) { warnings.push(args.join(' ')) }, info() {} },
  }, { dataDir, capture: { enabled: false }, maintenance: { enabled: false }, obsidian: { autoSync: false } }, testOptions)
  const route = await routeReady
  t.after(() => { for (const effect of effects) { try { effect()?.() } catch {} }; rmSync(root, { recursive: true, force: true }) })
  const panel = async (method, input) => {
    const request = Readable.from([Buffer.from(JSON.stringify({ method, input }))]); request.method = 'POST'
    let response
    await route.handler(request, { writeHead() {}, end(body) { response = JSON.parse(body) } })
    assert.equal(response.ok, true, response.error?.message)
    return response.value
  }
  let turn = 0
  const prepare = async (content, sessionId = 'session-integration', sessionState = {}) => {
    const messages = [{ id: `query-${++turn}`, role: 'user', source: { kind: 'user' }, content }]
    const result = await handlers['agent/pre-step']({
      agent: { session: { id: sessionId, header: { cwd }, ...sessionState } }, messages,
      modelSelection: { provider: 'host-provider', model: 'host-model' },
    }, async () => ({ kind: 'enter', messages }))
    return { result, messages, session: { id: sessionId, header: { cwd }, ...sessionState },
      block: result.messages.filter(m => m.source?.kind === 'memory').flatMap(m => m.content.map(b => b.text)).join('\n') }
  }
  const ask = async (...args) => (await prepare(...args)).block
  return { root, dataDir, key, cwd, panel, ask, prepare, handlers, store, warnings }
}

function completeAnswer(handlers, session, text, reason = 'completed') {
  handlers['session/event'](session, { type: 'assistant/message', data: { message: {
    role: 'assistant', source: { kind: 'assistant' }, content: [{ type: 'text', text }],
  } } })
  handlers['session/event'](session, { type: 'turn/end', data: { reason: { kind: reason } } })
}

test('recall reports follow the active session and project through the completed turn', async t => {
  const otherCwd = join(tmpdir(), 'dsh-memory-report-other-project')
  const otherKey = projectIdentity(otherCwd).key
  const { key, cwd, panel, prepare, handlers } = await setup(t, [
    { id: 'mem_report_a', content: '青岚快照每天04:20执行，保留47天，因为要避开每日导入的磁盘峰值。' },
    { id: 'mem_report_b', projectKey: otherKey, content: '赤潮快照每天06:15执行，保留63天，因为要避开早间归档。' },
  ])
  const questionA = '青岚快照每天几点执行，保留多久，为什么改时间？'
  const questionB = '赤潮快照每天几点执行，保留多久，为什么改时间？'
  const a = await prepare(questionA, 'session-a')
  const b = await prepare(questionB, 'session-b', { header: { cwd: otherCwd } })
  const c = await prepare(questionA, 'session-c')
  const aSession = { id: 'session-a', header: { cwd } }
  const bSession = { id: 'session-b', header: { cwd: otherCwd } }
  completeAnswer(handlers, aSession, '青岚快照每天04:20执行，保留47天，因为要避开每日导入的磁盘峰值。')
  completeAnswer(handlers, bSession, '赤潮快照每天06:15执行，保留63天，因为要避开早间归档。')
  completeAnswer(handlers, c.session, '青岚快照每天04:20执行。')

  const reportA = (await panel('stats', { sessionId: 'session-a', scope: 'project', projectKey: key })).lastRecall
  const reportB = (await panel('stats', { sessionId: 'session-b', scope: 'project', projectKey: otherKey })).lastRecall
  assert.equal(reportA.projectKey, key)
  assert.equal(reportB.projectKey, otherKey)
  assert.equal(reportA.turnKey, 'id:' + a.messages[0].id)
  assert.equal(reportB.turnKey, 'id:' + b.messages[0].id)
  assert.equal(reportA.outcome, 'completed')
  assert.equal(reportA.questions.length, 3)
  assert.ok(reportA.questions.every(question => question.answerCoverage === 'covered'))
  assert.ok(reportA.questions.every(question => question.answerExcerpt !== null))
  assert.ok(reportA.questions.some(question => question.injected.some(evidence => evidence.text.includes('04:20'))))
  assert.equal(reportB.questions.filter(question => question.answerCoverage === 'covered').length, 3)
  const reportC = (await panel('stats', { sessionId: 'session-c', scope: 'project', projectKey: key })).lastRecall
  assert.equal(reportC.questions.filter(question => question.answerCoverage === 'covered').length, 1)
  assert.equal(reportC.questions.filter(question => question.answerCoverage === 'unverified').length, 2)
  assert.equal((await panel('stats', { scope: 'project', projectKey: key })).lastRecall, null)
})

test('retention and reason inherit the named backup, and reason coverage requires a specific phrase', async t => {
  const fog = '雾杉备份每天03:42执行，保留61天，为了避开每日导入的磁盘峰值。'
  const whale = '砂鲸快照每天05:10执行，保留90天，因为要避开批量校验的 CPU 峰值。'
  const { key, prepare, panel, handlers } = await setup(t, [
    { id: 'mem_fog_backup', content: fog },
    { id: 'mem_whale_snapshot', content: whale },
  ])
  const queryFog = '雾杉备份每天几点执行、记录保留多久、为什么改时间？请按原话逐项回答。不要保存本轮问答。'
  const preparedFog = await prepare(queryFog, 'session-fog-backup')
  const pendingFog = (await panel('stats', { sessionId: 'session-fog-backup', scope: 'project', projectKey: key })).lastRecall
  assert.equal(pendingFog.total, 3)
  assert.deepEqual(pendingFog.questions.map(question => question.detail), ['clock', 'retention', 'reason'])
  assert.ok(pendingFog.questions[1].injected.some(evidence => evidence.id === 'mem_fog_backup'))
  assert.ok(pendingFog.questions[2].injected.some(evidence => evidence.id === 'mem_fog_backup'))
  assert.ok(pendingFog.questions.every(question => question.injected.every(evidence => evidence.id !== 'mem_whale_snapshot')))
  completeAnswer(handlers, preparedFog.session, '雾杉备份每天03:42执行，保留61天，因为要避开巡检占用的磁盘峰值。')
  const reportFog = (await panel('stats', { sessionId: 'session-fog-backup', scope: 'project', projectKey: key })).lastRecall
  assert.deepEqual(reportFog.questions.map(question => question.answerCoverage), ['covered', 'covered', 'unverified'])

  const preparedFogExact = await prepare(queryFog, 'session-fog-backup-exact')
  completeAnswer(handlers, preparedFogExact.session, '雾杉备份每天03:42执行，保留61天，因为要避开每日导入的磁盘峰值。')
  const reportFogExact = (await panel('stats', { sessionId: 'session-fog-backup-exact', scope: 'project', projectKey: key })).lastRecall
  assert.deepEqual(reportFogExact.questions.map(question => question.answerCoverage), ['covered', 'covered', 'covered'])

  const queryWhale = '砂鲸快照每天几点执行、记录保留多久、为什么改时间？请按原话逐项回答。不要保存本轮问答。'
  const preparedWhale = await prepare(queryWhale, 'session-whale-snapshot')
  const pendingWhale = (await panel('stats', { sessionId: 'session-whale-snapshot', scope: 'project', projectKey: key })).lastRecall
  assert.equal(pendingWhale.total, 3)
  assert.deepEqual(pendingWhale.questions.map(question => question.detail), ['clock', 'retention', 'reason'])
  assert.ok(pendingWhale.questions[1].injected.some(evidence => evidence.id === 'mem_whale_snapshot'))
  assert.ok(pendingWhale.questions[2].injected.some(evidence => evidence.id === 'mem_whale_snapshot'))
  assert.ok(pendingWhale.questions.every(question => question.injected.every(evidence => evidence.id !== 'mem_fog_backup')))
  completeAnswer(handlers, preparedWhale.session, whale)
  const reportWhale = (await panel('stats', { sessionId: 'session-whale-snapshot', scope: 'project', projectKey: key })).lastRecall
  assert.deepEqual(reportWhale.questions.map(question => question.answerCoverage), ['covered', 'covered', 'covered'])
})

test('clock and retention answer coverage compares complete values', async t => {
  const { key, prepare, panel, handlers } = await setup(t, [
    { id: 'mem_exact_backup_values', content: '雾杉备份每天02:37执行，保留41天。' },
  ])
  const query = '雾杉备份每天几点执行，记录保留多久？'
  const mismatched = await prepare(query, 'session-mismatched-values')
  completeAnswer(handlers, mismatched.session, '雾杉备份每天12:37执行，保留141天。')
  const mismatchReport = (await panel('stats', { sessionId: 'session-mismatched-values', scope: 'project', projectKey: key })).lastRecall
  assert.deepEqual(mismatchReport.questions.map(question => question.answerCoverage), ['unverified', 'unverified'])

  const equivalent = await prepare(query, 'session-equivalent-values')
  completeAnswer(handlers, equivalent.session, '雾杉备份每天 2：37 执行，保留 041 天。')
  const equivalentReport = (await panel('stats', { sessionId: 'session-equivalent-values', scope: 'project', projectKey: key })).lastRecall
  assert.deepEqual(equivalentReport.questions.map(question => question.answerCoverage), ['covered', 'covered'])
})

test('reason coverage strips repeated cause prefixes before comparing the source phrase', async t => {
  const { key, prepare, panel, handlers } = await setup(t, [
    { id: 'mem_reason_prefixes', content: '星芒快照改到03:42的原因是为了避开每日导入的磁盘峰值。' },
  ])
  const prepared = await prepare('星芒快照为什么改到03:42？', 'session-reason-prefixes')
  completeAnswer(handlers, prepared.session, '原因：避开每日导入的磁盘峰值。')
  const report = (await panel('stats', { sessionId: 'session-reason-prefixes', scope: 'project', projectKey: key })).lastRecall
  assert.equal(report.questions.length, 1)
  assert.equal(report.questions[0].detail, 'reason')
  assert.equal(report.questions[0].answerCoverage, 'covered')
})

test('multi-question answer coverage is independent, and repeated question values do not collapse slots', async t => {
  const { key, panel, prepare, handlers } = await setup(t, [
    { id: 'mem_same_value_snapshot', content: '银帆快照每天04:20执行，报表也每天04:20开始。' },
    { id: 'mem_retention_value', content: '银帆快照保留47天。' },
  ])
  const prepared = await prepare('银帆快照几点执行，报表几点开始，银帆快照保留多久？', 'session-partial')
  completeAnswer(handlers, prepared.session, '银帆快照和报表都在04:20。保留期限我无法确认。')
  const report = (await panel('stats', { sessionId: 'session-partial', scope: 'project', projectKey: key })).lastRecall
  assert.equal(report.questions.length, 3)
  assert.equal(report.questions.filter(question => question.answerCoverage === 'covered').length, 2)
  assert.equal(report.questions.filter(question => question.answerCoverage === 'unverified').length, 1)
  assert.equal(report.questions.filter(question => question.query.includes('几点') || question.query.includes('开始')).length, 2)
})

test('duplicate native inbox and user events do not erase the report for the same turn', async t => {
  const { key, panel, prepare, handlers } = await setup(t, [
    { id: 'mem_duplicate_native_event', content: '星芒快照每天在03:42执行，保留61天。' },
  ])
  const prepared = await prepare('星芒快照每天几点执行，保留多久？', 'session-duplicate-event')
  const input = prepared.messages[0]
  handlers['session/event'](prepared.session, { type: 'user/message', data: input })
  handlers['session/event'](prepared.session, { type: 'agent/inbox/spliced', data: { inserted: [input] } })
  completeAnswer(handlers, prepared.session, '星芒快照每天在03:42执行，保留61天。')
  const report = (await panel('stats', { sessionId: prepared.session.id, scope: 'project', projectKey: key })).lastRecall
  assert.ok(report)
  assert.equal(report.outcome, 'completed')
  assert.deepEqual(report.questions.map(question => question.answerCoverage), ['covered', 'covered'])
})

test('no-evidence, unanswered, aborted and forget outcomes never claim answer coverage', async t => {
  const { key, panel, prepare, handlers } = await setup(t, [
    { id: 'mem_forget_report', content: '碧潮交接的备用代号是雨燕七号。' },
  ])
  const noEvidence = await prepare('火星的公转周期是多少？', 'session-empty')
  completeAnswer(handlers, noEvidence.session, '火星的公转周期是687天。')
  const emptyReport = (await panel('stats', { sessionId: 'session-empty', scope: 'project', projectKey: key })).lastRecall
  assert.ok(emptyReport.questions.every(question => question.answerCoverage !== 'covered'))

  const unanswered = await prepare('碧潮交接的备用代号是什么？', 'session-unanswered')
  handlers['session/event'](unanswered.session, { type: 'assistant/message', data: { message: {
    role: 'assistant', source: { kind: 'candidate' }, content: [{ type: 'text', text: '雨燕七号。' }],
  } } })
  handlers['session/event'](unanswered.session, { type: 'tool/result', data: { content: '雨燕七号。' } })
  handlers['session/event'](unanswered.session, { type: 'assistant/message', data: { message: {
    role: 'assistant', channel: 'analysis', source: { kind: 'assistant' }, content: [{ type: 'text', text: '雨燕七号。' }],
  } } })
  handlers['session/event'](unanswered.session, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  const unansweredReport = (await panel('stats', { sessionId: 'session-unanswered', scope: 'project', projectKey: key })).lastRecall
  assert.equal(unansweredReport.outcome, 'completed')
  assert.ok(unansweredReport.questions.every(question => question.answerCoverage === 'unverified'))
  assert.ok(unansweredReport.questions.every(question => question.answerExcerpt === null))

  const aborted = await prepare('碧潮交接的备用代号是什么？', 'session-aborted')
  completeAnswer(handlers, aborted.session, '雨燕七号。', 'aborted')
  const abortedReport = (await panel('stats', { sessionId: 'session-aborted', scope: 'project', projectKey: key })).lastRecall
  assert.equal(abortedReport.outcome, 'aborted')
  assert.ok(abortedReport.questions.every(question => question.answerCoverage !== 'covered'))

  await panel('removeMemory', { id: 'mem_forget_report', scope: 'project', projectKey: key })
  assert.equal((await panel('stats', { sessionId: 'session-unanswered', scope: 'project', projectKey: key })).lastRecall, null)
})

test('the routed model capacity and the host measurement shrink the real injection budget to zero', async t => {
  let occupied = 850
  let route = 'host-model'
  const meter = { measure: () => ({ totalTokens: occupied }), estimateMessage: () => 20 }
  const ctxWindow = 1500
  const { ask, panel } = await setup(t, [
    { id: 'mem_silver_snapshot', content: '银帆快照每天 04:20 执行，保留 47 天。' },
  ], { async resolveModelInfo(provider, model) {
    assert.equal(provider, 'host-provider')
    assert.equal(model, 'host-model')
    return { context: { contextWindow: ctxWindow } }
  } }, { host: { tokenMeter: meter } })
  const state = { requestContext: () => ({ provider: 'host-provider', model: route, contextWindow: ctxWindow }),
    requestHeader: () => ({ config: { provider: 'host-provider', model: 'host-model', maxTokens: 300 } }) }
  const question = '银帆快照每天几点执行，保留多久？'
  assert.match(await ask(question, 'session-budget', state), /04:20/u)
  const first = (await panel('stats', { sessionId: 'session-budget' })).contextUsage
  assert.ok(first.budget < 360 && first.budget >= first.tokens && first.tokens > 0)
  route = 'previous-model'
  occupied = 1490
  assert.equal(await ask(question, 'session-budget', state), '')
  const second = (await panel('stats', { sessionId: 'session-budget' })).contextUsage
  assert.equal(second.budget, 0)
  assert.equal(second.tokens, 0)
})

test('context usage reports the final memory block and clears on a miss in the same session', async t => {
  const { ask, panel } = await setup(t, [
    { id: 'mem_snapshot_retention', content: '青岚快照每天 04:20 执行，保留 47 天。' },
  ])
  const usageOf = async sessionId => (await panel('stats', { sessionId })).contextUsage
  assert.equal(await usageOf('session-a'), null)
  const block = await ask('青岚快照每天几点执行，保留多久？', 'session-a')
  assert.match(block, /04:20/u)
  const used = await usageOf('session-a')
  assert.equal(used.tokens, estimateTokens(block))
  assert.equal(used.budget, 360)
  assert.equal(used.items, 1)
  assert.equal(await usageOf('session-b'), null)
  assert.equal(await ask('火星的公转周期是多少？', 'session-b'), '')
  assert.equal((await usageOf('session-b')).tokens, 0)
  assert.deepEqual(await usageOf('session-a'), used)
  assert.equal(await ask('月球的直径是多少？', 'session-a'), '')
  const missed = await usageOf('session-a')
  assert.equal(missed.tokens, 0)
  assert.equal(missed.items, 0)
  assert.equal(await usageOf(undefined), null)
})

test('deep recall searches only the missing snapshot reason and never treats a saved question as evidence', async t => {
  const { ask, panel, dataDir, key } = await setup(t, [
    { id: 'mem_quartz_clock', content: '灰晶快照每天在 03:42 执行。' },
    { id: 'mem_quartz_retention', content: '灰晶快照保留 61 天。' },
  ], {
    async *stream() { assert.fail('Exact original evidence does not need a provider selection call') },
  })
  const grant = (messageId, text) => {
    const source = readSource(dataDir, saveSource(dataDir, { sessionId: 'remember-source', messageId,
      projectKey: key, role: 'user', sourceKind: 'user', text }).id)
    assert.ok(grantSourceRecall(dataDir, source, key))
  }
  grant('real-reason', '记住：灰晶快照改到 03:42，因为要避开每日导入的磁盘峰值。')
  grant('unconfirmed-question', '记住：关机单统一晚班发出。灰晶快照改期是因为审核流程吗？')
  const answer = await ask('灰晶快照每天几点执行、保留多久、为什么改时间？')
  for (const text of ['03:42', '61 天', '避开每日导入的磁盘峰值']) assert.ok(answer.includes(text))
  assert.doesNotMatch(answer, /审核流程/u)
  const report = (await panel('stats', { sessionId: 'session-integration' })).lastRecall
  assert.equal(report.covered.length, 3)
  assert.deepEqual(report.localDeepRecall.queries, ['灰晶快照 为什么改时间'])
  assert.equal(report.localDeepRecall.limit, 50000)
  assert.ok(report.localDeepRecall.tokens > 0 && report.localDeepRecall.tokens <= 50000)
  const original = report.covered.flatMap(row => row.evidence).find(item => item.kind === 'source')
  assert.ok(original)
  await panel('removeMemory', { id: original.id, scope: 'project', projectKey: key })
  assert.doesNotMatch(await ask('灰晶快照为什么改时间？', 'another-session'), /磁盘峰值|审核流程/u)
})

test('unextracted original evidence remains usable without another paid call, but is not reported as confirmed coverage', async t => {
  const {dataDir,key,panel,ask}=await setup(t)
  const source=readSource(dataDir,saveSource(dataDir,{sessionId:'source-session',projectKey:key,role:'user',sourceKind:'user',text:'碧潮交接的备用联络代号是雨燕七号。'}).id)
  grantSourceRecall(dataDir,source,key)
  const answer=await ask('碧潮交接的备用联络代号是什么？')
  assert.match(answer,/雨燕七号/u)
  assert.match(answer,/用户原文（未提炼）/u)
  assert.match(answer,/可按用户所述引用/u)
  assert.doesNotMatch(answer,/\[事实\]/u)
  const report=(await panel('stats',{scope:'project',projectKey:key,sessionId:'session-integration'})).lastRecall
  assert.equal(report.covered.length,0)
  assert.equal(report.candidates.length,1)
  const id=report.candidates[0].evidence[0].id
  await assert.rejects(()=>panel('removeMemory',{id,scope:'project',projectKey:projectIdentity('/another').key}))
  await panel('removeMemory',{id,scope:'project',projectKey:key})
  assert.doesNotMatch(await ask('碧潮交接的备用联络代号是什么？'),/雨燕七号/u)
})

test('a high vector score cannot inject unrelated global memories for a physical-location question',async t=>{
  // Adversarial similarity exercises the policy boundary, not embedding quality.
  const engine={state:'ready',async embed(texts){return texts.map(()=>[1,...Array(383).fill(0)])},dispose(){}}
  const {ask,panel}=await setup(t,[{id:'mem_ui_preference',scope:'global',projectKey:null,kind:'preference',
    content:'用户要求界面设计先用可交互的 HTML demo 做方案预览，再落到真实面板。'},
    {id:'mem_unrelated_global',scope:'global',projectKey:null,kind:'fact',content:'用户今天要整理 Git 仓库。'}],undefined,{semantic:{enabled:true,engine}})
  assert.equal(await ask('雪松交接的备用物料盒放在哪里？'),'')
  assert.equal((await panel('stats',{scope:'global',sessionId:'session-integration'})).lastRecall.candidates.length,0)
})

test('answering a global preference cannot inject an unrelated or foreign project preference via the profile',async t=>{
  const {ask,panel}=await setup(t,[
    {id:'mem_unit_preference',kind:'preference',scope:'global',content:'我在所有项目都偏好用公制单位。',confidence:.90},
    {id:'mem_color_preference',kind:'preference',scope:'global',content:'我偏好用浅色背景。',confidence:.98},
    {id:'mem_foreign_preference',kind:'preference',projectKey:'other-project',content:'本项目的外发报告标题要用玉竹四号。',confidence:.99},
  ])
  const block=await ask('我的单位偏好是什么？')
  assert.match(block,/公制单位/u)
  assert.doesNotMatch(block,/玉竹四号|浅色背景/u)
  const report=(await panel('stats',{scope:'global',sessionId:'session-integration'})).lastRecall
  assert.deepEqual(report.covered.flatMap(item=>item.evidence.map(e=>e.id)),['mem_unit_preference'])
})

test('a preference question matches its requested category instead of the common wording around it',async t=>{
  const {ask,panel}=await setup(t,[
    {id:'mem_metric',kind:'preference',scope:'global',content:'我在所有项目都偏好用公制单位。'},
    {id:'mem_light_theme',kind:'preference',scope:'global',content:'我偏好用浅色背景。'},
  ])
  const block=await ask('我偏好用什么计量单位？请只给单位。不要保存或提炼本轮问答。')
  assert.match(block,/公制单位/u)
  assert.doesNotMatch(block,/浅色背景/u)
  const report=(await panel('stats',{scope:'global',sessionId:'session-integration'})).lastRecall
  assert.equal(report.total,1)
  assert.equal(report.covered.length,1)
})

test('an explicitly different project name blocks otherwise matching evidence while unnamed facts remain usable',async t=>{
  const query='霁海项目的离线构建识别码是什么？'
  const other=await setup(t,[{id:'mem_other_named_project',content:'夜航项目的离线构建识别码是云雀六号。'}])
  assert.equal(await other.ask(query),'')
  const same=await setup(t,[{id:'mem_same_named_project',content:'霁海工程的离线构建识别码是云雀六号。'}])
  assert.match(await same.ask(query),/云雀六号/u)
  const implicit=await setup(t,[{id:'mem_implicit_project',content:'离线构建识别码是云雀六号。'}])
  assert.match(await implicit.ask(query),/云雀六号/u)
})

test('semantic fallback carries each attempt through candidate fusion without a provider call',async t=>{
  const engine={state:'ready',modes:[],async embed(texts,mode){this.modes.push(mode);return texts.map(()=>[1,...Array(383).fill(0)])},dispose(){}}
  const {ask,warnings}=await setup(t,[{id:'mem_semantic_fallback',content:'交接工具的登记名称是雨燕七号。'}],undefined,
    {semantic:{enabled:true,engine}})
  const answer=await ask('紫杉巡检的备用代号是什么？')
  assert.ok(engine.modes.includes('query'),'the mock local query embedding reaches semantic recall')
  assert.match(answer,/雨燕七号/u)
  assert.ok(!warnings.some(message=>message.includes('query is not defined')),warnings.join('\n'))
})

test('direct lexical evidence without tags survives disabled and failed semantic recall',async t=>{
  for (const tags of [[], ['pnpm']]) {
    for (const semanticMode of ['disabled', 'failed']) {
      const engine={state:'ready',calls:0,async embed(){this.calls++;throw new Error('offline fixture')},dispose(){}}
      const {ask,warnings}=await setup(t,[{id:`mem_${tags.length}_${semanticMode}`,content:'会话 A 决定项目使用 pnpm 管理依赖',tags}],undefined,
        {semantic:{enabled:semanticMode==='failed',engine}})
      const answer=await ask('pnpm 依赖和 Node 版本')
      if (semanticMode === 'failed') assert.ok(engine.calls>0,'the missing Node slot exercises the unavailable semantic lane')
      else assert.equal(engine.calls,0)
      assert.match(answer,/pnpm 管理依赖/u,`tags=${JSON.stringify(tags)}, semantic=${semanticMode}`)
      assert.doesNotMatch(answer,/Node 版本要求是/u)
      assert.ok(!warnings.some(message=>message.includes('offline fixture')),warnings.join('\n'))
    }
  }
})

test('apply rechecks memory authority after passage embedding before persisting a vector', async t => {
  let begin, release
  const started = new Promise(resolve => { begin=resolve })
  const engine={state:'ready',async embed(texts,mode){
    if(mode==='passage') { begin();await new Promise(resolve=>{release=resolve}) }
    return texts.map(()=>[1,...Array(383).fill(0)])
  },dispose(){}}
  const {dataDir,key,panel,ask}=await setup(t,[{id:'mem_revoked_during_embedding',content:'夜航项目的离线构建识别码是云雀六号。'}],undefined,
    {semantic:{enabled:true,engine}})
  const pending=ask('霁海系统的版本追踪编号是多少？')
  try { await waitForStart(started, 'memory passage embedding') }
  catch (error) { release?.(); await pending; throw error }
  await panel('removeMemory',{id:'mem_revoked_during_embedding',scope:'project',projectKey:key})
  release()
  await pending
  assert.equal((await panel('stats',{scope:'project',projectKey:key,sessionId:'session-integration'})).lastRecall,null,
    'a recall already in progress cannot repopulate a report after forgetting')
  assert.equal(await ask('霁海系统的版本追踪编号是多少？'),'')
  const report=await panel('stats',{scope:'project',projectKey:key,sessionId:'session-integration'})
  assert.equal(report.semantic.total,0)
  assert.equal(report.semantic.indexed,0)
  assert.equal(existsSync(join(dataDir,'.cache','semantic','multilingual-e5-small-761b726-v1',key+'.jsonl')),false)
})

test('apply rechecks source grants after passage embedding before persisting a vector', async t => {
  let begin, release
  const started = new Promise(resolve => { begin=resolve })
  const engine={state:'ready',async embed(texts,mode){
    if(mode==='passage') { begin();await new Promise(resolve=>{release=resolve}) }
    return texts.map(()=>[1,...Array(383).fill(0)])
  },dispose(){}}
  const {dataDir,key,ask}=await setup(t,[],undefined,{semantic:{enabled:true,engine}})
  const source=readSource(dataDir,saveSource(dataDir,{sessionId:'grant-session',projectKey:key,role:'user',sourceKind:'user',text:'值守证书的备用联系编号是木槿三号。'}).id)
  assert.equal(grantSourceRecall(dataDir,source,key),true,'the safe user fact must be granted before testing revocation')
  const pending=ask('值守证书的备用联系编号是什么？')
  try { await waitForStart(started, 'source passage embedding') }
  catch (error) { release?.(); await pending; throw error }
  unlinkSync(join(dataDir,'capture','recall-grants',key,source.id+'.json'))
  release()
  await pending
  assert.equal(await ask('值守证书的临时口令是什么？'),'')
  assert.equal(existsSync(join(dataDir,'.cache','semantic','multilingual-e5-small-761b726-v1',key+'.jsonl')),false)
})

test('a note imported through the activated panel is immediately recalled without a restart', async t => {
  const { root, key, panel, ask } = await setup(t, Array.from({ length: 64 }, (_, i) => ({
    id: `mem_other_${i}`, content: `无关设备的盘点编号为 OTHER-${i}。`,
  })))
  const vaultPath = join(root, 'vault'), folder = 'Notes', dest = join(vaultPath, folder, 'knowledge')
  mkdirSync(dest, { recursive: true })
  writeFileSync(join(dest, 'build.md'), `---\ndsh_knowledge: true\nscope: project\nprojectKey: ${key}\n---\n青岩构建配置\n\n青岩项目的构建工具使用 Vite 8.4.2。\n`)
  assert.equal((await panel('knowledgeSync', { direction: 'import', vaultPath, folder })).imported, 1)
  assert.match(await ask('青岩项目的构建工具是什么版本？'), /Vite 8\.4\.2/u)
})

test('one product version cannot mark a different product slot covered; verified paraphrases can', async t => {
  let calls = 0
  const llm = { async *stream(request) {
    calls++
    const data = JSON.parse(request.messages.at(-1).content)
    yield { type: 'text-delta', text: JSON.stringify({ selections: data.slots
      .filter(slot => !slot.query.includes('构建'))
      .map(slot => ({ slot: slot.slot, id: 'mem_relation', revision: 1, quote: slot.query.includes('版本') ? '11.4.7' : 'MariaDB' })) }) }
    yield { type: 'finish', reason: { kind: 'stop' }, usage: { inputTokens: 250, outputTokens: 50, totalTokens: 300 } }
  } }
  // The collector wraps the selection instructions and JSON in a text message.
  const stream = llm.stream.bind(llm)
  llm.stream = request => {
    const content = request.messages.at(-1).content
    const text = typeof content === 'string' ? content : content.map(p => p.text ?? '').join('')
    return stream({ ...request, messages: [{ content: text.slice(text.indexOf('{"query"')) }] })
  }
  const { panel, ask } = await setup(t, [
    { id: 'mem_relation', content: '青岩项目的关系型数据库采用 MariaDB 11.4.7。' },
    { id: 'mem_unrelated', content: '青岩快照每天 06:12 生成，保留 41 天。' },
  ], llm)
  const result = await ask('青岩项目最终把结构化数据交给哪款关系型持久化产品、哪个版本？青岩项目的构建工具及版本是什么？请简短逐项回答。')
  assert.match(result, /MariaDB 11\.4\.7/u)
  assert.doesNotMatch(result, /06:12|41 天/u)
  assert.equal(calls, 1)
  const report = (await panel('stats', { scope: 'project', projectKey: 'unused', sessionId: 'session-integration' })).lastRecall
  assert.equal(report.missing.length, 2)
  assert.ok(report.missing.every(query => /构建/u.test(query)))
  assert.ok(report.covered.every(item => !item.query.includes('构建')))
})

test('current and previous values retain the current change reason as a separate question', async t => {
  const { ask } = await setup(t, [
    { id: 'mem_old_ttl', content: '青岩快照保留 17 天。', status: 'superseded' },
    { id: 'mem_new_ttl', content: '青岩项目现在确认变更：快照保留期限从 17 天改为 29 天，因为月度追溯需要覆盖完整账期。每日 06:12 生成的安排不变。' },
    { id: 'mem_old_reason', content: '青岩快照调整保留期限，是为了节省磁盘容量。', status: 'superseded' },
    { id: 'mem_other_project', content: '红杉项目现在确认变更：快照保留 82 天，因为审计要求。' },
    { id: 'mem_other_object', content: '青岩项目的红杉快照保留 74 天，因为容量足够。' },
  ])
  const result = await ask('青岩快照现在保留多久，改之前是多久，为什么改保留期限？')
  assert.match(result, /17 天/u); assert.match(result, /29 天/u)
  assert.match(result, /覆盖完整账期/u); assert.doesNotMatch(result, /节省磁盘容量/u)
  assert.doesNotMatch(result, /82 天|74 天/u)
})

test('recall follows an explicit person relation across two separate memories', async t => {
  const { ask } = await setup(t, [
    { id: 'mem_project_lead', content: '青岩项目的负责人是林青。' },
    { id: 'mem_leave_handoff', content: '林青请假时，交付值班由周岚接手。' },
    { id: 'mem_name_cooccurrence', content: '林青和周岚属于同一个值班组。' },
  ])

  const result = await ask('青岩项目的负责人是谁，他请假时谁接手？')

  assert.match(result, /青岩项目的负责人是林青/u)
  assert.match(result, /林青请假时，交付值班由周岚接手/u)
  assert.doesNotMatch(result, /同一个值班组/u)
})

test('a role-based relation question joins its owner fact without exposing co-occurrence', async t => {
  const positive = await setup(t, [
    { id: 'mem_role_owner', content: '桐湾项目的值班负责人是许岚。' },
    { id: 'mem_role_delegate', content: '许岚请假时，由顾宁代班。' },
  ])
  const result = await positive.ask('桐湾项目的负责人请假时谁代班？')
  assert.match(result, /许岚/u)
  assert.match(result, /顾宁/u)

  const unrelated = await setup(t, [
    { id: 'mem_role_owner', content: '桐湾项目的值班负责人是许岚。' },
    { id: 'mem_role_cooccurrence', content: '许岚和顾宁一起讨论过请假手续。' },
  ])
  assert.equal(await unrelated.ask('桐湾项目的负责人请假时谁代班？'), '')
})

test('a chosen plan connects only to its separately recorded causal reason', async t => {
  const project = await setup(t, [
    { id: 'mem_backup_decision', kind: 'decision', content: '沐桥项目的备份方式最终采用星港方案。' },
    { id: 'mem_backup_reason', content: '选择星港方案，是因为它允许夜间限速传输。' },
    { id: 'mem_wrong_plan_reason', content: '选择云岚方案，是因为它允许夜间限速传输。' },
    { id: 'mem_cooccurring_reason', content: '星港方案和夜间限速传输曾被同时讨论。' },
    { id: 'mem_foreign_reason', projectKey: projectIdentity('/foreign-project').key,
      content: '选择星港方案，是因为另一个项目需要审计留痕。' },
  ])
  const query = '沐桥项目的备份方式最终采用哪个方案，为什么选这个方案？'
  const answer = await project.ask(query)
  assert.match(answer, /星港方案/u)
  assert.match(answer, /允许夜间限速传输/u)
  assert.doesNotMatch(answer, /云岚方案|同时被讨论|另一个项目/u)

  await project.panel('removeMemory', { id: 'mem_backup_decision', scope: 'project', projectKey: project.key })
  assert.doesNotMatch(await project.ask(query), /允许夜间限速传输/u)
})

test('a denied plan cannot establish a decision-reason bridge', async t => {
  const { ask } = await setup(t, [
    { id: 'mem_denied_backup', kind: 'decision', content: '沐桥项目的备份方式并未采用星港方案。' },
    { id: 'mem_denied_reason', content: '选择星港方案，是因为它允许夜间限速传输。' },
  ])
  const answer = await ask('沐桥项目的备份方式最终采用哪个方案，为什么选这个方案？')
  assert.doesNotMatch(answer, /允许夜间限速传输/u)
})
