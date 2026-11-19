import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore } from '../host/store.js'
import { MemoryIndex } from '../host/search.js'
import { serializeMemory } from '../host/obsidian.js'
import { ObsidianSync } from '../host/obsidian-sync.js'

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

test('restart full reconciliation catches host authority changes missed while the watcher was offline',async t=>{
 const c=setup(t);await c.sync.run();c.sync.dispose()
 c.store.update(c.record.id,{content:'停机期间由宿主修改的事实'})
 const restarted=c.make();t.after(()=>restarted.dispose())
 const result=await restarted.run({fullScan:true})
 assert.equal(result.exported,1)
 assert.ok(readFileSync(c.file,'utf8').includes('停机期间由宿主修改的事实'))
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
