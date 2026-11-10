/** Project-private original passages. Grants are authority; the index is disposable. */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { canReadSource, readSource, blockSourceRecall, readCaptureTasks, updateCaptureTask } from './capture-journal.js'
import { atomicWritePrivate } from './persistence.js'
import { isValidProjectKey } from './paths.js'
import { looksSensitive } from './records.js'
import { MemoryIndex } from './search.js'
import { analyzeUserMessageControls } from './user-controls.js'

const sourcePattern = /^src_[a-f0-9]{24}$/u
const hash = text => createHash('sha256').update(text).digest('hex')
const directory = (root, projectKey) => join(root, 'capture', 'recall-grants', projectKey)
const hasStatement = text => (text.match(/[^。！？!?\n]+[。！？!?]?/gu) ?? []).some(clause => {
  const value = clause.trim()
  return value.length > 3 && !/[？?]$/u.test(value) &&
    !/^(?:请|帮我|麻烦|能不能|是不是|是否|what\b|which\b|who\b|when\b|where\b|why\b|how\b)/iu.test(value) &&
    !/(?:是什么|是多少|为什么|多少|多久|吗|呢)[。\s]*$/u.test(value)
})
const permitted = source => source?.role === 'user' && source.sourceKind === 'user' &&
  typeof source.text === 'string' && !looksSensitive(source.text) &&
  hasStatement(source.text) &&
  !analyzeUserMessageControls(source.text).noSaveDirective &&
  !/^\s*(?:>|```|引用(?:示例|内容)?[:：]|虚构(?:测试|验收)?(?:材料|资料))/u.test(source.text)

/** Called only after turn-level opt-out checks, never merely because a file exists. */
export function grantSourceRecall(root, source, projectKey) {
  if (!isValidProjectKey(projectKey) || source?.projectKey !== projectKey ||
      !sourcePattern.test(source?.id ?? '') || !permitted(source) || !canReadSource(root, source.id)) return false
  const dir = directory(root, projectKey)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  atomicWritePrivate(join(dir, source.id + '.json'), JSON.stringify({
    version: 1, sourceId: source.id, projectKey, textHash: hash(source.text), grantedAt: Date.now(),
  }) + '\n')
  return true
}

function authorized(root, sourceId, projectKey, allowBlocked = false) {
  if (!isValidProjectKey(projectKey) || !sourcePattern.test(sourceId) || (!allowBlocked && !canReadSource(root, sourceId))) return null
  try {
    const grant = JSON.parse(readFileSync(join(directory(root, projectKey), sourceId + '.json'), 'utf8'))
    if (grant.version !== 1 || grant.sourceId !== sourceId || grant.projectKey !== projectKey) return null
    const source = readSource(root, sourceId)
    return source?.projectKey === projectKey && permitted(source) && hash(source.text) === grant.textHash ? source : null
  } catch { return null }
}

function passages(source) {
  const records = [], text = source.text, contentHash = hash(text)
  for (let from = 0; from < text.length;) {
    let to = Math.min(text.length, from + 420)
    if (to < text.length) {
      const endings = [...text.slice(from + 210, to).matchAll(/[。！？\n]/gu)]
      if (endings.length) to = from + 210 + endings.at(-1).index + 1
      if (/[\uDC00-\uDFFF]/u.test(text[to])) to--
    }
    const content = text.slice(from, to), id = `source:${source.id}:${from}:${to}`
    records.push({ id, kind: 'source', scope: 'project', projectKey: source.projectKey, status: 'active',
      content, contentHash: hash(content), sourceHash: contentHash, revision: 1, confidence: 1, importance: .5,
      tags: [], observedAt: source.at, updatedAt: source.at, validFrom: null, validTo: null,
      evidenceRole: 'user', sourceRefs: [{ sourceId: source.id, sessionId: source.sessionId,
        messageId: source.messageId, role: 'user', sourceKind: 'user', from, to, at: source.at, excerpt: content }] })
    if (to === text.length) break
    from = Math.max(from + 1, to - 64)
    if (/[\uDC00-\uDFFF]/u.test(text[from])) from--
  }
  return records
}

export class SourcePassageIndex {
  #root
  #projects = new Map()
  constructor(root) { this.#root = root }
  #refresh(projectKey) {
    if (!isValidProjectKey(projectKey)) return null
    let cached = this.#projects.get(projectKey)
    if (!cached) {
      cached = { index: new MemoryIndex(), records: new Map(), sources: new Set(), stamp: null }
      this.#projects.set(projectKey, cached)
      if (this.#projects.size > 4) this.#projects.delete(this.#projects.keys().next().value)
    }
    let stamp
    try { const s = statSync(directory(this.#root, projectKey)); stamp = `${s.mtimeMs}:${s.ctimeMs}` }
    catch { stamp = 'absent' }
    if (cached.stamp === stamp) return cached
    // Grant creation is incremental. Existing source bytes are rechecked before use.
    let files = []
    try { files = readdirSync(directory(this.#root, projectKey)) } catch {}
    const present = new Set(files.filter(name => name.endsWith('.json') && sourcePattern.test(name.slice(0,-5))).map(name => name.slice(0,-5)))
    for (const [id, record] of cached.records) if (!present.has(record.sourceRefs[0].sourceId)) {
      cached.records.delete(id); cached.index.remove(id)
    }
    for (const id of present) {
      if (cached.sources.has(id)) continue
      const source = authorized(this.#root, id, projectKey)
      if (!source) continue
      for (const record of passages(source)) { cached.records.set(record.id, record); cached.index.upsert(record) }
    }
    cached.sources = present; cached.stamp = stamp
    return cached
  }
  validate(hit, projectKey) {
    return this.validateMany([hit], projectKey).length === 1
  }
  validateMany(hits, projectKey) {
    const sources = new Map(), valid = []
    for (const hit of Array.isArray(hits) ? hits : []) {
      const record = hit?.record ?? hit, ref = record?.sourceRefs?.[0]
      if (record?.scope !== 'project' || record.projectKey !== projectKey || record.kind !== 'source' ||
          !ref || !Number.isSafeInteger(ref.from) || !Number.isSafeInteger(ref.to) || ref.from < 0 || ref.to <= ref.from) continue
      if (!sources.has(ref.sourceId)) {
        const source = authorized(this.#root, ref.sourceId, projectKey)
        sources.set(ref.sourceId, source ? { source, hash: hash(source.text) } : null)
      }
      const verified = sources.get(ref.sourceId)
      if (!verified) continue
      const { source, hash: sourceHash } = verified
      if (record.id !== `source:${source.id}:${ref.from}:${ref.to}` || record.sourceHash !== sourceHash ||
          ref.to > source.text.length || source.text.slice(ref.from, ref.to) !== record.content ||
          record.contentHash !== hash(record.content)) continue
      valid.push(hit)
    }
    return valid
  }
  candidates(projectKey) {
    const cached = this.#refresh(projectKey)
    if (!cached) return []
    return [...cached.records.values()].filter(record => canReadSource(this.#root, record.sourceRefs[0].sourceId))
      .map(record => ({ record, score: 0, matched: [], termScores: [] }))
  }
  search(query, { projectKey, now = Date.now(), limit = 40 } = {}) {
    const cached = this.#refresh(projectKey)
    return cached ? this.validateMany(cached.index.search(query, {
      projectKey, scopes: ['project'], statuses: ['active'], now, limit,
    }), projectKey) : []
  }
}

/** Forgetting an original passage blocks its entire source, including extracted facts. */
export function forgetSourcePassage(root, id, projectKey, store, index) {
  const match = /^source:(src_[a-f0-9]{24}):\d+:\d+$/u.exec(id)
  if (!match || !authorized(root, match[1], projectKey, true)) return null
  blockSourceRecall(root, { sourceRefs: [{ sourceId: match[1] }] })
  for (const record of [...store.list('project', projectKey), ...store.list('global', null)]) {
    if (!record.sourceRefs?.some(ref => ref.sourceId === match[1])) continue
    store.remove(record.id, [{ scope: record.scope, projectKey: record.projectKey ?? null }]); index.remove(record.id)
  }
  for (const task of readCaptureTasks(root)) {
    if (task.projectKey !== projectKey || !task.sourceIds?.includes(match[1]) ||
        task.status !== 'pending' || task.callState !== 'not-sent') continue
    updateCaptureTask(root, task.id, { status: 'skipped', reason: '用户已遗忘该原始消息，未发送的提炼任务已撤销' })
  }
  return { id, status: 'deleted', revision: 1 }
}
