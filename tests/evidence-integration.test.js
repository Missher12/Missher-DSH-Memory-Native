import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'
import { apply } from '../index.js'
import { MemoryStore } from '../host/store.js'
import { projectIdentity } from '../host/paths.js'
import { saveSource, readSource } from '../host/capture-journal.js'
import { grantSourceRecall } from '../host/source-passages.js'

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
  apply({ get: name => name === 'webServer' ? webServer : name === 'llm' ? llm : undefined,
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
  const ask = async content => {
    const messages = [{ id: `query-${++turn}`, role: 'user', source: { kind: 'user' }, content }]
    const result = await handlers['agent/pre-step']({
      agent: { session: { id: 'session-integration', header: { cwd } } }, messages,
      modelSelection: { provider: 'host-provider', model: 'host-model' },
    }, async () => ({ kind: 'enter', messages }))
    return result.messages.filter(m => m.source?.kind === 'memory').flatMap(m => m.content.map(b => b.text)).join('\n')
  }
  return { root, dataDir, key, panel, ask, warnings }
}

test('unextracted original evidence remains usable without another paid call, but is not reported as confirmed coverage', async t => {
  const {dataDir,key,panel,ask}=await setup(t)
  const source=readSource(dataDir,saveSource(dataDir,{sessionId:'source-session',projectKey:key,role:'user',sourceKind:'user',text:'碧潮交接的备用联络代号是雨燕七号。'}).id)
  grantSourceRecall(dataDir,source,key)
  const answer=await ask('碧潮交接的备用联络代号是什么？')
  assert.match(answer,/雨燕七号/u)
  assert.match(answer,/用户原文（未提炼）/u)
  assert.match(answer,/可按用户所述引用/u)
  assert.doesNotMatch(answer,/\[事实\]/u)
  const report=(await panel('stats',{scope:'project',projectKey:key})).lastRecall
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
  assert.equal((await panel('stats',{scope:'global'})).lastRecall.candidates.length,0)
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
  const report = (await panel('stats', { scope: 'project', projectKey: 'unused' })).lastRecall
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
