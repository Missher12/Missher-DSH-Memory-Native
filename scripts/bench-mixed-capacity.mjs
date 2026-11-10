/** Current-version isolated mixed-capacity benchmark; no profile, vault, or model downloads. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildRecord } from '../host/records.js'
import { projectIdentity } from '../host/paths.js'
import { saveSource, readSource, captureTaskIdOf, writeCaptureTask } from '../host/capture-journal.js'
import { promoteMemoryToKnowledge, listKnowledgeNotes } from '../host/knowledge.js'
import { openMemoryRuntime } from '../host/startup.js'
import { KnowledgeRecallIndex } from '../host/knowledge-recall.js'
import { SourceCandidateIndex } from '../host/source-index.js'
import { SourcePassageIndex, grantSourceRecall } from '../host/source-passages.js'
import { sourceResolver } from '../host/source-recall.js'
import { SemanticRecallIndex } from '../host/semantic-index.js'
import { LocalEmbedding } from '../host/embedding.js'
import { ObsidianSync } from '../host/obsidian-sync.js'
import { QUERIES } from './bench-corpus.mjs'

const COUNT = 50_000, NOTE_EVERY = 10, SOURCE_COUNT = 10, SOURCE_PARTS = 25, SOURCE_PART_LENGTH = 200
const NOTE_COUNT = COUNT / NOTE_EVERY
let NOW = Number(process.env.DSH_BENCH_NOW) || Date.now()
const PROJECT = projectIdentity('/tmp/dsh-memory-mixed-capacity/current-project').key
const FOREIGN = projectIdentity('/tmp/dsh-memory-mixed-capacity/foreign-project').key
const SCRIPT = fileURLToPath(import.meta.url)
const DEFAULT_OUTPUT = resolve(new URL('../docs/tasks/mixed-capacity-20261110/baseline.json', import.meta.url).pathname)
const round = value => Number(value.toFixed(2))
const elapsed = start => round(performance.now() - start)
const miB = bytes => round(bytes / 1048576)
const percentile95 = values => [...values].sort((a, b) => a - b)[Math.ceil(values.length * .95) - 1] ?? 0
const common = ['中文 检索', '项目 偏好', '记忆 注入', 'SQLite', 'pnpm', '上下文 预算', '设计 方案', '用户 中文', '索引 数据库', '经验 教训']
const contentWords = '存储 决策 经验 上下文 注入 数据库 接口 面板 测试 版本 仓库 方案 设计'.split(' ')

function makeContent(index, id, topic, excerpt = '') {
  if (id === 'mem_p29991') return '旧更新原句：BENCH_UPDATE_OLD；该约定仍完整保留，直到增量轮更新。'
  if (id === 'mem_p29992') return '待遗忘原句：BENCH_FORGET_OLD；该约定只用于验证删除后的索引和阅读页失效。'
  if (id === 'mem_f00000') return 'FOREIGNZEBRA：这条事实只属于外部项目，必须被当前项目检索隔离。'
  if (excerpt) return `用户确认：${excerpt}`
  const terms = common[index % common.length]
  return `第 ${index} 条记忆 ${id}：${topic} 涉及 ${terms} 与 ${contentWords[(index * 7) % contentWords.length]}。完整约定保留适用条件、决定原因、时间范围、项目边界与来源说明；后续更新沿原修订记录维护。`
}

function sourceText(sourceIndex) {
  const anchor = `ZEPHYR${String(sourceIndex).padStart(4, '0')}`
  const chunks = []
  for (let part = 0; part < SOURCE_PARTS; part++) {
    const marker = part === 0 ? `用户原文 ${anchor}` : '用户原文后续'
    const prefix = `${marker} 片段${String(part).padStart(2, '0')}：确认项目归档与备份规则，保留周期和具体处理条件均需按原话核对。`
    chunks.push(prefix + '；'.repeat(SOURCE_PART_LENGTH - prefix.length - 1) + '。')
  }
  return chunks.join('')
}

function writeCorpus(root) {
  const projectFolder = join(root, 'projects', PROJECT), foreignFolder = join(root, 'projects', FOREIGN), globalFolder = join(root, 'global')
  mkdirSync(projectFolder, { recursive: true }); mkdirSync(foreignFolder, { recursive: true }); mkdirSync(globalFolder, { recursive: true })
  const sourceMeta = []
  const sessionId = 'bench-long-source-session'
  for (let index = 0; index < SOURCE_COUNT; index++) {
    const text = sourceText(index), messageId = `bench-message-${index}`
    const saved = saveSource(root, { sessionId, messageId, projectKey: PROJECT, role: 'user', sourceKind: 'user', at: NOW, text })
    const source = readSource(root, saved.id)
    assert.ok(source && source.text === text, `source ${index} full-text readback`)
    assert.equal(grantSourceRecall(root, source, PROJECT), true)
    sourceMeta.push({ ...saved, text })
  }
  const sourceIds = sourceMeta.map(source => source.id)
  const taskId = captureTaskIdOf({ sessionId, turnKey: 'bench-long-mixed-source', segmentIndex: 0, sourceIds, total: 1 })
  const grants = [], sourceEntries = sourceMeta.map(source => ({ sourceId: source.id, from: 0, to: source.text.length }))
  const byScope = { project: [], global: [], foreign: [] }
  const topicCounts = { project: 240, global: 100, foreign: 40 }

  for (let index = 0; index < COUNT; index++) {
    const scopeName = index < 30_000 ? 'project' : index < 45_000 ? 'global' : 'foreign'
    const scope = scopeName === 'global' ? 'global' : 'project'
    const projectKey = scopeName === 'project' ? PROJECT : scopeName === 'foreign' ? FOREIGN : null
    const localIndex = scopeName === 'project' ? index : scopeName === 'global' ? index - 30_000 : index - 45_000
    const prefix = scopeName === 'project' ? 'p' : scopeName === 'global' ? 'g' : 'f'
    const id = `mem_${prefix}${String(localIndex).padStart(5, '0')}`
    const topic = `${scopeName === 'project' ? '项目' : scopeName === 'global' ? '全局' : '隔离'}主题${String(localIndex % topicCounts[scopeName]).padStart(3, '0')}`
    let sourceRef
    if (scopeName === 'project' && localIndex < SOURCE_COUNT * SOURCE_PARTS) {
      const source = sourceMeta[Math.floor(localIndex / SOURCE_PARTS)], part = localIndex % SOURCE_PARTS
      const from = part * SOURCE_PART_LENGTH, to = from + SOURCE_PART_LENGTH, excerpt = source.text.slice(from, to)
      sourceRef = { sourceId: source.id, sessionId, messageId: source.messageId, role: 'user', sourceKind: 'user', from, to, excerpt, at: NOW }
    }
    const result = buildRecord({ kind: ['fact', 'preference', 'decision', 'episode'][index % 4], scope, projectKey,
      content: makeContent(index, id, topic, sourceRef?.excerpt), topic, confidence: .95, importance: .6,
      evidenceRole: sourceRef ? 'user' : 'unknown', captureTaskId: sourceRef ? taskId : null,
      captureKey: sourceRef ? `${taskId}:0:exact` : null, sourceRefs: sourceRef ? [sourceRef] : [] },
    { id, now: NOW - COUNT + index })
    assert.ok(result.ok, result.ok ? '' : result.reason)
    const record = result.record
    byScope[scopeName].push(JSON.stringify(record))
    if (sourceRef) grants.push({ id, revision: record.revision, hash: record.contentHash, sourceId: sourceRef.sourceId, from: sourceRef.from, to: sourceRef.to })
    if (index % NOTE_EVERY === 0) promoteMemoryToKnowledge(root, record)
  }
  writeFileSync(join(projectFolder, 'memories.jsonl'), `${byScope.project.join('\n')}\n`, { mode: 0o600 })
  writeFileSync(join(globalFolder, 'memories.jsonl'), `${byScope.global.join('\n')}\n`, { mode: 0o600 })
  writeFileSync(join(foreignFolder, 'memories.jsonl'), `${byScope.foreign.join('\n')}\n`, { mode: 0o600 })
  writeCaptureTask(root, { id: taskId, sessionId, projectKey: PROJECT, turnKey: 'bench-long-mixed-source',
    segmentIndex: 0, total: 1, sourceIds, status: 'done', callState: 'completed', attempts: 1,
    segment: { entries: sourceEntries }, sourceGrants: grants, createdAt: NOW, updatedAt: NOW })
  return { projectRecords: byScope.project.length, globalRecords: byScope.global.length, foreignRecords: byScope.foreign.length,
    records: COUNT, notes: NOTE_COUNT, sourceCount: SOURCE_COUNT, sourcePartsPerRecord: 1,
    sourceChars: sourceMeta.reduce((sum, source) => sum + source.chars, 0), sourceGrantCount: sourceMeta.length,
    sourceBackedRecords: grants.length, taskId }
}

function memorySnapshot() {
  const usage = process.memoryUsage(), resources = process.resourceUsage()
  return { rssMiB: miB(usage.rss), heapUsedMiB: miB(usage.heapUsed), externalMiB: miB(usage.external), maxRssMiB: round(resources.maxRSS / 1024) }
}

function verifyAuthority(runtime, root) {
  const actual = new Map(runtime.store.listAll({ includeDeleted: true }).map(record => [record.id, record]))
  let records = 0, authorityBytes = 0
  for (const file of [join(root, 'global', 'memories.jsonl'), join(root, 'projects', PROJECT, 'memories.jsonl'), join(root, 'projects', FOREIGN, 'memories.jsonl')]) {
    const text = readFileSync(file, 'utf8'); authorityBytes += Buffer.byteLength(text)
    for (const line of text.trimEnd().split('\n')) {
      const expected = JSON.parse(line), found = actual.get(expected.id)
      assert.ok(found, `missing authority record ${expected.id}`)
      assert.equal(JSON.stringify(found), line, `authority body changed for ${expected.id}`)
      records++
    }
  }
  assert.equal(records, COUNT)
  return { records, authorityBytes }
}

function verifyNotes(runtime, root) {
  const records = new Map(runtime.store.listAll({ includeDeleted: true }).map(record => [record.id, record]))
  const notes = listKnowledgeNotes(root, { includeBody: true })
  assert.equal(notes.length, NOTE_COUNT)
  for (const note of notes) {
    const record = records.get(note.memoryId)
    assert.ok(record && note.body.includes(record.content), `full knowledge note ${note.file}`)
    assert.equal(note.scope, record.scope); assert.equal(note.projectKey, record.projectKey)
  }
  return { notes: notes.length, completeBodiesVerified: notes.length }
}

function queryMeasurements(index, options) {
  const samples = []
  let firstMs = null
  for (let iteration = 0; iteration < 30; iteration++) {
    const start = performance.now()
    index.searchPage(QUERIES[iteration % QUERIES.length], options)
    const ms = performance.now() - start
    if (firstMs === null) firstMs = ms
    samples.push(ms)
  }
  return { firstMs: round(firstMs), stableP95Ms: round(percentile95(samples.slice(1))),
    queries: samples.length, stableQueries: samples.length - 1 }
}

function phaseRuntime(root, phase) {
  const start = performance.now(), runtime = openMemoryRuntime({ root, clock: () => NOW })
  const openMs = elapsed(start), memoryAfterOpen = memorySnapshot()
  const readbackStart = performance.now(), authority = verifyAuthority(runtime, root), knowledge = verifyNotes(runtime, root)
  const readbackMs = elapsed(readbackStart)
  const knowledgeStart = performance.now(), knowledgeIndex = new KnowledgeRecallIndex(root, runtime.store)
  const knowledgeIndexMs = elapsed(knowledgeStart)
  const query = queryMeasurements(runtime.index, { projectKey: PROJECT, now: NOW, limit: 40 })
  const foreignHits = runtime.index.searchPage('FOREIGNZEBRA', { projectKey: PROJECT, now: NOW, limit: 40 })
  const foreignControl = runtime.index.searchPage('FOREIGNZEBRA', { projectKey: FOREIGN, now: NOW, limit: 40 })
  assert.equal(foreignHits.hits.some(hit => hit.record.projectKey === FOREIGN), false)
  assert.ok(foreignControl.hits.some(hit => hit.record.id === 'mem_f00000'), 'foreign marker is indexed in its owning scope')
  const result = { phase, openMs, cacheHit: runtime.metrics.cacheHit, metrics: runtime.metrics, memoryAfterOpen,
    memoryAfterWork: memorySnapshot(), readbackMs, authority, knowledge, knowledgeIndexMs, knowledgeIndexSize: knowledgeIndex.size,
    lexicalQuery: query, foreignScopeExcluded: true, foreignPositiveControl: true }
  runtime.dispose()
  return result
}

async function modelSample() {
  const modelDir = new LocalEmbedding({ allowDownload: false })
  const start = performance.now(), pending = modelDir.embed(['容量基准真实模型查询'], 'query')
  while (modelDir.state !== 'ready' && modelDir.state !== 'failed') await new Promise(resolve => setImmediate(resolve))
  const initializationMs = elapsed(start)
  const first = await pending, firstCompleteMs = elapsed(start)
  const querySamples = [], passages = Array.from({ length: 4 }, (_, index) => sourceText(index).slice(0, 420))
  const passageStart = performance.now(), passageVectors = await modelDir.embed(passages, 'passage'), passageMs = elapsed(passageStart)
  for (let index = 0; index < 10; index++) {
    const before = performance.now(); await modelDir.embed([`容量基准真实模型查询 ${index}`], 'query'); querySamples.push(performance.now() - before)
  }
  modelDir.dispose()
  return { model: 'multilingual-e5-small-761b726-v1', allowDownload: false, state: 'ready', initializationMs,
    firstQueryEmbedMs: round(firstCompleteMs - initializationMs), firstCallMs: firstCompleteMs,
    stableQueryP95Ms: round(percentile95(querySamples)), actualPassageSample: { count: passages.length, charsEach: 420,
      embedMs: passageMs, vectors: passageVectors.length }, firstQueryVectorSize: first[0]?.length ?? 0 }
}

function allMarkdown(dir) {
  const result = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = join(dir, entry.name)
    if (entry.isDirectory()) result.push(...allMarkdown(file))
    else if (entry.isFile() && file.endsWith('.md')) result.push(file)
  }
  return result
}

async function sourceMaintenancePhase(root, phase) {
  const runtimeStart = performance.now(), runtime = openMemoryRuntime({ root, clock: () => NOW }), runtimeOpenMs = elapsed(runtimeStart)
  const knowledgeStart = performance.now(), knowledge = new KnowledgeRecallIndex(root, runtime.store), knowledgeIndexMs = elapsed(knowledgeStart)
  const sourceIndex = new SourceCandidateIndex(runtime.store)
  const candidateTimes = []
  let sourceCandidates = []
  for (let iteration = 0; iteration < 8; iteration++) {
    const start = performance.now()
    sourceCandidates = sourceIndex.search('ZEPHYR0000', { projectKey: PROJECT, now: NOW, limit: 40 })
    candidateTimes.push(performance.now() - start)
  }
  const resolver = sourceResolver(root, runtime.store, PROJECT, NOW), resolverStart = performance.now()
  const resolved = resolver({ query: 'ZEPHYR0000', detail: null, entityTerms: [] }, sourceCandidates)
  const sourceResolverMs = elapsed(resolverStart)

  const passageIndex = new SourcePassageIndex(root), passageBuildStart = performance.now()
  const allPassages = passageIndex.candidates(PROJECT), passageIndexBuildMs = elapsed(passageBuildStart)
  const uniquePassageSources = new Set(allPassages.map(hit => hit.record.sourceRefs[0].sourceId)).size
  const validationStart = performance.now()
  const validated = typeof passageIndex.validateMany === 'function'
    ? passageIndex.validateMany(allPassages, PROJECT)
    : allPassages.filter(hit => passageIndex.validate(hit, PROJECT))
  const allPassageValidationMs = elapsed(validationStart)
  const passageQueryTimes = []
  let passageHits = []
  for (let iteration = 0; iteration < 10; iteration++) {
    const start = performance.now()
    passageHits = passageIndex.search('ZEPHYR0000', { projectKey: PROJECT, now: NOW, limit: 40 })
    passageQueryTimes.push(performance.now() - start)
  }
  assert.ok(resolved, 'a fully granted long source excerpt resolves')
  assert.ok(validated.length > 0)

  const result = { phase, runtimeOpenMs, knowledgeIndexMs, sourceCandidateIndex: { firstMs: round(candidateTimes[0]), stableQueryP95Ms: round(percentile95(candidateTimes.slice(1))),
      repeatedQueries: candidateTimes.length, lastHits: sourceCandidates.length },
    sourceResolver: { ms: sourceResolverMs, resolved: Boolean(resolved), candidateCount: sourceCandidates.length, sourceId: resolved?.sourceId ?? null },
    sourcePassages: { buildMs: passageIndexBuildMs, segments: allPassages.length, uniqueSources: uniquePassageSources,
      validateCallsBaseline: allPassages.length, validateCallsGrouped: uniquePassageSources,
      validated: validated.length, allValidationMs: allPassageValidationMs, queryHits: passageHits.length,
      queryValidationCallsBaseline: passageHits.length, queryUniqueSources: new Set(passageHits.map(hit => hit.record.sourceRefs[0].sourceId)).size,
      firstQueryMs: round(passageQueryTimes[0]), queryStableP95Ms: round(percentile95(passageQueryTimes.slice(1))),
      repeatedQueries: passageQueryTimes.length, stableQueries: passageQueryTimes.length - 1 },
    sourcePassageCorpus: { segments: allPassages.length, activeMemoryRecords: 45_000, fullKnowledgeNotes: NOTE_COUNT },
    memory: memorySnapshot() }
  passageIndex; runtime.dispose()
  return result
}

async function semanticSamplePhase(root, phase) {
  const runtime = openMemoryRuntime({ root, clock: () => NOW })
  const knowledge = new KnowledgeRecallIndex(root, runtime.store)
  const corpus = [
    ...runtime.store.list('project', PROJECT).slice(0, 40),
    ...runtime.store.list('global', null).slice(0, 15),
    ...knowledge.candidates(PROJECT, { now: NOW, limit: 20 }).map(hit => hit.record),
  ].filter(record => !record.quoted)
  const semantic = new SemanticRecallIndex(root, { enabled: true, engine: new LocalEmbedding({ allowDownload: false }) })
  const cacheFile = join(root, '.cache', 'semantic', 'multilingual-e5-small-761b726-v1', `${PROJECT}.jsonl`)
  if (phase === 'semantic-sample-first') {
    const buildStart = performance.now(), firstSearchStart = performance.now()
    const firstResult = await semantic.search(['项目主题017 备份保留周期'], corpus, { projectKey: PROJECT, waitMs: 60_000 })
    const firstSearchMs = elapsed(firstSearchStart)
    await semantic.settle()
    const fullBuildMs = elapsed(buildStart), status = semantic.status(), stableTimes = []
    for (let iteration = 0; iteration < 8 && status.state === 'ready'; iteration++) {
      const start = performance.now()
      await semantic.search([QUERIES[iteration % QUERIES.length]], corpus, { projectKey: PROJECT, waitMs: 60_000 })
      stableTimes.push(performance.now() - start)
    }
    const result = { phase, corpusRecords: corpus.length, firstSearchMs, fullBuildMs, status,
      firstQueryHits: firstResult[0]?.length ?? 0, stableQueries: stableTimes.length,
      stableQueryP95Ms: stableTimes.length ? round(percentile95(stableTimes)) : null,
      cacheBytes: statMaybe(cacheFile) ? statSync(cacheFile).size : 0, fullCorpusEmbedded: false }
    semantic.dispose(); runtime.dispose(); return result
  }
  const times = []
  for (let iteration = 0; iteration < 8; iteration++) {
    const start = performance.now()
    await semantic.search([QUERIES[iteration % QUERIES.length]], corpus, { projectKey: PROJECT, waitMs: 60_000 })
    times.push(performance.now() - start)
  }
  const result = { phase, corpusRecords: corpus.length, fullCacheReopen: semantic.status(), searchCount: times.length,
    firstQueryMs: round(times[0]), stableQueryP95Ms: round(percentile95(times.slice(1))), stableQueries: times.length - 1,
    cacheBytes: statMaybe(cacheFile) ? statSync(cacheFile).size : 0, fullCorpusEmbedded: false }
  semantic.dispose(); runtime.dispose(); return result
}

async function syncFirstPhase(root, vault) {
  const runtime = openMemoryRuntime({ root, clock: () => NOW }), config = { vaultPath: vault, folder: 'DSH Memory', autoSync: true }
  const dshFolder = join(vault, config.folder)
  const sync = new ObsidianSync({ root, store: runtime.store, index: runtime.index, getConfig: () => config, synchronize: runtime.synchronize })
  let start = performance.now(), initial = await sync.run(), initialMs = elapsed(start)
  start = performance.now(); const stable = await sync.run(); const unchangedSecondMs = elapsed(start)
  const output = { initialMs, unchangedSecondMs, exported: initial.exported, imported: initial.imported,
    initialErrors: initial.errors.length, stableErrors: stable.errors.length,
    sourceFiles: readdirSync(dshFolder).filter(name => name.startsWith('mem_') && name.endsWith('.md')).length,
    noteFiles: readdirSync(join(dshFolder, 'knowledge')).filter(name => name.endsWith('.md')).length,
    readingFiles: allMarkdown(join(dshFolder, '阅读')).length, memory: memorySnapshot() }
  assert.equal(initial.errors.length, 0); assert.equal(stable.errors.length, 0)
  sync.dispose(); runtime.dispose()
  return output
}

async function syncIncrementalPhase(root, vault) {
  const runtime = openMemoryRuntime({ root, clock: () => NOW }), config = { vaultPath: vault, folder: 'DSH Memory', autoSync: true }
  const sync = new ObsidianSync({ root, store: runtime.store, index: runtime.index, getConfig: () => config, synchronize: runtime.synchronize })
  const reopenStart = performance.now(), reopened = await sync.run(), reopenMs = elapsed(reopenStart)
  assert.equal(reopened.errors.length, 0)
  const scopes = [{ scope: 'project', projectKey: PROJECT }]
  const mutationStart = performance.now()
  runtime.store.update('mem_p29991', { content: '更新后的完整原句：BENCH_UPDATE_NEW；确认此次变更应进入增量阅读索引。' }, scopes)
  runtime.store.remove('mem_p29992', scopes)
  const mutationMs = elapsed(mutationStart)
  const incrementalStart = performance.now(), result = await sync.run(), incrementalMs = elapsed(incrementalStart)
  assert.equal(result.errors.length, 0)
  const readingText = allMarkdown(join(vault, 'DSH Memory', '阅读')).map(file => readFileSync(file, 'utf8')).join('\n')
  assert.ok(readingText.includes('BENCH_UPDATE_NEW'))
  assert.equal(readingText.includes('BENCH_UPDATE_OLD'), false)
  assert.equal(readingText.includes('BENCH_FORGET_OLD'), false)
  assert.equal(statMaybe(join(vault, 'DSH Memory', 'mem_p29992.md')), false)
  assert.ok(runtime.index.searchPage('BENCH_UPDATE_NEW', { projectKey: PROJECT, now: NOW }).hits.some(hit => hit.record.id === 'mem_p29991'))
  assert.equal(runtime.index.searchPage('BENCH_FORGET_OLD', { projectKey: PROJECT, now: NOW }).hits.some(hit => hit.record.id === 'mem_p29992'), false)
  const output = { reopenMs, reopenedErrors: reopened.errors.length, mutationMs, incrementalMs,
    updateAndForgetErrors: result.errors.length, oldUpdateTextRemoved: true, forgottenTextRemoved: true,
    forgottenSourceNoteRemoved: true, indexUpdatedAndForgotten: true, memory: memorySnapshot() }
  sync.dispose(); runtime.dispose()
  return output
}

function statMaybe(file) { try { statSync(file); return true } catch { return false } }

async function worker(phase, root, vault) {
  if (phase === 'cold-runtime' || phase === 'warm-runtime') return phaseRuntime(root, phase)
  if (phase === 'model-sample') return modelSample()
  if (phase === 'source-maintenance') return sourceMaintenancePhase(root, phase)
  if (phase === 'semantic-sample-first' || phase === 'semantic-sample-reopen') return semanticSamplePhase(root, phase)
  if (phase === 'sync-first') return syncFirstPhase(root, vault)
  if (phase === 'sync-reopen-incremental') return syncIncrementalPhase(root, vault)
  throw new Error(`Unknown benchmark phase ${phase}`)
}

if (process.argv[2] === '--worker') {
  const [, , , phase, root, vault] = process.argv
  try { process.stdout.write(JSON.stringify(await worker(phase, root, vault))) }
  catch (error) { process.stdout.write(JSON.stringify({ phase, error: error.message, stack: error.stack, memory: memorySnapshot() })); process.exitCode = 2 }
} else {
  const root = mkdtempSync(join(tmpdir(), 'dsh-memory-mixed-capacity-')), vault = join(root, 'isolated-vault')
  const outputFile = resolve(process.env.DSH_BENCH_OUTPUT || DEFAULT_OUTPUT)
  const report = { environment: { node: process.version, platform: process.platform, arch: process.arch,
      cpu: (await import('node:os')).cpus()[0]?.model ?? 'unknown', osCacheFlushed: false,
      fullDshStartupMeasured: false, defaultModelModified: false }, corpus: null, phases: {} }
  mkdirSync(vault, { recursive: true })
  const save = () => { mkdirSync(join(outputFile, '..'), { recursive: true }); writeFileSync(outputFile, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 }) }
  const run = phase => {
    process.stdout.write(`Running ${phase}...\n`)
    const child = spawnSync(process.execPath, [SCRIPT, '--worker', phase, root, vault], {
      encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, env: { ...process.env, DSH_BENCH_NOW: String(NOW) },
    })
    let result
    try { result = JSON.parse(child.stdout) }
    catch { result = { phase, error: child.error?.message ?? child.stderr ?? 'worker returned invalid JSON' } }
    if (child.status !== 0 && !result.error) result.error = child.error?.message ?? child.stderr ?? `worker exited ${child.status}`
    report.phases[phase] = result; save()
    if (result.error) process.stdout.write(`Phase reported: ${result.error}\n`)
    return result
  }
  try {
    process.stdout.write('Generating isolated corpus (50,000 memories, 5,000 full notes, 10 long sources)...\n')
    report.corpus = writeCorpus(root); NOW = Date.now()
    report.environment.benchmarkNow = NOW; report.environment.benchmarkTime = new Date(NOW).toISOString(); save()
    const projectBytes = statSync(join(root, 'projects', PROJECT, 'memories.jsonl')).size
    const globalBytes = statSync(join(root, 'global', 'memories.jsonl')).size
    const foreignBytes = statSync(join(root, 'projects', FOREIGN, 'memories.jsonl')).size
    report.corpus.authorityBytes = projectBytes + globalBytes + foreignBytes; report.corpus.projectKey = PROJECT; report.corpus.foreignProjectKey = FOREIGN; save()
    const selected = process.env.DSH_BENCH_PHASES ? new Set(process.env.DSH_BENCH_PHASES.split(',').map(value => value.trim())) : null
    const selectedRun = phase => selected === null || selected.has(phase) ? run(phase) : null
    selectedRun('cold-runtime')
    selectedRun('warm-runtime')
    selectedRun('model-sample')
    selectedRun('source-maintenance')
    selectedRun('semantic-sample-first')
    if (!report.phases['semantic-sample-first']?.error) selectedRun('semantic-sample-reopen')
    selectedRun('sync-first')
    selectedRun('sync-reopen-incremental')
    report.method = { notes: '5,000 complete promoted notes; full bodies read back against linked authority',
      longUserSources: '10 saved, compressed, read-back verified 5,000-character user messages; 250 exact 200-character granted excerpts',
      semanticModel: 'real LocalEmbedding with allowDownload=false; four-passage sample and 75-record semantic index sample; full corpus embedding is excluded',
      queryPercentile: 'nearest-rank p95 over the listed repeated queries', updateForget: 'one project memory updated and one forgotten after Obsidian state reopen' }
    save()
    process.stdout.write(`${JSON.stringify({ outputFile, phases: Object.keys(report.phases), corpus: report.corpus }, null, 2)}\n`)
  } finally { rmSync(root, { recursive: true, force: true }) }
}
