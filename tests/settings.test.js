import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { mergeConfigObjects, readSettings, sanitizeSettings, settingsToConfig, writeSettings } from '../host/settings.js'

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-memory-settings-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

test('settings round-trip and clamp numeric fields', (t) => {
  const root = setup(t)
  assert.deepEqual(readSettings(root), {})
  const saved = writeSettings(root, { captureEnabled: false, injectMaxTokens: 99999, retentionEpisodeDays: -5 })
  assert.equal(saved.captureEnabled, false)
  assert.equal(saved.injectMaxTokens, 8000)
  assert.equal(saved.retentionEpisodeDays, 0)
  assert.deepEqual(readSettings(root), saved)
  const raw = JSON.parse(readFileSync(join(root, 'settings.json'), 'utf8'))
  assert.equal(raw.injectMaxTokens, 8000)
})

test('unknown and mistyped settings are ignored', () => {
  assert.deepEqual(sanitizeSettings({ unknown: 1, captureEnabled: 'yes', injectMaxTokens: 'big' }), {})
  assert.deepEqual(sanitizeSettings(null), {})
})

test('settingsToConfig maps flat settings to the nested config shape', () => {
  assert.deepEqual(settingsToConfig({
    captureEnabled: false,
    injectEnabled: true,
    injectMaxTokens: 900,
    retentionEpisodeDays: 30,
    maintenanceEnabled: false,
  }), {
    capture: { enabled: false },
    inject: { enabled: true, maxTokens: 900 },
    retention: { episodeDays: 30 },
    maintenance: { enabled: false },
  })
})

test('mergeConfigObjects merges nested sections without dropping defaults', () => {
  const merged = mergeConfigObjects(
    { capture: { enabled: true, minTurnChars: 200 }, inject: { maxTokens: 600 } },
    { capture: { enabled: false }, inject: { maxTokens: 900 } },
  )
  assert.deepEqual(merged, { capture: { enabled: false, minTurnChars: 200 }, inject: { maxTokens: 900 } })
})


test('settings persist the Obsidian vault path and folder', (t) => {
  const root = setup(t)
  const saved = writeSettings(root, { obsidianVaultPath: ' /Users/me/Vault ', obsidianFolder: 'DSH Notes' })
  assert.equal(saved.obsidianVaultPath, '/Users/me/Vault')
  assert.equal(saved.obsidianFolder, 'DSH Notes')
  const config = settingsToConfig(saved)
  assert.deepEqual(config.obsidian, { vaultPath: '/Users/me/Vault', folder: 'DSH Notes' })
})

test('automatic Obsidian sync is opt-in and persists with its target',()=>{
 const config=settingsToConfig({obsidianAutoSync:true,obsidianVaultPath:'/a/vault',obsidianFolder:'Memory'})
 assert.deepEqual(config.obsidian,{autoSync:true,vaultPath:'/a/vault',folder:'Memory'})
 assert.equal(sanitizeSettings({obsidianAutoSync:false}).obsidianAutoSync,false)
})
