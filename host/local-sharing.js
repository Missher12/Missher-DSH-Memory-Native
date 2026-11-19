/** Local HTTP/MCP clients over the existing DSH authority. */
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createRecallReportStore } from './recall-reports.js'
import { createPanelBackend } from './remote.js'
import { deriveProjectBrief } from './project-brief.js'
import { isValidProjectKey } from './paths.js'
import { openMemoryRuntime } from './startup.js'
import { buildRecord, CONTENT_LIMITS, looksSensitive } from './records.js'
import { formatSceneBlock } from './scene-format.js'
import { canReadSource } from './capture-journal.js'
import { grantSourceRecall, hasSourceRecallGrant, isRecallSourceStatement, revokeSourceRecallGrant, SourcePassageIndex, withSourceRecallLock } from './source-passages.js'
import { saveSource, sourceIdOf } from './capture-journal.js'
import { analyzeUserMessageControls, explicitRememberText } from './user-controls.js'
import { clearLastUsersForSources } from './local-sharing-hook-state.js'
import { recallTimeIntent } from './recall.js'
import { directPassageEvidence, isSafeRecallRecord, slotEvidence } from './recall-flow.js'

const isProfileIdentity = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
const hash = value => createHash('sha256').update(value).digest('hex')

function readOwner(root) {
  const file = resolve(root, 'data-owner.json')
  const stat = lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('memory profile owner marker is not a regular file')
  const owner = JSON.parse(readFileSync(file, 'utf8'))
  if (owner?.version !== 1 || !['profile', 'explicit'].includes(owner.kind) || !isProfileIdentity(owner.identity)) {
    throw new Error('memory profile owner marker is invalid; service refused to open this data root')
  }
  return owner
}

function projectKeyOf(input, boundProjectKey) {
  const requested = input ?? boundProjectKey
  if (!isValidProjectKey(requested)) throw new TypeError('a valid project key is required')
  if (boundProjectKey !== null && requested !== boundProjectKey) throw new Error('request is outside the client bound project')
  return requested
}

function asResult(hit) {
  return { id: hit.record.id, revision: hit.record.revision, kind: hit.record.kind,
    scope: hit.record.scope, projectKey: hit.record.projectKey ?? null, content: hit.record.content,
    score: hit.score, verified: hit.record.unverifiedRecall !== true,
    sourceRefs: (hit.record.sourceRefs ?? []).map(ref => ({ ...ref })) }
}

function memoSegments(text) {
  const segments = []
  for (let from = 0; from < text.length;) {
    let to = Math.min(text.length, from + 420)
    if (to < text.length) {
      const tail = text.slice(from + 220, to)
      const matches = [...tail.matchAll(/[。！？.!?\n]/gu)]
      if (matches.length) to = from + 220 + matches.at(-1).index + 1
    }
    segments.push({ from, to, content: text.slice(from, to) })
    from = to
  }
  if (segments.length > 1 && segments.at(-1).content.length < CONTENT_LIMITS.min) {
    segments.at(-2).to = segments.at(-1).to
    segments.at(-2).content = text.slice(segments.at(-2).from, segments.at(-2).to)
    segments.pop()
  }
  return segments
}

function filteredRefs(refs, reports) {
  return reports.filterSourceRefs(refs ?? []).map(ref => ({ ...ref }))
}

function authorizedSourceProjects(root) {
  const grantRoot = join(root, 'capture', 'recall-grants')
  const sourceRoot = join(root, 'capture', 'sources')
  let projects = []
  try { projects = readdirSync(grantRoot, { withFileTypes: true }) } catch (error) { if (error?.code !== 'ENOENT') throw error }
  const found = []
  for (const project of projects) {
    if (!project.isDirectory() || !isValidProjectKey(project.name)) continue
    let grants = []
    try { grants = readdirSync(join(grantRoot, project.name)) } catch { continue }
    for (const name of grants) {
      const sourceId = /^src_[a-f0-9]{24}\.json$/u.test(name) ? name.slice(0, -5) : null
      if (!sourceId) continue
      try {
        const grant = JSON.parse(readFileSync(join(grantRoot, project.name, name), 'utf8'))
        const metadataFile = join(sourceRoot, `${sourceId}.json`)
        const stat = lstatSync(metadataFile)
        if (!stat.isFile() || stat.isSymbolicLink()) continue
        const metadata = JSON.parse(readFileSync(metadataFile, 'utf8'))
        if (grant.version === 1 && grant.sourceId === sourceId && grant.projectKey === project.name &&
            typeof grant.textHash === 'string' && metadata.id === sourceId && metadata.projectKey === project.name &&
            metadata.textHash === grant.textHash && metadata.role === 'user' && metadata.sourceKind === 'user' &&
            canReadSource(root, sourceId)) {
          found.push(project.name)
          break
        }
      } catch { /* Missing, revoked, or malformed source grants do not expose a project. */ }
    }
  }
  return found
}

/**
 * Compose independent local clients over the same JSONL/L0 profile used by DSH.
 * A projectKey makes an MCP process permanently project-bound; the browser
 * process may inspect any validated project after authenticating as admin.
 */
export function createLocalSharingService({ root, profileIdentity = null, projectKey = null, clock = () => Date.now() }) {
  const dataRoot = resolve(root)
  const owner = readOwner(dataRoot)
  if (profileIdentity !== null && owner.identity !== profileIdentity) {
    throw new Error('configured profile identity does not match this memory root')
  }
  if (projectKey !== null && !isValidProjectKey(projectKey)) throw new TypeError('bound project key is invalid')
  const identity = profileIdentity ?? owner.identity
  const reports = createRecallReportStore(dataRoot, identity)
  const runtime = openMemoryRuntime({ root: dataRoot, clock,
    onRecallRevoke: targets => reports.invalidateReferences(targets) })
  const passages = new SourcePassageIndex(dataRoot)
  const panel = createPanelBackend({ store: runtime.store, index: runtime.index, root: dataRoot,
    config: {}, invalidateRecallReferences: targets => reports.invalidateReferences(targets) })

  function assertProject(input) { return projectKeyOf(input, projectKey) }
  function refresh(key) {
    runtime.refreshScope('global', null)
    runtime.refreshScope('project', key)
  }
  function recordsFor(key) {
    refresh(key)
    return runtime.store.list('project', key)
  }

  function saveRemembered({ text, remembered, client, sessionId, messageId, key }) {
    if (typeof text !== 'string' || text.length > 20_000) throw new TypeError('original user message is required')
    if (looksSensitive(text) || analyzeUserMessageControls(text).noSaveDirective) {
      throw new Error('the user message is private or contains likely credentials')
    }
    if (typeof remembered !== 'string' || !isRecallSourceStatement(remembered)) {
      throw new Error('remembered content is not an eligible user statement')
    }
    if (remembered.length < CONTENT_LIMITS.min || remembered.length > 20_000) {
      throw new TypeError(`remembered content must contain ${CONTENT_LIMITS.min}-20000 characters`)
    }
    if (typeof sessionId !== 'string' || sessionId.trim() === '' || sessionId.length > 160) {
      throw new TypeError('client session id is required')
    }
    const clientName = String(client).trim().slice(0, 40)
    if (!/^[a-z0-9._-]+$/iu.test(clientName)) throw new TypeError('client name is invalid')
    const sourceSession = `${clientName}:${sessionId}`
    const at = clock()
    const memoOffset = text.indexOf(remembered)
    if (memoOffset < 0) throw new Error('remembered text could not be bound to the original user message')
    const chunks = memoSegments(remembered)
    const sourceInput = { sessionId: sourceSession, messageId, role: 'user', sourceKind: 'user',
      sourceForm: clientName, projectKey: key, text, at }
    const sourceId = sourceIdOf(sourceInput)
    return withSourceRecallLock(dataRoot, sourceId, () => {
      const grantAlreadyExisted = hasSourceRecallGrant(dataRoot, sourceId, key)
      const records = chunks.map((chunk, index) => {
        const id = `mem_${hash(`${key}\0${sourceId}\0${index}`).slice(0, 24)}`
        const from = memoOffset + chunk.from
        const to = Math.min(text.length, from + Math.min(240, chunk.content.length))
        const excerpt = text.slice(from, to)
        const built = buildRecord({ kind: 'fact', scope: 'project', projectKey: key, content: chunk.content,
          tags: ['explicit-memory'], confidence: 1, importance: .85, evidenceRole: 'user',
          sourceRefs: [{ sourceId, sessionId: sourceSession, messageId, role: 'user',
            sourceKind: 'user', sourceForm: clientName, at, from, to, excerpt }] }, { id, now: at })
        if (!built.ok) throw new Error(built.reason)
        return built.record
      })
      const source = saveSource(dataRoot, sourceInput)
      if (source.projectKey !== key) throw new Error('source belongs to a different project')
      const sourceForGrant = { ...source, projectKey: key, role: 'user', sourceKind: 'user', sourceForm: clientName, text }
      if (!grantSourceRecall(dataRoot, sourceForGrant, key, { remembered: true, locked: true })) {
        throw new Error('original message did not pass the source authorization checks')
      }
      let saved
      try { saved = runtime.store.appendBatch(records) }
      catch (error) {
        if (!grantAlreadyExisted) {
          try { revokeSourceRecallGrant(dataRoot, source.id, key, { locked: true }) }
          catch (revokeError) { error.revokeFailed = revokeError?.code ?? revokeError?.message ?? 'unknown' }
        }
        throw error
      }
      const results = saved.map(record => asResult({ record, score: 0 }))
      return { ...results[0], records: results, sourceId: source.id, originalChars: text.length }
    })
  }

  return {
    root: dataRoot,
    profileIdentity: identity,
    projectKey,
    reports,
    projects() { return [...new Set([...runtime.store.listProjects(), ...authorizedSourceProjects(dataRoot), ...reports.listProjects()])].sort() },
    list(input = {}) {
      const key = assertProject(input.projectKey)
      refresh(key)
      return panel.list({ ...input, scope: 'project', projectKey: key })
    },
    brief(input = {}) {
      const key = assertProject(input.projectKey)
      refresh(key)
      const brief = deriveProjectBrief(runtime.store, { ...input, projectKey: key, now: clock() })
      for (const section of brief.sections) for (const item of section.items) item.sourceRefs = filteredRefs(item.sourceRefs, reports)
      return brief
    },
    scenes(input = {}) {
      const key = assertProject(input.projectKey)
      const records = recordsFor(key)
      const groups = new Map()
      for (const record of records) {
        if (record.status !== 'active' && record.status !== 'candidate') continue
        const name = record.topic || record.tags?.[0] || record.kind
        if (!groups.has(name)) groups.set(name, [])
        groups.get(name).push(record)
      }
      return [...groups].map(([name, items]) => {
        const timestamp = values => values.length ? new Date(values.reduce((min, value) => Math.min(min, value), Infinity)).toISOString() : ''
        const updated = values => values.length ? new Date(values.reduce((max, value) => Math.max(max, value), -Infinity)).toISOString() : ''
        const createdAt = items.map(record => record.createdAt).filter(Number.isFinite)
        const updatedAt = items.map(record => record.updatedAt).filter(Number.isFinite)
        const summary = `${name} · ${items.length} 条现有记忆`
        const content = items.map(record => `- [${record.id}@${record.revision}] ${record.content}`).join('\n')
        const meta = { created: timestamp(createdAt), updated: updated(updatedAt), summary, heat: Math.min(100, items.length) }
        const filename = `${hash(`${key}\0${name}`).slice(0, 20)}.md`
        return { filename, title: name, meta, content, records: items.map(record => ({ id: record.id,
          revision: record.revision, sourceRefs: filteredRefs(record.sourceRefs, reports) })),
          text: formatSceneBlock(meta, content) }
      })
    },
    coreRules() {
      runtime.refreshScope('global', null)
      return runtime.store.list('global', null).filter(record => record.status === 'active' &&
        (record.kind === 'preference' || record.kind === 'decision')).map(record => ({
        id: record.id, revision: record.revision, kind: record.kind, content: record.content,
        sourceRefs: filteredRefs(record.sourceRefs, reports),
      }))
    },
    search(query, requestedProjectKey, limit = 12, recall = null) {
      const key = assertProject(requestedProjectKey)
      if (typeof query !== 'string' || query.trim() === '' || query.length > 1000) throw new TypeError('query must contain 1-1000 characters')
      if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new TypeError('limit must be from 1 to 50')
      refresh(key)
      const now = clock()
      const timeIntent = recall ? recallTimeIntent(query, now) : null
      const historical = timeIntent !== null && timeIntent.kind !== 'current'
      const fetchLimit = recall ? 40 : limit
      const memoryHits = runtime.index.search(query, { projectKey: key, scopes: ['project', 'global'],
        statuses: historical ? ['active', 'superseded'] : ['active'], includeExpired: historical, now, limit: fetchLimit })
      const sourceHits = historical ? [] : passages.search(query, { projectKey: key, now, limit: fetchLimit })
      const unique = new Map()
      for (const hit of [...memoryHits, ...sourceHits]) unique.set(hit.record.id, hit)
      const hits = []
      const slot = recall ? { ...recall.slot, query, timeIntent } : null
      for (const hit of [...unique.values()].sort((a, b) => b.score - a.score)) {
        if (hits.length >= limit) break
        if (slot && (!isSafeRecallRecord(hit.record, key, timeIntent, now) ||
            (hit.record.kind === 'source' ? !directPassageEvidence(slot, hit, recall.hasSubquestions)
              : slotEvidence(slot, [hit], recall.hasSubquestions).length === 0))) continue
        const sourceRefs = filteredRefs(hit.record.sourceRefs, reports)
        if (hit.record.kind === 'source' && sourceRefs.length === 0) continue
        hits.push({ ...asResult(hit), sourceRefs })
      }
      return { projectKey: key, query, hits }
    },
    recentReports(requestedProjectKey, limit = 20, offset = 0) {
      const key = assertProject(requestedProjectKey)
      return reports.listRecent(key, limit, offset)
    },
    remember({ text, client = 'local', sessionId, messageId = null, requestedProjectKey } = {}) {
      const key = assertProject(requestedProjectKey)
      const remembered = explicitRememberText(text)
      if (remembered === null) throw new Error('only a clear user message that explicitly says to remember its content can be saved')
      return saveRemembered({ text, remembered, client, sessionId, messageId, key })
    },
    rememberPrevious({ text, client = 'local', sessionId, messageId = null, requestedProjectKey } = {}) {
      const key = assertProject(requestedProjectKey)
      if (typeof text !== 'string' || text.length > 20_000 || !isRecallSourceStatement(text)) {
        throw new Error('the previous user message is not eligible to remember')
      }
      return saveRemembered({ text, remembered: text, client, sessionId, messageId, key })
    },
    forget(id, requestedProjectKey) {
      const key = assertProject(requestedProjectKey)
      if (typeof id !== 'string' || id.trim() === '') throw new TypeError('memory id is required')
      refresh(key)
      const current = runtime.store.find(id.trim(), [{ scope: 'project', projectKey: key }])
      const result = panel.removeMemory({ id: id.trim(), scope: 'project', projectKey: key })
      const sourceTarget = /^source:(src_[a-f0-9]{24}):/u.exec(id.trim())?.[1]
      const sourceIds = [...new Set([...(current?.sourceRefs ?? []).map(ref => ref?.sourceId), sourceTarget]
        .filter(value => typeof value === 'string'))]
      clearLastUsersForSources(dataRoot, sourceIds)
      return result
    },
    close() { runtime.dispose() },
  }
}
