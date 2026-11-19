import { randomBytes, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { accessSync, chmodSync, lstatSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { atomicWritePrivate, withFileLock } from './persistence.js'

const ENTRY = fileURLToPath(new URL('../local-server.js', import.meta.url))
const stateFile = root => join(root, '.local-sharing', 'service.json')
const lockFile = root => join(root, '.local-sharing', 'service.lock')

function ensureDirectory(root) {
  const directory = join(root, '.local-sharing')
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  chmodSync(directory, 0o700)
  return directory
}

export function readLocalSharingState(root) {
  const file = stateFile(resolve(root))
  try {
    const stat = lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16_384) return null
    const value = JSON.parse(readFileSync(file, 'utf8'))
    if (value.version !== 1 || typeof value.instanceId !== 'string' || typeof value.profileIdentity !== 'string' ||
        typeof value.token !== 'string' || value.token.length < 32 ||
        value.pid !== null && (!Number.isSafeInteger(value.pid) || value.pid < 1) ||
        value.port !== null && (!Number.isSafeInteger(value.port) || value.port < 1 || value.port > 65535)) return null
    return value
  } catch { return null }
}

function writeState(root, state) {
  ensureDirectory(root)
  atomicWritePrivate(stateFile(root), `${JSON.stringify(state)}\n`)
}

export function writeLocalSharingReady(root, instanceId, port, pid = process.pid) {
  return withFileLock(lockFile(root), () => {
    const current = readLocalSharingState(root)
    if (!current || current.instanceId !== instanceId) return false
    writeState(root, { ...current, pid, port, status: 'running' })
    return true
  })
}

export function clearLocalSharingState(root, instanceId) {
  return withFileLock(lockFile(root), () => {
    const current = readLocalSharingState(root)
    if (!current || current.instanceId !== instanceId) return false
    try { unlinkSync(stateFile(resolve(root))); return true }
    catch (error) { if (error?.code === 'ENOENT') return false; throw error }
  })
}

function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false
  try { process.kill(pid, 0); return true }
  catch (error) { return error?.code === 'EPERM' }
}

function isExecutable(path) {
  try { accessSync(path, constants.X_OK); return true } catch { return false }
}

function isSupportedNode(path) {
  if (!isExecutable(path) || !/^node(?:\.exe)?$/iu.test(basename(path))) return false
  const result = spawnSync(path, ['--version'], { encoding: 'utf8', timeout: 3000, windowsHide: true })
  const version = /^v(\d+)\.(\d+)\.(\d+)/u.exec(result.stdout?.trim() ?? '')
  return result.status === 0 && version !== null &&
    (Number(version[1]) > 22 || Number(version[1]) === 22 && Number(version[2]) >= 19)
}

export function standaloneNodeExecutable(current = process.execPath) {
  const normalized = resolve(current)
  const wrapperSuffix = `${process.platform === 'win32' ? '\\' : '/'}runtime${process.platform === 'win32' ? '\\' : '/'}bin${process.platform === 'win32' ? '\\' : '/'}node`
  const candidates = []
  if (typeof process.env.DSH_DESKTOP_NODE_EXECUTABLE === 'string') candidates.push(process.env.DSH_DESKTOP_NODE_EXECUTABLE)
  const executableName = process.platform === 'win32' ? 'node.exe' : 'node'
  for (let directory = dirname(normalized), depth = 0; depth < 10; depth += 1) {
    candidates.push(join(directory, 'Resources', 'runtime', 'primary-runtime', 'dependencies', 'node', 'bin', executableName))
    candidates.push(join(directory, 'resources', 'runtime', 'primary-runtime', 'dependencies', 'node', 'bin', executableName))
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  if (normalized.toLowerCase().endsWith(wrapperSuffix.toLowerCase())) {
    candidates.push(resolve(dirname(normalized), '..', 'primary-runtime', 'dependencies', 'node', 'bin', executableName))
  }
  if (/^node(?:\.exe)?$/iu.test(basename(normalized))) candidates.push(normalized)
  const result = [...new Set(candidates.map(path => resolve(path)))].find(isSupportedNode)
  if (!result) throw new Error('A standalone Node >=22.19 executable was not found. Set DSH_DESKTOP_NODE_EXECUTABLE to the installed primary-runtime Node binary.')
  return resolve(result)
}

async function wait(milliseconds) { await new Promise(resolvePromise => setTimeout(resolvePromise, milliseconds)) }

async function isReady(state) {
  if (!state || !Number.isSafeInteger(state.port)) return false
  try {
    const response = await fetch(`http://127.0.0.1:${state.port}/healthz`, { signal: AbortSignal.timeout(1000) })
    const value = await response.json()
    return response.ok && value.instanceId === state.instanceId
  } catch { return false }
}

export async function statusLocalSharing(root) {
  const dataRoot = resolve(root)
  const state = readLocalSharingState(dataRoot)
  if (!state) return { running: false }
  if (!alive(state.pid)) {
    clearLocalSharingState(dataRoot, state.instanceId)
    return { running: false }
  }
  const running = await isReady(state)
  if (!running && Date.now() - state.startedAt > 30_000) {
    clearLocalSharingState(dataRoot, state.instanceId)
    return { running: false }
  }
  return { running, ...(running ? { port: state.port, instanceId: state.instanceId } : { starting: true }) }
}

export async function startLocalSharing({ root, profileIdentity }) {
  const dataRoot = resolve(root)
  ensureDirectory(dataRoot)
  const locked = withFileLock(lockFile(dataRoot), () => {
    const current = readLocalSharingState(dataRoot)
    if (current && alive(current.pid) && current.profileIdentity !== profileIdentity) {
      throw new Error('a local sharing service is already bound to a different profile identity')
    }
    if (current && alive(current.pid)) return { state: current, alreadyRunning: true }
    const instanceId = randomUUID()
    const state = { version: 1, instanceId, profileIdentity, pid: null, port: null,
      token: randomBytes(32).toString('base64url'), startedAt: Date.now(), status: 'starting' }
    writeState(dataRoot, state)
    let child
    try {
      child = spawn(standaloneNodeExecutable(), [ENTRY, 'serve', '--root', dataRoot, '--profile', profileIdentity, '--instance', instanceId], {
        detached: true, stdio: 'ignore', env: process.env,
      })
      if (!Number.isSafeInteger(child.pid) || child.pid < 1) throw new Error('local sharing service process did not start')
      child.unref()
      const next = { ...state, pid: child.pid }
      writeState(dataRoot, next)
      return { state: next, alreadyRunning: false }
    } catch (error) {
      try { unlinkSync(stateFile(dataRoot)) } catch {}
      throw error
    }
  })

  for (let attempt = 0; attempt < 200; attempt += 1) {
    const current = readLocalSharingState(dataRoot)
    if (current?.instanceId === locked.state.instanceId && current.port && await isReady(current)) {
      return { url: `http://127.0.0.1:${current.port}/#token=${current.token}`, port: current.port,
        instanceId: current.instanceId, alreadyRunning: locked.alreadyRunning }
    }
    if (current?.instanceId === locked.state.instanceId && !alive(current.pid)) break
    await wait(100)
  }
  clearLocalSharingState(dataRoot, locked.state.instanceId)
  throw new Error('local sharing service did not become ready; run local-server.js status for details')
}

export async function stopLocalSharing(root) {
  const dataRoot = resolve(root)
  const state = readLocalSharingState(dataRoot)
  if (!state) return { stopped: false }
  if (!alive(state.pid)) {
    clearLocalSharingState(dataRoot, state.instanceId)
    return { stopped: false }
  }
  if (!(await isReady(state))) return { stopped: false, reason: 'instance-unverified' }
  try {
    const response = await fetch(`http://127.0.0.1:${state.port}/__admin/stop`, { method: 'POST',
      headers: { authorization: `Bearer ${state.token}` }, signal: AbortSignal.timeout(2000) })
    const value = await response.json()
    if (!response.ok || value.stopped !== true || value.instanceId !== state.instanceId) {
      return { stopped: false, reason: 'stop-unconfirmed' }
    }
  } catch {
    return { stopped: false, reason: 'stop-unconfirmed' }
  }
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (!alive(state.pid)) return { stopped: true }
    await wait(100)
  }
  return { stopped: false, reason: 'shutdown-pending' }
}
