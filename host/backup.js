/** Complete local snapshots. Recovery never overwrites an existing data root. */
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, rmdirSync, unlinkSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { setImmediate as yieldToHost, setTimeout as delay } from 'node:timers/promises'
import { acquireFileLock, atomicWritePrivateAsync, flushFile, syncDirectory, syncDirectoryAsync, writeAll } from './persistence.js'
import { CAPTURE_DIR, noSaveSourceIds, readCaptureTaskJournal, readTurnIntakes, TASKS_FILE, TURNS_FILE } from './capture-journal.js'
import { readAuthorityIntent } from './authority-intent.js'
import { readKnowledgeBinding } from './knowledge.js'
import { knowledgeAuthority } from './knowledge-authority.js'
import { MAX_RECALL_SELECTION_BYTES, recallSelectionFileId, sanitizeRecallSelectionBytes } from './recall-journal.js'
import { MemoryStore, PURGED_IDS_FILE } from './store.js'
import { PURGED_NOTE_DIGESTS } from './obsidian-note.js'
import { readRevocationLedger, REVOCATION_FILE, validSourceId } from './revocation-ledger.js'
import { isValidProjectKey } from './paths.js'
import { USAGE_FILE } from './usage-log.js'

const FORMAT = 'dsh-memory-backup'
const DIRECTORIES = new Set(['global', 'projects', 'capture', 'knowledge', 'recall'])
const FILES = new Set(['meta.json', 'settings.json', USAGE_FILE, 'obsidian-sync.json', 'obsidian-purged-ids.json',
  PURGED_NOTE_DIGESTS, REVOCATION_FILE, 'corrupt-lines.jsonl', 'data-owner.json'])
const LEGACY_MAX_FILES = 200_000, MAX_MANIFEST_BYTES = 32 * 1024 * 1024
const PART_SIZE = 128
const PACKED_FILE_BYTES = 64 * 1024
const PARTS = 'manifest-parts'
const PAYLOADS = 'payloads'
const partialBackup = '.dsh-memory-snapshot.tmp'
const backupStage = format => format === 'fast' ? '.dsh-memory-snapshot-fast.tmp' : partialBackup
const RESTORE_CHECKPOINT = 'dsh-memory-restore'
const RESTORE_RECEIPT = 'restore.json'
const RESTORE_TEMPORARY = 'file.prepare.tmp'
const partFile = index => String(index).padStart(8, '0') + '.json'
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const validHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
const sourceChanged = () => Object.assign(new Error('备份来源正在变化，请稍后重试。'), { code: 'backup-source-changed' })
const stamp = s => [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].join(':')
const allowedFile = name => FILES.has(name) || /^obsidian-(?:state|exports)-[a-f0-9]+\.json$/u.test(name) || /^settings\.invalid-[a-f0-9-]+\.json$/u.test(name)
const sourceFile = /^capture\/(?:sources|recall-grants\/[^/]+)\/(src_[a-f0-9]{24})\.json(?:\.gz)?$/u
const captureJournals = [`${CAPTURE_DIR}/${TASKS_FILE}`, `${CAPTURE_DIR}/${TURNS_FILE}`]
const snapshotMetadata = ['meta.json', USAGE_FILE]
const grantDirectory = `${CAPTURE_DIR}/recall-grants`

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

function dirAt(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 })
  if (!lstatSync(path).isDirectory()) throw new Error('备份目录必须是普通目录，不能是符号链接。')
}

function validBackupFile(file) {
  return safePath(file?.path) && Number.isSafeInteger(file.bytes) && file.bytes >= 0 && validHash(file.sha256)
}

const knowledgeMarkdown = path => path.startsWith('knowledge/') && /\.md$/iu.test(path)
const authorityPath = path => path === 'global/memories.jsonl' ||
  isValidProjectKey(/^projects\/([^/]+)\/memories\.jsonl$/u.exec(path)?.[1]) || captureJournals.includes(path)

function optionalStat(root, relative) {
  try { return lstatSync(plainPath(root, relative), { bigint: true }) }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error }
}

function pathsState(root, paths) {
  return paths.map(relative => {
    const info = optionalStat(root, relative)
    return [relative, info && stamp(info)]
  })
}

const revocationState = root => JSON.stringify(pathsState(root, [PURGED_IDS_FILE, PURGED_NOTE_DIGESTS, REVOCATION_FILE]))

function captureState(root) {
  const projects = optionalStat(root, grantDirectory)?.isDirectory()
    ? readdirSync(plainPath(root, grantDirectory), { withFileTypes: true }).filter(entry => entry.isDirectory())
      .map(entry => `${grantDirectory}/${entry.name}`).sort() : []
  return JSON.stringify(pathsState(root, [...captureJournals, `${CAPTURE_DIR}/sources`, grantDirectory, ...projects, 'recall/selection']))
}

// Snapshot preparation and publication need the authority lock only for
// metadata, never while copying or hashing the bulk data.
async function withBackupAuthority(root, callback) {
  const deadline = performance.now() + 3000
  for (;;) {
    let release
    try { release = acquireFileLock(join(root, '.write.lock'), 0) }
    catch (error) {
      if (error?.code !== 'memory-lock-in-use') throw error
      if (performance.now() >= deadline) throw sourceChanged()
      await delay(10)
      continue
    }
    try { return callback() } finally { release() }
  }
}

function authoritySnapshot(root, store) {
  if (readAuthorityIntent(root)) throw sourceChanged()
  const files = []
  const paths = ['global/memories.jsonl', ...store.listProjects().map(key => `projects/${key}/memories.jsonl`), ...captureJournals]
  for (const path of paths) {
    const info = optionalStat(root, path)
    if (!info) continue
    if (!info.isFile() || info.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('记忆日志无法安全备份。')
    const signature = stamp(info)
    files.push({ path, stamp: signature, prefix: { dev: info.dev, ino: info.ino, size: Number(info.size), stamp: signature } })
  }
  // Usage compaction can replace bytes in place. Freeze its small contents
  // rather than treating the file as an append-only journal.
  for (const path of snapshotMetadata) {
    const info = optionalStat(root, path)
    if (!info) continue
    if (!info.isFile()) throw new Error('备份元数据必须是普通文件。')
    const contents = readFileSync(plainPath(root, path), { flag: constants.O_RDONLY | constants.O_NOFOLLOW })
    if (BigInt(contents.length) !== info.size || stamp(info) !== stamp(optionalStat(root, path) ?? {})) throw sourceChanged()
    files.push({ path, stamp: stamp(info), contents })
  }
  return { files, revocations: revocationState(root) }
}

function hasCommittedPrefix(info, prefix) {
  const size = BigInt(prefix.size)
  return info?.isFile() && info.dev === prefix.dev && info.ino === prefix.ino &&
    (info.size > size || (info.size === size && stamp(info) === prefix.stamp))
}

async function inventory(root, store, noteBindings) {
  if (readAuthorityIntent(root)) throw new Error('有记忆写入待恢复，请在恢复后重试备份。')
  const result = []
  const turns = readTurnIntakes(root, { strict: true })
  if (turns.corrupt) throw new Error('原文禁存记录有未确认的条目，暂不能安全备份。')
  const denied = noSaveSourceIds(turns.intakes)
  for (const id of readRevocationLedger(root).deniedSources) denied.add(id)
  const allowed = knowledgeAuthority(store)
  let scanned = 0
  const visit = async (dir, prefix) => {
    for (const name of readdirSync(dir).sort()) {
      if (name.endsWith('.tmp') || name.endsWith('.lock')) continue
      const path = join(dir, name), relative = prefix ? `${prefix}/${name}` : name
      if (isDeniedSourceFile(relative, denied)) continue
      if (!prefix && !DIRECTORIES.has(name) && !allowedFile(name)) continue
      const stat = lstatSync(path, { bigint: true })
      if (stat.isSymbolicLink()) throw new Error('备份不能包含符号链接。')
      if (stat.isDirectory()) await visit(path, relative)
      else if (stat.isFile() && safePath(relative)) {
        const signature = stamp(stat)
        if (snapshotMetadata.includes(relative) || authorityPath(relative)) continue
        const knowledge = knowledgeMarkdown(relative)
        const packable = (knowledge || sourceFile.test(relative)) && stat.size <= BigInt(PACKED_FILE_BYTES)
        const entry = { path: relative, stamp: signature, ...(packable ? { packable: true } : {}) }
        if (knowledge) {
          let cached = noteBindings.get(relative)
          if (cached?.stamp !== signature) {
            cached = { stamp: signature, binding: readKnowledgeBinding(path) }
            noteBindings.set(relative, cached)
          }
          if (allowed(cached.binding).allowed) result.push(entry)
        } else result.push(entry)
      }
      else throw new Error('备份来源包含不支持的文件类型。')
      if (++scanned % 64 === 0) await yieldToHost()
    }
  }
  await visit(root, '')
  if (readAuthorityIntent(root)) throw new Error('有记忆写入待恢复，请在恢复后重试备份。')
  return result
}

function onlyNewCaptureRows(saved, current, savedSources) {
  const old = new Map(saved.map(row => [row.id, JSON.stringify(row)]))
  for (const row of current) {
    if (old.has(row.id)) {
      if (old.get(row.id) !== JSON.stringify(row)) return false
      old.delete(row.id)
    } else if (!Array.isArray(row.sourceIds) || row.sourceIds.length === 0 ||
        row.sourceIds.some(id => !validSourceId(id) || savedSources.has(id))) return false
  }
  return old.size === 0
}

// Revisions of work already in the snapshot must stay exact. In particular
// a pending paid call from the cut must not be restored as unsent after it
// was requested while the archive was being written.
function checkCaptureAdvance(root, stagedFiles, savedSources) {
  const oldTurns = readTurnIntakes(stagedFiles, { strict: true }), oldTasks = readCaptureTaskJournal(stagedFiles)
  const turns = readTurnIntakes(root, { strict: true }), tasks = readCaptureTaskJournal(root)
  if (oldTurns.corrupt || oldTasks.corrupt || turns.corrupt || tasks.corrupt) throw sourceChanged()
  for (const row of [...oldTurns.intakes, ...oldTasks.rows]) {
    if (Array.isArray(row.sourceIds)) for (const id of row.sourceIds) savedSources.add(id)
  }
  if (!onlyNewCaptureRows(oldTurns.intakes, turns.intakes, savedSources) ||
      !onlyNewCaptureRows(oldTasks.rows, tasks.rows, savedSources)) throw sourceChanged()
  const oldDenied = noSaveSourceIds(oldTurns.intakes), denied = noSaveSourceIds(turns.intakes)
  if (oldDenied.size !== denied.size || [...oldDenied].some(id => !denied.has(id))) throw sourceChanged()
}

async function checkBackupCut(root, stagedFiles, before, captureAtCut, scan) {
  const state = captureState(root), latest = await scan()
  const frozen = new Map(before.map(file => [file.path, file.stamp]))
  const savedSources = new Set(before.map(file => sourceFile.exec(file.path)?.[1]).filter(Boolean))
  if (state !== captureAtCut) checkCaptureAdvance(root, stagedFiles, savedSources)
  for (const file of latest) {
    if (frozen.has(file.path)) {
      if (frozen.get(file.path) !== file.stamp) throw sourceChanged()
      frozen.delete(file.path)
    } else {
      const id = sourceFile.exec(file.path)?.[1]
      if (!id || savedSources.has(id)) throw sourceChanged()
    }
  }
  if (frozen.size || state !== captureState(root)) throw sourceChanged()
  return state
}

function isDeniedSourceFile(path, denied) {
  const match = sourceFile.exec(path)
  return match !== null && denied.has(match[1])
}

/** Bounded-memory copy/hash with complete writes and same-file mutation checks. */
async function copyAndHash(source, destination, prefix) {
  const input = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW)
  let output
  try {
    const before = fstatSync(input, { bigint: true })
    if (!before.isFile()) throw new Error('备份只支持普通文件。')
    if (prefix && !hasCommittedPrefix(before, prefix)) throw sourceChanged()
    if (destination) {
      mkdirSync(dirname(destination), { recursive: true, mode: 0o700 })
      output = openSync(destination, 'wx', 0o600)
    }
    const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(256 * 1024)
    let bytes = 0, count, sinceYield = 0
    const limit = prefix?.size ?? Infinity
    while (bytes < limit && (count = readSync(input, buffer, 0, Math.min(buffer.length, limit - bytes))) > 0) {
      const chunk = buffer.subarray(0, count)
      hash.update(chunk)
      if (output !== undefined) writeAll(output, chunk)
      bytes += count
      sinceYield += count
      if (sinceYield >= 1024 * 1024) { await yieldToHost(); sinceYield = 0 }
    }
    const after = fstatSync(input, { bigint: true })
    if (prefix ? bytes !== prefix.size || !hasCommittedPrefix(after, prefix) :
      stamp(before) !== stamp(after) || BigInt(bytes) !== before.size) throw sourceChanged()
    if (output !== undefined) await flushFile(output)
    return { bytes, sha256: hash.digest('hex') }
  } finally { closeSync(input); if (output !== undefined) closeSync(output) }
}

async function syncTreeDirectories(root) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory()) { await syncTreeDirectories(join(root, entry.name)); await yieldToHost() }
  }
  await syncDirectoryAsync(root)
}

function readSmallFile(path, maxBytes, expectedStamp) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = fstatSync(fd, { bigint: true }), signature = stamp(before)
    if (!before.isFile() || before.size > BigInt(maxBytes) || (expectedStamp && signature !== expectedStamp)) {
      throw sourceChanged()
    }
    const bytes = Buffer.allocUnsafe(Number(before.size))
    let offset = 0
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset)
      if (count === 0) throw sourceChanged()
      offset += count
    }
    if (signature !== stamp(fstatSync(fd, { bigint: true }))) throw sourceChanged()
    return bytes
  } finally { closeSync(fd) }
}

async function cleanSelectionCopy(path, id, source) {
  const info = lstatSync(path, { bigint: true })
  const signature = stamp(info)
  if (!info.isFile() || (source.stamp && signature !== source.stamp)) throw sourceChanged()
  const original = info.size <= BigInt(MAX_RECALL_SELECTION_BYTES)
    ? readSmallFile(path, MAX_RECALL_SELECTION_BYTES, signature) : undefined
  if (source.sha256) {
    const actual = original ? { bytes: original.length, sha256: digest(original) } : await copyAndHash(path)
    if (actual.bytes !== source.bytes || actual.sha256 !== source.sha256) throw new Error('恢复期间备份校验发生变化，未应用。')
  }
  return sanitizeRecallSelectionBytes(original, id)
}

const validPackedFile = (row, allowKnowledge) => validBackupFile(row) &&
  (sourceFile.test(row.path) || allowKnowledge && knowledgeMarkdown(row.path)) && row.bytes <= PACKED_FILE_BYTES
const stampedPaths = rows => JSON.stringify(rows.map(({ path, stamp }) => [path, stamp]))

// Bind the physical name to each member, including its path and digest. A
// crash between the payload and its receipt cannot pair new bytes with an
// older receipt that happens to occupy the same part number.
function payload(rows) {
  const name = digest(JSON.stringify(rows.map(({ path, bytes, sha256 }) => [path, bytes, sha256]))) + '.bin'
  return { name, bytes: rows.reduce((size, row) => size + row.bytes, 0) }
}

function readPayload(directory, part) {
  let bytes
  try { bytes = readSmallFile(plainPath(directory, part.name), part.bytes) }
  catch (error) {
    if (error?.code === 'backup-source-changed') throw new Error('备份文件分段大小校验失败。', { cause: error })
    throw error
  }
  if (bytes.length !== part.bytes) throw new Error('备份文件分段大小校验失败。')
  return bytes
}

function checkPayload(directory, rows) {
  const part = payload(rows), bytes = readPayload(directory, part)
  let offset = 0
  for (const row of rows) {
    if (digest(bytes.subarray(offset, offset + row.bytes)) !== row.sha256) throw new Error('备份文件分段校验失败。')
    offset += row.bytes
  }
  return part
}

function resumeFiles(stage, allowKnowledge) {
  const parts = join(stage, PARTS), files = new Map(), packs = new Map()
  for (const name of readdirSync(parts).filter(name => /^\d{8}\.json$/u.test(name)).sort()) {
    try {
      const path = plainPath(parts, name)
      const info = lstatSync(path)
      if (!info.isFile() || info.size > MAX_MANIFEST_BYTES) continue
      const rows = JSON.parse(readFileSync(path, 'utf8'))
      if (!Array.isArray(rows) || rows.length > PART_SIZE) continue
      for (const row of rows) if (validBackupFile(row) && typeof row.stamp === 'string' && row.packed !== true) files.set(row.path, row)
      const packed = rows.filter(row => row?.packed === true)
      if (packed.length && packed.every(row => validPackedFile(row, allowKnowledge) && typeof row.stamp === 'string')) {
        packs.set(stampedPaths(packed), packed)
      }
    } catch { /* Missing receipts are not reusable. */ }
  }
  return { files, packs }
}

async function removeObsoleteCopies(root, retain, retainedPaths) {
  let visited = 0
  const walk = async (dir, prefix = '') => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name), relative = prefix + entry.name
      if (entry.isDirectory()) await walk(path, relative + '/')
      else if (!entry.isFile() || !retain.has(relative)) unlinkSync(path)
      else retainedPaths?.add(relative)
      if (++visited % 64 === 0) await yieldToHost()
    }
  }
  await walk(root)
}

async function snapshotFile(root, stageFiles, file, receipt) {
  const destination = join(stageFiles, file.path)
  const selectionId = recallSelectionFileId(file.path)
  let contents = file.contents
  if (selectionId) {
    try { contents = await cleanSelectionCopy(plainPath(root, file.path), selectionId, file) }
    catch (error) { if (error?.code === 'ENOENT') throw sourceChanged(); throw error }
  }
  const checksum = contents && digest(contents)
  if (receipt?.stamp === file.stamp && existsSync(destination)) {
    const actual = await copyAndHash(plainPath(stageFiles, file.path))
    if (actual.bytes === receipt.bytes && actual.sha256 === receipt.sha256 && (!checksum || checksum === receipt.sha256)) return receipt
  }
  try { unlinkSync(destination) } catch (error) { if (error?.code !== 'ENOENT') throw error }
  if (contents) {
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 })
    await atomicWritePrivateAsync(destination, contents)
    return { path: file.path, stamp: file.stamp, bytes: contents.length, sha256: checksum }
  }
  try {
    return { path: file.path, stamp: file.stamp, ...await copyAndHash(plainPath(root, file.path), destination, file.prefix) }
  } catch (error) { if (error?.code === 'ENOENT') throw sourceChanged(); throw error }
}

async function prunePayloads(directory, packs, allowed) {
  if (!existsSync(directory)) return
  if (!lstatSync(directory).isDirectory()) throw new Error('备份文件分段必须在普通目录中。')
  const retained = new Set()
  let checked = 0
  for (const [key, rows] of packs) {
    if (++checked % 4 === 0) await yieldToHost()
    if (rows.every(row => allowed.has(row.path))) {
      try { retained.add(checkPayload(directory, rows).name); continue }
      catch { /* The next attempt copies a damaged or missing segment. */ }
    }
    packs.delete(key)
  }
  await removeObsoleteCopies(directory, retained)
  await syncDirectoryAsync(directory)
}

async function snapshotPayload(root, directory, files, previous) {
  const cached = previous.get(stampedPaths(files))
  if (cached) return { rows: cached, part: payload(cached) }
  const chunks = [], rows = []
  for (const [i, file] of files.entries()) {
    if (i > 0 && i % 16 === 0) await yieldToHost()
    let bytes
    try { bytes = readSmallFile(plainPath(root, file.path), PACKED_FILE_BYTES, file.stamp) }
    catch (error) { if (error?.code === 'ENOENT') throw sourceChanged(); throw error }
    chunks.push(bytes)
    rows.push({ path: file.path, stamp: file.stamp, bytes: bytes.length, sha256: digest(bytes), packed: true })
  }
  const part = payload(rows)
  await atomicWritePrivateAsync(join(directory, part.name), Buffer.concat(chunks, part.bytes))
  return { rows, part }
}

async function writePart(directory, index, rows) {
  const file = partFile(index), value = JSON.stringify(rows) + '\n'
  await atomicWritePrivateAsync(join(directory, file), value)
  return { file, entries: rows.length, bytes: Buffer.byteLength(value), sha256: digest(value) }
}

export function hasBackupCheckpoint(root, format = 'compatible') {
  try {
    const stage = plainPath(join(root, 'backups'), backupStage(format) + '/' + PARTS + '/' + partFile(0))
    return lstatSync(stage).isFile()
  } catch { return false }
}

export const isBackupFormat = format => format === 'fast' || format === 'compatible'

export async function createCompleteBackup(root, now = Date.now(), format = 'compatible') {
  if (!isBackupFormat(format)) throw new TypeError('请选择快速备份或兼容备份。')
  const allowKnowledge = format === 'fast'
  const backups = join(root, 'backups')
  const name = `memories-${new Date(now).toISOString().replace(/[:.]/gu, '-')}-${randomUUID()}.backup`
  dirAt(backups)
  let release
  try { release = acquireFileLock(join(backups, '.snapshot-writer.lock'), 0) }
  catch (error) {
    if (error?.code !== 'memory-lock-in-use') throw error
    throw Object.assign(new Error('已有备份正在进行。'), { code: 'backup-in-progress' })
  }
  const staged = join(backups, backupStage(format)), target = join(backups, name)
  const stagedFiles = join(staged, 'files'), stagedParts = join(staged, PARTS), stagedPayloads = join(staged, PAYLOADS)
  const preparedManifest = join(staged, 'manifest.prepare.tmp'), readyManifest = join(staged, 'manifest.json')
  const store = new MemoryStore({ root }), noteBindings = new Map()
  const scan = () => inventory(root, store, noteBindings)
  let checkpointed = hasBackupCheckpoint(root, format)
  try {
    const captureAtCut = captureState(root)
    const before = await scan()
    const cut = await withBackupAuthority(root, () => {
      if (captureAtCut !== captureState(root)) throw sourceChanged()
      return authoritySnapshot(root, store)
    })
    const snapshot = [...before, ...cut.files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
    dirAt(staged); dirAt(stagedFiles); dirAt(stagedParts)
    try { unlinkSync(readyManifest); await syncDirectoryAsync(staged) }
    catch (error) { if (error?.code !== 'ENOENT') throw error }
    const previous = resumeFiles(staged, allowKnowledge)
    checkpointed = previous.files.size > 0 || previous.packs.size > 0
    const parts = [], payloadNames = new Set()
    const smallFiles = before.filter(file => file.packable && (allowKnowledge || sourceFile.test(file.path)))
    const usePayloads = smallFiles.length >= PART_SIZE
    const packable = new Set(usePayloads ? smallFiles.map(file => file.path) : [])
    await prunePayloads(stagedPayloads, previous.packs, packable)
    if (usePayloads) dirAt(stagedPayloads)
    await syncDirectoryAsync(staged)
    await syncDirectoryAsync(backups)
    await syncDirectoryAsync(root)
    await removeObsoleteCopies(stagedFiles, new Set(snapshot.filter(file => !packable.has(file.path)).map(file => file.path)))
    let batch = [], fileCount = 0
    for (let offset = 0; offset < snapshot.length; offset += PART_SIZE) {
      const group = snapshot.slice(offset, offset + PART_SIZE), packed = group.filter(file => packable.has(file.path))
      const packedRows = new Map()
      if (packed.length) {
        const { rows, part } = await snapshotPayload(root, stagedPayloads, packed, previous.packs)
        payloadNames.add(part.name)
        for (const row of rows) packedRows.set(row.path, row)
        await yieldToHost()
      }
      batch = []
      for (const file of group) {
        batch.push(packedRows.get(file.path) ?? await snapshotFile(root, stagedFiles, file, previous.files.get(file.path)))
        if (++fileCount % 16 === 0) await yieldToHost()
      }
      if (usePayloads || snapshot.length > PART_SIZE) {
        parts.push(await writePart(stagedParts, parts.length, batch))
        checkpointed = true
      }
    }
    const version = !usePayloads ? 2 : smallFiles.some(file => knowledgeMarkdown(file.path)) ? 4 : 3
    const manifest = parts.length > 0
      ? { format: FORMAT, version, createdAt: now, fileCount, parts }
      : { format: FORMAT, version: 1, createdAt: now, files: batch.map(({ stamp: _stamp, ...file }) => file) }
    await removeObsoleteCopies(stagedParts, new Set(parts.map(part => part.file)))
    if (existsSync(stagedPayloads)) {
      await removeObsoleteCopies(stagedPayloads, payloadNames)
      if (payloadNames.size === 0) rmdirSync(stagedPayloads)
    }
    for (const entry of readdirSync(staged, { withFileTypes: true })) {
      if (entry.name === 'files' || entry.name === PARTS || entry.name === 'manifest.json') continue
      if (usePayloads && entry.name === PAYLOADS && entry.isDirectory()) continue
      if (entry.isFile() && entry.name.endsWith('.tmp')) unlinkSync(join(staged, entry.name))
      else throw new Error('未完成备份目录包含无法确认的内容。')
    }
    await syncTreeDirectories(staged)
    const serialized = JSON.stringify(manifest) + '\n'
    if (Buffer.byteLength(serialized) > MAX_MANIFEST_BYTES) throw new Error('备份清单超过当前恢复工具支持的大小。')
    await atomicWritePrivateAsync(preparedManifest, serialized)
    // Check the selected files after the awaited flushes and seal while the
    // revocation and capture states still match that validation.
    const validatedCapture = await checkBackupCut(root, stagedFiles, before, captureAtCut, scan)
    await withBackupAuthority(root, () => {
      if (readAuthorityIntent(root) || cut.revocations !== revocationState(root) || validatedCapture !== captureState(root) || cut.files.some(file =>
        file.prefix && !hasCommittedPrefix(optionalStat(root, file.path), file.prefix))) throw sourceChanged()
      renameSync(preparedManifest, readyManifest)
      syncDirectory(staged)
      renameSync(staged, target)
      syncDirectory(backups)
    })
    return target
  } catch (error) {
    if (checkpointed && ['backup-source-changed', 'ENOSPC'].includes(error?.code)) {
      try {
        const allowed = new Set((await scan()).map(file => file.path))
        await removeObsoleteCopies(stagedFiles, allowed)
        await prunePayloads(stagedPayloads, resumeFiles(staged, allowKnowledge).packs, allowed)
      }
      catch { rmSync(staged, { recursive: true, force: true }) }
    } else rmSync(staged, { recursive: true, force: true })
    throw error
  } finally { release() }
}

function* manifestGroups(backup, manifest) {
  if (manifest.version === 1 && Array.isArray(manifest.files) && manifest.files.length <= LEGACY_MAX_FILES) {
    yield manifest.files
    return
  }
  if (![2, 3, 4].includes(manifest.version) || !Array.isArray(manifest.parts) ||
      !Number.isSafeInteger(manifest.fileCount) || manifest.fileCount < 1) throw new Error('不支持的备份格式或版本。')
  let count = 0
  for (const [index, part] of manifest.parts.entries()) {
    if (part?.file !== partFile(index) || !Number.isSafeInteger(part.entries) || part.entries < 1 || part.entries > PART_SIZE ||
        !Number.isSafeInteger(part.bytes) || part.bytes < 1 || part.bytes > MAX_MANIFEST_BYTES || !validHash(part.sha256)) {
      throw new Error('备份清单分段校验失败。')
    }
    const path = plainPath(backup, PARTS + '/' + part.file), info = lstatSync(path)
    if (!info.isFile() || info.size !== part.bytes) throw new Error('备份清单分段大小不匹配。')
    const bytes = readFileSync(path)
    if (digest(bytes) !== part.sha256) throw new Error('备份清单分段校验失败。')
    const rows = JSON.parse(bytes.toString('utf8'))
    if (!Array.isArray(rows) || rows.length !== part.entries) throw new Error('备份清单分段数量不匹配。')
    count += rows.length
    yield rows
  }
  if (count !== manifest.fileCount) throw new Error('备份清单文件数不匹配。')
}

export function readBackupManifest(backup) {
  if (!lstatSync(backup).isDirectory() || lstatSync(backup).isSymbolicLink()) throw new Error('请选择完整备份目录。')
  const manifestPath = plainPath(backup, 'manifest.json')
  const info = lstatSync(manifestPath)
  if (!info.isFile() || info.size > MAX_MANIFEST_BYTES) throw new Error('备份清单超过支持的大小或格式不符。')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (manifest?.format !== FORMAT || !Number.isFinite(manifest.createdAt) || manifest.createdAt < 0) {
    throw new Error('不支持的备份格式或版本。')
  }
  return manifest
}

async function readVerifiedBackup(backup) {
  const manifest = readBackupManifest(backup)
  const names = new Set(), files = [], packedPaths = new Map()
  const allowPayloads = manifest.version === 3 || manifest.version === 4
  for (const rows of manifestGroups(backup, manifest)) {
    const packed = allowPayloads ? rows.filter(row => row?.packed === true) : []
    if (packed.length) {
      if (!packed.every(row => validPackedFile(row, manifest.version === 4))) throw new Error('备份文件分段清单校验失败。')
      const part = checkPayload(plainPath(backup, PAYLOADS), packed)
      let offset = 0
      for (const row of packed) {
        packedPaths.set(row.path, { part, offset })
        offset += row.bytes
      }
    }
    for (const file of rows) {
      if (!validBackupFile(file) || names.has(file.path)) throw new Error('备份清单校验失败。')
      names.add(file.path)
      if (!allowPayloads || file.packed !== true) {
        const actual = await copyAndHash(plainPath(backup, `files/${file.path}`))
        if (actual.bytes !== file.bytes || actual.sha256 !== file.sha256) throw new Error('备份文件校验失败，未恢复任何数据。')
      }
      if (names.size % 16 === 0) await yieldToHost()
      files.push({ path: file.path, bytes: file.bytes, sha256: file.sha256 })
    }
  }
  return { manifest: { ...manifest, files }, packedPaths }
}

export async function verifyBackup(backup) {
  return (await readVerifiedBackup(backup)).manifest
}

async function writeRestoredFile(path, bytes) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const fd = openSync(path, 'wx', 0o600)
  try { writeAll(fd, bytes); await flushFile(fd) }
  finally { closeSync(fd) }
}

async function prepareRestoreWorkspace(workspace, fingerprint) {
  try { mkdirSync(workspace, { mode: 0o700 }) }
  catch (error) { if (error?.code !== 'EEXIST') throw error }
  const info = lstatSync(workspace)
  if (!info.isDirectory() || process.platform !== 'win32' &&
      ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.())) {
    throw new Error('恢复暂存目录归属不明，请选择新的恢复目标。')
  }
  const receiptPath = join(workspace, RESTORE_RECEIPT)
  const entries = readdirSync(workspace)
  const receiptTemps = entries.filter(name => /^restore\.json\.\d+\.[a-f0-9-]{36}\.tmp$/u.test(name))
  const stage = join(workspace, 'files')
  let previous = null
  if (entries.includes(RESTORE_RECEIPT)) {
    previous = JSON.parse(readSmallFile(plainPath(workspace, RESTORE_RECEIPT), 4096).toString('utf8'))
    if (previous?.format !== RESTORE_CHECKPOINT || previous.version !== 1 || !validHash(previous.fingerprint)) {
      throw new Error('恢复暂存凭据无法核验，请选择新的恢复目标。')
    }
  }
  const allowed = new Set([...receiptTemps, ...(previous ? [RESTORE_RECEIPT, RESTORE_TEMPORARY, 'files'] : [])])
  if (entries.some(name => !allowed.has(name))) throw new Error('恢复暂存目录包含未确认的内容。')
  for (const name of receiptTemps) unlinkSync(join(workspace, name))
  if (previous?.fingerprint !== fingerprint) {
    rmSync(stage, { recursive: true, force: true })
    await atomicWritePrivateAsync(receiptPath, JSON.stringify({ format: RESTORE_CHECKPOINT, version: 1, fingerprint }) + '\n')
    await syncDirectoryAsync(dirname(workspace))
  }
  dirAt(stage)
  return stage
}

export async function restoreBackup(backup, target, { currentRoot, revocations } = {}) {
  if (currentRoot !== undefined && revocations !== undefined) throw new Error('请选择当前数据目录或单独保存的撤权凭据。')
  const destination = resolve(target), parent = dirname(destination)
  if (existsSync(destination)) throw new Error('恢复目标已存在；请选择新的空目录路径。')
  const workspace = join(parent, `.memory-restore-${digest(basename(destination))}.tmp`)
  const temporary = join(workspace, RESTORE_TEMPORARY), lock = workspace + '.lock'
  const existingLock = optionalStat(parent, basename(lock))
  if (existingLock && (!existingLock.isFile() || existingLock.size > 64n)) throw new Error('恢复写入锁无法核验。')
  let release
  try { release = acquireFileLock(lock, 0) }
  catch (error) {
    if (error?.code !== 'memory-lock-in-use') throw error
    throw Object.assign(new Error('已有恢复正在写入此目标。'), { code: 'restore-in-progress' })
  }
  let owned = false, reserved = false
  try {
    if (existsSync(destination)) throw new Error('恢复目标已存在；请选择新的空目录路径。')
    const privacy = currentRoot !== undefined || revocations !== undefined ? await import('./recovery-privacy.js') : null
    const receipt = revocations === undefined ? null : privacy.readRevocationReceipt(revocations)
    const { manifest, packedPaths } = await readVerifiedBackup(backup)
    const input = join(backup, 'files')
    const denied = manifest.files.some(file => file.path === `${CAPTURE_DIR}/${TURNS_FILE}`)
      ? noSaveSourceIds(readTurnIntakes(input).intakes) : new Set()
    if (manifest.files.some(file => file.path === REVOCATION_FILE)) {
      for (const id of readRevocationLedger(input).deniedSources) denied.add(id)
    }
    const restorable = manifest.files.filter(file => !isDeniedSourceFile(file.path, denied))
    const identity = createHash('sha256').update(JSON.stringify([
      resolve(backup), manifest.version, manifest.createdAt,
      currentRoot === undefined ? null : resolve(currentRoot), revocations === undefined ? null : resolve(revocations),
    ]))
    for (const file of restorable) identity.update(JSON.stringify(file) + '\n')
    const stage = await prepareRestoreWorkspace(workspace, identity.digest('hex'))
    owned = true
    const retained = new Set()
    await removeObsoleteCopies(stage, new Set(restorable.map(file => file.path)), retained)
    rmSync(temporary, { force: true })
    let activePart, payloadBytes, reusedFiles = 0
    for (const file of restorable) {
      const output = join(stage, file.path), packed = packedPaths.get(file.path)
      const selectionId = recallSelectionFileId(file.path)
      const selection = selectionId ? await cleanSelectionCopy(plainPath(input, file.path), selectionId, file) : null
      const expected = selection ? { bytes: selection.length, sha256: digest(selection) } : file
      if (retained.has(file.path)) {
        const actual = await copyAndHash(plainPath(stage, file.path))
        if (actual.bytes === expected.bytes && actual.sha256 === expected.sha256) {
          reusedFiles++
          continue
        }
        unlinkSync(output)
      }
      if (existsSync(output)) throw new Error('备份文件在恢复目标上存在路径冲突。')
      if (selection) {
        await writeRestoredFile(temporary, selection)
      } else if (packed) {
        if (activePart !== packed.part) {
          activePart = packed.part
          payloadBytes = readPayload(plainPath(backup, PAYLOADS), activePart)
        }
        const bytes = payloadBytes.subarray(packed.offset, packed.offset + file.bytes)
        if (digest(bytes) !== file.sha256) throw new Error('恢复期间备份校验发生变化，未应用。')
        await writeRestoredFile(temporary, bytes)
      } else {
        const copied = await copyAndHash(plainPath(backup, `files/${file.path}`), temporary)
        if (copied.bytes !== file.bytes || copied.sha256 !== file.sha256) throw new Error('恢复期间备份校验发生变化，未应用。')
      }
      // Only fully flushed and verified files ever appear at a reusable path.
      mkdirSync(dirname(output), { recursive: true, mode: 0o700 })
      renameSync(temporary, output)
    }
    await syncTreeDirectories(stage)
    const publish = retainedRevocations => {
      const check = knowledgeAuthority(new MemoryStore({ root: stage }))
      const modified = new Set()
      let files = 0, bytes = 0
      for (const entry of restorable) {
        const knowledge = knowledgeMarkdown(entry.path)
        if (!knowledge && !recallSelectionFileId(entry.path) && retainedRevocations === undefined) {
          files++; bytes += entry.bytes
          continue
        }
        let path
        let info
        try {
          path = knowledge ? plainPath(stage,entry.path) : join(stage,entry.path)
          info = lstatSync(path)
        }
        catch (error) { if (error?.code === 'ENOENT' && retainedRevocations !== undefined) continue; throw error }
        if (!info.isFile()) throw new Error('恢复中的文件不是普通文件。')
        if (knowledge && !check(readKnowledgeBinding(path)).allowed) {
          unlinkSync(path)
          modified.add(dirname(path))
        } else {
          files++
          bytes += info.size
        }
      }
      for (const directory of modified) syncDirectory(directory)
      if (process.platform === 'win32') {
        // Windows directory rename requires an absent destination and rejects a race winner.
        renameSync(stage, destination)
      } else {
        // POSIX rename can atomically replace the empty reservation, preserving no-overwrite behavior.
        mkdirSync(destination, { mode: 0o700 }); reserved = true
        renameSync(stage, destination); reserved = false
      }
      syncDirectory(workspace)
      syncDirectory(parent)
      return { files, bytes,
        ...(retainedRevocations === undefined ? {} : { retainedRevocations }) }
    }
    const restored = receipt ? privacy.publishWithReceipt(stage, receipt, publish)
      : currentRoot !== undefined ? privacy.publishWithCurrentRevocations(resolve(currentRoot), stage, backup, publish)
        : denied.size ? (await import('./recovery-privacy.js')).publishWithSnapshotDenials(stage, publish) : publish()
    rmSync(workspace, { recursive: true, force: true })
    return reusedFiles ? { ...restored, reusedFiles } : restored
  } catch (error) {
    if (reserved) { try { rmdirSync(destination) } catch {} }
    if (owned) {
      if (['ENOSPC', 'EDQUOT', 'memory-lock-in-use'].includes(error?.code)) rmSync(temporary, { force: true })
      else rmSync(workspace, { recursive: true, force: true })
    }
    throw error
  } finally { release() }
}
