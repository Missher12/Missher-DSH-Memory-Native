import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { CapturePipeline } from '../host/capture.js'
import { readCaptureTasks } from '../host/capture-journal.js'
import { resolveConfig } from '../host/config.js'
import { atomicWritePrivate } from '../host/persistence.js'
import { projectIdentity } from '../host/paths.js'
import { MemoryIndex } from '../host/search.js'
import { MemoryStore } from '../host/store.js'

test('failed replacement preserves authority and index; retry reuses the saved model result', async t => {
  const root = fs.mkdtempSync(join(tmpdir(), 'memory-atomic-replace-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const key = projectIdentity('/tmp/atomic-replacement').key
  const store = new MemoryStore({ root }).open()
  const old = store.write({ kind: 'fact', scope: 'project', projectKey: key, content: '这个仓库要求 Node 22 以上', confidence: 0.9 }).record
  const index = new MemoryIndex().rebuild(store.listAll())
  const authority = join(root, 'projects', key, 'memories.jsonl')
  const before = fs.readFileSync(authority, 'utf8')
  let calls = 0
  const llm = {
    async resolveModelInfo() { return {} },
    async *stream() {
      calls += 1
      yield { type: 'text-delta', text: JSON.stringify({ memories: [{ op: 'SUPERSEDE', targetId: old.id, kind: 'fact', scope: 'project', content: '这个仓库要求 Node 24 以上', confidence: 0.95 }] }) }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const capture = new CapturePipeline({ store, index, config: resolveConfig({ capture: { minTurnChars: 0 } }), ctx: { get: () => llm } })
  const session = { id: 'atomic-session', header: { cwd: '/tmp/atomic-replacement' }, requestHeader: () => ({ config: { provider: 'qa', model: 'fake' } }) }
  const write = fs.writeSync
  let injected = 0
  fs.writeSync = (fd, data, ...args) => {
    const text = Buffer.isBuffer(data) ? data.toString() : String(data)
    if (text.includes(old.id) && text.includes('"status":"superseded"')) {
      injected += 1
      throw Object.assign(new Error('simulated authority write failure'), { code: 'EIO' })
    }
    return write(fd, data, ...args)
  }
  syncBuiltinESMExports()
  try {
    capture.observe(session, { type: 'user/message', seq: 0, time: Date.now(), data: { id: 'atomic-user', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '更正：这个仓库要求 Node 24 以上。' }] } })
    capture.observe(session, { type: 'turn/end', seq: 1, time: Date.now(), data: { reason: { kind: 'completed' } } })
    await capture.flush()
  } finally {
    fs.writeSync = write
    syncBuiltinESMExports()
  }
  assert.ok(injected > 0, 'the authority write fault must actually occur')
  assert.equal(fs.readFileSync(authority, 'utf8'), before, 'a failed replacement must publish neither half')
  assert.deepEqual(store.list('project', key).filter(record => record.status === 'active').map(record => record.id), [old.id])
  assert.deepEqual(index.search('这个仓库要求 Node', { projectKey: key, scopes: ['project'], statuses: ['active'] }).map(hit => hit.record.id), [old.id])
  const task = readCaptureTasks(root)[0]
  assert.equal(task.status, 'failed')
  assert.equal(capture.retry(task.id).ok, true)
  await capture.flush()
  assert.equal(calls, 1, 'local write recovery must not repeat the paid request')
  const persisted = new MemoryStore({ root }).open()
  const active = persisted.list('project', key).filter(record => record.status === 'active')
  assert.equal(active.length, 1)
  assert.match(active[0].content, /Node 24/)
  assert.equal(persisted.find(old.id, [{ scope: 'project', projectKey: key }]).status, 'superseded')
  assert.equal(persisted.history(old.id, [{ scope: 'project', projectKey: key }]).length, 2)
  assert.equal(readCaptureTasks(root)[0].status, 'done')
})

for (const code of ['EPERM', 'EISDIR']) test(`Windows directory-open ${code} does not turn a committed atomic write into failure`, t => {
  const root = fs.mkdtempSync(join(tmpdir(), 'memory-win-sync-open-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const target = join(root, 'owner.json')
  fs.writeFileSync(target, 'old')
  const originalOpen = fs.openSync
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
  let injected = 0
  Object.defineProperty(process, 'platform', { ...originalPlatform, value: 'win32' })
  fs.openSync = (path, flags, ...args) => {
    if (path === root && flags === 'r') {
      injected += 1
      throw Object.assign(new Error(`simulated Windows directory open ${code}`), { code })
    }
    return originalOpen(path, flags, ...args)
  }
  syncBuiltinESMExports()
  try { atomicWritePrivate(target, 'new') }
  finally {
    fs.openSync = originalOpen
    syncBuiltinESMExports()
    Object.defineProperty(process, 'platform', originalPlatform)
  }
  assert.equal(injected, 1, 'fault injection reached the directory-open stage')
  assert.equal(fs.readFileSync(target, 'utf8'), 'new', 'the atomic replacement remains committed')
})

test('Windows directory fsync EPERM is best-effort after atomic replacement', t => {
  const root = fs.mkdtempSync(join(tmpdir(), 'memory-win-sync-fsync-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const target = join(root, 'owner.json')
  fs.writeFileSync(target, 'old')
  const originalOpen = fs.openSync, originalFsync = fs.fsyncSync, originalClose = fs.closeSync
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
  const directoryFd = -8417
  let injected = 0
  Object.defineProperty(process, 'platform', { ...originalPlatform, value: 'win32' })
  fs.openSync = (path, flags, ...args) => path === root && flags === 'r'
    ? directoryFd : originalOpen(path, flags, ...args)
  fs.fsyncSync = fd => {
    if (fd === directoryFd) {
      injected += 1
      throw Object.assign(new Error('simulated Windows directory fsync EPERM'), { code: 'EPERM' })
    }
    return originalFsync(fd)
  }
  fs.closeSync = fd => fd === directoryFd ? undefined : originalClose(fd)
  syncBuiltinESMExports()
  try { atomicWritePrivate(target, 'new') }
  finally {
    fs.openSync = originalOpen
    fs.fsyncSync = originalFsync
    fs.closeSync = originalClose
    syncBuiltinESMExports()
    Object.defineProperty(process, 'platform', originalPlatform)
  }
  assert.equal(injected, 1, 'fault injection reached directory fsync after the atomic rename')
  assert.equal(fs.readFileSync(target, 'utf8'), 'new')
})

test('Windows atomic writes still surface file permission errors and preserve the previous file', t => {
  const root = fs.mkdtempSync(join(tmpdir(), 'memory-win-file-eacces-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const target = join(root, 'owner.json')
  fs.writeFileSync(target, 'old')
  const originalOpen = fs.openSync
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
  let injected = 0
  Object.defineProperty(process, 'platform', { ...originalPlatform, value: 'win32' })
  fs.openSync = (path, flags, ...args) => {
    if (String(path).startsWith(`${target}.`) && flags === 'wx') {
      injected += 1
      throw Object.assign(new Error('simulated file permission denial'), { code: 'EACCES' })
    }
    return originalOpen(path, flags, ...args)
  }
  syncBuiltinESMExports()
  try { assert.throws(() => atomicWritePrivate(target, 'new'), error => error.code === 'EACCES') }
  finally {
    fs.openSync = originalOpen
    syncBuiltinESMExports()
    Object.defineProperty(process, 'platform', originalPlatform)
  }
  assert.equal(injected, 1, 'fault injection reached the temporary file open')
  assert.equal(fs.readFileSync(target, 'utf8'), 'old', 'a denied file write does not replace the old file')
})
