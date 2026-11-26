import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { Worker } from 'node:worker_threads'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate as immediate } from 'node:timers/promises'
import test from 'node:test'
import { saveSource, readSource, blockSourceRecall } from '../host/capture-journal.js'
import { projectIdentity } from '../host/paths.js'
import { grantSourceRecall, SourcePassageIndex } from '../host/source-passages.js'
import { MemoryStore } from '../host/store.js'

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
  const validated=index.validateMany?.(records,projectKey) ?? []
  assert.equal(validated.length,records.length,'batch validation keeps every currently granted passage')
  assert.deepEqual(validated.map(hit=>hit.record.id),records.map(hit=>hit.record.id))
  const tampered={...records[0],record:{...records[0].record,sourceHash:'forged'}}
  assert.equal(tampered.record.id,records[0].record.id,'the tampered copy keeps the authorized record id')
  const validatedPair=index.validateMany([records[0],tampered],projectKey)
  assert.deepEqual(validatedPair,[records[0]])
  assert.strictEqual(validatedPair[0],records[0],'batch validation preserves the authorized hit identity')
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

test('a previous grant cannot make a plain-language credential available to original recall', t => {
  const { root, projectKey, save } = fixture(t)
  const source = save('My previous archive label was Sandstone. My previous API key was QA-placeholder-53.')
  const dir = join(root, 'capture', 'recall-grants', projectKey)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, source.id + '.json'), JSON.stringify({
    version: 1, sourceId: source.id, projectKey, textHash: createHash('sha256').update(source.text).digest('hex'),
    grantedAt: Date.now(), remembered: true,
  }))
  assert.equal(grantSourceRecall(root, source, projectKey), false)
  assert.deepEqual(new SourcePassageIndex(root).search('previous archive label', { projectKey }), [])
})

test('a factual statement with a conversational tail keeps the complete source and respects grant restrictions', t => {
  const { root, projectKey, save } = fixture(t)
  const text = 'I installed the Juniper sensor at Bay 17, have you used that sensor?'
  const permitted = save(text)
  assert.ok(grantSourceRecall(root, permitted, projectKey))
  const denied = [
    'If I installed the Juniper sensor at Bay 23, could you test that sensor?',
    'Could you install the Juniper sensor at Bay 24?',
    'Could you check the Juniper sensor at Bay 25, would you?',
    'Had I installed the Juniper sensor at Bay 26, would you test it?',
    '\"I installed the Juniper sensor at Bay 27, have you used that sensor?',
    '不要保存。I installed the Juniper sensor at Bay 28, have you used that sensor?',
    '> I installed the Juniper sensor at Bay 38, have you used that sensor?',
  ]
  for (const input of denied) assert.equal(grantSourceRecall(root, save(input), projectKey), false, input)
  const hits = new SourcePassageIndex(root).search('Juniper sensor', { projectKey })
  assert.deepEqual(hits.map(hit => hit.record.content), [text])
})

test('cold original indexing yields, sees granted changes, and shares work across callers', async t => {
  const { root, projectKey, save } = fixture(t)
  let doomed
  for (let i = 0; i < 144; i++) {
    const text = i === 70 ? 'The revoked violet inventory terminal is ACTIVE-419.'
      : 'Warehouse pallet ' + i + ' was inspected in aisle G before shift handoff.'
    const source = save(text)
    assert.ok(grantSourceRecall(root, source, projectKey, { remembered: true }))
    if (i === 70) doomed = source.id
  }

  const index = new SourcePassageIndex(root)
  const controller = new AbortController()
  let complete = false
  const first = index.prepare(projectKey).then(outcome => { complete = true; return outcome })
  const stopped = index.prepare(projectKey, controller.signal)
  const concurrent = index.prepare(projectKey)
  await immediate()
  assert.equal(complete, false, 'another callback runs before the original index finishes')
  blockSourceRecall(root, { sourceRefs: [{ sourceId: doomed }] })
  const added = save('The dawn inventory token is SWAN-821.')
  assert.ok(grantSourceRecall(root, added, projectKey, { remembered: true }))
  controller.abort()
  assert.equal(await stopped, false)
  assert.equal(await first, true)
  assert.equal(await concurrent, true)
  assert.equal(index.search('dawn SWAN-821', { projectKey })[0].record.sourceRefs[0].sourceId, added.id)
  assert.ok(!index.search('violet ACTIVE-419', { projectKey }).some(hit => hit.record.sourceRefs[0].sourceId === doomed))
})

test('deep passage lookup spends its shared budget only on the supplied questions', t => {
  const { root, projectKey, save } = fixture(t)
  for (const text of ['银帆快照保留 47 天。', '银帆快照改期是为避开夜间磁盘峰值。', '银帆快照每天 04:20 执行。']) {
    assert.ok(grantSourceRecall(root, save(text), projectKey))
  }
  const index = new SourcePassageIndex(root)
  const inspected = []
  const queries = ['银帆快照 保留', '银帆快照 改期']
  const result = index.findEvidence(queries, {
    projectKey, maxTokens: 90,
    match(query, hit) {
      inspected.push(query)
      return hit.record.content.includes(query.split(' ').at(-1)) ? hit : null
    },
  })
  assert.deepEqual(result.matches.map(({ query }) => query), queries)
  assert.ok(result.tokens > 0 && result.tokens <= 90)
  assert.deepEqual([...new Set(inspected)], queries)
  const exhausted = index.findEvidence(queries, { projectKey, maxTokens: 3, match: (_, hit) => hit })
  assert.deepEqual(exhausted.matches, [])
  assert.ok(exhausted.tokens <= 3)
})

test('a separate writer forgetting newer matches does not crowd out the remaining original', t => {
  const { root, projectKey, save } = fixture(t)
  const at = Date.UTC(2026, 10, 1)
  const query = 'Granite beacon'
  const kept = save('Granite beacon is ZX099.', { at })
  const forgotten = Array.from({ length: 12 }, (_, offset) =>
    save('Granite beacon is ZX' + (100 + offset) + '.', { at: at + 1 + offset }))
  for (const source of [kept, ...forgotten]) assert.ok(grantSourceRecall(root, source, projectKey))
  const reader = new SourcePassageIndex(root)
  const search = () => reader.search(query, { projectKey, limit: 1 }).map(hit => hit.record.sourceRefs[0].sourceId)
  assert.deepEqual(search(), [forgotten.at(-1).id])

  const writer = new MemoryStore({ root }).open()
  for (const source of forgotten) writer.revokeSource(source.id, projectKey)
  const deep = reader.findEvidence([query], { projectKey, maxTokens: 9, match: (_, hit) => hit })
  assert.deepEqual({
    ranked: search(),
    deep: deep.matches.map(({ hit }) => hit.record.sourceRefs[0].sourceId),
  }, { ranked: [kept.id], deep: [kept.id] })
})

test('the question clock limits ranked, deep, semantic and neighboring user passages', t => {
  const { root, projectKey, save } = fixture(t)
  const now = Date.UTC(2026, 10, 25, 12)
  const earlier = save('Cedar lamp inventory uses the older label.', { at: now + 20, eventTime: now - 30, eventSeq: 1 })
  const boundary = save('Cedar lamp inventory has the current label.', { at: now, eventTime: now, eventSeq: 2 })
  const future = save('Cedar lamp inventory has a future label.', { at: now - 20, eventTime: now + 30, eventSeq: 3 })
  const legacy = save('Cedar lamp inventory has a later legacy label.', { at: now + 30, eventSeq: 4 })
  for (const source of [earlier, boundary, future, legacy]) assert.ok(grantSourceRecall(root, source, projectKey))
  const index = new SourcePassageIndex(root)
  const query = 'Cedar lamp inventory'
  const allowed = new Set([earlier.id, boundary.id])
  const ids = hits => new Set(hits.map(hit => hit.record.sourceRefs[0].sourceId))
  const ranked = index.search(query, { projectKey, now })
  assert.deepEqual(ids(ranked), allowed)
  assert.deepEqual(ids(index.candidates(projectKey, { now })), allowed)
  const deep = index.findEvidence([query], { projectKey, now, allMatches: true, acceptOriginal: true,
    match: (_, hit) => hit, distinctKey: (_, hit) => hit.record.id })
  assert.deepEqual(ids(deep.matches.map(({ hit }) => hit)), allowed)
  const last = ranked.find(hit => hit.record.sourceRefs[0].sourceId === boundary.id)
  assert.deepEqual(index.followingMessages(last, projectKey, { now }), [])
  assert.deepEqual(ids(index.previousMessages(last, projectKey, { now })), new Set([earlier.id]))
  assert.deepEqual(ids(index.search(query, { projectKey, now: now + 30 })),
    new Set([earlier.id, boundary.id, future.id, legacy.id]))
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
  assert.deepEqual(index.validateMany?.([hit],projectKey) ?? [],[])
  assert.equal(index.validate(hit,projectKey),false)
  assert.deepEqual(index.search('琉璃交接',{projectKey}),[])
  assert.deepEqual(new SourcePassageIndex(root).candidates(projectKey),[])
  assert.equal(grantSourceRecall(root,source,projectKey),false,'replayed capture cannot revive a forgotten source')
})

test('the batch reader does not publish an original revoked while fetching its grant', async t => {
  const { root, projectKey, save } = fixture(t)
  const before = save('The Alder incident review ran at 04:31.')
  const during = save('The Boulder incident review ran at 19:42.')
  const allowed = save('The Cedar incident review ran at 07:25.')
  for (const source of [before, during, allowed]) assert.ok(grantSourceRecall(root, source, projectKey))
  blockSourceRecall(root, { sourceRefs: [{ sourceId: before.id }] })
  const workerSource = `
    import fs from 'node:fs'
    import { syncBuiltinESMExports } from 'node:module'
    import { workerData } from 'node:worker_threads'
    const read = fs.readFileSync
    let revoked = false
    fs.readFileSync = (file, ...args) => {
      if (file === workerData.trigger && !revoked) {
        revoked = true
        fs.writeFileSync(workerData.marker, '')
      }
      return read(file, ...args)
    }
    syncBuiltinESMExports()
    await import(workerData.moduleUrl)
  `
  const worker = new Worker(new URL('data:text/javascript,' + encodeURIComponent(workerSource)), { workerData: {
    root, projectKey,
    moduleUrl: new URL('../host/source-passage-worker.js', import.meta.url).href,
    trigger: join(root, 'capture', 'recall-grants', projectKey, during.id + '.json'),
    marker: join(root, 'capture', 'sources', during.id + '.recall-blocked'),
  } })
  t.after(() => worker.terminate())
  const pull = async () => {
    const response = once(worker, 'message')
    worker.postMessage([before.id, during.id, allowed.id])
    return (await response)[0].map(item => item.id)
  }
  assert.deepEqual(await pull(), [allowed.id])
  assert.deepEqual(await pull(), [allowed.id])
})
