import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import fs from 'node:fs'
import test from 'node:test'
import { syncBuiltinESMExports } from 'node:module'

import { CapturePipeline } from '../host/capture.js'
import {
  captureStorageStatus,
  captureTaskIdOf,
  compactCaptureLedgers,
  compressCaptureSources,
  readSource,
  readTurnIntakes,
  readCaptureTasks,
  saveSource,
  writeCaptureTask,
} from '../host/capture-journal.js'
import { resolveConfig } from '../host/config.js'
import { projectIdentity } from '../host/paths.js'
import { MemoryIndex } from '../host/search.js'
import { MemoryStore } from '../host/store.js'

const NOW = 1_800_000_000_000
const CWD = '/tmp/capacity-project'
const KEY = projectIdentity(CWD).key

function pipelineFor(root, store, index) {
  return new CapturePipeline({
    store,
    index,
    config: resolveConfig({ capture: { minTurnChars: 0 } }),
    clock: () => NOW,
    ctx: { get: () => undefined },
  })
}

test('maintenance compresses sources and never deletes user originals', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-memory-capacity-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const store = new MemoryStore({ root, clock: () => NOW }).open()
  const index = new MemoryIndex()
  const referenced = saveSource(root, { sessionId: 's', messageId: 'm-ref', role: 'user', sourceKind: 'user', at: NOW, text: '被记忆引用的原文' })
  const taskSource = saveSource(root, { sessionId: 's', messageId: 'm-task', role: 'user', sourceKind: 'user', at: NOW, text: '待处理任务的原文' })
  const doneSource = saveSource(root, { sessionId: 's', messageId: 'm-done', role: 'user', sourceKind: 'user', at: NOW, text: '已完成任务且无记忆引用的原文' })
  const unknownSource = saveSource(root, { sessionId: 's', messageId: 'm-unknown', role: 'user', sourceKind: 'user', at: NOW, text: '未知任务必须保留的原文' })
  const orphan = saveSource(root, { sessionId: 's', messageId: 'm-orphan', role: 'user', sourceKind: 'user', at: NOW, text: '无人引用的旧原文' })
  const record = store.write({
    kind: 'fact', scope: 'project', projectKey: KEY, content: '容量测试事实', confidence: 0.9,
    sourceRefs: [{ sourceId: referenced.id, sessionId: 's', role: 'user', sourceKind: 'user' }],
  }).record
  index.upsert(record)
  const taskId = captureTaskIdOf({ sessionId: 's', turnKey: 't', segmentIndex: 0, sourceIds: [taskSource.id], total: 1 })
  writeCaptureTask(root, {
    id: taskId, sessionId: 's', projectKey: KEY, turnKey: 't',
    segment: { index: 0, total: 1, entries: [{ sourceId: taskSource.id, from: 0, to: taskSource.chars }] },
    sourceIds: [taskSource.id], status: 'pending', callState: 'not-sent', attempts: 0,
    explicit: false, route: null, createdAt: NOW,
  })
  const doneTaskId = captureTaskIdOf({ sessionId: 's', turnKey: 'done', segmentIndex: 0, sourceIds: [doneSource.id], total: 1 })
  writeCaptureTask(root, {
    id: doneTaskId, sessionId: 's', projectKey: KEY, turnKey: 'done',
    segment: { index: 0, total: 1, entries: [{ sourceId: doneSource.id, from: 0, to: doneSource.chars }] },
    sourceIds: [doneSource.id], status: 'done', callState: 'completed', attempts: 1,
    explicit: false, route: null, createdAt: NOW,
  })
  const unknownTaskId = captureTaskIdOf({ sessionId: 's', turnKey: 'unknown', segmentIndex: 0, sourceIds: [unknownSource.id], total: 1 })
  writeCaptureTask(root, {
    id: unknownTaskId, sessionId: 's', projectKey: KEY, turnKey: 'unknown',
    segment: { index: 0, total: 1, entries: [{ sourceId: unknownSource.id, from: 0, to: unknownSource.chars }] },
    sourceIds: [unknownSource.id], status: 'unknown', callState: 'unknown', attempts: 1,
    explicit: false, route: null, createdAt: NOW,
  })
  const old = new Date(NOW - 5 * 86_400_000)
  for (const source of [referenced, taskSource, doneSource, unknownSource, orphan]) {
    utimesSync(join(root, 'capture', 'sources', `${source.id}.json`), old, old)
  }
  const pipeline = pipelineFor(root, store, index)
  const result = pipeline.maintain({ now: NOW })
  assert.equal(result.pruned, null)
  for (const source of [referenced, taskSource, doneSource, unknownSource, orphan]) {
    assert.equal(existsSync(join(root, 'capture', 'sources', `${source.id}.json`)), true)
    assert.equal(readSource(root, source.id).text.length, source.chars)
  }
  const status = captureStorageStatus(root)
  assert.equal(status.sources.count, 5)
  assert.ok(status.sources.bytes > 0)
})

test('maintenance keeps old sources readable regardless of age', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-memory-capacity-window-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const source = saveSource(root, { sessionId: 's', messageId: 'm', role: 'user', sourceKind: 'user', at: NOW, text: '新原文' })
  const old = new Date(NOW - 5 * 86_400_000)
  utimesSync(join(root, 'capture', 'sources', `${source.id}.json`), old, old)
  const store = new MemoryStore({ root, clock: () => NOW }).open()
  const pipeline = pipelineFor(root, store, new MemoryIndex())
  pipeline.maintain({ now: NOW })
  assert.equal(existsSync(join(root, 'capture', 'sources', `${source.id}.json`)), true)
  assert.equal(readSource(root, source.id).text, '新原文')
})

test('turn ledger compaction keeps every identity and source text readable', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-memory-capacity-ledger-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const source = saveSource(root, { sessionId: 's', messageId: 'ledger', role: 'user', sourceKind: 'user', at: NOW, text: '账本压缩后仍应可读回的原文' })
  mkdirSync(join(root, 'capture'), { recursive: true })
  const lines = []
  for (let index = 0; index < 1600; index += 1) {
    lines.push(JSON.stringify({
      id: `turn_${index.toString(16).padStart(24, '0')}`, revision: 1, sessionId: 's', projectKey: KEY,
      sourceIds: [source.id], chars: source.chars, status: 'done', createdAt: NOW + index,
    }))
  }
  writeFileSync(join(root, 'capture', 'capture-turns.jsonl'), `${lines.join('\n')}\n`)
  const before = readTurnIntakes(root)
  assert.equal(before.intakes.length, 1600)
  const compacted = compactCaptureLedgers(root)
  assert.ok(compacted >= 1)
  const after = readTurnIntakes(root)
  assert.equal(after.intakes.length, 1600)
  assert.equal(after.corrupt, 0)
  assert.equal(readSourceText(root, source.id), '账本压缩后仍应可读回的原文')
})

function readSourceText(root, id) {
  return readSource(root, id)?.text ?? null
}


test('sources are transparently gzipped and read back byte-for-byte', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-memory-capacity-gzip-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const text = '可压缩的原始用户文本：Capacity-Roundtrip-20261105。'.repeat(1500)
  const source = saveSource(root, { sessionId: 's', messageId: 'gzip', role: 'user', sourceKind: 'user', at: NOW, text })
  const jsonFile = join(root, 'capture', 'sources', `${source.id}.json`)
  const gzFile = `${jsonFile}.gz`
  const metadata = JSON.parse(readFileSync(jsonFile, 'utf8'))
  assert.equal(metadata.text, undefined)
  assert.equal(metadata.compressed, true)
  assert.equal(existsSync(gzFile), true)
  const compressedBytes = statSync(jsonFile).size + statSync(gzFile).size
  const inlineBytes = Buffer.byteLength(JSON.stringify({ ...metadata, text }), 'utf8')
  assert.ok(compressedBytes < inlineBytes * 0.9, `${compressedBytes} vs ${inlineBytes}`)
  assert.equal(readSource(root, source.id).text, text)
})

test('legacy inline sources are compressed by maintenance and stay readable', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-memory-capacity-legacy-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const text = '旧版内联原文需要透明压缩。'.repeat(1200)
  const source = saveSource(root, { sessionId: 's', messageId: 'legacy', role: 'user', sourceKind: 'user', at: NOW, text })
  const jsonFile = join(root, 'capture', 'sources', `${source.id}.json`)
  const legacy = { id: source.id, sessionId: 's', messageId: 'legacy', role: 'user', sourceKind: 'user', at: NOW, text, identityKind: 'message-id' }
  writeFileSync(jsonFile, `${JSON.stringify(legacy)}\n`)
  const result = compressCaptureSources(root)
  assert.equal(result.compressed, 1)
  assert.equal(readSource(root, source.id).text, text)
  assert.equal(JSON.parse(readFileSync(jsonFile, 'utf8')).text, undefined)
})


test('a legal short write during legacy compression still preserves the original bytes', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-memory-gzip-short-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const dir = join(root, 'capture', 'sources')
  mkdirSync(dir, { recursive: true })
  const id = 'src_1234567890abcdef12345678'
  const text = '短写不能丢原文。'.repeat(900)
  writeFileSync(join(dir, `${id}.json`), JSON.stringify({ id, sessionId: 'qa', role: 'user', sourceKind: 'user', text }))
  const originalOpen = fs.openSync
  const originalWrite = fs.writeSync
  const targets = new Set()
  let shortened = false
  fs.openSync = function (file, ...args) {
    const fd = originalOpen.call(this, file, ...args)
    if (String(file).endsWith('.gz.tmp')) targets.add(fd)
    return fd
  }
  fs.writeSync = function (fd, data, ...args) {
    if (targets.has(fd) && Buffer.isBuffer(data) && !shortened) {
      shortened = true
      return originalWrite.call(this, fd, data, 0, Math.floor(data.length / 2))
    }
    return originalWrite.call(this, fd, data, ...args)
  }
  syncBuiltinESMExports()
  try {
    compressCaptureSources(root)
  } finally {
    fs.openSync = originalOpen
    fs.writeSync = originalWrite
    syncBuiltinESMExports()
  }
  assert.equal(shortened, true)
  assert.equal(readSource(root, id).text, text)
})

test('a zero-progress write during compression keeps the inline original readable', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-memory-gzip-fail-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const dir = join(root, 'capture', 'sources')
  mkdirSync(dir, { recursive: true })
  const id = 'src_abcdefabcdefabcdefabcdef'
  const text = '压缩故障必须保留原文。'.repeat(800)
  const file = join(dir, `${id}.json`)
  writeFileSync(file, JSON.stringify({ id, sessionId: 'qa', role: 'user', sourceKind: 'user', text }))
  const originalOpen = fs.openSync
  const originalWrite = fs.writeSync
  const targets = new Set()
  fs.openSync = function (name, ...args) {
    const fd = originalOpen.call(this, name, ...args)
    if (String(name).endsWith('.gz.tmp')) targets.add(fd)
    return fd
  }
  fs.writeSync = function (fd, data, ...args) {
    if (targets.has(fd)) return 0
    return originalWrite.call(this, fd, data, ...args)
  }
  syncBuiltinESMExports()
  let result
  try {
    result = compressCaptureSources(root)
  } finally {
    fs.openSync = originalOpen
    fs.writeSync = originalWrite
    syncBuiltinESMExports()
  }
  assert.equal(result.failed, 1)
  assert.equal(result.compressed, 0)
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).text, text)
  assert.equal(readSource(root, id).text, text)
})
