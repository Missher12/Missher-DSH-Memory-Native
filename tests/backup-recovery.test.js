import assert from 'node:assert/strict'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { CapturePipeline } from '../host/capture.js'
import { MemoryIndex } from '../host/search.js'
import { resolveConfig } from '../host/config.js'
import { MemoryStore } from '../host/store.js'
import { readCaptureTasks, writeCaptureTask } from '../host/capture-journal.js'
import { writeSettings, readSettings } from '../host/settings.js'

function setup(t) {
  const parent = fs.mkdtempSync(join(tmpdir(), 'memory-complete-backup-')), root = join(parent, 'data')
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }))
  return { parent, root, store: new MemoryStore({ root, clock: () => 1700000000000 }).open() }
}

test('complete backup restores history, deletion, source barriers, unknown calls, notes and settings', async t => {
  const { parent, root, store } = setup(t)
  const row = store.write({ kind: 'fact', scope: 'global', content: '备份恢复需要保留已遗忘的记录状态。', confidence: .9 }).record
  store.update(row.id, { status: 'deleted' }, [{ scope: 'global' }])
  writeSettings(root, { captureEnabled: false, obsidianAutoSync: false })
  fs.mkdirSync(join(root, 'knowledge'), { recursive: true })
  fs.writeFileSync(join(root, 'knowledge', 'example.md'), '用户自己的完整知识笔记。')
  fs.mkdirSync(join(root, 'capture', 'sources'), { recursive: true })
  fs.writeFileSync(join(root, 'capture', 'sources', 'source.recall-blocked'), 'blocked')
  writeCaptureTask(root, { id: 'cap_112233441122334411223344', status: 'unknown', callState: 'unknown', attempts: 1, sourceIds: [], route: { provider: 'local', model: 'test' } })
  fs.writeFileSync(join(root, 'panel-transport.json'), '{"path":"runtime-secret"}')
  const backup = await store.backup()
  assert.equal(fs.statSync(backup).isDirectory(), true, 'backup must include the complete local evidence set')
  const { restoreBackup } = await import('../host/backup.js')
  const restored = join(parent, 'restored')
  await restoreBackup(backup, restored)
  const fresh = new MemoryStore({ root: restored }).open()
  assert.equal(fresh.listAll().length, 0)
  assert.equal(fresh.find(row.id).status, 'deleted')
  assert.equal(fresh.history(row.id, [{ scope: 'global' }]).length, 2)
  assert.equal(readSettings(restored).captureEnabled, false)
  assert.equal(readCaptureTasks(restored)[0].callState, 'unknown')
  for (const file of ['global/memories.jsonl', 'capture/sources/source.recall-blocked', 'knowledge/example.md']) {
    assert.deepEqual(fs.readFileSync(join(restored, file)), fs.readFileSync(join(root, file)))
  }
  assert.equal(fs.existsSync(join(restored, 'panel-transport.json')), false)
  assert.equal(fs.existsSync(join(restored, '.write.lock')), false)
  let calls = 0
  const pipeline = new CapturePipeline({ store: fresh, index: new MemoryIndex().rebuild(fresh.listAll()), config: resolveConfig({}),
    ctx: { get: key => key === 'llm' ? { async *stream() { calls++; throw new Error('must not resend') } } : undefined, logger: { info() {}, warn() {} } } })
  await pipeline.resume()
  assert.equal(calls, 0)
  assert.equal(readCaptureTasks(restored)[0].callState, 'unknown')
})

test('same-clock backups remain distinct and an existing target is never replaced', async t => {
  const { parent, store } = setup(t)
  const first = await store.backup(), second = await store.backup()
  assert.notEqual(first, second)
  const { restoreBackup } = await import('../host/backup.js')
  const target = join(parent, 'existing'); fs.mkdirSync(target); fs.writeFileSync(join(target, 'mine'), 'keep')
  await assert.rejects(async () => restoreBackup(first, target), /已存在/u)
  assert.equal(fs.readFileSync(join(target, 'mine'), 'utf8'), 'keep')
})

test('corrupt snapshots and linked authority files cannot be restored', async t => {
  const { parent, root, store } = setup(t)
  store.write({ kind: 'fact', scope: 'global', content: '校验失败不能写入恢复目录。' })
  const backup = await store.backup()
  assert.ok(fs.statSync(backup).isDirectory())
  const { restoreBackup } = await import('../host/backup.js')
  fs.appendFileSync(join(backup, 'files', 'global', 'memories.jsonl'), 'corrupt')
  const target = join(parent, 'refused')
  await assert.rejects(async () => restoreBackup(backup, target), /校验/u)
  assert.equal(fs.existsSync(target), false)
  fs.mkdirSync(join(root, 'knowledge')); fs.symlinkSync('/etc/hosts', join(root, 'knowledge', 'linked.md'))
  await assert.rejects(async () => store.backup(), /链接/u)
  assert.equal(fs.readdirSync(join(root, 'backups')).filter(n => n.endsWith('.backup')).length, 1)
})

test('large source backups allow the host event loop to run and reject a changing source set', async t => {
  const { root, store } = setup(t)
  fs.mkdirSync(join(root, 'knowledge'))
  const note = join(root, 'knowledge', 'large.md')
  fs.writeFileSync(note, '完整知识原文。'.repeat(400_000))
  let progressed = false
  const timer = setImmediate(() => { progressed = true; fs.appendFileSync(note, '并发修改') })
  try { await assert.rejects(async () => store.backup(), /变化/u) }
  finally { clearImmediate(timer) }
  assert.equal(progressed, true)
  assert.equal(fs.readdirSync(join(root, 'backups')).length, 0)
})

test('the packaged recovery CLI restores a verified snapshot and rejects a traversal manifest', async t => {
  const { parent, store } = setup(t)
  store.write({ kind: 'fact', scope: 'global', content: '离线恢复工具必须实际可运行。' })
  const backup = await store.backup(), target = join(parent, 'cli-restored')
  const cli = new URL('../host/recovery-cli.js', import.meta.url).pathname
  for (const args of [['verify', backup], ['restore', backup, target]]) {
    const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    assert.ok(JSON.parse(result.stdout).files > 0)
  }
  assert.equal(new MemoryStore({ root: target }).open().listAll().length, 1)
  const file = join(backup, 'manifest.json'), manifest = JSON.parse(fs.readFileSync(file, 'utf8'))
  manifest.files[0].path = '../outside'
  fs.writeFileSync(file, JSON.stringify(manifest))
  const { restoreBackup } = await import('../host/backup.js')
  await assert.rejects(restoreBackup(backup, join(parent, 'refused')), /校验/u)
  assert.equal(fs.existsSync(join(parent, 'refused')), false)
})
