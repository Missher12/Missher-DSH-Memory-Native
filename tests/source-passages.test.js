import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { saveSource, readSource, blockSourceRecall } from '../host/capture-journal.js'
import { projectIdentity } from '../host/paths.js'
import { grantSourceRecall, SourcePassageIndex } from '../host/source-passages.js'

function fixture(t) {
  const root=mkdtempSync(join(tmpdir(),'memory-passages-')), projectKey=projectIdentity(join(root,'a')).key
  t.after(()=>rmSync(root,{recursive:true,force:true}))
  const save=(text,extra={})=>readSource(root,saveSource(root,{text,sessionId:'s1',messageId:text,
    projectKey,role:'user',sourceKind:'user',...extra}).id)
  return {root,projectKey,save}
}

test('complete long source has exact overlapping ranges including its end, across restart',t=>{
  const {root,projectKey,save}=fixture(t)
  const source=save('原文开始。'+('普通记录：每日校对样品。🙂\n'.repeat(700))+'末尾决定：夜间快照保留47天。')
  assert.ok(grantSourceRecall(root,source,projectKey))
  const index=new SourcePassageIndex(root), records=index.candidates(projectKey)
  assert.ok(records.length>20)
  const covered=new Uint8Array(source.text.length)
  for(const {record} of records){const ref=record.sourceRefs[0];assert.equal(record.content,source.text.slice(ref.from,ref.to));covered.fill(1,ref.from,ref.to)}
  assert.ok(covered.every(Boolean),'no original range is silently truncated')
  assert.ok(new SourcePassageIndex(root).search('夜间快照保留', {projectKey}).some(h=>h.record.content.includes('47天')))
  assert.equal(readSource(root,source.id).text,source.text)
})

test('old ungranted, opt-out, quoted and non-user sources never acquire automatic access',t=>{
  const {root,projectKey,save}=fixture(t)
  save('旧来源：内部代号是珊瑚。')
  for(const source of [save('不要保存这次对话。代号是珊瑚。'),save('> 引用示例：代号是珊瑚。'),
    save('我们是不是把 Node 版本设为22了？'),save('请帮我确认。Node 版本是多少？'),
    save('代号是珊瑚。',{role:'assistant'}),save('代号是珊瑚。',{sourceKind:'tool'})]) assert.equal(grantSourceRecall(root,source,projectKey),false)
  assert.deepEqual(new SourcePassageIndex(root).candidates(projectKey),[])
})

test('project/root boundaries and permanent forgetting invalidate cached and restarted passages',t=>{
  const {root,projectKey,save}=fixture(t),source=save('琉璃交接的备用号码是橡果七号。')
  grantSourceRecall(root,source,projectKey)
  const index=new SourcePassageIndex(root), hit=index.search('琉璃交接',{projectKey})[0]
  assert.ok(hit)
  const other=projectIdentity(join(root,'b')).key
  assert.deepEqual(index.candidates(other),[])
  assert.equal(index.validate(hit,other),false)
  assert.deepEqual(new SourcePassageIndex(join(root,'other-profile')).candidates(projectKey),[])
  blockSourceRecall(root,hit.record)
  assert.equal(index.validate(hit,projectKey),false)
  assert.deepEqual(index.search('琉璃交接',{projectKey}),[])
  assert.deepEqual(new SourcePassageIndex(root).candidates(projectKey),[])
  assert.equal(grantSourceRecall(root,source,projectKey),false,'replayed capture cannot revive a forgotten source')
})
