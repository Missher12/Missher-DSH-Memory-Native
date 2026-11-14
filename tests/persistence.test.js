import assert from 'node:assert/strict'
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MemoryStore } from '../host/store.js'
import { readCaptureTasks, writeCaptureTask } from '../host/capture-journal.js'

function setup(t) {
  const root = fs.mkdtempSync(join(tmpdir(), 'memory-persistence-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return { root, store: new MemoryStore({ root }).open() }
}
const fact = { kind: 'fact', scope: 'global', content: '数据写入必须完整保留中文与所有数值 31 天。', confidence: .9 }

test('a live writer keeps its lock even when it is older than the stale timeout', t => {
  const { root, store } = setup(t), lock = join(root, '.write.lock')
  fs.writeFileSync(lock, `${process.pid}\n`)
  fs.utimesSync(lock, new Date(0), new Date(0))
  const originalNow = Date.now
  Date.now = () => 1700000000000
  try { assert.throws(() => store.write(fact), /locked/u) }
  finally { Date.now = originalNow }
  assert.equal(fs.readFileSync(lock, 'utf8'), `${process.pid}\n`)
  assert.equal(store.listAll().length, 0)
})

test('a departed writer does not strand its recently created lock', t => {
  const { root, store } = setup(t)
  const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' })
  assert.equal(child.status, 0)
  fs.writeFileSync(join(root, '.write.lock'), child.stdout + '\n')
  assert.equal(store.write(fact).ok, true)
  assert.equal(new MemoryStore({ root }).open().listAll()[0].content, fact.content)
})

test('short OS writes still commit a complete authority record', t => {
  const { root, store } = setup(t), original = fs.writeSync
  fs.writeSync = (fd, data, ...args) => {
    if (typeof data === 'string') return original(fd, Buffer.from(data).subarray(0, 7))
    const [offset = 0, length = data.length - offset, position] = args
    return original(fd, data, offset, Math.min(7, length), position)
  }
  syncBuiltinESMExports()
  try { assert.equal(store.write(fact).ok, true) }
  finally { fs.writeSync = original; syncBuiltinESMExports() }
  const records = new MemoryStore({ root }).open().listAll()
  assert.equal(records.length, 1)
  assert.equal(records[0].content, fact.content)
})

test('a failed append preserves prior bytes and a later write remains readable', t => {
  const { root, store } = setup(t)
  store.write(fact)
  const file = join(root, 'global', 'memories.jsonl'), before = fs.readFileSync(file)
  const original = fs.writeSync, originalOpen = fs.openSync, originalTruncate = fs.ftruncateSync
  const modes = new Map()
  let authorityWrites = 0
  fs.openSync = (path, flags, ...args) => {
    const fd = originalOpen(path, flags, ...args)
    modes.set(fd, flags)
    return fd
  }
  fs.ftruncateSync = (fd, size) => {
    if (modes.get(fd) === 'a+') throw Object.assign(new Error('Windows append handles cannot truncate'), { code: 'EPERM' })
    return originalTruncate(fd, size)
  }
  fs.writeSync = (fd, data, ...args) => {
    if (fs.fstatSync(fd).ino !== fs.statSync(file).ino) return original(fd, data, ...args)
    if (++authorityWrites === 2) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' })
    if (typeof data === 'string') return original(fd, Buffer.from(data).subarray(0, 7))
    return original(fd, data, args[0] ?? 0, 7)
  }
  syncBuiltinESMExports()
  try {
    let failure
    try { store.write({ ...fact, content: '这条未完成写入的记录不应出现。' }) } catch (error) { failure = error }
    assert.match(failure?.message ?? '', /disk full/u)
    assert.equal(failure.rollbackFailed, undefined, 'rollback must use a non-append descriptor')
  } finally {
    fs.writeSync = original
    fs.openSync = originalOpen
    fs.ftruncateSync = originalTruncate
    syncBuiltinESMExports()
  }
  assert.deepEqual(fs.readFileSync(file), before)
  store.write({ ...fact, content: '磁盘恢复后写入的新记录仍然完整可读。' })
  assert.equal(new MemoryStore({ root }).open().listAll().length, 2)
})

test('a failed capture-journal append preserves its prior bytes on Windows append handles', t => {
  const { root } = setup(t)
  const task = { id: 'cap_0123456789abcdef01234567', status: 'pending', callState: 'not-sent', sourceIds: [] }
  writeCaptureTask(root, task)
  const file = join(root, 'capture', 'capture-tasks.jsonl'), before = fs.readFileSync(file)
  const original = fs.writeSync, originalOpen = fs.openSync, originalTruncate = fs.ftruncateSync
  const modes = new Map()
  let journalWrites = 0
  fs.openSync = (path, flags, ...args) => {
    const fd = originalOpen(path, flags, ...args)
    modes.set(fd, flags)
    return fd
  }
  fs.ftruncateSync = (fd, size) => {
    if (modes.get(fd) === 'a') throw Object.assign(new Error('Windows append handles cannot truncate'), { code: 'EPERM' })
    return originalTruncate(fd, size)
  }
  fs.writeSync = (fd, data, ...args) => {
    if (fs.fstatSync(fd).ino !== fs.statSync(file).ino) return original(fd, data, ...args)
    if (++journalWrites === 2) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' })
    return original(fd, data, args[0] ?? 0, 7)
  }
  syncBuiltinESMExports()
  try {
    let failure
    try { writeCaptureTask(root, { ...task, status: 'done' }) } catch (error) { failure = error }
    assert.match(failure?.message ?? '', /disk full/u)
    assert.equal(failure.rollbackFailed, undefined)
    assert.deepEqual(fs.readFileSync(file), before)
    assert.equal(readCaptureTasks(root)[0].status, 'pending')
  } finally {
    fs.writeSync = original
    fs.openSync = originalOpen
    fs.ftruncateSync = originalTruncate
    syncBuiltinESMExports()
  }
  writeCaptureTask(root, { ...task, status: 'done' })
  assert.equal(readCaptureTasks(root)[0].status, 'done')
})

test('an interrupted tail cannot swallow the next valid record', t => {
  const { root, store } = setup(t)
  store.write(fact)
  fs.appendFileSync(join(root, 'global', 'memories.jsonl'), '{"id":"interrupted')
  const reopened = new MemoryStore({ root }).open()
  reopened.write({ ...fact, content: '重启后第一条已完成写入的完整记录。' })
  assert.equal(new MemoryStore({ root }).open().listAll().length, 2)
})

test('a large live scope does not rewrite every record for each small append', t => {
  const { root, store } = setup(t)
  const seed = store.write(fact).record
  const file = join(root, 'global', 'memories.jsonl')
  fs.writeFileSync(file, Array.from({ length: 3000 }, (_, i) => JSON.stringify({ ...seed, id: `mem_capacity_${i}` }) + '\n').join(''))
  const fresh = new MemoryStore({ root }).open(), before = fs.statSync(file)
  fresh.update('mem_capacity_0', { content: '第一条更新仍然保留历史与其他全部记忆。' })
  fresh.write({ ...fact, content: '第 3001 条新记忆应当只追加一次。' })
  assert.equal(fs.statSync(file).ino, before.ino, 'appending has no reclaimable compaction benefit at this point')
  const reopened = new MemoryStore({ root }).open()
  assert.equal(reopened.listAll().length, 3001)
  assert.equal(reopened.history('mem_capacity_0', [{ scope: 'global' }]).length, 2)
})
