import { hotRecord } from './cache-records.js'
import { isValidProjectKey } from './paths.js'

const SECTIONS = [
  ['current', '当前事实与约束'],
  ['decisions', '已确认的决定'],
  ['history', '历史变化'],
  ['unresolved', '待确认与待生效'],
]
const time = value => Number.isFinite(value) ? value : null

function sectionFor(record, now) {
  const meta = hotRecord(record)
  if (meta.status === 'candidate') return 'unresolved'
  if (meta.status === 'archived' || meta.status === 'superseded') return 'history'
  if (meta.status !== 'active') return null
  if (time(record.validFrom) !== null && record.validFrom > now) return 'unresolved'
  if (time(meta.validTo) !== null && meta.validTo <= now) return 'history'
  if (meta.kind === 'episode') return 'history'
  return meta.kind === 'decision' ? 'decisions' : 'current'
}

/** A live view of current authority revisions, never a second summary store. */
export function deriveProjectBrief(store, input) {
  const { projectKey, limit = 100, offset = 0, now = Date.now() } = input ?? {}
  if (!isValidProjectKey(projectKey)) throw new TypeError('projectKey is required and must identify one project')
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new TypeError('limit must be an integer from 1 to 200')
  if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError('offset must be a non-negative safe integer')
  if (!Number.isFinite(now)) throw new TypeError('now must be a finite timestamp')
  const groups = new Map(SECTIONS.map(([id]) => [id, []]))
  const records = store.list('project', projectKey)
  for (const record of records) {
    const meta = hotRecord(record)
    if (meta.scope !== 'project' || meta.projectKey !== projectKey) continue
    const section = sectionFor(record, now)
    if (section !== null) groups.get(section).push(record)
  }
  // Paging happens before reading text or source excerpts from lazy records.
  let total = 0, remaining = limit
  const sections = []
  for (const [id, title] of SECTIONS) {
    const records = groups.get(id)
    const start = Math.max(0, offset - total)
    const page = remaining > 0 ? records.slice(start, start + remaining) : []
    remaining -= page.length
    total += records.length
    if (!page.length) continue
    sections.push({ id, title, items: page.map(record => ({
      id: record.id,
      revision: record.revision,
      kind: record.kind,
      scope: 'project',
      projectKey,
      content: record.content,
      status: record.status,
      sourceRefs: (record.sourceRefs ?? []).map(ref => ({ ...ref })),
      validFrom: time(record.validFrom),
      validTo: time(record.validTo),
      observedAt: time(record.observedAt),
      supersedesId: record.supersedesId ?? null,
    })) })
  }
  return { projectKey, sections, total, limit, offset, nextOffset: offset + limit < total ? offset + limit : null }
}
