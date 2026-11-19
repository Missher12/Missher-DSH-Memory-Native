import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { clearLastUsersForSources, readLastUser, writeLastUser } from '../host/local-sharing-hook-state.js'

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-memory-hook-state-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

const largeUserEvent = root => {
  const input = { client: 'codex', sessionId: 'large-session', projectKey: 'long-user-event',
    messageId: 'turn-large', text: '長'.repeat(8_800), sourceId: 'src_0123456789abcdef01234567' }
  assert.equal(writeLastUser(root, input), true)
  return input
}

test('a valid 8,800-character user event survives the private JSON size check', t => {
  const root = fixture(t)
  const input = largeUserEvent(root)
  assert.ok(readLastUser(root, input.client, input.sessionId, input.projectKey)?.text === input.text,
    'the full prior user message remains readable')
})

test('source revocation can clear a valid large previous-user event', t => {
  const root = fixture(t)
  const input = largeUserEvent(root)
  assert.equal(clearLastUsersForSources(root, [input.sourceId]), 1)
  assert.equal(readLastUser(root, input.client, input.sessionId, input.projectKey), null)
})
