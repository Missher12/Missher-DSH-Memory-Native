/**
 * User-editable settings persisted next to the memory authority.
 *
 * The panel writes `settings.json`; activation merges it over the bundle row
 * config, so a change survives restarts without editing the profile. Only the
 * fields the panel exposes are accepted; values are clamped here once.
 *
 * @module dsh-memory/host/settings
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

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
  return out
}

/** Read `settings.json`; a missing or corrupt file means "no overrides". */
export function readSettings(root) {
  try {
    return sanitizeSettings(JSON.parse(readFileSync(join(root, SETTINGS_FILE), 'utf8')))
  } catch {
    return {}
  }
}

/** Merge a validated patch into the file and return the full settings object. */
export function writeSettings(root, patch) {
  const merged = sanitizeSettings({ ...readSettings(root), ...(patch !== null && typeof patch === 'object' ? patch : {}) })
  writeFileSync(join(root, SETTINGS_FILE), `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 })
  return merged
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
