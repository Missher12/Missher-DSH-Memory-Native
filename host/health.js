/** Deliberately allowlisted diagnostics: no content, path, record/session ID or raw error. */
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { open, readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const number = value => Number.isSafeInteger(value) && value >= 0 ? value : 0
const unavailableCodes = new Set(['profile-unavailable', 'storage-owner-conflict', 'storage-owner-invalid'])
const issueCodes = new Set(['storage-probe-failed', 'panel-unavailable', 'panel-check-failed', 'hooks-unavailable',
  'capture-incomplete', 'extraction-route-unavailable', 'lexical-failed', 'semantic-failed', 'injection-failed', 'obsidian-failed'])
const actions = new Set(['none', 'capture', 'model', 'obsidian'])

/** Small local round-trip probe; the temporary bytes and filename never leave the host. */
export async function probeStorage(root) {
  if (typeof root !== 'string' || root === '') return { state: 'unavailable', issue: 'storage-probe-failed' }
  const file = join(root, `.health-${randomUUID()}.tmp`)
  let handle
  try {
    handle = await open(file, 'wx', 0o600)
    await handle.writeFile('dsh-memory-health')
    await handle.close();handle = null
    if (await readFile(file, 'utf8') !== 'dsh-memory-health') throw new Error('round-trip failed')
    await unlink(file)
    return { state: 'ready' }
  } catch {
    await handle?.close().catch(() => {})
    await unlink(file).catch(() => {})
    return { state: 'failed', issue: 'storage-probe-failed' }
  }
}

export function storageIssue(error) {
  const code = unavailableCodes.has(error?.code) ? error.code : 'storage-unavailable'
  return { code, message: code === 'storage-unavailable'
    ? '记忆存储暂时不可用，已暂停读写。请检查数据目录权限、磁盘空间和文件版本后重新加载插件。'
    : error.message }
}

export function memoryHealth({ isolation, unavailable, settingsIssue, maintenance, capture, store, total, deleted, checks = {} } = {}) {
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
  const make = (state, action = 'none', issue = null) => ({
    state: ['ready', 'waiting', 'disabled', 'running', 'attention', 'unavailable'].includes(state) ? state : 'waiting',
    action: actions.has(action) ? action : 'none',
    issue: issueCodes.has(issue) ? issue : null,
  })
  const storage = checks.storage?.state === 'failed' ? make('attention', 'none', 'storage-probe-failed') :
    unavailable ? make('unavailable', 'reload') : checks.storage?.state === 'pending' ? make('running') : make('ready')
  const panel = checks.panel?.transport === 'unavailable' ? make('unavailable', 'none', 'panel-unavailable') :
    checks.panel?.selfTest === 'failed' ? make('attention', 'none', 'panel-check-failed') :
    checks.panel?.selfTest === 'ready' ? make('ready') : make('waiting', 'none')
  const hooks = checks.hooks?.sessionEventRegistered === false || checks.hooks?.preStepRegistered === false
    ? make('attention', 'none', 'hooks-unavailable')
    : number(checks.hooks?.events) + number(checks.hooks?.preSteps) ? make('ready') : make('waiting')
  const captureState = checks.capture?.enabled === false ? make('disabled', 'capture') :
    number(checks.capture?.failed) + number(checks.capture?.partial) + number(checks.capture?.unknown)
      ? make('attention', 'capture', 'capture-incomplete') :
    number(checks.capture?.running) ? make('running', 'capture') :
    number(checks.hooks?.userMessages) ? make('ready') : make('waiting')
  const extraction = checks.extraction?.enabled === false ? make('disabled', 'capture') :
    number(checks.extraction?.routeUnavailable) ? make('attention', 'capture', 'extraction-route-unavailable') :
    checks.extraction?.lastStatus === 'failed' || checks.extraction?.lastStatus === 'partial' || checks.extraction?.lastStatus === 'unknown'
      ? make('attention', 'capture', 'capture-incomplete') :
    number(checks.extraction?.running) ? make('running', 'capture') :
    checks.extraction?.lastStatus ? make('ready') : make('waiting')
  const lexical = number(checks.lexical?.failures) ? make('attention', 'none', 'lexical-failed') :
    number(checks.lexical?.runs) ? make('ready') : make('waiting')
  const semanticState = checks.semantic?.state
  const semantic = semanticState === 'disabled' ? make('disabled', 'model') :
    semanticState === 'failed' ? make('attention', 'model', 'semantic-failed') :
    ['preparing', 'downloading', 'importing', 'loading'].includes(semanticState) ? make('running', 'model') :
    semanticState === 'ready' ? make('ready') : semanticState === 'indexing' ? make('running', 'model') : make('waiting', 'model')
  const injection = checks.injection?.enabled === false ? make('disabled', 'capture') :
    number(checks.injection?.failures) ? make('attention', 'capture', 'injection-failed') :
    number(checks.injection?.injected) ? make('ready') :
    number(checks.injection?.attempts) ? make('waiting', 'capture') : make('waiting')
  const obsidian = checks.obsidian?.enabled === false ? make('disabled', 'obsidian') :
    checks.obsidian?.running ? make('running', 'obsidian') :
    number(checks.obsidian?.errors) || checks.obsidian?.watchersReady === false && checks.obsidian?.lastAt
      ? make('attention', 'obsidian', 'obsidian-failed') :
    checks.obsidian?.lastAt ? make('ready', 'obsidian') : make('waiting', 'obsidian')
  const components = { storage, panel, hooks, capture: captureState, extraction, lexical, semantic, injection, obsidian }
  for (const component of Object.values(components)) if (component.issue && !issues.includes(component.issue)) issues.push(component.issue)
  return { version, at: Date.now(), status: unavailable ? 'unavailable' : issues.length ? 'attention' : 'ok',
    isolation: isolation === 'profile' ? 'profile' : isolation === 'explicit' ? 'explicit' : 'unavailable', counts, issues, components }
}
