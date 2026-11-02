/**
 * In-memory BM25 index over memory records.
 *
 * The index is derived data: it is rebuilt from the JSONL authority at startup
 * and updated in place on every append. Documents are `content + tags`; the
 * tokenizer expands CJK runs to unigrams+bigrams, so 2-character Chinese queries
 * match. Filtering (scope/status/kind/validity) happens before scoring.
 *
 * @module dsh-memory/host/search
 */

import { queryTerms, tokenize } from './tokenize.js'

const K1 = 1.2
const B = 0.75

/**
 * @typedef {{ record: object, length: number, terms: Map<string, number> }} IndexDoc
 */

export class MemoryIndex {
  #docs = new Map()
  #totalLength = 0
  #docFreq = new Map()

  get size() {
    return this.#docs.size
  }

  /** Replace the whole index with the given records. */
  rebuild(records) {
    this.#docs.clear()
    this.#totalLength = 0
    this.#docFreq.clear()
    for (const record of records) this.upsert(record)
    return this
  }

  /** Add or replace one record. */
  upsert(record) {
    if (record === null || typeof record !== 'object' || typeof record.id !== 'string') return
    this.remove(record.id)
    const text = `${record.content ?? ''} ${Array.isArray(record.tags) ? record.tags.join(' ') : ''} ${record.topic ?? ''}`
    const tokens = tokenize(text)
    const terms = new Map()
    for (const token of tokens) terms.set(token, (terms.get(token) ?? 0) + 1)
    this.#docs.set(record.id, { record, length: tokens.length, terms })
    this.#totalLength += tokens.length
    for (const term of terms.keys()) this.#docFreq.set(term, (this.#docFreq.get(term) ?? 0) + 1)
    return this
  }

  /** Remove one record from the index. */
  remove(id) {
    const doc = this.#docs.get(id)
    if (doc === undefined) return false
    this.#docs.delete(id)
    this.#totalLength -= doc.length
    for (const term of doc.terms.keys()) {
      const next = (this.#docFreq.get(term) ?? 1) - 1
      if (next <= 0) this.#docFreq.delete(term)
      else this.#docFreq.set(term, next)
    }
    return true
  }

  /** Drop everything; the caller rebuilds from the authority. */
  clear() {
    this.#docs.clear()
    this.#totalLength = 0
    this.#docFreq.clear()
  }

  /**
   * Score records for one query.
   * @param {string} query
   * @param {{ statuses?: string[], scopes?: string[], projectKey?: string | null, kinds?: string[], now?: number, limit?: number }} [options]
   * @returns {Array<{ record: object, score: number, matched: string[] }>}
   */
  search(query, options = {}) {
    const terms = queryTerms(query)
    if (terms.length === 0 || this.#docs.size === 0) return []
    const statuses = options.statuses ?? ['active']
    const scopes = options.scopes ?? ['project', 'global']
    const kinds = options.kinds ?? null
    const now = typeof options.now === 'number' ? options.now : Date.now()
    const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 40
    const total = this.#docs.size
    const averageLength = total > 0 ? this.#totalLength / total : 0
    const hits = []

    for (const doc of this.#docs.values()) {
      const record = doc.record
      if (!statuses.includes(record.status)) continue
      if (!scopes.includes(record.scope)) continue
      if (record.scope === 'project' && options.projectKey != null && record.projectKey !== options.projectKey) continue
      if (kinds !== null && !kinds.includes(record.kind)) continue
      if (record.validTo != null && record.validTo <= now) continue

      let score = 0
      const matched = []
      for (const term of terms) {
        const termFrequency = doc.terms.get(term)
        if (termFrequency === undefined) continue
        matched.push(term)
        const docFrequency = this.#docFreq.get(term) ?? 0
        const idf = Math.log(1 + (total - docFrequency + 0.5) / (docFrequency + 0.5))
        const denominator = termFrequency + K1 * (1 - B + (B * doc.length) / (averageLength || 1))
        score += idf * ((termFrequency * (K1 + 1)) / denominator)
      }
      if (score > 0) hits.push({ record, score, matched })
    }

    hits.sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score
      return (right.record.updatedAt ?? 0) - (left.record.updatedAt ?? 0)
    })
    return hits.slice(0, limit)
  }
}
