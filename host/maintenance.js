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

import { readdirSync, readFileSync, rmSync, lstatSync } from 'node:fs'
import { join } from 'node:path'
import { verifyBackup } from './backup.js'
import { atomicWritePrivate } from './persistence.js'

const DAY_MS = 86_400_000
const BACKUP_PATTERN = /^memories-.*\.(?:json|backup)$/u

/** Newest backup mtime under `<root>/backups`, or null when there is none. */
async function newestCompleteBackup(root) {
  const dir = join(root, 'backups')
  const candidates = []
  try {
    for (const name of readdirSync(dir)) {
      if (!BACKUP_PATTERN.test(name) || !name.endsWith('.backup')) continue
      try {
        const stat = lstatSync(join(dir, name))
        if (stat.isDirectory()) candidates.push({ path: join(dir, name), time: stat.mtimeMs })
      } catch {
        // A vanished backup is not an error.
      }
    }
  } catch {
    // No backups directory yet.
  }
  candidates.sort((a, b) => b.time - a.time)
  for (const candidate of candidates) {
    try { const manifest = await verifyBackup(candidate.path); return { ...candidate, time: manifest.createdAt } } catch { /* A broken snapshot is not recovery coverage. */ }
  }
  return null
}

export async function newestBackupTime(root) { return (await newestCompleteBackup(root))?.time ?? null }

/** Keep the newest `keep` backups, delete the rest, return the deleted count. */
export function pruneBackups(root, keep, preserve = null) {
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
      const stat = lstatSync(join(dir, name))
      if (stat.isSymbolicLink()) continue
      entries.push({ name, time: stat.mtimeMs, directory: stat.isDirectory() })
    } catch {
      // Ignore races with the filesystem.
    }
  }
  entries.sort((left, right) => right.time - left.time)
  const retained = new Set(preserve ? [preserve] : [])
  for (const entry of entries) {
    if (retained.size >= keep) break
    retained.add(join(dir, entry.name))
  }
  let removed = 0
  for (const entry of entries) {
    if (retained.has(join(dir, entry.name))) continue
    try {
      rmSync(join(dir, entry.name), { recursive: entry.directory })
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
export async function runMaintenance(options) {
  const { store } = options
  const config = options.config ?? {}
  const now = typeof options.now === 'number' ? options.now : Date.now()
  const summary = {
    at: now,
    archived: 0,
    backedUp: null,
    pruned: 0,
    skipped: false,
    backupError: null,
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

  const newest = await newestCompleteBackup(store.root)
  if (newest === null || now < newest.time || now - newest.time > DAY_MS) {
    try {
      summary.backedUp = await store.backup()
    } catch {
      summary.backupError = { code: 'backup-failed', message: '完整备份未完成，已有备份保留。请稍后重试或检查磁盘与文件权限。' }
    }
  }
  if (!summary.backupError) summary.pruned = pruneBackups(store.root, config?.maintenance?.backupKeep ?? 7, summary.backedUp ?? newest?.path)
  writeSummary(store.root, summary)
  options.logger?.info?.(`[dsh-memory] maintenance: archived=${summary.archived} backup=${summary.backedUp === null ? 'skip' : 'ok'} pruned=${summary.pruned}`)
  return summary
}

/** Persist the last maintenance summary for the panel/debug output. */
function writeSummary(root, summary) {
  try {
    atomicWritePrivate(join(root, 'maintenance.json'), `${JSON.stringify(summary, null, 2)}\n`)
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
