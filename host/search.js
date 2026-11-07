/**
 * In-memory BM25 index over memory records.
 *
 * The index is derived data: it is rebuilt from the JSONL authority at startup
 * and updated in place on every append. Documents are `content + tags`; the
 * tokenizer expands CJK runs to unigrams+bigrams, so 2-character Chinese queries
 * match. Filtering (scope/status/kind/validity) happens before scoring.
 *
 * The hot path uses compact numeric term slots, per-document typed arrays and
 * postings instead of one `Map<string, freq>` per document. The JSONL store is
 * still the only authority; this structure is always disposable/rebuildable.
 *
 * @module dsh-memory/host/search
 */

import { queryTerms, tokenize } from './tokenize.js'
import { hotRecord } from './cache-records.js'

const K1 = 1.2
const B = 0.75

export class MemoryIndex {
  #slots = []
  #recordAt = null
  #hotAt = null
  #hotSlots = []
  #lengths = []
  #docTerms = []
  #docFreqs = []
  #slotById = new Map()
  #termIds = new Map()
  #termNames = []
  #df = []
  #postings = new Map()
  #packedDocs = null
  #packedPostings = null
  #totalLength = 0
  #stalePostings = 0

  get size() {
    return this.#slotById.size
  }

  /** Replace the whole index with the given records. */
  rebuild(records) {
    this.#recordAt = this.#hotAt = null
    this.#slots = []
    this.#hotSlots = []
    this.#lengths = []
    this.#docTerms = []
    this.#docFreqs = []
    this.#slotById.clear()
    this.#termIds.clear()
    this.#termNames = []
    this.#df = []
    this.#postings.clear()
    this.#packedDocs = null
    this.#packedPostings = null
    this.#totalLength = 0
    this.#stalePostings = 0
    for (const record of records) this.#add(record)
    return this
  }

  /** Compact, disposable representation of the already-built index. */
  snapshot() {
    const docOffsets = new Uint32Array(this.#slots.length + 1)
    for (let i = 0; i < this.#slots.length; i += 1) docOffsets[i + 1] = docOffsets[i] + (this.#termsFor(i)?.length ?? 0)
    const docTerms = new Int32Array(docOffsets.at(-1))
    const docFreqs = new Uint16Array(docTerms.length)
    for (let i = 0; i < this.#slots.length; i += 1) {
      const terms = this.#termsFor(i), freqs = this.#freqsFor(i)
      if (terms !== undefined && freqs !== undefined) {
        docTerms.set(terms, docOffsets[i])
        docFreqs.set(freqs, docOffsets[i])
      }
    }
    const offsets = new Uint32Array(this.#termNames.length + 1)
    for (let i = 0; i < this.#termNames.length; i += 1) {
      const packed = this.#packedPostings
      const base = packed !== null && i + 1 < packed.offsets.length ? packed.offsets[i + 1] - packed.offsets[i] : 0
      offsets[i + 1] = offsets[i] + base + (this.#postings.get(i)?.slots.length ?? 0)
    }
    const slots = new Uint32Array(offsets.at(-1)), freqs = new Uint32Array(slots.length)
    for (let i = 0; i < this.#termNames.length; i += 1) {
      let at = offsets[i]
      const packed = this.#packedPostings
      if (packed !== null && i + 1 < packed.offsets.length) {
        const start = packed.offsets[i], end = packed.offsets[i + 1]
        slots.set(packed.slots.subarray(start, end), at)
        freqs.set(packed.freqs.subarray(start, end), at)
        at += end - start
      }
      const extra = this.#postings.get(i)
      if (extra !== undefined) { slots.set(extra.slots, at); freqs.set(extra.freqs, at) }
    }
    return { slots: this.#recordAt ? this.#slots.map(slot => this.#record(slot)) : this.#slots, lengths: this.#lengths, slotById: this.#slotById,
      termIds: this.#termIds, termNames: this.#termNames, df: this.#df, totalLength: this.#totalLength,
      docs: { offsets: docOffsets, terms: docTerms, freqs: docFreqs }, postings: { offsets, slots, freqs } }
  }

  /** Restore only data produced by snapshot(); callers validate its authority. */
  restore(data) {
    if (!data || !Array.isArray(data.slots) || !Array.isArray(data.lengths) ||
      !(data.slotById instanceof Map) || !(data.termIds instanceof Map) ||
      !Array.isArray(data.termNames) || !Array.isArray(data.df) ||
      !(data.docs?.offsets instanceof Uint32Array) || !(data.docs?.terms instanceof Int32Array) ||
      !(data.docs?.freqs instanceof Uint16Array) || !(data.postings?.offsets instanceof Uint32Array) ||
      !(data.postings?.slots instanceof Uint32Array) || !(data.postings?.freqs instanceof Uint32Array) ||
      data.docs.offsets.length !== data.slots.length + 1 || data.postings.offsets.length !== data.termNames.length + 1 ||
      data.docs.terms.length !== data.docs.freqs.length || data.postings.slots.length !== data.postings.freqs.length ||
      data.docs.offsets.at(-1) !== data.docs.terms.length || data.postings.offsets.at(-1) !== data.postings.slots.length) {
      throw new Error('invalid derived index')
    }
    this.#slots = data.slots
    this.#hotSlots = data.slots.slice()
    this.#recordAt = data.recordAt ?? null
    this.#hotAt = data.hotAt ?? null
    this.#lengths = data.lengths
    this.#slotById = data.slotById
    this.#termIds = data.termIds
    this.#termNames = data.termNames
    this.#df = data.df
    this.#totalLength = data.totalLength
    this.#packedDocs = data.docs
    this.#packedPostings = data.postings
    this.#docTerms = []
    this.#docFreqs = []
    this.#postings.clear()
    this.#stalePostings = 0
    return this
  }

  #record(slot) { return typeof slot === 'number' ? this.#recordAt(slot) : slot }

  #termsFor(slot) {
    const terms = this.#docTerms[slot]
    if (terms !== undefined) return terms
    const packed = this.#packedDocs
    if (packed === null || slot + 1 >= packed.offsets.length || this.#slots[slot] === null) return undefined
    return packed.terms.subarray(packed.offsets[slot], packed.offsets[slot + 1])
  }

  #freqsFor(slot) {
    const freqs = this.#docFreqs[slot]
    if (freqs !== undefined) return freqs
    const packed = this.#packedDocs
    if (packed === null || slot + 1 >= packed.offsets.length || this.#slots[slot] === null) return undefined
    return packed.freqs.subarray(packed.offsets[slot], packed.offsets[slot + 1])
  }

  /** Add or replace one record. */
  upsert(record) {
    if (record === null || typeof record !== 'object' || typeof record.id !== 'string') return
    this.remove(record.id)
    this.#add(record)
    this.#maybeCompact()
    return this
  }

  #add(record) {
    if (record === null || typeof record !== 'object' || typeof record.id !== 'string') return this
    const text = `${record.content ?? ''} ${Array.isArray(record.tags) ? record.tags.join(' ') : ''} ${record.topic ?? ''}`
    const tokens = tokenize(text)
    const frequencies = new Map()
    for (const token of tokens) frequencies.set(token, (frequencies.get(token) ?? 0) + 1)
    const slot = this.#slots.length
    this.#slots.push(record)
    this.#hotSlots.push(hotRecord(record))
    this.#lengths.push(tokens.length)
    this.#slotById.set(record.id, slot)
    this.#totalLength += tokens.length

    const termIds = new Int32Array(frequencies.size)
    const termFreqs = new Uint16Array(frequencies.size)
    let index = 0
    for (const [term, frequency] of frequencies) {
      let termId = this.#termIds.get(term)
      if (termId === undefined) {
        termId = this.#termNames.length
        this.#termIds.set(term, termId)
        this.#termNames.push(term)
        this.#df.push(0)
      }
      termIds[index] = termId
      termFreqs[index] = frequency
      index += 1
      this.#df[termId] = (this.#df[termId] ?? 0) + 1
      let posting = this.#postings.get(termId)
      if (posting === undefined) {
        posting = { slots: [], freqs: [] }
        this.#postings.set(termId, posting)
      }
      posting.slots.push(slot)
      posting.freqs.push(frequency)
    }
    this.#docTerms[slot] = termIds
    this.#docFreqs[slot] = termFreqs
    return this
  }

  /** Reclaim historical slots/dictionary entries once churn outgrows live data. */
  #maybeCompact() {
    if (this.#slots.length <= this.size * 2 + 64) return
    const live = this.#slots.filter((entry) => entry !== null).map(entry => this.#record(entry))
    this.rebuild(live)
  }

  /** idf of a term in the current index, or null when it is absent. */
  idfOf(term) {
    const termId = this.#termIds.get(term)
    if (termId === undefined) return null
    const docFrequency = this.#df[termId] ?? 0
    if (docFrequency === 0) return null
    const total = this.size
    return Math.log(1 + (total - docFrequency + 0.5) / (docFrequency + 0.5))
  }

  /** Remove one record from the index. */
  remove(id) {
    const slot = this.#slotById.get(id)
    if (slot === undefined) return false
    this.#slotById.delete(id)
    const record = this.#record(this.#slots[slot])
    const termIds = this.#termsFor(slot)
    this.#slots[slot] = null
    this.#hotSlots[slot] = null
    this.#totalLength -= this.#lengths[slot] ?? 0
    this.#lengths[slot] = 0
    if (termIds !== undefined) {
      for (const termId of termIds) {
        const next = (this.#df[termId] ?? 1) - 1
        this.#df[termId] = next < 0 ? 0 : next
      }
    }
    this.#docTerms[slot] = undefined
    this.#docFreqs[slot] = undefined
    this.#stalePostings += 1
    if (this.#stalePostings > 2048) this.#rebuildPostings()
    this.#maybeCompact()
    return record !== undefined
  }

  #rebuildPostings() {
    this.#postings.clear()
    this.#packedPostings = null
    for (let slot = 0; slot < this.#slots.length; slot += 1) {
      if (this.#slots[slot] === null) continue
      const termIds = this.#termsFor(slot)
      const termFreqs = this.#freqsFor(slot)
      if (termIds === undefined || termFreqs === undefined) continue
      for (let index = 0; index < termIds.length; index += 1) {
        const termId = termIds[index]
        let posting = this.#postings.get(termId)
        if (posting === undefined) {
          posting = { slots: [], freqs: [] }
          this.#postings.set(termId, posting)
        }
        posting.slots.push(slot)
        posting.freqs.push(termFreqs[index])
      }
    }
    this.#stalePostings = 0
  }

  /** Drop everything; the caller rebuilds from the authority. */
  clear() {
    this.rebuild([])
  }

  #termData(terms) {
    const data = []
    for (const term of terms) {
      const termId = this.#termIds.get(term)
      if (termId === undefined) continue
      const docFrequency = this.#df[termId] ?? 0
      if (docFrequency === 0) continue
      data.push({
        term,
        termId,
        idf: Math.log(1 + (this.size - docFrequency + 0.5) / (docFrequency + 0.5)),
        posting: this.#postings.get(termId),
      })
    }
    return data
  }

  #frequencyOf(slot, termId) {
    const ids = this.#termsFor(slot)
    if (ids === undefined) return undefined
    for (let index = 0; index < ids.length; index += 1) {
      if (ids[index] === termId) return this.#freqsFor(slot)[index]
    }
    return undefined
  }

  #compare(left, right) {
    if (left.score !== right.score) return left.score > right.score ? 1 : -1
    if ((left.updatedAt ?? 0) !== (right.updatedAt ?? 0)) return (left.updatedAt ?? 0) > (right.updatedAt ?? 0) ? 1 : -1
    if (left.id === right.id) return 0
    return left.id < right.id ? 1 : -1
  }

  #hitsFromHeap(heap, termData, offset, limit) {
    heap.sort((left, right) => this.#compare(right, left))
    const selected = Number.isInteger(offset) && offset > 0 ? heap.slice(offset, offset + limit) : heap.slice(0, limit)
    const hits = []
    for (const entry of selected) {
      const slot = entry.slot
      const record = this.#record(this.#slots[slot])
      if (record === null) continue
      const matched = []
      const termScores = []
      for (const item of termData) {
        const frequency = this.#frequencyOf(slot, item.termId)
        if (frequency === undefined) continue
        matched.push(item.term)
        const denominator = frequency + K1 * (1 - B + (B * (this.#lengths[slot] ?? 0)) / (this.#averageLength() || 1))
        termScores.push({
          term: item.term,
          idf: item.idf,
          value: item.idf * ((frequency * (K1 + 1)) / denominator),
        })
      }
      hits.push({ record, score: entry.score, matched, termScores })
    }
    return hits
  }

  #averageLength() {
    return this.size > 0 ? this.#totalLength / this.size : 1
  }

  /**
   * Score records for one query.
   * @param {string} query
   * @param {{ statuses?: string[], scopes?: string[], projectKey?: string | null, kinds?: string[], topic?: string, now?: number, limit?: number, offset?: number }} [options]
   * @returns {Array<{ record: object, score: number, matched: string[], termScores: Array<{term:string,idf:number,value:number}> }>}
   */
  search(query, options = {}) {
    return this.searchPage(query, options).hits
  }

  /**
   * Filter/count all matches but allocate hit objects only for the requested
   * page. Used by the panel list so total/kind/topic counts do not require
   * materialising 50k hit explanations.
   *
   * @param {string} query
   * @param {object} options
   * @returns {{ total: number, hits: object[], kindCounts: Record<string, number>, topicCounts: Record<string, number> }}
   */
  searchPage(query, options = {}) {
    if (typeof query === 'string' && query.trim() === '') {
      return { total: 0, hits: [], kindCounts: {}, topicCounts: {} }
    }
    const terms = queryTerms(query)
    if (terms.length === 0 || this.size === 0) {
      return { total: 0, hits: [], kindCounts: {}, topicCounts: {} }
    }
    const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 40
    const offset = Number.isInteger(options.offset) && options.offset > 0 ? options.offset : 0
    const statuses = new Set(options.statuses ?? ['active'])
    const singleStatus = statuses.size === 1 ? statuses.values().next().value : undefined
    const scopes = new Set(options.scopes ?? ['project', 'global'])
    const kinds = options.kinds === undefined || options.kinds === null ? null : new Set(options.kinds)
    const topic = typeof options.topic === 'string' && options.topic !== '' ? options.topic : null
    const now = typeof options.now === 'number' ? options.now : Date.now()
    const termData = this.#termData(terms)
    if (termData.length === 0) return { total: 0, hits: [], kindCounts: {}, topicCounts: {} }

    const scores = new Float64Array(this.#slots.length)
    const touched = []
    const averageLength = this.#averageLength() || 1
    for (const item of termData) {
      const scorePosting = (slots, freqs, start, end) => {
      for (let index = start; index < end; index += 1) {
        const slot = slots[index]
        if (this.#slots[slot] === null) continue
        const frequency = freqs[index]
        const length = this.#lengths[slot] ?? 0
        const denominator = frequency + K1 * (1 - B + (B * length) / averageLength)
        const value = item.idf * ((frequency * (K1 + 1)) / denominator)
        if (scores[slot] === 0) touched.push(slot)
        scores[slot] += value
      }
      }
      const packed = this.#packedPostings
      if (packed !== null && item.termId + 1 < packed.offsets.length) {
        scorePosting(packed.slots, packed.freqs, packed.offsets[item.termId], packed.offsets[item.termId + 1])
      }
      if (item.posting !== undefined) scorePosting(item.posting.slots, item.posting.freqs, 0, item.posting.slots.length)
    }

    const heap = []
    const heapSize = offset + limit
    const worse = (left, right) => this.#compare(left, right) < 0
    const siftUp = (index) => {
      while (index > 0) {
        const parent = (index - 1) >> 1
        if (!worse(heap[index], heap[parent])) break
        ;[heap[index], heap[parent]] = [heap[parent], heap[index]]
        index = parent
      }
    }
    const siftDown = (index) => {
      for (;;) {
        const left = index * 2 + 1
        const right = left + 1
        let smallest = index
        if (left < heap.length && worse(heap[left], heap[smallest])) smallest = left
        if (right < heap.length && worse(heap[right], heap[smallest])) smallest = right
        if (smallest === index) break
        ;[heap[index], heap[smallest]] = [heap[smallest], heap[index]]
        index = smallest
      }
    }

    const kindCounts = {}
    const topicCounts = {}
    let total = 0
    for (const slot of touched) {
      const cached = this.#hotSlots[slot]
      const record = typeof cached === 'number' ? (this.#hotSlots[slot] = this.#hotAt(cached)) : cached
      if (record === null) continue
      if (singleStatus !== undefined ? record.status !== singleStatus : !statuses.has(record.status)) continue
      if (!scopes.has(record.scope)) continue
      if (record.scope === 'project' && options.projectKey != null && record.projectKey !== options.projectKey) continue
      if (record.validFrom != null && record.validFrom > now) continue
      if (options.includeExpired !== true && record.validTo != null && record.validTo <= now) continue
      if (Object.hasOwn(MEMORY_KINDS, record.kind)) kindCounts[record.kind] = (kindCounts[record.kind] ?? 0) + 1
      if (kinds !== null && !kinds.has(record.kind)) continue
      const recordTopic = typeof record.topic === 'string' && record.topic.trim() !== '' ? record.topic : '__none__'
      topicCounts[recordTopic] = (topicCounts[recordTopic] ?? 0) + 1
      if (topic !== null && recordTopic !== topic) continue
      total += 1
      const score = scores[slot]
      if (score <= 0) continue
      if (heap.length >= heapSize) {
        const worst = heap[0]
        if (score < worst.score) continue
        if (score === worst.score) {
          const updated = record.updatedAt ?? 0
          if (updated < worst.updatedAt || (updated === worst.updatedAt && record.id >= worst.id)) continue
        }
      }
      const entry = { slot, score, updatedAt: record.updatedAt ?? 0, id: record.id }
      if (heap.length < heapSize) {
        heap.push(entry)
        siftUp(heap.length - 1)
      } else {
        heap[0] = entry
        siftDown(0)
      }
    }

    const pageOffset = Math.min(offset, total)
    const hits = this.#hitsFromHeap(heap, termData, pageOffset, limit)
    // The heap contains at most offset+limit entries; trim to the stable page.
    return { total, hits, kindCounts, topicCounts }
  }
}

/** Kind keys used by the panel; kept local to avoid a records.js dependency. */
const MEMORY_KINDS = Object.freeze({ preference: true, fact: true, decision: true, episode: true })
