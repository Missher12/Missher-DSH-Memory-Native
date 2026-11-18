/** Per-profile final recall reports; this directory is deliberately outside backup and export roots. */
import { createHash } from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWritePrivate, syncDirectory, withFileLock } from './persistence.js'
import { isValidProjectKey } from './paths.js'

const VERSION = 1
const MAX_REPORT_BYTES = 8 * 1024 * 1024
const INVALIDATED_FILE = 'invalidated-references.json'
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

function validEnvelope(value, expectedKey, profileIdentity) {
  return isObject(value) && value.version === VERSION && value.sessionKey === expectedKey &&
    value.profileIdentity === profileIdentity && isValidProjectKey(value.projectKey) &&
    finalizedReport(value.report) && value.report.projectKey === value.projectKey
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

export function createRecallReportStore(root, profileIdentity) {
  const directory = join(root, 'recall-reports')
  const lockFile = join(directory, '.reports.lock')
  const tombstoneFile = join(directory, INVALIDATED_FILE)
  const cache = new Map()
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

  function readSession(key) {
    refreshInvalidations()
    if (cache.has(key)) return cache.get(key)
    let value = null
    try {
      const file = join(directory, `${key}.json`)
      const stat = lstatSync(file)
      if (stat.isFile() && !stat.isSymbolicLink() && stat.size <= MAX_REPORT_BYTES) {
        const parsed = JSON.parse(readFileSync(file, 'utf8'))
        if (validEnvelope(parsed, key, profileIdentity) && !recallReportReferences(parsed.report, invalidated)) value = parsed
      }
    } catch { /* Missing and corrupt reports both memoize as absent. */ }
    cache.set(key, value)
    return value
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

    write(sessionId, projectKey, report) {
      const key = recallReportSessionKey(sessionId)
      if (key === null || !isValidProjectKey(projectKey) || !finalizedReport(report) || report.projectKey !== projectKey) {
        throw new Error('only a finalized report bound to its session project can be persisted')
      }
      const envelope = { version: VERSION, sessionKey: key, profileIdentity, projectKey, report }
      const serialized = `${JSON.stringify(envelope)}\n`
      if (Buffer.byteLength(serialized) > MAX_REPORT_BYTES) throw new Error('recall report exceeds the storage limit')
      ensureDirectory()
      return withFileLock(lockFile, () => {
        refreshInvalidations()
        if (recallReportReferences(report, invalidated)) {
          cache.set(key, null)
          return false
        }
        atomicWritePrivate(join(directory, `${key}.json`), serialized)
        cache.set(key, envelope)
        return true
      })
    },

    invalidateReferences({ recordIds = [], recordRevisions = [], sourceIds = [] } = {}) {
      const targets = { recordIds: uniqueStrings(recordIds), recordRevisions: uniqueRecordRevisions(recordRevisions), sourceIds: uniqueStrings(sourceIds) }
      if (targets.recordIds.length === 0 && targets.recordRevisions.length === 0 && targets.sourceIds.length === 0) return new Set()
      ensureDirectory()
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
          if (!name.endsWith('.json') || name === INVALIDATED_FILE) continue
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
          }
        }
        if (removed.size > 0) syncDirectory(directory)
        return removed
      })
    },
  }
}
