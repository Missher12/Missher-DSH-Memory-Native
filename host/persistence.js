/** Small local persistence primitives shared by settings, authority and backups. */
import { randomUUID } from 'node:crypto'
import { closeSync, ftruncateSync, fsyncSync, fstatSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs'
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

export function syncDirectory(dir) {
  let fd
  try { fd = openSync(dir, 'r') }
  catch (error) {
    const knownUnsupported = ['EINVAL', 'ENOTSUP', 'EBADF'].includes(error?.code)
    const windowsDirectoryOpen = process.platform === 'win32' && ['EPERM', 'EISDIR'].includes(error?.code)
    if (knownUnsupported || windowsDirectoryOpen) return
    throw error
  }
  try { fsyncSync(fd) }
  catch (error) {
    const knownUnsupported = ['EINVAL', 'ENOTSUP', 'EBADF'].includes(error?.code)
    if (!knownUnsupported && !(process.platform === 'win32' && error?.code === 'EPERM')) throw error
  }
  finally { closeSync(fd) }
}

export function atomicWritePrivate(file, value) {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
  let fd
  try {
    fd = openSync(temporary, 'wx', 0o600)
    writeAll(fd, value)
    fsyncSync(fd)
    closeSync(fd); fd = undefined
    renameSync(temporary, file)
    syncDirectory(dirname(file))
  } finally {
    if (fd !== undefined) closeSync(fd)
    try { unlinkSync(temporary) } catch (error) { if (error?.code !== 'ENOENT') throw error }
  }
}

const sameFile = (left, right) => left.dev === right.dev && left.ino === right.ino

/** Legacy numeric PID locks are accepted; age alone never evicts a live owner. */
export function withFileLock(file, callback) {
  const deadline = performance.now() + 3000
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
      if (performance.now() >= deadline) throw new Error('memory store is locked by another process')
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
    }
  }
  try { return callback() }
  finally {
    closeSync(fd)
    try { if (sameFile(owned, statSync(file))) unlinkSync(file) }
    catch (error) { if (error?.code !== 'ENOENT') throw error }
  }
}
