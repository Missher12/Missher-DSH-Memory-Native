/** Derived, profile-local vectors. Search results always point back to live authority. */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, appendFile, writeFile, rename } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { join } from 'node:path'
import { isValidProjectKey } from './paths.js'
import { EMBEDDING_MODEL, LocalEmbedding } from './embedding.js'

const digest = text => createHash('sha256').update(text).digest('hex')
const encode = vector => Buffer.from(new Float32Array(vector).buffer).toString('base64')
function decode(text) {
  if (typeof text !== 'string' || text.length !== 2048) return null
  const bytes = Buffer.from(text, 'base64')
  if (bytes.length !== 1536) return null
  const vector = new Float32Array(new Uint8Array(bytes).buffer)
  const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0))
  return vector.every(Number.isFinite) && norm > .99 && norm < 1.01 ? vector : null
}

export class SemanticRecallIndex {
  #root
  #engine
  #enabled
  #projects = new Map()
  #running = null
  #disposed = false
  #error = null
  #options
  #retryAt = 0
  constructor(root, options = {}) {
    this.#root = root; this.#enabled = options.enabled !== false; this.#options = options
    this.#engine = options.engine ?? new LocalEmbedding(options)
  }
  status() {
    let indexed = 0, total = 0
    for (const scope of this.#projects.values()) {
      total += scope.entries.size
      for (const key of scope.entries.keys()) if (scope.vectors.has(key)) indexed++
    }
    return { model: EMBEDDING_MODEL, state: !this.#enabled ? 'disabled' : this.#error ? 'failed'
      : this.#engine.state !== 'ready' ? this.#engine.state : indexed < total ? 'indexing' : 'ready',
      indexed, total, error: this.#error ?? this.#engine.error ?? null }
  }
  async #scope(projectKey) {
    if (this.#projects.has(projectKey)) return this.#projects.get(projectKey)
    const file = join(this.#root, '.cache', 'semantic', EMBEDDING_MODEL, projectKey + '.jsonl')
    const scope = { file, entries: new Map(), vectors: new Map(), loading: null }
    this.#projects.set(projectKey, scope)
    scope.loading = (async () => {
      try {
        const input = createReadStream(file), lines = createInterface({ input, crlfDelay: Infinity })
        for await (const line of lines) {
          if (this.#disposed) { lines.close(); input.destroy(); return }
          try {
            const item = JSON.parse(line), vector = decode(item.vector)
            if (/^[a-f0-9]{64}$/u.test(item.key) && vector) scope.vectors.set(item.key, vector)
          } catch { /* A derived interrupted tail is rebuilt from authority. */ }
        }
      } catch (error) { if (error.code !== 'ENOENT') scope.cacheError = error.message }
    })()
    await scope.loading
    return scope
  }
  async #persist(scope, rows, replace = false) {
    if (this.#disposed) return
    await mkdir(join(scope.file, '..'), { recursive: true, mode: 0o700 })
    const data = rows.map(([key, vector]) => JSON.stringify({ key, vector: encode(vector) }) + '\n').join('')
    if (replace) {
      const temporary = scope.file + '.' + process.pid + '.tmp'
      await writeFile(temporary, data, { mode: 0o600 }); await rename(temporary, scope.file)
    } else if (rows.length) await appendFile(scope.file, data, { mode: 0o600 })
  }
  #pump() {
    if (this.#running || this.#disposed || this.#error) return
    this.#running = (async () => {
      for (;;) {
        if (this.#disposed) return
        const scope = [...this.#projects.values()].find(item => [...item.entries.keys()].some(key => !item.vectors.has(key)))
        if (!scope) return
        const batch = [...scope.entries].filter(([key]) => !scope.vectors.has(key)).slice(0, 4)
        const vectors = await this.#engine.embed(batch.map(([,entry]) => entry.text), 'passage')
        if (this.#disposed) return
        const rows = []
        for (let i = 0; i < batch.length; i++) {
          const [key] = batch[i]
          if (!scope.entries.has(key)) continue // deletion while a worker was running
          const vector = decode(encode(vectors[i]))
          if (!vector) throw new Error('本地语义模型返回无效向量')
          scope.vectors.set(key, vector); rows.push([key, vector])
        }
        await this.#persist(scope, rows)
        await new Promise(resolve => setTimeout(resolve, 0))
      }
    })().catch(error => { if (!this.#disposed) { this.#error = error.message; this.#retryAt = Date.now() + 60000 } })
      .finally(() => { this.#running = null })
  }
  async search(queries, records, { projectKey, signal, waitMs = 6000 } = {}) {
    if (!this.#enabled || this.#disposed || signal?.aborted || !isValidProjectKey(projectKey)) return queries.map(() => [])
    if (this.#error && Date.now() >= this.#retryAt) {
      this.#engine.dispose(); this.#engine = this.#options.engine ?? new LocalEmbedding(this.#options); this.#error = null
    }
    const scope = await this.#scope(projectKey)
    await scope.loading
    const entries = new Map()
    for (const record of records) {
      // A foreign record must never be embedded, even if a caller makes a mistake.
      if (record.scope !== 'global' && (record.scope !== 'project' || record.projectKey !== projectKey)) continue
      if (!['active', 'superseded'].includes(record.status) || record.quoted) continue
      const content = String(record.content ?? '')
      for (let from = 0; from < content.length; from += 356) {
        const text = content.slice(from, from + 420)
        const key = digest(`${record.id}\0${record.revision}\0${record.contentHash}\0${from}\0${text}`)
        entries.set(key, { record, text })
        if (from + 420 >= content.length) break
      }
    }
    scope.entries = entries
    let retired = false
    for (const key of scope.vectors.keys()) if (!entries.has(key)) { scope.vectors.delete(key); retired = true }
    if (retired) await this.#persist(scope, [...scope.vectors], true)
    if (!entries.size || this.#error) return queries.map(() => [])
    this.#pump()
    let timer
    const vectors = await Promise.race([
      this.#engine.embed(queries, 'query').catch(error => { this.#error = error.message; this.#retryAt = Date.now() + 60000; return null }),
      new Promise(resolve => { timer = setTimeout(() => resolve(null), waitMs) }),
    ])
    clearTimeout(timer)
    if (!vectors || signal?.aborted || this.#disposed) return queries.map(() => [])
    return vectors.map(vector => {
      const hits = new Map()
      for (const [key, candidate] of scope.vectors) {
        const entry = entries.get(key)
        if (!entry) continue
        const score = candidate.reduce((sum, value, i) => sum + value * vector[i], 0)
        if (score < .7 || (hits.get(entry.record.id)?.score ?? 0) >= score) continue
        hits.set(entry.record.id, { record: { ...entry.record, recallContent: entry.text },
          score, semantic: true, matched: [], termScores: [] })
      }
      return [...hits.values()].sort((a,b) => b.score-a.score).slice(0, 20)
    })
  }
  async settle() { await this.#running }
  dispose() { this.#disposed = true; this.#engine.dispose() }
}
