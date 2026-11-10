import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, renameSync, statSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore } from '../host/store.js'
import { MemoryIndex } from '../host/search.js'
import { ObsidianSync } from '../host/obsidian-sync.js'
import { promoteMemoryToKnowledge } from '../host/knowledge.js'
import { buildReadingPages, refreshReadingPages } from '../host/obsidian-reading.js'

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'memory-reading-')), vault = join(root, 'vault')
  mkdirSync(vault)
  const store = new MemoryStore({ root: join(root, 'data') }).open(), index = new MemoryIndex()
  const config = { vaultPath: vault, folder: 'DSH Memory', autoSync: true }
  const make = () => new ObsidianSync({ root: store.root, store, index, getConfig: () => config })
  const sync = make(), dir = join(vault, config.folder)
  const write = input => {
    const result = store.write({ kind: 'fact', scope: 'project', projectKey: 'project-alpha', confidence: .95, topic: '备份', ...input })
    assert.equal(result.ok, true, result.reason); return result.record
  }
  t.after(() => { sync.dispose(); rmSync(root, { recursive: true, force: true }) })
  return { root, store, index, config, make, sync, dir, write }
}
const topicPages = dir => readdirSync(join(dir, '阅读/主题')).map(file => ({ file: join(dir, '阅读/主题', file), text: readFileSync(join(dir, '阅读/主题', file), 'utf8') }))

test('reading groups complete source text and decisions by topic, keeps project boundaries and valid wiki targets', async t => {
  const c = setup(t)
  c.write({ content: '快照时间 06:17，保留 37 天。' })
  c.write({ kind: 'decision', content: '决定改为 06:17，因为凌晨导入任务到 06:00 才结束。' })
  c.write({ projectKey: 'project-beta', content: '另一个项目保留 7 天。' })
  const note = c.write({ content: '完整备份方案' }); promoteMemoryToKnowledge(c.store.root, note)
  const result = await c.sync.run(); assert.deepEqual(result.errors, [])
  const pages = topicPages(c.dir), alpha = pages.find(p => p.text.includes('快照时间'))
  assert.match(alpha.text, /37 天/u); assert.match(alpha.text, /因为凌晨导入任务到 06:00/u)
  assert.doesNotMatch(alpha.text, /另一个项目保留/u); assert.match(alpha.text, /## 完整笔记/u)
  const decisionFile = readdirSync(join(c.dir, '阅读/决策'))[0]
  assert.match(readFileSync(join(c.dir, '阅读/决策', decisionFile), 'utf8'), /因为凌晨导入任务到 06:00/u)
  assert.match(readFileSync(join(c.dir, '阅读/首页.md'), 'utf8'), /## 按用途阅读/u)
  for (const file of ['阅读/首页.md', ...pages.map(p => p.file.slice(c.dir.length + 1))]) {
    for (const [, target] of readFileSync(join(c.dir, file), 'utf8').matchAll(/\[\[([^|\]]+)\|/gu)) assert.ok(statSync(join(c.config.vaultPath, target + '.md')).isFile(), target)
  }
})

test('reading merges only formatting variants and explicit same-topic aliases, with redirects that preserve personal additions', async t => {
  const c = setup(t)
  const alias = c.write({ topic: 'CloudSync', content: 'CloudSync保留 30 天。' })
  const canonical = c.write({ topic: '云同步', content: '云同步也称 CloudSync，由项目负责维护。' })
  c.write({ topic: '备份 计划', content: '空格写法的备份计划。' })
  c.write({ topic: '备份计划', content: '紧凑写法的备份计划。' })
  c.write({ topic: '备份计划历史', content: '相似名称但不同主题。' })
  c.write({ projectKey: 'project-beta', topic: '云同步', content: '另一项目的独立云同步。' })
  await c.sync.run()

  const pages = topicPages(c.dir)
  const merged = pages.find(page => page.text.includes(alias.content) && page.text.includes(canonical.content))
  assert.ok(merged, 'explicit alias should share the canonical topic page')
  assert.match(merged.text, /## 主题归并/u)
  assert.match(merged.text, /CloudSync/u)
  assert.match(merged.text, /也称/u)
  assert.ok(pages.some(page => page.text.includes('相似名称但不同主题。')))
  assert.ok(pages.some(page => page.text.includes('另一项目的独立云同步。')))
  assert.equal(pages.filter(page => page.text.includes('空格写法的备份计划。') || page.text.includes('紧凑写法的备份计划。')).length, 1)

  const redirect = pages.find(page => page.file.includes('/CloudSync-') )
  assert.ok(redirect, 'old topic path should remain as a redirect')
  assert.match(redirect.text, /已归并/u)
  assert.match(redirect.text, /\[\[[^|]+\|云同步\]\]/u)
  const built = buildReadingPages({ records: c.store.listAll({ includeDeleted: true }), notes: [], files: new Map(), folder: c.config.folder })
  assert.ok(built.sources.get(redirect.file.slice(c.dir.length + 1)).includes(canonical), 'redirect depends on the record that proves the alias')
  for (const [, target] of redirect.text.matchAll(/\[\[([^|\]]+)\|/gu)) {
    assert.ok(statSync(join(c.config.vaultPath, target + '.md')).isFile(), target)
  }
  writeFileSync(redirect.file, redirect.text + '\n我在旧主题页补充的内容仍要保留。\n')
  c.store.update(alias.id, { content: 'CloudSync更新为 45 天。' }, [{ scope: 'project', projectKey: 'project-alpha' }])
  assert.deepEqual((await c.sync.run()).errors, [])
  const refreshedRedirect = readFileSync(redirect.file, 'utf8')
  assert.match(refreshedRedirect, /已归并/u)
  assert.match(refreshedRedirect, /我在旧主题页补充的内容仍要保留/u)
  const refreshedCanonical = topicPages(c.dir).find(page => page.text.includes('更新为 45 天。'))
  assert.ok(refreshedCanonical)
  assert.doesNotMatch(refreshedCanonical.text, /保留 30 天/u)
})

test('a note linked to an inactive memory cannot prove that two current topics are aliases', t => {
  const c = setup(t), original = c.write({ topic: '星港备份', content: '备份原话。' })
  const other = { ...original, id: 'mem-other', topic: '星港快照', content: '快照原话。' }
  const proof = { ...original, id: 'mem-proof', status: 'candidate', content: '待确认的别名来源。' }
  const note = { scope: 'project', projectKey: 'project-alpha', topic: '星港备份', title: '别名线索', file: 'alias.md', memoryId: proof.id, content: '星港备份也称星港快照。' }
  const { pages } = buildReadingPages({ records: [original, other, proof], notes: [note], files: new Map(), folder: 'DSH Memory' })
  const topicBodies = [...pages].filter(([file]) => file.startsWith('阅读/主题/')).map(([, body]) => body)
  assert.equal(topicBodies.some(body => body.includes(original.content) && body.includes(other.content)), false)
})

test('a redirect rechecks an alias proof stored under another topic before writing', async t => {
  const c = setup(t); c.write({ topic: 'CloudSync', content: '独立的旧主题来源。' })
  const proof = c.write({ topic: '云同步', content: '云同步也称 CloudSync。' })
  assert.deepEqual((await c.sync.run()).errors, [])
  const redirect = topicPages(c.dir).find(page => page.file.includes('/CloudSync-'))
  assert.ok(redirect)

  c.sync.readingSignature = null
  const replace = c.sync.replace.bind(c.sync)
  let removedProof = false, wroteRedirect = false
  c.sync.replace = async (file, before, after, vaultDir) => {
    const result = await replace(file, before, after, vaultDir)
    if (!removedProof && file.includes('/阅读/主题/云同步-')) {
      c.store.remove(proof.id, [{ scope: 'project', projectKey: 'project-alpha' }])
      removedProof = true
    }
    if (file === redirect.file) wroteRedirect = true
    return result
  }
  const result = { errors: [] }
  await refreshReadingPages(c.sync, c.dir, c.config, result)
  assert.equal(removedProof, true)
  assert.equal(wroteRedirect, false)
  assert.ok(result.errors.some(error => error.file === redirect.file.slice(c.dir.length + 1)))
})

test('unclassified entries stay unclassified instead of being inferred into a named theme', t => {
  const c = setup(t), named = c.write({ content: '已有主题的原话。' }), uncategorized = { ...named, id: 'uncategorized', topic: '', content: '未分类内容。' }
  const { pages } = buildReadingPages({ records: [named, uncategorized], notes: [], files: new Map(), folder: 'DSH Memory' })
  const texts = [...pages.values()].join('\n')
  assert.match(texts, /# 未分类/u)
  assert.match(texts, /未分类内容。/u)
  assert.match(texts, /# 备份/u)
  assert.doesNotMatch(texts, /主题归并[\s\S]*?未分类内容/u)
})

test('renamed source files still resolve and unchanged sync does not rewrite reading pages or memory revisions', async t => {
  const c = setup(t), record = c.write({ content: '稳定的原始内容' })
  await c.sync.run()
  renameSync(join(c.dir, record.id + '.md'), join(c.dir, '自然标题.md'))
  await c.sync.run()
  const page = topicPages(c.dir)[0]
  assert.match(page.text, /自然标题\|原记录/u)
  const time = statSync(page.file).mtimeMs, revision = c.store.find(record.id, [{scope:'project', projectKey:'project-alpha'}]).revision
  const result = await c.sync.run()
  assert.equal(statSync(page.file).mtimeMs, time); assert.equal(result.imported, 0)
  assert.equal(c.store.find(record.id, [{scope:'project', projectKey:'project-alpha'}]).revision, revision)
})

test('personal additions survive refresh and restart; edits inside generated text get a visible preserved copy', async t => {
  const c = setup(t), record = c.write({ content: '原始的备份约定' })
  await c.sync.run()
  const page = topicPages(c.dir)[0]
  writeFileSync(page.file, page.text.replace('原始的备份约定', '我的区内修改') + '\n我自己的补充不能丢。\n')
  c.store.update(record.id, {content:'更新后的备份约定'}, [{scope:'project',projectKey:'project-alpha'}])
  assert.deepEqual((await c.make().run()).errors, [])
  const next = readFileSync(page.file, 'utf8')
  assert.match(next, /更新后的备份约定/u); assert.match(next, /我自己的补充不能丢/u); assert.match(next, /查看手动版本/u)
  const copies = readdirSync(join(c.dir, '阅读/手动修改'))
  assert.equal(copies.length, 1); assert.match(readFileSync(join(c.dir, '阅读/手动修改', copies[0]), 'utf8'), /我的区内修改/u)
})

test('forget removes derived content and linked notes from reading pages without re-importing it', async t => {
  const c = setup(t), record = c.write({ content: '需要遗忘的独有文字' })
  promoteMemoryToKnowledge(c.store.root, record)
  await c.sync.run()
  c.store.remove(record.id, [{scope:'project',projectKey:'project-alpha'}])
  assert.deepEqual((await c.sync.run()).errors, [])
  for (const page of topicPages(c.dir)) assert.doesNotMatch(page.text, /需要遗忘的独有文字|完整笔记|原记录/u)
  for (const file of readdirSync(join(c.dir, '阅读/知识库'))) assert.doesNotMatch(readFileSync(join(c.dir, '阅读/知识库', file), 'utf8'), /需要遗忘的独有文字/u)
  assert.doesNotMatch(readFileSync(join(c.dir, '阅读/首页.md'), 'utf8'), /备份/u)
  await c.sync.run()
  assert.equal(c.store.find(record.id, [{scope:'project',projectKey:'project-alpha'}]).status, 'deleted')
})

test('pre-existing personal home page is not overwritten or treated as a memory', async t => {
  const c = setup(t); c.write({content:'独立的界面测试'})
  mkdirSync(join(c.dir, '阅读'), {recursive:true})
  const home = join(c.dir, '阅读/首页.md'); writeFileSync(home, '# 这是我自己的首页\n')
  const result = await c.sync.run()
  assert.equal(readFileSync(home, 'utf8'), '# 这是我自己的首页\n')
  assert.ok(result.errors.some(e => e.file === '阅读/首页.md'))
  assert.equal(c.store.listAll().length, 1)
})

test('changing the vault builds its own reading layer even if the records did not change', async t => {
  const c = setup(t); c.write({content:'独立的同步目标'})
  await c.sync.run(); c.config.folder = 'Another folder'
  assert.deepEqual((await c.sync.run()).errors, [])
  assert.match(readFileSync(join(c.config.vaultPath, c.config.folder, '阅读/首页.md'), 'utf8'), /Another folder\/阅读\/项目/u)
})

test('future and expired facts and quoted material cannot appear as current agreements', t => {
  const c = setup(t), now = Date.now()
  const future = c.write({content:'未来才生效的约定', validFrom:now + 60000})
  const expired = c.write({content:'已经过期的旧约定', validTo:now - 1000})
  const quoted = c.write({content:'仅为引用的资料内容', quoted:true})
  const render = time => [...buildReadingPages({records:[future,expired,quoted],notes:[],files:new Map(),folder:'DSH Memory',now:time}).pages.values()][0]
  assert.doesNotMatch(render(now), /## 当前事实与偏好/u)
  assert.match(render(now), /## 尚未生效/u); assert.match(render(now), /## 历史记录/u); assert.match(render(now), /## 引用资料/u)
  assert.match(render(now + 60001), /## 当前事实与偏好/u)
})

test('a restart between writing generated pages and saving their baseline is recoverable', async t => {
  const c = setup(t); c.write({content:'首次写入被中断的记录'})
  await c.sync.run()
  const stateFile = join(c.store.root, readdirSync(c.store.root).find(file => file.startsWith('obsidian-state-')))
  const state = JSON.parse(readFileSync(stateFile, 'utf8')); delete state.readingPages
  writeFileSync(stateFile, JSON.stringify(state))
  assert.deepEqual((await c.make().run()).errors, [])
})

test('a symlink cannot redirect the derived reading directory outside the sync folder', async t => {
  const c = setup(t); c.write({content:'不允许越界写入的记录'})
  const elsewhere = join(c.root, 'personal'); mkdirSync(elsewhere); mkdirSync(c.dir, {recursive:true})
  symlinkSync(elsewhere, join(c.dir, '阅读'))
  await assert.rejects(c.sync.run(), /符号链接/u)
  assert.deepEqual(readdirSync(elsewhere), [])
})
