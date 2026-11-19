import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { prepareStorage } from '../host/storage-boundary.js'
import { createLocalSharingHttpServer } from '../host/local-sharing-http.js'

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-memory-local-http-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const owner = prepareStorage({ get() {} }, { dataDir: root })
  return { root, owner }
}

test('the local page accepts the browser cookie header size observed during real Chromium use', async t => {
  const { root, owner } = fixture(t)
  const server = createLocalSharingHttpServer({ root, profileIdentity: owner.identity,
    token: 't'.repeat(43), instanceId: 'header-limit-check' })
  t.after(() => server.close())
  const address = await server.listen()
  const response = await fetch(`http://127.0.0.1:${address.port}/healthz`, {
    headers: { cookie: `local=${'x'.repeat(17_100)}` },
  })
  assert.equal(response.status, 200)
  assert.equal((await response.json()).instanceId, 'header-limit-check')
})

test('the authenticated list endpoint returns the requested project page and full count', async t => {
  const { root, owner } = fixture(t)
  const projectKey = 'a'.repeat(64)
  const token = 't'.repeat(43)
  const server = createLocalSharingHttpServer({ root, profileIdentity: owner.identity, token, instanceId: 'browse-page-check' })
  t.after(() => server.close())
  const address = await server.listen()
  for (let i = 0; i < 3; i += 1) {
    server.service.remember({ client: 'codex', sessionId: 'browse-session', messageId: `browse-${i}`,
      requestedProjectKey: projectKey, text: `记住：分页记忆条目 ${i} 应保留。` })
  }
  const base = `http://127.0.0.1:${address.port}/api/list?projectKey=${projectKey}&limit=1`
  const headers = { authorization: `Bearer ${token}` }
  const first = await fetch(`${base}&offset=0`, { headers })
  const second = await fetch(`${base}&offset=1`, { headers })
  assert.equal(first.status, 200)
  assert.equal(second.status, 200)
  const firstPage = await first.json()
  const secondPage = await second.json()
  assert.equal(firstPage.total, 3)
  assert.equal(secondPage.total, 3)
  assert.equal(firstPage.items.length, 1)
  assert.equal(secondPage.items.length, 1)
  assert.equal(secondPage.offset, 1)
  assert.notEqual(firstPage.items[0].id, secondPage.items[0].id)
})
