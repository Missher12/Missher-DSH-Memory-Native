import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Worker } from 'node:worker_threads'
import { prepareStorage } from '../host/storage-boundary.js'
import { createLocalSharingService } from '../host/local-sharing.js'
import { saveSource } from '../host/capture-journal.js'
import { grantSourceRecall } from '../host/source-passages.js'
import { projectIdentity } from '../host/paths.js'
import { handleClaudeHook, handleCodexHook } from '../host/local-sharing-hooks.js'
import { dispatchMcpRequest } from '../host/local-sharing-mcp.js'

const PROJECT_A = 'same-topic-a'
const PROJECT_B = 'same-topic-b'

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-memory-local-sharing-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const owner = prepareStorage({ get() {} }, { dataDir: root })
  return { root, owner }
}

function waitForMessage(worker, type) {
  return new Promise((resolve, reject) => {
    const onMessage = message => {
      if (message.type === type) { worker.off('message', onMessage); resolve(message) }
      else if (message.type.endsWith('-error')) { worker.off('message', onMessage); reject(new Error(message.error)) }
    }
    worker.on('message', onMessage)
    worker.once('error', reject)
  })
}

test('explicit cross-client remember is idempotent, evidence-bound and project-private', t => {
  const { root, owner } = fixture(t)
  const a = createLocalSharingService({ root, profileIdentity: owner.identity, projectKey: PROJECT_A })
  const b = createLocalSharingService({ root, profileIdentity: owner.identity, projectKey: PROJECT_B })
  t.after(() => { a.close(); b.close() })
  const input = { client: 'claude-code', sessionId: 'session-a', messageId: 'message-1',
    text: '请记住：晨弧快照每天 03:18，保留 47 天，改时间为了避开每日导入的磁盘峰值。' }
  const first = a.remember(input)
  const retry = a.remember(input)
  assert.equal(retry.id, first.id)
  assert.equal(retry.revision, first.revision)
  assert.match(first.content, /03:18.*47 天.*磁盘峰值/u)

  const result = a.search('晨弧快照 03:18 47 天 磁盘峰值')
  assert.ok(result.hits.some(hit => hit.id === first.id && hit.revision === first.revision))
  assert.equal(b.search('晨弧快照 03:18 47 天 磁盘峰值').hits.some(hit => hit.id === first.id), false)
  assert.equal(a.scenes().some(scene => scene.records.some(record => record.id === first.id)), true)
})

test('a long explicit remember saves the full L0 original and idempotent segmented L1 records', t => {
  const { root, owner } = fixture(t)
  const service = createLocalSharingService({ root, profileIdentity: owner.identity, projectKey: PROJECT_A })
  t.after(() => service.close())
  const memo = `请记住：晨弧快照每天 03:18，保留 47 天，改时间为了避开每日导入的磁盘峰值。${'这条规则保留完整原文并按连续分段写入 L1。'.repeat(180)}`
  const input = { client: 'claude-code', sessionId: 'long-session', messageId: 'long-message', text: memo }
  const first = service.remember(input)
  const retry = service.remember(input)
  assert.ok(first.records.length > 1)
  assert.equal(first.records.map(item => item.content).join(''), memo.slice(memo.indexOf('晨弧快照')))
  assert.deepEqual(retry.records.map(item => [item.id, item.revision]), first.records.map(item => [item.id, item.revision]))
  assert.equal(service.search('每日导入的磁盘峰值', PROJECT_A, 50).hits.some(hit => hit.kind === 'source'), true)
  assert.ok(service.search('磁盘峰值', PROJECT_A, 50).hits.length > 0)
})

test('forgetting a remembered source revokes the record and cross-client report evidence', t => {
  const { root, owner } = fixture(t)
  const service = createLocalSharingService({ root, profileIdentity: owner.identity, projectKey: PROJECT_A })
  t.after(() => service.close())
  const saved = service.remember({ client: 'codex', sessionId: 'session-a', messageId: 'message-2',
    text: '记住：计划备份每周五进行。' })
  const hit = service.search('计划备份 每周五').hits.find(item => item.id === saved.id)
  assert.ok(hit)
  service.reports.write('codex:session-a', PROJECT_A, {
    at: Date.now(), projectKey: PROJECT_A, turnKey: 'id:test', outcome: 'completed', total: 1,
    questions: [{ query: '计划备份时间', hits: [{ id: saved.id, revision: saved.revision, sourceRefs: hit.sourceRefs }],
      injected: [{ id: saved.id, revision: saved.revision, sourceRefs: hit.sourceRefs, text: saved.content }],
      notInjected: [], answerCoverage: 'covered', answerExcerpt: '每周五' }],
  })
  service.forget(saved.id)
  assert.equal(service.search('计划备份 每周五').hits.some(item => item.id === saved.id), false)
  assert.deepEqual(service.reports.listRecent(PROJECT_A), [])
})

test('project bindings reject attempts to read or mutate a different project', t => {
  const { root, owner } = fixture(t)
  const service = createLocalSharingService({ root, profileIdentity: owner.identity, projectKey: PROJECT_A })
  t.after(() => service.close())
  assert.throws(() => service.search('secret', PROJECT_B), /bound project/u)
  assert.throws(() => service.forget('mem_missing', PROJECT_B), /bound project/u)
})

test('Claude and Codex reject lexical evidence for a different attribute', async t => {
  const { root, owner } = fixture(t)
  const cwd = join(root, 'gateway')
  mkdirSync(cwd)
  const key = projectIdentity(cwd).key
  const service = createLocalSharingService({ root, profileIdentity: owner.identity, projectKey: key })
  t.after(() => service.close())
  service.remember({ client: 'codex', sessionId: 'record', messageId: 'test-port',
    text: '记住：网关监听端口是 4731。' })
  for (const [client, hook] of [['codex', handleCodexHook], ['claude-code', handleClaudeHook]]) {
    const base = { hook_event_name: 'UserPromptSubmit', cwd, session_id: 'attribute',
      turn_id: 'missing', prompt_id: 'missing' }
    const ask = input => hook({ service, root, input: { ...base, ...input } })
    assert.deepEqual(await ask({ prompt: '网关请求超时是多少？' }), {})
    const missing = service.reports.get(`${client}:attribute`, key)
    assert.equal(missing.covered.length, 0)
    assert.equal(missing.missing.length, 1)
    const positive = await ask({ turn_id: 'present', prompt_id: 'present', prompt: '网关监听端口是多少？' })
    assert.match(positive.hookSpecificOutput.additionalContext, /4731/u)
  }
})

test('a directory alias shares its real project and retargeting the alias cannot leak the old project', async t => {
  const { root, owner } = fixture(t)
  const original = join(root, 'work'), alias = join(root, 'shortcut'), isolated = join(root, 'other')
  mkdirSync(original)
  mkdirSync(isolated)
  symlinkSync(original, alias, 'junction')
  const key = projectIdentity(original).key
  const service = createLocalSharingService({ root, profileIdentity: owner.identity, projectKey: key })
  t.after(() => service.close())
  const hook = input => handleCodexHook({ service, root, input: { cwd: alias, hook_event_name: 'UserPromptSubmit',
    session_id: 'path-alias', turn_id: 'remember', ...input } })
  await hook({ prompt: '记住：网关监听端口是 4731。' })
  const readUsingRealPath = await hook({ cwd: original, turn_id: 'recall', prompt: '网关监听端口是多少？' })
  assert.match(readUsingRealPath.hookSpecificOutput.additionalContext, /4731/u)
  rmSync(alias)
  symlinkSync(isolated, alias, 'junction')
  await assert.rejects(hook({ turn_id: 'unrelated', prompt: '网关监听端口是多少？' }), /project binding/u)
})

test('the project directory includes authorized L0-only projects without reading source bodies', t => {
  const { root, owner } = fixture(t)
  const text = '记住：这个项目使用晨弧快照。'
  const metadata = saveSource(root, { sessionId: 'dsh:session', messageId: 'message-l0', role: 'user',
    sourceKind: 'user', projectKey: PROJECT_B, text })
  assert.equal(grantSourceRecall(root, { ...metadata, projectKey: PROJECT_B, role: 'user', sourceKind: 'user', text }, PROJECT_B,
    { remembered: true }), true)
  const service = createLocalSharingService({ root, profileIdentity: owner.identity })
  t.after(() => service.close())
  assert.ok(service.projects().includes(PROJECT_B))
})

test('Claude user and stop hooks split compound questions and assess each answer against injected evidence', async t => {
  const { root, owner } = fixture(t)
  const workdir = join(root, 'workspace-a')
  mkdirSync(workdir)
  const key = projectIdentity(workdir).key
  const service = createLocalSharingService({ root, profileIdentity: owner.identity, projectKey: key })
  t.after(() => service.close())
  service.remember({ client: 'codex', sessionId: 'prior', messageId: 'prior-1', requestedProjectKey: key,
    text: '记住：晨弧快照每天 03:18，保留 47 天，改时间为了避开每日导入的磁盘峰值。' })

  const input = { hook_event_name: 'UserPromptSubmit', cwd: workdir, session_id: 'claude-1', prompt_id: 'prompt-1',
    prompt: '晨弧快照几点、保留多久、改时间为了什么？' }
  const injected = await handleClaudeHook({ service, root, input })
  assert.match(injected.hookSpecificOutput.additionalContext, /03:18.*47 天/u)
  const pending = service.reports.get('claude-code:claude-1', key)
  assert.equal(pending.outcome, 'pending')
  assert.equal(pending.total, 3)
  assert.deepEqual(pending.questions.map(question => question.detail), ['clock', 'retention', 'reason'])
  assert.ok(pending.questions.every(question => question.injected.length > 0))

  await handleClaudeHook({ service, root, input: { ...input, hook_event_name: 'Stop', last_assistant_message:
    '每天 03:18。\n保留 47 天。\n改时间是为了避开每日导入的磁盘峰值。' } })
  const completed = service.reports.get('claude-code:claude-1', key)
  assert.deepEqual(completed.questions.map(question => question.answerCoverage), ['covered', 'covered', 'covered'])
  assert.deepEqual(completed.questions.map(question => question.answerExcerpt), [
    '每天 03:18。', '保留 47 天。', '改时间是为了避开每日导入的磁盘峰值。',
  ])
})

test('forgetting evidence while a hook report is pending prevents Stop from restoring it', async t => {
  const { root, owner } = fixture(t)
  const workdir = join(root, 'workspace-a')
  mkdirSync(workdir)
  const key = projectIdentity(workdir).key
  const service = createLocalSharingService({ root, profileIdentity: owner.identity, projectKey: key })
  t.after(() => service.close())
  const saved = service.remember({ client: 'codex', sessionId: 'prior', messageId: 'prior-1', requestedProjectKey: key,
    text: '记住：晨弧快照每天 03:18，保留 47 天。' })
  const input = { hook_event_name: 'UserPromptSubmit', cwd: workdir, session_id: 'claude-forget', prompt_id: 'prompt-forget',
    prompt: '晨弧快照几点运行？' }
  await handleClaudeHook({ service, root, input })
  assert.equal(service.reports.get('claude-code:claude-forget', key).outcome, 'pending')
  assert.equal(existsSync(join(root, '.local-sharing', 'pending-turns')), false)
  service.forget(saved.id, key)
  await handleClaudeHook({ service, root, input: { ...input, hook_event_name: 'Stop', last_assistant_message: '每天 03:18。' } })
  assert.equal(service.reports.get('claude-code:claude-forget', key), null)
})

test('a bare remember command binds only to the preceding real user prompt in the same client session', async t => {
  const { root, owner } = fixture(t)
  const workdir = join(root, 'workspace-a')
  mkdirSync(workdir)
  const key = projectIdentity(workdir).key
  const service = createLocalSharingService({ root, profileIdentity: owner.identity, projectKey: key })
  t.after(() => service.close())
  await handleCodexHook({ service, root, input: { hook_event_name: 'UserPromptSubmit', cwd: workdir, session_id: 'codex-bare',
    turn_id: 'turn-source', prompt: '晨弧备份每周五执行，保留 30 天。', model: 'test', permission_mode: 'default', transcript_path: null } })
  await handleCodexHook({ service, root, input: { hook_event_name: 'UserPromptSubmit', cwd: workdir, session_id: 'codex-bare',
    turn_id: 'turn-remember', prompt: '记住', model: 'test', permission_mode: 'default', transcript_path: null } })
  const result = service.search('晨弧备份 每周五 30 天', key, 50)
  const saved = result.hits.find(hit => hit.kind !== 'source')
  assert.ok(saved)
  assert.equal(saved.sourceRefs[0].messageId, 'turn-source')
  assert.match(saved.content, /晨弧备份每周五执行，保留 30 天/u)
})

test('Codex bare remember still reads an 8,800-character previous Chinese prompt', async t => {
  const { root, owner } = fixture(t)
  const workdir = join(root, 'workspace-long')
  mkdirSync(workdir)
  const key = projectIdentity(workdir).key
  const service = createLocalSharingService({ root, profileIdentity: owner.identity, projectKey: key })
  t.after(() => service.close())
  const previousPrompt = `长句记忆标记${'文'.repeat(8_800 - 6)}`
  await handleCodexHook({ service, root, input: { hook_event_name: 'UserPromptSubmit', cwd: workdir,
    session_id: 'codex-long', turn_id: 'long-user-turn', prompt: previousPrompt } })
  await handleCodexHook({ service, root, input: { hook_event_name: 'UserPromptSubmit', cwd: workdir,
    session_id: 'codex-long', turn_id: 'remember-long-turn', prompt: '记住' } })
  const hit = service.search('长句记忆标记', key, 50).hits.find(item => item.kind !== 'source')
  assert.ok(hit)
  assert.equal(hit.sourceRefs[0].messageId, 'long-user-turn')
  assert.ok(hit.content.startsWith('长句记忆标记'))
})

test('source forgetting serializes against a cross-process L0 grant to L1 batch commit', { timeout: 10_000 }, async t => {
  const { root, owner } = fixture(t)
  const workdir = join(root, 'workspace-a')
  mkdirSync(workdir)
  const key = projectIdentity(workdir).key
  const gate = new Int32Array(new SharedArrayBuffer(8))
  const workerData = { root, profileIdentity: owner.identity, projectKey: key, sharedBuffer: gate.buffer }
  const writer = new Worker(new URL('./local-sharing-race-worker.js', import.meta.url), { workerData: { ...workerData, mode: 'writer' } })
  let reader
  t.after(async () => {
    Atomics.store(gate, 0, 1)
    Atomics.notify(gate, 0)
    await Promise.allSettled([writer.terminate(), reader?.terminate()])
  })

  const paused = await waitForMessage(writer, 'append-paused')
  assert.equal(paused.type, 'append-paused')
  reader = new Worker(new URL('./local-sharing-race-worker.js', import.meta.url), { workerData: { ...workerData, mode: 'reader' } })
  const found = await waitForMessage(reader, 'source-found')
  assert.match(found.id, /^source:src_[a-f0-9]{24}:/u)
  const forgetStarted = await waitForMessage(reader, 'forget-started')
  assert.equal(forgetStarted.type, 'forget-started')

  let forgotBeforeCommit = false
  const observe = message => { if (message.type === 'forgot') forgotBeforeCommit = true }
  reader.on('message', observe)
  await new Promise(resolve => setTimeout(resolve, 120))
  reader.off('message', observe)
  assert.equal(forgotBeforeCommit, false, 'forget must wait for the in-flight source transaction')

  const writerSavedPromise = waitForMessage(writer, 'writer-saved')
  const forgotPromise = waitForMessage(reader, 'forgot')
  const finalSearchPromise = waitForMessage(reader, 'final-search')
  Atomics.store(gate, 0, 1)
  Atomics.notify(gate, 0)
  const [saved, forgotten, finalSearch] = await Promise.all([writerSavedPromise, forgotPromise, finalSearchPromise])
  assert.ok(saved.id)
  assert.equal(forgotten.forgotten.status, 'deleted')
  assert.deepEqual(finalSearch.ids, [], 'the source and its derived records stay forgotten after both processes finish')
})

test('a native L1 delete also blocks a concurrent replay of the same user event', { timeout: 10_000 }, async t => {
  const { root, owner } = fixture(t)
  const workdir = join(root, 'workspace-a')
  mkdirSync(workdir)
  const key = projectIdentity(workdir).key
  const rememberInput = { client: 'codex', sessionId: 'race-session', messageId: 'race-event', requestedProjectKey: key,
    text: '记住：珊瑚星计划每周四执行，并发遗忘后不能留下检索结果。' }
  const initial = createLocalSharingService({ root, profileIdentity: owner.identity, projectKey: key })
  const original = initial.remember(rememberInput)
  initial.close()

  const gate = new Int32Array(new SharedArrayBuffer(8))
  const common = { root, profileIdentity: owner.identity, projectKey: key, sharedBuffer: gate.buffer }
  const writer = new Worker(new URL('./local-sharing-race-worker.js', import.meta.url), {
    workerData: { ...common, mode: 'replay-writer', rememberInput },
  })
  let forgetter
  t.after(async () => {
    Atomics.store(gate, 0, 1)
    Atomics.store(gate, 1, 1)
    Atomics.notify(gate, 0)
    Atomics.notify(gate, 1)
    await Promise.allSettled([writer.terminate(), forgetter?.terminate()])
  })

  await waitForMessage(writer, 'append-paused')
  forgetter = new Worker(new URL('./local-sharing-race-worker.js', import.meta.url), {
    workerData: { ...common, mode: 'record-forgetter', recordId: original.id },
  })
  await waitForMessage(forgetter, 'forget-started')
  const forgottenPromise = waitForMessage(forgetter, 'record-forgotten')
  const writerErrorPromise = waitForMessage(writer, 'writer-error')
  const forgotten = await forgottenPromise
  assert.equal(forgotten.forgotten.status, 'deleted')
  Atomics.store(gate, 0, 1)
  Atomics.notify(gate, 0)
  const writerError = await writerErrorPromise
  assert.match(writerError.error, /source.*revoked|revoked.*source/u)
  const finalSearchPromise = waitForMessage(forgetter, 'final-search')
  Atomics.store(gate, 1, 1)
  Atomics.notify(gate, 1)
  const finalSearch = await finalSearchPromise
  assert.deepEqual(finalSearch.ids, [], 'a deleted revision must not be reactivated by an idempotent replay')
})

test('Codex Stop closes the actual turn report with per-question coverage', async t => {
  const { root, owner } = fixture(t)
  const workdir = join(root, 'workspace-a')
  mkdirSync(workdir)
  const key = projectIdentity(workdir).key
  const service = createLocalSharingService({ root, profileIdentity: owner.identity, projectKey: key })
  t.after(() => service.close())
  service.remember({ client: 'claude-code', sessionId: 'prior', messageId: 'prior-1', requestedProjectKey: key,
    text: '记住：晨弧快照每天 03:18，保留 47 天，改时间为了避开每日导入的磁盘峰值。' })
  const common = { cwd: workdir, session_id: 'codex-session', model: 'test', permission_mode: 'default', transcript_path: null }
  await handleCodexHook({ service, root, input: { ...common, hook_event_name: 'UserPromptSubmit', turn_id: 'turn-1',
    prompt: '晨弧快照几点运行、保留多久、改时间为了什么？' } })
  await handleCodexHook({ service, root, input: { ...common, hook_event_name: 'Stop', turn_id: 'turn-1', stop_hook_active: false,
    last_assistant_message: '每天 03:18。\n保留 47 天。' } })
  const report = service.reports.get('codex:codex-session', key)
  assert.deepEqual(report.questions.map(question => question.answerCoverage), ['covered', 'covered', 'unverified'])
})

test('stdio MCP calls only address the fixed project bound to the process', t => {
  const { root, owner } = fixture(t)
  const service = createLocalSharingService({ root, profileIdentity: owner.identity, projectKey: PROJECT_A })
  t.after(() => service.close())
  const init = dispatchMcpRequest(service, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } })
  assert.equal(init.result.protocolVersion, '2024-11-05')
  const tools = dispatchMcpRequest(service, { jsonrpc: '2.0', id: 2, method: 'tools/list' }).result.tools
  assert.ok(tools.some(tool => tool.name === 'memory_search'))
  assert.ok(!tools.some(tool => ['memory_remember', 'memory_forget'].includes(tool.name)))
  assert.ok(tools.every(tool => !Object.hasOwn(tool.inputSchema.properties, 'projectKey')))
  const lookup = dispatchMcpRequest(service, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: {
    name: 'memory_search', arguments: { query: '晨弧快照 03:18' },
  } }, { client: 'codex' })
  assert.match(lookup.result.content[0].text, /晨弧快照/u)
})
