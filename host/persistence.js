/** Small local persistence primitives shared by settings, authority and backups. */
import { randomUUID } from 'node:crypto'
import { closeSync, ftruncateSync, fsync, fsyncSync, fstatSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'

export function writeAll(fd, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8')
  for (let offset = 0; offset < bytes.length;) {
    const size = writeSync(fd, bytes, offset, bytes.length - offset)
    if (!Number.isInteger(size) || size <= 0 || size > bytes.length - offset) throw new Error('file write made no progress')
    offset += size
  }
}

/** Roll back a partial append through a random-access handle, never an append-only fd. */
export function truncateFile(file, size) {
  const fd = openSync(file, 'r+')
  try { ftruncateSync(fd, size); fsyncSync(fd) }
  finally { closeSync(fd) }
}

const unsupportedDirectorySync = error => ['EINVAL', 'ENOTSUP', 'EBADF'].includes(error?.code) ||
  (process.platform === 'win32' && error?.code === 'EPERM')

function openDirectoryForSync(dir) {
  try { return openSync(dir, 'r') }
  catch (error) {
    if (unsupportedDirectorySync(error) || (process.platform === 'win32' && error?.code === 'EISDIR')) return undefined
    throw error
  }
}

export function syncDirectory(dir) {
  const fd = openDirectoryForSync(dir)
  if (fd === undefined) return
  try { fsyncSync(fd) }
  catch (error) { if (!unsupportedDirectorySync(error)) throw error }
  finally { closeSync(fd) }
}

export const flushFile = fd => new Promise((resolve, reject) => fsync(fd, error => error ? reject(error) : resolve()))

export async function syncDirectoryAsync(dir) {
  const fd = openDirectoryForSync(dir)
  if (fd === undefined) return
  try { await flushFile(fd) }
  catch (error) { if (!unsupportedDirectorySync(error)) throw error }
  finally { closeSync(fd) }
}

const temporaryName = file => `${file}.${process.pid}.${randomUUID()}.tmp`

function clearTemporaryFile(file, fd) {
  if (fd !== undefined) closeSync(fd)
  try { unlinkSync(file) } catch (error) { if (error?.code !== 'ENOENT') throw error }
}

export function atomicWritePrivate(file, value) {
  const temporary = temporaryName(file)
  let fd
  try {
    fd = openSync(temporary, 'wx', 0o600)
    writeAll(fd, value)
    fsyncSync(fd)
    closeSync(fd); fd = undefined
    renameSync(temporary, file)
    syncDirectory(dirname(file))
  } finally {
    clearTemporaryFile(temporary, fd)
  }
}

/** Private replace with the same durability order as atomicWritePrivate. */
export async function atomicWritePrivateAsync(file, value) {
  const temporary = temporaryName(file)
  let fd
  try {
    fd = openSync(temporary, 'wx', 0o600)
    writeAll(fd, value)
    await flushFile(fd)
    closeSync(fd); fd = undefined
    renameSync(temporary, file)
    await syncDirectoryAsync(dirname(file))
  } finally {
    clearTemporaryFile(temporary, fd)
  }
}

const sameFile = (left, right) => left.dev === right.dev && left.ino === right.ino

/** Legacy numeric PID locks are accepted; age alone never evicts a live owner. */
export function acquireFileLock(file, waitMs = 3000) {
  const deadline = performance.now() + waitMs
  let fd, owned
  for (;;) {
    try {
      fd = openSync(file, 'wx', 0o600)
      owned = fstatSync(fd)
      writeAll(fd, `${process.pid}\n`)
      break
    } catch (error) {
      if (fd !== undefined) {
        closeSync(fd)
        try { if (sameFile(owned, statSync(file))) unlinkSync(file) } catch {}
        throw error
      }
      if (error?.code !== 'EEXIST') throw error
      try {
        const before = statSync(file), pid = Number(readFileSync(file, 'utf8').trim())
        let abandoned = false
        if (Number.isSafeInteger(pid) && pid > 0) {
          try { process.kill(pid, 0) } catch (probe) { abandoned = probe?.code === 'ESRCH' }
        } else abandoned = Date.now() - before.mtimeMs > 30_000
        if (abandoned && sameFile(before, statSync(file))) { unlinkSync(file); continue }
      } catch (inspection) { if (inspection?.code !== 'ENOENT') throw inspection }
      if (performance.now() >= deadline) throw Object.assign(new Error('memory store is locked by another process'), { code: 'memory-lock-in-use' })
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
    }
  }
  return () => {
    closeSync(fd)
    try { if (sameFile(owned, statSync(file))) unlinkSync(file) }
    catch (error) { if (error?.code !== 'ENOENT') throw error }
  }
}

export function withFileLock(file, callback) {
  const release = acquireFileLock(file)
  try { return callback() } finally { release() }
}
