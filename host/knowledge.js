/**
 * Knowledge map: a read-only view over memories grouped by topic, with edges
 * for shared tags. The panel renders this as a constellation (topic hubs with
 * memory nodes) so the memory store can be inspected visually without adding
 * a second database.
 *
 * @module dsh-memory/host/knowledge
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const MAX_NODES = 400
export const KNOWLEDGE_DIR = 'knowledge'

/**
 * Build a topic-oriented graph from memory records.
 * @param {object[]} records
 * @param {{ now?: number, maxNodes?: number }} [options]
 */
export function buildKnowledgeGraph(records, options = {}) {
  const maxNodes = Number.isInteger(options.maxNodes) ? Math.max(10, options.maxNodes) : MAX_NODES
  const list = (Array.isArray(records) ? records : [])
    .filter((record) => record !== null && typeof record === 'object' && typeof record.id === 'string')
    .filter((record) => record.status !== 'deleted')
    .sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0))
    .slice(0, maxNodes)

  const topics = new Map()
  for (const record of list) {
    const topic = typeof record.topic === 'string' && record.topic.trim() !== '' ? record.topic.trim() : '未分类'
    if (!topics.has(topic)) topics.set(topic, [])
    topics.get(topic).push(record)
  }

  let topicEntries = [...topics.entries()]
  if (topicEntries.length > 24) {
    topicEntries.sort((left, right) => right[1].length - left[1].length)
    const kept = topicEntries.slice(0, 23)
    const rest = topicEntries.slice(23)
    const other = []
    for (const [, members] of rest) other.push(...members)
    kept.push(['其他', other])
    topicEntries = kept
  }

  const nodes = []
  const edges = []
  const tagIndex = new Map()
  const hubs = []
  for (const [topic, members] of topicEntries) {
    hubs.push({ id: `topic:${topic}`, type: 'topic', label: topic, count: members.length })
    for (const record of members) {
      nodes.push({
        id: record.id,
        type: 'memory',
        topic,
        kind: record.kind,
        status: record.status,
        label: String(record.content ?? '').slice(0, 60),
        confidence: typeof record.confidence === 'number' ? record.confidence : 0.5,
      })
      edges.push({ source: `topic:${topic}`, target: record.id, type: 'topic' })
      for (const tag of Array.isArray(record.tags) ? record.tags : []) {
        const key = String(tag)
        if (!tagIndex.has(key)) tagIndex.set(key, [])
        tagIndex.get(key).push(record.id)
      }
    }
  }
  for (const note of (Array.isArray(options.notes) ? options.notes : [])) {
    const memoryId = typeof note.memoryId === 'string' ? note.memoryId : null
    const topic = typeof note.topic === 'string' && note.topic.trim() !== '' ? note.topic.trim() : '未分类'
    const noteId = `note:${note.file}`
    nodes.push({ id: noteId, type: 'note', topic, kind: 'knowledge', status: 'active', label: String(note.title ?? note.file).slice(0, 60), confidence: 1 })
    const target = memoryId === null ? null : nodes.find((node) => node.type === 'memory' && node.id === memoryId)
    if (target !== undefined) edges.push({ source: noteId, target: memoryId, type: 'knowledge' })
    else hubs.find((hub) => hub.label === topic) === undefined ? null : edges.push({ source: noteId, target: `topic:${topic}`, type: 'knowledge' })
  }

  const traits = Array.isArray(options.traits) ? options.traits : []
  if (traits.length > 0) {
    const profileHub = { id: 'topic:用户画像', type: 'topic', label: '用户画像', count: traits.length }
    hubs.push(profileHub)
    for (const trait of traits) {
      const traitId = `trait:${trait.id}`
      nodes.push({
        id: traitId,
        type: 'trait',
        topic: '用户画像',
        kind: 'trait',
        status: 'active',
        label: String(trait.statement ?? '').slice(0, 60),
        confidence: typeof trait.confidence === 'number' ? trait.confidence : 0.5,
      })
      edges.push({ source: 'topic:用户画像', target: traitId, type: 'topic' })
      for (const evidence of Array.isArray(trait.evidence) ? trait.evidence : []) {
        if (nodes.some((node) => node.type === 'memory' && node.id === evidence.id)) {
          edges.push({ source: traitId, target: evidence.id, type: 'profile' })
        }
      }
    }
  }

  for (const [tag, ids] of tagIndex) {
    if (ids.length < 2) continue
    for (let i = 0; i < ids.length - 1; i += 1) {
      edges.push({ source: ids[i], target: ids[i + 1], type: 'tag', label: tag })
    }
  }
  return {
    nodes,
    hubs,
    edges,
    topicCount: topics.size,
    memoryCount: nodes.length,
    tagCount: tagIndex.size,
    truncated: (Array.isArray(records) ? records : []).length > list.length,
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

/** Read promoted knowledge notes from `<root>/knowledge`. */
export function listKnowledgeNotes(root) {
  const dir = join(root, KNOWLEDGE_DIR)
  if (!existsSync(dir)) return []
  const notes = []
  for (const file of readdirSync(dir).filter((name) => name.endsWith('.md'))) {
    try {
      const text = readFileSync(join(dir, file), 'utf8')
      const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/u)
      if (match === null) continue
      const data = {}
      for (const line of match[1].split(/\r?\n/u)) {
        const separator = line.indexOf(':')
        if (separator <= 0) continue
        const key = line.slice(0, separator).trim()
        const raw = line.slice(separator + 1).trim()
        let value = raw
        if (raw === 'true') value = true
        else if (raw === 'false') value = false
        else if (raw === 'null') value = null
        else if (/^-?\d+(?:\.\d+)?$/u.test(raw)) value = Number(raw)
        else if (raw.startsWith('"') || raw.startsWith('[')) {
          try { value = JSON.parse(raw) } catch { value = raw }
        }
        data[key] = value
      }
      if (data.dsh_knowledge !== true) continue
      notes.push({
        file,
        memoryId: typeof data.memoryId === 'string' ? data.memoryId : null,
        topic: typeof data.topic === 'string' ? data.topic : null,
        tags: Array.isArray(data.tags) ? data.tags : [],
        title: String(text).slice(match[0].length).trim().split('\n')[0]?.slice(0, 60) ?? file,
      })
    } catch {
      // Skip unreadable notes.
    }
  }
  return notes
}
