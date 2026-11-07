import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'
import { apply } from '../index.js'
import { prepareStorage } from '../host/storage-boundary.js'
import { MemoryStore } from '../host/store.js'
import { memoryHealth } from '../host/health.js'

function harness(t, profile, config) {
  let route
  const handlers = {}, effects = []
  apply({ get: key => key === 'profileContext' ? profile : key === 'webServer' ? { register(value) { route = value; return () => {} } } : undefined,
    on: (key, fn) => { handlers[key] = fn; return () => {} }, effect: fn => { effects.push(fn); return () => {} }, logger: { warn() {}, info() {} } }, config)
  t.after(() => { for (const fn of effects) { try { fn()?.() } catch {} } })
  return { handlers, async call(method, input) {
    for (let i = 0; !route && i < 20; i++) await new Promise(resolve => setTimeout(resolve, 10))
    assert.ok(route)
    const request = Readable.from([Buffer.from(JSON.stringify({ method, input }))]); request.method = 'POST'
    let result; await route.handler(request, { writeHead() {}, end(body) { result = JSON.parse(body) } })
    return result
  } }
}

test('diagnostic summary never serializes raw messages, paths, IDs or configuration', () => {
  const secret = 'private-api-key-and-memory-body'
  const report = memoryHealth({ isolation: 'profile', total: 5, deleted: 2,
    capture: { failed: 1, unknown: 1, tasks: [{ content: secret, id: secret }] },
    settingsIssue: { code: 'settings-invalid', message: secret }, maintenance: { backupError: { message: secret, path: secret } },
    store: { stats: () => [{ corrupt: 2, projectKey: secret, path: secret }] } })
  assert.equal(JSON.stringify(report).includes(secret), false)
  assert.deepEqual(report.issues, ['settings-invalid', 'backup-failed', 'corrupt-lines', 'capture-incomplete', 'capture-unknown'])
  assert.equal(report.status, 'attention')
})

test('two native-profile compositions recall only their own global records and ownership failure leaves a usable read-only diagnostic panel', async t => {
  const home = mkdtempSync(join(tmpdir(), 'memory-native-profile-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const profile = name => ({ name, home, dir: join(home, 'profiles', name) })
  const root = name => prepareStorage({ get: () => profile(name) }, {}).root
  new MemoryStore({ root: root('desktop') }).open().write({ kind: 'fact', scope: 'global', content: '北岚数据库版本是 MariaDB 11.4.7。', confidence: .95 })
  const a = harness(t, profile('desktop'), { capture: { enabled: false }, maintenance: { enabled: false } })
  const b = harness(t, profile('work'), { capture: { enabled: false }, maintenance: { enabled: false } })
  const ask = async session => {
    const messages = [{ role: 'user', content: '北岚数据库版本是什么？' }]
    return session.handlers['agent/pre-step']({ agent: { session: { id: 'fresh-chat', header: { cwd: home } } }, messages }, async () => ({ kind: 'enter', messages }))
  }
  assert.match(JSON.stringify(await ask(a)), /MariaDB 11\.4\.7/u)
  assert.doesNotMatch(JSON.stringify(await ask(b)), /MariaDB 11\.4\.7/u)
  assert.equal((await a.call('stats', {})).value.health.isolation, 'profile')
  const denied = harness(t, profile('work'), { dataDir: root('desktop') })
  assert.equal(denied.handlers['agent/pre-step'], undefined)
  const state = await denied.call('stats', {})
  assert.equal(state.ok, true); assert.equal(state.value.health.status, 'unavailable')
  assert.equal(state.value.health.issues[0], 'storage-owner-conflict')
  assert.equal(JSON.stringify(state).includes(home), false)
  assert.equal((await denied.call('list', { scope: 'global' })).ok, false)
})
