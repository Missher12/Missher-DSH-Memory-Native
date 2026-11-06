import assert from 'node:assert/strict'
import { mkdtempSync,rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { apply } from '../index.js'
import { saveSource,writeCaptureTask,updateCaptureTask } from '../host/capture-journal.js'
import { projectIdentity } from '../host/paths.js'
import { MemoryStore } from '../host/store.js'

test('production recall can fill a missing reason only from a live, verified project quote', async t=>{
  const root=mkdtempSync(join(tmpdir(),'dsh-source-recall-'))
  t.after(()=>rmSync(root,{recursive:true,force:true}))
  const cwd=join(root,'A'),key=projectIdentity(cwd).key,scopes=[{scope:'project',projectKey:key}]
  const text='星湾快照改到 02:48，因为午夜会撞上琥珀巡检。'
  const source=saveSource(root,{sessionId:'qa-source',messageId:'msg',sourceKind:'user',role:'user',text,projectKey:key})
  const task='cap_441122334411223344112233'
  writeCaptureTask(root,{id:task,projectKey:key,sessionId:'qa-source',sourceIds:[source.id],
    segment:{entries:[{sourceId:source.id,from:0,to:text.length}]},status:'done'})
  const store=new MemoryStore({root}).open()
  const attrs={scope:'project',projectKey:key,kind:'fact',confidence:.95,evidenceRole:'user',captureTaskId:task,
    sourceRefs:[{sessionId:'qa-source',messageId:'msg',sourceId:source.id,sourceKind:'user',role:'user',from:0,to:text.length,excerpt:text}]}
  const a=store.write({...attrs,content:'星湾快照当前定在 02:48',captureKey:task+':0:x'})
  const b=store.write({...attrs,content:'星湾快照已经调整过一次',captureKey:task+':1:y'})
  assert.ok(a.ok && b.ok)
  updateCaptureTask(root,task,{sourceGrants:[a.record,b.record].map(record=>({
    id:record.id,revision:record.revision,hash:record.contentHash,sourceId:source.id,from:0,to:text.length}))})
  const handlers={},cleanups=[],trace=[]
  apply({get:()=>undefined,on:(k,v)=>{handlers[k]=v},effect:f=>{const d=f();if(typeof d==='function')cleanups.push(d)},logger:{warn(){},debug(){}}},
    {dataDir:root,capture:{enabled:false},maintenance:{enabled:false}},{recallObserver:e=>trace.push(e)})
  t.after(()=>cleanups.reverse().forEach(fn=>fn()))
  async function ask(dir){
    const m={role:'user',source:{kind:'user'},content:'星湾快照几点执行、为什么改？'}
    const r=await handlers['agent/pre-step']({agent:{session:{header:{cwd:dir}}},messages:[m]},async()=>({kind:'enter',messages:[m]}))
    return r.messages.filter(m=>m.source?.kind==='memory').flatMap(m=>m.content.map(b=>b.text)).join(' ')
  }
  assert.match(await ask(cwd),/琥珀巡检/);assert.ok(trace.some(e=>e.phase==='source'&&e.detail==='reason'))
  assert.doesNotMatch(await ask(join(root,'B')),/琥珀巡检|02:48/)
  store.remove(a.record.id,scopes)
  store.purge(a.record.id,scopes)
  assert.doesNotMatch(await ask(cwd),/琥珀巡检/,'a sibling referencing the same source cannot revive a purged fact')
})
