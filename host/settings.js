/**
 * User-editable settings persisted next to the memory authority.
 *
 * The panel writes `settings.json`; activation merges it over the bundle row
 * config, so a change survives restarts without editing the profile. Only the
 * fields the panel exposes are accepted; values are clamped here once.
 *
 * @module dsh-memory/host/settings
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { atomicWritePrivate, withFileLock } from './persistence.js'

export const SETTINGS_FILE = 'settings.json'

const LIMITS = Object.freeze({
  injectMaxTokens: { min: 100, max: 8000 },
  retentionEpisodeDays: { min: 0, max: 36_500 },
})

function clampInteger(value, fallback, { min, max }) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.floor(value)))
}

/** Keep only known, well-typed fields. */
export function sanitizeSettings(raw) {
  const input = raw !== null && typeof raw === 'object' ? raw : {}
  const out = {}
  if (typeof input.captureEnabled === 'boolean') out.captureEnabled = input.captureEnabled
  if (typeof input.injectEnabled === 'boolean') out.injectEnabled = input.injectEnabled
  if (typeof input.injectMaxTokens === 'number') out.injectMaxTokens = clampInteger(input.injectMaxTokens, 600, LIMITS.injectMaxTokens)
  if (typeof input.retentionEpisodeDays === 'number') out.retentionEpisodeDays = clampInteger(input.retentionEpisodeDays, 90, LIMITS.retentionEpisodeDays)
  if (typeof input.maintenanceEnabled === 'boolean') out.maintenanceEnabled = input.maintenanceEnabled
  if (typeof input.obsidianAutoSync === 'boolean') out.obsidianAutoSync = input.obsidianAutoSync
  if (typeof input.obsidianVaultPath === 'string') out.obsidianVaultPath = input.obsidianVaultPath.trim()
  if (typeof input.obsidianFolder === 'string' && input.obsidianFolder.trim() !== '') out.obsidianFolder = input.obsidianFolder.trim().slice(0, 64)
  return out
}

/** Only a missing file means no overrides; unreadable policy must fail closed. */
export function readSettings(root) {
  let text
  try {
    text = readFileSync(join(root, SETTINGS_FILE), 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return {}
    throw Object.assign(new Error('记忆设置无法读取，已停止自动处理。请检查文件权限后重试。'), { code: 'settings-unreadable', cause: error })
  }
  try {
    const parsed = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('settings must be an object')
    const sanitized = sanitizeSettings(parsed)
    const known = ['captureEnabled', 'injectEnabled', 'injectMaxTokens', 'retentionEpisodeDays', 'maintenanceEnabled', 'obsidianAutoSync', 'obsidianVaultPath', 'obsidianFolder']
    for (const key of known) {
      if (Object.hasOwn(parsed, key) && !Object.hasOwn(sanitized, key)) throw new Error('invalid setting type')
    }
    return sanitized
  } catch (error) {
    throw Object.assign(new Error('记忆设置已损坏，已停止自动处理。请在设置页重新保存；原文件会保留。'), { code: 'settings-invalid', cause: error })
  }
}

/** Merge a validated patch into the file and return the full settings object. */
export function writeSettings(root, patch) {
  return withFileLock(join(root, '.settings.lock'), () => {
    const merged = sanitizeSettings({ ...readSettings(root), ...(patch !== null && typeof patch === 'object' ? patch : {}) })
    atomicWritePrivate(join(root, SETTINGS_FILE), `${JSON.stringify(merged, null, 2)}\n`)
    return merged
  })
}

/** An explicit full policy save repairs invalid JSON and preserves its bytes. */
export function repairSettings(root, patch) {
  for (const key of ['captureEnabled', 'injectEnabled', 'maintenanceEnabled', 'obsidianAutoSync']) {
    if (typeof patch?.[key] !== 'boolean') throw new Error('请检查并保存全部自动处理开关，再恢复记忆设置。')
  }
  return withFileLock(join(root, '.settings.lock'), () => {
    let current = {}
    try { current = readSettings(root) }
    catch (error) {
      if (error?.code !== 'settings-invalid') throw error
      atomicWritePrivate(join(root, `settings.invalid-${randomUUID()}.json`), readFileSync(join(root, SETTINGS_FILE)))
    }
    const merged = sanitizeSettings({ ...current, ...patch })
    atomicWritePrivate(join(root, SETTINGS_FILE), `${JSON.stringify(merged, null, 2)}\n`)
    return merged
  })
}

/** Translate settings into a config patch that `resolveConfig` understands. */
export function settingsToConfig(settings) {
  const value = settings !== null && typeof settings === 'object' ? settings : {}
  const out = {}
  if (typeof value.captureEnabled === 'boolean') out.capture = { enabled: value.captureEnabled }
  if (typeof value.injectEnabled === 'boolean' || typeof value.injectMaxTokens === 'number') {
    out.inject = {
      ...(typeof value.injectEnabled === 'boolean' ? { enabled: value.injectEnabled } : {}),
      ...(typeof value.injectMaxTokens === 'number' ? { maxTokens: value.injectMaxTokens } : {}),
    }
  }
  if (typeof value.retentionEpisodeDays === 'number') out.retention = { episodeDays: value.retentionEpisodeDays }
  if (typeof value.maintenanceEnabled === 'boolean') out.maintenance = { enabled: value.maintenanceEnabled }
  if (typeof value.obsidianAutoSync === 'boolean' || typeof value.obsidianVaultPath === 'string' || typeof value.obsidianFolder === 'string') {
    out.obsidian = {
      ...(typeof value.obsidianAutoSync === 'boolean' ? { autoSync: value.obsidianAutoSync } : {}),
      ...(typeof value.obsidianVaultPath === 'string' ? { vaultPath: value.obsidianVaultPath === '' ? null : value.obsidianVaultPath } : {}),
      ...(typeof value.obsidianFolder === 'string' ? { folder: value.obsidianFolder } : {}),
    }
  }
  return out
}

/** Recursively merge two plain config objects; later values win. */
export function mergeConfigObjects(base, override) {
  const left = base !== null && typeof base === 'object' ? base : {}
  const right = override !== null && typeof override === 'object' ? override : {}
  const out = { ...left }
  for (const [key, value] of Object.entries(right)) {
    const previous = out[key]
    out[key] = value !== null && typeof value === 'object' && !Array.isArray(value) && previous !== null && typeof previous === 'object'
      ? mergeConfigObjects(previous, value)
      : value
  }
  return out
}
