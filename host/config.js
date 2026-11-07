/**
 * Plugin configuration: defaults, tolerant merging and clamping.
 *
 * The plugin does not export a `Config` schema (the Host would validate it
 * through schemastery/zod, which a dependency-free plain bundle cannot import).
 * `resolveConfig` is the single validation point for the row's `config` object;
 * unknown fields are ignored and every numeric field is clamped.
 *
 * @module dsh-memory/host/config
 */

export const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  dataDir: null,
  projectKey: null,
  capture: Object.freeze({
    enabled: true,
    minTurnChars: 200,
    maxCallsPerDay: 50,
    autoApproveConfidence: 0.75,
  }),
  extraction: Object.freeze({
    provider: null,
    model: null,
    reasoningEffort: null,
    maxInputTokens: 12000,
    // Some host routes count reasoning inside this cap, including with "off".
    maxOutputTokens: 4096,
  }),
  inject: Object.freeze({
    enabled: true,
    maxTokens: 360,
    maxItems: 12,
    minScore: 0.2,
  }),
  retention: Object.freeze({
    episodeDays: 90,
  }),
  consolidation: Object.freeze({
    auto: false,
  }),
  maintenance: Object.freeze({
    enabled: true,
    intervalHours: 24,
    backupKeep: 7,
  }),
  obsidian: Object.freeze({
    autoSync: false,
    vaultPath: null,
    folder: 'DSH Memory',
  }),
})

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function integerIn(value, fallback, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.floor(value)))
}

function numberIn(value, fallback, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

function optionalString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

/**
 * Merge a raw patch config over the defaults and clamp every value.
 * @param {unknown} raw
 */
export function resolveConfig(raw) {
  const input = isPlainObject(raw) ? raw : {}
  const capture = isPlainObject(input.capture) ? input.capture : {}
  const extraction = isPlainObject(input.extraction) ? input.extraction : {}
  const inject = isPlainObject(input.inject) ? input.inject : {}
  const retention = isPlainObject(input.retention) ? input.retention : {}
  const consolidation = isPlainObject(input.consolidation) ? input.consolidation : {}
  const maintenance = isPlainObject(input.maintenance) ? input.maintenance : {}
  const obsidian = isPlainObject(input.obsidian) ? input.obsidian : {}

  return Object.freeze({
    enabled: input.enabled !== false,
    dataDir: optionalString(input.dataDir),
    projectKey: optionalString(input.projectKey),
    capture: Object.freeze({
      enabled: capture.enabled !== false,
      minTurnChars: integerIn(capture.minTurnChars, DEFAULT_CONFIG.capture.minTurnChars, 0, 100000),
      maxCallsPerDay: integerIn(capture.maxCallsPerDay, DEFAULT_CONFIG.capture.maxCallsPerDay, 0, 10000),
      autoApproveConfidence: numberIn(capture.autoApproveConfidence, DEFAULT_CONFIG.capture.autoApproveConfidence, 0, 1),
    }),
    extraction: Object.freeze({
      provider: optionalString(extraction.provider),
      model: optionalString(extraction.model),
      reasoningEffort: optionalString(extraction.reasoningEffort),
      maxInputTokens: integerIn(extraction.maxInputTokens, DEFAULT_CONFIG.extraction.maxInputTokens, 1000, 200000),
      maxOutputTokens: integerIn(extraction.maxOutputTokens, DEFAULT_CONFIG.extraction.maxOutputTokens, 100, 32000),
    }),
    inject: Object.freeze({
      enabled: inject.enabled !== false,
      maxTokens: integerIn(inject.maxTokens, DEFAULT_CONFIG.inject.maxTokens, 100, 8000),
      maxItems: integerIn(inject.maxItems, DEFAULT_CONFIG.inject.maxItems, 1, 100),
      minScore: numberIn(inject.minScore, DEFAULT_CONFIG.inject.minScore, 0, 1),
    }),
    retention: Object.freeze({
      episodeDays: integerIn(retention.episodeDays, DEFAULT_CONFIG.retention.episodeDays, 0, 36500),
    }),
    consolidation: Object.freeze({
      auto: consolidation.auto === true,
    }),
    maintenance: Object.freeze({
      enabled: maintenance.enabled !== false,
      intervalHours: integerIn(maintenance.intervalHours, DEFAULT_CONFIG.maintenance.intervalHours, 1, 720),
      backupKeep: integerIn(maintenance.backupKeep, DEFAULT_CONFIG.maintenance.backupKeep, 1, 100),
    }),
    obsidian: Object.freeze({
      autoSync: obsidian.autoSync === true,
      vaultPath: optionalString(obsidian.vaultPath),
      folder: optionalString(obsidian.folder) ?? DEFAULT_CONFIG.obsidian.folder,
    }),
  })
}
