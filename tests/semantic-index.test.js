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

test('unchanged searches reuse prepared passage keys and only prepare changed records',async t=>{
  const {root,key,record}=fixture(t),e=engine(),index=new SemanticRecallIndex(root,{engine:e})
  t.after(()=>index.dispose())
  await index.search(['环境'],[record],{projectKey:key});await index.settle()
  const prepared=index.status().preparedChunks
  await index.search(['环境'],[record],{projectKey:key});await index.settle()
  assert.equal(index.status().preparedChunks,prepared)
  assert.equal(e.inputs.filter(text=>text.startsWith('绒花')).length,1)
  const changed={...record,revision:2,contentHash:'b',content:'绒花环境更新为 Node 24。'}
  await index.search(['环境'],[changed],{projectKey:key});await index.settle()
  assert.equal(index.status().preparedChunks,prepared+1)
  assert.equal(e.inputs.filter(text=>text.startsWith('绒花')).length,2)
})

test('semantic liveness checks score candidates in small batches and refill after stale top hits',async t=>{
  const {root,key,record}=fixture(t),e=engine();let checked=0,batches=0
  const records=Array.from({length:120},(_,i)=>({...record,id:`mem_candidate_${i}`,content:`候选事实 ${i}。`}))
  const index=new SemanticRecallIndex(root,{engine:e,isLiveMany(hits){checked+=hits.length;batches++
    return hits.filter(hit=>Number(hit.record.id.split('_').at(-1))>=5)}})
  t.after(()=>index.dispose())
  await index.search(['事实'],records,{projectKey:key});await index.settle()
  const hits=(await index.search(['事实'],records,{projectKey:key}))[0]
  assert.equal(hits.length,20)
  assert.ok(hits.every(hit=>Number(hit.record.id.split('_').at(-1))>=5))
  assert.ok(checked<records.length,`only the leading candidates should be checked, got ${checked}`)
  assert.ok(batches>1,'a second ranked batch fills slots rejected as stale in the first')
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

test('failed passage work stays queued and an explicit retry completes the same authority snapshot',async t=>{
  const {root,key,record}=fixture(t)
  const e=engine();let fail=true
  const embed=e.embed.bind(e)
  e.embed=async(texts,mode)=>{if(mode==='passage'&&fail){fail=false;throw new Error('temporary worker failure')}return embed(texts,mode)}
  const index=new SemanticRecallIndex(root,{engine:e});t.after(()=>index.dispose())
  await index.search(['环境'],[record],{projectKey:key});await index.settle()
  assert.equal(index.status().state,'failed')
  assert.equal(index.status().queued,1)
  await index.prepare({action:'retry'});await index.settle()
  assert.equal(index.status().indexed,1)
  assert.equal(index.status().total,1)
})

test('retry and offline import from a failed state acknowledge the active operation immediately',async t=>{
  const {root,key,record}=fixture(t),e=engine();let failPassage=true
  e.importModel=async()=>{}
  e.embed=async(texts,mode)=>{
    if(mode==='passage'&&failPassage){failPassage=false;throw new Error('temporary local worker failure')}
    return texts.map(()=>[1,...Array(383).fill(0)])
  }
  const index=new SemanticRecallIndex(root,{engine:e});t.after(()=>index.dispose())
  await index.search(['环境'],[record],{projectKey:key});await index.settle()
  assert.equal(index.status().state,'failed')
  const retry=index.prepare({action:'retry'})
  assert.equal(retry.state,'preparing')
  await index.settle()
  e.embed=async()=>{throw new Error('query worker failed')}
  await index.search(['环境'],[record],{projectKey:key});await index.settle()
  assert.equal(index.status().state,'failed')
  const imported=index.prepare({action:'import',sourceDir:'/offline-fixture'})
  assert.equal(imported.state,'importing')
  await index.settle()
})

test('restart reconciles cached vectors against current authority and persists retirement',async t=>{
  const {root,key,record}=fixture(t),first=new SemanticRecallIndex(root,{engine:engine()})
  await first.search(['环境'],[record],{projectKey:key});await first.settle();first.dispose()
  const next=new SemanticRecallIndex(root,{engine:engine()});t.after(()=>next.dispose())
  await next.search(['环境'],[],{projectKey:key})
  assert.equal(next.status().indexed,0)
  const files=readdirSync(join(root,'.cache','semantic','multilingual-e5-small-761b726-v1'))
  const rows=readFileSync(join(root,'.cache','semantic','multilingual-e5-small-761b726-v1',files[0]),'utf8').trim().split('\n').map(JSON.parse)
  assert.equal(rows.at(-1).deleted,true)
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
    assert.equal(fetchCalls,3,'the download uses three bounded attempts; no external request is sent')
    assert.equal(index.status().state,'failed')
    assert.equal(index.status().error,'model-preparation-failed')
  } finally {
    globalThis.fetch=originalFetch
    index.dispose()
  }
})
