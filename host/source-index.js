import { hotRecord } from './cache-records.js'
import { isValidProjectKey } from './paths.js'
import { looksSensitive } from './records.js'
import { MemoryIndex } from './search.js'

/**
 * Find parent records by their source excerpts even when the summary lost the
 * query terms. These are candidates only: sourceResolver must still verify
 * current grants, source bytes, opt-outs and deletion blocks before injection.
 */
export class SourceCandidateIndex {
  #store
  #projects = new Map()
  constructor(store) { this.#store = store }

  search(query, { projectKey, now = Date.now(), limit = 40 } = {}) {
    if (!isValidProjectKey(projectKey)) return []
    let cached = this.#projects.get(projectKey)
    if (!cached) cached = { index: new MemoryIndex(), parents: new Map() }
    this.#projects.delete(projectKey)
    this.#projects.set(projectKey, cached)
    // Bound derived memory without omitting any authority: evicted scopes are
    // rebuilt on their next missing-evidence lookup, never during startup.
    if (this.#projects.size > 4) this.#projects.delete(this.#projects.keys().next().value)
    const live = new Set()
    for (const record of this.#store.list('project', projectKey)) {
      const meta = hotRecord(record)
      if (meta.scope !== 'project' || meta.projectKey !== projectKey || meta.status !== 'active') continue
      live.add(meta.id)
      if (cached.parents.get(meta.id) === record) continue
      cached.index.remove(meta.id)
      cached.parents.set(meta.id, record)
      if (record.evidenceRole !== 'user' || record.quoted || !record.captureTaskId ||
          !record.captureKey?.startsWith(record.captureTaskId + ':')) continue
      const refs = Array.isArray(record.sourceRefs) ? record.sourceRefs : []
      const excerpts = refs.filter(ref => ref?.role === 'user' && ref.sourceKind === 'user' &&
        typeof ref.sourceId === 'string' && typeof ref.excerpt === 'string' &&
        Number.isSafeInteger(ref.from) && ref.from >= 0 && Number.isSafeInteger(ref.to) &&
        ref.to > ref.from && ref.to - ref.from <= 240 && ref.excerpt.length === ref.to - ref.from &&
        !looksSensitive(ref.excerpt)).map(ref => ref.excerpt)
      if (!excerpts.length) continue
      cached.index.upsert({
        id:meta.id,kind:meta.kind,scope:'project',projectKey,status:'active',
        content:[...new Set(excerpts)].join('\n'),tags:[],topic:null,
        confidence:meta.confidence,importance:meta.importance,revision:meta.revision,
        observedAt:meta.observedAt,updatedAt:meta.updatedAt,validFrom:record.validFrom,validTo:meta.validTo,
      })
    }
    for (const id of cached.parents.keys()) {
      if (live.has(id)) continue
      cached.parents.delete(id)
      cached.index.remove(id)
    }
    return cached.index.search(query, { projectKey, scopes:['project'], statuses:['active'], now, limit })
      .map(hit => ({ ...hit, record:cached.parents.get(hit.record.id) }))
  }
}
