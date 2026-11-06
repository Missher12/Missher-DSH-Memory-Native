import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  USAGE_FILE,
  USAGE_KEEP_LINES,
  appendUsage,
  computeUsageSummary,
  localDayKey,
  readUsage,
} from '../host/usage-log.js'

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-memory-usage-'))
  if (t !== undefined && typeof t.after === 'function') {
    t.after(() => rmSync(root, { recursive: true, force: true }))
  }
  return root
}

const NOW = new Date(2026, 9, 31, 12, 0, 0).getTime()
const DAY = 86_400_000

test('usage entries aggregate into injection and extraction totals', (t) => {
  const root = setup(t)
  appendUsage(root, { at: NOW, kind: 'inject', tokens: 240, items: 3, budget: 256 })
  appendUsage(root, { at: NOW - 1000, kind: 'inject', tokens: 200, items: 1, budget: 200 })
  appendUsage(root, { at: NOW, kind: 'inject', tokens: 300, items: 1, budget: 256 })
  appendUsage(root, { at: NOW, kind: 'extract', tokens: 812, items: 2, applied: 2, calls: 1 })

  const usage = readUsage(root, { now: NOW })
  assert.equal(usage.windowDays, 7)
  assert.equal(usage.days.length, 7)
  assert.equal(usage.days[6].date, localDayKey(NOW))
  assert.equal(usage.days[6].inject.calls, 3)
  assert.equal(usage.days[6].inject.tokens, 740)
  assert.equal(usage.days[6].inject.items, 5)
  assert.equal(usage.days[6].inject.overBudget, 1)
  assert.equal(usage.days[6].extract.calls, 1)
  assert.equal(usage.days[6].extract.tokens, 812)
  assert.equal(usage.days[6].extract.applied, 2)
  assert.equal(usage.totals.injectTokens, 740)
  assert.equal(usage.totals.overBudget, 1)
  assert.equal(usage.totals.extractTokens, 812)
  assert.equal(usage.totals.extractApplied, 2)
  assert.equal(usage.avgInjectTokens, 247)
  assert.equal(usage.peakInjectTokens, 740)
})

test('the window is zero-filled, oldest first and bounded', (t) => {
  const root = setup(t)
  appendUsage(root, { at: NOW - 2 * DAY, kind: 'inject', tokens: 300, items: 2, budget: 360 })
  appendUsage(root, { at: NOW - 30 * DAY, kind: 'inject', tokens: 999, items: 6, budget: 360 })

  const usage = readUsage(root, { now: NOW, days: 3 })
  assert.deepEqual(usage.days.map((day) => day.date), [
    localDayKey(NOW - 2 * DAY),
    localDayKey(NOW - DAY),
    localDayKey(NOW),
  ])
  assert.equal(usage.days[0].inject.tokens, 300)
  assert.equal(usage.days[1].inject.calls, 0)
  assert.equal(usage.totals.injectTokens, 300)
  assert.equal(readUsage(root, { now: NOW, days: 100 }).windowDays, 90)
})

test('corrupt lines and unknown kinds are ignored', (t) => {
  const root = setup(t)
  appendUsage(root, { at: NOW, kind: 'inject', tokens: 200, items: 1 })
  appendFileSync(join(root, USAGE_FILE), 'not json\n{"kind":"other","tokens":99,"at":1}\n{"kind":"inject","tokens":"x"}\n')
  const usage = readUsage(root, { now: NOW })
  assert.equal(usage.totals.injectTokens, 200)
  assert.equal(usage.totals.injectCalls, 1)
})

test('appendUsage never throws on a missing root or bad entry', () => {
  assert.doesNotThrow(() => appendUsage('', { kind: 'inject', tokens: 1 }))
  assert.doesNotThrow(() => appendUsage('/tmp/does-not-exist-dsh-memory', { kind: 'inject', tokens: 1 }))
  assert.doesNotThrow(() => appendUsage(tmpdir(), { kind: 'nope' }))
  assert.doesNotThrow(() => appendUsage(tmpdir(), null))
})

test('the log is compacted to the newest lines when it grows past the bound', (t) => {
  const root = setup(t)
  const file = join(root, USAGE_FILE)
  const lines = Array.from({ length: USAGE_KEEP_LINES + 3000 }, () => JSON.stringify({ at: NOW, kind: 'inject', tokens: 1, items: 0 }))
  writeFileSync(file, `${lines.join('\n')}\n`)
  appendUsage(root, { at: NOW, kind: 'inject', tokens: 5, items: 1 })
  const kept = readFileSync(file, 'utf8').trim().split('\n')
  assert.equal(kept.length, USAGE_KEEP_LINES + 1)
  assert.match(kept[kept.length - 1], /"tokens":5/u)
})

test('computeUsageSummary returns null without a root', () => {
  assert.equal(computeUsageSummary(null), null)
  assert.equal(computeUsageSummary(''), null)
})

test('provider usage is kept separate and missing values stay null', (t) => {
  const root = setup(t)
  appendUsage(root, {
    at: NOW,
    kind: 'extract',
    tokens: 812,
    items: 2,
    applied: 2,
    calls: 1,
    outcome: 'done',
    usage: { inputTokens: 600, outputTokens: 90, totalTokens: 690 },
  })
  const usage = readUsage(root, { now: NOW })
  assert.equal(usage.totals.extractTokens, 812)
  assert.equal(usage.totals.extractProviderCalls, 1)
  assert.equal(usage.totals.extractProviderInputTokens, 600)
  assert.equal(usage.totals.extractProviderTotalTokens, 690)

  const empty = setup(t)
  appendUsage(empty, { at: NOW, kind: 'extract', tokens: 100, items: 1, calls: 1 })
  const missing = readUsage(empty, { now: NOW })
  assert.equal(missing.totals.extractProviderCalls, 0)
  assert.equal(missing.totals.extractProviderInputTokens, null)
  assert.equal(missing.totals.extractProviderTotalTokens, null)
})
