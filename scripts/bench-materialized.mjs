/** Compare fresh-process search after all 50k original records are read back.
 * Run with Node 24: node scripts/bench-materialized.mjs
 * DSH_BENCH_FAST1_PACKAGE and DSH_BENCH_OLD_PACKAGE can override read-only references.
 * DSH_BENCH_GC=1 additionally samples heap after GC, including the test fixture.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { QUERIES, writeCorpus } from './bench-corpus.mjs'

const NOW = 1_793_865_600_000
const PROJECT = 'installed-50k-qa'
const COUNT = 50000
const SCRIPT = fileURLToPath(import.meta.url)
const SOURCE = fileURLToPath(new URL('../', import.meta.url))
const FAST1 = resolve(process.env.DSH_BENCH_FAST1_PACKAGE || '/Users/missher/.dsh/profiles/desktop/node_modules/@missher/dsh-memory')
const OLD = resolve(process.env.DSH_BENCH_OLD_PACKAGE || new URL('../docs/tasks/codex-terra-50k-20261105/reference-0.2.18/', import.meta.url).pathname)
const rounded = (n) => Number(n.toFixed(2))

if (process.argv[2] === '--worker') {
  const [root, packageDir, mode] = process.argv.slice(3)
  const load = (name) => import(pathToFileURL(join(packageDir, 'host', name)).href)
  let runtime
  const start = performance.now()
  if (mode === 'old') {
    const { MemoryStore } = await load('store.js')
    const { MemoryIndex } = await load('search.js')
    const store = new MemoryStore({ root, clock: () => NOW }).open()
    runtime = { store, index: new MemoryIndex().rebuild(store.listAll()), metrics: { reference: true }, dispose() {} }
  } else {
    const { openMemoryRuntime } = await load('startup.js')
    runtime = openMemoryRuntime({ root, clock: () => NOW })
  }
  const openMs = performance.now() - start
  const records = runtime.store.listAll()
  const file = join(root, 'projects', PROJECT, 'memories.jsonl')
  const expected = readFileSync(file, 'utf8').trimEnd().split('\n').map(JSON.parse)
  assert.equal(runtime.index.size, COUNT)
  assert.equal(records.length, COUNT)
  const byId = new Map(records.map((record) => [record.id, record]))
  for (const record of expected) {
    const actual = byId.get(record.id)
    assert.deepEqual(actual, record)
    assert.equal(JSON.stringify(actual), JSON.stringify(record))
  }
  const options = { projectKey: PROJECT, now: NOW, limit: 40 }
  const queries = QUERIES.map((query) => runtime.index.searchPage(query, options))
  const timings = []
  for (let i = 0; i < 30; i++) {
    const before = performance.now()
    runtime.index.searchPage(QUERIES[i % QUERIES.length], options)
    timings.push(performance.now() - before)
  }
  timings.sort((a, b) => a - b)
  const pages = QUERIES.slice(0, 3).map((query) => runtime.index.searchPage(query, { ...options, offset: 40 }))
  if (global.gc) global.gc()
  const heapWithFixtureMiB = global.gc ? rounded(process.memoryUsage().heapUsed / 1048576) : null
  runtime.dispose()
  console.log(JSON.stringify({ openMs: rounded(openMs), cacheHit: runtime.metrics.cacheHit ?? null, recordsCompared: records.length,
    queryMedianMs: rounded(timings[15]), queryP95Ms: rounded(timings[28]), heapWithFixtureMiB, queries, pages }))
} else {
  assert.equal(JSON.parse(readFileSync(join(OLD, 'package.json'), 'utf8')).version, '0.2.18-native.20261105')
  assert.equal(JSON.parse(readFileSync(join(FAST1, 'package.json'), 'utf8')).version, '0.2.19-native.20261105-fast1')
  const root = mkdtempSync(join(tmpdir(), 'dsh-materialized-bench-'))
  try {
    const roots = Object.fromEntries(['old', 'fast1', 'candidate'].map((key) => [key, join(root, key)]))
    writeCorpus(roots.old, PROJECT, COUNT, NOW)
    const original = join(roots.old, 'projects', PROJECT, 'memories.jsonl')
    for (const key of ['fast1', 'candidate']) {
      const dir = join(roots[key], 'projects', PROJECT)
      mkdirSync(dir, { recursive: true })
      copyFileSync(original, join(dir, 'memories.jsonl'))
    }
    const run = (key, packageDir, mode) => {
      process.stdout.write(`Running ${key}...\n`)
      const args = [...(process.env.DSH_BENCH_GC === '1' ? ['--expose-gc'] : []), SCRIPT, '--worker', roots[key], packageDir, mode]
      return JSON.parse(execFileSync(process.execPath, args,
        { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }))
    }
    const old = run('old', OLD, 'old')
    const fast1 = [run('fast1', FAST1, 'new'), run('fast1', FAST1, 'new'), run('fast1', FAST1, 'new')]
    // Reopen the unchanged fast1 cache with the candidate, as an upgrade does.
    const upgrade = run('fast1', SOURCE, 'new')
    const candidate = [run('candidate', SOURCE, 'new'), run('candidate', SOURCE, 'new'), run('candidate', SOURCE, 'new'), run('candidate', SOURCE, 'new')]
    assert.equal(fast1[0].cacheHit, false)
    assert.equal(candidate[0].cacheHit, false)
    assert.equal(upgrade.cacheHit, true)
    for (const result of [...fast1.slice(1), ...candidate.slice(1)]) assert.equal(result.cacheHit, true)
    for (const result of [...fast1, upgrade, ...candidate]) {
      assert.deepEqual(result.queries, old.queries)
      assert.deepEqual(result.pages, old.pages)
    }
    const authority = readFileSync(original)
    for (const key of ['fast1', 'candidate']) assert.deepEqual(readFileSync(join(roots[key], 'projects', PROJECT, 'memories.jsonl')), authority)
    for (const result of [old, ...fast1, upgrade, ...candidate]) { delete result.queries; delete result.pages }
    const report = { records: COUNT, fullRecordReadbackBeforeQueries: true, originalAndJsonOrderVerified: true,
      osCacheFlushed: false, baseline: old, fast1, upgrade, candidate, queryResultsEqual: true, pagesEqual: 3 }
    if (process.env.DSH_BENCH_OUTPUT) writeFileSync(process.env.DSH_BENCH_OUTPUT, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
    console.log(JSON.stringify(report, null, 2))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}
