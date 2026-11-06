/** Full-size temporary JSONL benchmark; each measurement runs in a fresh Node process.
 * OS file caches are not flushed. No real profile or memory files are touched.
 * Run: node scripts/bench-storage.mjs [record-count]
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildRecord } from '../host/records.js'
import { MemoryIndex } from '../host/search.js'
import { MemoryStore } from '../host/store.js'
import { QUERIES, writeCorpus } from './bench-corpus.mjs'

const projectKey = 'storage-benchmark'
const mb = bytes => Number((bytes / 1024 / 1024).toFixed(2))
const ms = value => Number(value.toFixed(2))
if (process.argv[2] === '--measure') {
  const root = process.argv[3], expected = Number(process.argv[4])
  const start = performance.now()
  const store = new MemoryStore({ root }).open()
  const records = store.listAll()
  const loaded = performance.now()
  assert.equal(records.length, expected)
  const index = new MemoryIndex().rebuild(records)
  const ready = performance.now()
  const queries = QUERIES
  const samples = []
  for (let round = 0; round < 20; round++) {
    for (const query of queries) {
      const before = performance.now()
      index.search(query, { projectKey, limit: 40 })
      samples.push(performance.now() - before)
    }
  }
  const firstQueryMs = samples[0]
  samples.sort((a, b) => a - b)
  const heapAfterQueriesMB = mb(process.memoryUsage().heapUsed)
  global.gc?.()
  const heapRetainedMB = mb(process.memoryUsage().heapUsed)
  if (index.size !== records.length) throw new Error(`index was collected or incomplete after GC: ${index.size}/${records.length}`)
  const file = join(root, 'projects', projectKey, 'memories.jsonl')
  const diskBytes = statSync(file).size
  const replacement = buildRecord({ ...records[0], content: '容量验收：已确认的新替换内容', status: 'active' }, { id: 'mem_benchmark_replacement' })
  assert.ok(replacement.ok)
  const replacing = performance.now()
  store.replace(records[0].id, replacement.record)
  const replacementMs = performance.now() - replacing
  const scopes = [{ scope: 'project', projectKey }]
  const reopened = new MemoryStore({ root }).open()
  assert.equal(reopened.find(records[0].id, scopes)?.status, 'superseded')
  assert.equal(reopened.find(replacement.record.id, scopes)?.status, 'active')
  assert.equal(reopened.listAll().filter(r => r.status === 'active').length, expected)
  console.log(JSON.stringify({ records: records.length, freshProcess: true, osCacheFlushed: false,
    storeLoadMs: ms(loaded - start), indexBuildMs: ms(ready - loaded), indexReadyMs: ms(ready - start),
    firstQueryMs: ms(firstQueryMs), queries: samples.length, medianMs: ms(samples[100]), p95Ms: ms(samples[190]),
    heapAfterQueriesMB, heapRetainedAfterGcMB: heapRetainedMB, indexSizeAfterGc: index.size, diskBytes, diskMB: mb(diskBytes),
    replacementMs: ms(replacementMs), replacementScopeRecords: expected, replacementReopenVerified: true,
  }, null, 2))
} else {
  const count = process.argv[2] === undefined ? 50000 : Number(process.argv[2])
  assert.ok(Number.isInteger(count) && count > 0 && count <= 1000000)
  const root = mkdtempSync(join(tmpdir(), 'dsh-memory-storage-bench-'))
  try {
    writeCorpus(root, projectKey, count)
    process.stdout.write(execFileSync(process.execPath, ['--expose-gc', fileURLToPath(import.meta.url), '--measure', root, String(count)], { encoding: 'utf8', maxBuffer: 1024 * 1024 }))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}
