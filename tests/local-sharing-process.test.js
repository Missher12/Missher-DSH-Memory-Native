import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { prepareStorage } from '../host/storage-boundary.js'
import { standaloneNodeExecutable, startLocalSharing, statusLocalSharing, stopLocalSharing } from '../host/local-sharing-process.js'

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-memory-local-process-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const owner = prepareStorage({ get() {} }, { dataDir: root })
  return { root, owner }
}

test('a desktop app executable resolves to the standalone Node under Resources', t => {
  if (process.platform === 'win32') { t.skip('the DSH desktop bundle layout is verified on macOS') ; return }
  const root = mkdtempSync(join(tmpdir(), 'dsh-memory-desktop-node-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const contents = join(root, 'DeepSeek Harness.app', 'Contents')
  const appExecutable = join(contents, 'MacOS', 'DeepSeek Harness')
  const bundledNode = join(contents, 'Resources', 'runtime', 'primary-runtime', 'dependencies', 'node', 'bin', 'node')
  mkdirSync(join(contents, 'MacOS'), { recursive: true })
  mkdirSync(join(bundledNode, '..'), { recursive: true })
  writeFileSync(appExecutable, '#!/bin/sh\nprintf "DeepSeek Harness 1.0\\n"\n')
  chmodSync(appExecutable, 0o755)
  symlinkSync(process.execPath, bundledNode)
  assert.equal(standaloneNodeExecutable(appExecutable), bundledNode)
})

test('stop refuses to signal a live process when its HTTP instance cannot be verified', async t => {
  const { root, owner } = fixture(t)
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  assert.ok(unrelated.pid)
  t.after(() => { try { unrelated.kill('SIGTERM') } catch {} })
  const directory = join(root, '.local-sharing')
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'service.json'), JSON.stringify({ version: 1, instanceId: 'stale-state',
    profileIdentity: owner.identity, pid: unrelated.pid, port: 65_535, token: 't'.repeat(43),
    startedAt: Date.now(), status: 'running' }))

  const result = await stopLocalSharing(root)
  assert.equal(result.stopped, false)
  assert.doesNotThrow(() => process.kill(unrelated.pid, 0))
})

test('the standalone Node process starts, reports ready, and stops through its authenticated instance endpoint', async t => {
  const { root, owner } = fixture(t)
  t.after(() => stopLocalSharing(root))
  const started = await startLocalSharing({ root, profileIdentity: owner.identity })
  assert.match(started.url, /^http:\/\/127\.0\.0\.1:\d+\/#token=/u)
  assert.equal((await statusLocalSharing(root)).running, true)
  const stopped = await stopLocalSharing(root)
  assert.equal(stopped.stopped, true)
  assert.equal((await statusLocalSharing(root)).running, false)
})
