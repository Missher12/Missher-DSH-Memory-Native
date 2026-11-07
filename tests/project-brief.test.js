import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deriveProjectBrief } from '../host/project-brief.js'
import { MemoryStore } from '../host/store.js'

const projectKey = 'brief-project', now = Date.UTC(2026, 10, 7)
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'memory-brief-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const store = new MemoryStore({ root, clock: () => now }).open()
  const write = (id, fields = {}) => {
    const result = store.write({ id, kind: 'fact', scope: 'project', projectKey,
      content: id + ' 对应原记录', confidence: .9, ...fields })
    assert.equal(result.ok, true)
    if (fields.status && !['active','candidate'].includes(fields.status)) {
      return store.update(id, {status:fields.status}, [{scope:result.record.scope,projectKey:result.record.projectKey}])
    }
    return result.record
  }
  return { store, write }
}
const items = brief => brief.sections.flatMap(s => s.items)

test('brief groups actual scoped records without inventing evidence or effective dates', t => {
  const {store,write}=fixture(t)
  const source={sessionId:'session-brief',messageId:'message-1',role:'user',sourceKind:'user',excerpt:'因为对账重叠，改到早晨。'}
  write('mem_brief_fact',{observedAt:now-1000,validFrom:null})
  write('mem_brief_decision',{kind:'decision',content:'改到早晨，因为对账重叠。',sourceRefs:[source]})
  write('mem_brief_old',{status:'superseded',validFrom:now-10000,validTo:now-5000})
  write('mem_brief_candidate',{status:'candidate'})
  write('mem_brief_future',{validFrom:now+10000})
  write('mem_brief_deleted',{status:'deleted'})
  write('mem_brief_other',{projectKey:'another-project'})
  write('mem_brief_global',{scope:'global',projectKey:null})
  const brief=deriveProjectBrief(store,{projectKey,now})
  assert.equal(brief.total,5)
  assert.deepEqual(brief.sections.map(s=>s.id),['current','decisions','history','unresolved'])
  const decision=items(brief).find(r=>r.id==='mem_brief_decision')
  assert.equal(decision.content,'改到早晨，因为对账重叠。')
  assert.deepEqual(decision.sourceRefs,[source])
  assert.equal(items(brief).find(r=>r.id==='mem_brief_fact').validFrom,null)
  assert.deepEqual(new Set(brief.sections.find(s=>s.id==='unresolved').items.map(r=>r.id)),new Set(['mem_brief_candidate','mem_brief_future']))
  assert.ok(items(brief).every(r=>r.scope==='project'&&r.projectKey===projectKey))
})

test('brief reflects changed, superseded and forgotten authority immediately', t => {
  const {store,write}=fixture(t),scopes=[{scope:'project',projectKey}]
  write('mem_brief_live',{content:'保留 19 天。'})
  assert.equal(items(deriveProjectBrief(store,{projectKey,now}))[0].content,'保留 19 天。')
  store.update('mem_brief_live',{content:'保留 27 天。'},scopes)
  const changed=items(deriveProjectBrief(store,{projectKey,now}))[0]
  assert.equal(changed.content,'保留 27 天。');assert.equal(changed.revision,2)
  store.update('mem_brief_live',{status:'superseded',validTo:now},scopes)
  assert.equal(deriveProjectBrief(store,{projectKey,now}).sections[0].id,'history')
  store.remove('mem_brief_live',scopes)
  assert.equal(deriveProjectBrief(store,{projectKey,now}).total,0)
})

test('brief pages once across all sections and does not read off-page text', () => {
  let reads=0
  const records=Array.from({length:530},(_,i)=>({
    id:`mem_page_${i}`,revision:1,scope:'project',projectKey,kind:i<240?'fact':'decision',status:i<480?'active':'candidate',
    validFrom:null,validTo:null,observedAt:null,
    get content(){reads++;return `record ${i}`},sourceRefs:[],
  }))
  const store={list:()=>records},all=[]
  let offset=0
  do {
    const page=deriveProjectBrief(store,{projectKey,limit:200,offset,now})
    assert.equal(page.total,530)
    all.push(...items(page).map(r=>r.id));offset=page.nextOffset
  } while(offset!==null)
  assert.equal(all.length,530);assert.equal(new Set(all).size,530)
  assert.equal(reads,530,'Only one page of bodies should be read per call')
  assert.equal(items(deriveProjectBrief(store,{projectKey,offset:600,now})).length,0)
})

test('brief rejects missing scope and invalid pagination',()=>{
  const store={list:()=>{throw Error('must not read store')}}
  for(const input of [{},{projectKey:'../outside'},{projectKey,limit:201},{projectKey,limit:0},{projectKey,offset:-1},{projectKey,offset:.5}]) {
    assert.throws(()=>deriveProjectBrief(store,input),TypeError)
  }
})
