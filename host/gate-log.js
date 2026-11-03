/**
 * Recall-gate audit log: gray-zone candidates are never injected without a
 * model verdict, but keeping a hashed trace makes the trade-off reviewable.
 * The raw query is never written; only a short hash is stored.
 *
 * @module dsh-memory/host/gate-log
 */

import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'

/** Append one gate decision to `<root>/recall-gate.jsonl`. Never throws. */
export function writeGateLog(root, entry) {
  try {
    const queryHash = createHash('sha256').update(String(entry.query ?? '')).digest('hex').slice(0, 12)
    const line = JSON.stringify({
      at: entry.at ?? Date.now(),
      queryHash,
      ids: Array.isArray(entry.ids) ? entry.ids : [],
      thresholds: entry.thresholds ?? null,
      reason: entry.reason ?? 'no-model',
    })
    appendFileSync(join(root, 'recall-gate.jsonl'), `${line}\n`)
  } catch {
    // The gate works without its log; never fail a turn for telemetry.
  }
}
