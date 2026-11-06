import assert from 'node:assert/strict'
import test from 'node:test'
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
  const make=()=>new ObsidianSync({root:store.root,store,index,getConfig:()=>config})
  const sync=make(), file=join(vault,config.folder,record.id+'.md')
  t.after(()=>{sync.dispose();rmSync(root,{recursive:true,force:true})})
  return {root,vault,store,index,record,config,sync,file,make}
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
