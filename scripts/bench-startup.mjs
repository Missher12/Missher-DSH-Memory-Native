/**
 * Full-corpus startup, real pre-step handler, gateway self-test, and 0.2.18 comparison.
 * Uses isolated temporary data, fixed time and fresh Node processes; no model calls.
 * Run: node scripts/bench-startup.mjs [count]
 * DSH_MEMORY_REFERENCE can point to the read-only 0.2.18 package directory.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { buildRecord } from '../host/records.js'
import { projectIdentity } from '../host/paths.js'
import { QUERIES, writeCorpus } from './bench-corpus.mjs'

const NOW = 1_793_865_600_000
const CWD = '/tmp/dsh-memory-capacity-benchmark-project'
const PROJECT = projectIdentity(CWD).key
const SCRIPT = fileURLToPath(import.meta.url)
const LOADER = fileURLToPath(new URL('./bench-typert-loader.mjs', import.meta.url))
const DEFAULT_REFERENCE = '/Users/missher/.dsh/profiles/desktop/node_modules/@missher/dsh-memory'
const round = (n) => Number(n.toFixed(2))

if (process.argv[2] !== '--worker') {
  const count = process.argv[2] === undefined ? 50000 : Number(process.argv[2])
  assert.ok(Number.isInteger(count) && count > 0 && count <= 1_000_000)
  const reference = resolve(process.env.DSH_MEMORY_REFERENCE || DEFAULT_REFERENCE)
  assert.equal(JSON.parse(readFileSync(join(reference, 'package.json'), 'utf8')).version, '0.2.18-native.20261105')
  const root = mkdtempSync(join(tmpdir(), 'dsh-memory-startup-bench-'))
  const run = (phase, loader = false) => {
    process.stdout.write(`Running ${phase}...\n`)
    const args = [...(loader ? ['--import', LOADER] : []), SCRIPT, '--worker', phase, root, String(count), reference]
    return JSON.parse(execFileSync(process.execPath, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }))
  }
  try {
    writeCorpus(root, PROJECT, count, NOW)
    const authorityBytes = statSync(join(root, 'projects', PROJECT, 'memories.jsonl')).size
    const legacy = run('legacy-search')
    const cold = run('cold-host', true)
    const warm = run('warm-host', true)
    const warmRepeats = [run('warm-host', true), run('warm-host', true)]
    assert.equal(cold.preStep.injected, true)
    assert.deepEqual(warm.preStep.memoryText, cold.preStep.memoryText)
    for (const sample of warmRepeats) assert.deepEqual(sample.preStep.memoryText, cold.preStep.memoryText)
    let legacyHost
    if (process.env.DSH_BENCH_OLD_PROOF) {
      const prior = JSON.parse(readFileSync(process.env.DSH_BENCH_OLD_PROOF, 'utf8'))
      assert.equal(prior.count, count)
      assert.equal(prior.fixedNow, NOW)
      assert.equal(prior.projectKey, PROJECT)
      legacyHost = { ...prior.legacyHost, reusedFrom: process.env.DSH_BENCH_OLD_PROOF }
    } else {
      legacyHost = run('legacy-host')
      assert.equal(legacyHost.preStep.injected, true)
      assert.deepEqual(legacyHost.preStep.memoryText, cold.preStep.memoryText)
    }
    const comparison = run('compare-and-replace')
    const replacement = run('reopen-replacement')
    const report = { count, fixedNow: NOW, projectKey: PROJECT, authorityBytes, osCacheFlushed: false,
      source: 'isolated synthetic corpus; gateway shim; no DSH profile or model call', legacy, cold, warm, warmRepeats, legacyHost, comparison, replacement }
    for (const entry of [report.cold, report.warm, ...report.warmRepeats, report.legacyHost]) delete entry.preStep.memoryText
    if (process.env.DSH_BENCH_OUTPUT) writeFileSync(process.env.DSH_BENCH_OUTPUT, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
    console.log(JSON.stringify(report, null, 2))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
} else {
  const phase = process.argv[3], root = process.argv[4], count = Number(process.argv[5]), reference = process.argv[6]
  Date.now = () => NOW
  const authorityFile = join(root, 'projects', PROJECT, 'memories.jsonl')
  const cacheFile = join(root, 'derived-index-v1.bin')
  const referenceFile = join(root, 'reference-search.json')
  const load = async (module) => import(pathToFileURL(join(reference, 'host', module)).href)
  const options = { projectKey: PROJECT, now: NOW, limit: 40 }
  const queries = Array.from({ length: 20 }, () => QUERIES).flat()
  const save = (value) => process.stdout.write(JSON.stringify(value))

  if (phase === 'legacy-search') {
    const { MemoryStore } = await load('store.js')
    const { MemoryIndex } = await load('search.js')
    const storeStart = performance.now()
    const store = new MemoryStore({ root }).open(), records = store.listAll()
    const loaded = performance.now()
    const index = new MemoryIndex().rebuild(records)
    const ready = performance.now()
    assert.equal(index.size, count)
    const samples = [], results = []
    for (const query of queries) {
      const t = performance.now()
      const page = index.searchPage(query, options)
      samples.push(performance.now() - t)
      results.push(JSON.stringify(page))
    }
    for (const query of ['中文 检索', '项目 偏好', '记忆 注入']) {
      results.push(JSON.stringify(index.searchPage(query, { ...options, offset: 40 })))
    }
    writeFileSync(referenceFile, JSON.stringify(results))
    const firstQueryMs = samples[0]
    samples.sort((a, b) => a - b)
    save({ storeMs: round(loaded - storeStart), indexMs: round(ready - loaded), readyMs: round(ready - storeStart),
      firstQueryMs: round(firstQueryMs), medianMs: round(samples[100]), p95Ms: round(samples[190]), queries: queries.length })
  } else if (phase === 'cold-host' || phase === 'warm-host' || phase === 'legacy-host') {
    const old = phase === 'legacy-host'
    const { apply } = old ? await import(pathToFileURL(join(reference, 'index.js')).href) : await import('../index.js')
    const handlers = {}, disposers = [], gatewayTimes = [], warnings = []
    let metrics = null
    const gateway = { async invoke({ method, args }) {
      const start = performance.now()
      const result = await ctx.remote[method](args.input)
      gatewayTimes.push({ method, ms: round(performance.now() - start) })
      return result
    } }
    const ctx = {
      get(key) { if (key === 'typertGateway') return gateway },
      on(name, handler) { handlers[name] = handler; return () => {} },
      effect(factory) { const dispose = factory(); if (typeof dispose === 'function') disposers.push(dispose) },
      logger: { info() {}, warn(message) { warnings.push(message) }, debug(message) {
        const prefix = '[dsh-memory] startup metrics '
        if (message.startsWith(prefix)) metrics = JSON.parse(message.slice(prefix.length))
      } },
    }
    const start = performance.now()
    apply(ctx, { dataDir: root, maintenance: { enabled: false }, capture: { enabled: false } })
    const applied = performance.now()
    assert.equal(typeof handlers['agent/pre-step'], 'function')
    if (!old) {
      for (let i = 0; i < 100 && gatewayTimes.length < 5; i++) await new Promise((r) => setTimeout(r, 5))
      await new Promise((r) => setImmediate(r))
      assert.deepEqual(gatewayTimes.map((x) => x.method), ['stats', 'list', 'profile', 'knowledgeGraph', 'knowledgeList'])
      const diagnostic = JSON.parse(readFileSync(join(root, 'panel-transport.json'), 'utf8'))
      assert.equal(diagnostic.selfTest?.ok, true)
    }
    const afterGateway = performance.now()
    const messages = [{ role: 'user', content: '编号 100 的记忆是什么' }]
    const decision = { kind: 'enter', messages }
    const recallStart = performance.now()
    const result = await handlers['agent/pre-step']({ agent: { session: { header: { cwd: CWD } } }, messages }, async () => decision)
    const recallEnd = performance.now()
    const memory = result.messages.find((message) => message.source?.kind === 'memory')
    const memoryText = memory?.content?.map((block) => block.text).join('\n') ?? null
    for (const dispose of disposers) dispose()
    save({ applyMs: round(applied - start), runtime: metrics, gatewayAfterApplyMs: round(afterGateway - applied), gatewayTimes,
      preStep: { ms: round(recallEnd - recallStart), injected: memoryText !== null, memoryText },
      startToRecallCompleteMs: round(recallEnd - start), cacheBytes: old ? null : statSync(cacheFile).size, warnings })
  } else if (phase === 'compare-and-replace') {
    const { openMemoryRuntime } = await import('../host/startup.js')
    const runtime = openMemoryRuntime({ root, clock: () => NOW })
    assert.equal(runtime.metrics.cacheHit, true)
    assert.equal(runtime.index.size, count)
    const expected = JSON.parse(readFileSync(referenceFile, 'utf8'))
    const samples = []
    let firstQueryMs = null
    for (let i = 0; i < queries.length; i++) {
      const start = performance.now(), page = runtime.index.searchPage(queries[i], options), elapsed = performance.now() - start
      if (i === 0) firstQueryMs = elapsed
      samples.push(elapsed)
      assert.equal(JSON.stringify(page), expected[i], `query ${i} differs from 0.2.18`)
    }
    for (let i = 0; i < 3; i++) {
      const page = runtime.index.searchPage(['中文 检索', '项目 偏好', '记忆 注入'][i], { ...options, offset: 40 })
      assert.equal(JSON.stringify(page), expected[queries.length + i], `page ${i} differs from 0.2.18`)
    }
    samples.sort((a, b) => a - b)
    // Each generated record has its own numeric term. Check every posting,
    // in addition to exercising the 200 real searches above.
    const snapshot = runtime.index.snapshot()
    for (let i = 0; i < count; i++) {
      const term = snapshot.termIds.get(String(i)), slot = snapshot.slotById.get(`mem_${i}`)
      assert.notEqual(term, undefined, `record ${i} has no indexed term`)
      assert.notEqual(slot, undefined, `record ${i} has no index slot`)
      const start = snapshot.postings.offsets[term], end = snapshot.postings.offsets[term + 1]
      assert.equal(end - start, 1, `record ${i} has unexpected numeric postings`)
      assert.equal(snapshot.postings.slots[start], slot, `record ${i} is not reachable by its numeric term`)
    }
    const authorityLines = readFileSync(authorityFile, 'utf8').trimEnd().split('\n')
    const records = runtime.store.listAll()
    assert.equal(records.length, count)
    for (let i = 0; i < count; i++) assert.equal(JSON.stringify(records[i]), authorityLines[i], `record ${i} changed`)
    const old = runtime.store.find('mem_0', [{ scope: 'project', projectKey: PROJECT }])
    const replacement = buildRecord({ ...old, content: '容量验收：已确认的新替换内容', status: 'active' }, { id: 'mem_benchmark_replacement', now: NOW })
    assert.ok(replacement.ok)
    const before = performance.now()
    runtime.store.replace(old.id, replacement.record)
    const replacementMs = performance.now() - before
    await new Promise((r) => setTimeout(r, 350))
    const cacheBytes = statSync(cacheFile).size
    runtime.dispose()
    save({ cacheHit: true, recordsCompared: count, uniquePostingsVerified: count, queriesMatched: queries.length, pagesMatched: 3,
      firstQueryMs: round(firstQueryMs), medianMs: round(samples[100]), p95Ms: round(samples[190]),
      replacementMs: round(replacementMs), cacheBytes })
  } else if (phase === 'reopen-replacement') {
    const { openMemoryRuntime } = await import('../host/startup.js')
    const runtime = openMemoryRuntime({ root, clock: () => NOW })
    const scopes = [{ scope: 'project', projectKey: PROJECT }]
    assert.equal(runtime.store.find('mem_0', scopes)?.status, 'superseded')
    assert.equal(runtime.store.find('mem_benchmark_replacement', scopes)?.status, 'active')
    assert.equal(runtime.store.listAll().filter((record) => record.status === 'active').length, count)
    assert.ok(runtime.index.search('新替换内容', options).some((hit) => hit.record.id === 'mem_benchmark_replacement'))
    assert.ok(runtime.store.history('mem_0', scopes).length >= 2)
    save({ freshProcess: true, cacheHit: runtime.metrics.cacheHit, readyMs: round(runtime.metrics.readyMs), activeRecords: count,
      indexSize: runtime.index.size, old: 'superseded', replacement: 'active', historyPreserved: true })
    runtime.dispose()
  } else throw new Error(`unknown worker phase ${phase}`)
}
