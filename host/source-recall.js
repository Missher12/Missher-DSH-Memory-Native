import { recallTaskLookup, readRecallSource } from './capture-journal.js'
import { matchesRecallAttribute } from './recall.js'
import { looksSensitive } from './records.js'
import { analyzeUserMessageControls } from './user-controls.js'

// Re-read only the exact range originally authorized by successful capture.
// This is turn-local evidence, never a new persisted fact or a model request.
export function sourceResolver(root, store, projectKey, now) {
  const lookup = recallTaskLookup(root), sources = new Map()
  const scopes = [{ scope: 'project', projectKey }]
  let remaining = 4
  return (item, candidates) => {
    const matches = new Map()
    for (const hit of candidates.slice(0, 6)) {
      const record = store.find(hit.record.id, scopes)
      if (!record || record.scope !== 'project' || record.projectKey !== projectKey ||
          record.status !== 'active' || record.revision !== hit.record.revision ||
          record.validFrom > now || (record.validTo != null && record.validTo <= now) ||
          record.evidenceRole !== 'user' || record.quoted || !record.captureTaskId ||
          !record.captureKey?.startsWith(record.captureTaskId + ':')) continue
      for (const ref of record.sourceRefs ?? []) {
        if (ref.role !== 'user' || ref.sourceKind !== 'user' ||
            !Number.isSafeInteger(ref.from) || ref.from < 0 || !Number.isSafeInteger(ref.to) ||
            ref.to <= ref.from || ref.to - ref.from > 240 || !ref.excerpt || looksSensitive(ref.excerpt)) continue
        const key = record.captureTaskId + '/' + ref.sourceId
        if (!sources.has(key)) {
          if (remaining <= 0) continue
          remaining--
          sources.set(key, readRecallSource(root, ref.sourceId, record.captureTaskId, projectKey, lookup))
        }
        const verified = sources.get(key)
        if (!verified) continue
        const {source, task} = verified
        if (!task.sourceGrants?.some(g => g.id === record.id && g.revision === record.revision &&
            g.hash === record.contentHash && g.sourceId === ref.sourceId && g.from === ref.from && g.to === ref.to)) continue
        if (source.sessionId !== ref.sessionId || (source.messageId ?? null) !== (ref.messageId ?? null) ||
            source.text.slice(ref.from,ref.to) !== ref.excerpt || analyzeUserMessageControls(source.text).noSaveDirective ||
            !task.segment?.entries?.some(e => e.sourceId === ref.sourceId && e.from <= ref.from && e.to >= ref.to)) continue
        const full = { ...record, content: ref.excerpt }
        if (matchesRecallAttribute({record:full},item.query,item.detail,item.entityTerms)) {
          matches.set(full.content, {...hit, record:full, sourceId:ref.sourceId})
        }
      }
    }
    return matches.size === 1 ? [...matches.values()][0] : null
  }
}
