/**
 * Token-usage telemetry: one append-only JSONL line per injection or
 * extraction pass, aggregated into a bounded daily series for the panel.
 *
 * The log is purely advisory: a missing, corrupt or oversized file never
 * breaks recall or capture. Only token counts, item counts and the injection
 * budget are stored — never prompt text, queries or memory content.
 *
 * @module dsh-memory/host/usage-log
 */

import { appendFileSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const USAGE_FILE = 'usage.jsonl'
/** File size above which the oldest lines are dropped on the next append. */
export const USAGE_MAX_BYTES = 256 * 1024
/** Lines kept when the log is compacted. */
export const USAGE_KEEP_LINES = 2000
const DAY_MS = 86_400_000
const KINDS = new Set(['inject', 'extract'])

function integer(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0
}

function optionalInteger(value) {
  return Number.isInteger(value) && value >= 0 ? value : undefined
}

/** Local calendar day of a timestamp, as `YYYY-MM-DD`. */
export function localDayKey(ms) {
  const date = new Date(ms)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

function startOfLocalDay(ms) {
  const date = new Date(ms)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

function serialize(entry, at) {
  const line = {
    at,
    kind: entry.kind,
    tokens: integer(entry.tokens),
    items: integer(entry.items),
  }
  if (entry.kind === 'inject') {
    const budget = optionalInteger(entry.budget)
    if (budget !== undefined) line.budget = budget
  } else {
    const applied = optionalInteger(entry.applied)
    const calls = optionalInteger(entry.calls)
    if (applied !== undefined) line.applied = applied
    if (calls !== undefined) line.calls = calls
    if (typeof entry.outcome === 'string' && entry.outcome !== '') line.outcome = entry.outcome
    if (entry.usage !== null && typeof entry.usage === 'object') {
      for (const [key, value] of Object.entries({
        providerInputTokens: entry.usage.inputTokens,
        providerOutputTokens: entry.usage.outputTokens,
        providerTotalTokens: entry.usage.totalTokens,
      })) {
        if (Number.isInteger(value) && value >= 0) line[key] = value
      }
    }
  }
  return `${JSON.stringify(line)}\n`
}

/** Drop the oldest lines when the log grew past its size bound. */
function compact(file) {
  let text
  try {
    if (statSync(file).size <= USAGE_MAX_BYTES) return
    text = readFileSync(file, 'utf8')
  } catch {
    return
  }
  const lines = text.split('\n').filter((line) => line !== '')
  if (lines.length <= USAGE_KEEP_LINES) return
  try {
    writeFileSync(file, `${lines.slice(-USAGE_KEEP_LINES).join('\n')}\n`, { mode: 0o600 })
  } catch {
    // Compaction is best effort; appending still works.
  }
}

/**
 * Append one usage line. Never throws and never records free-form text.
 * @param {string} root memory data root
 * @param {{ at?: number, kind: 'inject' | 'extract', tokens?: number, items?: number,
 *   budget?: number, applied?: number, calls?: number }} entry
 */
export function appendUsage(root, entry) {
  try {
    if (typeof root !== 'string' || root === '') return
    if (entry === null || typeof entry !== 'object' || !KINDS.has(entry.kind)) return
    const at = typeof entry.at === 'number' && Number.isFinite(entry.at) ? entry.at : Date.now()
    const file = join(root, USAGE_FILE)
    compact(file)
    appendFileSync(file, serialize(entry, at), { mode: 0o600 })
  } catch {
    // Telemetry must never break a turn.
  }
}

function emptyBucket(date) {
  return {
    date,
    inject: { calls: 0, tokens: 0, items: 0, overBudget: 0 },
    extract: {
      calls: 0,
      tokens: 0,
      items: 0,
      applied: 0,
      providerCalls: 0,
      providerInputCalls: 0,
      providerOutputCalls: 0,
      providerTotalCalls: 0,
      providerInputTokens: 0,
      providerOutputTokens: 0,
      providerTotalTokens: 0,
    },
  }
}

/**
 * Aggregate the log into a fixed-length window of local days (oldest first,
 * zero-filled). `now` is injectable for tests.
 * @param {string} root
 * @param {{ days?: number, now?: number }} [options]
 */
export function readUsage(root, options = {}) {
  const windowDays = Math.min(90, Math.max(1, Number.isInteger(options.days) ? options.days : 7))
  const now = typeof options.now === 'number' ? options.now : Date.now()
  const today = startOfLocalDay(now)
  const start = today - (windowDays - 1) * DAY_MS
  const buckets = new Map()
  const order = []
  for (let index = 0; index < windowDays; index += 1) {
    const date = localDayKey(start + index * DAY_MS)
    buckets.set(date, emptyBucket(date))
    order.push(date)
  }

  let lines = []
  try {
    lines = readFileSync(join(root, USAGE_FILE), 'utf8').split('\n')
  } catch {
    lines = []
  }
  for (const line of lines) {
    if (line === '') continue
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (entry === null || typeof entry !== 'object' || !KINDS.has(entry.kind)) continue
    if (typeof entry.at !== 'number' || !Number.isFinite(entry.at)) continue
    if (entry.at < start) continue
    const bucket = buckets.get(localDayKey(entry.at))
    if (bucket === undefined) continue
    const tokens = integer(entry.tokens)
    const items = integer(entry.items)
    if (entry.kind === 'inject') {
      bucket.inject.calls += 1
      bucket.inject.tokens += tokens
      bucket.inject.items += items
      if (Number.isInteger(entry.budget) && tokens > entry.budget) bucket.inject.overBudget += 1
    } else {
      bucket.extract.calls += 1
      bucket.extract.tokens += tokens
      bucket.extract.items += items
      bucket.extract.applied += integer(entry.applied)
      const providerFields = ['providerInputTokens', 'providerOutputTokens', 'providerTotalTokens']
      if (providerFields.some((field) => Number.isInteger(entry[field]))) {
        bucket.extract.providerCalls += 1
        if (Number.isInteger(entry.providerInputTokens)) {
          bucket.extract.providerInputCalls += 1
          bucket.extract.providerInputTokens += entry.providerInputTokens
        }
        if (Number.isInteger(entry.providerOutputTokens)) {
          bucket.extract.providerOutputCalls += 1
          bucket.extract.providerOutputTokens += entry.providerOutputTokens
        }
        if (Number.isInteger(entry.providerTotalTokens)) {
          bucket.extract.providerTotalCalls += 1
          bucket.extract.providerTotalTokens += entry.providerTotalTokens
        }
      }
    }
  }

  const days = order.map((date) => buckets.get(date))
  const totals = {
    injectCalls: 0,
    injectTokens: 0,
    injectItems: 0,
    overBudget: 0,
    extractCalls: 0,
    extractTokens: 0,
    extractItems: 0,
    extractApplied: 0,
    extractProviderCalls: 0,
    extractProviderInputCalls: 0,
    extractProviderOutputCalls: 0,
    extractProviderTotalCalls: 0,
    extractProviderInputTokens: 0,
    extractProviderOutputTokens: 0,
    extractProviderTotalTokens: 0,
  }
  for (const day of days) {
    totals.injectCalls += day.inject.calls
    totals.injectTokens += day.inject.tokens
    totals.injectItems += day.inject.items
    totals.overBudget += day.inject.overBudget
    totals.extractCalls += day.extract.calls
    totals.extractTokens += day.extract.tokens
    totals.extractItems += day.extract.items
    totals.extractApplied += day.extract.applied
    totals.extractProviderCalls += day.extract.providerCalls
    totals.extractProviderInputCalls += day.extract.providerInputCalls
    totals.extractProviderOutputCalls += day.extract.providerOutputCalls
    totals.extractProviderTotalCalls += day.extract.providerTotalCalls
    totals.extractProviderInputTokens += day.extract.providerInputTokens
    totals.extractProviderOutputTokens += day.extract.providerOutputTokens
    totals.extractProviderTotalTokens += day.extract.providerTotalTokens
  }
  return {
    windowDays,
    days,
    totals: {
      ...totals,
      // Each field is null when no provider call supplied that field; a missing
      // value is never reported as zero.
      extractProviderInputTokens: totals.extractProviderInputCalls > 0 ? totals.extractProviderInputTokens : null,
      extractProviderOutputTokens: totals.extractProviderOutputCalls > 0 ? totals.extractProviderOutputTokens : null,
      extractProviderTotalTokens: totals.extractProviderTotalCalls > 0 ? totals.extractProviderTotalTokens : null,
    },
    avgInjectTokens: totals.injectCalls === 0 ? 0 : Math.round(totals.injectTokens / totals.injectCalls),
    peakInjectTokens: days.reduce((max, day) => Math.max(max, day.inject.tokens), 0),
  }
}

/** Compact summary for `stats.usage`; `null` when no root is available. */
export function computeUsageSummary(root, options = {}) {
  if (typeof root !== 'string' || root === '') return null
  return readUsage(root, options)
}
