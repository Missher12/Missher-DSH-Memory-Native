import assert from 'node:assert/strict'
import test from 'node:test'
import { SourceCandidateIndex } from '../host/source-index.js'

const projectKey='source-project'
function record(id,text,patch={}) {
  return {id,kind:'fact',scope:'project',projectKey,status:'active',revision:1,content:'一次交接安排已经确认。',
    confidence:.95,importance:.8,evidenceRole:'user',quoted:false,captureTaskId:'cap_source',captureKey:'cap_source:0:exact',
    sourceRefs:[{role:'user',sourceKind:'user',sourceId:'src_source',from:0,to:text.length,excerpt:text}],...patch}
}

test('source candidate lookup is lazy and finds words absent from the summary',()=>{
  let lists=0,reads=0
  const item=record('mem_source','木棉快照安排在 06:31，保留 35 天。')
  const refs=item.sourceRefs
  Object.defineProperty(item,'sourceRefs',{get(){reads++;return refs}})
  const index=new SourceCandidateIndex({list:()=>{lists++;return[item]}})
  assert.equal(lists,0)
  assert.equal(index.search('木棉快照保留多久',{projectKey})[0].record,item)
  const initialReads=reads
  assert.equal(index.search('木棉快照几点',{projectKey})[0].record,item)
  assert.equal(reads,initialReads,'Unchanged excerpts should not be read and tokenized again')
})

test('source candidates follow revisions and deletion without reviving old words',()=>{
  let rows=[record('mem_source','木棉快照保留 35 天。')]
  const index=new SourceCandidateIndex({list:()=>rows})
  assert.equal(index.search('木棉快照',{projectKey}).length,1)
  rows=[record('mem_source','银杏构建工具采用 Vite。',{revision:2})]
  assert.equal(index.search('木棉快照',{projectKey}).length,0)
  assert.equal(index.search('银杏构建',{projectKey}).length,1)
  rows=[]
  assert.equal(index.search('银杏构建',{projectKey}).length,0)
})

test('source candidates exclude other projects, quotations and untrusted provenance',()=>{
  const rows=[
    record('mem_other','木棉快照保留 35 天。',{projectKey:'other'}),
    record('mem_quoted','木棉快照保留 35 天。',{quoted:true}),
    record('mem_assistant','木棉快照保留 35 天。',{evidenceRole:'assistant'}),
    record('mem_unknown','木棉快照保留 35 天。',{sourceRefs:[{excerpt:'木棉快照保留 35 天。'}]}),
    record('mem_secret','木棉快照 api_key=secret-value'),
  ]
  const index=new SourceCandidateIndex({list:()=>rows})
  assert.deepEqual(index.search('木棉快照',{projectKey}),[])
  assert.deepEqual(index.search('木棉快照',{projectKey:'../outside'}),[])
})
