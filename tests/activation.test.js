import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { apply } from '../index.js'

/** Minimal Cordis-like context: enough for apply() to wire the Host half. */
function fakeContext(root) {
  const listeners = []
  const effects = []
  const handlers = {}
  return {
    listeners,
    effects,
    handlers,
    ctx: {
      get(key) {
        if (key === 'dshHomePath') return () => root
        return undefined
      },
      on(name, handler) {
        listeners.push(name)
        handlers[name] = handler
        return () => {}
      },
      effect(factory) {
        effects.push(factory)
        return () => {}
      },
      logger: { info() {}, warn() {} },
    },
  }
}

test('apply wires capture and recall on a minimal context', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-memory-activation-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const { ctx, listeners, effects } = fakeContext(root)

  assert.doesNotThrow(() => apply(ctx, { dataDir: join(root, 'data') }))
  assert.ok(listeners.includes('session/event'), 'capture listens to session/event')
  assert.ok(listeners.includes('agent/pre-step'), 'recall listens to agent/pre-step')
  assert.ok(effects.length >= 1, 'capture registers a disposal effect')
  assert.ok(existsSync(join(root, 'data')), 'the data root is created at activation')

  // wirePanel() resolves asynchronously; give it a tick to settle on the
  // "unavailable" path of this context instead of rejecting into the void.
  await new Promise((resolve) => setTimeout(resolve, 50))
  const diagnostic = join(root, 'data', 'panel-transport.json')
  assert.ok(existsSync(diagnostic), 'panel transport diagnostic is written')
})

test('apply is a no-op when disabled', () => {
  const { ctx, listeners } = fakeContext(tmpdir())
  apply(ctx, { enabled: false })
  assert.deepEqual(listeners, [])
})

test('apply disables itself instead of throwing when storage cannot open', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-memory-activation-bad-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const blocked = join(root, 'data')
  writeFileSync(blocked, 'not a directory')
  const { ctx, listeners } = fakeContext(root)
  assert.doesNotThrow(() => apply(ctx, { dataDir: blocked }))
  assert.deepEqual(listeners, [], 'no hooks are registered when storage is unavailable')
  await new Promise((resolve) => setTimeout(resolve, 20))
})


test('pre-step failures never break the turn', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-memory-activation-hook-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const { ctx, handlers } = fakeContext(root)
  apply(ctx, { dataDir: join(root, 'data') })
  const decision = { kind: 'enter', messages: [] }
  const agent = {}
  Object.defineProperty(agent, 'session', { get() { throw new Error('session exploded') } })
  const result = await handlers['agent/pre-step']({ agent, messages: [] }, async () => decision)
  assert.deepEqual(result, decision)
})
