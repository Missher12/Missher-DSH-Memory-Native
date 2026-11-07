/** Validate a whole migration payload before touching the destination store. */
import { buildRecord, MEMORY_STATUSES, contentHashOf } from './records.js'
import { isValidProjectKey } from './paths.js'

const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const safeId = value => typeof value === 'string' && /^[\p{L}\p{N}_.-]{1,160}$/u.test(value) && !['.', '..', '__proto__'].includes(value)

export function validateImport(payload, supportedVersion, now) {
  if (!plain(payload) || (!Object.hasOwn(payload, 'global') && !Object.hasOwn(payload, 'projects'))) throw new Error('导入文件必须是记忆导出对象。')
  // Pre-versioned partial exports remain readable as the old schema.
  const version = payload.schemaVersion ?? 1
  if (!Number.isInteger(version) || version < 1 || version > supportedVersion) throw new Error('导入文件版本不受支持。')
  if (payload.global !== undefined && !Array.isArray(payload.global)) throw new Error('导入全局范围必须是记录列表。')
  if (payload.projects !== undefined && !plain(payload.projects)) throw new Error('导入项目范围无效。')
  const records = [], ids = new Set()
  const add = (record, scope, projectKey) => {
    const invalid = reason => { throw new Error(`导入记录 ${records.length + 1} 无效：${reason}`) }
    if (!plain(record) || !safeId(record.id)) invalid('记录标识不合法')
    if (ids.has(record.id)) invalid('记录标识重复')
    if (record.scope !== scope || (record.projectKey ?? null) !== projectKey) invalid('记录与所在范围不一致')
    if (!Number.isSafeInteger(record.revision) || record.revision < 1) invalid('修订号不合法')
    if (!MEMORY_STATUSES.includes(record.status) || typeof record.content !== 'string') invalid('状态或正文类型不合法')
    for (const field of ['confidence', 'importance']) {
      if (record[field] !== undefined && (typeof record[field] !== 'number' || !Number.isFinite(record[field]) || record[field] < 0 || record[field] > 1)) invalid('评分不合法')
    }
    for (const field of ['createdAt', 'updatedAt', 'observedAt', 'validFrom', 'validTo', 'lastRecalledAt']) {
      if (record[field] != null && (!Number.isSafeInteger(record[field]) || record[field] < 0)) invalid('时间不合法')
    }
    if (record.tags !== undefined && (!Array.isArray(record.tags) || record.tags.length > 8 || record.tags.some(tag => typeof tag !== 'string' || tag.length > 40))) invalid('标签不合法')
    if (record.sourceRefs !== undefined && (!Array.isArray(record.sourceRefs) || record.sourceRefs.length > 12 || record.sourceRefs.some(ref => !plain(ref)))) invalid('来源列表不合法')
    const built = buildRecord({ ...record, status: 'candidate' }, { now: record.createdAt ?? now, id: record.id })
    if (!built.ok) invalid('正文、类型或有效时间不合法')
    ids.add(record.id)
    records.push({ ...built.record, ...record, scope, projectKey, content: built.record.content, contentHash: contentHashOf(built.record.content) })
  }
  for (const record of payload.global ?? []) add(record, 'global', null)
  for (const [key, rows] of Object.entries(payload.projects ?? {})) {
    if (!isValidProjectKey(key) || !Array.isArray(rows)) throw new Error('导入项目范围无效。')
    for (const record of rows) add(record, 'project', key)
  }
  return records
}
