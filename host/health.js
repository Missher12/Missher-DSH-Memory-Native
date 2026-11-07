/** Deliberately allowlisted diagnostics: no content, path, record/session ID or raw error. */
import { readFileSync } from 'node:fs'
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const number = value => Number.isSafeInteger(value) && value >= 0 ? value : 0
const unavailableCodes = new Set(['profile-unavailable', 'storage-owner-conflict', 'storage-owner-invalid'])

export function storageIssue(error) {
  const code = unavailableCodes.has(error?.code) ? error.code : 'storage-unavailable'
  return { code, message: code === 'storage-unavailable'
    ? '记忆存储暂时不可用，已暂停读写。请检查数据目录权限、磁盘空间和文件版本后重新加载插件。'
    : error.message }
}

export function memoryHealth({ isolation, unavailable, settingsIssue, maintenance, capture, store, total, deleted } = {}) {
  const counts = {
    memories: number(total), deleted: number(deleted),
    corruptLines: (store?.stats?.() ?? []).reduce((sum, scope) => sum + number(scope.corrupt), 0),
    pending: number(capture?.pending), running: number(capture?.running),
    partial: number(capture?.partial), failed: number(capture?.failed), unknown: number(capture?.unknown),
  }
  const issues = []
  if (unavailable) issues.push(unavailableCodes.has(unavailable.code) ? unavailable.code : 'storage-unavailable')
  if (settingsIssue) issues.push(settingsIssue.code === 'settings-invalid' ? 'settings-invalid' : 'settings-unreadable')
  if (isolation !== 'profile' && !unavailable) issues.push('profile-explicit')
  if (maintenance?.backupError) issues.push('backup-failed')
  if (counts.corruptLines) issues.push('corrupt-lines')
  if (counts.failed || counts.partial) issues.push('capture-incomplete')
  if (counts.unknown) issues.push('capture-unknown')
  return { version, at: Date.now(), status: unavailable ? 'unavailable' : issues.length ? 'attention' : 'ok',
    isolation: isolation === 'profile' ? 'profile' : isolation === 'explicit' ? 'explicit' : 'unavailable', counts, issues }
}
