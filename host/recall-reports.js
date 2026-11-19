/** Per-profile final recall reports; this directory is deliberately outside backup and export roots. */
import { createHash } from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWritePrivate, syncDirectory, withFileLock } from './persistence.js'
import { isValidProjectKey } from './paths.js'

const VERSION = 1
const MAX_REPORT_BYTES = 8 * 1024 * 1024
const INVALIDATED_FILE = 'invalidated-references.json'
const SESSION_INDEX_FILE = 'sessions-index.json'
const SESSION_INDEX_DIRTY_FILE = '.sessions-index-dirty'
const sessionKey = id => createHash('sha256').update(id).digest('hex')
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const uniqueStrings = values => [...new Set(values && typeof values[Symbol.iterator] === 'function' && typeof values !== 'string'
  ? [...values].filter(value => typeof value === 'string' && value !== '') : [])]
function uniqueRecordRevisions(values) {
  const revisions = new Map()
  const entries = values instanceof Map
    ? [...values].flatMap(([id, versions]) => [...versions].map(revision => ({ id, revision })))
    : values ?? []
  for (const value of entries) {
    if (!isObject(value) || typeof value.id !== 'string' || value.id === '' || !Number.isSafeInteger(value.revision) || value.revision < 1) continue
    if (!revisions.has(value.id)) revisions.set(value.id, new Set())
    revisions.get(value.id).add(value.revision)
  }
  return [...revisions].flatMap(([id, versions]) => [...versions].map(revision => ({ id, revision })))
}

export function recallReportSessionKey(sessionId) {
  return typeof sessionId === 'string' && sessionId !== '' ? sessionKey(sessionId) : null
}

export function recallReportReferences(report, { recordIds = [], recordRevisions = [], sourceIds = [] } = {}) {
  const records = new Set(uniqueStrings(recordIds))
  const sources = new Set(uniqueStrings(sourceIds))
  const revisions = new Map()
  for (const value of uniqueRecordRevisions(recordRevisions)) {
    if (!revisions.has(value.id)) revisions.set(value.id, new Set())
    revisions.get(value.id).add(value.revision)
  }
  if (records.size === 0 && revisions.size === 0 && sources.size === 0) return false
  const visit = value => {
    if (Array.isArray(value)) return value.some(visit)
    if (!isObject(value)) return false
    if (typeof value.id === 'string' && (records.has(value.id) || revisions.get(value.id)?.has(value.revision))) return true
    for (const [key, nested] of Object.entries(value)) {
      if (key === 'id' && typeof nested === 'string' && records.has(nested)) return true
      if (key === 'sourceId' && typeof nested === 'string' && sources.has(nested)) return true
      if (visit(nested)) return true
    }
    return false
  }
  return visit(report)
}

function finalizedReport(report) {
  const evidence = (item, injected = false) => isObject(item) && typeof item.id === 'string' &&
    Number.isSafeInteger(item.revision) && item.revision > 0 &&
    Array.isArray(item.sourceRefs) && item.sourceRefs.every(ref => isObject(ref) &&
      (ref.sourceId === undefined || ref.sourceId === null || typeof ref.sourceId === 'string')) &&
    (!injected || typeof item.text === 'string')
  const question = item => isObject(item) && typeof item.query === 'string' &&
    Array.isArray(item.hits) && item.hits.every(value => evidence(value)) &&
    Array.isArray(item.injected) && item.injected.every(value => evidence(value, true)) &&
    Array.isArray(item.notInjected) && item.notInjected.every(value => evidence(value)) &&
    typeof item.answerCoverage === 'string' && (item.answerExcerpt === null || typeof item.answerExcerpt === 'string')
  return isObject(report) && isValidProjectKey(report.projectKey) &&
    (report.outcome === 'completed' || report.outcome === 'aborted') &&
    Array.isArray(report.questions) && report.questions.length <= 64 &&
    report.questions.every(question) &&
    (report.localDeepRecall == null || isObject(report.localDeepRecall) && Array.isArray(report.localDeepRecall.queries) &&
      Number.isFinite(report.localDeepRecall.tokens) && Number.isFinite(report.localDeepRecall.limit))
}

function pendingReport(report) {
  return isObject(report) && report.outcome === 'pending' &&
    report.questions?.every(question => question.answerCoverage === 'pending' && question.answerExcerpt === null) === true &&
    finalizedReport({ ...report, outcome: 'completed' })
}

function validReport(report) { return finalizedReport(report) || pendingReport(report) }

function validEnvelope(value, expectedKey, profileIdentity) {
  return isObject(value) && value.version === VERSION && value.sessionKey === expectedKey &&
    value.profileIdentity === profileIdentity && isValidProjectKey(value.projectKey) &&
    validReport(value.report) && value.report.projectKey === value.projectKey
}

function readTombstones(file) {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'))
    if (!isObject(value) || value.version !== VERSION || !Array.isArray(value.recordIds) || !Array.isArray(value.sourceIds) ||
        !value.recordIds.every(id => typeof id === 'string') || !value.sourceIds.every(id => typeof id === 'string') ||
        value.recordRevisions !== undefined && (!Array.isArray(value.recordRevisions) ||
          !value.recordRevisions.every(item => isObject(item) && typeof item.id === 'string' && Number.isSafeInteger(item.revision) && item.revision > 0))) {
      throw new Error('recall report invalidation data is malformed')
    }
    const recordRevisions = new Map()
    for (const { id, revision } of value.recordRevisions ?? []) {
      if (!recordRevisions.has(id)) recordRevisions.set(id, new Set())
      recordRevisions.get(id).add(revision)
    }
    return { recordIds: new Set(value.recordIds), recordRevisions, sourceIds: new Set(value.sourceIds) }
  } catch (error) {
    if (error?.code === 'ENOENT') return { recordIds: new Set(), recordRevisions: new Map(), sourceIds: new Set() }
    throw error
  }
}

function envelopeMatches(value, expectedKey, profileIdentity) {
  return validEnvelope(value, expectedKey, profileIdentity)
}

function readSessionIndex(file) {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'))
    if (!isObject(value) || value.version !== VERSION || !Array.isArray(value.sessions) ||
        !value.sessions.every(item => isObject(item) && /^[a-f0-9]{64}$/u.test(item.sessionKey) &&
          isValidProjectKey(item.projectKey) && Number.isFinite(item.at))) throw new Error('recall report index is malformed')
    return value.sessions
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
}

export function createRecallReportStore(root, profileIdentity) {
  const directory = join(root, 'recall-reports')
  const lockFile = join(directory, '.reports.lock')
  const tombstoneFile = join(directory, INVALIDATED_FILE)
  const sessionIndexFile = join(directory, SESSION_INDEX_FILE)
  const sessionIndexDirtyFile = join(directory, SESSION_INDEX_DIRTY_FILE)
  const cache = new Map()
  const sessionStamps = new Map()
  let invalidated = { recordIds: new Set(), recordRevisions: new Map(), sourceIds: new Set() }
  let invalidationStamp = null

  function ensureDirectory() {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    chmodSync(directory, 0o700)
  }

  function refreshInvalidations() {
    let stamp
    try {
      const stat = statSync(tombstoneFile, { bigint: true })
      stamp = [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':')
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      stamp = 'absent'
    }
    if (stamp === invalidationStamp) return
    invalidated = readTombstones(tombstoneFile)
    invalidationStamp = stamp
    for (const [key, value] of cache) {
      if (value && recallReportReferences(value.report, invalidated)) cache.set(key, null)
    }
  }

  function sessionIndexDirty() {
    try {
      const stat = lstatSync(sessionIndexDirtyFile)
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('recall report index marker is not a regular file')
      return true
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      return false
    }
  }

  function clearSessionIndexDirty() {
    try { unlinkSync(sessionIndexDirtyFile) }
    catch (error) { if (error?.code !== 'ENOENT') return }
  }

  /** Caller holds the report lock. A dirty marker makes this the one repair scan. */
  function rebuildSessionIndexLocked() {
    refreshInvalidations()
    const sessions = []
    for (const name of readdirSync(directory)) {
      if (!/^[a-f0-9]{64}\.json$/u.test(name)) continue
      const file = join(directory, name), key = name.slice(0, -5)
      let stat
      try { stat = lstatSync(file) }
      catch (error) { if (error?.code === 'ENOENT') continue; throw error }
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_REPORT_BYTES) continue
      let serialized
      try { serialized = readFileSync(file, 'utf8') }
      catch (error) { if (error?.code === 'ENOENT') continue; throw error }
      let value
      try { value = JSON.parse(serialized) }
      catch { continue }
      if (validEnvelope(value, key, profileIdentity) && !recallReportReferences(value.report, invalidated)) {
        sessions.push({ sessionKey: key, projectKey: value.projectKey,
          at: Number.isFinite(value.report.at) ? value.report.at : stat.mtimeMs })
      }
    }
    sessions.sort((left, right) => right.at - left.at)
    atomicWritePrivate(sessionIndexFile, `${JSON.stringify({ version: VERSION, sessions })}\n`)
    clearSessionIndexDirty()
    return sessions
  }

  function readSessionIndexIfPresent() {
    let stat
    try { stat = lstatSync(sessionIndexFile) }
    catch (error) { if (error?.code === 'ENOENT') return null; throw error }
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('recall report index is not a regular file')
    try { return readSessionIndex(sessionIndexFile) }
    catch (error) {
      if (error instanceof SyntaxError || error?.message === 'recall report index is malformed') return null
      throw error
    }
  }

  function ensureSessionIndex() {
    ensureDirectory()
    if (!sessionIndexDirty()) {
      const existing = readSessionIndexIfPresent()
      if (existing !== null) return existing
    }
    return withFileLock(lockFile, () => {
      if (!sessionIndexDirty()) {
        const existing = readSessionIndexIfPresent()
        if (existing !== null) return existing
      }
      return rebuildSessionIndexLocked()
    })
  }

  function readSession(key) {
    refreshInvalidations()
    const file = join(directory, `${key}.json`)
    let stamp
    try {
      const stat = lstatSync(file, { bigint: true })
      stamp = stat.isFile() && !stat.isSymbolicLink()
        ? [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':') : 'unsupported'
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      stamp = 'absent'
    }
    if (cache.has(key) && sessionStamps.get(key) === stamp) return cache.get(key)
    let value = null
    try {
      const stat = lstatSync(file)
      if (stat.isFile() && !stat.isSymbolicLink() && stat.size <= MAX_REPORT_BYTES) {
        const parsed = JSON.parse(readFileSync(file, 'utf8'))
        if (validEnvelope(parsed, key, profileIdentity) && !recallReportReferences(parsed.report, invalidated)) value = parsed
      }
    } catch { /* Missing and corrupt reports both memoize as absent. */ }
    cache.set(key, value)
    sessionStamps.set(key, stamp)
    return value
  }

  function persistReport(sessionId, projectKey, report, pending = false) {
    const key = recallReportSessionKey(sessionId)
    const value = pending ? { ...report, outcome: 'pending' } : report
    const valid = pending ? pendingReport(value) : finalizedReport(value)
    if (key === null || !isValidProjectKey(projectKey) || !valid || value.projectKey !== projectKey) {
      throw new Error(pending
        ? 'pending report must be bound to its session project and contain no answer excerpt'
        : 'only a finalized report bound to its session project can be persisted')
    }
    const envelope = { version: VERSION, sessionKey: key, profileIdentity, projectKey, report: value }
    const serialized = `${JSON.stringify(envelope)}\n`
    if (Buffer.byteLength(serialized) > MAX_REPORT_BYTES) throw new Error('recall report exceeds the storage limit')
    ensureDirectory()
    return withFileLock(lockFile, () => {
      refreshInvalidations()
      if (sessionIndexDirty() || readSessionIndexIfPresent() === null) rebuildSessionIndexLocked()
      if (recallReportReferences(value, invalidated)) {
        cache.set(key, null)
        return false
      }
      if (!sessionIndexDirty()) atomicWritePrivate(sessionIndexDirtyFile, `${JSON.stringify({ version: VERSION })}\n`)
      atomicWritePrivate(join(directory, `${key}.json`), serialized)
      let sessions = readSessionIndexIfPresent()
      if (sessions === null) sessions = rebuildSessionIndexLocked()
      else {
        sessions = sessions.filter(item => item.sessionKey !== key)
        sessions.push({ sessionKey: key, projectKey, at: typeof value.at === 'number' ? value.at : Date.now() })
        sessions.sort((left, right) => right.at - left.at)
        atomicWritePrivate(sessionIndexFile, `${JSON.stringify({ version: VERSION, sessions })}\n`)
        clearSessionIndexDirty()
      }
      cache.set(key, envelope)
      sessionStamps.delete(key)
      return true
    })
  }

  return {
    isInvalidated(report) {
      try {
        refreshInvalidations()
        return recallReportReferences(report, invalidated)
      } catch { return true }
    },

    filterSourceRefs(sourceRefs) {
      try { refreshInvalidations() } catch { return [] }
      if (!Array.isArray(sourceRefs)) return []
      return sourceRefs.filter(ref => !isObject(ref) || typeof ref.sourceId !== 'string' || !invalidated.sourceIds.has(ref.sourceId))
    },

    get(sessionId, projectKey) {
      const key = recallReportSessionKey(sessionId)
      if (key === null || !isValidProjectKey(projectKey)) return null
      let value
      try { value = readSession(key) } catch { return null }
      return value?.projectKey === projectKey ? value.report : null
    },

    has(sessionId) {
      const key = recallReportSessionKey(sessionId)
      if (key === null) return false
      try { return readSession(key) !== null } catch { return false }
    },

    listRecent(projectKey, limit = 20, offset = 0) {
      if (!isValidProjectKey(projectKey) || !Number.isInteger(limit) || limit < 1 || limit > 100 ||
          !Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000) return []
      let entries
      try { refreshInvalidations(); entries = ensureSessionIndex() } catch { return [] }
      return entries.filter(item => item.projectKey === projectKey).sort((a, b) => b.at - a.at).slice(offset, offset + limit)
        .flatMap(item => {
          try {
            const file = join(directory, `${item.sessionKey}.json`)
            const stat = lstatSync(file)
            if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_REPORT_BYTES) return []
            const value = JSON.parse(readFileSync(file, 'utf8'))
            if (!validEnvelope(value, item.sessionKey, profileIdentity) || value.projectKey !== projectKey ||
                recallReportReferences(value.report, invalidated)) return []
            return [{ sessionKey: item.sessionKey, projectKey, at: item.at, report: value.report }]
          } catch { return [] }
        })
    },

    listProjects() {
      let entries
      try { refreshInvalidations(); entries = ensureSessionIndex() } catch { return [] }
      return [...new Set(entries.map(item => item.projectKey))].filter(key => this.listRecent(key, 1).length > 0)
    },

    write(sessionId, projectKey, report) {
      return persistReport(sessionId, projectKey, report)
    },

    writePending(sessionId, projectKey, report) {
      return persistReport(sessionId, projectKey, report, true)
    },

    invalidateReferences({ recordIds = [], recordRevisions = [], sourceIds = [] } = {}) {
      const targets = { recordIds: uniqueStrings(recordIds), recordRevisions: uniqueRecordRevisions(recordRevisions), sourceIds: uniqueStrings(sourceIds) }
      if (targets.recordIds.length === 0 && targets.recordRevisions.length === 0 && targets.sourceIds.length === 0) return new Set()
      ensureDirectory()
      ensureSessionIndex()
      return withFileLock(lockFile, () => {
        refreshInvalidations()
        for (const id of targets.recordIds) invalidated.recordIds.add(id)
        for (const { id, revision } of targets.recordRevisions) {
          if (!invalidated.recordRevisions.has(id)) invalidated.recordRevisions.set(id, new Set())
          invalidated.recordRevisions.get(id).add(revision)
        }
        for (const id of targets.sourceIds) invalidated.sourceIds.add(id)
        atomicWritePrivate(tombstoneFile, `${JSON.stringify({
          version: VERSION,
          recordIds: [...invalidated.recordIds],
          recordRevisions: [...invalidated.recordRevisions].flatMap(([id, versions]) => [...versions].map(revision => ({ id, revision }))),
          sourceIds: [...invalidated.sourceIds],
        })}\n`)
        invalidationStamp = null
        refreshInvalidations()

        const removed = new Set()
        for (const name of readdirSync(directory)) {
          if (!name.endsWith('.json') || name === INVALIDATED_FILE || name === SESSION_INDEX_FILE) continue
          const key = name.slice(0, -5)
          const file = join(directory, name)
          const stat = lstatSync(file)
          if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('recall report directory contains an unsupported entry')
          let envelope
          try {
            if (stat.size <= MAX_REPORT_BYTES) envelope = JSON.parse(readFileSync(file, 'utf8'))
          } catch { /* Unknown reports are deleted conservatively during a forget operation. */ }
          if (!/^[a-f0-9]{64}$/u.test(key) || !envelopeMatches(envelope, key, profileIdentity) ||
              recallReportReferences(envelope.report, targets)) {
            unlinkSync(file)
            removed.add(key)
            cache.set(key, null)
            sessionStamps.delete(key)
          }
        }
        if (removed.size > 0) {
          const sessions = readSessionIndex(sessionIndexFile).filter(item => !removed.has(item.sessionKey))
          atomicWritePrivate(sessionIndexFile, `${JSON.stringify({ version: VERSION, sessions })}\n`)
        }
        if (removed.size > 0) syncDirectory(directory)
        return removed
      })
    },
  }
}
