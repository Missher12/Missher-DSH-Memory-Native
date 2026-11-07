import assert from 'node:assert/strict'
import fs, { mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
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

test('corrupt persisted settings cannot silently reactivate default capture', t => {
  const root = setup(t), file = join(root, 'settings.json')
  for (const invalid of ['{"captureEnabled":false', '[]', 'null', '{"captureEnabled":"false"}']) {
    writeFileSync(file, invalid)
    assert.throws(() => readSettings(root), /设置/u)
    assert.throws(() => writeSettings(root, { injectEnabled: false }), /设置/u)
    assert.equal(readFileSync(file, 'utf8'), invalid)
  }
})

test('failed settings commit preserves the prior policy and leaves no temporary file', t => {
  const root = setup(t), file = join(root, 'settings.json')
  writeSettings(root, { captureEnabled: false, injectEnabled: false })
  const before = readFileSync(file), rename = fs.renameSync
  fs.renameSync = (from, to) => { if (to === file) throw Object.assign(new Error('disk commit failure'), { code: 'EIO' }); return rename(from, to) }
  syncBuiltinESMExports()
  try { assert.throws(() => writeSettings(root, { captureEnabled: true }), /disk commit failure/u) }
  finally { fs.renameSync = rename; syncBuiltinESMExports() }
  assert.deepEqual(readFileSync(file), before)
  assert.deepEqual(readdirSync(root), ['settings.json'])
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
