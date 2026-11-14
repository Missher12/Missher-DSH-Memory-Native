/** Real local WASM check. Inputs are synthetic; downloads are pinned public model assets. */
import assert from 'node:assert/strict'
import {cpSync,mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
const root=mkdtempSync(join(tmpdir(),'memory-wasm-'))
const at=process.argv.indexOf('--model-dir')
const modelDir=at>=0?resolve(process.argv[at+1]):join(root,'中文模型 with spaces')
if(at<0)mkdirSync(modelDir)
let engine
try{
 const pluginDir=join(root,'中文插件 with spaces')
 mkdirSync(pluginDir)
 cpSync(new URL('../host/',import.meta.url),join(pluginDir,'host'),{recursive:true})
 cpSync(new URL('../vendor/',import.meta.url),join(pluginDir,'vendor'),{recursive:true})
 writeFileSync(join(pluginDir,'package.json'),'{"type":"module"}')
 const {LocalEmbedding}=await import(pathToFileURL(join(pluginDir,'host','embedding.js')).href)
 engine=new LocalEmbedding({modelDir,allowDownload:at<0})
 const start=performance.now()
 const vectors=await engine.embed(['澄岚服务日志保留37天。','相机镜头使用35毫米胶片。'],'passage')
 assert.equal(engine.state,'ready');assert.equal(vectors.length,2)
 for(const v of vectors){assert.equal(v.length,384);assert.ok(v.every(Number.isFinite));const n=Math.hypot(...v);assert.ok(n>.99&&n<1.01)}
 assert.notDeepEqual(vectors[0],vectors[1])
 console.log(JSON.stringify({platform:process.platform,arch:process.arch,node:process.version,state:engine.state,vectors:vectors.length,dimensions:384,elapsedMs:Math.round(performance.now()-start)}))
}finally{engine?.dispose();rmSync(root,{recursive:true,force:true})}
