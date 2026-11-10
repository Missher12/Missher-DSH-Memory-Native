import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'
import { apply } from '../index.js'
import { buildRecord } from '../host/records.js'
import { projectIdentity, scopePaths } from '../host/paths.js'
import { recallQueryPlan } from '../host/recall.js'

const versions = [['pnpm','9.12.3'],['Node','22.13.1'],['Redis','7.2.4'],['PostgreSQL','16.3'],
  ['Vite','8.5.1'],['React','19.2.1'],['TypeScript','5.8.2'],['Vitest','3.1.4']]
const question = `琥珀项目的 ${versions.map(([name])=>name).join('、')} 版本分别是多少？`

async function setup(t, inject = {}, fixtureContents = null) {
  const root=mkdtempSync(join(tmpdir(),'memory-completeness-')),cwd=join(root,'project'),dataDir=join(root,'data')
  const key=projectIdentity(cwd).key, loc=scopePaths(dataDir,'project',key), handlers={},disposers=[]
  mkdirSync(loc.dir,{recursive:true})
  const contents=fixtureContents ?? [...versions.map(([name,version])=>`琥珀项目的 ${name} 版本是 ${version}。`),
    ...Array.from({length:50},(_,i)=>`无关仓储零件编号为 STOCK-${i}。`)]
  const rows=contents
    .map((content,i)=>{const built=buildRecord({scope:'project',projectKey:key,kind:'fact',content,confidence:.95},{id:`mem_complete_${i}`,now:Date.now()});assert.ok(built.ok);return {...built.record,status:'active'}})
  writeFileSync(loc.file,rows.map(row=>JSON.stringify(row)).join('\n')+'\n')
  let routeReady
  const ready=new Promise(resolve=>{routeReady=resolve})
  apply({get:name=>name==='webServer'?{register(route){routeReady(route);return()=>{}}}:undefined,
    on:(name,handler)=>{handlers[name]=handler;return()=>{}},
    effect:factory=>{const dispose=factory();if(typeof dispose==='function')disposers.push(dispose)},
    logger:{warn(){},info(){},debug(){}}},
    {dataDir,capture:{enabled:false},maintenance:{enabled:false},obsidian:{autoSync:false},inject:{maxTokens:600,...inject}})
  const route=await ready
  t.after(()=>{for(const dispose of disposers.reverse())dispose();rmSync(root,{recursive:true,force:true})})
  return async(query=question)=>{
    const messages=[{id:'question',role:'user',source:{kind:'user'},content:query}]
    const response=await handlers['agent/pre-step']({agent:{session:{id:'new-session',header:{cwd}}},messages},async()=>({kind:'enter',messages}))
    const block=response.messages.filter(m=>m.source?.kind==='memory').flatMap(m=>m.content.map(b=>b.text)).join('\n')
    let stats
    const request=Readable.from([Buffer.from(JSON.stringify({method:'stats',input:{scope:'project',projectKey:key}}))]);request.method='POST'
    await route.handler(request,{writeHead(){},end(body){const reply=JSON.parse(body);assert.equal(reply.ok,true);stats=reply.value}})
    return {block,report:stats.lastRecall}
  }
}

test('eight named objects remain independent questions and inherit the shared version property',()=>{
  const slots=recallQueryPlan(question,'',false).filter(part=>part.role==='subquestion')
  assert.equal(slots.length,8)
  for(const [name] of versions) assert.ok(slots.some(slot=>slot.entityTerms.includes(name.toLowerCase())&&/版本/u.test(slot.query)),name)
})

test('answer style modifiers in either order are controls, not extra factual questions',()=>{
  for(const instruction of ['请逐项简短回答','请简短逐项回答','请逐项简洁作答','请简要回答']){
    const slots=recallQueryPlan(`${question}${instruction}，没有依据就说不知道；不要调用工具，也不要保存这次问答。`,'',false)
      .filter(part=>part.role==='subquestion')
    assert.equal(slots.length,8,instruction)
    assert.ok(slots.every(slot=>!slot.query.includes('回答')&&!slot.query.includes('作答')))
  }
  assert.ok(recallQueryPlan('用户希望什么风格的回答？','',false).some(part=>part.query.includes('风格')))
})

test('an elliptical floor question retains the object from its preceding location question',()=>{
  const slots=recallQueryPlan('雪松交接的备用物料盒放在哪里，哪一层？','',false).filter(p=>p.role==='subquestion')
  assert.equal(slots.length,2)
  assert.deepEqual(slots[1].entityTerms,slots[0].entityTerms)
  assert.equal(slots[1].detail,'floor')
})

test('a fresh session receives all eight versions when its configured budget fits',async t=>{
  const ask=await setup(t),{block,report}=await ask()
  for(const [name,version] of versions) assert.ok(block.includes(version),`${name} must reach the answer model`)
  assert.equal(report.covered.length,8)
  assert.deepEqual(report.missing,[])
})

test('the delivered coverage denominator excludes answer style instructions',async t=>{
  const ask=await setup(t),{block,report}=await ask(question+'请逐项简短回答，没有依据就说不知道。不要调用工具，也不要保存这次问答。')
  assert.equal(report.total,8)
  assert.equal(report.covered.length,8)
  assert.deepEqual(report.missing,[])
  assert.equal(versions.filter(([,version])=>block.includes(version)).length,8)
})

test('clock and retention stay bound to the named object when nearby clauses name another object',async t=>{
  const ask=await setup(t,{},[
    '碧潮方案的快照每天07:26运行，保留43天；赤潮方案的快照每天06:15运行，保留90天。',
    '碧潮方案的日志每天09:00运行，保留7天。',
    '碧潮计划的快照每天04:00运行，保留21天。',
    '紫杉清理任务每天03:30运行，保留14天。',
    '碧潮方案选择夜间传输，是为了避开白天校验窗口。',
  ])
  const {block,report}=await ask('碧潮方案快照每天几点运行，保留多久？缺少依据就说不知道。不要保存或提炼这次问答。')
  assert.match(block,/07:26/u,JSON.stringify(report,null,2))
  assert.match(block,/43天/u)
  assert.match(block,/碧潮方案的快照每天07:26运行，保留43天；赤潮方案的快照每天06:15运行，保留90天/u)
  assert.doesNotMatch(block,/09:00|7天|04:00|21天|03:30|14天/u)
  assert.equal(report.total,2)
  assert.equal(report.covered.length,2)
  assert.ok(report.covered.every(item=>item.evidence.some(evidence=>evidence.id==='mem_complete_0')))
  assert.deepEqual(report.missing,[])
})

test('coverage reports only delivered evidence after the item limit, with omitted questions explicit',async t=>{
  const ask=await setup(t,{maxItems:2}),{block,report}=await ask()
  assert.equal(versions.filter(([,version])=>block.includes(version)).length,2)
  assert.equal(report.covered.length,2)
  assert.ok(Array.isArray(report.retrieved),'Retrieved evidence is reported separately from delivered evidence')
  assert.equal(report.retrieved.length,8)
  assert.equal(report.budgetOmitted.length,6)
  assert.equal(report.missing.length,6)
  for(const covered of report.covered) for(const evidence of covered.evidence){
    const i=Number(evidence.id.split('_').at(-1));assert.ok(block.includes(versions[i][1]))
  }
})

test('token exhaustion cannot report evidence as delivered',async t=>{
  const ask=await setup(t,{maxTokens:110}),{block,report}=await ask()
  const delivered=versions.filter(([,version])=>block.includes(version)).length
  assert.ok(delivered<8)
  assert.equal(report.covered.length,delivered)
  assert.ok(Array.isArray(report.retrieved),'Retrieved evidence remains visible when the output budget is exhausted')
  assert.equal(report.retrieved.length,8)
  assert.equal(report.missing.length,8-delivered)
})
