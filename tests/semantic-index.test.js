import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { SemanticRecallIndex } from '../host/semantic-index.js'
import { projectIdentity } from '../host/paths.js'

// The stub exercises cache lifecycle and boundaries, not semantic quality.
function engine() {
  return { state: 'ready', inputs: [], calls: 0, disposed: false,
    async embed(texts) { this.calls++; this.inputs.push(...texts); return texts.map(()=>[1,...Array(383).fill(0)]) },
    dispose() { this.disposed = true } }
}
function fixture(t) {
  const root=mkdtempSync(join(tmpdir(),'semantic-cache-')), key=projectIdentity(join(root,'project')).key
  t.after(()=>rmSync(root,{recursive:true,force:true}))
  const record={id:'mem_test',scope:'project',projectKey:key,kind:'fact',status:'active',revision:1,contentHash:'a',content:'绒花部署环境使用 Node 22。'}
  return {root,key,record}
}
test('derived vectors survive restart; changed revisions replace old keys and foreign scopes never reach embedding',async t=>{
  const {root,key,record}=fixture(t),e=engine(),index=new SemanticRecallIndex(root,{engine:e})
  await index.search(['环境'],[record,{...record,id:'foreign',projectKey:projectIdentity('/elsewhere').key,content:'FOREIGN'}],{projectKey:key})
  await index.settle()
  assert.ok(!e.inputs.includes('FOREIGN'))
  assert.equal(index.status().indexed,1)
  index.dispose()
  const nextEngine=engine(),next=new SemanticRecallIndex(root,{engine:nextEngine})
  t.after(()=>next.dispose())
  assert.equal((await next.search(['环境'],[record],{projectKey:key}))[0][0].record.id,record.id)
  assert.equal(nextEngine.inputs.length,1,'cached document is not re-embedded')
  const changed={...record,revision:2,contentHash:'b',content:'绒花环境改用 Node 24。'}
  await next.search(['环境'],[changed],{projectKey:key});await next.settle()
  const hit=(await next.search(['环境'],[changed],{projectKey:key}))[0][0]
  assert.equal(hit.record.revision,2);assert.equal(next.status().total,1)
})
test('forgetting during embedding cannot resurrect the document, on disk or in another profile',async t=>{
  const {root,key,record}=fixture(t),e=engine();let release,started
  const ready=new Promise(resolve=>{started=resolve})
  e.embed=async(texts,mode)=>{if(mode==='passage'){started();await new Promise(resolve=>{release=resolve})}return texts.map(()=>[1,...Array(383).fill(0)])}
  const index=new SemanticRecallIndex(root,{engine:e});t.after(()=>index.dispose())
  const pending=index.search(['环境'],[record],{projectKey:key,waitMs:10});await ready
  await index.search(['环境'],[],{projectKey:key});release();await pending;await index.settle()
  assert.deepEqual(await index.search(['环境'],[],{projectKey:key}),[[]]);assert.equal(index.status().indexed,0)
  const other=new SemanticRecallIndex(join(root,'different-profile'),{engine:engine()});t.after(()=>other.dispose())
  assert.deepEqual(await other.search(['环境'],[],{projectKey:key}),[[]])
})

test('an uncached model that cannot reach the network degrades to an empty semantic lane', async t => {
  const {root,key,record}=fixture(t),originalFetch=globalThis.fetch
  let fetchCalls=0
  globalThis.fetch=async()=>{fetchCalls++;throw new TypeError('offline fixture')}
  const index=new SemanticRecallIndex(root,{enabled:true,allowDownload:true,modelDir:join(root,'uncached-model')})
  try {
    const result=await index.search(['部署环境是什么'],[record],{projectKey:key,waitMs:100})
    await index.settle()
    assert.deepEqual(result,[[]])
    assert.equal(fetchCalls,1,'the download attempt is intercepted; no external request is sent')
    assert.equal(index.status().state,'failed')
    assert.match(index.status().error,/offline fixture/u)
  } finally {
    globalThis.fetch=originalFetch
    index.dispose()
  }
})
