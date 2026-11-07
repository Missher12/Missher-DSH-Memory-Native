/** Complete local snapshots. Recovery never overwrites an existing data root. */
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, rmdirSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { setImmediate as yieldToHost } from 'node:timers/promises'
import { atomicWritePrivate, syncDirectory, writeAll } from './persistence.js'

const FORMAT = 'dsh-memory-backup'
const DIRECTORIES = new Set(['global', 'projects', 'capture', 'knowledge', 'recall'])
const FILES = new Set(['meta.json', 'settings.json', 'usage.jsonl', 'obsidian-sync.json', 'corrupt-lines.jsonl', 'data-owner.json'])
const MAX_FILES = 200_000, MAX_MANIFEST_BYTES = 32 * 1024 * 1024
const stamp = s => [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].join(':')
const allowedFile = name => FILES.has(name) || /^obsidian-state-[a-f0-9]+\.json$/u.test(name) || /^settings\.invalid-[a-f0-9-]+\.json$/u.test(name)

function safePath(path) {
  if (typeof path !== 'string' || isAbsolute(path) || path.includes('\\')) return false
  const parts = path.split('/')
  return parts.every(p => p !== '' && p !== '.' && p !== '..' && !p.includes('\0')) &&
    (parts.length === 1 ? allowedFile(path) : DIRECTORIES.has(parts[0]))
}

function plainPath(root, relative) {
  let path = root
  for (const part of relative.split('/')) {
    path = join(path, part)
    if (lstatSync(path).isSymbolicLink()) throw new Error('备份不能包含符号链接。')
  }
  return path
}

async function inventory(root) {
  const result = []
  let scanned = 0
  const visit = async (dir, prefix) => {
    for (const name of readdirSync(dir).sort()) {
      if (name.endsWith('.tmp') || name.endsWith('.lock')) continue
      const path = join(dir, name), relative = prefix ? `${prefix}/${name}` : name
      if (!prefix && !DIRECTORIES.has(name) && !allowedFile(name)) continue
      const stat = lstatSync(path, { bigint: true })
      if (stat.isSymbolicLink()) throw new Error('备份不能包含符号链接。')
      if (stat.isDirectory()) await visit(path, relative)
      else if (stat.isFile() && safePath(relative)) result.push({ path: relative, stamp: stamp(stat) })
      else throw new Error('备份来源包含不支持的文件类型。')
      if (++scanned % 64 === 0) await yieldToHost()
    }
  }
  await visit(root, '')
  return result
}

/** Bounded-memory copy/hash with complete writes and same-file mutation checks. */
async function copyAndHash(source, destination) {
  const input = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW)
  let output
  try {
    const before = fstatSync(input, { bigint: true })
    if (!before.isFile()) throw new Error('备份只支持普通文件。')
    if (destination) {
      mkdirSync(dirname(destination), { recursive: true, mode: 0o700 })
      output = openSync(destination, 'wx', 0o600)
    }
    const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(256 * 1024)
    let bytes = 0, count, sinceYield = 0
    while ((count = readSync(input, buffer, 0, buffer.length)) > 0) {
      const chunk = buffer.subarray(0, count)
      hash.update(chunk)
      if (output !== undefined) writeAll(output, chunk)
      bytes += count
      sinceYield += count
      if (sinceYield >= 1024 * 1024) { await yieldToHost(); sinceYield = 0 }
    }
    if (stamp(before) !== stamp(fstatSync(input, { bigint: true })) || BigInt(bytes) !== before.size) {
      throw new Error('备份来源正在变化，请等待当前处理完成后重试。')
    }
    if (output !== undefined) fsyncSync(output)
    return { bytes, sha256: hash.digest('hex') }
  } finally { closeSync(input); if (output !== undefined) closeSync(output) }
}

async function syncTreeDirectories(root) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory()) { await syncTreeDirectories(join(root, entry.name)); await yieldToHost() }
  }
  syncDirectory(root)
}

export async function createCompleteBackup(root, now = Date.now()) {
  const backups = join(root, 'backups')
  mkdirSync(backups, { recursive: true, mode: 0o700 })
  if (lstatSync(backups).isSymbolicLink()) throw new Error('备份目录不能是符号链接。')
  const name = `memories-${new Date(now).toISOString().replace(/[:.]/gu, '-')}-${randomUUID()}.backup`
  const staged = join(backups, `.${name}.tmp`), target = join(backups, name)
  mkdirSync(staged, { mode: 0o700 })
  try {
    const before = await inventory(root), files = []
    if (before.length > MAX_FILES) throw new Error('备份文件数超过当前恢复工具支持的上限，未生成不完整备份。')
    for (const file of before) {
      files.push({ path: file.path, ...await copyAndHash(plainPath(root, file.path), join(staged, 'files', file.path)) })
      if (files.length % 16 === 0) await yieldToHost()
    }
    if (JSON.stringify(before) !== JSON.stringify(await inventory(root))) throw new Error('备份来源正在变化，请稍后重试。')
    const manifest = JSON.stringify({ format: FORMAT, version: 1, createdAt: now, files }, null, 2) + '\n'
    if (Buffer.byteLength(manifest) > MAX_MANIFEST_BYTES) throw new Error('备份清单超过当前恢复工具支持的大小。')
    await syncTreeDirectories(staged)
    // Recheck after yielded flushes; no partially changing snapshot is published.
    if (JSON.stringify(before) !== JSON.stringify(await inventory(root))) throw new Error('备份来源正在变化，请稍后重试。')
    atomicWritePrivate(join(staged, 'manifest.json'), manifest)
    renameSync(staged, target)
    syncDirectory(backups)
    return target
  } catch (error) { rmSync(staged, { recursive: true, force: true }); throw error }
}

export async function verifyBackup(backup) {
  if (!lstatSync(backup).isDirectory() || lstatSync(backup).isSymbolicLink()) throw new Error('请选择完整备份目录。')
  const manifestPath = plainPath(backup, 'manifest.json')
  if (lstatSync(manifestPath).size > MAX_MANIFEST_BYTES) throw new Error('备份清单超过支持的大小。')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (manifest?.format !== FORMAT || manifest.version !== 1 || !Number.isFinite(manifest.createdAt) || manifest.createdAt < 0 || !Array.isArray(manifest.files) || manifest.files.length > MAX_FILES) {
    throw new Error('不支持的备份格式或版本。')
  }
  const names = new Set()
  for (const file of manifest.files) {
    if (!safePath(file?.path) || names.has(file.path) || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || !/^[a-f0-9]{64}$/u.test(file.sha256)) {
      throw new Error('备份清单校验失败。')
    }
    names.add(file.path)
    const actual = await copyAndHash(plainPath(backup, `files/${file.path}`))
    if (actual.bytes !== file.bytes || actual.sha256 !== file.sha256) throw new Error('备份文件校验失败，未恢复任何数据。')
    if (names.size % 16 === 0) await yieldToHost()
  }
  return manifest
}

export async function restoreBackup(backup, target) {
  const destination = resolve(target)
  if (existsSync(destination)) throw new Error('恢复目标已存在；请选择新的空目录路径。')
  const manifest = await verifyBackup(backup), parent = dirname(destination)
  const stage = join(parent, `.memory-restore-${randomUUID()}.tmp`)
  mkdirSync(stage, { mode: 0o700 })
  let reserved = false
  try {
    for (const file of manifest.files) {
      const copied = await copyAndHash(plainPath(backup, `files/${file.path}`), join(stage, file.path))
      if (copied.bytes !== file.bytes || copied.sha256 !== file.sha256) throw new Error('恢复期间备份校验发生变化，未应用。')
    }
    await syncTreeDirectories(stage)
    // Reserve a previously absent path; rename can only replace our empty dir.
    mkdirSync(destination, { mode: 0o700 }); reserved = true
    renameSync(stage, destination); reserved = false
    syncDirectory(parent)
    return { files: manifest.files.length, bytes: manifest.files.reduce((n, f) => n + f.bytes, 0) }
  } catch (error) {
    rmSync(stage, { recursive: true, force: true })
    if (reserved) { try { rmdirSync(destination) } catch {} }
    throw error
  }
}
