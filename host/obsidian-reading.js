/** A derived reading layer. Source notes and their sync identities stay intact. */
import { createHash } from 'node:crypto'
import { mkdir, lstat } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { parseKnowledgeNote, splitNoteBody } from './knowledge.js'

const digest = value => createHash('sha256').update(value).digest('hex')
const START = '<!-- dsh-memory:reading:start -->'
const END = '<!-- dsh-memory:reading:end -->'
const label = value => String(value ?? '').replace(/[\[\]|#\r\n]/gu, ' ').trim()
const title = value => label(value).slice(0, 72) || '未命名'
const filename = (name, key) => title(name).replace(/[<>:"/\\?*\u0000-\u001f]/gu, '-') + '-' + digest(key).slice(0, 8) + '.md'
const wiki = (path, name) => `[[${path.replace(/\.md$/u, '')}|${label(name)}]]`
const projectName = key => key === 'global' ? '全局' : key === 'unbound' ? '未指定范围' : key.replace(/-[a-f\d]{10,16}$/iu, '')
const scopeOf = record => record.scope === 'global' ? 'global' : record.scope === 'project' ? record.projectKey : 'unbound'
const topicOf = value => typeof value === 'string' && value.trim() ? value.trim() : '未分类'
const normalizedTopic = value => topicOf(value).normalize('NFKC').toLocaleLowerCase().replace(/\s+/gu, '')
const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
const ALIAS_MARKERS = '(以下简称|简称|又称|亦称|也称|别名|别称|英文名|原名|全称)'
const ALIAS_CUE_PATTERN = /(?:以下简称|简称|又称|亦称|也称|别名|别称|英文名|原名|全称)/u
const currentEvidenceRecord = (record, now) => record?.status === 'active' && !record.quoted && !(record.validFrom > now) && !(Number.isFinite(record.validTo) && record.validTo <= now)
const evidenceSourceIsCurrent = (source, byId, now) => {
  if (!source || source.quoted || source.validFrom > now || Number.isFinite(source.validTo) && source.validTo <= now) return false
  if (source.memoryId) return currentEvidenceRecord(byId.get(source.memoryId), now)
  if (source.id || source.status !== undefined) return currentEvidenceRecord(source, now)
  return true
}
const evidenceRecord = (source, byId) => source?.id ? byId.get(source.id) : source?.memoryId ? byId.get(source.memoryId) : null

function explicitAlias(text, left, right) {
  if (!text || left === right || left === '未分类' || right === '未分类') return null
  const a = escapeRegExp(left), b = escapeRegExp(right)
  const aStart = `(?<![\\p{L}\\p{N}_])${a}`, bStart = `(?<![\\p{L}\\p{N}_])${b}`
  const boundary = '(?![\\p{L}\\p{N}_])'
  const markers = ALIAS_MARKERS
  const match = (pattern, canonical, alias) => {
    const found = text.match(pattern)
    if (!found) return null
    const marker = found[1]
    const fullNameIsRight = marker === '全称'
    return {
      canonical: fullNameIsRight ? alias : canonical,
      alias: fullNameIsRight ? canonical : alias,
      quote: found[0].replace(/\s+/gu, ' ').slice(0, 180),
    }
  }
  const candidates = [
    [new RegExp(`${aStart}\\s*[（(]\\s*${markers}\\s*[:：]?\\s*${b}\\s*[）)]`, 'u'), left, right],
    [new RegExp(`${bStart}\\s*[（(]\\s*${markers}\\s*[:：]?\\s*${a}\\s*[）)]`, 'u'), right, left],
    [new RegExp(`${aStart}\\s*(?:${markers})\\s*[:：]?\\s*${b}${boundary}`, 'u'), left, right],
    [new RegExp(`${bStart}\\s*(?:${markers})\\s*[:：]?\\s*${a}${boundary}`, 'u'), right, left],
  ]
  for (const [pattern, canonical, alias] of candidates) {
    const result = match(pattern, canonical, alias)
    if (result) return result
  }
  const reverseCandidates = [
    [new RegExp(`${aStart}\\s*是\\s*${b}\\s*的\\s*(?:简称|别名|英文名)`, 'u'), right, left],
    [new RegExp(`${bStart}\\s*是\\s*${a}\\s*的\\s*(?:简称|别名|英文名)`, 'u'), left, right],
  ]
  for (const [pattern, canonical, alias] of reverseCandidates) {
    const found = text.match(pattern)
    if (found) return { canonical, alias, quote: found[0].replace(/\s+/gu, ' ').slice(0, 180) }
  }
  return null
}

function topicComponents(entries, byId, now) {
  const names = [...entries.keys()], parent = new Map(names.map(name => [name, name]))
  const find = name => {
    let root = name
    while (parent.get(root) !== root) root = parent.get(root)
    while (parent.get(name) !== name) { const next = parent.get(name); parent.set(name, root); name = next }
    return root
  }
  const union = (left, right) => { const a = find(left), b = find(right); if (a !== b) parent.set(b, a) }
  const normalized = new Map()
  for (const name of names) {
    const key = normalizedTopic(name)
    if (name === '未分类') continue
    if (normalized.has(key)) union(name, normalized.get(key)); else normalized.set(key, name)
  }

  const evidence = []
  for (const [name, entry] of entries) {
    for (const source of entry.sources) {
      if (!evidenceSourceIsCurrent(source, byId, now)) continue
      const text = String(source.content ?? source.body ?? '')
      if (!ALIAS_CUE_PATTERN.test(text)) continue
      for (const candidate of names) {
        if (candidate === name || !text.includes(name) || !text.includes(candidate)) continue
        const proof = explicitAlias(text, name, candidate)
        if (proof) evidence.push({ ...proof, source, left: name, right: candidate })
      }
    }
  }
  const targets = new Map()
  for (const item of evidence) {
    if (!targets.has(item.alias)) targets.set(item.alias, new Set())
    targets.get(item.alias).add(item.canonical)
  }
  const validEvidence = evidence.filter(item => targets.get(item.alias)?.size === 1 && !targets.has(item.canonical))
  for (const item of validEvidence) union(item.canonical, item.alias)

  const components = new Map()
  for (const name of names) {
    const root = find(name)
    if (!components.has(root)) components.set(root, [])
    components.get(root).push(name)
  }
  return [...components.values()].map(component => {
    const explicitNames = new Set(validEvidence.filter(item => component.includes(item.canonical)).map(item => item.canonical))
    const options = explicitNames.size ? [...explicitNames] : component
    const count = name => entries.get(name).sources.length
    const canonical = options.sort((a, b) => count(b) - count(a) || [...a].length - [...b].length || a.localeCompare(b, 'zh'))[0]
    const merges = component.filter(name => name !== canonical).map(name => {
      const proof = validEvidence.find(item => item.alias === name && component.includes(item.canonical))
      return {
        topic: name,
        reason: proof ? `来源原文明确标注为别名：“${proof.quote}”` : '统一全半角、空白与英文大小写后名称相同',
        source: proof?.source ?? null,
      }
    })
    return { canonical, names: component, merges }
  })
}

export function buildReadingPages({ records, notes, files, folder, now = Date.now() }) {
  const pages = new Map(), sources = new Map(), aliasProofs = new Map(), groups = new Map(), projects = new Map(), collections = new Map()
  const categories = { decision: '决策', fact: '知识库', preference: '偏好', episode: '经历' }
  const pathTo = path => posix.join(folder.replaceAll('\\', '/'), path)
  const home = wiki(pathTo('阅读/首页.md'), '记忆首页')
  const topicEntries = new Map()
  const collect = (source, kind) => {
    const scope = scopeOf(source), topic = topicOf(source.topic), key = JSON.stringify([scope, topic])
    if (!topicEntries.has(key)) topicEntries.set(key, { scope, topic, records: [], notes: [], sources: [] })
    const entry = topicEntries.get(key)
    entry[kind].push(source); entry.sources.push(source)
  }
  const byId = new Map(records.map(record => [record.id, record]))
  for (const record of records) if (record.status !== 'deleted') collect(record, 'records')
  for (const note of notes) {
    // A linked note must not re-publish a forgotten memory into a generated page.
    if (note.memoryId && (!byId.has(note.memoryId) || byId.get(note.memoryId).status === 'deleted')) continue
    collect(note, 'notes')
  }
  const entriesByScope = new Map()
  for (const entry of topicEntries.values()) {
    if (!entriesByScope.has(entry.scope)) entriesByScope.set(entry.scope, new Map())
    entriesByScope.get(entry.scope).set(entry.topic, entry)
  }
  const oldTopics = []
  const groupFor = (scope, topic) => {
    const key = JSON.stringify([scope, topic || '未分类'])
    if (!groups.has(key)) groups.set(key, { key, scope, topic: topic || '未分类', records: [], notes: [] })
    return groups.get(key)
  }
  for (const [scope, entries] of entriesByScope) {
    for (const component of topicComponents(entries, byId, now)) {
      const group = groupFor(scope, component.canonical)
      for (const name of component.names) {
        const entry = entries.get(name)
        group.records.push(...entry.records); group.notes.push(...entry.notes)
      }
      group.merges = component.merges
      for (const merge of component.merges) {
        const legacy = '阅读/主题/' + filename(merge.topic, JSON.stringify([scope, merge.topic]))
        const primary = '阅读/主题/' + filename(component.canonical, JSON.stringify([scope, component.canonical]))
        oldTopics.push({ scope, legacy, primary, ...merge, canonical: component.canonical,
          sources: entries.get(merge.topic).sources })
      }
    }
  }
  for (const group of [...groups.values()].sort((a, b) => a.key.localeCompare(b.key, 'zh'))) {
    const name = projectName(group.scope), projectFile = '阅读/项目/' + filename(name, group.scope)
    const file = '阅读/主题/' + filename(group.topic, group.key)
    const lines = [`# ${title(group.topic)}`, '', `${home} · ${wiki(pathTo(projectFile), name)}`, '',
      '同一主题的现行约定、决定与历史放在一起阅读。各段保留原话，未补写来源中没有的原因。', '']
    if (group.merges?.length) {
      lines.push('## 主题归并', '')
      for (const merge of group.merges) {
        const source = merge.source
        const sourcePath = source?.id ? files.get(source.id) ?? `${source.id}.md` : source?.file ? `knowledge/${source.file}` : null
        lines.push(`- 原主题“${merge.topic}” → “${group.topic}”：${merge.reason}${sourcePath ? ` · ${wiki(pathTo(sourcePath), '归并依据')}` : ''}`)
      }
      lines.push('')
    }
    const current = record => record.status === 'active' && !record.quoted && !(record.validFrom > now) && !(Number.isFinite(record.validTo) && record.validTo <= now)
    const sections = [
      ['当前事实与偏好', record => current(record) && ['fact', 'preference'].includes(record.kind)],
      ['决定与原因', record => current(record) && record.kind === 'decision'],
      ['相关经历', record => current(record) && record.kind === 'episode'],
      ['尚未生效', record => record.status === 'active' && !record.quoted && record.validFrom > now],
      ['引用资料', record => record.status === 'active' && record.quoted],
      ['待确认', record => record.status === 'candidate'],
      ['历史记录', record => ['archived', 'superseded'].includes(record.status) || record.status === 'active' && !record.quoted && !(record.validFrom > now) && Number.isFinite(record.validTo) && record.validTo <= now],
    ]
    for (const [heading, accept] of sections) {
      const items = group.records.filter(accept).sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0) || a.id.localeCompare(b.id))
      if (!items.length) continue
      lines.push('## ' + heading, '')
      for (const record of items) {
        const source = files.get(record.id) ?? `${record.id}.md`
        lines.push(String(record.content).replaceAll(START, '&lt;!-- dsh-memory:reading:start -->').replaceAll(END, '&lt;!-- dsh-memory:reading:end -->'), '',
          `${wiki(pathTo(source), '原记录')} · ${record.status === 'archived' ? '已归档 · ' : record.status === 'superseded' ? '已被取代 · ' : ''}${new Date(record.updatedAt ?? record.createdAt).toISOString().slice(0, 10)}`, '')
      }
    }
    if (group.notes.length) {
      lines.push('## 完整笔记', '')
      for (const note of group.notes.sort((a, b) => a.file.localeCompare(b.file))) {
        lines.push(`- ${wiki(pathTo('knowledge/' + note.file), note.title)}`)
      }
      lines.push('')
    }
    pages.set(file, lines.join('\n'))
    sources.set(file, [...group.records, ...group.notes.map(note => byId.get(note.memoryId)).filter(Boolean)])
    const proofs = (group.merges ?? []).filter(merge => merge.source).map(merge => ({ source: merge.source, record: evidenceRecord(merge.source, byId) }))
    if (proofs.length) aliasProofs.set(file, proofs)
    for (const [kind, category] of Object.entries(categories)) {
      const matching = group.records.filter(record => record.kind === kind)
      if (!matching.length) continue
      const collectionFile = `阅读/${category}/` + filename(name, group.scope)
      if (!collections.has(collectionFile)) collections.set(collectionFile, {
        category, project: name, projectFile, scope: group.scope, records: [],
        lines: [`# ${title(name)} · ${category}`, '', `${home} · ${wiki(pathTo(projectFile), name)}`, '',
          '按主题汇集原话。时间、状态和来源与原记录一起保留，可从侧边大纲定位主题。', ''],
      })
      const collection = collections.get(collectionFile)
      collection.lines.push(`## ${title(group.topic)}`, '', `${wiki(pathTo(file), '相关事实、决定与完整笔记')}`, '')
      for (const record of matching.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0) || a.id.localeCompare(b.id))) {
        const status = record.status === 'candidate' ? '待确认' : record.status === 'archived' ? '已归档' : record.status === 'superseded' ? '已被取代'
          : record.quoted ? '引用资料' : record.validFrom > now ? '尚未生效' : Number.isFinite(record.validTo) && record.validTo <= now ? '已过期' : '当前生效'
        collection.lines.push(`**${status}**`, '', String(record.content).replaceAll(START, '&lt;!-- dsh-memory:reading:start -->').replaceAll(END, '&lt;!-- dsh-memory:reading:end -->'), '',
          `${wiki(pathTo(files.get(record.id) ?? `${record.id}.md`), '原记录')} · ${new Date(record.updatedAt ?? record.createdAt).toISOString().slice(0, 10)}`, '')
        collection.records.push(record)
      }
    }
    if (!projects.has(group.scope)) projects.set(group.scope, { name, file: projectFile, groups: [], scope: group.scope })
    projects.get(group.scope).groups.push({ file, topic: group.topic, count: group.records.length + group.notes.length })
  }
  for (const old of oldTopics) {
    const group = groups.get(JSON.stringify([old.scope, old.canonical]))
    const projectFile = '阅读/项目/' + filename(projectName(old.scope), old.scope)
    const lines = [`# ${title(old.topic)}`, '', `${home} · ${wiki(pathTo(projectFile), projectName(old.scope))}`, '',
      `此旧主题已归并至 ${wiki(pathTo(old.primary), old.canonical)}。原主题：“${old.topic}”。`,
      `归并依据：${old.reason}。`, '']
    pages.set(old.legacy, lines.join('\n'))
    const proof = old.source ? { source: old.source, record: evidenceRecord(old.source, byId) } : null
    const dependencies = [...old.sources.map(source => evidenceRecord(source, byId)), proof?.record].filter(Boolean)
    sources.set(old.legacy, [...new Set(dependencies)])
    if (proof) aliasProofs.set(old.legacy, [proof])
  }
  const homeLines = ['# DSH Memory', '', '先按用途阅读，再按项目和主题查找。每份汇集笔记保留完整原话与来源，原始文件仍可独立编辑和同步。', '', '## 按用途阅读', '']
  for (const category of Object.values(categories)) {
    const entries = [...collections.entries()].filter(([, collection]) => collection.category === category)
    if (!entries.length) continue
    homeLines.push('### ' + category, '')
    for (const [file, collection] of entries) {
      pages.set(file, collection.lines.join('\n')); sources.set(file, collection.records)
      homeLines.push(`- ${wiki(pathTo(file), collection.project)} · ${collection.records.length} 项来源`)
    }
    homeLines.push('')
  }
  homeLines.push('## 按项目查找', '')
  for (const project of projects.values()) {
    const links = project.groups.map(group => `- ${wiki(pathTo(group.file), group.topic)} · ${group.count} 项来源`)
    const reading = [...collections.entries()].filter(([, collection]) => collection.scope === project.scope)
      .map(([file, collection]) => `- ${wiki(pathTo(file), collection.category)}`)
    pages.set(project.file, [`# ${title(project.name)}`, '', home, '', '## 阅读笔记', '', ...reading, '', '## 主题索引', '', ...links, ''].join('\n'))
    homeLines.push(`- ${wiki(pathTo(project.file), project.name)} · ${links.length} 个主题`)
  }
  if (!projects.size) homeLines.push('暂时没有可整理的内容。', '')
  pages.set('阅读/首页.md', homeLines.join('\n'))
  return { pages, sources, aliasProofs }
}

export async function refreshReadingPages(sync, dir, config, result) {
  const records = sync.store.listAll({ includeDeleted: true })
  const now = Date.now()
  const signature = digest(JSON.stringify([sync.state.entries, records.map(r => [r.id, r.revision, r.status, r.validFrom > now, Number.isFinite(r.validTo) && r.validTo <= now])]))
  if (signature === sync.readingSignature) return
  for (const path of ['阅读', '阅读/项目', '阅读/主题', '阅读/手动修改', '阅读/决策', '阅读/知识库', '阅读/偏好', '阅读/经历']) {
    const target = join(dir, path)
    await mkdir(target, { recursive: true, mode: 0o700 })
    if ((await lstat(target)).isSymbolicLink()) throw new Error('阅读文件夹不能是符号链接')
  }
  const notes = [], files = new Map()
  for (const [key, entry] of Object.entries(sync.state.entries)) {
    if (key.startsWith('memory:')) files.set(key.slice(7), entry.file)
    else if (key.startsWith('knowledge:')) {
      const text = await sync.existingText(join(sync.root, entry.file))
      if (text === null) continue
      const parsed = parseKnowledgeNote(text), body = splitNoteBody(parsed.body)
      notes.push({ ...parsed.data, title: body.title || posix.basename(entry.file), file: posix.basename(entry.file), content: parsed.body })
    }
  }
  const { pages, sources, aliasProofs } = buildReadingPages({ records, notes, files, folder: config.folder || 'DSH Memory', now })
  const previous = sync.state.readingPages ?? {}
  // Clear generated content for obsolete topics too; never leave forgotten facts
  // in a still-readable derived page. Personal text outside the block is retained.
  for (const file of Object.keys(previous)) {
    if (!/^阅读\/(?:首页\.md|(?:主题|项目|决策|知识库|偏好|经历)\/[^/\\]+\.md)$/u.test(file)) throw new Error('阅读页路径无效')
    if (!pages.has(file)) pages.set(file, '# 已无可用来源\n\n该主题的来源已移除或重新归类。\n')
  }
  let clean = true
  for (const [file, body] of pages) {
    try {
      const target = join(dir, file), before = await sync.existingText(target)
      const generated = START + '\n' + body + '\n' + END
      let after
      if (before === null) {
        after = generated + '\n\n## 我的补充\n\n此处可自由记录。上方内容随同步整理；在上方直接修改的内容会另存为手动版本。\n'
      } else {
        const start = before.indexOf(START), end = before.lastIndexOf(END)
        if (start < 0 || end < start) throw new Error('已有同名笔记未由插件管理，已保留原文件')
        const block = before.slice(start, end + END.length)
        if (!previous[file] && block !== generated) throw new Error('已有同名笔记未由插件管理，已保留原文件')
        let suffix = before.slice(end + END.length)
        if (digest(block) !== previous[file] && block !== generated) {
          const copy = '阅读/手动修改/' + filename(posix.basename(file, '.md'), before)
          await sync.preserve(join(dir, '阅读/手动修改'), posix.basename(copy), before)
          suffix += '\n\n> 上方整理区的手动修改已保留：' + wiki(posix.join(config.folder || 'DSH Memory', copy), '查看手动版本') + '\n'
        }
        after = before.slice(0, start) + generated + suffix
      }
      const current = sync.getConfig()
      if (sync.stopped || current.vaultPath !== config.vaultPath || current.folder !== config.folder || (config.autoSync && !current.autoSync)) throw new Error('同步设置已变化，本轮整理停止')
      // Source changes while awaiting the filesystem must be handled next round.
      if ((sources.get(file) ?? []).some(record => sync.store.find(record.id, [{ scope: record.scope, projectKey: record.projectKey }]) !== record)) throw new Error('来源已变化，下一轮重新整理')
      for (const { source, record } of aliasProofs.get(file) ?? []) {
        const checkedAt = Date.now()
        let currentRecord = null
        if (record) {
          currentRecord = sync.store.find(record.id, [{ scope: record.scope, projectKey: record.projectKey }])
          if (currentRecord !== record || !currentEvidenceRecord(currentRecord, checkedAt)) throw new Error('主题归并依据已变化或失效，下一轮重新整理')
        }
        const proofRecords = new Map()
        if (source.memoryId && currentRecord) proofRecords.set(source.memoryId, currentRecord)
        if (!evidenceSourceIsCurrent(source, proofRecords, checkedAt)) throw new Error('主题归并依据已变化或失效，下一轮重新整理')
        if (source.file && !source.id) {
          const text = await sync.existingText(join(sync.root, 'knowledge', source.file))
          if (text === null) throw new Error('主题归并依据已变化或失效，下一轮重新整理')
          let parsed
          try { parsed = parseKnowledgeNote(text) } catch { throw new Error('主题归并依据已变化或失效，下一轮重新整理') }
          const currentSource = { ...parsed.data, file: source.file, content: parsed.body }
          const fields = ['topic', 'scope', 'projectKey', 'memoryId', 'quoted', 'status', 'validFrom', 'validTo']
          if (parsed.body !== source.content || fields.some(field => currentSource[field] !== source[field]) || !evidenceSourceIsCurrent(currentSource, proofRecords, Date.now())) {
            throw new Error('主题归并依据已变化或失效，下一轮重新整理')
          }
        }
      }
      await sync.replace(target, before, after, dir)
      previous[file] = digest(generated)
    } catch (error) { clean = false; result.errors.push({ file, message: error.message }) }
  }
  sync.state.readingPages = previous
  if (clean) sync.readingSignature = signature
}
