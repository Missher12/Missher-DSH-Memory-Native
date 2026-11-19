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
