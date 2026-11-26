/** Carry forward deletion evidence without copying newer memory content into an old snapshot. */
import { createHash, randomUUID } from 'node:crypto'
import { linkSync, lstatSync, readFileSync, readdirSync, realpathSync, unlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { readAuthorityIntent } from './authority-intent.js'
import { blockSourceRecall, CAPTURE_DIR, discardTurnSources, noSaveSourceIds, readTurnIntakes,
  retireRestoredCaptureTasks, TURNS_FILE } from './capture-journal.js'
import { scopePaths } from './paths.js'
import { atomicWritePrivate, syncDirectory, withFileLock } from './persistence.js'
import { invalidateStoredRecallReports, legacyPurgedScopes } from './recall-reports.js'
import { buildRecord, isValidMemoryId, nextRevision } from './records.js'
import { readDataOwner } from './storage-boundary.js'
import { fileStamp, latestRevisions, MemoryStore, PURGED_IDS_FILE, readJsonl } from './store.js'
import { isNoteDigest, memoryNoteDigests, readPurgedNoteDigests, writePurgedNoteDigests } from './obsidian-note.js'
import { mergeRevocations, PERMANENT_REVISION, readRevocationLedger, retainRevocations, revocationKey,
  validRevocation, validSourceId } from './revocation-ledger.js'

const FORMAT = 'dsh-memory-revocations'
const MAX_RECEIPT_BYTES = 128 * 1024 * 1024
const sha256 = text => createHash('sha256').update(text).digest('hex')
const validId = value => typeof value === 'string' && value !== ''
const validArray = (value, check) => Array.isArray(value) && value.every(check)
const scopesOf = store => [['global', null], ...store.listProjects().map(key => ['project', key])]
const sourceDirectory = root => join(root, CAPTURE_DIR, 'sources')

function entries(dir) {
  try { return readdirSync(dir, { withFileTypes: true }) }
  catch (error) { if (error?.code === 'ENOENT') return []; throw error }
}

function ownersMatch(current, saved, currentRoot, backup) {
  if (current.identity !== saved.identity || current.kind !== saved.kind) return false
  // Standalone roots have no unique profile identity. Use their original backup location.
  return current.kind === 'profile' || realpathSync(dirname(backup)) === realpathSync(join(currentRoot, 'backups'))
}

function collectRevocations(root) {
  if (readAuthorityIntent(root)) throw new Error('当前目录有未完成的记忆写入，请先恢复该次写入再试。')
  const store = new MemoryStore({ root })
  const { records, deniedSources } = readRevocationLedger(root)
  const purgedIds = store.purgedIds()
  const needsScope = new Set(purgedIds)
  for (const row of records.values()) if (row.revision === PERMANENT_REVISION) needsScope.delete(row.id)
  if (needsScope.size) mergeRevocations(records,legacyPurgedScopes(root,needsScope,PERMANENT_REVISION))
  for (const [scope, projectKey] of scopesOf(store)) {
    const { records: revisions, corrupt } = readJsonl(scopePaths(root, scope, projectKey).file, root)
    if (corrupt) throw new Error('记忆文件有未确认的修订，尚不能安全保留撤权状态。')
    for (const row of revisions) {
      if (row.status !== 'deleted') continue
      const at = Number.isSafeInteger(row.updatedAt) && row.updatedAt >= 0 ? row.updatedAt : 0
      mergeRevocations(records, [{ id:row.id, projectKey, revision:row.revision, at }])
    }
  }
  const turnsFile = join(root, CAPTURE_DIR, TURNS_FILE)
  const sourceDir = sourceDirectory(root)
  const turnsStamp = fileStamp(turnsFile), sourceStamp = fileStamp(sourceDir)
  const sources = []
  for (const entry of entries(sourceDir)) {
    const match = /^(src_[a-f0-9]{24})\.recall-blocked$/u.exec(entry.name)
    if (match && entry.isFile()) sources.push(match[1])
  }
  const turns = readTurnIntakes(root)
  if (turns.corrupt || turnsStamp !== fileStamp(turnsFile) || sourceStamp !== fileStamp(sourceDir)) {
    throw new Error('原文的撤权记录正在变化或已损坏，请核对后重试。')
  }
  for (const id of noSaveSourceIds(turns.intakes)) if (validSourceId(id)) deniedSources.add(id)
  return { records:[...records.values()], purgedIds:[...purgedIds], blockedSources:sources,
    deniedSources:[...deniedSources], purgedNotes:[...readPurgedNoteDigests(root)]
      .filter(([id]) => purgedIds.has(id)).map(([id, hashes]) => [id, [...hashes]]) }
}

export function exportRevocations(currentRoot, target) {
  const root = resolve(currentRoot), output = resolve(target)
  const data = withFileLock(join(root,'.write.lock'), () => {
    const owner = readDataOwner(root)
    if (owner.kind !== 'profile') throw new Error('独立目录没有可携带的 DSH profile 身份，请在原目录使用 --current-root 恢复。')
    return { profile:owner.identity, ...collectRevocations(root) }
  })
  checkReceiptData(data)
  const envelope = { format:FORMAT, version:1, data, sha256:sha256(JSON.stringify(data)) }
  const text = JSON.stringify(envelope) + '\n'
  if (Buffer.byteLength(text) > MAX_RECEIPT_BYTES) throw new Error('撤权凭据超过支持的大小。')
  const staged = join(dirname(output), `.memory-revocations-${randomUUID()}.tmp`)
  try {
    atomicWritePrivate(staged,text)
    // The final link reserves the chosen filename without replacing an existing file.
    linkSync(staged,output)
    syncDirectory(dirname(output))
  } catch (error) {
    if (error?.code === 'EEXIST') throw new Error('撤权凭据目标已存在，请选择新的文件名。')
    throw error
  } finally {
    try { unlinkSync(staged) }
    catch (error) { if (error?.code !== 'ENOENT') throw error }
  }
  return { records:data.records.length, purged:data.purgedIds.length,
    sources:new Set([...data.deniedSources, ...data.blockedSources]).size }
}

function checkReceiptData(data) {
  if (!isNoteDigest(data?.profile) ||
      !validArray(data.records, validRevocation) || !validArray(data.purgedIds,validId) ||
      !validArray(data.blockedSources,validSourceId) || !validArray(data.deniedSources,validSourceId) ||
      !validArray(data.purgedNotes, row => Array.isArray(row) && row.length === 2 &&
        isValidMemoryId(row[0]) && validArray(row[1],isNoteDigest))) throw new Error('撤权凭据内容格式无效。')
  const purged = new Set(data.purgedIds)
  if (data.records.some(row => row.revision === PERMANENT_REVISION && !purged.has(row.id)) ||
      data.purgedNotes.some(([id]) => !purged.has(id))) throw new Error('撤权凭据缺少对应的永久删除记录。')
}

export function readRevocationReceipt(file) {
  const stat = lstatSync(file)
  if (!stat.isFile() || stat.size > MAX_RECEIPT_BYTES) throw new Error('请选择完整的撤权凭据文件。')
  const bytes = readFileSync(file)
  if (bytes.length > MAX_RECEIPT_BYTES) throw new Error('撤权凭据超过支持的大小。')
  let value
  try { value = JSON.parse(bytes.toString('utf8')) }
  catch { throw new Error('撤权凭据格式无效。') }
  const { data } = value ?? {}
  if (value?.format !== FORMAT || value.version !== 1 || typeof data !== 'object' || data === null ||
      value.sha256 !== sha256(JSON.stringify(data))) throw new Error('撤权凭据格式或校验值无效。')
  checkReceiptData(data)
  return data
}

function applyRevocations(stage, data) {
  const store = new MemoryStore({ root:stage })
  const restoredPurged = store.purgedIds(), currentPurged = new Set(data.purgedIds)
  const noteDigests = readPurgedNoteDigests(stage)
  let changedDigests = false
  const retainNoteDigests = (id, hashes) => {
    const saved = noteDigests.get(id) ?? new Set()
    const count = saved.size
    for (const hash of hashes) saved.add(hash)
    if (saved.size === count) return
    noteDigests.set(id, saved)
    changedDigests = true
  }
  const records = new Map(), purgeScopes = new Set(), legacyScopes = new Map()
  mergeRevocations(records, data.records)
  for (const row of records.values()) if (row.revision === PERMANENT_REVISION) purgeScopes.add(row.id)
  const sources = new Set(data.blockedSources), denied = new Set(data.deniedSources)
  for (const id of readRevocationLedger(stage).deniedSources) denied.add(id)
  for (const id of noSaveSourceIds(readTurnIntakes(stage).intakes)) if (validSourceId(id)) denied.add(id)
  const deniedTasks = retireRestoredCaptureTasks(stage,denied)
  const privateRevision = record => deniedTasks.has(record.captureTaskId) ||
    (Array.isArray(record.sourceRefs) && record.sourceRefs.some(ref=>denied.has(ref?.sourceId)))
  const now = Date.now()
  let deletedCount = 0
  for (const [scope, projectKey] of scopesOf(store)) {
    const target = scopePaths(stage, scope, projectKey).file
    const saved = readJsonl(target, stage)
    if (saved.corrupt) throw new Error('记忆文件有未确认的修订，尚不能安全保留撤权状态。')
    const latest = latestRevisions(saved.records)
    const remove = new Set(), tombstones = []
    for (const record of latest) {
      const id = record.id
      const key = revocationKey({id,projectKey})
      let limit = records.get(key)
      if (currentPurged.has(id) && !purgeScopes.has(id)) {
        if (legacyScopes.has(id) && legacyScopes.get(id) !== projectKey) {
          throw new Error('旧永久删除记录在多个项目中命中同一 ID，无法核对归属。')
        }
        legacyScopes.set(id,projectKey)
        limit = { id,projectKey,revision:PERMANENT_REVISION,at:0 }
        records.set(key,limit)
      }
      if (limit?.revision === PERMANENT_REVISION) remove.add(id)
      else if (privateRevision(record)) {
        const revision = Math.max(record.revision,limit?.revision ?? 0) + 1
        if (!Number.isSafeInteger(revision)) throw new Error('禁存记录的修订号无效。')
        const { record:empty } = buildRecord({ scope, projectKey, kind:'fact', content:'旧快照中的禁存内容已移除。' }, {id,now})
        tombstones.push({ ...empty, status:'deleted', revision })
        records.set(key,{ id,projectKey,revision,at:now })
      } else if (limit && record.revision < limit.revision) {
        // A later explicit restore has a higher revision and remains active.
        tombstones.push({ ...nextRevision(record,{status:'deleted'},limit.at), revision:limit.revision })
      } else if (limit && record.revision === limit.revision && record.status !== 'deleted') {
        throw new Error('备份与删除凭据在同一修订上冲突，请核对所属数据历史。')
      }
    }
    if (remove.size || tombstones.length || denied.size && saved.records.some(privateRevision)) {
      const kept = []
      const revoked = new Set([...remove, ...tombstones.map(record => record.id)])
      for (const record of saved.records) {
        if (revoked.has(record.id)) {
          for (const ref of Array.isArray(record.sourceRefs) ? record.sourceRefs : []) {
            if (validSourceId(ref?.sourceId)) sources.add(ref.sourceId)
          }
        }
        if (privateRevision(record)) continue
        if (remove.has(record.id)) {
          // The verified snapshot may be the last authority for Markdown
          // copies made before the purge stored their checksums.
          retainNoteDigests(record.id, memoryNoteDigests([record]))
        } else kept.push(record)
      }
      atomicWritePrivate(target, [...kept,...tombstones].map(record => JSON.stringify(record)+'\n').join(''))
      deletedCount += tombstones.length
    }
  }
  const purged = new Set([...restoredPurged, ...currentPurged])
  if (purged.size !== restoredPurged.size) atomicWritePrivate(join(stage,PURGED_IDS_FILE),JSON.stringify([...purged].sort())+'\n')
  for (const [id, hashes] of data.purgedNotes) retainNoteDigests(id, hashes)
  if (changedDigests) writePurgedNoteDigests(stage,noteDigests)
  blockSourceRecall(stage,{sourceRefs:[...sources].map(sourceId=>({sourceId}))})
  if (denied.size) {
    discardTurnSources(stage,[...denied])
    const grants = join(stage,CAPTURE_DIR,'recall-grants')
    for (const entry of entries(grants)) {
      if (!entry.isDirectory()) continue
      const dir = join(grants,entry.name)
      for (const id of denied) {
        try { unlinkSync(join(dir,`${id}.json`)) }
        catch (error) { if (error?.code !== 'ENOENT') throw error }
      }
      syncDirectory(dir)
    }
  }
  const rows = [...records.values()]
  retainRevocations(stage,rows,[...denied])
  invalidateStoredRecallReports(stage,{recordThrough:rows,sourceIds:[...new Set([...sources,...denied])]})
  syncDirectory(stage)
  return { deleted:deletedCount, purged:currentPurged.size, sources:new Set([...sources,...denied]).size }
}

export function publishWithCurrentRevocations(currentRoot, stage, backup, publish) {
  return withFileLock(join(currentRoot,'.write.lock'), () => {
    const current = readDataOwner(currentRoot), saved = readDataOwner(stage)
    if (!ownersMatch(current,saved,currentRoot,backup)) throw new Error('当前数据目录与备份归属不一致，未恢复。')
    return publish(applyRevocations(stage,collectRevocations(currentRoot)))
  })
}

export function publishWithReceipt(stage, receipt, publish) {
  const owner = readDataOwner(stage)
  if (owner.kind !== 'profile' || owner.identity !== receipt.profile) throw new Error('撤权凭据与备份的 DSH profile 归属不一致，未恢复。')
  return publish(applyRevocations(stage,receipt))
}

export function publishWithSnapshotDenials(stage,publish) {
  return publish(applyRevocations(stage,{ records:[], purgedIds:[], purgedNotes:[], blockedSources:[], deniedSources:[] }))
}
