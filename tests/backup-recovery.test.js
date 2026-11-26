import assert from 'node:assert/strict'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { syncBuiltinESMExports } from 'node:module'
import { fileURLToPath } from 'node:url'
import { CapturePipeline } from '../host/capture.js'
import { MemoryIndex } from '../host/search.js'
import { resolveConfig } from '../host/config.js'
import { MemoryStore } from '../host/store.js'
import { canReadSource, captureTaskIdOf, readCaptureTasks, readSource, saveSource, turnIdOf, writeCaptureTask, writeTurnIntake } from '../host/capture-journal.js'
import { hasBackupCheckpoint, restoreBackup, verifyBackup } from '../host/backup.js'
import { runMaintenance } from '../host/maintenance.js'
import { writeSettings, readSettings } from '../host/settings.js'
import { promoteMemoryToKnowledge } from '../host/knowledge.js'
import { noteDigest, PURGED_NOTE_DIGESTS, readPurgedNoteDigests, serializeMemory } from '../host/obsidian-note.js'
import { ObsidianSync } from '../host/obsidian-sync.js'
import { grantSourceRecall, hasSourceRecallGrant } from '../host/source-passages.js'
import { readRecallSelection, readRecallSelections, recallSelectionId } from '../host/recall-journal.js'
import { appendUsage, USAGE_FILE } from '../host/usage-log.js'

const recoveryCli = fileURLToPath(new URL('../host/recovery-cli.js', import.meta.url))
const recoveryCommand = (...args) => spawnSync(process.execPath, [recoveryCli, ...args], { encoding: 'utf8' })

function setup(t) {
  const parent = fs.mkdtempSync(join(tmpdir(), 'memory-complete-backup-')), root = join(parent, 'data')
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }))
  return { parent, root, store: new MemoryStore({ root, clock: () => 1700000000000 }).open() }
}

test('complete backup restores history, deletion, source barriers, unknown calls, notes and settings', async t => {
  const { parent, root, store } = setup(t)
  const row = store.write({ kind: 'fact', scope: 'global', content: '备份恢复需要保留已遗忘的记录状态。', confidence: .9 }).record
  store.update(row.id, { status: 'deleted' }, [{ scope: 'global' }])
  writeSettings(root, { captureEnabled: false, obsidianAutoSync: false })
  fs.mkdirSync(join(root, 'knowledge'), { recursive: true })
  fs.writeFileSync(join(root, 'knowledge', 'example.md'), '用户自己的完整知识笔记。')
  fs.mkdirSync(join(root, 'capture', 'sources'), { recursive: true })
  fs.writeFileSync(join(root, 'capture', 'sources', 'source.recall-blocked'), 'blocked')
  writeCaptureTask(root, { id: 'cap_112233441122334411223344', status: 'unknown', callState: 'unknown', attempts: 1, sourceIds: [], route: { provider: 'local', model: 'test' } })
  fs.writeFileSync(join(root, 'panel-transport.json'), '{"path":"runtime-secret"}')
  const backup = await store.backup()
  assert.equal(fs.statSync(backup).isDirectory(), true, 'backup must include the complete local evidence set')
  const { restoreBackup } = await import('../host/backup.js')
  const restored = join(parent, 'restored')
  await restoreBackup(backup, restored)
  const fresh = new MemoryStore({ root: restored }).open()
  assert.equal(fresh.listAll().length, 0)
  assert.equal(fresh.find(row.id).status, 'deleted')
  assert.equal(fresh.history(row.id, [{ scope: 'global' }]).length, 2)
  assert.equal(readSettings(restored).captureEnabled, false)
  assert.equal(readCaptureTasks(restored)[0].callState, 'unknown')
  for (const file of ['global/memories.jsonl', 'capture/sources/source.recall-blocked', 'knowledge/example.md']) {
    assert.deepEqual(fs.readFileSync(join(restored, file)), fs.readFileSync(join(root, file)))
  }
  assert.equal(fs.existsSync(join(restored, 'panel-transport.json')), false)
  assert.equal(fs.existsSync(join(restored, '.write.lock')), false)
  let calls = 0
  const pipeline = new CapturePipeline({ store: fresh, index: new MemoryIndex().rebuild(fresh.listAll()), config: resolveConfig({}),
    ctx: { get: key => key === 'llm' ? { async *stream() { calls++; throw new Error('must not resend') } } : undefined, logger: { info() {}, warn() {} } } })
  await pipeline.resume()
  assert.equal(calls, 0)
  assert.equal(readCaptureTasks(restored)[0].callState, 'unknown')
})

test('complete backup preserves the Obsidian purge ledger and exact copy checksums', async t => {
  const { parent, root, store } = setup(t)
  const row = store.write({ kind: 'fact', scope: 'global', content: '这条记忆用于验证清除记录备份。', confidence: .9 }).record
  store.remove(row.id, [{ scope: 'global' }])
  store.purge(row.id, [{ scope: 'global' }])
  const backup = await store.backup()
  const { restoreBackup } = await import('../host/backup.js')
  const restored = join(parent, 'restored-purge-ledger')
  await restoreBackup(backup, restored)
  const fresh = new MemoryStore({ root: restored }).open()
  assert.deepEqual(fresh.purgedIds(), new Set([row.id]))
  assert.deepEqual(JSON.parse(fs.readFileSync(join(restored, 'obsidian-purged-ids.json'), 'utf8')), [row.id])
  assert.deepEqual(readPurgedNoteDigests(restored).get(row.id), new Set([noteDigest(serializeMemory(row))]))
  assert.ok(!fs.readFileSync(join(restored, 'obsidian-purged-notes.json'), 'utf8').includes(row.content))
})

test('both snapshot formats and old restores keep the selection ledger without copying legacy text', async t => {
  const { parent, root, store } = setup(t)
  const id = recallSelectionId('old-session', 'old-turn')
  const corruptId = recallSelectionId('old-session', 'corrupt-turn')
  const relative = `recall/selection/${id}.json`, corruptRelative = `recall/selection/${corruptId}.json`
  const statement = 'Synthetic legacy selection phrase for QA'
  const request = 'Synthetic original question for QA'
  const ledger = {
    id, state: 'completed', callState: 'completed', requestedAt: 1700000000000,
    completedAt: 1700000000180, route: { provider: 'local', model: 'fixture' },
    usage: { inputTokens: 40, outputTokens: 7, totalTokens: 47 },
    budgetReservation: { day: '2023-11-14', calls: 1, state: 'settled', actualTokens: 47 },
    candidateRefs: [{ id: 'note:forgotten.md', revision: 1 }], finishKind: 'stop', reason: null,
  }
  const raw = Buffer.from(JSON.stringify({ ...ledger, slotKeys: [request],
    resultText: JSON.stringify({ selections: [{ slot: 0, id: 'note:forgotten.md', revision: 1, quote: statement }] }) }) + '\n')
  fs.mkdirSync(join(root, 'recall', 'selection'), { recursive: true })
  fs.writeFileSync(join(root, relative), raw)
  fs.writeFileSync(join(root, corruptRelative), statement)

  const check = directory => {
    const clean = fs.readFileSync(join(directory, relative), 'utf8')
    assert.ok(!clean.includes(statement) && !clean.includes(request), clean)
    assert.deepEqual(JSON.parse(clean), ledger)
    assert.ok(!fs.readFileSync(join(directory, corruptRelative), 'utf8').includes(statement))
    assert.equal(readRecallSelection(directory, corruptId).callState, 'unknown')
    assert.deepEqual(readRecallSelections(directory, '2023-11-15').find(row => row.id === corruptId).budgetReservation,
      { day: '2023-11-15', calls: 1, state: 'reserved' })
  }
  let compatibilityBackup
  for (const format of ['fast', 'compatible']) {
    const backup = await store.backup(format)
    check(join(backup, 'files'))
    const verified = await verifyBackup(backup)
    assert.equal(verified.files.find(row => row.path === relative).bytes, fs.statSync(join(backup, 'files', relative)).size)
    const target = join(parent, 'clean-' + format)
    await restoreBackup(backup, target)
    check(target)
    if (format === 'compatible') compatibilityBackup = backup
  }
  // Restore a V1 archive containing the original legacy receipt and its
  // authentic manifest digest. Successful recovery must leave it untouched.
  const old = join(parent, 'old-v1.backup')
  fs.cpSync(compatibilityBackup, old, { recursive: true })
  const manifestPath = join(old, 'manifest.json')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  assert.equal(manifest.version, 1)
  fs.writeFileSync(join(old, 'files', relative), raw)
  Object.assign(manifest.files.find(row => row.path === relative), { bytes: raw.length,
    sha256: createHash('sha256').update(raw).digest('hex') })
  const manifestBytes = JSON.stringify(manifest)
  fs.writeFileSync(manifestPath, manifestBytes)
  const target = join(parent, 'from-old')
  const restored = await restoreBackup(old, target)
  check(target)
  assert.equal(restored.bytes, manifest.files.reduce((total, row) => total + row.bytes, 0) - raw.length + fs.statSync(join(target, relative)).size)
  assert.deepEqual(fs.readFileSync(join(old, 'files', relative)), raw)
  assert.equal(fs.readFileSync(manifestPath, 'utf8'), manifestBytes)
  assert.deepEqual(fs.readFileSync(join(root, relative)), raw)
})

test('restoring an older backup with the current root retains later forget and purge barriers', async t => {
  const { parent, root, store } = setup(t)
  const owner = { version: 1, kind: 'profile', identity: 'a'.repeat(64) }
  fs.writeFileSync(join(root, 'data-owner.json'), JSON.stringify(owner))
  const projectKey = 'b'.repeat(64), target = { scope: 'project', projectKey }
  const source = saveSource(root, { sessionId: 'qa', messageId: 'forgotten', role: 'user', sourceKind: 'user', projectKey,
    text: '旧快照中有一条后来忘掉的原话。' })
  const a = store.write({ ...target, kind: 'fact', content: '后来遗忘的记忆。', sourceRefs: [{ sourceId: source.id }], confidence: .9 }).record
  const b = store.write({ scope: 'global', kind: 'fact', content: '后来永久删除的记忆。', confidence: .9 }).record
  const c = store.write({ ...target, kind: 'fact', content: '原有记忆仍应保留。', confidence: .9 }).record
  const before = store.exportData()
  const backup = await store.backup()
  store.remove(a.id, [target])
  store.remove(b.id, [{ scope: 'global' }])
  store.purge(b.id, [{ scope: 'global' }])
  const destination = join(parent, 'with-later-revocations')
  await restoreBackup(backup, destination, { currentRoot: root })
  const current = new MemoryStore({ root: destination }).open()
  assert.equal(current.find(a.id, [target]).status, 'deleted')
  assert.equal(canReadSource(destination, source.id), false)
  assert.equal(current.history(b.id, [{ scope: 'global' }]).length, 0)
  assert.ok(current.purgedIds().has(b.id))
  assert.deepEqual(readPurgedNoteDigests(destination).get(b.id), new Set([noteDigest(serializeMemory(b))]))
  assert.equal(current.find(c.id, [target]).content, c.content)
  assert.equal(current.importData(before).protectedDeleted, 2)

  const foreign = join(parent, 'mismatched-profile'), withheld = join(parent, 'not-published')
  fs.mkdirSync(foreign)
  fs.writeFileSync(join(foreign, 'data-owner.json'), JSON.stringify({ ...owner, identity: 'c'.repeat(64) }))
  await assert.rejects(restoreBackup(backup, withheld, { currentRoot: foreign }), /归属/u)
  assert.equal(fs.existsSync(withheld), false)
})

test('verified old snapshots recover missing Vault checksums only for revisions that were purged', async t => {
  const { parent, root, store } = setup(t)
  fs.writeFileSync(join(root, 'data-owner.json'), JSON.stringify({ version: 1, kind: 'profile', identity: 'a'.repeat(64) }))
  const removed = { scope: 'project', projectKey: 'archived-origin' }
  const retained = { scope: 'project', projectKey: 'archived-other' }
  const first = store.write({ ...removed, kind: 'fact', content: 'Legacy archived fact 1937.' }).record
  const later = store.update(first.id, { content: 'Legacy revised fact 5602.' }, [removed])
  const sibling = store.write({ ...retained, kind: 'fact', content: 'An unrelated project with the same old ID.' }, { id: first.id }).record
  const snapshot = await store.backup()
  const manifest = fs.readFileSync(join(snapshot, 'manifest.json'))
  store.remove(first.id, [removed])
  assert.equal(store.purge(first.id, [removed]), true)
  // Model an old purge that retained the scoped tombstone but no Vault digests.
  fs.unlinkSync(join(root, PURGED_NOTE_DIGESTS))
  const receipt = join(parent, 'legacy-revocations.json')
  const exported = recoveryCommand('export-revocations', root, receipt)
  assert.equal(exported.status, 0, exported.stderr)
  assert.deepEqual(JSON.parse(fs.readFileSync(receipt, 'utf8')).data.purgedNotes, [])
  const target = join(parent, 'restored-legacy-copies')
  await restoreBackup(snapshot, target, { revocations: receipt })
  assert.deepEqual(fs.readFileSync(join(snapshot, 'manifest.json')), manifest)
  await verifyBackup(snapshot)
  const restored = new MemoryStore({ root: target }).open()
  assert.equal(restored.find(first.id, [removed]), undefined)
  assert.equal(restored.find(first.id, [retained]).content, sibling.content)
  assert.deepEqual(readPurgedNoteDigests(target).get(first.id), new Set([first, later].map(row => noteDigest(serializeMemory(row)))))

  const vault = join(parent, 'vault'), folder = 'Notes', history = join(vault, folder, '_history')
  fs.mkdirSync(history, { recursive: true })
  const archive = (id, bytes) => {
    const file = join(history, `1700000000-00000000-0000-0000-0000-00000000000${id}-${first.id}.md`)
    fs.writeFileSync(file, bytes)
    return file
  }
  const originalCopy = archive(1, serializeMemory(first)), laterCopy = archive(2, serializeMemory(later))
  const authorBytes = serializeMemory(first) + '\nAuthor annotation.\n'
  const authored = archive(3, authorBytes), otherCopy = archive(4, serializeMemory(sibling))
  const config = { vaultPath: vault, folder, autoSync: false }
  const sync = new ObsidianSync({ root: target, store: restored, index: new MemoryIndex(), getConfig: () => config })
  t.after(() => sync.dispose())
  const result = await sync.run()
  assert.deepEqual(result.errors, [])
  assert.equal(result.purgedCopies, 2)
  assert.equal(fs.existsSync(originalCopy), false)
  assert.equal(fs.existsSync(laterCopy), false)
  assert.equal(fs.readFileSync(authored, 'utf8'), authorBytes)
  assert.equal(fs.readFileSync(otherCopy, 'utf8'), serializeMemory(sibling))
  assert.equal((await sync.run()).purgedCopies, 0)
})

test('an independent deletion receipt restores an old backup without the current data directory', async t => {
  const { parent, root, store } = setup(t)
  fs.writeFileSync(join(root, 'data-owner.json'), JSON.stringify({ version:1, kind:'profile', identity:'a'.repeat(64) }))
  const scope = { scope:'project', projectKey:'receipt-alpha' }, other = { scope:'project', projectKey:'receipt-beta' }
  const makeSource = (messageId, text) => saveSource(root, {
    sessionId:'source-session', messageId, text, role:'user', sourceKind:'user', projectKey:scope.projectKey
  })
  const source = makeSource('forgotten', '不可召回的原文 QA-RECEIPT-SOURCE。')
  const privateSource = makeSource('no-save', '不应保留的原文 QA-RECEIPT-PRIVATE。')
  const forgotten = store.write({ ...scope, kind:'fact', content:'稍后遗忘 QA-RECEIPT-FORGET。',
    sourceRefs:[{ sourceId:source.id }] }).record
  const permanent = store.write({ ...scope, kind:'fact', content:'稍后永久删除 QA-RECEIPT-PURGE。' }).record
  const unrelated = store.write({ ...other, kind:'fact', content:'另一个项目仍保留 QA-RECEIPT-BETA。' }, {id:forgotten.id}).record
  const unrelatedPermanent = store.write({ ...other, kind:'fact', content:'同一个旧 ID 在另一个项目仍有效。' },
    {id:permanent.id}).record
  const related = promoteMemoryToKnowledge(root, forgotten)
  const otherNote = promoteMemoryToKnowledge(root, unrelatedPermanent)
  const otherNoteBytes = fs.readFileSync(otherNote)
  const task = {
    id:captureTaskIdOf({sessionId:'source-session',turnKey:'private',sourceIds:[privateSource.id],segmentIndex:0,total:1}),
    sessionId:'source-session', projectKey:scope.projectKey, sourceIds:[privateSource.id],
    status:'running', callState:'completed', attempts:1, resultText:'已付费的禁存回应 QA-RECEIPT-PRIVATE-RESULT。',
    resultUsage:{inputTokens:10,outputTokens:7,totalTokens:17},
  }
  writeCaptureTask(root,task)
  writeCaptureTask(root,{...task,appliedContents:['旧修订的禁存回应 QA-RECEIPT-PRIVATE-OLDER。']})
  const derivedPrivate = store.write({ ...scope, kind:'fact', content:'旧提炼产物 QA-RECEIPT-PRIVATE-DERIVED。',
    captureTaskId:task.id, sourceRefs:[{sourceId:privateSource.id}] }).record
  const backup = await store.backup(), copy = join(parent, 'offline.backup')
  fs.cpSync(backup, copy, {recursive:true})
  const originalManifest = fs.readFileSync(join(copy,'manifest.json'))
  const deleted = store.remove(forgotten.id,[scope])
  store.remove(permanent.id,[scope])
  assert.equal(store.purge(permanent.id,[scope]),true)
  writeTurnIntake(root,{ id:turnIdOf({sessionId:'source-session',sourceIds:[privateSource.id]}),
    sessionId:'source-session', projectKey:scope.projectKey, sourceIds:[privateSource.id], status:'skipped', noSave:true })
  const receipt = join(parent,'deletions.json')
  const exported = recoveryCommand('export-revocations', root, receipt)
  assert.equal(exported.status,0,exported.stderr)
  const receiptBytes = fs.readFileSync(receipt,'utf8')
  assert.doesNotMatch(receiptBytes,/QA-RECEIPT-|source-session/u)
  assert.notEqual(recoveryCommand('export-revocations',root,receipt).status,0)
  assert.equal(fs.readFileSync(receipt,'utf8'),receiptBytes)
  fs.renameSync(root,join(parent,'disconnected-data'))

  const target = join(parent,'offline-restored')
  const restored = recoveryCommand('restore',copy,target,'--revocations',receipt)
  assert.equal(restored.status,0,restored.stderr)
  const fresh = new MemoryStore({root:target}).open()
  assert.equal(fresh.find(forgotten.id,[scope]).status,'deleted')
  assert.equal(fresh.find(forgotten.id,[scope]).revision,deleted.revision)
  assert.equal(fresh.find(permanent.id,[scope]),undefined)
  assert.equal(fresh.find(unrelated.id,[other]).content,unrelated.content)
  assert.equal(fresh.find(unrelatedPermanent.id,[other]).content,unrelatedPermanent.content)
  assert.deepEqual(fs.readFileSync(join(target,'knowledge',otherNote.split(sep).at(-1))),otherNoteBytes)
  assert.equal(canReadSource(target,source.id),false)
  assert.equal(canReadSource(target,privateSource.id),false)
  assert.equal(fs.existsSync(join(target,'capture','sources',privateSource.id+'.json.gz')),false)
  assert.equal(fs.existsSync(join(target,'knowledge',related.split(sep).at(-1))),false)
  assert.equal(fresh.find(derivedPrivate.id,[scope]).status,'deleted')
  assert.doesNotMatch(fs.readFileSync(join(target,'projects',scope.projectKey,'memories.jsonl'),'utf8'),/QA-RECEIPT-PRIVATE-/u)
  assert.doesNotMatch(fs.readFileSync(join(target,'capture','capture-tasks.jsonl'),'utf8'),/QA-RECEIPT-PRIVATE-/u)
  const revoked = readCaptureTasks(target).find(row=>row.id===task.id)
  assert.equal(revoked.status,'skipped')
  assert.equal(revoked.callState,'completed')
  assert.deepEqual(revoked.resultUsage,task.resultUsage)
  let calls = 0
  const pipeline = new CapturePipeline({ store:fresh, index:new MemoryIndex().rebuild(fresh.listAll()), config:resolveConfig({}),
    ctx:{get:name=>name==='llm' ? {async *stream(){calls++; throw Error('must not resend')}} : undefined} })
  await pipeline.resume()
  assert.equal(pipeline.retry(task.id,{confirmUnknown:true}).ok,false)
  assert.equal(calls,0)
  assert.deepEqual(readPurgedNoteDigests(target).get(permanent.id),new Set([noteDigest(serializeMemory(permanent))]))
  assert.deepEqual(fs.readFileSync(join(copy,'manifest.json')),originalManifest)
  assert.ok((await verifyBackup(copy)).files.length > 0)
})

test('recovery honors a deletion through compaction and preserves a newer restored revision', async t => {
  const { parent, root, store } = setup(t)
  fs.writeFileSync(join(root, 'data-owner.json'), JSON.stringify({ version:1, kind:'profile', identity:'a'.repeat(64) }))
  const scope = { scope:'project', projectKey:'receipt-alpha' }, where = [scope]
  const original = store.write({ ...scope, kind:'fact', content:'第一版审批条件。' }).record
  const early = await store.backup()
  store.update(original.id,{content:'第二版审批条件。'},where)
  const deleted = store.remove(original.id,where)
  const receipt = join(parent,'before-restore.json')
  const saved = recoveryCommand('export-revocations',root,receipt)
  assert.equal(saved.status,0,saved.stderr)
  const staleCurrent = join(parent,'data-at-deletion')
  fs.cpSync(root,staleCurrent,{recursive:true,filter:source=>!source.endsWith(sep+'backups')})
  store.update(original.id,{status:'active',content:'用户后来恢复并改写的审批条件。'},where,{restore:true})
  store.compact(scope.scope,scope.projectKey)
  const later = await store.backup()
  const recentReceipt = join(parent,'after-restore.json')
  const exported = recoveryCommand('export-revocations',root,recentReceipt)
  assert.equal(exported.status,0,exported.stderr)
  const oldTarget = join(parent,'restored-early')
  await restoreBackup(early,oldTarget,{revocations:recentReceipt})
  const older = new MemoryStore({root:oldTarget}).open().find(original.id,where)
  assert.equal(older.status,'deleted')
  assert.equal(older.revision,deleted.revision)
  for (const [index,options] of [{revocations:receipt},{currentRoot:staleCurrent}].entries()) {
    const target = join(parent,'restored-later-'+index)
    await restoreBackup(later,target,options)
    const active = new MemoryStore({root:target}).open().find(original.id,where)
    assert.equal(active.status,'active')
    assert.equal(active.content,'用户后来恢复并改写的审批条件。')
  }
})

test('bad, foreign and conflicting revocation receipts leave the destination absent', async t => {
  const { parent, root, store } = setup(t)
  const owner = identity => JSON.stringify({ version:1, kind:'profile', identity })
  fs.writeFileSync(join(root,'data-owner.json'),owner('a'.repeat(64)))
  const scope = {scope:'global', projectKey:null}
  const row = store.write({ ...scope, kind:'fact', content:'同修订冲突的初始内容。' }).record
  const early = await store.backup()
  const forkRoot = join(parent,'forked')
  fs.cpSync(root,forkRoot,{recursive:true,filter:source=>!source.endsWith(sep+'backups')})
  const fork = new MemoryStore({root:forkRoot}).open()
  fork.update(row.id,{content:'分支里同一修订号的有效内容。'},[scope])
  const forkBackup = await fork.backup()
  store.remove(row.id,[scope])
  const sameProfile = join(parent,'correct-owner.json')
  assert.equal(recoveryCommand('export-revocations',root,sameProfile).status,0)
  const corrupt = join(parent,'bad-checksum.json')
  const value = JSON.parse(fs.readFileSync(sameProfile,'utf8'))
  value.data.records[0].revision += 1
  fs.writeFileSync(corrupt,JSON.stringify(value))
  const foreign = join(parent,'different-owner.json')
  fs.writeFileSync(join(forkRoot,'data-owner.json'),owner('b'.repeat(64)))
  assert.equal(recoveryCommand('export-revocations',forkRoot,foreign).status,0)

  for (const [name, backup, revocations, error] of [
    ['bad',early,corrupt,/校验/u],['foreign',early,foreign,/归属/u],['conflict',forkBackup,sameProfile,/同一修订/u],
  ]) {
    const target = join(parent,'unpublished-'+name)
    await assert.rejects(restoreBackup(backup,target,{revocations}),error)
    assert.equal(fs.existsSync(target),false)
    assert.equal(fs.readdirSync(parent).some(item=>item.startsWith('.memory-restore-')),false)
  }
  assert.ok((await verifyBackup(early)).files.length > 0)
  assert.ok((await verifyBackup(forkBackup)).files.length > 0)
})

test('deletion boundaries recover after a failure to publish the ledger', t => {
  const { root, store } = setup(t)
  const row = store.write({ scope:'global', kind:'fact', content:'删除写入恢复基线。' }).record
  const file = join(root,'recovery-revocations.json')
  const rename = fs.renameSync
  let injected = false
  fs.renameSync = (from,to) => {
    if (to === file && !injected) {
      injected = true
      throw Object.assign(Error('test revocation-ledger interruption'),{code:'EIO'})
    }
    return rename(from,to)
  }
  syncBuiltinESMExports()
  try { assert.throws(()=>store.remove(row.id),{code:'recall-recovery-pending',committed:true}) }
  finally { fs.renameSync = rename; syncBuiltinESMExports() }
  assert.equal(injected,true)
  assert.equal(fs.existsSync(join(root,'.authority-intent.json')),true)
  const restarted = new MemoryStore({root}).open()
  assert.equal(restarted.find(row.id).status,'deleted')
  assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).records[0].revision,2)
  assert.equal(fs.existsSync(join(root,'.authority-intent.json')),false)
})

test('a linked Markdown copy cannot survive a forget or purge through backup recovery', async t => {
  const { parent, root, store } = setup(t)
  const scope = { scope: 'project', projectKey: 'field-a' }
  const other = { scope: 'project', projectKey: 'field-b' }
  fs.writeFileSync(join(root, 'data-owner.json'), JSON.stringify({ version: 1, kind: 'profile', identity: 'a'.repeat(64) }))
  const revoked = store.write({ ...scope, kind: 'fact', content: '后来撤回的手册库存号 CEDAR-429。' }).record
  const purged = store.write({ ...scope, kind: 'fact', content: '稍后彻底清除的库存号 MAPLE-635。' }).record
  const live = store.write({ ...other, kind: 'fact', content: '另一项目的笔记仍在授权范围内。' }).record
  const files = [revoked, purged, live].map(row => promoteMemoryToKnowledge(root, row))
  fs.writeFileSync(join(root, 'knowledge', 'plain-author.md'), '作者自己的迁移笔记。')
  const latestEdited = fs.readFileSync(files[0], 'utf8') + '\n## 个人补充\n自己的编辑要保留。\n'
  fs.writeFileSync(files[0], latestEdited)
  const older = await store.backup()
  store.remove(revoked.id, [scope])
  store.remove(purged.id, [scope])
  assert.equal(store.purge(purged.id, [scope]), true)
  const after = await verifyBackup(await store.backup())
  const included = after.files.map(file => file.path)
  assert.ok(included.includes('knowledge/plain-author.md') && included.includes('knowledge/' + live.id + '.md'))
  assert.ok(!included.includes('knowledge/' + revoked.id + '.md') && !included.includes('knowledge/' + purged.id + '.md'))

  const destination = join(parent, 'restored-with-current')
  await restoreBackup(older, destination, { currentRoot: root })
  const fresh = new MemoryStore({ root: destination }).open()
  assert.equal(fresh.find(revoked.id, [scope]).status, 'deleted')
  assert.ok(fresh.purgedIds().has(purged.id))
  assert.ok(!fs.existsSync(join(destination, 'knowledge', revoked.id + '.md')))
  assert.ok(!fs.existsSync(join(destination, 'knowledge', purged.id + '.md')))
  assert.deepEqual(fs.readFileSync(join(destination, 'knowledge', live.id + '.md')), fs.readFileSync(files[2]))
  assert.equal(fs.readFileSync(join(destination, 'knowledge', 'plain-author.md'), 'utf8'), '作者自己的迁移笔记。')
  assert.equal(fs.readFileSync(files[0], 'utf8'), latestEdited)
})

test('new backups exclude every raw source of a legacy opted-out turn and preserve other sources', async t => {
  const { root, store } = setup(t)
  const sessionId = 'legacy-private-turn'
  const save = (role, messageId, text) => saveSource(root, { role, sourceKind: role, sessionId, messageId, text })
  const denied = [save('user', 'u', '不要保存这次问答。'), save('assistant', 'a', '这是临时答复。')]
  const kept = save('user', 'other', '这条来自另一次正常问答。')
  const sourceIds = denied.map(item => item.id)
  writeTurnIntake(root, { id: turnIdOf({ sessionId, sourceIds }), sessionId, sourceIds, status: 'skipped',
    reason: '明确要求不保存当前问答，已跳过提炼' })
  const { files } = await verifyBackup(await store.backup())
  assert.ok(files.every(file => !sourceIds.some(id => file.path.includes(`${id}.json`))))
  assert.ok(files.some(file => file.path.endsWith(`${kept.id}.json.gz`)))
})

test('same-clock backups remain distinct and an existing target is never replaced', async t => {
  const { parent, store } = setup(t)
  const first = await store.backup(), second = await store.backup()
  assert.notEqual(first, second)
  const { restoreBackup } = await import('../host/backup.js')
  const target = join(parent, 'existing'); fs.mkdirSync(target); fs.writeFileSync(join(target, 'mine'), 'keep')
  await assert.rejects(async () => restoreBackup(first, target), /已存在/u)
  assert.equal(fs.readFileSync(join(target, 'mine'), 'utf8'), 'keep')
})

test('an interrupted snapshot reuses verified copies and excludes a subsequently opted-out source', async t => {
  const { parent, root, store } = setup(t)
  fs.mkdirSync(join(root, 'knowledge'))
  fs.writeFileSync(join(root, 'knowledge', '0000.md'), 'Existing safe note')
  const previous = await store.backup()
  const sessionId = 'staged-private-test'
  const source = saveSource(root, { role: 'user', sourceKind: 'user', sessionId, messageId: '1', text: '临时备用资料。' })
  for (let i = 1; i < 148; i += 1) fs.writeFileSync(join(root, 'knowledge', String(i).padStart(4, '0') + '.md'), 'Note ' + i)
  const script = [
    "import fs from 'node:fs';",
    "import { syncBuiltinESMExports } from 'node:module';",
    "import { sep } from 'node:path';",
    "const [root, module] = process.argv.slice(1), open = fs.openSync, sync = fs.fsync;",
    "const copies = new Set(); let count = 0;",
    "fs.openSync = (path, flags, ...args) => { const fd = open(path, flags, ...args);",
    "if (typeof path === 'string' && path.startsWith(root + sep + 'backups' + sep) && path.includes(sep + 'files' + sep) && flags === 'wx') copies.add(fd); return fd };",
    "const close = fs.closeSync; fs.closeSync = fd => { copies.delete(fd); return close(fd) };",
    "fs.fsync = (fd, callback) => sync(fd, error => { if (!error && copies.has(fd) && ++count === 129) process.exit(47); callback(error) });",
    "syncBuiltinESMExports(); await (await import(module)).createCompleteBackup(root);",
  ].join('\n')
  const stopped = spawnSync(process.execPath, ['--input-type=module', '-e', script, root,
    new URL('../host/backup.js', import.meta.url).href], { encoding: 'utf8', timeout: 30000 })
  assert.equal(stopped.status, 47, stopped.stderr)
  const backups = join(root, 'backups')
  const staged = fs.readdirSync(backups).find(name => name.endsWith('.tmp'))
  assert.ok(staged)
  assert.equal(fs.readdirSync(backups).filter(name => name.endsWith('.backup')).length, 1)
  const cached = join(backups, staged, 'files', 'knowledge')
  const keptInode = fs.statSync(join(cached, '0001.md')).ino
  fs.writeFileSync(join(cached, '0002.md'), 'Damaged staging copy')
  fs.writeFileSync(join(root, 'knowledge', '0003.md'), 'Updated during restart')
  writeTurnIntake(root, { id: turnIdOf({ sessionId, sourceIds: [source.id] }), sessionId, sourceIds: [source.id], status: 'skipped',
    reason: '明确要求不保存当前问答，已跳过提炼' })
  const maintenance = await runMaintenance({ store, now: 1700000001000, config: { retention: { episodeDays: 0 } } })
  assert.equal(maintenance.backupError, null)
  const next = maintenance.backedUp
  assert.ok(next)
  const verified = await verifyBackup(next)
  assert.equal(verified.version, 2)
  assert.ok(verified.files.every(file => !file.path.includes(source.id)))
  assert.equal(fs.existsSync(join(next, 'files', 'capture', 'sources', source.id + '.json.gz')), false)
  assert.equal(fs.readdirSync(backups).filter(name => name.endsWith('.tmp')).length, 0)
  if (process.platform !== 'win32') assert.equal(fs.statSync(join(next, 'files', 'knowledge', '0001.md')).ino, keptInode)
  assert.equal((await verifyBackup(previous)).version, 1)
  const restored = join(parent, 'restored-resumption')
  await restoreBackup(next, restored)
  assert.equal(fs.readFileSync(join(restored, 'knowledge', '0002.md'), 'utf8'), 'Note 2')
  assert.equal(fs.readFileSync(join(restored, 'knowledge', '0003.md'), 'utf8'), 'Updated during restart')
  assert.equal(fs.readdirSync(join(restored, 'knowledge')).length, 148)
  const manifest = JSON.parse(fs.readFileSync(join(next, 'manifest.json'), 'utf8'))
  fs.appendFileSync(join(next, 'manifest-parts', manifest.parts.at(-1).file), ' ')
  const refused = join(parent, 'refused-part-corruption')
  await assert.rejects(restoreBackup(next, refused), /分段/u)
  assert.equal(fs.existsSync(refused), false)
})

test('a concurrent backup writer cannot publish while the first writer owns its staging area', async t => {
  const { root, store } = setup(t)
  const other = new MemoryStore({ root }).open()
  const started = store.backup()
  try {
    await assert.rejects(other.backup(), error => error?.code === 'backup-in-progress')
  } finally {
    await started
  }
  assert.equal(fs.readdirSync(join(root, 'backups')).filter(name => name.endsWith('.backup')).length, 1)
})

function seedSmallSources(root, count) {
  const directory = join(root, 'capture', 'sources')
  fs.mkdirSync(directory, { recursive: true })
  for (let i = 0; i < count; ++i) {
    const id = 'src_' + i.toString(16).padStart(24, '0')
    fs.writeFileSync(join(directory, id + '.json'), JSON.stringify({
      id, sessionId: 'small-sources', role: 'user', sourceKind: 'user', projectKey: 'pack-alpha', text: '原话第 ' + i + ' 条。',
    }))
  }
}

test('large source backups pack small files and restore their exact contents and grants', async t => {
  const { parent, root, store } = setup(t)
  fs.writeFileSync(join(root, 'data-owner.json'), JSON.stringify({version:1, kind:'profile', identity:'a'.repeat(64)}))
  const source = saveSource(root, {
    role:'user', sourceKind:'user', projectKey:'pack-alpha', sessionId:'packed', messageId:'kept',
    text:'每周备份后的恢复原话要完整保留。'
  })
  assert.ok(grantSourceRecall(root, readSource(root, source.id), 'pack-alpha', { remembered: true }))
  const record = store.write({ scope:'project', projectKey:'pack-alpha', kind:'fact',
    content:'备份后检查可读性。', confidence:.95, sourceRefs:[{sourceId:source.id}] }).record
  seedSmallSources(root, 132)
  const largeId = 'src_' + 'f'.repeat(24)
  const large = JSON.stringify({ id:largeId, sessionId:'packed', text:'完整原文'.repeat(7000) })
  fs.writeFileSync(join(root, 'capture', 'sources', largeId + '.json'), large)
  const backup = await store.backup()
  const { version, files } = await verifyBackup(backup)
  assert.equal(version, 3)
  assert.ok(files.some(file => file.path === 'capture/sources/' + source.id + '.json.gz'))
  assert.equal(fs.existsSync(join(backup, 'files', 'capture', 'sources', source.id + '.json.gz')), false)
  assert.ok(fs.readdirSync(join(backup, 'payloads')).length > 1)
  assert.equal(fs.readFileSync(join(backup, 'files', 'capture', 'sources', largeId + '.json'), 'utf8'), large)
  const restored = join(parent, 'packed-restore')
  await restoreBackup(backup, restored)
  assert.equal(readSource(restored, source.id).text, readSource(root, source.id).text)
  assert.equal(hasSourceRecallGrant(restored, source.id, 'pack-alpha'), true)
  assert.equal(hasSourceRecallGrant(restored, source.id, 'pack-beta'), false)
  assert.equal(new MemoryStore({ root: restored }).open().find(record.id, [{scope:'project', projectKey:'pack-alpha'}]).content, record.content)

  const scope = {scope:'project', projectKey:'pack-alpha'}
  store.remove(record.id, [scope])
  const withRevocation = join(parent, 'packed-restore-with-current-revocation')
  await restoreBackup(backup, withRevocation, { currentRoot:root })
  assert.equal(new MemoryStore({ root:withRevocation }).open().find(record.id, [scope]).status, 'deleted')
  assert.equal(canReadSource(withRevocation, source.id), false)
  assert.equal(hasSourceRecallGrant(withRevocation, source.id, scope.projectKey), false)

  const payload = join(backup, 'payloads', fs.readdirSync(join(backup, 'payloads'))[0])
  const damaged = fs.readFileSync(payload)
  damaged[0] ^= 1
  fs.writeFileSync(payload, damaged)
  const wrong = join(parent, 'refused-packed-restore')
  await assert.rejects(restoreBackup(backup, wrong), /校验/u)
  assert.equal(fs.existsSync(wrong), false)
})

test('fast and compatible backups preserve the same files and restore packed Markdown', async t => {
  const { parent, root, store } = setup(t)
  seedSmallSources(root, 130)
  const knowledge = join(root, 'knowledge')
  fs.mkdirSync(knowledge, { recursive:true })
  const note = '---\ndsh_knowledge: true\nscope: global\n---\n# 备份原句\n\n需要完整保存。\n'
  for (let index = 0; index < 130; index++) fs.writeFileSync(join(knowledge, 'note-' + index + '.md'), note + index + '\n')
  fs.writeFileSync(join(knowledge, 'large.md'), note + '较长的记录。'.repeat(6000))
  const revoked = store.write({ scope:'global', kind:'fact', content:'已经遗忘的附属笔记。', confidence:0.9 }).record
  const removedNote = promoteMemoryToKnowledge(root, revoked).split(sep).at(-1)
  assert.ok(store.remove(revoked.id, [{ scope:'global' }]))

  const compatible = await store.backup('compatible'), fast = await store.backup('fast')
  const [legacyManifest, fastManifest] = await Promise.all([verifyBackup(compatible), verifyBackup(fast)])
  assert.equal(legacyManifest.version, 3)
  assert.equal(fastManifest.version, 4)
  assert.deepEqual(fastManifest.files, legacyManifest.files)
  assert.ok(fs.existsSync(join(compatible, 'files', 'knowledge', 'note-0.md')))
  assert.ok(!fs.existsSync(join(fast, 'files', 'knowledge', 'note-0.md')))
  assert.ok(fs.existsSync(join(fast, 'files', 'knowledge', 'large.md')))
  assert.ok(!fastManifest.files.some(row => row.path === 'knowledge/' + removedNote))
  const restored = join(parent, 'fast-knowledge-restored')
  await restoreBackup(fast, restored)
  for (const row of fastManifest.files) assert.deepEqual(fs.readFileSync(join(restored, row.path)), fs.readFileSync(join(root, row.path)))
})

test('same-format callers share a backup and a concurrent different format is reported busy', async t => {
  const { store } = setup(t)
  const started = store.backup('fast')
  try {
    assert.equal(store.backup('fast'), started)
    await assert.rejects(store.backup('compatible'), { code:'backup-in-progress' })
  } finally { await started }
})

test('maintenance resumes an interrupted fast backup independently of a compatible backup', async t => {
  const { root, store } = setup(t)
  const knowledge = join(root, 'knowledge')
  fs.mkdirSync(knowledge, { recursive:true })
  for (let index = 0; index < 132; index++) fs.writeFileSync(join(knowledge, 'indexed-' + index + '.md'), '测试知识笔记 ' + index)
  const fastParts = join(root, 'backups', '.dsh-memory-snapshot-fast.tmp', 'manifest-parts')
  const open = fs.openSync
  fs.openSync = (path, flags, ...args) => {
    if (flags === 'wx' && typeof path === 'string' && path.startsWith(join(fastParts, '00000001.json.'))) {
      throw Object.assign(new Error('synthetic full disk writing a fast checkpoint'), { code:'ENOSPC' })
    }
    return open(path, flags, ...args)
  }
  syncBuiltinESMExports()
  try { await assert.rejects(store.backup('fast'), { code:'ENOSPC' }) }
  finally { fs.openSync = open; syncBuiltinESMExports() }
  assert.ok(hasBackupCheckpoint(root, 'fast'))
  assert.equal(hasBackupCheckpoint(root), false)
  assert.equal((await verifyBackup(await store.backup('compatible'))).version, 2)
  assert.ok(hasBackupCheckpoint(root, 'fast'))
  const resumed = await runMaintenance({ store, now:1700000001000, config:{ retention:{ episodeDays:0 } } })
  const manifest = await verifyBackup(resumed.backedUp)
  assert.equal(manifest.version, 4)
  assert.equal(manifest.files.filter(row => row.path.startsWith('knowledge/')).length, 132)
  assert.equal(hasBackupCheckpoint(root, 'fast'), false)
})

test('packed data and its manifest parts flush through asynchronous fsync', async t => {
  const { root, store } = setup(t)
  seedSmallSources(root, 132)
  const open = fs.openSync, close = fs.closeSync, blocking = fs.fsyncSync, asyncSync = fs.fsync
  const files = new Map(), flushed = new Set(), blockingPaths = new Set()
  fs.openSync = (path, flags, ...args) => {
    const fd = open(path, flags, ...args)
    if (typeof path === 'string' && path.startsWith(join(root, 'backups') + sep)) {
      const group = path.split(sep).find(part => part === 'manifest-parts' || part === 'payloads')
      if (group) files.set(fd, path === join(root, 'backups', '.dsh-memory-snapshot.tmp', group) ? group : group + '/file')
    }
    return fd
  }
  fs.closeSync = fd => { files.delete(fd); return close(fd) }
  fs.fsyncSync = fd => {
    if (files.has(fd)) blockingPaths.add(files.get(fd))
    return blocking(fd)
  }
  fs.fsync = (fd, callback) => {
    if (files.has(fd)) flushed.add(files.get(fd))
    return asyncSync(fd, callback)
  }
  syncBuiltinESMExports()
  try { await store.backup() }
  finally {
    fs.openSync = open
    fs.closeSync = close
    fs.fsyncSync = blocking
    fs.fsync = asyncSync
    syncBuiltinESMExports()
  }
  assert.deepEqual([...blockingPaths], [])
  assert.ok(flushed.has('payloads/file') && flushed.has('manifest-parts/file'))
  if (process.platform !== 'win32') assert.ok(flushed.has('payloads') && flushed.has('manifest-parts'))
})

test('packed checkpoints resume after a writer exits before sealing the next part', async t => {
  const { parent, root, store } = setup(t)
  store.write({ scope:'global', kind:'fact', content:'这条原有记录必须继续可恢复。' })
  const earlier = await store.backup()
  seedSmallSources(root, 260)
  const id = 'src_' + (161).toString(16).padStart(24, '0')
  const intake = { id:turnIdOf({ sessionId:'small-sources', sourceIds:[id] }),
    sessionId:'small-sources', projectKey:'pack-alpha', sourceIds:[id] }
  writeTurnIntake(root, { ...intake, status:'done' })
  const module = new URL('../host/backup.js', import.meta.url).href
  const code = [
    "import fs from 'node:fs';",
    "import { syncBuiltinESMExports } from 'node:module';",
    "import { sep } from 'node:path';",
    "const [root, module] = process.argv.slice(1), rename = fs.renameSync; let written = 0;",
    "fs.renameSync = (from, to) => { const result = rename(from, to);",
    "if (to.includes(sep + 'payloads' + sep) && to.endsWith('.bin') && ++written === 2) process.exit(53); return result; };",
    "syncBuiltinESMExports(); await (await import(module)).createCompleteBackup(root);",
  ].join('\n')
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', code, root, module], { encoding:'utf8', timeout:30000 })
  assert.equal(child.status, 53, child.stderr)
  const stage = join(root, 'backups', '.dsh-memory-snapshot.tmp'), payloads = join(stage, 'payloads')
  assert.deepEqual(fs.readdirSync(join(stage, 'manifest-parts')), ['00000000.json'])
  await assert.rejects(verifyBackup(stage), { code:'ENOENT' })
  const names = fs.readdirSync(payloads)
  assert.equal(names.length, 2)
  const orphan = names.find(name => fs.readFileSync(join(payloads, name), 'utf8').includes(id))
  assert.ok(orphan)
  const sealed = names.find(name => name !== orphan), savedInode = fs.statSync(join(payloads, sealed)).ino
  writeTurnIntake(root, { ...intake, status:'skipped', noSave:true })

  const snapshot = await store.backup()
  assert.equal(fs.existsSync(stage), false)
  assert.equal(fs.existsSync(join(snapshot, 'payloads', orphan)), false)
  const reused = join(snapshot, 'payloads', sealed)
  assert.ok(fs.existsSync(reused))
  if (process.platform !== 'win32') assert.equal(fs.statSync(reused).ino, savedInode)
  const verified = await verifyBackup(snapshot)
  assert.equal(verified.version, 3)
  assert.ok(verified.files.every(file => !file.path.includes(id)))
  assert.ok((await verifyBackup(earlier)).files.length)
  const target = join(parent, 'resumed-packed-snapshot')
  await restoreBackup(snapshot, target)
  assert.equal(readSource(target, id), null)
  assert.equal(readSource(target, 'src_' + '0'.repeat(24)).text, '原话第 0 条。')
})

test('opt-out during packed backup publication clears the affected staged payload', async t => {
  const { root, store } = setup(t)
  const source = saveSource(root, { role:'user', sourceKind:'user', projectKey:'pack-alpha',
    sessionId:'pack-opt-out', messageId:'private', text:'这条原话在发布备份前被撤回。' })
  const previous = await store.backup()
  seedSmallSources(root, 132)
  const stage = join(root, 'backups', '.dsh-memory-snapshot.tmp'), payloads = join(stage, 'payloads')
  const rename = fs.renameSync
  let removed
  fs.renameSync = (from, to) => {
    const result = rename(from, to)
    if (to === join(stage, 'manifest.prepare.tmp')) {
      removed = fs.readdirSync(payloads).find(name => fs.readFileSync(join(payloads, name), 'utf8').includes(source.id))
      assert.ok(removed)
      writeTurnIntake(root, { id:turnIdOf({ sessionId:'pack-opt-out', sourceIds:[source.id] }),
        sessionId:'pack-opt-out', sourceIds:[source.id], projectKey:'pack-alpha', status:'skipped', noSave:true })
    }
    return result
  }
  syncBuiltinESMExports()
  try { await assert.rejects(store.backup(), { code:'backup-source-changed' }) }
  finally { fs.renameSync = rename; syncBuiltinESMExports() }
  assert.equal(fs.existsSync(join(payloads, removed)), false)
  assert.equal(fs.existsSync(join(stage, 'manifest.json')), false)
  assert.ok((await verifyBackup(previous)).files.length)
  const backup = await store.backup()
  assert.ok((await verifyBackup(backup)).files.every(file => !file.path.includes(source.id)))
  assert.ok(fs.readdirSync(join(backup, 'payloads')).every(name =>
    !fs.readFileSync(join(backup, 'payloads', name), 'utf8').includes(source.id)))
})

test('disk exhaustion between packed parts keeps the completed part and the last good backup', async t => {
  const { root, store } = setup(t)
  store.write({ scope:'global', kind:'fact', content:'磁盘不足时保留上一份已完成备份。' })
  const previous = await store.backup()
  seedSmallSources(root, 260)
  const stage = join(root, 'backups', '.dsh-memory-snapshot.tmp'), payloads = join(stage, 'payloads')
  const open = fs.openSync, close = fs.closeSync, flush = fs.fsync
  const outputs = new Set()
  let writes = 0
  fs.openSync = (path, flags, ...args) => {
    const fd = open(path, flags, ...args)
    if (flags === 'wx' && typeof path === 'string' && path.startsWith(payloads + sep)) outputs.add(fd)
    return fd
  }
  fs.closeSync = fd => { outputs.delete(fd); return close(fd) }
  fs.fsync = (fd, callback) => {
    if (outputs.has(fd) && ++writes === 2) {
      queueMicrotask(() => callback(Object.assign(new Error('synthetic full disk during packed backup flush'), { code:'ENOSPC' })))
    } else {
      flush(fd, callback)
    }
  }
  syncBuiltinESMExports()
  try { await assert.rejects(store.backup(), { code:'ENOSPC' }) }
  finally { fs.openSync = open; fs.closeSync = close; fs.fsync = flush; syncBuiltinESMExports() }
  assert.ok((await verifyBackup(previous)).files.length)
  assert.deepEqual(fs.readdirSync(join(stage, 'manifest-parts')), ['00000000.json'])
  const [file, ...others] = fs.readdirSync(payloads)
  assert.ok(file)
  assert.equal(others.length, 0)
  const inode = fs.statSync(join(payloads, file)).ino
  const backup = await store.backup()
  const manifest = await verifyBackup(backup)
  assert.equal(manifest.version, 3)
  assert.equal(manifest.files.filter(row => row.path.startsWith('capture/sources/')).length, 260)
  if (process.platform !== 'win32') assert.equal(fs.statSync(join(backup, 'payloads', file)).ino, inode)
})

test('new capture sources and journal entries stay outside an in-progress packed backup', async t => {
  const { parent, root, store } = setup(t)
  seedSmallSources(root, 132)
  const oldSource = 'src_' + '0'.repeat(24)
  const old = { id:turnIdOf({sessionId:'small-sources', sourceIds:[oldSource]}),
    sessionId:'small-sources', projectKey:'pack-alpha', sourceIds:[oldSource], status:'done' }
  writeTurnIntake(root, old)
  const prior = fs.readFileSync(join(root, 'capture', 'capture-turns.jsonl'))
  appendUsage(root, {kind:'extract', tokens:13, calls:1})
  const priorUsage = fs.readFileSync(join(root, USAGE_FILE))
  const rename = fs.renameSync
  let later
  fs.renameSync = (from, to) => {
    const result = rename(from, to)
    if (!later && to.endsWith('.bin') && to.includes(sep + 'payloads' + sep)) {
      later = saveSource(root, {role:'user', sourceKind:'user', projectKey:'pack-alpha',
        sessionId:'new-chat', messageId:'user', text:'新对话从备份时点之后开始。'})
      grantSourceRecall(root, readSource(root, later.id), 'pack-alpha')
      writeTurnIntake(root, {id:turnIdOf({sessionId:'new-chat', sourceIds:[later.id]}),
        sessionId:'new-chat', projectKey:'pack-alpha', sourceIds:[later.id], status:'done'})
      writeCaptureTask(root, {id:'cap_b23456789012345678901234', sourceIds:[later.id],
        sessionId:'new-chat', projectKey:'pack-alpha', status:'done', callState:'completed'})
      appendUsage(root, {kind:'extract', tokens:7, calls:1})
    }
    return result
  }
  syncBuiltinESMExports()
  let backup
  try { backup = await store.backup() }
  finally { fs.renameSync = rename; syncBuiltinESMExports() }
  assert.ok(later)
  assert.equal(hasSourceRecallGrant(root, later.id, 'pack-alpha'), true)
  const manifest = await verifyBackup(backup)
  assert.equal(manifest.version, 3)
  assert.ok(manifest.files.every(file => !file.path.includes(later.id) && !file.path.endsWith('capture-tasks.jsonl')))
  const target = join(parent, 'capture-cut')
  await restoreBackup(backup, target)
  assert.deepEqual(fs.readFileSync(join(target, 'capture', 'capture-turns.jsonl')), prior)
  assert.deepEqual(fs.readFileSync(join(target, USAGE_FILE)), priorUsage)
  assert.equal(readSource(target, later.id), null)
  assert.equal(readSource(target, oldSource).text, '原话第 0 条。')
})

test('a charge-state transition of an existing capture task invalidates a packed backup cut', async t => {
  const { root, store } = setup(t)
  const previous = await store.backup()
  seedSmallSources(root, 132)
  const entry = {id:'cap_a23456789012345678901234', sourceIds:['src_' + '0'.repeat(24)],
    sessionId:'small-sources', projectKey:'pack-alpha'}
  writeCaptureTask(root, {...entry, status:'pending', callState:'not-sent'})
  const rename = fs.renameSync
  let charged = false
  fs.renameSync = (from, to) => {
    const result = rename(from, to)
    if (!charged && to.endsWith('.bin') && to.includes(sep + 'payloads' + sep)) {
      writeCaptureTask(root, {...entry, status:'running', callState:'requested'})
      charged = true
    }
    return result
  }
  syncBuiltinESMExports()
  try { await assert.rejects(store.backup(), {code:'backup-source-changed'}) }
  finally { fs.renameSync = rename; syncBuiltinESMExports() }
  assert.equal(charged, true)
  assert.deepEqual(fs.readdirSync(join(root, 'backups')).filter(name => name.endsWith('.backup')), [previous.split(sep).at(-1)])
  assert.ok((await verifyBackup(previous)).files.length)
})

test('unreadable consent records prevent creating a new archive with unchecked originals', async t => {
  const { root, store } = setup(t)
  seedSmallSources(root, 132)
  const previous = await store.backup()
  fs.writeFileSync(join(root, 'capture', 'capture-turns.jsonl'), '{"id":"turn_damaged","noSave":true,\n')
  await assert.rejects(store.backup(), /禁存记录/u)
  assert.deepEqual(fs.readdirSync(join(root, 'backups')).filter(name => name.endsWith('.backup')), [previous.split(sep).at(-1)])
  assert.ok((await verifyBackup(previous)).files.length)
})

test('ordinary writes throughout a complete backup leave a coherent committed restore point', async t => {
  const { parent, root, store } = setup(t)
  const project = { scope: 'project', projectKey: 'ongoing-alpha' }
  const other = { scope: 'project', projectKey: 'ongoing-beta' }
  const saved = saveSource(root, { sessionId: 'archive-original', messageId: 'before', ...project,
    role: 'user', sourceKind: 'user', text: '备份开始前的原话保留全文。' })
  const old = store.write({ ...project, kind: 'fact', content: '备份开始前的甲项目记录。', sourceRefs: [{ sourceId: saved.id }] }).record
  const belongsToOther = store.write({ ...other, kind: 'fact', content: '同一份备份中乙项目的独立记录。' }).record
  const forgotten = store.write({ scope: 'global', kind: 'fact', content: '已经遗忘的历史条目。' }).record
  store.remove(forgotten.id)
  promoteMemoryToKnowledge(root, old)
  for (let n = 0; n < 132; n++) fs.writeFileSync(join(root, 'knowledge', `source-${n}.md`), `手稿第 ${n} 页。`)
  const writer = new MemoryStore({ root }).open()
  const appended = [], output = new Set(), open = fs.openSync, close = fs.closeSync, sync = fs.fsync
  let copied = 0
  fs.openSync = (file, flags, ...args) => {
    const fd = open(file, flags, ...args)
    if (flags === 'wx' && typeof file === 'string' && file.includes(`${sep}backups${sep}`) && file.includes(`${sep}files${sep}`)) output.add(fd)
    return fd
  }
  fs.closeSync = fd => { output.delete(fd); return close(fd) }
  fs.fsync = (fd, complete) => sync(fd, error => {
    if (!error && output.has(fd) && ++copied % 17 === 1 && appended.length < 7) {
      const result = writer.write({ ...(appended.length % 2 ? other : project), kind: 'fact', content: `备份读文件时提交的第 ${appended.length} 条。` })
      assert.ok(result.ok)
      appended.push(result.record)
    }
    complete(error)
  })
  syncBuiltinESMExports()
  let backup
  try { backup = await store.backup() }
  finally { fs.openSync = open; fs.closeSync = close; fs.fsync = sync; syncBuiltinESMExports() }
  assert.equal(appended.length, 7)
  const target = join(parent, 'restored-while-writing')
  await restoreBackup(backup, target)
  const restored = new MemoryStore({ root: target }).open()
  assert.equal(restored.find(old.id, [project]).content, old.content)
  assert.equal(restored.find(belongsToOther.id, [other]).content, belongsToOther.content)
  assert.equal(restored.find(belongsToOther.id, [project]), undefined)
  assert.equal(restored.find(forgotten.id).status, 'deleted')
  assert.deepEqual(fs.readFileSync(join(target, 'capture', 'sources', `${saved.id}.json.gz`)),
    fs.readFileSync(join(root, 'capture', 'sources', `${saved.id}.json.gz`)))
  for (const row of appended) {
    assert.equal(restored.find(row.id, [project, other]), undefined)
    assert.equal(writer.find(row.id, [project, other]).content, row.content)
  }
})

test('forget and opt-out at backup publication prevent an older copy from being sealed', async t => {
  for (const action of ['forget', 'opt-out']) await t.test(action, async part => {
    const { root, store } = setup(part)
    const project = { scope: 'project', projectKey: 'last-minute-revocation' }
    const original = saveSource(root, { sessionId: 'before-publish', messageId: 'raw', ...project,
      role: 'user', sourceKind: 'user', text: '准备发布备份时撤回的原话。' })
    const record = store.write({ ...project, kind: 'fact', content: '用于测试备份发布边界的旧条目。' }).record
    const before = await store.backup()
    fs.mkdirSync(join(root, 'knowledge'))
    for (let n = 0; n < 132; n++) fs.writeFileSync(join(root, 'knowledge', `page-${n}.md`), `作者笔记 ${n}`)
    const backups = join(root, 'backups'), stage = join(backups, '.dsh-memory-snapshot.tmp')
    const manifest = join(stage, 'manifest.prepare.tmp'), rename = fs.renameSync
    const writer = new MemoryStore({ root }).open()
    let revoked = false
    fs.renameSync = (source, target) => {
      const result = rename(source, target)
      if (target === manifest && !revoked) {
        revoked = true
        if (action === 'forget') writer.remove(record.id, [project])
        else writeTurnIntake(root, { id: turnIdOf({ sessionId: 'before-publish', sourceIds: [original.id] }),
          sessionId: 'before-publish', projectKey: project.projectKey, sourceIds: [original.id], status: 'skipped', noSave: true })
      }
      return result
    }
    syncBuiltinESMExports()
    try { await assert.rejects(store.backup(), { code: 'backup-source-changed' }) }
    finally { fs.renameSync = rename; syncBuiltinESMExports() }
    assert.ok(revoked)
    assert.equal(fs.readdirSync(backups).filter(name => name.endsWith('.backup')).length, 1)
    assert.equal((await verifyBackup(before)).version, 1)
    assert.ok(fs.existsSync(join(stage, 'files', 'knowledge', 'page-0.md')))
    assert.equal(fs.existsSync(join(stage, 'manifest.json')), false)
    assert.equal(fs.existsSync(join(stage, 'files', 'projects', project.projectKey, 'memories.jsonl')), false)
    const retry = await verifyBackup(await store.backup())
    assert.equal(retry.version, 2)
    if (action === 'opt-out') assert.ok(retry.files.every(file => !file.path.includes(original.id)))
    else assert.equal(writer.find(record.id, [project]).status, 'deleted')
  })
})

test('a crash before the authority seal leaves no recoverable manifest', async t => {
  const { root, store } = setup(t)
  store.write({ scope: 'global', kind: 'fact', content: '已经提交的数据仍可在重试后备份。' })
  const program = [
    "import fs from 'node:fs';",
    "import { syncBuiltinESMExports } from 'node:module';",
    "import { basename } from 'node:path';",
    "const [root, module] = process.argv.slice(1), rename = fs.renameSync;",
    "fs.renameSync = (from, to) => { const result = rename(from, to);",
    "if (basename(to) === 'manifest.prepare.tmp') process.exit(49); return result; };",
    "syncBuiltinESMExports(); await (await import(module)).createCompleteBackup(root);",
  ].join('\n')
  const interrupted = spawnSync(process.execPath, ['--input-type=module', '-e', program, root,
    new URL('../host/backup.js', import.meta.url).href], { encoding: 'utf8', timeout: 30000 })
  assert.equal(interrupted.status, 49, interrupted.stderr)
  const stage = join(root, 'backups', '.dsh-memory-snapshot.tmp')
  assert.ok(fs.existsSync(join(stage, 'manifest.prepare.tmp')))
  await assert.rejects(verifyBackup(stage), { code: 'ENOENT' })
  assert.equal((await verifyBackup(await store.backup())).files.length >= 2, true)
})

test('disk exhaustion in the actual snapshot writer preserves a usable previous backup', async t => {
  const { parent, root, store } = setup(t)
  fs.mkdirSync(join(root, 'knowledge'))
  const note = join(root, 'knowledge', 'daily.md')
  fs.writeFileSync(note, 'Earlier version of this note')
  const previous = await store.backup()
  fs.writeFileSync(note, 'Recent version of this note')
  const open = fs.openSync
  let failed = false
  fs.openSync = (path, flags, ...args) => {
    if (typeof path === 'string' && path.startsWith(join(root, 'backups') + sep) &&
        path.endsWith('daily.md') && flags === 'wx') {
      failed = true
      throw Object.assign(new Error('synthetic ENOSPC'), { code: 'ENOSPC' })
    }
    return open(path, flags, ...args)
  }
  syncBuiltinESMExports()
  try { await assert.rejects(store.backup(), error => error?.code === 'ENOSPC') }
  finally { fs.openSync = open; syncBuiltinESMExports() }
  assert.equal(failed, true)
  assert.equal(fs.readdirSync(join(root, 'backups')).filter(name => name.endsWith('.backup')).length, 1)
  const restored = join(parent, 'old-backup-after-enospc')
  await restoreBackup(previous, restored)
  assert.equal(fs.readFileSync(join(restored, 'knowledge', 'daily.md'), 'utf8'), 'Earlier version of this note')
  const next = await store.backup()
  assert.equal(fs.readFileSync(join(next, 'files', 'knowledge', 'daily.md'), 'utf8'), 'Recent version of this note')
})

test('an interrupted restore reuses flushed files and repairs a changed staged file', async t => {
  const { parent, root, store } = setup(t)
  const notes = join(root, 'knowledge')
  fs.mkdirSync(notes)
  const note = index => `恢复续跑校验第 ${index} 份笔记。`
  for (let index = 0; index < 6; index++) fs.writeFileSync(join(notes, `note-${index}.md`), note(index))
  const backup = await store.backup()
  const target = join(parent, 'resumed')
  const program = [
    "import fs from 'node:fs';",
    "import { syncBuiltinESMExports } from 'node:module';",
    "const [backup, target, module] = process.argv.slice(1), open = fs.openSync, close = fs.closeSync, flush = fs.fsync;",
    "const pending = new Map();",
    "fs.openSync = (path, flags, ...args) => { const fd = open(path, flags, ...args); if (flags === 'wx') pending.set(fd, path); return fd; };",
    "fs.closeSync = fd => { pending.delete(fd); return close(fd); };",
    "fs.fsync = (fd, done) => flush(fd, error => { const path = pending.get(fd);",
    "if (!error && path && fs.readFileSync(path, 'utf8') === '恢复续跑校验第 3 份笔记。') process.exit(57); done(error); });",
    "syncBuiltinESMExports(); await (await import(module)).restoreBackup(backup, target);",
  ].join('\n')
  const interrupted = spawnSync(process.execPath, ['--input-type=module', '-e', program, backup, target,
    new URL('../host/backup.js', import.meta.url).href], { encoding: 'utf8', timeout: 30000 })
  assert.equal(interrupted.status, 57, interrupted.stderr)
  assert.equal(fs.existsSync(target), false)
  const workspaces = fs.readdirSync(parent).filter(name => name.startsWith('.memory-restore-') && name.endsWith('.tmp'))
  assert.equal(workspaces.length, 1)
  const work = join(parent, workspaces[0])
  const stagedNotes = fs.existsSync(join(work, 'files', 'knowledge'))
    ? join(work, 'files', 'knowledge') : join(work, 'knowledge')
  assert.equal(fs.readFileSync(join(stagedNotes, 'note-0.md'), 'utf8'), note(0))
  fs.writeFileSync(join(stagedNotes, 'note-1.md'), '损坏的暂存内容。')
  fs.writeFileSync(join(stagedNotes, 'not-in-backup.md'), '恢复目录不应包含额外文件。')

  const pending = new Map(), rewritten = []
  const open = fs.openSync, close = fs.closeSync, flush = fs.fsync
  fs.openSync = (path, flags, ...args) => {
    const fd = open(path, flags, ...args)
    if (flags === 'wx') pending.set(fd, path)
    return fd
  }
  fs.closeSync = fd => { pending.delete(fd); return close(fd) }
  fs.fsync = (fd, done) => flush(fd, error => {
    const path = pending.get(fd)
    if (!error && path) {
      const match = /^恢复续跑校验第 (\d+) 份笔记。$/u.exec(fs.readFileSync(path, 'utf8'))
      if (match) rewritten.push(Number(match[1]))
    }
    done(error)
  })
  syncBuiltinESMExports()
  let report
  try { report = await restoreBackup(backup, target) }
  finally { fs.openSync = open; fs.closeSync = close; fs.fsync = flush; syncBuiltinESMExports() }

  assert.equal(report.reusedFiles, 2)
  assert.deepEqual(rewritten, [1, 3, 4, 5])
  assert.deepEqual(fs.readdirSync(join(target, 'knowledge')).sort(), Array.from({ length: 6 }, (_, i) => `note-${i}.md`))
  for (let index = 0; index < 6; index++) assert.equal(fs.readFileSync(join(target, 'knowledge', `note-${index}.md`), 'utf8'), note(index))
  assert.ok(!fs.readdirSync(parent).some(name => name.startsWith('.memory-restore-')))
})

test('a full disk leaves a checkpoint and only one writer can restore to the same target', async t => {
  const { root, store, parent } = setup(t)
  const notes = join(root, 'knowledge')
  const target = join(parent, 'restored-after-enospc')
  fs.mkdirSync(notes)
  fs.writeFileSync(join(notes, 'a.md'), '旧备份中的第一份笔记。')
  fs.writeFileSync(join(notes, 'b.md'), '新备份不会包含这份笔记。')
  const initial = await store.backup()
  const originalRename = fs.renameSync
  let rejectedConcurrent = false
  fs.renameSync = (from, to) => {
    if (to.endsWith(sep + 'b.md') && to.includes(sep + '.memory-restore-')) {
      const other = spawnSync(process.execPath, ['--input-type=module', '-e', [
        'try { await (await import(process.argv[3])).restoreBackup(process.argv[1], process.argv[2]); }',
        'catch (error) { process.stdout.write(String(error.code)); }',
      ].join('\n'), initial, target, new URL('../host/backup.js', import.meta.url).href], { encoding: 'utf8', timeout: 10000 })
      assert.equal(other.status, 0, other.stderr)
      assert.equal(other.stdout, 'restore-in-progress')
      rejectedConcurrent = true
      throw Object.assign(new Error('synthetic full disk'), { code: 'ENOSPC' })
    }
    return originalRename(from, to)
  }
  syncBuiltinESMExports()
  try { await assert.rejects(restoreBackup(initial, target), { code: 'ENOSPC' }) }
  finally { fs.renameSync = originalRename; syncBuiltinESMExports() }
  assert.ok(rejectedConcurrent)
  assert.equal(fs.existsSync(target), false)
  const partial = fs.readdirSync(parent).filter(name => name.startsWith('.memory-restore-') && name.endsWith('.tmp'))
  assert.equal(partial.length, 1)
  assert.equal(fs.readFileSync(join(parent, partial[0], 'files', 'knowledge', 'a.md'), 'utf8'), '旧备份中的第一份笔记。')

  fs.writeFileSync(join(notes, 'a.md'), '另一份备份的有效版本。')
  fs.unlinkSync(join(notes, 'b.md'))
  await restoreBackup(await store.backup(), target)
  assert.deepEqual(fs.readdirSync(join(target, 'knowledge')), ['a.md'])
  assert.equal(fs.readFileSync(join(target, 'knowledge', 'a.md'), 'utf8'), '另一份备份的有效版本。')
  assert.equal(fs.existsSync(join(parent, partial[0])), false)
})

test('a resumed restore checks revocations from a second writer before publication', async t => {
  const { root, store, parent } = setup(t)
  fs.writeFileSync(join(root, 'data-owner.json'), JSON.stringify({ version: 1, kind: 'profile', identity: 'a'.repeat(64) }))
  const scope = { scope: 'project', projectKey: 'resumed-restore-project' }
  const other = { scope: 'project', projectKey: 'resumed-restore-other' }
  const source = saveSource(root, { projectKey: scope.projectKey, sessionId: 'restore', messageId: 'old', role: 'user',
    sourceKind: 'user', text: '稍后会被遗忘的原话。' })
  assert.ok(grantSourceRecall(root, readSource(root, source.id), scope.projectKey))
  const forgotten = store.write({ ...scope, kind: 'fact', content: '这条记忆会在恢复时被遗忘。',
    sourceRefs: [{ sourceId: source.id }], confidence: .95 }).record
  const retained = store.write({ ...other, kind: 'fact', content: '另一个项目的资料保持有效。', confidence: .95 }).record
  promoteMemoryToKnowledge(root, forgotten)
  fs.writeFileSync(join(root, 'knowledge', 'zz-restore-checkpoint.md'), '手写笔记保持完整。')
  const backup = await store.backup()
  const target = join(parent, 'restore-through-revocation')

  const rename = fs.renameSync
  let duringRestore = false, wroteRevocation = false
  fs.renameSync = (from, to) => {
    if (to.endsWith(sep + 'zz-restore-checkpoint.md') && to.includes(sep + '.memory-restore-')) {
      if (!duringRestore) throw Object.assign(new Error('synthetic full disk'), { code: 'ENOSPC' })
      const writer = spawnSync(process.execPath, ['--input-type=module', '-e', [
        "const [root, id, projectKey, module] = process.argv.slice(1);",
        "const { MemoryStore } = await import(module);",
        "const result = new MemoryStore({ root }).open().remove(id, [{ scope: 'project', projectKey }]);",
        "process.stdout.write(String(result.status));",
      ].join('\n'), root, forgotten.id, scope.projectKey,
      new URL('../host/store.js', import.meta.url).href], { encoding: 'utf8', timeout: 10000 })
      assert.equal(writer.status, 0, writer.stderr)
      assert.equal(writer.stdout, 'deleted')
      wroteRevocation = true
    }
    return rename(from, to)
  }
  syncBuiltinESMExports()
  try {
    await assert.rejects(restoreBackup(backup, target, { currentRoot: root }), { code: 'ENOSPC' })
    assert.equal(fs.existsSync(target), false)
    duringRestore = true
    await restoreBackup(backup, target, { currentRoot: root })
  } finally { fs.renameSync = rename; syncBuiltinESMExports() }

  assert.ok(wroteRevocation)
  const reopened = new MemoryStore({ root: target }).open()
  assert.equal(reopened.find(forgotten.id, [scope]).status, 'deleted')
  assert.equal(reopened.find(retained.id, [other]).status, 'active')
  assert.equal(canReadSource(target, source.id), false)
  assert.equal(hasSourceRecallGrant(target, source.id, scope.projectKey), false)
  assert.equal(fs.existsSync(join(target, 'knowledge', forgotten.id + '.md')), false)
  assert.equal(fs.readFileSync(join(target, 'knowledge', 'zz-restore-checkpoint.md'), 'utf8'), '手写笔记保持完整。')
  const reports = join(target, 'recall-reports')
  assert.ok(!fs.readdirSync(reports).some(name => /^[a-f0-9]{64}\.json$/u.test(name)))
  const invalidated = JSON.parse(fs.readFileSync(join(reports, 'invalidated-references.json'), 'utf8'))
  assert.ok(invalidated.sourceIds.includes(source.id))
  assert.ok(invalidated.recordThrough.some(entry => entry.id === forgotten.id && entry.projectKey === scope.projectKey))
})

test('Windows restore publishes to an absent target and preserves a target that wins the race', async t => {
  const { parent, store } = setup(t)
  const backup = await store.backup()
  const { restoreBackup } = await import('../host/backup.js')
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform'), originalRename = fs.renameSync
  Object.defineProperty(process, 'platform', { ...originalPlatform, value: 'win32' })
  const restored = join(parent, 'windows-restored')
  let published = 0
  fs.renameSync = (source, destination, ...args) => {
    if (destination === restored) {
      published += 1
      assert.equal(fs.existsSync(destination), false, 'Windows rename must receive a destination that is still absent')
    }
    return originalRename(source, destination, ...args)
  }
  syncBuiltinESMExports()
  try { await restoreBackup(backup, restored) }
  finally {
    fs.renameSync = originalRename
    syncBuiltinESMExports()
    Object.defineProperty(process, 'platform', originalPlatform)
  }
  assert.equal(published, 1)
  assert.ok(fs.statSync(restored).isDirectory())

  const raceTarget = join(parent, 'windows-race-target'), ownerFile = join(raceTarget, 'owner.txt')
  const racePlatform = Object.getOwnPropertyDescriptor(process, 'platform'), raceRename = fs.renameSync
  Object.defineProperty(process, 'platform', { ...racePlatform, value: 'win32' })
  let raced = false
  fs.renameSync = (source, destination, ...args) => {
    if (destination === raceTarget) {
      raced = true
      assert.equal(fs.existsSync(destination), false, 'restore must not reserve the target before publishing')
      fs.mkdirSync(destination)
      fs.writeFileSync(ownerFile, 'created by another process')
      throw Object.assign(new Error('destination appeared during rename'), { code: 'EPERM' })
    }
    return raceRename(source, destination, ...args)
  }
  syncBuiltinESMExports()
  try { await assert.rejects(restoreBackup(backup, raceTarget), error => error.code === 'EPERM') }
  finally {
    fs.renameSync = raceRename
    syncBuiltinESMExports()
    Object.defineProperty(process, 'platform', racePlatform)
  }
  assert.equal(raced, true)
  assert.equal(fs.readFileSync(ownerFile, 'utf8'), 'created by another process')
})

test('corrupt snapshots and linked authority files cannot be restored', async t => {
  const { parent, root, store } = setup(t)
  store.write({ kind: 'fact', scope: 'global', content: '校验失败不能写入恢复目录。' })
  const backup = await store.backup()
  assert.ok(fs.statSync(backup).isDirectory())
  const { restoreBackup } = await import('../host/backup.js')
  fs.appendFileSync(join(backup, 'files', 'global', 'memories.jsonl'), 'corrupt')
  const target = join(parent, 'refused')
  await assert.rejects(async () => restoreBackup(backup, target), /校验/u)
  assert.equal(fs.existsSync(target), false)
  fs.mkdirSync(join(root, 'knowledge')); fs.symlinkSync('/etc/hosts', join(root, 'knowledge', 'linked.md'))
  await assert.rejects(async () => store.backup(), /链接/u)
  assert.equal(fs.readdirSync(join(root, 'backups')).filter(n => n.endsWith('.backup')).length, 1)
})

test('large source backups allow the host event loop to run and reject a changing source set', async t => {
  const { root, store } = setup(t)
  fs.mkdirSync(join(root, 'knowledge'))
  const note = join(root, 'knowledge', 'large.md')
  fs.writeFileSync(note, '完整知识原文。'.repeat(400_000))
  let progressed = false
  const timer = setImmediate(() => { progressed = true; fs.appendFileSync(note, '并发修改') })
  try { await assert.rejects(async () => store.backup(), /变化/u) }
  finally { clearImmediate(timer) }
  assert.equal(progressed, true)
  assert.equal(fs.readdirSync(join(root, 'backups')).length, 0)
})

test('the packaged recovery CLI restores a verified snapshot and rejects a traversal manifest', async t => {
  const { parent, store } = setup(t)
  store.write({ kind: 'fact', scope: 'global', content: '离线恢复工具必须实际可运行。' })
  const backup = await store.backup(), target = join(parent, 'cli-restored')
  const cli = fileURLToPath(new URL('../host/recovery-cli.js', import.meta.url))
  for (const args of [['verify', backup], ['restore', backup, target]]) {
    const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    assert.ok(JSON.parse(result.stdout).files > 0)
  }
  assert.equal(new MemoryStore({ root: target }).open().listAll().length, 1)
  const file = join(backup, 'manifest.json'), manifest = JSON.parse(fs.readFileSync(file, 'utf8'))
  manifest.files[0].path = '../outside'
  fs.writeFileSync(file, JSON.stringify(manifest))
  const { restoreBackup } = await import('../host/backup.js')
  await assert.rejects(restoreBackup(backup, join(parent, 'refused')), /校验/u)
  assert.equal(fs.existsSync(join(parent, 'refused')), false)
})
