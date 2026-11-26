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

test('knowledge embedding gives each section a first window and keeps complete short statements', async t => {
  const { root, key, record } = fixture(t)
  const entries = Array.from({ length: 35 }, (_, i) =>
    `Inventory ${i + 1} contains packing samples and a paper receipt for the next inspection.`)
  const latest = 'Staff must contact the service desk, verify identity, and obtain replacement credentials.'
  const other = 'Complete the monthly compliance review on its scheduled date.'
  entries.push(other)
  const batches = []
  const model = engine()
  const embed = model.embed.bind(model)
  model.embed = (texts, kind) => {
    if (kind === 'passage') batches.push(texts)
    return embed(texts)
  }
  const index = new SemanticRecallIndex(root, { engine: model })
  t.after(() => index.dispose())
  const article = { ...record, id: 'note:guide.md', kind: 'knowledge', noteReferenceTimes: [null],
    content: [...entries, latest].join('\n'),
    semanticSections: [{ text: entries.join('\n'), datedOnly: false }, { text: latest, datedOnly: false }] }
  await index.search(['recover login'], [article], { projectKey: key })
  await index.settle()
  assert.ok(batches[0]?.includes(latest), 'a short later section is already present in the first batch')
  const statements = new Set(batches.flat().flatMap(text => text.split('\n')))
  assert.deepEqual(statements, new Set([...entries, latest]))
})

test('semantic candidate limits apply independently after each query’s eligibility check', async t => {
  const { root, key, record } = fixture(t)
  const index = new SemanticRecallIndex(root, { engine: engine() })
  t.after(() => index.dispose())
  const records = [
    ...Array.from({ length: 30 }, (_, i) => ({ ...record, id: `mem_current_${i}`, content: `目前的部署说明 ${i}。` })),
    { ...record, id: 'mem_historical', content: '第一次部署使用 Node 16。', status: 'superseded' },
    { ...record, id: 'mem_foreign', projectKey: projectIdentity('/other').key, status: 'superseded' },
  ]
  const queries = ['当前怎么部署', '过去怎么部署']
  const options = { projectKey: key, eligibleForQuery: (row, position) => row.status === ['active', 'superseded'][position] }
  await index.search(queries, records, options)
  await index.settle()
  const [current, history] = await index.search(queries, records, options)
  assert.equal(current.length, 20)
  assert.ok(current.every(hit => hit.record.status === 'active'))
  assert.deepEqual(history.map(hit => hit.record.id), ['mem_historical'])
  assert.equal(index.status().indexed, 31, 'date filtering leaves cached vectors available to future requests')
})

test('dated subsets reuse vectors across restart and leave complete authority reconciliation intact', async t => {
  const { root, key, record } = fixture(t)
  const other = { ...record, id: 'mem_later', content: 'This record applies to a different period.' }
  const earlier = new SemanticRecallIndex(root, { engine: engine() })
  await earlier.search(['initial'], [record, other], { projectKey: key })
  await earlier.settle()
  earlier.dispose()

  const local = engine(), index = new SemanticRecallIndex(root, { engine: local })
  t.after(() => index.dispose())
  const [hits, empty] = await index.search(['matching date', 'date with no evidence'], () => [record], {
    projectKey: key, partial: true, eligibleForQuery: (_item, position) => position === 0,
  })
  assert.deepEqual(hits.map(hit => hit.record.id), [record.id])
  assert.deepEqual(empty, [])
  assert.deepEqual(local.inputs, ['matching date'])
  assert.deepEqual((await index.search(['current'], [record, other], { projectKey: key }))[0]
    .map(hit => hit.record.id).sort(), [record.id, other.id].sort())
  assert.deepEqual(local.inputs, ['matching date', 'current'])
  await index.search(['after forget'], [other], { projectKey: key })
  assert.equal(index.status().indexed, 1)
  assert.deepEqual((await index.search(['after forget'], () => [], { projectKey: key, partial: true })), [[]])
  assert.equal(local.inputs.filter(text => text === 'after forget').length, 1)
})

test('date-only sections share a note index while staying out of current search and preparation', async t => {
  const { root, key, record } = fixture(t)
  const at = Date.UTC(2025, 2, 2), known = [], proof = []
  const present = 'Current handbook paragraph', historical = 'Previously approved handbook paragraph'
  const row = { ...record, kind: 'knowledge', noteReferenceTimes: [null], semanticSections: [
    { text: present, datedOnly: false }, { text: historical, datedOnly: true },
  ] }
  const vector = score => [score, Math.sqrt(1 - score ** 2), ...Array(382).fill(0)]
  const index = new SemanticRecallIndex(root, { engine: { state: 'ready', async embed(texts, mode) {
    if (mode === 'query') return texts.map(() => vector(1))
    known.push(...texts)
    return texts.map(text => vector(text === historical ? 1 : .9))
  } }, isLiveMany(hits) { proof.push(...hits.map(hit => hit.record.noteReferenceTimes)); return hits } })
  t.after(() => index.dispose())
  const search = times => index.search(times.map(String), [{ ...row, noteReferenceTimes: times }], {
    projectKey: key, partial: times.includes(at),
    eligibleForQuery: (note, i, datedOnly) => note.noteReferenceTimes.includes(times[i]) && (!datedOnly || times[i] === at),
    recordForQuery: (note, i) => ({ ...note, noteReferenceTimes: [times[i]] }),
  })
  assert.equal((await search([null]))[0][0].record.recallContent, present)
  assert.deepEqual(known, [present])
  await index.settle()
  await search([null, at])
  await index.settle()
  const mixed = await search([null, at])
  assert.deepEqual(mixed.map(hits => hits[0].record.recallContent), [present, historical])
  assert.deepEqual(proof.at(-1), [at])
  assert.deepEqual(known, [present, historical])
  assert.equal((await search([null]))[0][0].record.recallContent, present)
  assert.equal((await search([at]))[0][0].record.recallContent, historical)
  assert.deepEqual(known, [present, historical])
})

test('overlapping date and current searches keep their own note reference times and candidates', async t => {
  for (const revoke of [false, true]) await t.test(revoke ? 'revoked before ranking' : 'remains authorized', async t => {
    const { root, key, record } = fixture(t)
    const march = Date.UTC(2025, 2, 2), april = Date.UTC(2025, 3, 2)
    const { promise: waiting, resolve: entered } = Promise.withResolvers()
    const { promise: resume, resolve: release } = Promise.withResolvers()
    const archived = { ...record, id: 'note:archived.md', kind: 'knowledge', status: 'superseded' }
    const current = { ...record, id: 'note:current.md', kind: 'knowledge' }
    let revoked = false
    const index = new SemanticRecallIndex(root, { isLive: candidate => !revoked || candidate.id !== archived.id,
      engine: { state: 'ready', async embed(texts, mode) {
        if (mode === 'query' && texts.includes('first dated question')) { entered(); await resume }
        return texts.map(() => [1, ...Array(383).fill(0)])
      } },
    })
    t.after(() => index.dispose())
    const lookup = (query, note, at) => index.search([query], [{ ...note, noteReferenceTimes: [at] }], {
      projectKey: key, partial: at !== null,
      eligibleForQuery: candidate => candidate.noteReferenceTimes.includes(at),
      recordForQuery: candidate => ({ ...candidate, noteReferenceTimes: [at] }),
    })
    const older = lookup('first dated question', archived, march)
    try {
      await waiting
      assert.equal((await lookup('second dated question', archived, april))[0][0].record.id, archived.id)
      assert.deepEqual((await lookup('current question', current, null))[0].map(hit => hit.record.id), [current.id])
      revoked = revoke
    } finally { release() }
    const [datedHits] = await older
    assert.deepEqual(datedHits.map(hit => [hit.record.id, hit.record.noteReferenceTimes]), revoke ? [] : [[archived.id, [march]]])
    await lookup('complete reconciliation after all dated searches', current, null)
    assert.equal(index.status().total, 1)
  })
})

test('disabled semantic search does not open the corpus', async t => {
  const { root, key } = fixture(t)
  const local = engine(), index = new SemanticRecallIndex(root, { engine: local, enabled: false })
  t.after(() => index.dispose())
  assert.deepEqual(await index.search(['query'], () => { throw new Error('corpus must remain unopened') },
    { projectKey: key }), [[]])
  assert.equal(local.calls, 0)
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

test('a deferred corpus only loads originals after local embedding preparation succeeds', async t => {
  const { root, key, record } = fixture(t)
  let loads = 0
  const records = async () => { loads++; return [record] }
  const faulty = new SemanticRecallIndex(root, { engine: {
    ...engine(), state: 'idle', async prepare() { throw Error('model unavailable') },
  } })
  t.after(() => faulty.dispose())
  assert.deepEqual(await faulty.search(['部署环境'], records, { projectKey: key, deferCorpus: true }), [[]])
  assert.equal(loads, 0)

  const model = { ...engine(), state: 'idle', async prepare() { this.state = 'ready' } }
  const ready = new SemanticRecallIndex(root, { engine: model })
  t.after(() => ready.dispose())
  const first = await ready.search(['部署环境'], records, { projectKey: key, deferCorpus: true })
  assert.equal(first[0][0]?.record.id, record.id)
  assert.equal(loads, 1)

  const cancel = new AbortController()
  let entered, finish
  const preparing = new Promise(resolve => { entered = resolve })
  const blocked = new SemanticRecallIndex(root, { engine: {
    ...engine(), state: 'idle', prepare() { entered(); return new Promise(resolve => { finish = resolve }) },
  } })
  t.after(() => blocked.dispose())
  const recall = blocked.search(['部署环境'], records, { projectKey: key, deferCorpus: true, signal: cancel.signal })
  await preparing
  cancel.abort()
  assert.deepEqual(await recall, [[]])
  finish()
  assert.equal(loads, 1)
})
