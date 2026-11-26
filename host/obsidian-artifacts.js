/** Ownership checks and restartable removal of Obsidian synchronization copies. */
import { randomUUID } from 'node:crypto'
import { linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, unlinkSync } from 'node:fs'
import { dirname, join, win32 } from 'node:path'
import { parseFrontmatter } from './frontmatter.js'
import { isNoteDigest, noteDigest } from './obsidian-note.js'
import { atomicWritePrivate, syncDirectory, withFileLock } from './persistence.js'

const UUID = '[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}'
const DIGEST = '[a-f0-9]{64}'
const managedName = new RegExp(`^managed-(reading|memory|knowledge)-(${DIGEST})-${UUID}\\.md$`, 'u')
const oldHistory = new RegExp(`^\\d+-${UUID}-.+\\.md$`, 'u')
const conflictName = new RegExp(`^(${DIGEST})-(memory|obsidian)(?:-(${DIGEST}))?\\.md$`, 'u')
const oldPending = new RegExp(`^${UUID}-pending\\.md$`, 'u')
const stageFolder = '_dsh-memory-cleanup'
const lock = root => join(root, '.obsidian-cleanup.lock')
const prefix = dir => '.obsidian-cleanup-' + noteDigest(dir).slice(0, 20) + '-'

export function managedHistoryName(kind, hash) {
  return `managed-${kind}-${hash}-${randomUUID()}.md`
}

export function conflictCopyName(token, side, text) {
  return `${token}-${side}-${noteDigest(text)}.md`
}

function missing(error) { return error?.code === 'ENOENT' }

function info(path) {
  try { return lstatSync(path) }
  catch (error) { if (!missing(error)) throw error; return null }
}

function safeParts(relative) {
  if (typeof relative !== 'string' || win32.isAbsolute(relative)) return null
  const parts = relative.split('/')
  return parts.every(part => part && part !== '.' && part !== '..' && !/[\\:\x00]/u.test(part)) ? parts : null
}

function plainTarget(dir, relative) {
  const parts = safeParts(relative)
  if (!parts || !info(dir)?.isDirectory()) return null
  let path = dir
  for (const part of parts.slice(0, -1)) {
    path = join(path, part)
    if (!info(path)?.isDirectory()) return null
  }
  return join(path, parts.at(-1))
}

function list(dir, relative, kind) {
  const path = plainTarget(dir, relative)
  if (!path || !info(path)?.isDirectory()) return []
  return readdirSync(path, { withFileTypes: true }).filter(item => kind === 'dir' ? item.isDirectory() : item.isFile())
    .map(item => item.name)
}

function bytesAt(file) {
  if (!file || !info(file)?.isFile()) return null
  try { return readFileSync(file) }
  catch (error) { if (!missing(error)) throw error; return null }
}

function linkedId(bytes, kind, purged) {
  try {
    const note = parseFrontmatter(bytes.toString('utf8'))?.data
    if ((!kind || kind === 'memory') && note?.dsh_memory === true && purged.has(note.id)) return 'memory:' + note.id
    if ((!kind || kind === 'knowledge') && note?.dsh_knowledge === true && purged.has(note.memoryId)) return 'knowledge:' + note.memoryId
  } catch { /* A historical file may be handwritten or invalid. */ }
  return null
}

export function findManagedCopies(dir, purged, digests) {
  const copies = new Map()
  // Canonical bytes include the scope. They can prove a copy even if another
  // project still has a live record with the same legacy ID.
  const canonical = new Set([...digests.values()].flatMap(hashes => [...hashes]))
  const matchAt = relative => bytesAt(plainTarget(dir, relative))
  for (const name of list(dir, '_history', 'file')) {
    const managed = managedName.exec(name)
    if (!managed && (!canonical.size || !oldHistory.test(name))) continue
    const file = '_history/' + name
    const bytes = matchAt(file)
    if (!bytes) continue
    const hash = noteDigest(bytes)
    if (canonical.has(hash) || managed && managed[2] === hash &&
        (managed[1] === 'reading' || linkedId(bytes, managed[1], purged))) copies.set(file, hash)
  }
  if (purged.size === 0 && canonical.size === 0) return copies

  for (const name of list(dir, '_conflicts', 'file')) {
    if (!oldPending.test(name)) continue
    const file = '_conflicts/' + name
    const bytes = matchAt(file)
    if (bytes && canonical.has(noteDigest(bytes))) copies.set(file, noteDigest(bytes))
  }
  for (const group of list(dir, '_conflicts', 'dir')) {
    if (!/^[a-f0-9]{16}$/u.test(group)) continue
    const entries = new Map()
    for (const name of list(dir, '_conflicts/' + group, 'file')) {
      const match = conflictName.exec(name)
      if (!match) continue
      const file = '_conflicts/' + group + '/' + name
      const bytes = matchAt(file)
      if (!bytes) continue
      const hash = noteDigest(bytes)
      const owner = linkedId(bytes, null, purged)
      if (canonical.has(hash)) copies.set(file, hash)
      if (match[3]) {
        if (owner?.startsWith('knowledge:') && hash === match[3] ||
            owner?.startsWith('memory:') && noteDigest(owner).slice(0, 16) === group && hash === match[3]) copies.set(file, hash)
      } else {
        const pair = entries.get(match[1]) ?? {}
        pair[match[2]] = { file, bytes, hash, owner }
        entries.set(match[1], pair)
      }
    }
    // Older copies recorded a joint checksum. Prove both before removing either.
    for (const [token, pair] of entries) {
      const text = side => pair[side]?.bytes.toString('utf8') ?? null
      if (noteDigest(JSON.stringify([text('memory'), text('obsidian')])) !== token) continue
      for (const item of Object.values(pair)) {
        if (item.owner?.startsWith('knowledge:') ||
            item.owner?.startsWith('memory:') && noteDigest(item.owner).slice(0, 16) === group) copies.set(item.file, item.hash)
      }
    }
  }
  return copies
}

function mkdirPlain(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 })
  if (!info(path)?.isDirectory()) throw new Error('Obsidian 清理目录必须是普通目录。')
}

function readPlan(file) {
  if (!info(file)?.isFile()) throw new Error('Obsidian 清理记录必须是普通文件。')
  const plan = JSON.parse(readFileSync(file, 'utf8'))
  if (plan?.version !== 1 || !Array.isArray(plan.files) || !plan.files.length ||
      plan.files.some(row => !safeParts(row?.file) || row.file.startsWith(stageFolder + '/') || !isNoteDigest(row.hash))) {
    throw new Error('Obsidian 清理记录无效。')
  }
  return plan.files
}

function finishPlan(dir, file, id, report) {
  const plan = readPlan(file)
  const stagingParent = join(dir, stageFolder)
  mkdirPlain(stagingParent)
  const staging = join(stagingParent, id)
  mkdirPlain(staging)
  let complete = true
  for (const [index, row] of plan.entries()) {
    const target = plainTarget(dir, row.file)
    const saved = join(staging, String(index) + '.md')
    try {
      if (!info(saved)) {
        const bytes = bytesAt(target)
        if (!bytes || noteDigest(bytes) !== row.hash) continue
        renameSync(target, saved)
        syncDirectory(dirname(target))
        syncDirectory(staging)
      }
      const bytes = bytesAt(saved)
      if (bytes && noteDigest(bytes) === row.hash) {
        unlinkSync(saved)
        syncDirectory(staging)
        report.purgedCopies = (report.purgedCopies ?? 0) + 1
      } else {
        // A writer may have edited the file just before it was moved. Restore
        // those bytes without overwriting a new file at the original path.
        if (!bytes || !target) throw new Error('文件已变化，副本已留待检查。')
        if (info(target)) {
          const original = bytesAt(target)
          if (!original || !original.equals(bytes)) throw new Error('原位置和保留副本不同，两个版本均已保留。')
        } else {
          linkSync(saved, target)
          syncDirectory(dirname(target))
        }
        unlinkSync(saved)
        syncDirectory(staging)
      }
    } catch (error) {
      if (missing(error) && !info(saved)) continue
      complete = false
      report.errors.push({ file: row.file, message: error.message })
    }
  }
  if (!complete) return
  rmdirSync(staging)
  unlinkSync(file)
  syncDirectory(dirname(file))
  try { rmdirSync(stagingParent) }
  catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error?.code)) throw error }
}

export function recoverManagedCleanup(root, dir, report) {
  const names = readdirSync(root).filter(name => name.startsWith(prefix(dir)) && name.endsWith('.json'))
  if (names.length === 0) return
  withFileLock(lock(root), () => {
    for (const name of names) {
      const file = join(root, name), id = name.slice(prefix(dir).length, -5)
      if (!new RegExp('^' + UUID + '$', 'u').test(id) || !info(file)) continue
      finishPlan(dir, file, id, report)
    }
  })
}

export function removeManagedCopies(root, dir, copies, report) {
  if (copies.size === 0) return
  withFileLock(lock(root), () => {
    const id = randomUUID()
    const file = join(root, prefix(dir) + id + '.json')
    const files = [...copies].map(([file, hash]) => ({ file, hash }))
    atomicWritePrivate(file, JSON.stringify({ version: 1, files }) + '\n')
    finishPlan(dir, file, id, report)
  })
}
