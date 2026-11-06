/** Independent P0 acceptance: labels are literal answer values in the returned pre-step message. No model or user profile. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {pathToFileURL,fileURLToPath} from 'node:url'
// node scripts/eval-recall-heldout.mjs [path-to-plugin] [--details]
const args=process.argv.slice(2), details=args.includes('--details')
const pkg=args.find(arg=>!arg.startsWith('--'))??fileURLToPath(new URL('../',import.meta.url)), imp=s=>import(pathToFileURL(path.resolve(pkg,s)))
const label=JSON.parse(fs.readFileSync(path.resolve(pkg,'package.json'),'utf8')).version
const [{apply},{buildRecord},{projectIdentity,scopePaths}]=await Promise.all([imp('index.js'),imp('host/records.js'),imp('host/paths.js')])
const groups=['gwPort gwTimeout','db redis','snap keep','root reg','worker retry delay','log audit','fmt size','upl upltime','bun bunOld','cipher rotation','migrate back','folder suffix','sign','id ttl'];
// id, exact value, record, optional status, project (m = main, b = other).
const rows=[
 ['gwPort','4731','网关监听端口是 4731。'],['gwTimeout','37 秒','网关请求超时设为 37 秒。'],
 ['db','PostgreSQL 16.3','生产数据库使用 PostgreSQL 16.3。'],['redis','Redis 7.2.4','生产缓存使用 Redis 7.2.4。'],
 ['snap','03:17','每日数据库快照在 03:17 开始。'],['keep','19 天','快照保留期限为 19 天。'],
 ['root','/srv/sable/api','部署目录固定为 /srv/sable/api。'],['reg','ap-east-7','服务部署区域是 ap-east-7。'],
 ['worker','6 个','后台队列的并发工作线程是 6 个。'],['retry','5 次','后台队列重试上限为 5 次。'],['delay','23 秒','后台队列重试间隔是 23 秒。'],
 ['log','14 天','普通日志保留 14 天。'],['audit','91 天','审计日志保留 91 天。'],
 ['fmt','zstd','归档压缩算法为 zstd。'],['size','64 MiB','归档分卷阈值为 64 MiB。'],
 ['upl','11 MiB','上传文件上限是 11 MiB。'],['upltime','83 秒','上传连接超时是 83 秒。'],
 ['bun','Bun 1.2.7','当前构建工具为 Bun 1.2.7。'],['bunOld','Bun 1.1.34','旧构建工具为 Bun 1.1.34。','superseded'],
 ['cipher','AES-256-GCM','备份加密使用 AES-256-GCM。'],['rotation','47 天','备份密钥轮换间隔是 47 天。'],
 ['migrate','migrate:check','迁移前的校验命令是 migrate:check。'],['back','ops/undo-v4.sh','数据库回滚脚本是 ops/undo-v4.sh。'],
 ['folder','桥塔笔记','Obsidian 同步目录名为桥塔笔记。'],['suffix','.both.md','Obsidian 冲突副本后缀是 .both.md。'],
 ['sign','Ed25519','签名算法使用 Ed25519。'],['id','UW-816','水印编号是 UW-816。'],['ttl','18 小时','水印有效期为 18 小时。'],
 ['other','ZB-720','乙项目专属的灰松密钥盒编号是 ZB-720。','active','b'],
 ['gone','DEL-714','归档校验花名曾经是 DEL-714。','deleted'],
 ['nok','GL-847','雪隼锁的标签是 GL-847。','candidate']
];
const q=(text,need='',opts={})=>({text,ids:need?need.split(' '):[],...opts});
const questions=[
 q('网关端口和网关超时分别是多少？','gwPort gwTimeout'),q('生产数据库与生产缓存分别用了什么版本？','db redis'),
 q('每日快照时间、保留期限分别是什么？','snap keep'),q('部署目录和部署区域分别是哪里？','root reg'),
 q('后台队列的并发线程数和重试上限是多少？','worker retry'),q('队列重试上限及重试间隔分别是多少？','retry delay'),
 q('普通日志和审计日志各保留多久？','log audit'),q('归档压缩算法和分卷阈值是什么？','fmt size'),
 q('上传文件上限和上传超时是多少？','upl upltime'),q('以前的构建工具是什么，现在改用什么？','bunOld bun',{history:true}),
 q('备份加密算法和密钥轮换间隔是多少？','cipher rotation'),q('迁移校验命令和数据库回滚脚本分别是什么？','migrate back'),
 q('Obsidian 的同步目录和冲突副本后缀分别是什么？','folder suffix'),q('水印编号和水印有效期是多少？','id ttl'),
 q('归档分卷阈值、上传文件上限分别是多少？','size upl'),q('签名算法以及备份加密分别用什么？','sign cipher'),
 q('网关监听端口是多少？','gwPort'),q('网关请求超时是多少？','gwTimeout'),q('生产数据库用的是什么版本？','db'),
 q('生产缓存用的是什么版本？','redis'),q('每天的数据库快照具体几点开始？','snap'),q('快照保留期限是多少？','keep'),
 q('部署目录在哪里？','root'),q('服务部署区域叫什么？','reg'),q('后台队列并发工作线程有多少？','worker'),
 q('后台队列重试间隔是多少？','delay'),q('普通日志保留多久？','log'),q('审计日志保留多久？','audit'),
 q('当前构建工具版本是什么？','bun',{forbid:['bunOld']}),q('以前的构建工具版本是什么？','bunOld',{history:true}),
 q('数据库回滚脚本叫什么？','back'),q('Obsidian 冲突副本后缀是什么？','suffix'),
 q('水星轨道的偏心率是多少？'),q('木星卫星的命名是什么？'),q('灰松密钥盒编号是多少？','',{forbid:['other']}),
 q('这个项目的网关监听端口是多少？','',{project:'b',forbid:['gwPort']}),
 q('本项目归档校验花名是什么？','',{forbid:['gone']}),q('雪隼锁的标签是什么？','',{forbid:['nok']}),
 q('我们有记录过玫瑰苗的数量吗？'),q('迁移校验命令是什么？','',{project:'b',forbid:['migrate']})
];
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'memory-p0-blind-')),data=path.join(temp,'data'),handlers={},off=[];
const keys=Object.fromEntries(['m','b'].map(p=>[p,projectIdentity(path.join(temp,p)).key])), now=Date.now(), byId=new Map(rows.map(r=>[r[0],r]));
try{
 for(const project of ['m','b']){
  const loc=scopePaths(data,'project',keys[project]);fs.mkdirSync(loc.dir,{recursive:true})
  const built=rows.filter(r=>(r[4]??'m')===project).map(([id,value,content,status])=>{const row=buildRecord({scope:'project',projectKey:keys[project],kind:'fact',confidence:.91,content},{id:'mem_blind_'+id,now});assert.ok(row.ok);return {...row.record,status:status??'active',...(status==='superseded'?{validTo:now-86400000}:{})}})
  fs.writeFileSync(loc.file,built.map(r=>JSON.stringify(r)).join('\n')+'\n')
 }
 apply({get:()=>undefined,on:(k,v)=>{handlers[k]=v;return ()=>{}},effect:f=>{const d=f();if(typeof d==='function')off.push(d);},logger:{warn:m=>{if(m.includes('recall skipped'))throw new Error(m);},info(){},debug(){}}},{dataDir:data,inject:{maxTokens:360}});
 const result=[];
 for(const {text,ids,project='m',forbid=[],history=false} of questions){
  const message={role:'user',source:{kind:'user'},content:[{type:'text',text}]};
  const d=await handlers['agent/pre-step']({agent:{session:{header:{cwd:path.join(temp,project)}}},messages:[message]},async()=>({kind:'enter',messages:[message]}));
  const block=d.messages.filter(m=>m.source?.plugin==='dsh-memory').flatMap(m=>m.content.map(x=>x.text)).join('\n');
  const hit=ids.filter(id=>block.includes(byId.get(id)[1]));
  const unsafe=[...new Set([...forbid,'other','gone','nok',...(history?[]:['bunOld'])])].filter(id=>block.includes(byId.get(id)[1]));
  result.push({text,ids,hit,unsafe,block});
 }
 const answerable=result.filter(r=>r.ids.length),multi=answerable.filter(r=>r.ids.length>1),empty=result.filter(r=>!r.ids.length);
 assert.equal(answerable.length,32);assert.equal(multi.length,16);assert.equal(empty.length,8);
 const wrongExtra=answerable.filter(r=>{const relevant=new Set(groups.filter(g=>r.ids.some(id=>g.split(' ').includes(id))).flatMap(g=>g.split(' ')));return rows.some(([id,val])=>!relevant.has(id)&&r.block.includes(val))}).length;
 const stats={label,wrongUnrelatedValueQueries:wrongExtra,questions:result.length,required:{matched:answerable.reduce((n,r)=>n+r.hit.length,0),total:answerable.reduce((n,r)=>n+r.ids.length,0)},completeMulti:{matched:multi.filter(r=>r.hit.length===r.ids.length).length,total:multi.length},single:{matched:answerable.filter(r=>r.ids.length===1&&r.hit.length).length,total:16},negativeAnyInjection:{count:empty.filter(r=>r.block).length,total:empty.length},forbiddenValues:result.reduce((n,r)=>n+r.unsafe.length,0)};
 console.log(JSON.stringify(details?{stats,result}:stats,null,2))
 // Floors for these fixed local questions; the native model answer is evaluated separately.
 if(stats.required.matched/stats.required.total<0.9 || stats.completeMulti.matched/stats.completeMulti.total<0.85 ||
    stats.single.matched!==16 || stats.forbiddenValues!==0 || stats.negativeAnyInjection.count!==0 || stats.wrongUnrelatedValueQueries!==0) process.exitCode=1
}finally{for(const d of off.reverse())d();await new Promise(r=>setTimeout(r,25));fs.rmSync(temp,{recursive:true,force:true})}
