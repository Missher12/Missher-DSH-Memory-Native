import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'
import { apply } from '../index.js'
import { MemoryStore } from '../host/store.js'

test('corrupt settings keep the native panel usable while capture, recall and sync stay off until an explicit save', async t => {
  const root = mkdtempSync(join(tmpdir(), 'memory-settings-recovery-')), effects = [], handlers = {}
  t.after(() => { for (const effect of effects) { try { effect()?.() } catch {} }; rmSync(root, { recursive: true, force: true }) })
  const store = new MemoryStore({ root }).open()
  store.write({ kind: 'fact', scope: 'global', content: '测试数据库版本是 PostgreSQL 16.3。', confidence: .95 })
  const original = '{"captureEnabled":false'
  writeFileSync(join(root, 'settings.json'), original)
  let route
  apply({ get: name => name === 'webServer' ? { register(value) { route = value; return () => {} } } : undefined,
    on: (name, fn) => { handlers[name] = fn; return () => {} }, effect: fn => { effects.push(fn); return () => {} }, logger: { warn() {}, info() {} } },
    { dataDir: root })
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.ok(route, 'the recovery panel remains available')
  const call = async (method, input) => {
    const request = Readable.from([Buffer.from(JSON.stringify({ method, input }))]); request.method = 'POST'
    let value; await route.handler(request, { writeHead() {}, end(data) { value = JSON.parse(data) } })
    return value
  }
  const stats = (await call('stats', { scope: 'global' })).value
  assert.equal(stats.settingsIssue.code, 'settings-invalid')
  for (const key of ['captureEnabled', 'injectEnabled', 'maintenanceEnabled', 'obsidianAutoSync']) assert.equal(stats[key], false)
  const messages = [{ role: 'user', content: '数据库版本是什么？' }]
  const response = await handlers['agent/pre-step']({ agent: { session: { id: 'recovery', header: { cwd: root } } }, messages }, async () => ({ kind: 'enter', messages }))
  assert.deepEqual(response.messages, messages)
  const incomplete = await call('updateSettings', { captureEnabled: true })
  assert.equal(incomplete.ok, false)
  assert.equal(readFileSync(join(root, 'settings.json'), 'utf8'), original)
  const repaired = await call('updateSettings', { captureEnabled: false, injectEnabled: true, maintenanceEnabled: false, obsidianAutoSync: false })
  assert.equal(repaired.ok, true)
  const after = (await call('stats', { scope: 'global' })).value
  assert.equal(after.settingsIssue, null); assert.equal(after.captureEnabled, false); assert.equal(after.injectEnabled, true)
  const retained = readdirSync(root).find(name => name.startsWith('settings.invalid-'))
  assert.ok(retained); assert.equal(readFileSync(join(root, retained), 'utf8'), original)
})
