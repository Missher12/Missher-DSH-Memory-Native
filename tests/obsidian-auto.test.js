import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import fs, { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync, renameSync, statSync, symlinkSync, utimesSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { MemoryStore } from '../host/store.js'
import { MemoryIndex } from '../host/search.js'
import { exportKnowledgeToVault, importKnowledgeFromVault, serializeMemory } from '../host/obsidian.js'
import { ObsidianSync } from '../host/obsidian-sync.js'
import { promoteMemoryToKnowledge } from '../host/knowledge.js'
import { knowledgeGraph } from '../host/remote-contract.js'

function setup(t) {
  const root=mkdtempSync(join(tmpdir(),'dsh-auto-')), vault=join(root,'vault')
  mkdirSync(vault)
  const store=new MemoryStore({root:join(root,'data')}).open(), index=new MemoryIndex()
  const record=store.write({kind:'fact',scope:'global',content:'原始事实 12345',confidence:.9}).record
  index.upsert(record)
  const config={vaultPath:vault,folder:'DSH Memory',autoSync:true}
  const make=(extra={})=>new ObsidianSync({root:store.root,store,index,getConfig:()=>config,...extra})
  const sync=make(), file=join(vault,config.folder,record.id+'.md')
  t.after(()=>{sync.dispose();rmSync(root,{recursive:true,force:true})})
  return {root,vault,store,index,record,config,sync,file,make}
}
async function waitFor(predicate, timeoutMs=4000) {
 const deadline=Date.now()+timeoutMs
 do {
  // Sync can move the previous file into history before publishing its replacement.
  try { if(predicate())return } catch(error) { if(error.code!=='ENOENT')throw error }
  await new Promise(resolve=>setTimeout(resolve,25))
 } while(Date.now()<deadline)
 assert.fail('condition did not become true before timeout')
}

test('automatic reconciliation imports and exports only changed content, including renamed notes',async t=>{
 const c=setup(t)
 assert.equal((await c.sync.run()).exported,1)
 assert.ok(readFileSync(c.file,'utf8').includes('原始事实 12345'))
 const renamed=join(c.vault,c.config.folder,'我的事实.md');renameSync(c.file,renamed)
 writeFileSync(renamed,readFileSync(renamed,'utf8').replace('原始事实 12345','外部改动 24680'))
 assert.equal((await c.sync.run()).imported,1)
 assert.equal(c.store.find(c.record.id).content,'外部改动 24680')
 const revision=c.store.find(c.record.id).revision
 const stable=await c.sync.run();assert.equal(stable.imported,0);assert.equal(stable.exported,0)
 assert.equal(c.store.find(c.record.id).revision,revision)
 c.store.update(c.record.id,{content:'宿主改动 35791'})
 assert.equal((await c.sync.run()).exported,1)
 assert.ok(readFileSync(renamed,'utf8').includes('宿主改动 35791'))
 assert.equal(existsSync(c.file),false)
})

test('a legacy memory imported from JSON still syncs with its original ID',async t=>{
 const c=setup(t), id='mem_legacy_v1'
 const old={...c.record,id,content:'迁移前的记忆正文。'}
 assert.equal(c.store.importData({schemaVersion:1,global:[old]}).imported,1)
 assert.equal((await c.sync.run()).errors.length,0)
 const file=join(c.vault,c.config.folder,`${id}.md`)
 writeFileSync(file,readFileSync(file,'utf8').replace(old.content,'迁移后从笔记编辑的正文。'))
 const result=await c.sync.run({fullScan:false,files:[`${id}.md`]})
 assert.deepEqual(result.errors,[])
 assert.equal(result.imported,1)
 assert.equal(c.store.find(id).content,'迁移后从笔记编辑的正文。')
})

test('both sides changed retain both originals and survive restart; stale resolution is rejected',async t=>{
 const c=setup(t);await c.sync.run()
 c.store.update(c.record.id,{content:'宿主不同版本'})
 writeFileSync(c.file,readFileSync(c.file,'utf8').replace('原始事实 12345','外部不同版本'))
 const first=await c.sync.run();assert.equal(first.conflicts.length,1)
 assert.equal(c.store.find(c.record.id).content,'宿主不同版本')
 assert.ok(readFileSync(c.file,'utf8').includes('外部不同版本'))
 for(const p of first.conflicts[0].copies)assert.ok(existsSync(p))
 const next=c.make();t.after(()=>next.dispose())
 assert.equal((await next.run()).conflicts[0].token,first.conflicts[0].token)
 writeFileSync(c.file,readFileSync(c.file,'utf8').replace('外部不同版本','外部最后版本'))
 await assert.rejects(()=>next.resolve({...first.conflicts[0],side:'vault'}),/changed|变化/u)
 const latest=await next.run();await next.resolve({...latest.conflicts[0],side:'vault'})
 assert.equal(c.store.find(c.record.id).content,'外部最后版本')
 assert.equal((await next.run()).conflicts.length,0)
})

test('initial divergent files and malformed properties are never overwritten',async t=>{
 const c=setup(t);mkdirSync(join(c.vault,c.config.folder))
 const text=serializeMemory({...c.record,content:'原有外部笔记'})
 writeFileSync(c.file,text)
 assert.equal((await c.sync.run()).conflicts.length,1)
 assert.equal(readFileSync(c.file,'utf8'),text)
 writeFileSync(c.file,text.replace('tags: []','tags: [invalid'))
 const bad=await c.sync.run();assert.equal(bad.errors.length,1)
 assert.ok(readFileSync(c.file,'utf8').includes('tags: [invalid'))
 assert.equal(c.store.find(c.record.id).content,'原始事实 12345')
})

test('forgotten records are not resurrected by an old vault note; vault deletion requires resolution',async t=>{
 const c=setup(t);await c.sync.run()
 rmSync(c.file)
 assert.equal((await c.sync.run()).conflicts.length,1)
 assert.equal(c.store.find(c.record.id).status,'active')
 assert.equal(existsSync(c.file),false)
 c.store.remove(c.record.id)
 writeFileSync(c.file,serializeMemory(c.record))
 await c.sync.run()
 assert.equal(c.store.find(c.record.id).status,'deleted')
 assert.equal(existsSync(c.file),false)
})

test('knowledge edits flow in both directions and conflicts keep both contents',async t=>{
 const c=setup(t), local=join(c.store.root,'knowledge','note.md')
 c.config.autoSync=false
 mkdirSync(join(c.store.root,'knowledge'))
 writeFileSync(local,'---\ndsh_knowledge: true\ntags: [one]\n---\n# Original\n[[小主题]]\n')
 await c.sync.run()
 const external=join(c.vault,c.config.folder,'knowledge','note.md')
 writeFileSync(external,readFileSync(external,'utf8').replace('# Original','# Vault'))
 assert.equal((await c.sync.run()).imported,1)
 assert.ok(readFileSync(local,'utf8').includes('# Vault'))
 writeFileSync(local,readFileSync(local,'utf8').replace('# Vault','# Host'))
 assert.equal((await c.sync.run()).exported,1)
 assert.equal(readFileSync(local,'utf8'),readFileSync(external,'utf8'))
 writeFileSync(local,readFileSync(local,'utf8').replace('# Host','# BothHost'))
 writeFileSync(external,readFileSync(external,'utf8').replace('# Host','# BothVault'))
 assert.equal((await c.sync.run()).conflicts.length,1)
})

test('a reloaded controller waits for the active baseline commit and preserves both conflict bodies',async t=>{
 const c=setup(t),local=join(c.store.root,'knowledge','overlap.md')
 c.config.autoSync=false
 mkdirSync(join(c.store.root,'knowledge'))
 writeFileSync(local,'---\ndsh_knowledge: true\n---\n# Initial\n')
 await c.sync.run()
 const external=join(c.vault,c.config.folder,'knowledge','overlap.md')
 const memoryKey=`memory:${c.record.id}`
 const initialEntry=structuredClone(c.sync.state.entries[memoryKey])
 const hostBody='---\ndsh_knowledge: true\n---\n# Host overlap body\n'
 const vaultBody='---\ndsh_knowledge: true\n---\n# Vault overlap body\n'
 writeFileSync(local,hostBody)
 writeFileSync(external,vaultBody)
 c.store.update(c.record.id,{content:'并发期间由宿主更新的事实'})

 let enteredConflict
 const enteredConflictPromise=new Promise(resolve=>{enteredConflict=resolve})
 let releaseConflict
 const conflictGate=new Promise(resolve=>{releaseConflict=resolve})
 const originalPreserve=c.sync.preserve.bind(c.sync)
 c.sync.preserve=async(dir,name,text)=>{
  if(dir.includes('_conflicts')){enteredConflict();await conflictGate}
  return originalPreserve(dir,name,text)
 }
 const oldRun=c.sync.run({fullScan:true})
 await enteredConflictPromise
 const advancedEntry=structuredClone(c.sync.state.entries[memoryKey])
 assert.notDeepEqual(advancedEntry,initialEntry)
 const oldQueuedRun=c.sync.run({fullScan:true})
 c.sync.dispose()

 let cancelledQueue
 const cancelledQueuePromise=new Promise(resolve=>{cancelledQueue=resolve})
 let cancelledStarted=false
 const cancelled=c.make({
  onReconcileQueued:event=>{if(event.queued)cancelledQueue(event)},
  synchronize:()=>{cancelledStarted=true},
 })
 t.after(()=>cancelled.dispose())
 const cancelledRun=cancelled.run({fullScan:true})
 const cancelledQueueEvent=await cancelledQueuePromise
 assert.ok(cancelledQueueEvent.queued)
 cancelled.dispose()

 let queueController
 let queued
 const queuedPromise=new Promise(resolve=>{queued=resolve})
 let loadedEntry
 const next=c.make({
  onReconcileQueued:event=>{if(event.queued)queued(event)},
  synchronize:()=>{loadedEntry=structuredClone(queueController.state.entries[memoryKey])},
 })
 t.after(()=>next.dispose())
 queueController=next
 const nextRun=next.run({fullScan:true})
 let queueTimer
 const queueEvent=await Promise.race([queuedPromise,new Promise(resolve=>{queueTimer=setTimeout(()=>resolve(null),1000)})])
 clearTimeout(queueTimer)
 releaseConflict()
 const [oldResult,nextResult,oldQueuedResult,cancelledResult]=await Promise.allSettled([oldRun,nextRun,oldQueuedRun,cancelledRun])

 assert.ok(queueEvent?.queued,'the new controller should wait at the shared state boundary')
 assert.equal(oldResult.status,'fulfilled')
 assert.equal(nextResult.status,'fulfilled')
 assert.equal(oldQueuedResult.status,'rejected','disposing the old controller cancels its queued rerun')
 assert.equal(cancelledResult.status,'fulfilled')
 assert.equal(cancelledStarted,false,'a controller disposed while queued never enters reconciliation')
 assert.equal(cancelled.status().watchersReady,false)
 assert.deepEqual(loadedEntry,advancedEntry,'the new controller reads the baseline committed by the old one')
 const conflict=nextResult.value.conflicts.find(item=>item.key==='knowledge:overlap.md')
 assert.ok(conflict)
 assert.deepEqual(conflict.copies.map(file=>readFileSync(file,'utf8')).sort(),[hostBody,vaultBody].sort())
 assert.deepEqual(nextResult.value.errors,[])
 assert.deepEqual(readdirSync(c.store.root).filter(name=>name.startsWith('obsidian-state-')&&name.endsWith('.tmp')),[])
 await c.sync.run()
 assert.equal(c.sync.status().watchersReady,false,'the disposed controller cannot reinstall watchers')
 c.sync.start(10)
 assert.equal(c.sync.status().watchersReady,false,'start cannot revive a disposed controller')
 next.dispose()
})

test('disabled sync does not create a vault folder and scheduled sync needs no RPC call',async t=>{
 const c=setup(t);c.config.autoSync=false
 c.sync.start(20)
 await new Promise(r=>setTimeout(r,65))
 assert.equal(existsSync(c.file),false)
 c.config.autoSync=true
 for(let i=0;i<50&&!existsSync(c.file);i++)await new Promise(r=>setTimeout(r,20))
 assert.equal(existsSync(c.file),true)
})

test('panel sync shares the controller and returns conflicts without destructive legacy exports',async t=>{
 const c=setup(t)
 const {createPanelBackend}=await import('../host/remote.js')
 const backend=createPanelBackend({root:c.store.root,store:c.store,index:c.index,config:{obsidian:c.config},obsidianSync:c.sync})
 await backend.obsidianSync({})
 c.store.update(c.record.id,{content:'本地分歧版本'})
 writeFileSync(c.file,readFileSync(c.file,'utf8').replace('原始事实 12345','外部保留版本'))
 await backend.obsidianExport({})
 assert.equal(c.store.find(c.record.id).content,'本地分歧版本')
 assert.ok(readFileSync(c.file,'utf8').includes('外部保留版本'))
 const status=backend.obsidianStatus({})
 assert.equal(status.automatic.enabled,true);assert.equal(status.automatic.conflicts.length,1)
 await backend.obsidianResolve({...status.automatic.conflicts[0],side:'memory'})
 assert.ok(readFileSync(c.file,'utf8').includes('本地分歧版本'))
})

test('knowledge deletion remains absent after choosing the deleted side',async t=>{
 const c=setup(t),local=join(c.store.root,'knowledge','owned.md')
 mkdirSync(join(c.store.root,'knowledge'));writeFileSync(local,'---\ndsh_knowledge: true\n---\n# 可恢复删除\n')
 await c.sync.run();const external=join(c.vault,c.config.folder,'knowledge','owned.md')
 rmSync(external)
 const result=await c.sync.run(), conflict=result.conflicts.find(x=>x.key==='knowledge:owned.md')
 assert.ok(conflict)
 await c.sync.resolve({...conflict,side:'vault'})
 assert.equal(existsSync(local),false)
 await c.sync.run();assert.equal(existsSync(external),false)
})

test('incremental knowledge sync withholds revoked edits and ignores old renamed copies', async t => {
 const c = setup(t)
 c.config.autoSync = false
 const local = promoteMemoryToKnowledge(c.store.root, c.record)
 const target = join(c.vault, c.config.folder, 'knowledge', c.record.id + '.md')
 const independent = '---\ndsh_knowledge: true\nscope: global\n---\n# 作者自己的独立笔记\n'
 writeFileSync(join(c.store.root, 'knowledge', 'author.md'), independent)
 await c.sync.run()
 const original = readFileSync(target, 'utf8')
 const localEdit = original + '\n本地作者亲自补了一段说明。\n'
 const vaultEdit = original + '\nObsidian 作者也另外添加说明。\n'
 writeFileSync(local, localEdit)
 writeFileSync(target, vaultEdit)
 const writer = new MemoryStore({ root: c.store.root }).open()
 writer.remove(c.record.id)
 const reopened = c.make()
 t.after(() => reopened.dispose())
 const result = await reopened.run({ fullScan: false, recordIds: [c.record.id] })
 assert.equal(result.mode, 'incremental')
 assert.equal(result.conflicts.length, 0, 'revoked content must not be copied into conflict history')
 assert.equal(reopened.state.entries['knowledge:' + c.record.id + '.md']?.left ?? null, null)
 assert.equal(readFileSync(local, 'utf8'), localEdit)
 assert.equal(readFileSync(target, 'utf8'), vaultEdit)
 assert.equal(readFileSync(join(c.vault, c.config.folder, 'knowledge', 'author.md'), 'utf8'), independent)

 const renamed = 'renamed-revoked.md'
 writeFileSync(join(c.vault, c.config.folder, 'knowledge', renamed), original)
 const incoming = await reopened.run({ fullScan: false, files: ['knowledge/' + renamed] })
 assert.equal(incoming.imported, 0)
 assert.equal(existsSync(join(c.store.root, 'knowledge', renamed)), false)
 writeFileSync(target, vaultEdit.split('\n').filter(line => !/^memory(?:Id|Scope|ProjectKey):/u.test(line)).join('\n'))
 const detached = await reopened.run({ fullScan: false, files: ['knowledge/' + c.record.id + '.md'] })
 assert.equal(detached.imported, 0, 'an established path cannot drop its revoked association on sync')
 assert.equal(readFileSync(local, 'utf8'), localEdit)
})

test('forget at the last asynchronous sync boundary cannot publish the linked bytes', async t => {
 const c = setup(t)
 c.config.autoSync = false
 const source = promoteMemoryToKnowledge(c.store.root, c.record)
 const target = join(c.vault, c.config.folder, 'knowledge', c.record.id + '.md')
 const anotherWriter = new MemoryStore({ root: c.store.root }).open()
 const original = c.sync.replace.bind(c.sync)
 let raced = false
 c.sync.replace = async (file, ...args) => {
  if (file === target) {
   assert.equal(anotherWriter.remove(c.record.id).status, 'deleted')
   raced = true
  }
  return original(file, ...args)
 }
 const result = await c.sync.run()
 assert.ok(raced, 'the test must reach the last step before publication')
 assert.equal(existsSync(target), false)
 assert.equal(existsSync(source), true)
 assert.equal(result.conflicts.length, 0)
 assert.ok(result.errors.some(error => error.file === 'knowledge/' + c.record.id + '.md' && /授权/u.test(error.message)))
 const restarted = c.make()
 t.after(() => restarted.dispose())
 assert.equal((await restarted.run()).errors.length, 0)
 assert.equal(existsSync(target), false)
})

test('automatic sync keeps the parent binding of an already linked knowledge file', async t => {
 const c = setup(t)
 c.config.autoSync = false
 const local = promoteMemoryToKnowledge(c.store.root, c.record)
 const file = c.record.id + '.md', relativeFile = 'knowledge/' + file
 const external = join(c.vault, c.config.folder, 'knowledge', file)
 await c.sync.run()
 const original = readFileSync(local, 'utf8')
 const remembered = c.store.write({ kind: 'fact', scope: 'global', content: 'An unrelated current parent.' }).record
 const detached = original.replace(/^memory(?:Id|Scope|ProjectKey):[^\n]*\n/gmu, '') + '\nAn outside edit.\n'
 const reassigned = original.replace(`memoryId: ${c.record.id}`, `memoryId: ${remembered.id}`)
 for (const changed of [detached, reassigned]) {
  writeFileSync(external, changed)
  const sync = c.make()
  t.after(() => sync.dispose())
  const result = await sync.run({ fullScan: false, files: [relativeFile] })
  assert.equal(result.imported, 0)
  assert.equal(readFileSync(local, 'utf8'), original)
  assert.equal(readFileSync(external, 'utf8'), changed)
 }
})

test('manual import and Vault browsing honor the recorded parent when the external header is removed', async t => {
 const c = setup(t)
 c.config.autoSync = false
 const local = promoteMemoryToKnowledge(c.store.root, c.record)
 const file = c.record.id + '.md'
 const knowledge = join(c.vault, c.config.folder, 'knowledge')
 await c.sync.run()
 const external = join(knowledge, file)
 const detached = readFileSync(external, 'utf8').replace(/^memory(?:Id|Scope|ProjectKey):[^\n]*\n/gmu, '')
 writeFileSync(external, detached)
 rmSync(local)
 const opts = { root: c.store.root, store: c.store, ...c.config }
 assert.equal(importKnowledgeFromVault(opts).imported, 0, 'a live parent must not be detached by importing')
 const writer = new MemoryStore({ root: c.store.root }).open()
 writer.remove(c.record.id)
 const independent = '---\ndsh_knowledge: true\nscope: global\n---\n# Independent author note\n'
 writeFileSync(join(knowledge, 'independent.md'), independent)
 const graph = knowledgeGraph({ ...opts, config: { obsidian: c.config } }, { scope: 'all' })
 assert.equal(graph.nodes.some(node => node.id === `vault:${file}`), false)
 assert.equal(graph.nodes.some(node => node.id === 'vault:independent.md'), true)
 assert.equal(importKnowledgeFromVault(opts).imported, 1)
 assert.equal(existsSync(local), false)
 assert.equal(readFileSync(external, 'utf8'), detached)
 assert.equal(readFileSync(join(c.store.root, 'knowledge', 'independent.md'), 'utf8'), independent)
})

test('a live linked note still syncs edits and keeps both versions of a conflict', async t => {
 const c = setup(t)
 c.config.autoSync = false
 const source = promoteMemoryToKnowledge(c.store.root, c.record)
 const target = join(c.vault, c.config.folder, 'knowledge', c.record.id + '.md')
 await c.sync.run()
 const original = readFileSync(source, 'utf8')
 const firstEdit = original + '\nObsidian 作者补充当前操作条件。\n'
 writeFileSync(target, firstEdit)
 const key = 'knowledge:' + c.record.id + '.md'
 assert.equal((await c.sync.run({ fullScan: false, files: ['knowledge/' + c.record.id + '.md'] })).imported, 1)
 assert.equal(readFileSync(source, 'utf8'), firstEdit)
 const localEdit = firstEdit + '\n本机另外记下审批条件。\n'
 const vaultEdit = firstEdit + '\n外部另外记下值班条件。\n'
 writeFileSync(source, localEdit)
 writeFileSync(target, vaultEdit)
 const conflict = (await c.sync.run()).conflicts.find(item => item.key === key)
 assert.ok(conflict)
 assert.deepEqual(conflict.copies.map(file => readFileSync(file, 'utf8')).sort(), [localEdit, vaultEdit].sort())
 await c.sync.resolve({ ...conflict, side: 'vault' })
 assert.equal(readFileSync(source, 'utf8'), vaultEdit)
 assert.equal(readFileSync(target, 'utf8'), vaultEdit)
})

test('host record creation, edits and forgetting trigger incremental export without a scheduled full scan',async t=>{
 const c=setup(t);c.sync.dispose()
 const sync=c.make({watcherFactory:()=>{const watcher=new EventEmitter();watcher.close=()=>{};return watcher}})
 t.after(()=>sync.dispose());await sync.run()
 const created=c.store.write({kind:'fact',scope:'global',content:'宿主新建的自动导出事实 65432'}).record
 c.index.upsert(created)
 const createdFile=join(c.vault,c.config.folder,created.id+'.md')
 await waitFor(()=>existsSync(createdFile)&&readFileSync(createdFile,'utf8').includes('宿主新建的自动导出事实 65432'))
 await waitFor(()=>sync.status().mode==='incremental')
 assert.equal(sync.status().mode,'incremental')
 c.store.update(created.id,{content:'由宿主自动导出的新版本'})
 await waitFor(()=>readFileSync(createdFile,'utf8').includes('由宿主自动导出的新版本'))
 c.store.remove(created.id)
 await waitFor(()=>!existsSync(createdFile))
 assert.equal(c.store.find(created.id).status,'deleted')
})

test('real watcher events from generated memory and reading files do not upgrade a normal update to full scan',async t=>{
 const c=setup(t);await c.sync.run()
 const lastFullScanAt=c.sync.status().lastFullScanAt
 c.store.update(c.record.id,{content:'需要由真实文件监听器同步的更新'})
 await waitFor(()=>readFileSync(c.file,'utf8').includes('需要由真实文件监听器同步的更新'))
 await waitFor(()=>c.sync.status().mode==='incremental'&&!c.sync.status().running)
 await new Promise(resolve=>setTimeout(resolve,700))
 assert.equal(c.sync.status().mode,'incremental')
 assert.equal(c.sync.status().lastFullScanAt,lastFullScanAt)
 assert.equal(c.sync.status().fullScanPending,false)
})

test('configuration changes immediately reconcile and rebind automatic sync',async t=>{
 const c=setup(t);await c.sync.run()
 c.config.folder='Renamed Memory'
 await c.sync.configurationChanged()
 const renamed=join(c.vault,c.config.folder,c.record.id+'.md')
 assert.ok(readFileSync(renamed,'utf8').includes('原始事实 12345'))
 c.config.autoSync=false;await c.sync.configurationChanged()
 c.store.update(c.record.id,{content:'暂停期间的新版本'})
 c.config.autoSync=true;await c.sync.configurationChanged()
 assert.ok(readFileSync(renamed,'utf8').includes('暂停期间的新版本'))
 assert.equal(c.sync.status().watchersReady,true)
})

test('initial export notices a note edit made immediately after publication', async t => {
 const c=setup(t), sync=c.make(), originalReplace=sync.replace.bind(sync)
 let edited=false
 t.after(()=>sync.dispose())
 sync.replace=async (...args)=>{
  const result=await originalReplace(...args)
  if(!edited&&args[0]===c.file&&args[2]!==null){
   edited=true
   writeFileSync(c.file,readFileSync(c.file,'utf8').replace('原始事实 12345','首轮导出后立即编辑 91919'))
  }
  return result
 }
 await sync.run({fullScan:true})
 assert.equal(edited,true)
 await waitFor(()=>c.store.find(c.record.id).content==='首轮导出后立即编辑 91919')
 await waitFor(()=>sync.status().mode==='incremental'&&!sync.status().running)
 assert.equal(sync.status().fullScanPending,false)
 assert.ok(readFileSync(c.file,'utf8').includes('首轮导出后立即编辑 91919'))
})

test('a publication readback queues an immediate edit even if the watcher misses the change', async t => {
 const c = setup(t)
 const sync = c.make({ watcherFactory: () => Object.assign(new EventEmitter(), { close() {} }) })
 t.after(() => sync.dispose())
 const replace = sync.replace.bind(sync)
 let edited = false
 sync.replace = async (...args) => {
  await replace(...args)
  if (edited || args[0] !== c.file || args[2] === null) return
  edited = true
  writeFileSync(c.file, readFileSync(c.file, 'utf8').replace('12345', '48923'))
 }
 await sync.run()
 assert.ok(edited)
 await waitFor(() => c.store.find(c.record.id).content === '原始事实 48923')
 await waitFor(() => sync.status().mode === 'incremental' && !sync.status().running)
 assert.deepEqual(sync.status().errors, [])
})

test('a changed vault notices a note edit made immediately after publication', async t => {
 const c=setup(t), sync=c.sync, originalReplace=sync.replace.bind(sync)
 await sync.run({fullScan:true})
 const target=join(c.vault,'Renamed Memory',`${c.record.id}.md`)
 let edited=false
 sync.replace=async (...args)=>{
  const result=await originalReplace(...args)
  if(!edited&&args[0]===target&&args[2]!==null){
   edited=true
   writeFileSync(target,readFileSync(target,'utf8').replace('原始事实 12345','更换 Vault 后立即编辑 91920'))
  }
  return result
 }
 c.config.folder='Renamed Memory'
 await sync.configurationChanged()
 assert.equal(edited,true)
 await waitFor(()=>c.store.find(c.record.id).content==='更换 Vault 后立即编辑 91920')
 await waitFor(()=>sync.status().mode==='incremental'&&!sync.status().running)
 assert.equal(sync.status().fullScanPending,false)
 assert.ok(readFileSync(target,'utf8').includes('更换 Vault 后立即编辑 91920'))
})

test('restart full reconciliation catches host authority changes missed while the watcher was offline',async t=>{
 const c=setup(t);await c.sync.run();c.sync.dispose()
 c.store.update(c.record.id,{content:'停机期间由宿主修改的事实'})
 const restarted=c.make();t.after(()=>restarted.dispose())
 const result=await restarted.run({fullScan:true})
 assert.equal(result.exported,1)
 assert.ok(readFileSync(c.file,'utf8').includes('停机期间由宿主修改的事实'))
})

test('automatic restart audits offline notes without opening the unchanged vault bodies', async t => {
 const c = setup(t)
 const second = c.store.write({ kind: 'fact', scope: 'global', content: '保留原有笔记 19874' }).record
 const third = c.store.write({ kind: 'decision', scope: 'global', content: '保留另一份笔记 25124' }).record
 assert.equal((await c.sync.run()).exported, 3)
 c.sync.dispose()
 const dir = join(c.vault, c.config.folder)
 const steady = [second, third].map(record => {
  const file = join(dir, record.id + '.md')
  return { file, text: readFileSync(file, 'utf8'), mtime: statSync(file, { bigint: true }).mtimeNs }
 })
 const originalTime = statSync(c.file)
 const body = readFileSync(c.file, 'utf8')
 writeFileSync(c.file, body.replace('12345', '54321'))
 utimesSync(c.file, originalTime.atime, originalTime.mtime)
 const store = new MemoryStore({ root: c.store.root }).open()
 const restarted = c.make({ store })
 t.after(() => restarted.dispose())
 const read = restarted.cachedText.bind(restarted)
 const opened = []
 restarted.cachedText = file => { opened.push(file); return read(file) }
 const res = await restarted.run({ automatic: true })
 assert.deepEqual(res.errors, [])
 assert.equal(res.imported, 1)
 assert.equal(store.find(c.record.id).content, '原始事实 54321')
 assert.ok(opened.includes(c.file))
 for (const sample of steady) {
  assert.ok(!opened.includes(sample.file), 'reopened unchanged vault body')
  assert.equal(readFileSync(sample.file, 'utf8'), sample.text)
  assert.equal(statSync(sample.file, { bigint: true }).mtimeNs, sample.mtime)
 }
})

test('automatic restart preserves duplicate-id conflicts and audits deleted or replaced paths', async t => {
 const c = setup(t)
 const moved = c.store.write({ kind: 'fact', scope: 'global', content: '允许离线改名 37264' }).record
 const missing = c.store.write({ kind: 'fact', scope: 'global', content: '保留缺失文件的权威内容 61730' }).record
 assert.equal((await c.sync.run()).exported, 3)
 c.sync.dispose()
 const dir = join(c.vault, c.config.folder)
 const original = readFileSync(c.file, 'utf8')
 const duplicate = join(dir, '0-duplicate.md')
 writeFileSync(duplicate, original.replace('12345', '98765'))
 const newName = join(dir, 'renamed.md')
 renameSync(join(dir, moved.id + '.md'), newName)
 rmSync(join(dir, missing.id + '.md'))
 const restarted = c.make({ store: new MemoryStore({ root: c.store.root }).open() })
 t.after(() => restarted.dispose())
 const res = await restarted.run({ automatic: true })
 assert.ok(res.errors.some(error => /相同记忆 id/u.test(error.message)))
 assert.ok(res.conflicts.some(item => item.key === 'memory:' + missing.id))
 assert.equal(restarted.state.entries['memory:' + moved.id].file, 'renamed.md')
 assert.equal(restarted.store.find(c.record.id).content, c.record.content)
 assert.equal(readFileSync(c.file, 'utf8'), original)
 assert.ok(readFileSync(duplicate, 'utf8').includes('98765'))
 assert.equal(restarted.store.find(missing.id).content, missing.content)
})

test('automatic restart rechecks linked notes after an offline purge and keeps the other scope', async t => {
 const c = setup(t)
 const other = c.store.write({ kind: 'fact', scope: 'project', projectKey: 'another-project', content: '异项目保留 27109' }).record
 const source = promoteMemoryToKnowledge(c.store.root, c.record)
 promoteMemoryToKnowledge(c.store.root, other)
 const dir = join(c.vault, c.config.folder)
 const linked = join(dir, 'knowledge', c.record.id + '.md')
 const unrelated = join(dir, 'knowledge', other.id + '.md')
 assert.deepEqual((await c.sync.run()).errors, [])
 assert.ok(existsSync(linked) && existsSync(unrelated))
 const unrelatedBytes = readFileSync(unrelated, 'utf8'), mtime = statSync(unrelated, { bigint: true }).mtimeNs
 c.sync.dispose()
 const writer = new MemoryStore({ root: c.store.root }).open()
 writer.remove(c.record.id)
 assert.equal(writer.purge(c.record.id, [{ scope: 'global', projectKey: null }]), true)
 const store = new MemoryStore({ root: c.store.root }).open()
 const restarted = c.make({ store })
 t.after(() => restarted.dispose())
 const read = restarted.cachedText.bind(restarted), opened = []
 restarted.cachedText = file => { opened.push(file); return read(file) }
 const res = await restarted.run({ automatic: true })
 assert.deepEqual(res.errors, [])
 assert.deepEqual(res.conflicts, [])
 assert.equal(store.find(c.record.id), undefined)
 assert.equal(store.find(other.id, [other]).content, other.content)
 assert.equal(existsSync(c.file), false)
 assert.equal(existsSync(linked), false)
 assert.ok(!opened.includes(unrelated))
 assert.equal(readFileSync(unrelated, 'utf8'), unrelatedBytes)
 assert.equal(statSync(unrelated, { bigint: true }).mtimeNs, mtime)
 assert.equal(restarted.state.entries['knowledge:' + c.record.id + '.md'].left, null)
 assert.ok(existsSync(source))
})

test('automatic restart audits edited reading pages and leaves an unchanged page unopened', async t => {
 const c = setup(t)
 const stableRecord = c.store.write({ kind: 'fact', scope: 'global', topic: '独立主题', content: '独立页面保留 58342' }).record
 assert.deepEqual((await c.sync.run()).errors, [])
 const dir = join(c.vault, c.config.folder, '阅读')
 const topicDir = join(dir, '主题')
 const pages = readdirSync(topicDir).map(name => join(topicDir, name))
 const edited = pages.find(file => readFileSync(file, 'utf8').includes(c.record.content))
 const stable = pages.find(file => readFileSync(file, 'utf8').includes(stableRecord.content))
 assert.ok(edited && stable && edited !== stable)
 const untouched = readFileSync(stable, 'utf8'), untouchedTime = statSync(stable, { bigint: true }).mtimeNs
 c.sync.dispose()
 const previous = statSync(edited)
 writeFileSync(edited, readFileSync(edited, 'utf8').replace(c.record.content, '离线手写的资料 74821'))
 utimesSync(edited, previous.atime, previous.mtime)
 rmSync(join(dir, '首页.md'))
 const restarted = c.make({ store: new MemoryStore({ root: c.store.root }).open() })
 t.after(() => restarted.dispose())
 const inspect = restarted.cachedText.bind(restarted), opened = []
 restarted.cachedText = file => { opened.push(file); return inspect(file) }
 assert.deepEqual((await restarted.run({ automatic: true })).errors, [])
 assert.ok(!opened.includes(stable))
 assert.equal(readFileSync(stable, 'utf8'), untouched)
 assert.equal(statSync(stable, { bigint: true }).mtimeNs, untouchedTime)
 assert.ok(readFileSync(edited, 'utf8').includes(c.record.content))
 assert.ok(existsSync(join(dir, '首页.md')))
 const handEdits = join(dir, '手动修改')
 assert.ok(readdirSync(handEdits).some(name => readFileSync(join(handEdits, name), 'utf8').includes('离线手写的资料 74821')))
})

test('physical purge survives an immediate full sync and cannot be revived from an old note after restart',async t=>{
 const c=setup(t);await c.sync.run()
 const oldNote=readFileSync(c.file,'utf8'),scopes=[{scope:'global',projectKey:null}]
 c.config.autoSync=false
 c.store.remove(c.record.id,scopes)
 assert.equal(c.store.purge(c.record.id,scopes),true)
 c.config.autoSync=true
 const purged=await c.sync.run({fullScan:true})
 assert.deepEqual(purged.conflicts,[]);assert.deepEqual(purged.errors,[]);assert.equal(existsSync(c.file),false)
 const stateName=readdirSync(c.store.root).find(name=>name.startsWith('obsidian-state-'))
 assert.equal(JSON.parse(readFileSync(join(c.store.root,stateName),'utf8')).purged[c.record.id],true)
 c.sync.dispose();writeFileSync(c.file,oldNote)
 const restarted=c.make();t.after(()=>restarted.dispose())
 const recovered=await restarted.run({fullScan:true})
 assert.deepEqual(recovered.conflicts,[]);assert.deepEqual(recovered.errors,[]);assert.equal(recovered.imported,0)
 assert.equal(existsSync(c.file),false);assert.equal(c.store.find(c.record.id,scopes),undefined)
})

test('purge ledger survives exit before auto-sync and follows the data root across folder changes',async t=>{
 const c=setup(t);await c.sync.run()
 const oldNote=readFileSync(c.file,'utf8'),scopes=[{scope:'global',projectKey:null}]
 const observer=new MemoryStore({root:c.store.root}).open()
 c.config.autoSync=false
 c.store.remove(c.record.id,scopes)
 assert.equal(c.store.purge(c.record.id,scopes),true)
 assert.ok(readFileSync(join(c.store.root,'obsidian-purged-ids.json'),'utf8').includes(c.record.id))
 assert.deepEqual(observer.purgedIds(),new Set([c.record.id]))
 c.sync.dispose()

 const reopened=new MemoryStore({root:c.store.root}).open(), index=new MemoryIndex()
 assert.deepEqual(reopened.purgedIds(),new Set([c.record.id]))
 c.config.folder='Renamed Memory'
 const renamed=join(c.vault,c.config.folder)
 mkdirSync(renamed,{recursive:true});writeFileSync(join(renamed,c.record.id+'.md'),oldNote)
 const restarted=new ObsidianSync({root:reopened.root,store:reopened,index,getConfig:()=>c.config})
 t.after(()=>restarted.dispose())
 c.config.autoSync=true
 const result=await restarted.run({fullScan:true})
 assert.deepEqual(result.conflicts,[]);assert.deepEqual(result.errors,[])
 assert.equal(result.imported,0);assert.equal(existsSync(join(renamed,c.record.id+'.md')),false)
 assert.equal(reopened.find(c.record.id,scopes),undefined)
})

test('permanent deletion removes verified history and legacy conflicts while retaining edited files', async t => {
 const c = setup(t)
 c.config.autoSync = false
 const dir = join(c.vault, c.config.folder)
 const scopes = [{ scope: 'global', projectKey: null }]
 const digest = value => createHash('sha256').update(value).digest('hex')
 await c.sync.run()
 const original = readFileSync(c.file, 'utf8')
 const latest = c.store.update(c.record.id, { content: '会被永久删除的宿主修订 QA-PURGE-HOST' }, scopes)
 await c.sync.run()
 const archived = readdirSync(join(dir, '_history')).map(file => join(dir, '_history', file))
   .find(file => readFileSync(file, 'utf8') === original)
 assert.ok(archived, 'revising a memory produced a historic Markdown byte-for-byte copy')
 const authored = serializeMemory(latest) + '\n用户的手写说明需保留。\n'
 writeFileSync(c.file, authored)
 const legacyDir = join(dir, '_conflicts', digest('memory:' + c.record.id).slice(0, 16))
 mkdirSync(legacyDir, { recursive: true })
 const token = digest(JSON.stringify([serializeMemory(latest), authored]))
 const legacy = [join(legacyDir, token + '-memory.md'), join(legacyDir, token + '-obsidian.md')]
 writeFileSync(legacy[0], serializeMemory(latest))
 writeFileSync(legacy[1], authored)
 const preserved = join(dir, '独立手写稿.md')
 writeFileSync(preserved, authored)
 c.sync.dispose()
 const writer = new MemoryStore({ root: c.store.root }).open()
 writer.remove(c.record.id, scopes)
 assert.equal(writer.purge(c.record.id, scopes), true)
 const reopened = new MemoryStore({ root: c.store.root }).open()
 const sync = new ObsidianSync({ root: reopened.root, store: reopened, index: c.index, getConfig: () => c.config })
 t.after(() => sync.dispose())
 const result = await sync.run()
 assert.deepEqual(result.errors, [])
 assert.equal(reopened.find(c.record.id, scopes), undefined)
 assert.equal(existsSync(archived), false)
 for (const copy of legacy) assert.equal(existsSync(copy), false)
 assert.equal(readFileSync(c.file, 'utf8'), authored)
 assert.equal(readFileSync(preserved, 'utf8'), authored)
 assert.ok(!readdirSync(join(dir, '_history')).some(name => readFileSync(join(dir, '_history', name), 'utf8') === authored))
})

test('a tracked conflict is cleaned independently of another side edited after it was saved', async t => {
 const c = setup(t)
 c.config.autoSync = false
 await c.sync.run()
 c.store.update(c.record.id, { content: '宿主等待冲突处理的改动' })
 writeFileSync(c.file, readFileSync(c.file, 'utf8').replace('原始事实 12345', 'Obsidian 侧用户改动'))
 const [conflict] = (await c.sync.run()).conflicts
 const [memoryCopy, vaultCopy] = conflict.copies
 const edited = readFileSync(memoryCopy, 'utf8') + '\n稍后在副本直接写的私人补充。\n'
 writeFileSync(memoryCopy, edited)
 const original = readFileSync(c.file, 'utf8')
 const scopes = [{ scope: 'global', projectKey: null }]
 c.store.remove(c.record.id, scopes)
 assert.equal(c.store.purge(c.record.id, scopes), true)
 c.sync.dispose()
 const sync = c.make()
 t.after(() => sync.dispose())
 assert.deepEqual((await sync.run()).errors, [])
 assert.equal(readFileSync(memoryCopy, 'utf8'), edited)
 assert.equal(readFileSync(c.file, 'utf8'), original)
 assert.equal(existsSync(vaultCopy), false)
})

test('a linked knowledge replica is removed after purge while its local authored source survives', async t => {
 const c = setup(t)
 c.config.autoSync = false
 const local = promoteMemoryToKnowledge(c.store.root, c.record)
 const bytes = readFileSync(local, 'utf8') + '\n由作者维护的操作说明。\n'
 writeFileSync(local, bytes)
 const replica = join(c.vault, c.config.folder, 'knowledge', c.record.id + '.md')
 await c.sync.run()
 assert.equal(readFileSync(replica, 'utf8'), bytes)
 const scopes = [{ scope: 'global', projectKey: null }]
 c.store.remove(c.record.id, scopes)
 assert.deepEqual((await c.sync.run()).errors, [])
 assert.equal(readFileSync(replica, 'utf8'), bytes, 'soft deletion is reversible')
 assert.equal(c.store.purge(c.record.id, scopes), true)
 c.sync.dispose()
 const sync = c.make()
 t.after(() => sync.dispose())
 assert.deepEqual((await sync.run()).errors, [])
 assert.equal(existsSync(replica), false)
 assert.equal(readFileSync(local, 'utf8'), bytes)
})

test('manual knowledge export records its own copy without claiming an identical existing note', async t => {
 const c = setup(t)
 c.config.autoSync = false
 const local = promoteMemoryToKnowledge(c.store.root, c.record)
 const text = readFileSync(local, 'utf8')
 const vaultKnowledge = join(c.vault, c.config.folder, 'knowledge')
 mkdirSync(vaultKnowledge, { recursive: true })
 const externalOriginal = join(vaultKnowledge, '我自己写的原件.md')
 writeFileSync(externalOriginal, text)
 writeFileSync(join(c.store.root,'knowledge','我自己写的原件.md'), text)
 const exportResult = exportKnowledgeToVault({ root:c.store.root, store:c.store, ...c.config })
 assert.equal(exportResult.written,1)
 assert.equal(exportResult.skipped,1)
 const replica = join(vaultKnowledge,c.record.id+'.md')
 assert.equal(readFileSync(replica,'utf8'),text)
 const scope = [{ scope:'global', projectKey:null }]
 c.store.remove(c.record.id,scope)
 assert.equal(c.store.purge(c.record.id,scope),true)
 const restarted = c.make()
 t.after(()=>restarted.dispose())
 assert.deepEqual((await restarted.run()).errors,[])
 assert.equal(existsSync(replica),false)
 assert.equal(readFileSync(externalOriginal,'utf8'),text)
 assert.equal(readFileSync(local,'utf8'),text)
})

test('a vault change during reconciliation stops a pending removal in the old location', async t => {
 const c = setup(t)
 c.config.autoSync = false
 await c.sync.run()
 const original = readFileSync(c.file,'utf8')
 const scope = [{ scope:'global', projectKey:null }]
 c.store.remove(c.record.id,scope)
 assert.equal(c.store.purge(c.record.id,scope),true)
 const read = c.sync.existingText.bind(c.sync)
 let switched = false
 c.sync.existingText = async file => {
  if (file === c.file && !switched) { switched = true; c.config.folder = 'Another folder' }
  return read(file)
 }
 await assert.rejects(c.sync.run(), /同步设置已变化/u)
 assert.equal(switched,true)
 assert.equal(readFileSync(c.file,'utf8'),original)
 c.config.folder = 'DSH Memory'
 assert.deepEqual((await c.sync.run()).errors,[])
 assert.equal(existsSync(c.file),false)
})

test('reconciliation never swaps or removes a preserved copy through a symlink', async t => {
 const c = setup(t)
 c.config.autoSync = false
 await c.sync.run()
 const dir = join(c.vault, c.config.folder)
 const outside = join(c.root, 'outside-vault')
 mkdirSync(outside)
 const external = join(outside, c.record.id + '.md')
 writeFileSync(external, readFileSync(c.file))
 const raw = readFileSync(external, 'utf8')
 if (existsSync(join(dir, '_history'))) renameSync(join(dir, '_history'), join(dir, 'old-history'))
 symlinkSync(outside, join(dir, '_history'), 'junction')
 const scopes = [{ scope: 'global', projectKey: null }]
 c.store.remove(c.record.id, scopes)
 assert.equal(c.store.purge(c.record.id, scopes), true)
 await c.sync.run()
 assert.equal(readFileSync(external, 'utf8'), raw)
})

test('a vault edit immediately before a verified copy is moved survives the purge', async t => {
 const c = setup(t)
 c.config.autoSync = false
 await c.sync.run()
 const original = readFileSync(c.file, 'utf8')
 const authored = original + '\n移动前最后一刻写下的人工补充。\n'
 const scopes = [{ scope: 'global', projectKey: null }]
 c.store.remove(c.record.id, scopes)
 assert.equal(c.store.purge(c.record.id, scopes), true)
 let edited = false
 const originalRename = fs.renameSync
 fs.renameSync = (from, to) => {
  if (from === c.file && to.includes('_dsh-memory-cleanup')) {
   edited = true
   writeFileSync(c.file, authored)
  }
  return originalRename(from, to)
 }
 syncBuiltinESMExports()
 try { assert.deepEqual((await c.sync.run()).errors, []) }
 finally { fs.renameSync = originalRename; syncBuiltinESMExports() }
 assert.equal(edited, true)
 assert.equal(readFileSync(c.file, 'utf8'), authored)
 assert.equal(c.store.find(c.record.id, scopes), undefined)
 assert.equal((await c.sync.run()).imported, 0)
 assert.equal(readFileSync(c.file, 'utf8'), authored)
})

test('a different writer can revoke memory before either the note or reading page is published', async t => {
 const c = setup(t)
 c.config.autoSync = false
 const writer = new MemoryStore({ root: c.store.root }).open()
 const extra = c.store.write({ kind:'decision', scope:'global', content:'临时页面的机密标记 QA-RACE-PAGE' }).record
 const scopes = [{ scope:'global', projectKey:null }]
 const replace = c.sync.replace.bind(c.sync)
 let revokedFile = false, revokedPage = false
 c.sync.replace = async (file, before, after, ...args) => {
  if (file === c.file && !revokedFile) {
   revokedFile = true
   writer.remove(c.record.id, scopes)
   writer.purge(c.record.id, scopes)
  }
  if (file.includes('阅读') && after?.includes(extra.content) && !revokedPage) {
   revokedPage = true
   writer.remove(extra.id, scopes)
   writer.purge(extra.id, scopes)
  }
  return replace(file, before, after, ...args)
 }
 const result = await c.sync.run()
 assert.ok(revokedFile && revokedPage)
 assert.ok(result.errors.some(error => error.file === c.record.id + '.md' && /记忆已变化/u.test(error.message)))
 assert.ok(result.errors.some(error => error.file.includes('阅读') && /来源已变化/u.test(error.message)))
 assert.equal(existsSync(c.file), false)
 assert.equal(writer.find(extra.id), undefined)
 const checked = await c.sync.run()
 assert.deepEqual(checked.errors, [])
 assert.equal(existsSync(join(c.vault, c.config.folder, extra.id + '.md')), false)
})

test('reading watcher repairs an edited generated page and a full scan restores a missing page',async t=>{
 const c=setup(t);await c.sync.run()
 const home=join(c.vault,c.config.folder,'阅读','首页.md')
 writeFileSync(home,readFileSync(home,'utf8').replace('先按用途阅读','手动改过的首页标题'))
 await waitFor(()=>readFileSync(home,'utf8').includes('先按用途阅读'))
 const copies=readdirSync(join(c.vault,c.config.folder,'阅读','手动修改'))
 assert.equal(copies.length,1)
 assert.ok(readFileSync(join(c.vault,c.config.folder,'阅读','手动修改',copies[0]),'utf8').includes('手动改过的首页标题'))
 rmSync(home)
 await c.sync.run({fullScan:true})
 assert.ok(existsSync(home))
})

function observeWatchers(t, c) {
 const callbacks = new Map()
 const sync = c.make({ watcherFactory(path, _options, notify) {
  const watcher = new EventEmitter()
  callbacks.set(path, notify)
  watcher.close = () => callbacks.delete(path)
  return watcher
 } })
 t.after(() => sync.dispose())
 return { sync, callbacks }
}

test('a directory-only reading event after a generated write preserves the user edit incrementally', async t => {
 const c = setup(t), { sync, callbacks } = observeWatchers(t, c)
 await sync.run()
 const reading = join(c.vault, c.config.folder, '阅读')
 const home = join(reading, '首页.md')
 const baseline = readFileSync(home, 'utf8')
 const edit = baseline.replace('先按用途阅读', '未附文件名的修改')
 assert.notEqual(edit, baseline)
 assert.ok(callbacks.has(reading))
 writeFileSync(home, edit)
 callbacks.get(reading)('change', null)
 await waitFor(() => !sync.status().running && readFileSync(home, 'utf8').includes('先按用途阅读'))
 const copies = readdirSync(join(reading, '手动修改'))
 assert.equal(copies.length, 1)
 assert.equal(readFileSync(join(reading, '手动修改', copies[0]), 'utf8'), edit)
 assert.equal(sync.status().mode, 'incremental')
 assert.equal(sync.status().fullScanPending, false)
})

test('a named reading edit only audits the affected page', async t => {
 const c = setup(t), { sync, callbacks } = observeWatchers(t, c)
 await sync.run()
 const dir = join(c.vault, c.config.folder), reading = join(dir, '阅读'), home = join(reading, '首页.md')
 const baseline = readFileSync(home, 'utf8'), edited = baseline.replace('先按用途阅读', '从阅读页补充的标题')
 const opened = new Set(), read = sync.existingText.bind(sync)
 sync.existingText = file => {
  opened.add(relative(dir, file).split(sep).join('/'))
  return read(file)
 }
 writeFileSync(home, edited)
 callbacks.get(reading)('change', '首页.md')
 await waitFor(() => !sync.status().running && readFileSync(home, 'utf8').includes('查看手动版本'))
 assert.deepEqual([...opened], ['阅读/首页.md'])
 const [copy] = readdirSync(join(reading, '手动修改'))
 assert.equal(readFileSync(join(reading, '手动修改', copy), 'utf8'), edited)
 assert.equal(sync.status().mode, 'incremental')
})

test('moving reading directories repairs the canonical pages and rebinds subsequent edits', async t => {
 const c = setup(t), { sync, callbacks } = observeWatchers(t, c)
 await sync.run()
 const dir = join(c.vault, c.config.folder), reading = join(dir, '阅读'), topics = join(reading, '主题')
 const [name] = readdirSync(topics), original = readFileSync(join(topics, name), 'utf8')
 const fullAt = sync.status().lastFullScanAt
 const oldTopicWatcher = callbacks.get(topics), savedTopics = join(c.vault, 'saved-topics')
 renameSync(topics, savedTopics)
 callbacks.get(reading)('rename', '主题')
 assert.equal(sync.status().watchersReady, false)
 await waitFor(() => !sync.status().running && existsSync(join(topics, name)))
 assert.ok(callbacks.has(topics))
 assert.notEqual(callbacks.get(topics), oldTopicWatcher)
 assert.equal(readFileSync(join(savedTopics, name), 'utf8'), original)
 assert.equal(readFileSync(join(topics, name), 'utf8'), original)
 assert.equal(sync.status().watchersReady, true)

 const oldReadingWatcher = callbacks.get(reading), savedReading = join(c.vault, 'saved-reading')
 const home = join(reading, '首页.md'), homeBefore = readFileSync(home, 'utf8')
 renameSync(reading, savedReading)
 callbacks.get(dir)('rename', '阅读')
 await waitFor(() => !sync.status().running && existsSync(home))
 assert.ok(callbacks.has(reading))
 assert.notEqual(callbacks.get(reading), oldReadingWatcher)
 assert.equal(readFileSync(join(savedReading, '首页.md'), 'utf8'), homeBefore)
 oldReadingWatcher('change', null)
 assert.equal(sync.status().pendingFiles, 0)
 const edited = homeBefore.replace('先按用途阅读', '重绑后仍能同步')
 writeFileSync(home, edited)
 callbacks.get(reading)('change', '首页.md')
 await waitFor(() => !sync.status().running && readFileSync(home, 'utf8').includes('查看手动版本'))
 const [copy] = readdirSync(join(reading, '手动修改'))
 assert.equal(readFileSync(join(reading, '手动修改', copy), 'utf8'), edited)
 assert.equal(sync.status().mode, 'incremental')
 assert.equal(sync.status().lastFullScanAt, fullAt)
})

test('two conflict resolutions queued during a busy sync run serially and return their own results',async t=>{
 const c=setup(t), second=c.store.write({kind:'fact',scope:'global',content:'第二条基线事实 98765'}).record
 c.index.upsert(second);c.config.autoSync=false
 await c.sync.run()
 c.store.update(c.record.id,{content:'宿主第一条版本'})
 c.store.update(second.id,{content:'宿主第二条版本'})
 const firstFile=c.file, secondFile=join(c.vault,c.config.folder,second.id+'.md')
 writeFileSync(firstFile,readFileSync(firstFile,'utf8').replace('原始事实 12345','外部第一条版本'))
 writeFileSync(secondFile,readFileSync(secondFile,'utf8').replace('第二条基线事实 98765','外部第二条版本'))
 const conflicts=(await c.sync.run({fullScan:true})).conflicts
 assert.equal(conflicts.length,2)
 const blockedFile=join(c.vault,c.config.folder,conflicts[0].file)
 const original=c.sync.cachedText.bind(c.sync)
 let entered;const enteredPromise=new Promise(resolve=>{entered=resolve})
 let release;const gate=new Promise(resolve=>{release=resolve})
 c.sync.cachedText=async file=>{if(file===blockedFile){entered();await gate}return original(file)}
 const active=c.sync.run({fullScan:true})
 await enteredPromise
 const first=c.sync.resolve({...conflicts[0],side:'vault'})
 const secondResolution=c.sync.resolve({...conflicts[1],side:'vault'})
 release();await active
 const [firstResult,secondResult]=await Promise.all([first,secondResolution])
 assert.equal(firstResult.conflicts.length,1)
 assert.equal(secondResult.conflicts.length,0)
 assert.equal(c.store.find(c.record.id).content,'外部第一条版本')
 assert.equal(c.store.find(second.id).content,'外部第二条版本')
})

test('a failed filesystem watcher is recreated on the next reconciliation',async t=>{
 const c=setup(t), opened=[]
 const sync=c.make({watcherFactory:(...args)=>{const watcher=new EventEmitter();watcher.close=()=>{};opened.push(watcher);return watcher}})
 t.after(()=>sync.dispose())
 await sync.run()
 assert.equal(sync.status().watchersReady,true)
 const before=opened.length
 opened[0].emit('error',new Error('watch lost'))
 await waitFor(()=>opened.length>before&&sync.status().watchersReady)
 assert.equal(sync.status().watcherErrors,0)
})
