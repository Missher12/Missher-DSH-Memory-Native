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
import { hasBackupCheckpoint, readBackupManifest, verifyBackup } from './backup.js'
import { atomicWritePrivate } from './persistence.js'

const DAY_MS = 86_400_000
const BACKUP_PATTERN = /^memories-.*\.(?:json|backup)$/u

function listBackups(root) {
  const dir = join(root, 'backups')
  let names
  try { names = readdirSync(dir) } catch { return [] }
  const entries = []
  for (const name of names) {
    if (!BACKUP_PATTERN.test(name)) continue
    const path = join(dir, name)
    try {
      const stat = lstatSync(path)
      if (!stat.isSymbolicLink()) entries.push({ path, time: stat.mtimeMs, directory: stat.isDirectory() })
    } catch {
      // The file may have been moved or removed.
    }
  }
  return entries.sort((a, b) => b.time - a.time)
}

async function* verifiedBackupsByFormat(entries) {
  const found = new Set()
  for (const { path, directory } of entries) {
    if (!directory || !path.endsWith('.backup')) continue
    try {
      const version = readBackupManifest(path).version
      const compatible = version !== 4
      if (found.has(compatible)) continue
      const manifest = await verifyBackup(path)
      if (manifest.version !== version) continue
      found.add(compatible)
      yield { path, time: manifest.createdAt, compatible }
      if (found.size === 2) return
    } catch {
      // A damaged or unreadable snapshot cannot establish recovery coverage.
    }
  }
}

export async function newestBackupTime(root) {
  for await (const backup of verifiedBackupsByFormat(listBackups(root))) return backup.time
  return null
}

/** Keep protected recovery points, then fill the remaining slots by recency. */
export function pruneBackups(root, keep, ...preserve) {
  const entries = listBackups(root)
  const retained = new Set(preserve.filter(Boolean))
  for (const entry of entries) {
    if (retained.size >= keep) break
    retained.add(entry.path)
  }
  let removed = 0
  for (const entry of entries) {
    if (retained.has(entry.path)) continue
    try {
      rmSync(entry.path, { recursive: entry.directory })
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

  const recoveryPoints = []
  for await (const backup of verifiedBackupsByFormat(listBackups(store.root))) recoveryPoints.push(backup)
  const compatible = recoveryPoints.find(backup => backup.compatible)
  let newest = recoveryPoints[0]
  const pendingFormat = hasBackupCheckpoint(store.root) ? 'compatible'
    : hasBackupCheckpoint(store.root, 'fast') ? 'fast' : null
  if (pendingFormat !== null || !compatible || now < compatible.time || now - compatible.time > DAY_MS) {
    try {
      const path = await store.backup(pendingFormat ?? 'compatible')
      newest = { path, compatible: readBackupManifest(path).version !== 4 }
      summary.backedUp = path
    } catch (error) {
      summary.backupError = error?.code === 'backup-source-changed'
        ? { code: 'backup-source-changed', message: '记忆在备份期间有更新，稍后会复用已核验的文件继续备份。' }
        : { code: 'backup-failed', message: '完整备份未完成，已有备份保留。请稍后重试或检查磁盘与文件权限。' }
    }
  }
  if (!summary.backupError) {
    const keep = config?.maintenance?.backupKeep ?? 7
    const fallback = keep > 1 && newest && recoveryPoints.find(backup => backup.compatible !== newest.compatible)
    summary.pruned = pruneBackups(store.root, keep, newest?.path, fallback?.path)
  }
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
