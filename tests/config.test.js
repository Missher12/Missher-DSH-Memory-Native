import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_CONFIG, resolveConfig } from '../host/config.js'

test('resolveConfig returns the defaults for missing or invalid input', () => {
  for (const raw of [undefined, null, 'nope', 42, []]) {
    const config = resolveConfig(raw)
    assert.equal(config.enabled, true)
    assert.equal(config.capture.enabled, true)
    assert.equal(config.capture.minTurnChars, 200)
    assert.equal(config.capture.maxCallsPerDay, 50)
    assert.equal(config.capture.autoApproveConfidence, 0.75)
    assert.equal(config.inject.enabled, true)
    assert.equal(config.inject.maxTokens, 360)
    assert.equal(config.inject.maxItems, 6)
    assert.equal(config.inject.minScore, 0.2)
    assert.equal(config.extraction.maxInputTokens, 12000)
    assert.equal(config.extraction.maxOutputTokens, 4096)
    assert.equal(config.retention.episodeDays, 90)
    assert.equal(config.consolidation.auto, false)
    assert.equal(config.dataDir, null)
    assert.equal(config.projectKey, null)
  }
})

test('resolveConfig treats only explicit false as disabled', () => {
  assert.equal(resolveConfig({ enabled: false }).enabled, false)
  assert.equal(resolveConfig({ enabled: 'false' }).enabled, true)
  assert.equal(resolveConfig({ capture: { enabled: false } }).capture.enabled, false)
  assert.equal(resolveConfig({ inject: { enabled: 0 } }).inject.enabled, true)
})

test('resolveConfig clamps numeric fields into their supported ranges', () => {
  const low = resolveConfig({
    capture: { minTurnChars: -5, maxCallsPerDay: -1, autoApproveConfidence: -2 },
    inject: { maxTokens: 1, maxItems: 0, minScore: -1 },
    extraction: { maxInputTokens: 1, maxOutputTokens: 1 },
    retention: { episodeDays: -10 },
  })
  assert.equal(low.capture.minTurnChars, 0)
  assert.equal(low.capture.maxCallsPerDay, 0)
  assert.equal(low.capture.autoApproveConfidence, 0)
  assert.equal(low.inject.maxTokens, 100)
  assert.equal(low.inject.maxItems, 1)
  assert.equal(low.inject.minScore, 0)
  assert.equal(low.extraction.maxInputTokens, 1000)
  assert.equal(low.extraction.maxOutputTokens, 100)
  assert.equal(low.retention.episodeDays, 0)

  const high = resolveConfig({
    capture: { minTurnChars: 9999999, maxCallsPerDay: 999999, autoApproveConfidence: 5 },
    inject: { maxTokens: 999999, maxItems: 9999, minScore: 2 },
    extraction: { maxInputTokens: 9999999, maxOutputTokens: 999999 },
    retention: { episodeDays: 999999 },
  })
  assert.equal(high.capture.minTurnChars, 100000)
  assert.equal(high.capture.maxCallsPerDay, 10000)
  assert.equal(high.capture.autoApproveConfidence, 1)
  assert.equal(high.inject.maxTokens, 8000)
  assert.equal(high.inject.maxItems, 100)
  assert.equal(high.inject.minScore, 1)
  assert.equal(high.extraction.maxInputTokens, 200000)
  assert.equal(high.extraction.maxOutputTokens, 32000)
  assert.equal(high.retention.episodeDays, 36500)
})

test('resolveConfig floors integers and keeps fractional scores', () => {
  const config = resolveConfig({
    capture: { minTurnChars: 199.9, maxCallsPerDay: 12.7 },
    inject: { maxTokens: 599.2, maxItems: 7.9, minScore: 0.3333 },
  })
  assert.equal(config.capture.minTurnChars, 199)
  assert.equal(config.capture.maxCallsPerDay, 12)
  assert.equal(config.inject.maxTokens, 599)
  assert.equal(config.inject.maxItems, 7)
  assert.equal(config.inject.minScore, 0.3333)
})

test('resolveConfig falls back for non-finite numbers and wrong types', () => {
  const config = resolveConfig({
    capture: { minTurnChars: Number.NaN, maxCallsPerDay: '30', autoApproveConfidence: Infinity },
    inject: { maxTokens: null, maxItems: true, minScore: '0.5' },
    retention: { episodeDays: Number.NEGATIVE_INFINITY },
  })
  assert.equal(config.capture.minTurnChars, 200)
  assert.equal(config.capture.maxCallsPerDay, 50)
  assert.equal(config.capture.autoApproveConfidence, 0.75)
  assert.equal(config.inject.maxTokens, 360)
  assert.equal(config.inject.maxItems, 6)
  assert.equal(config.inject.minScore, 0.2)
  assert.equal(config.retention.episodeDays, 90)
})

test('resolveConfig trims provider/model strings and turns blanks into null', () => {
  assert.deepEqual(resolveConfig({ extraction: { provider: '  missher  ', model: ' deepseek-flash ' } }).extraction, {
    provider: 'missher',
    model: 'deepseek-flash',
    reasoningEffort: null,
    maxInputTokens: 12000,
    maxOutputTokens: 4096,
  })
  assert.equal(resolveConfig({ extraction: { provider: '   ', model: '' } }).extraction.provider, null)
  assert.equal(resolveConfig({ extraction: { provider: '   ', model: '' } }).extraction.model, null)
  assert.equal(resolveConfig({ dataDir: '  /tmp/x  ' }).dataDir, '/tmp/x')
  assert.equal(resolveConfig({ dataDir: '   ' }).dataDir, null)
  assert.equal(resolveConfig({ projectKey: ' demo ' }).projectKey, 'demo')
})

test('resolveConfig copies only known fields and ignores unknown ones', () => {
  const config = resolveConfig({ unknown: 1, capture: { nope: true, minTurnChars: 300 } })
  assert.equal(config.capture.minTurnChars, 300)
  assert.equal('unknown' in config, false)
  assert.equal('nope' in config.capture, false)
})

test('resolveConfig enables consolidation only for explicit true', () => {
  assert.equal(resolveConfig({ consolidation: { auto: true } }).consolidation.auto, true)
  assert.equal(resolveConfig({ consolidation: { auto: 1 } }).consolidation.auto, false)
  assert.equal(resolveConfig({ consolidation: { auto: 'true' } }).consolidation.auto, false)
})

test('resolveConfig returns a deeply frozen object', () => {
  const config = resolveConfig({ capture: { minTurnChars: 300 }, inject: { maxTokens: 700 } })
  assert.ok(Object.isFrozen(config))
  assert.ok(Object.isFrozen(config.capture))
  assert.ok(Object.isFrozen(config.inject))
  assert.ok(Object.isFrozen(config.extraction))
  assert.ok(Object.isFrozen(config.retention))
  assert.ok(Object.isFrozen(config.consolidation))
  assert.throws(() => {
    'use strict'
    config.inject.maxTokens = 9999
  })
})

test('DEFAULT_CONFIG is the frozen baseline resolveConfig falls back to', () => {
  assert.ok(Object.isFrozen(DEFAULT_CONFIG))
  assert.equal(DEFAULT_CONFIG.inject.maxTokens, 360)
  assert.equal(resolveConfig({}).inject.maxTokens, DEFAULT_CONFIG.inject.maxTokens)
})


test('config exposes Obsidian path and folder defaults', () => {
  assert.equal(DEFAULT_CONFIG.obsidian.folder, 'DSH Memory')
  const config = resolveConfig({ obsidian: { vaultPath: ' /tmp/vault ', folder: 'Notes' } })
  assert.equal(config.obsidian.vaultPath, '/tmp/vault')
  assert.equal(config.obsidian.folder, 'Notes')
  assert.equal(resolveConfig({ obsidian: { folder: '   ' } }).obsidian.folder, 'DSH Memory')
})
