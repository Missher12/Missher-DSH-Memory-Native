/**
 * Self-maintenance: the memory system tidies itself on a schedule.
 *
 * Runs without user action: archives stale low-confidence episodes according to
 * the retention policy, writes a daily backup, prunes old backups, and records
 * what it did in `maintenance.json`. Everything is deterministic and local; the
 * panel can display the last run and the user can turn it off via config.
 *
 * @module dsh-memory/host/maintenance
 */

import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const DAY_MS = 86_400_000
const BACKUP_PATTERN = /^memories-.*\.json$/u

/** Newest backup mtime under `<root>/backups`, or null when there is none. */
export function newestBackupTime(root) {
  const dir = join(root, 'backups')
  let newest = null
  try {
    for (const name of readdirSync(dir)) {
      if (!BACKUP_PATTERN.test(name)) continue
      try {
        const time = statSync(join(dir, name)).mtimeMs
        if (newest === null || time > newest) newest = time
      } catch {
        // A vanished backup is not an error.
      }
    }
  } catch {
    // No backups directory yet.
  }
  return newest
}

/** Keep the newest `keep` backups, delete the rest, return the deleted count. */
export function pruneBackups(root, keep) {
  const dir = join(root, 'backups')
  let files
  try {
    files = readdirSync(dir).filter((name) => BACKUP_PATTERN.test(name))
  } catch {
    return 0
  }
  const entries = []
  for (const name of files) {
    try {
      entries.push({ name, time: statSync(join(dir, name)).mtimeMs })
    } catch {
      // Ignore races with the filesystem.
    }
  }
  entries.sort((left, right) => right.time - left.time)
  let removed = 0
  for (const entry of entries.slice(keep)) {
    try {
      rmSync(join(dir, entry.name))
      removed += 1
    } catch {
      // Best effort.
    }
  }
  return removed
}

/**
 * Run one maintenance pass.
 * @param {{ store: object, config: object, now?: number, logger?: object }} options
 */
export function runMaintenance(options) {
  const { store } = options
  const config = options.config ?? {}
  const now = typeof options.now === 'number' ? options.now : Date.now()
  const summary = {
    at: now,
    archived: 0,
    backedUp: null,
    pruned: 0,
    skipped: false,
  }
  if (config?.maintenance?.enabled === false) {
    summary.skipped = true
    writeSummary(store.root, summary)
    return summary
  }

  const episodeDays = config?.retention?.episodeDays ?? 90
  if (episodeDays > 0) {
    const scopes = [{ scope: 'global', projectKey: null }]
    for (const projectKey of store.listProjects()) scopes.push({ scope: 'project', projectKey })
    for (const scope of scopes) {
      for (const record of store.list(scope.scope, scope.projectKey)) {
        if (record.kind !== 'episode' || record.status !== 'active') continue
        if (record.pinned === true) continue
        if ((record.confidence ?? 0.5) >= 0.75) continue
        const age = now - (record.updatedAt ?? record.observedAt ?? now)
        if (age <= episodeDays * DAY_MS) continue
        const updated = store.update(record.id, { status: 'archived' }, [scope])
        if (updated !== undefined) summary.archived += 1
      }
    }
  }

  const newest = newestBackupTime(store.root)
  if (newest === null || now - newest > DAY_MS) {
    try {
      summary.backedUp = store.backup()
    } catch {
      summary.backedUp = null
    }
  }
  summary.pruned = pruneBackups(store.root, config?.maintenance?.backupKeep ?? 7)
  writeSummary(store.root, summary)
  options.logger?.info?.(`[dsh-memory] maintenance: archived=${summary.archived} backup=${summary.backedUp === null ? 'skip' : 'ok'} pruned=${summary.pruned}`)
  return summary
}

/** Persist the last maintenance summary for the panel/debug output. */
function writeSummary(root, summary) {
  try {
    writeFileSync(join(root, 'maintenance.json'), `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 })
  } catch {
    // Maintenance is advisory; never fail activation over its report.
  }
}

/** Read the last maintenance summary, or null. */
export function readMaintenance(root) {
  try {
    const parsed = JSON.parse(readFileSync(join(root, 'maintenance.json'), 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}
