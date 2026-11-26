import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs, { existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

import { isCurrentKnowledgeQuote, KnowledgeRecallIndex } from '../host/knowledge-recall.js'
import { promoteMemoryToKnowledge, readKnowledgeNote, saveKnowledgeNote } from '../host/knowledge.js'
import { slotEvidence } from '../host/recall-flow.js'
import { recallQueryPlan, recallTimeIntent } from '../host/recall.js'
import { MemoryStore } from '../host/store.js'

const PROJECT = 'project-alpha'

function setup(t, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-memory-knowledge-recall-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const now = Date.now()
  const store = new MemoryStore({ root, clock: () => now }).open()
  const saved = store.write({
    id: 'mem_scope01', kind: 'fact', scope: 'project', projectKey: PROJECT,
    content: 'Production database uses PostgreSQL 16 for the primary application service.',
    status: 'active', confidence: 0.95, ...overrides,
  }, { now })
  assert.equal(saved.ok, true)
  const file = promoteMemoryToKnowledge(root, saved.record)
  const index = new KnowledgeRecallIndex(root, store)
  return { root, now, store, file, index, record: saved.record }
}

test('linked knowledge notes inherit parent effective time and quotation eligibility', (t) => {
  const future = setup(t, { validFrom: Date.now() + 60_000 })
  assert.equal(future.index.search('PostgreSQL', { projectKey: PROJECT, now: future.now }).length, 0)

  const expired = setup(t)
  const oldHit = expired.index.search('PostgreSQL', { projectKey: PROJECT, now: expired.now })[0]
  assert.ok(oldHit)
  expired.store.update(expired.record.id, { validTo: expired.now - 1 }, [{ scope: 'project', projectKey: PROJECT }])
  assert.equal(expired.index.validate(oldHit, PROJECT, expired.now), false)
  assert.equal(expired.index.search('PostgreSQL', { projectKey: PROJECT, now: expired.now }).length, 0)

  const quoted = setup(t, { quoted: true })
  assert.equal(quoted.index.search('PostgreSQL', { projectKey: PROJECT, now: quoted.now }).length, 0)
})

test('a dated note proof is restricted by its linked memory at that date and by later revocation', t => {
  const from = Date.UTC(2025, 0, 1), to = Date.UTC(2025, 3, 1), asOf = Date.UTC(2025, 2, 2)
  const { root, now, file, index, record } = setup(t, { validFrom: from, validTo: to })
  writeFileSync(file, readFileSync(file, 'utf8').replace('dsh_knowledge: true\n',
    'dsh_knowledge: true\nvalidFrom: ' + from + '\nvalidTo: ' + to + '\n'))
  index.refresh()
  const hit = index.search('PostgreSQL', { projectKey: PROJECT, now, asOf })[0]
  assert.ok(hit)
  assert.equal(index.validate(hit, PROJECT, now), true)
  assert.equal(index.validate(hit, 'project-beta', now), false)
  assert.equal(index.validate({ record: { ...hit.record, noteReferenceTimes: undefined } }, PROJECT, now), false)
  const otherWriter = new MemoryStore({ root }).open()
  otherWriter.update(record.id, { validFrom: asOf + 1 }, [{ scope: 'project', projectKey: PROJECT }])
  assert.equal(index.validate(hit, PROJECT, now), false)
  assert.equal(index.search('PostgreSQL', { projectKey: PROJECT, now, asOf }).length, 0)
  otherWriter.remove(record.id, [{ scope: 'project', projectKey: PROJECT }])
  assert.equal(index.validate(hit, PROJECT, now), false)
})

test('sensitive note edits are rejected by direct search validation', (t) => {
  const { root, now, index, file } = setup(t)
  const hit = index.search('PostgreSQL', { projectKey: PROJECT, now })[0]
  assert.ok(hit)
  const note = readKnowledgeNote(root, file.split('/').at(-1))
  saveKnowledgeNote(root, {
    file: note.file, title: 'PostgreSQL api_key=private-example-token', body: note.body,
    topic: note.topic, tags: note.tags, expectedMtimeMs: note.mtimeMs,
  })
  assert.equal(index.validate(hit, PROJECT, now), false)
  index.refresh()
  assert.equal(index.search('PostgreSQL', { projectKey: PROJECT, now }).length, 0)
})

test('ineligible linked notes cannot use up the page of valid knowledge evidence', t => {
  const { root, index, now, store, record } = setup(t)
  store.remove(record.id, [{ scope: 'project', projectKey: PROJECT }])
  const writeNote = (file, body, linked = null) => writeFileSync(join(root, 'knowledge', file),
    ['---', 'dsh_knowledge: true', 'scope: project', 'projectKey: ' + PROJECT,
      ...(linked ? ['memoryId: ' + linked] : []), '---', '# 珊瑚应急审批', body].join('\n') + '\n')
  for (let offset = 0; offset < 48; offset += 1) {
    writeNote('retired-' + offset + '.md', '珊瑚应急审批须联系旧负责人。', record.id)
  }
  writeNote('valid.md', '本期说明与交接文案。'.repeat(80) + '\n珊瑚应急审批由当前值班人复核。')
  index.refresh()
  const hits = index.search('珊瑚应急审批', { projectKey: PROJECT, now: now + 30000, limit: 40 })
  assert.deepEqual(hits.map(hit => hit.record.noteFile), ['valid.md'])
  assert.equal(index.validate(hits[0], PROJECT, now + 30000), true)
})

test('standalone note validity and quotation govern search and semantic candidates', t => {
  const { root, index, now } = setup(t)
  const clock = now + 30_000
  for (const [tag, frontmatter] of [
    ['quoted', 'quoted: true'],
    ['retired', 'status: deleted'],
    ['future', 'validFrom: ' + (clock + 60_000)],
    ['expired', 'validTo: ' + (clock - 1)],
    ['confirmed', 'status: active'],
  ]) {
    writeFileSync(join(root, 'knowledge', tag + '.md'),
      ['---', 'dsh_knowledge: true', 'scope: project', 'projectKey: ' + PROJECT,
        frontmatter, '---', '# 蓝帆调度表', '蓝帆调度表按当前项目的工作日安排。'].join('\n') + '\n')
  }
  index.refresh()
  const search = index.search('蓝帆调度表', { projectKey: PROJECT, now: clock })
  assert.deepEqual(search.map(hit => hit.record.noteFile), ['confirmed.md'])
  assert.equal(index.validate(search[0], PROJECT, clock), true)
  const semantic = index.candidates(PROJECT, { now: clock, limit: 40 }).map(hit => hit.record.noteFile)
  assert.ok(semantic.includes('confirmed.md'))
  for (const file of ['quoted', 'retired', 'future', 'expired']) assert.ok(!semantic.includes(file + '.md'))
})

test('dated candidates include the historical title section while excluding withdrawn subsections', t => {
  const { root, index, now } = setup(t)
  const at = Date.UTC(2025, 2, 2), from = Date.UTC(2025, 0, 1)
  const filename = 'versioned-handbook.md'
  const historical = 'Handle supplier substitutions by signed memo from finance.'
  const current = 'Consult the procurement operations desk for new supplier onboarding.'
  writeFileSync(join(root, 'knowledge', filename), [
    '---', 'dsh_knowledge: true', 'scope: project', 'projectKey: ' + PROJECT, 'validFrom: ' + from, '---',
    '# Historical policy', '## Approved rule', historical, '## Deprecated policy', 'Archive test only: red rubber stamp.',
    '# Operations desk', current, '',
  ].join('\n'))
  index.refresh()
  const options = { projectKey: PROJECT, now: now + 1000 }
  assert.deepEqual(index.search('signed memo from finance', options), [])
  assert.deepEqual(index.search('signed memo from finance', { ...options, asOf: at }).map(hit => hit.record.noteFile), [filename])
  const [hit] = index.candidates(PROJECT, { now: options.now, referenceTimes: [null, at, from - 86400000] })
    .filter(hit => hit.record.noteFile === filename)
  assert.deepEqual(hit.record.noteReferenceTimes, [null, at])
  assert.deepEqual(hit.record.semanticSections, [{ text: historical, datedOnly: true }, { text: current, datedOnly: false }])
  assert.equal(index.validate(hit, PROJECT, options.now), true)
})

test('a changed note invalidates cached evidence even when the old modification time is restored', t => {
  const { root, index, now } = setup(t)
  const clock = now + 30_000, other = 'project-beta'
  const file = join(root, 'knowledge', 'oversize-header.md')
  const write = (projectKey, version) => writeFileSync(file, [
    '---', 'dsh_knowledge: true', 'scope: project', 'projectKey: ' + projectKey,
    'description: ' + JSON.stringify('旧版属性'.repeat(1600)),
    'aliases: [MoonShell]', '---', '# 远航测试',
    `远航测试的替代构建工具使用 Meson ${version}。`,
  ].join('\n'))
  write(PROJECT, '2.3.0')
  index.refresh()
  const validate = version => (_record, quote) => quote.includes('Meson ' + version)
  const options = { projectKey: PROJECT, now: clock, verify: validate('2.3.0') }
  const old = index.search('MoonShell 的替代构建工具', options)[0]
  assert.ok(old)
  assert.equal(index.validate(old, PROJECT, clock), true)
  write(other, '3.7.1')
  utimesSync(file, clock / 1000, old.record.updatedAt / 1000)
  assert.equal(index.validate(old, PROJECT, clock), false)
  assert.deepEqual(index.search('MoonShell 的替代构建工具', { ...options, verify: validate('3.7.1') }), [])
  const latest = index.search('MoonShell 的替代构建工具',
    { ...options, projectKey: other, verify: validate('3.7.1') })[0]
  assert.ok(latest)
  assert.ok(index.validate(latest, other, clock))
})

test('current knowledge uses the section that supports the requested state and falls back past a retired title match', t => {
  const { root, now, index } = setup(t)
  const write = (file, projectKey, title, content) => writeFileSync(join(root, 'knowledge', file), [
    '---', 'dsh_knowledge: true', 'scope: project', `projectKey: ${projectKey}`, '---', `# ${title}`, content,
  ].join('\n'))
  const filler = Array.from({ length: 120 }, (_, index) => `交接事项 ${index}。逐项复核。`).join('\n')
  write('split.md', PROJECT, 'Atlas 快照', [
    '## 已废止的设置', 'Atlas 快照每天 01:39 执行。',
    '## 旧方案', 'Atlas 快照每天 04:15 执行。', filler,
    '## 当前方案', 'Atlas 快照每天 02:45 执行。',
    '```text', 'Atlas 快照每天 19:32 执行。', '```',
  ].join('\n'))
  write('title-only.md', 'west-work', 'Atlas 快照', '## 退役方案\nAtlas 快照每天 06:35 执行。')
  write('handover.md', 'west-work', '运行交接', `${filler}\n## 当前方案\nAtlas 快照每天 01:23 执行。`)
  write('another.md', 'another-work', 'Atlas 快照', '## 当前方案\nAtlas 快照每天 09:32 执行。')
  index.refresh()
  const query = 'Atlas 快照目前几点执行？'
  const plan = { ...recallQueryPlan(query).find(item => item.role === 'subquestion'),
    coverageRequired: true, timeIntent: recallTimeIntent(query, now) }
  const forProject = projectKey => index.search(plan.query, { projectKey, now,
    verify: (record, quote, section) => slotEvidence(plan, [{ record: { ...record,
      recallQuote: quote, notePassages: [{ quote, section }] } }], true).length > 0 })
  const local = forProject(PROJECT)
  assert.deepEqual(local.map(hit => [hit.record.noteFile, hit.record.recallQuote]), [['split.md', 'Atlas 快照每天 02:45 执行。']])
  assert.equal(isCurrentKnowledgeQuote(local[0].record, 'Atlas 快照每天 01:39 执行。'), false)
  assert.equal(isCurrentKnowledgeQuote(local[0].record, 'Atlas 快照每天 04:15 执行。'), false)
  assert.equal(isCurrentKnowledgeQuote(local[0].record, 'Atlas 快照每天 19:32 执行。'), false)
  assert.equal(isCurrentKnowledgeQuote(local[0].record, 'Atlas 快照每天 02:45 执行。'), true)
  assert.equal(isCurrentKnowledgeQuote(local[0].record, '# Atlas 快照\n## 当前方案\nAtlas 快照每天 02:45 执行。'), true)
  assert.equal(isCurrentKnowledgeQuote(local[0].record, '# Atlas 快照\n## 当前方案'), false)
  assert.equal(isCurrentKnowledgeQuote(local[0].record, '## 旧方案\nAtlas 快照每天 02:45 执行。'), false)
  assert.equal(isCurrentKnowledgeQuote(local[0].record, '## 不存在的标题\nAtlas 快照每天 02:45 执行。'), false)
  assert.deepEqual(forProject('west-work').map(hit => [hit.record.noteFile, hit.record.recallQuote]),
    [['handover.md', 'Atlas 快照每天 01:23 执行。']])
})

test('underlined headings keep retired and current statements separate in long notes', t => {
  const { root, now, index } = setup(t)
  const previous = '栖羽快照每天 00:42 执行。'
  const current = '栖羽快照每天 04:37 执行。'
  const misleading = '栖羽快照每天 03:19 执行。'
  const filler = Array.from({ length: 140 }, (_, i) => `条目 ${i + 1} 已和交接清单核对。\n`).join('\n')
  writeProjectNote(join(root, 'knowledge', 'runbook.md'), PROJECT, '栖羽快照', [
    '退役方案', '迁移前的规则', '----------', previous, '',
    '> 当前方案', '----------', misleading, '',
    '```text', '当前方案', '----------', misleading, '```', '',
    filler, '当前方案', '----------', current, '',
  ].join('\n'))
  writeProjectNote(join(root, 'knowledge', 'superseded.md'), PROJECT, '夜杉镜像', [
    '废弃的设置', '----------', '夜杉镜像每天 08:19 执行。', '',
  ].join('\n'))
  index.refresh()
  const clock = now + 30000
  const options = { projectKey: PROJECT, now: clock }
  const [hit] = index.search('栖羽快照', options)
  assert.equal(hit?.record.noteQuote, current)
  assert.deepEqual(index.search('夜杉镜像', options), [])
  assert.ok(index.validate(hit, PROJECT, clock))

  const oldExcerpt = '退役方案\n迁移前的规则\n----------\n' + previous
  const currentExcerpt = '当前方案\n----------\n' + current
  assert.equal(isCurrentKnowledgeQuote(hit.record, oldExcerpt), false)
  assert.equal(isCurrentKnowledgeQuote(hit.record, misleading), false)
  assert.equal(isCurrentKnowledgeQuote(hit.record, currentExcerpt), true)
  assert.equal(isCurrentKnowledgeQuote(hit.record, '没有的标题\n----------\n' + current), false)
  const semantic = index.candidates(PROJECT, { now: clock }).find(item => item.record.noteFile === 'runbook.md')
    .record.semanticSections
  assert.ok(semantic.some(section => section.text.includes(current)))
  assert.ok(semantic.every(section => !section.text.includes(previous) && !section.text.includes(misleading)))
})

const directoryRoutes = root => join(root, 'derived-knowledge-directory.json')

async function persistedDirectory(root, accept = () => true) {
  const path = directoryRoutes(root)
  for (let attempt = 0; attempt < 60; attempt++) {
    if (existsSync(path)) {
      const contents = readFileSync(path, 'utf8')
      if (accept(contents)) return contents
    }
    await delay(50)
  }
  assert.fail('the knowledge directory was not persisted')
}

const routeChecksum = routes => createHash('sha256').update(JSON.stringify(routes)).digest('hex')

function writeProjectNote(file, key, title, body, properties = []) {
  writeFileSync(file, [
    '---', 'dsh_knowledge: true', 'scope: project', 'projectKey: ' + key, ...properties,
    '---', '# ' + title, body,
  ].join('\n') + '\n')
}

test('a reopened knowledge directory rechecks linked memory authority and project scope', async t => {
  const { root, now, store, index, record, file } = setup(t)
  const other = 'project-beta', clock = now + 30_000
  writeProjectNote(join(root, 'knowledge', 'other.md'), other, 'Database', 'Other project uses PostgreSQL 13.')
  index.refresh()
  const hit = index.search('PostgreSQL', { projectKey:PROJECT, now:clock })[0]
  assert.ok(hit)
  const raw = await persistedDirectory(root)
  assert.equal(JSON.parse(raw).routes.length, 2)
  assert.doesNotMatch(raw, /PostgreSQL|project-alpha|project-beta|mem_scope01|other\.md/u)

  const warm = new KnowledgeRecallIndex(root, store)
  assert.ok(warm.validate(hit, PROJECT, clock))
  assert.equal(warm.validate(hit, other, clock), false)
  store.remove(record.id, [{ scope:'project', projectKey:PROJECT }])
  const revoked = new KnowledgeRecallIndex(root, store)
  assert.equal(revoked.validate(hit, PROJECT, clock), false)
  assert.deepEqual(revoked.search('PostgreSQL', { projectKey:PROJECT, now:clock }), [])
  assert.deepEqual(revoked.search('PostgreSQL', { projectKey:other, now:clock }).map(row => row.record.noteFile), ['other.md'])

  rmSync(file)
  const withoutFile = new KnowledgeRecallIndex(root, store)
  assert.equal(withoutFile.validate(hit, PROJECT, clock), false)
})

test('reopening the directory detects scope changes with the previous note modification time', async t => {
  const { root, now, store, index } = setup(t)
  const file = join(root, 'knowledge', 'handoff.md')
  const other = 'project-beta', clock = now + 30_000
  writeProjectNote(file, PROJECT, 'Quartz handoff', 'Quartz backup keeps 37 copies.')
  index.refresh()
  const hit = index.search('Quartz', { projectKey:PROJECT, now:clock })[0]
  assert.ok(hit)
  await persistedDirectory(root)
  const previous = statSync(file)
  writeProjectNote(file, other, 'Quartz handoff', 'Quartz backup keeps 68 copies.')
  utimesSync(file, previous.atime, previous.mtime)
  const after = new KnowledgeRecallIndex(root, store)
  assert.equal(after.validate(hit, PROJECT, clock), false)
  assert.deepEqual(after.search('Quartz', { projectKey:PROJECT, now:clock }), [])
  const latest = after.search('Quartz', { projectKey:other, now:clock })[0]
  assert.match(latest?.record.noteQuote, /68 copies/u)
  assert.ok(after.validate(latest, other, clock))
})

test('background reopening keeps a changed note in its verified project after an abandoned waiter', async t => {
  const { root, now, store, index } = setup(t)
  const other = 'project-beta', clock = now + 30_000
  const file = join(root, 'knowledge', 'handoff.md')
  writeProjectNote(file, PROJECT, 'Quartz handoff', 'Quartz backup keeps 37 copies.')
  for (let i = 0; i < 75; i++) {
    writeProjectNote(join(root, 'knowledge', `inventory-${i}.md`), PROJECT, 'Inventory', 'Shelf contents are labelled.')
  }
  index.refresh()
  const old = index.search('Quartz', { projectKey: PROJECT, now: clock })[0]
  assert.ok(old)
  assert.equal(JSON.parse(await persistedDirectory(root)).routes.length, 77)
  index.dispose()

  const next = new KnowledgeRecallIndex(root, store, { background: true })
  t.after(() => next.dispose())
  const cancelled = new AbortController()
  const abandoned = next.waitUntilReady(cancelled.signal)
  cancelled.abort()
  assert.equal(await abandoned, false)
  const previous = statSync(file)
  writeProjectNote(file, other, 'Quartz handoff', 'Quartz backup keeps 68 copies.')
  utimesSync(file, previous.atime, previous.mtime)
  next.refresh()
  assert.equal(await next.waitUntilReady(), true)
  assert.equal(next.validate(old, PROJECT, clock), false)
  assert.deepEqual(next.search('Quartz', { projectKey: PROJECT, now: clock }), [])
  const latest = next.search('Quartz', { projectKey: other, now: clock })[0]
  assert.match(latest?.record.noteQuote, /68 copies/u)
  assert.equal(next.validate(latest, other, clock), true)
})

test('a warm dated query opens only eligible headers and still discovers an edited period', async t => {
  const { root, store, index, now } = setup(t)
  const dir = join(root, 'knowledge'), before = Date.UTC(2025, 0, 1), at = Date.UTC(2025, 2, 2), after = Date.UTC(2025, 4, 1)
  const authoritative = ['status: superseded', 'validFrom: ' + before, 'validTo: ' + after]
  const excluded = [[], ['validFrom: ' + after], ['validFrom: ' + before, 'validTo: ' + (at - 1)]]
  for (let i = 0; i < 75; i++) {
    writeProjectNote(join(dir, `reference-${i}.md`), PROJECT, 'Quartz handoff', 'Quartz inventory has an unrelated schedule.', excluded[i % 3])
  }
  writeProjectNote(join(dir, 'archive.md'), PROJECT, 'Quartz handoff', 'Quartz backup keeps 37 copies.', authoritative)
  index.refresh()
  await persistedDirectory(root)
  index.dispose()

  const warm = new KnowledgeRecallIndex(root, store, { background: true })
  t.after(() => warm.dispose())
  assert.equal(await warm.waitUntilReady(), true)
  const original = fs.openSync, opened = new Set()
  const directoryPrefix = dir + sep
  const restore = () => { fs.openSync = original; syncBuiltinESMExports() }
  fs.openSync = (file, ...rest) => {
    if (typeof file === 'string' && file.startsWith(directoryPrefix)) opened.add(file.slice(directoryPrefix.length))
    return original(file, ...rest)
  }
  syncBuiltinESMExports()
  try {
    const options = { projectKey: PROJECT, now: now + 30_000, asOf: at }
    assert.deepEqual(warm.search('Quartz backup', options).map(hit => hit.record.noteFile), ['archive.md'])
    assert.equal(opened.size, 1)
    assert.ok(opened.has('archive.md'))

    const changed = join(dir, 'reference-1.md'), previous = statSync(changed)
    writeProjectNote(changed, PROJECT, 'Quartz handoff', 'Quartz retest keeps 68 copies.', authoritative)
    utimesSync(changed, previous.atime, previous.mtime)
    const hit = warm.search('Quartz retest', options).find(hit => hit.record.noteFile === 'reference-1.md')
    assert.match(hit?.record.noteQuote, /68 copies/u)
    assert.ok(warm.validate(hit, PROJECT, options.now))
  } finally { restore() }
})

test('a damaged directory falls back to Markdown and its routes never grant access', async t => {
  const { root, now, store, index } = setup(t)
  const other = 'project-beta', clock = now + 30_000
  const hit = index.search('PostgreSQL', { projectKey:PROJECT, now:clock })[0]
  assert.ok(hit)
  const saved = JSON.parse(await persistedDirectory(root))
  const hash = text => createHash('sha256').update(text).digest('hex')
  const routes = saved.routes.map(([id, , period]) => [id, hash(other), period])
  const path = directoryRoutes(root)
  writeFileSync(path, JSON.stringify({ ...saved, routes }))
  assert.ok(new KnowledgeRecallIndex(root, store).validate(hit, PROJECT, clock))

  writeFileSync(path, JSON.stringify({ ...saved, routes, checksum: routeChecksum(routes) }))
  const otherRoute = new KnowledgeRecallIndex(root, store)
  assert.equal(otherRoute.validate(hit, other, clock), false)
  assert.deepEqual(otherRoute.search('PostgreSQL', { projectKey:other, now:clock }), [])
  assert.ok(otherRoute.validate(hit, PROJECT, clock))
})

test('a v1 directory learns dates only for headers reopened by a query', async t => {
  const { root, store, now, index } = setup(t)
  const other = 'project-beta', start = Date.UTC(2025, 0, 1), asOf = Date.UTC(2025, 2, 2)
  writeProjectNote(join(root, 'knowledge', 'other.md'), other, 'Quartz', 'Quartz backups keep 93 copies.')
  writeProjectNote(join(root, 'knowledge', 'current.md'), PROJECT, 'Quartz', 'Quartz backups keep 37 copies.', ['validFrom: ' + start])
  index.refresh()
  const initial = JSON.parse(await persistedDirectory(root))
  assert.equal(initial.version, 2)
  assert.equal(initial.routes.length, 3)
  index.dispose()

  const routes = initial.routes.map(([id, bucket]) => [id, bucket])
  writeFileSync(directoryRoutes(root), JSON.stringify({ version: 1, routes, checksum: routeChecksum(routes) }))
  const warm = new KnowledgeRecallIndex(root, store, { background: true })
  t.after(() => warm.dispose())
  assert.equal(await warm.waitUntilReady(), true)
  assert.equal(JSON.parse(readFileSync(directoryRoutes(root), 'utf8')).version, 1)
  const hits = warm.search('Quartz backups', { projectKey: PROJECT, now: now + 30_000, asOf })
  assert.deepEqual(hits.map(hit => hit.record.noteFile), ['current.md'])
  assert.ok(warm.validate(hits[0], PROJECT, now + 30_000))
  const migrated = JSON.parse(await persistedDirectory(root, contents => JSON.parse(contents).version === 2))
  assert.equal(migrated.routes.length, 3)
  assert.equal(migrated.routes.filter(([, , period]) => period === null).length, 1)
  assert.ok(migrated.routes.some(([, , period]) => period?.[1] === start))
})

test('a cached eligible period cannot grant dated recall for undated Markdown', async t => {
  const { root, store, now, index } = setup(t)
  const saved = JSON.parse(await persistedDirectory(root))
  index.dispose()
  const routes = saved.routes.map(([id, bucket]) => [id, bucket, ['active', Date.UTC(2025, 0, 1), null]])
  writeFileSync(directoryRoutes(root), JSON.stringify({ ...saved, routes, checksum: routeChecksum(routes) }))
  const warm = new KnowledgeRecallIndex(root, store)
  t.after(() => warm.dispose())
  assert.deepEqual(warm.search('PostgreSQL', { projectKey: PROJECT, now, asOf: Date.UTC(2025, 2, 2) }), [])
  assert.equal(warm.search('PostgreSQL', { projectKey: PROJECT, now }).length, 1)
})
