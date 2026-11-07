import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate as yieldLoop } from 'node:timers/promises'
import { CapturePipeline } from '../host/capture.js'
import { readCaptureTasks, updateCaptureTask } from '../host/capture-journal.js'
import { resolveConfig } from '../host/config.js'
import { MemoryStore } from '../host/store.js'
import { MemoryIndex } from '../host/search.js'

function fixture(t, limit = 1) {
  const root = mkdtempSync(join(tmpdir(), 'memory-budget-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  let now = new Date(2026, 10, 7, 23, 59, 59).getTime(), calls = 0
  const store = new MemoryStore({ root, clock: () => now }).open()
  const index = new MemoryIndex().rebuild(store.listAll())
  const config = n => resolveConfig({ capture: { minTurnChars: 0, maxCallsPerDay: n } })
  const llm = { async resolveModelInfo() { return {} }, async *stream() {
    calls++
    yield { type: 'text-delta', text: '{"memories":[],"complete":true}' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  } }
  const create = () => {
    const p = new CapturePipeline({ store, index, clock: () => now, config: config(limit), ctx: { get: () => llm } })
    t.after(() => p.dispose())
    return p
  }
  const feed = (p, id) => {
    const s = { id: 'budget-session', header: { cwd: '/tmp/budget-project' }, requestHeader: () => ({ config: { provider: 'qa', model: 'test' } }) }
    p.observe(s, { type: 'user/message', data: { id, source: { kind: 'user' }, content: [{ type: 'text', text: '本项目使用 pnpm 安装依赖。' }] } })
    p.observe(s, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  }
  return { root, create, feed, config, calls: () => calls, now: () => now, advance: ms => { now += ms } }
}

test('budget wait is durable and periodic checks do not rewrite the same task', async t => {
  const f = fixture(t), p = f.create()
  f.feed(p, 'first'); f.feed(p, 'second'); await p.flush()
  const waiting = readCaptureTasks(f.root).find(t => t.status === 'pending')
  assert.equal(waiting.waitReason, 'daily-budget')
  assert.equal(waiting.resumeAt, new Date(2026, 10, 8).getTime())
  await p.resume(); await p.resume()
  assert.deepEqual(readCaptureTasks(f.root).find(t => t.id === waiting.id), waiting)
  assert.equal(f.calls(), 1)
})

test('local midnight automatically resumes once without another turn or manual flush', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = fixture(t), p = f.create()
  f.feed(p, 'first'); f.feed(p, 'second'); await p.flush()
  f.advance(1100); t.mock.timers.tick(1100)
  await yieldLoop(); await yieldLoop()
  assert.equal(f.calls(), 2)
  assert.ok(readCaptureTasks(f.root).every(t => t.status === 'done'))
  await p.resume()
  assert.equal(f.calls(), 2)
})

test('restart restores the wait and disposal cancels its wake-up', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = fixture(t), old = f.create()
  f.feed(old, 'first'); f.feed(old, 'second'); await old.flush(); old.dispose()
  const next = f.create(); await next.resume()
  f.advance(1100); t.mock.timers.tick(1100)
  await yieldLoop(); await yieldLoop()
  assert.equal(f.calls(), 2)
  assert.equal(readCaptureTasks(f.root)[1].attempts, 1)
})

test('zero allowance does not advertise a timed retry; a changed limit wakes pending work', async t => {
  const f = fixture(t, 0), p = f.create()
  f.feed(p, 'first'); await p.flush()
  assert.equal(p.status().budget.resumeAt, null)
  assert.equal(f.calls(), 0)
  p.setConfig(f.config(1))
  await yieldLoop(); await yieldLoop()
  assert.equal(f.calls(), 1)
})

test('manual recovery and unknown receipts never receive a second automatic request', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = fixture(t), p = f.create()
  f.feed(p, 'first'); f.feed(p, 'manual'); f.feed(p, 'unknown'); await p.flush()
  const pending = readCaptureTasks(f.root).filter(t => t.status === 'pending')
  updateCaptureTask(f.root, pending[1].id, { status: 'pending', callState: 'requested', attempts: 1 })
  assert.equal(p.retry(pending[0].id).ok, true)
  await p.flush()
  f.advance(1100); t.mock.timers.tick(1100)
  await yieldLoop(); await p.resume()
  assert.equal(f.calls(), 2)
  assert.equal(readCaptureTasks(f.root).find(t => t.id === pending[1].id).callState, 'unknown')
})

test('legacy UTC call receipts still count after a local-calendar upgrade', async t => {
  const f = fixture(t)
  f.advance(30 * 60_000 + 1000) // 00:30 local: the UTC and local dates differ in Asia/Shanghai.
  const p = f.create()
  f.feed(p, 'first'); await p.flush(); p.dispose()
  const task = readCaptureTasks(f.root)[0]
  updateCaptureTask(f.root, task.id, { automaticCallAt: undefined,
    automaticCallDay: new Date(task.lastCallAt).toISOString().slice(0, 10),
    budgetReservation: { ...task.budgetReservation, calendar: undefined, at: undefined } })
  const next = f.create(); f.feed(next, 'second'); await next.flush()
  assert.equal(f.calls(), 1)
  assert.equal(next.status().budget.remaining, 0)
})
