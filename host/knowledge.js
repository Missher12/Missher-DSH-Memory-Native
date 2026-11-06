/**
 * Knowledge map: a read-only view over memories grouped by topic, with edges
 * for shared tags. The panel renders this as a constellation (topic hubs with
 * memory nodes) so the memory store can be inspected visually without adding
 * a second database.
 *
 * @module dsh-memory/host/knowledge
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { hotRecord } from './cache-records.js'
import { parseFrontmatter } from './frontmatter.js'

const MAX_NODES = 400
export const KNOWLEDGE_DIR = 'knowledge'

/**
 * Build a topic-oriented graph from memory records.
 * @param {object[]} records
 * @param {{ now?: number, maxNodes?: number }} [options]
 */
export function buildKnowledgeGraph(records, options = {}) {
  const limit = Number.isInteger(options.maxNodes) ? Math.max(10, options.maxNodes) : MAX_NODES
  const list = (Array.isArray(records) ? records : [])
    .filter(record => record && typeof record.id === 'string' && hotRecord(record).status !== 'deleted')
    .sort((a, b) => (hotRecord(b).updatedAt ?? 0) - (hotRecord(a).updatedAt ?? 0) || a.id.localeCompare(b.id))
  const nodes = new Map(), hubs = new Map(), edges = []
  const topicOf = value => typeof value === 'string' && value.trim() !== '' ? value.trim() : '未分类'
  const hub = topic => {
    const id = `topic:${topic}`
    if (!hubs.has(id)) hubs.set(id, { id, type: 'topic', label: topic, count: 0 })
    return hubs.get(id)
  }
  const aliases = new Map()
  const alias = (name, id) => {
    const key = name.replace(/\.md$/iu, '').toLocaleLowerCase()
    if (!aliases.has(key)) aliases.set(key, new Set())
    aliases.get(key).add(id)
  }
  for (const record of list) {
    const r = hotRecord(record), topic = topicOf(r.topic)
    hub(topic).count++
    nodes.set(r.id, { id:r.id, type:'memory', topic, kind:r.kind, status:r.status, confidence:r.confidence ?? .5, record, links:extractWikiLinks(record.content??'') })
    alias(r.id,r.id)
    edges.push({source:`topic:${topic}`,target:r.id,type:'topic'})
  }
  for (const note of options.notes ?? []) {
    const source = note.source === 'vault' ? 'vault' : 'knowledge'
    const id = `${source === 'vault' ? 'vault' : 'note'}:${note.file}`, topic = topicOf(note.topic)
    const links = Array.isArray(note.links) ? note.links : extractWikiLinks(note.body ?? '')
    hub(topic)
    nodes.set(id, {id,type:'note',source,topic,kind:source==='vault'?'vault':'knowledge',status:'active',label:String(note.title??note.file),confidence:1,links})
    alias(note.file,id);alias(String(note.title??'').replace(/^#+\s*/u,''),id)
    const memory = nodes.get(note.memoryId)
    edges.push({source:id,target:memory?.type==='memory'?memory.id:`topic:${topic}`,type:'knowledge'})
  }
  for (const trait of options.traits ?? []) {
    const id = `trait:${trait.id}`, topic = '用户画像';hub(topic)
    nodes.set(id,{id,type:'trait',topic,kind:'trait',status:'active',label:trait.statement??'',confidence:trait.confidence??.5})
    edges.push({source:`topic:${topic}`,target:id,type:'topic'})
    for(const evidence of trait.evidence??[])if(nodes.has(evidence.id))edges.push({source:id,target:evidence.id,type:'profile'})
  }
  for (const node of [...nodes.values()]) {
    for (const link of node.links ?? []) {
      const key=String(link).replace(/\.md$/iu,'').toLocaleLowerCase()
      let targets = aliases.get(key) ?? aliases.get(key.split('/').at(-1))
      if (!targets && hubs.has(`topic:${link}`)) targets = new Set([`topic:${link}`])
      if (!targets) {
        const id = `unresolved:${link}`
        if(!nodes.has(id))nodes.set(id,{id,type:'unresolved',kind:'unresolved',topic:'未解析链接',status:'unresolved',label:String(link),confidence:0})
        hub('未解析链接'); targets = new Set([id])
      }
      for(const target of targets)edges.push({source:node.id,target,type:'wiki',label:String(link)})
    }
  }
  const label = node => node.record ? String(node.record.content??'') : node.label
  const query = String(options.query??'').trim().toLocaleLowerCase()
  const matched = [...nodes.values()].filter(n => (!options.topic || n.topic===options.topic) && (!query || `${label(n)} ${n.topic} ${n.id}`.toLocaleLowerCase().includes(query)))
  let offset = Math.max(0, Number.isInteger(options.offset) ? options.offset : 0)
  if (options.focus) {
    const i=matched.findIndex(n=>n.id===options.focus)
    if(i>=0)offset=Math.floor(i/limit)*limit
  }
  if (offset >= matched.length) offset = Math.floor(Math.max(0,matched.length-1)/limit)*limit
  const page = matched.slice(offset,offset+limit), ids = new Set(page.map(n=>n.id))
  const tagIndex = new Map()
  for(const n of page)for(const tag of n.record?.tags??[]){if(!tagIndex.has(tag))tagIndex.set(tag,[]);tagIndex.get(tag).push(n.id)}
  for(const [tag, members]of tagIndex)for(let i=1;i<members.length;i++)edges.push({source:members[i-1],target:members[i],type:'tag',label:tag})
  const visibleEdges=edges.filter(e=>ids.has(e.source)||ids.has(e.target))
  const hubIds=new Set(page.map(n=>`topic:${n.topic}`))
  for(const e of visibleEdges)for(const id of [e.source,e.target])if(hubs.has(id))hubIds.add(id)
  const title=id=>hubs.get(id)?.label??(nodes.has(id)?label(nodes.get(id)):id)
  return {
    nodes:page.map(({record,...node})=>({...node,label:record?String(record.content??''):node.label})),
    hubs:[...hubIds].map(id=>hubs.get(id)).filter(Boolean),
    edges:visibleEdges.map(e=>({...e,sourceLabel:title(e.source),targetLabel:title(e.target)})),
    topicCount:hubs.size,memoryCount:list.length,noteCount:[...nodes.values()].filter(n=>n.type==='note').length,
    tagCount:tagIndex.size,total:matched.length,offset,limit,nextOffset:offset+page.length<matched.length?offset+page.length:null,
    truncated:offset+page.length<matched.length,focus:options.focus??null,
  }
}


/** Write one memory as a long-term Markdown knowledge note. */
export function promoteMemoryToKnowledge(root, record) {
  const dir = join(root, KNOWLEDGE_DIR)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const file = join(dir, `${record.id}.md`)
  const topic = typeof record.topic === 'string' && record.topic !== '' ? record.topic : '未分类'
  const text = [
    '---',
    'dsh_knowledge: true',
    `memoryId: ${record.id}`,
    `topic: ${JSON.stringify(topic)}`,
    `tags: ${JSON.stringify(Array.isArray(record.tags) ? record.tags : [])}`,
    `createdAt: ${new Date().toISOString()}`,
    '---',
    '',
    String(record.content ?? ''),
    '',
    '## 关联',
    '',
    `- [[${topic}]]`,
    '',
  ].join('\n')
  const temp = `${file}.tmp`
  writeFileSync(temp, text, { mode: 0o600 })
  renameSync(temp, file)
  return file
}

/** A note name that can only ever resolve inside `<root>/knowledge`. */
export function isKnowledgeFile(name) {
  return typeof name === 'string' && /^[\p{L}\p{N} ._-]{1,120}\.md$/u.test(name)
}

/** Split note text into its frontmatter map and post-frontmatter body. */
function parseNote(text) {
  const parsed = parseFrontmatter(text)
  const data = parsed?.data ?? {}
  const body = parsed?.body ?? String(text)
  return { data, body: body.trimEnd() }
}

/** Public parser for vault-side knowledge notes. */
export function parseKnowledgeNote(text) {
  return parseNote(text)
}

/** Unique `[[wiki links]]` targets in a note body. */
export function extractWikiLinks(text) {
  const links = [], seen = new Set()
  const source = String(text??'').replace(/```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`]*`/gu,'')
  const add = raw => {
    let value=raw.trim()
    try { value=decodeURIComponent(value) } catch { /* Keep literal malformed escapes visible. */ }
    value=value.split('#')[0].trim()
    if(!value||/^[a-z][a-z\d+.-]*:/iu.test(value)||value.startsWith('//')||seen.has(value))return
    seen.add(value);links.push(value)
  }
  for(const match of source.matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/gu))add(match[1])
  for(const match of source.matchAll(/(?<!!)\[[^\[\]]+\]\((?:<([^>]+)>|([^\s)]+))(?:\s+"[^"]*")?\)/gu))add(match[1]??match[2])
  return links
}

function serializeValue(value) {
  if (Array.isArray(value) || typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'boolean' || typeof value === 'number') return String(value)
  if (value === null) return 'null'
  return JSON.stringify(value)
}

function serializeNote(data, body) {
  const lines = ['---']
  for (const key of Object.keys(data)) lines.push(`${key}: ${serializeValue(data[key])}`)
  lines.push('---', '', body.trimEnd(), '')
  return lines.join('\n')
}

/** First non-empty body line is the title; the rest stays editable content. */
export function splitNoteBody(body) {
  const lines = String(body ?? '').split(/\r?\n/u)
  const index = lines.findIndex((line) => line.trim() !== '')
  if (index < 0) return { title: '', rest: '' }
  return {
    title: lines[index].trim(),
    rest: lines.slice(index + 1).join('\n').trim(),
  }
}

/**
 * Read one promoted knowledge note for editing.
 * @param {string} root memory data root
 * @param {string} file note file name
 */
export function readKnowledgeNote(root, file) {
  if (!isKnowledgeFile(file)) throw new Error('invalid knowledge note name')
  const path = join(root, KNOWLEDGE_DIR, file)
  const text = readFileSync(path, 'utf8')
  const { data, body } = parseNote(text)
  if (data.dsh_knowledge !== true) throw new Error('not a dsh knowledge note')
  const stat = statSync(path)
  const { title, rest } = splitNoteBody(body)
  return {
    file,
    memoryId: typeof data.memoryId === 'string' ? data.memoryId : null,
    topic: typeof data.topic === 'string' ? data.topic : '',
    tags: Array.isArray(data.tags) ? data.tags.map((tag) => String(tag)) : [],
    title,
    body: rest,
    mtimeMs: stat.mtimeMs,
    updatedAt: stat.mtimeMs,
  }
}

function normalizeTags(tags) {
  if (!Array.isArray(tags)) return []
  const seen = new Set()
  const out = []
  for (const tag of tags) {
    if (typeof tag !== 'string') continue
    const value = tag.trim()
    if (value === '' || value.length > 32) continue
    const key = value.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(value)
    if (out.length >= 20) break
  }
  return out
}

/**
 * Overwrite one knowledge note in place.
 *
 * The frontmatter map is preserved (unknown keys included); `topic` and `tags`
 * are updated and the body is recomposed as title + rest. When the caller's
 * `expectedMtimeMs` no longer matches the file, nothing is written and a
 * `{ saved: false, reason: 'conflict', current }` result is returned so the
 * panel can offer a reload instead of silently overwriting external edits.
 *
 * @param {string} root
 * @param {{ file: string, title: string, body?: string, topic?: string,
 *   tags?: string[], expectedMtimeMs?: number }} input
 */
export function saveKnowledgeNote(root, input) {
  const file = input?.file
  if (!isKnowledgeFile(file)) throw new Error('invalid knowledge note name')
  const title = typeof input.title === 'string' ? input.title.trim() : ''
  if (title === '') throw new Error('knowledge note title is required')
  if ([...title].length > 200) throw new Error('knowledge note title is too long')
  const body = typeof input.body === 'string' ? input.body.trim() : ''
  if (body.length > 100_000) throw new Error('knowledge note body is too long')
  const topic = typeof input.topic === 'string' ? input.topic.trim().slice(0, 40) : ''
  const tags = normalizeTags(input.tags)

  const path = join(root, KNOWLEDGE_DIR, file)
  const text = readFileSync(path, 'utf8')
  const parsed = parseNote(text)
  if (parsed.data.dsh_knowledge !== true) throw new Error('not a dsh knowledge note')
  const stat = statSync(path)
  if (Number.isFinite(input.expectedMtimeMs) && stat.mtimeMs !== input.expectedMtimeMs) {
    return { saved: false, reason: 'conflict', current: readKnowledgeNote(root, file) }
  }

  const oldTopic = typeof parsed.data.topic === 'string' ? parsed.data.topic : ''
  let rest = body
  if (oldTopic !== '' && topic !== oldTopic) {
    const link = `- [[${oldTopic}]]`
    if (rest.split(/\r?\n/u).includes(link)) {
      rest = rest.split(/\r?\n/u).map((line) => (line === link ? `- [[${topic}]]` : line)).join('\n')
    }
  }
  const next = { ...parsed.data }
  next.dsh_knowledge = true
  next.topic = topic
  next.tags = tags
  const composed = title + (rest === '' ? '' : `\n\n${rest}`) + '\n'
  const temp = `${path}.tmp`
  writeFileSync(temp, serializeNote(next, composed), { mode: 0o600 })
  renameSync(temp, path)
  return { saved: true, ...readKnowledgeNote(root, file) }
}

/** Read promoted knowledge notes from `<root>/knowledge`. */
/**
 * @param {string} root
 * @param {{ includeBody?: boolean }} [options]
 */
export function listKnowledgeNotes(root, options = {}) {
  const dir = join(root, KNOWLEDGE_DIR)
  if (!existsSync(dir)) return []
  const notes = []
  for (const file of readdirSync(dir).filter((name) => name.endsWith('.md'))) {
    try {
      const { data, body } = parseNote(readFileSync(join(dir, file), 'utf8'))
      if (data.dsh_knowledge !== true) continue
      const { title } = splitNoteBody(body)
      const note = {
        file,
        memoryId: typeof data.memoryId === 'string' ? data.memoryId : null,
        topic: typeof data.topic === 'string' ? data.topic : null,
        tags: Array.isArray(data.tags) ? data.tags : [],
        title: title === '' ? file : title.slice(0, 60),
        links: extractWikiLinks(body),
      }
      if (options.includeBody === true) note.body = body
      notes.push(note)
    } catch {
      // Skip unreadable notes.
    }
  }
  return notes
}
