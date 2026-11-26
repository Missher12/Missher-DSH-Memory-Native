import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { CapturePipeline } from '../host/capture.js'
import { readTurnIntakes, readCaptureTasks, readSource } from '../host/capture-journal.js'
import { verifyBackup } from '../host/backup.js'
import { resolveConfig } from '../host/config.js'
import { projectIdentity } from '../host/paths.js'
import { MemoryIndex } from '../host/search.js'
import { MemoryStore } from '../host/store.js'
import { SourcePassageIndex, forgetSourcePassage } from '../host/source-passages.js'

const NOW = 1_700_000_000_000

function fakeLlm(reply, finishKind = 'stop') {
  let calls = 0
  const llm = {
    calls: () => calls,
    async resolveModelInfo() {
      return { reasoning: { efforts: [{ id: 'max' }, { id: 'low' }] } }
    },
    async *stream(request) {
      calls += 1
      const text = typeof reply === 'function' ? reply(request) : reply
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'finish', reason: { kind: finishKind } }
    },
  }
  return llm
}

function setup(t, { reply, config: overrides = {}, cwd = '/tmp/project-a', onExtraction, finishKind, sessionQuery } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-memory-capture-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const store = new MemoryStore({ root, clock: () => NOW }).open()
  const index = new MemoryIndex().rebuild(store.listAll())
  const llm = fakeLlm(reply, finishKind)
  const config = resolveConfig({
    capture: { minTurnChars: 0 },
    ...overrides,
  })
  const writes = []
  const capture = new CapturePipeline({
    store,
    index,
    config,
    ctx: { get: (key) => (key === 'llm' ? llm : key === 'sessionQuery' ? sessionQuery : undefined), logger: { info() {}, warn() {} } },
    clock: () => NOW,
    onWrite: () => writes.push(Date.now()),
    onExtraction,
  })
  const session = {
    id: 'session-1',
    header: { cwd },
    requestHeader: () => ({ config: { provider: 'deepseek', model: 'chat', reasoningEffort: 'max' } }),
  }
  return { root, store, index, llm, capture, session, writes, config }
}

function feed(capture, session, userText, assistantText = '好的，我记下了。') {
  capture.observe(session, { type: 'user/message', data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: userText }] } })
  capture.observe(session, { type: 'assistant/message', data: { message: { role: 'assistant', source: { kind: 'assistant' }, content: [{ type: 'text', text: assistantText }] } } })
  capture.observe(session, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
}

const REPLY = JSON.stringify({ memories: [
  { op: 'ADD', kind: 'fact', scope: 'project', content: '该仓库使用 pnpm 并要求 Node 22 以上', tags: ['pnpm'], confidence: 0.9, importance: 0.7 },
] })

test('a queued, explicit remember command grants the original immediately and cannot revive a forgotten message', t => {
  const { root, capture, session, llm, store, index } = setup(t, { reply: REPLY, config: { capture: { maxCallsPerDay: 0 } } })
  t.after(() => capture.dispose())
  const key = projectIdentity(session.header.cwd).key
  const passageIndex = new SourcePassageIndex(root)
  const enqueue = (id, content, source = 'user') => capture.observe(session, {
    type: 'agent/inbox/spliced',
    data: { target: 'next-turn', start: 0, inserted: [{ id, role: 'user', source: { kind: source }, content }] },
  })
  const command = '请记住：银帆快照每天 04:20 执行，保留 47 天。'
  enqueue('explicit', command)
  const hits = passageIndex.search('银帆快照', { projectKey: key })
  assert.equal(hits.length, 1)
  assert.equal(hits[0].record.content, command)
  assert.equal(hits[0].record.remembered, true)
  assert.equal(llm.calls(), 0)
  assert.deepEqual(passageIndex.search('银帆快照', { projectKey: projectIdentity('/tmp/other-project').key }), [])

  enqueue('opt-out', '记住：石榴作业使用现役节点。不要保存本轮对话。')
  enqueue('example', '例子：「记住：橡木快照保留两天。」')
  enqueue('internal', '记住：雪松快照凌晨执行。', 'memory')
  enqueue('discussion', '记住这个功能应该如何解释？')
  for (const query of ['石榴', '橡木', '雪松', '功能']) assert.deepEqual(passageIndex.search(query, { projectKey: key }), [])

  assert.ok(forgetSourcePassage(root, hits[0].record.id, key, store, index))
  enqueue('explicit', command)
  assert.deepEqual(new SourcePassageIndex(root).search('银帆快照', { projectKey: key }), [])
})

test('ordinary-language credential assignments are stopped before capture and cannot be explicitly remembered', async t => {
  const { root, capture, session, llm } = setup(t, { reply: REPLY })
  t.after(() => capture.dispose())
  for (const content of [
    'Please remember: my previous password was QA-placeholder-42.',
    '记住：我的访问令牌原来是QA-placeholder-43。',
    'I changed my passphrase from QA-placeholder-first to QA-placeholder-next.',
  ]) {
    feed(capture, session, content)
    await capture.flush()
  }
  const sources = join(root, 'capture', 'sources')
  assert.equal(llm.calls(), 0)
  assert.deepEqual(existsSync(sources) ? readdirSync(sources).filter(name => /\.json(?:\.gz)?$/u.test(name)) : [], [])
  feed(capture, session, '记住：这套流程使用两步验证，修改前先复查负责人。')
  await capture.flush()
  assert.equal(llm.calls(), 1)
})

test('remembering a previous message keeps its native time and client zone', async t => {
  const { root, capture, session, user, submit, end } = previousMessageFixture(t, { capture: { enabled: false } })
  const chat = session('previous-time')
  const key = projectIdentity(chat.header.cwd).key
  const message = user('previous-dated-message', '昨天完成了水杉检修。')
  message.source.clientTimeZone = 'Asia/Shanghai'
  submit(chat, user('older', '普通的另一条消息。'))
  submit(chat, message)
  end(chat)
  capture.setConfig(resolveConfig({ capture: { enabled: true, maxCallsPerDay: 0 } }))
  const command = user('bare-command', '记住')
  submit(chat, command)
  await capture.waitForRemembering(chat, [command])

  const [hit] = new SourcePassageIndex(root).search('水杉检修', { projectKey: key })
  const [ref] = hit.record.sourceRefs
  const source = readSource(root, ref.sourceId)
  assert.equal(source.text, message.content)
  assert.equal(source.eventTime, NOW + 1)
  assert.equal(source.timeZone, 'Asia/Shanghai')
  assert.equal(ref.eventTime, NOW + 1)
  assert.equal(ref.timeZone, 'Asia/Shanghai')
})

test('an ordinary queued message keeps its submission clock through extraction', async t => {
  const content = '昨天我完成了水杉检修。'
  const { root, store, capture, session } = setup(t, { reply: JSON.stringify({ memories: [
    { op: 'ADD', kind: 'episode', scope: 'project', content, confidence: 0.96, importance: 0.8 },
  ] }) })
  t.after(() => capture.dispose())
  const message = { id: 'ordinary-dated', role: 'user', content, source: { kind: 'user', clientTimeZone: 'Asia/Shanghai' } }
  const queuedAt = NOW - 86_400_000
  capture.observe(session, { type: 'agent/inbox/spliced', seq: 0, time: queuedAt,
    data: { target: 'next-turn', start: 0, inserted: [message] } })
  capture.observe(session, { type: 'user/message', seq: 1, time: NOW, data: message })
  capture.observe(session, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  await capture.flush()

  const [record] = new MemoryStore({ root }).open().listAll()
  assert.ok(store.find(record.id, [{ scope: 'project', projectKey: projectIdentity(session.header.cwd).key }]))
  const [ref] = record.sourceRefs
  const source = readSource(root, ref.sourceId)
  assert.equal(source.eventTime, queuedAt)
  assert.equal(source.eventSeq, 1)
  assert.equal(ref.eventTime, queuedAt)
  assert.equal(ref.at, NOW)
  assert.equal(ref.timeZone, 'Asia/Shanghai')
  assert.equal(source.text.slice(ref.from, ref.to), ref.excerpt)
})

function previousMessageFixture(t, config) {
  const logs = new Map()
  const sessionQuery = { async observeSession(id) {
    const log = logs.get(id)
    return { events: [...log.events], inheritedEventCount: log.inherited, [Symbol.dispose]() {} }
  } }
  const env = setup(t, { reply: REPLY, config, sessionQuery })
  t.after(() => env.capture.dispose())
  const session = (id, cwd = env.session.header.cwd, inherited = []) => {
    const log = { events: [...inherited], inherited: inherited.length }
    logs.set(id, log)
    return { ...env.session, id, header: { cwd }, inheritedEventCount: inherited.length,
      eventAt: seq => log.events[seq] }
  }
  const user = (id, content, sourceKind = 'user') => ({ id, role: 'user', content, source: { kind: sourceKind } })
  const append = (session, type, data) => {
    const log = logs.get(session.id)
    const event = { type, data, seq: log.events.length, time: NOW + log.events.length }
    log.events.push(event)
    env.capture.observe(session, event)
  }
  const submit = (session, ...messages) => append(session, 'agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: messages })
  const end = session => append(session, 'turn/end', { reason: { kind: 'completed' } })
  return { ...env, session, user, submit, append, end }
}

test('capture records only an immediately preceding authorized user source', async t => {
  const { root, capture, llm, session, user, submit, append, end } =
    previousMessageFixture(t, { capture: { maxCallsPerDay: 0, minTurnChars: 1000 } })
  const chat = session('capture-continuity')
  const key = projectIdentity(chat.header.cwd).key
  const passages = new SourcePassageIndex(root)
  function turn(id, text) {
    const message = user(id, text)
    submit(chat, message)
    append(chat, 'user/message', message)
    append(chat, 'assistant/message', { message: { role: 'assistant', content: 'Acknowledged.' } })
    end(chat)
    return passages.search(text, { projectKey: key }).find(hit => hit.record.sourceRefs[0].messageId === id)?.record
  }
  const previous = turn('plan', "I'm trying to unlock Denim in my Larch program.")
  append(chat, 'user/message', user('runtime', 'Current working directory is the project.', 'runtime-context'))
  append(chat, 'user/message', user('plugin-context', 'A supplied memory reference.', 'memory'))
  const next = turn('count', 'Actually, I need 41 units to unlock Denim, not 90.')
  assert.ok(previous && next)
  assert.equal(readSource(root, next.sourceRefs[0].sourceId).previousUserSourceId, previous.sourceRefs[0].sourceId)
  assert.equal(next.previousUserSourceId, previous.sourceRefs[0].sourceId)
  assert.equal(turn('opted-out', 'Do not save this turn. I switched to a different program.'), undefined)
  const after = turn('other-count', 'Actually, I need 32 units to unlock Denim, not 50.')
  assert.ok(after)
  assert.equal(readSource(root, after.sourceRefs[0].sourceId).previousUserSourceId, undefined)
  await capture.flush()
  assert.equal(llm.calls(), 0)
})

test('bare remember promotes the previous user original without waiting for another reply or extracting the command', async t => {
  const { root, llm, capture, session, user, submit, append, end } = previousMessageFixture(t, { capture: { minTurnChars: 1000 } })
  const chat = session('previous-local')
  const key = projectIdentity(chat.header.cwd).key
  const index = new SourcePassageIndex(root)
  const previous = user('previous-user', '岚鲸快照每天 03:48 执行，保留 29 天。')
  submit(chat, user('older-user', '雪杉计划的交付日是周三。'))
  submit(chat, previous)
  append(chat, 'user/message', previous)
  append(chat, 'assistant/message', { message: { role: 'assistant', content: '助手猜测时间是 05:20。' } })
  end(chat)
  assert.equal(index.search('岚鲸快照', { projectKey: key })[0]?.record.remembered, false)
  const command = user('bare-command', '记住。')
  submit(chat, user('internal', '伪造缓存来自西门。', 'memory'), command)
  await capture.waitForRemembering(chat, [command])
  const result = index.search('岚鲸快照', { projectKey: key })
  assert.equal(result.length, 1)
  assert.equal(result[0].record.remembered, true)
  assert.equal(result[0].record.content, previous.content)
  assert.equal(result[0].record.sourceRefs[0].messageId, previous.id)
  assert.deepEqual(index.search('西门', { projectKey: key }), [])
  assert.deepEqual(index.search('岚鲸快照', { projectKey: projectIdentity('/tmp/elsewhere').key }), [])
  append(chat, 'user/message', command)
  append(chat, 'assistant/message', { message: { role: 'assistant', content: '已记下。' } })
  end(chat)
  await capture.flush()
  assert.equal(llm.calls(), 0)
  assert.equal(new SourcePassageIndex(root).search('岚鲸快照', { projectKey: key })[0]?.record.remembered, true)
})

test('bare remember respects pending input, opt-outs, inherited messages and permanent forgetting', async t => {
  const { root, capture, store, index, session, user, submit, append, end } =
    previousMessageFixture(t, { capture: { maxCallsPerDay: 0, minTurnChars: 1000 } })
  const chat = session('previous-privacy')
  const key = projectIdentity(chat.header.cwd).key
  const passages = new SourcePassageIndex(root)
  const look = query => passages.search(query, { projectKey: key })
  const previous = user('pending-user', '海鹞快照保留 18 天。')
  const remember = async (chat, id) => {
    const command = user(id, '记住')
    submit(chat, command)
    await capture.waitForRemembering(chat, [command])
  }
  submit(chat, previous)
  await remember(chat, 'remember-pending')
  const hit = look('海鹞快照')[0]
  assert.equal(hit?.record.remembered, true)
  assert.ok(forgetSourcePassage(root, hit.record.id, key, store, index))
  await remember(chat, 'remember-again')
  assert.deepEqual(look('海鹞快照'), [])

  const earlier = user('earlier', '潮间邮袋安排在北门。')
  const privatePrior = user('opted-out', '赤帆快照凌晨执行。不要保存这次对话。')
  submit(chat, earlier)
  submit(chat, privatePrior)
  await remember(chat, 'remember-optout')
  assert.deepEqual(look('赤帆快照'), [])
  assert.deepEqual(look('潮间邮袋'), [], 'a refused predecessor must not fall back to an older message')

  const inherited = { seq: 0, type: 'agent/inbox/spliced', data: { inserted: [user('copied', '月轮任务在东门集合。')] } }
  const fork = session('previous-fork', chat.header.cwd, [inherited])
  await remember(fork, 'remember-at-fork-start')
  assert.deepEqual(look('月轮任务'), [])

  const turnOptOut = user('whole-turn-optout', '不要保存本轮问答。')
  const last = user('other-text-same-turn', '河心索引将在周四更新。')
  submit(chat, turnOptOut, last)
  append(chat, 'user/message', turnOptOut)
  append(chat, 'user/message', last)
  end(chat)
  await remember(chat, 'remember-whole-turn-optout')
  assert.deepEqual(look('河心索引'), [])
})

test('original user passages stay available when extraction waits for budget, without granting opt-outs or assistant replies', async t => {
  const {root,capture,session,llm}=setup(t,{reply:'{"memories":[]}',config:{capture:{maxCallsPerDay:0,minTurnChars:1000}}})
  t.after(()=>capture.dispose())
  feed(capture,session,'岚石交接地点定在东侧三楼。','助手猜测备用地点是西门。')
  await capture.flush()
  const key=projectIdentity(session.header.cwd).key,index=new SourcePassageIndex(root)
  assert.ok(index.search('岚石交接',{projectKey:key}).some(hit=>hit.record.content.includes('东侧三楼')))
  assert.equal(index.search('西门',{projectKey:key}).length,0)
  feed(capture,{...session,id:'no-save'},'不要保存这次问答。岚石口令是枫叶。')
  await capture.flush()
  assert.equal(index.search('枫叶',{projectKey:key}).length,0)
  assert.equal(llm.calls(),0)
})

test('forgetting an unextracted original also retires its queued work; explicit retry cannot recreate it', async t => {
  const {root,capture,session,llm,store,index}=setup(t,{reply:REPLY,config:{capture:{maxCallsPerDay:0,minTurnChars:0}}})
  t.after(()=>capture.dispose())
  feed(capture,session,'该仓库使用 pnpm 并要求 Node 22 以上。')
  await capture.flush()
  const key=projectIdentity(session.header.cwd).key,hit=new SourcePassageIndex(root).search('pnpm',{projectKey:key})[0]
  assert.ok(hit)
  const task=readCaptureTasks(root).find(item=>item.status==='pending');assert.ok(task)
  forgetSourcePassage(root,hit.record.id,key,store,index)
  capture.retry(task.id)
  await capture.flush()
  assert.equal(llm.calls(),0)
  assert.equal(store.listAll().length,0)
  assert.equal(readCaptureTasks(root).find(item=>item.id===task.id).status,'skipped')
})

test('one completed turn produces one active memory', async (t) => {
  const { store, capture, session } = setup(t, { reply: REPLY })
  feed(capture, session, '记住：这个仓库用 pnpm，要求 Node 22 以上。')
  await capture.flush()

  const key = projectIdentity(session.header.cwd).key
  const records = store.list('project', key)
  assert.equal(records.length, 1)
  assert.equal(records[0].status, 'active')
  assert.match(records[0].content, /pnpm/u)
})

test('the reasoning effort is downgraded for the background call', async (t) => {
  const { llm, capture, session } = setup(t, { reply: REPLY })
  const seen = []
  const original = llm.stream
  llm.stream = async function* (options) {
    seen.push(options)
    yield* original(options)
  }
  feed(capture, session, '记住：这个仓库用 pnpm。')
  await capture.flush()
  assert.equal(seen.length, 1)
  assert.equal(seen[0].reasoningEffort, 'low')
})

test('a duplicate statement is not stored twice', async (t) => {
  const { store, capture, session } = setup(t, { reply: REPLY })
  feed(capture, session, '记住：这个仓库用 pnpm。')
  await capture.flush()
  feed(capture, session, '再确认一下，这个仓库用 pnpm。')
  await capture.flush()

  const key = projectIdentity(session.header.cwd).key
  assert.equal(store.list('project', key).length, 1)
})

test('UPDATE rewrites the target record instead of adding a second one', async (t) => {
  const holder = { reply: REPLY }
  const { store, capture, session } = setup(t, { reply: () => holder.reply })
  feed(capture, session, '记住：这个仓库用 pnpm，要求 Node 22 以上。')
  await capture.flush()
  const key = projectIdentity(session.header.cwd).key
  const first = store.list('project', key)[0]
  assert.ok(first !== undefined)

  holder.reply = JSON.stringify({ memories: [
    { op: 'UPDATE', targetId: first.id, kind: 'fact', scope: 'project', content: '该仓库使用 pnpm 并要求 Node 24 以上', tags: ['pnpm'], confidence: 0.95, importance: 0.8 },
  ] })
  feed(capture, session, '更正：这个仓库使用 pnpm，Node 版本要求是 24 以上。')
  await capture.flush()

  const records = store.list('project', key)
  assert.equal(records.length, 1)
  assert.match(records[0].content, /Node 24/u)
  assert.equal(records[0].revision, 2)
  assert.ok(records[0].sourceRefs.length >= 2)
  assert.ok(records[0].sourceRefs.every((ref) => ref.role === 'user'))
})

test('credential-looking content is rejected', async (t) => {
  const reply = JSON.stringify({ memories: [
    { op: 'ADD', kind: 'fact', scope: 'project', content: 'api_key = sk-abcdefghijklmnopqrstuvwxyz', confidence: 0.9 },
  ] })
  const { store, capture, session } = setup(t, { reply })
  feed(capture, session, '记住我的 key')
  await capture.flush()
  assert.equal(store.list('project', projectIdentity(session.header.cwd).key).length, 0)
})

test('a truncated extraction keeps the complete leading items', async (t) => {
  const truncated = '{"memories":[{"op":"ADD","kind":"fact","scope":"project","content":"该仓库使用 pnpm","confidence":0.9},{"op":"ADD","kind":"fact","scope":"project","content":"要求 Node 24 以上","confidence":0.9},{"op":"ADD","kind":"fact","scope":"project","content":"未写完'
  const { store, capture, session } = setup(t, { reply: truncated, finishKind: 'length' })
  feed(capture, session, '记住：这个仓库用 pnpm，要求 Node 24 以上。')
  await capture.flush()
  assert.equal(store.list('project', projectIdentity(session.header.cwd).key).length, 2)
  assert.ok(capture.status().counts.partial >= 1, 'the parent and its bounded completion child remain explicitly partial')
})

test('budget exhaustion skips non-explicit turns', async (t) => {
  const { llm, capture, session } = setup(t, { reply: REPLY, config: { capture: { minTurnChars: 0, maxCallsPerDay: 0 } } })
  feed(capture, session, '这是一个普通的长对话，没有显式要求记忆。')
  await capture.flush()
  assert.equal(llm.calls(), 0)
})

test('an explicit remember request bypasses the exhausted budget', async (t) => {
  const { llm, capture, session } = setup(t, { reply: REPLY, config: { capture: { minTurnChars: 0, maxCallsPerDay: 0 } } })
  feed(capture, session, '记住：这个仓库用 pnpm。')
  await capture.flush()
  assert.equal(llm.calls(), 1)
})

test('an incomplete turn is ignored', async (t) => {
  const { llm, capture, session } = setup(t, { reply: REPLY })
  capture.observe(session, { type: 'user/message', data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '记住：这个仓库用 pnpm。' }] } })
  capture.observe(session, { type: 'turn/end', data: { reason: { kind: 'aborted' } } })
  await capture.flush()
  assert.equal(llm.calls(), 0)
})

test('near-duplicate statements merge into one record and raise confidence', async (t) => {
  let call = 0
  const reply = () => {
    call += 1
    const content = call === 1 ? '用户偏好简洁直接的表达方式' : '用户偏好简洁、直接的表达方式。'
    return JSON.stringify({ memories: [
      { op: 'ADD', kind: 'preference', scope: 'global', content, tags: ['style'], confidence: 0.8, importance: 0.6 },
    ] })
  }
  const { store, capture, session } = setup(t, { reply })
  feed(capture, session, '记住：我喜欢简洁直接的回答。')
  await capture.flush()
  feed(capture, session, '以后回答都简洁直接一点。')
  await capture.flush()

  const preferences = store.listAll().filter((record) => record.kind === 'preference')
  assert.equal(preferences.length, 1)
  assert.ok(preferences[0].confidence >= 0.85)
  assert.match(preferences[0].content, /简洁/u)
})

test('a long turn is extracted in chunks', async (t) => {
  let call = 0
  const reply = () => {
    call += 1
    const content = call === 1 ? '第一段对话涉及项目依赖管理' : '第二段对话涉及部署与版本约束'
    return JSON.stringify({ memories: [
      { op: 'ADD', kind: 'fact', scope: 'project', content, tags: [], confidence: 0.85, importance: 0.6 },
    ] })
  }
  const { store, capture, session, llm } = setup(t, { reply, config: { extraction: { maxInputTokens: 1000 } } })
  const long = '这是一段很长的用户描述，'.repeat(300)
  capture.observe(session, { type: 'user/message', data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: long }] } })
  capture.observe(session, { type: 'assistant/message', data: { message: { role: 'assistant', source: { kind: 'assistant' }, content: [{ type: 'text', text: '收到，继续。' }] } } })
  capture.observe(session, { type: 'user/message', data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: long }] } })
  capture.observe(session, { type: 'assistant/message', data: { message: { role: 'assistant', source: { kind: 'assistant' }, content: [{ type: 'text', text: '好的。' }] } } })
  capture.observe(session, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  await capture.flush()

  assert.equal(llm.calls(), 2)
  const records = store.list('project', projectIdentity(session.header.cwd).key)
  assert.equal(records.length, 2)
})

test('the daily budget stops mid-turn chunking', async (t) => {
  const reply = () => JSON.stringify({ memories: [
    { op: 'ADD', kind: 'fact', scope: 'project', content: '预算受限的抽取测试', tags: [], confidence: 0.85, importance: 0.6 },
  ] })
  const { capture, session, llm } = setup(t, { reply, config: { extraction: { maxInputTokens: 1000 }, capture: { maxCallsPerDay: 1 } } })
  const long = '这是一段很长的用户描述，'.repeat(300)
  capture.observe(session, { type: 'user/message', data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: long }] } })
  capture.observe(session, { type: 'assistant/message', data: { message: { role: 'assistant', source: { kind: 'assistant' }, content: [{ type: 'text', text: '收到。' }] } } })
  capture.observe(session, { type: 'user/message', data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: long }] } })
  capture.observe(session, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  await capture.flush()

  assert.equal(llm.calls(), 1)
})

test('a very long turn keeps every source and extracts after turn/end', async (t) => {
  const reply = JSON.stringify({ memories: [
    { op: 'ADD', kind: 'fact', scope: 'project', content: '增量抽取测试记录一条', tags: [], confidence: 0.85, importance: 0.6 },
  ] })
  const { store, capture, session, llm } = setup(t, { reply, config: { extraction: { maxInputTokens: 1000 } } })
  const long = '这是一段很长的用户描述，'.repeat(300)
  for (let index = 0; index < 6; index += 1) {
    capture.observe(session, { type: 'user/message', data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: long }] } })
    capture.observe(session, { type: 'assistant/message', data: { message: { role: 'assistant', source: { kind: 'assistant' }, content: [{ type: 'text', text: '收到。' }] } } })
  }
  await capture.flush()
  assert.equal(llm.calls(), 0)
  const status = capture.status()
  assert.equal(status.counts.total, 0)
  assert.ok(status.counts.pending === 0)

  capture.observe(session, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  await capture.flush()
  assert.ok(llm.calls() >= 1)
  const records = store.list('project', projectIdentity(session.header.cwd).key)
  assert.ok(records.length >= 1)
  assert.ok(capture.status().counts.done >= 1)
})

test('preferences merge in the 0.85–0.9 gray zone while facts stay separate', async (t) => {
  const statements = [
    '用户偏好简洁、直接、不绕弯子的中文表达方式，避免客套话',
    '用户偏好简洁、直接、不绕弯子的中文表达方式，避免客套语气',
  ]
  const run = async (kind) => {
    let call = 0
    const reply = () => {
      const content = statements[Math.min(call, statements.length - 1)]
      call += 1
      return JSON.stringify({ memories: [
        { op: 'ADD', kind, scope: 'global', content, tags: [], confidence: 0.8, importance: 0.6 },
      ] })
    }
    const setupResult = setup(t, { reply })
    feed(setupResult.capture, setupResult.session, statements[0])
    await setupResult.capture.flush()
    feed(setupResult.capture, setupResult.session, statements[1])
    await setupResult.capture.flush()
    return setupResult.store.listAll().filter((record) => record.kind === kind)
  }

  const preferences = await run('preference')
  assert.equal(preferences.length, 1)
  assert.ok(Math.abs(preferences[0].confidence - 0.85) < 1e-9)

  const facts = await run('fact')
  assert.equal(facts.length, 2)
})

test('a changed value supersedes the old statement instead of merging', async (t) => {
  let call = 0
  const reply = () => {
    call += 1
    const content = call === 1 ? '该仓库要求 Node 22 以上' : '该仓库要求 Node 24 以上'
    return JSON.stringify({ memories: [
      { op: 'ADD', kind: 'fact', scope: 'project', content, tags: [], confidence: 0.9, importance: 0.7 },
    ] })
  }
  const { store, capture, session } = setup(t, { reply })
  feed(capture, session, '记住：这个仓库要求 Node 22 以上。')
  await capture.flush()
  feed(capture, session, '更正：这个仓库现在要求 Node 24 以上。')
  await capture.flush()

  const records = store.list('project', projectIdentity(session.header.cwd).key)
  assert.equal(records.length, 2)
  const old = records.find((record) => record.content.includes('22'))
  const fresh = records.find((record) => record.content.includes('24'))
  assert.equal(old.status, 'superseded')
  assert.equal(fresh.status, 'active')
  assert.equal(fresh.supersedesId, old.id)
})


test('setConfig disables capture at runtime', async (t) => {
  const { capture, session, llm } = setup(t, { reply: REPLY })
  capture.setConfig(resolveConfig({ capture: { enabled: false } }))
  feed(capture, session, '记住：这个仓库用 pnpm，要求 Node 22 以上。')
  await capture.flush()
  assert.equal(llm.calls(), 0)
})

test('an explicit current-turn no-save clause skips extraction before the paid model call', async (t) => {
  const { root, store, capture, session, llm } = setup(t, { reply: '{"memories":[]}' })
  const prompt = '这个项目的 pnpm 和 Node 版本分别是多少？只根据已有记忆回答。不要调用工具，也不要保存这次问答。'
  feed(capture, session, prompt, 'pnpm：9.12.3；Node：不记得。')
  await capture.flush()
  assert.equal(llm.calls(), 0)
  assert.equal(readTurnIntakes(root).intakes[0].status, 'skipped')
  assert.match(readTurnIntakes(root).intakes[0].reason, /明确要求不保存/u)
  const ids = readTurnIntakes(root).intakes[0].sourceIds
  assert.ok(ids.length > 0)
  assert.ok(ids.every(id => readSource(root, id) === null))
  const manifest = await verifyBackup(await store.backup())
  assert.ok(manifest.files.every(file => !ids.some(id => file.path.includes(`${id}.json`))))
  assert.equal(store.listAll().length, 0)
})

test('a late no-save instruction drops earlier user and assistant originals from the same turn', async t => {
  const { root, capture, session, llm } = setup(t, { reply: '{"memories":[]}' })
  const user = (id, content) => capture.observe(session, { type: 'user/message',
    data: { id, role: 'user', source: { kind: 'user' }, content } })
  user('first', '请记住：普通的临时记忆示例。')
  capture.observe(session, { type: 'assistant/message',
    data: { message: { id: 'reply', role: 'assistant', content: '同一轮生成的答复。' } } })
  user('opt-out', '不要保存')
  capture.observe(session, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  await capture.flush()
  const [intake] = readTurnIntakes(root).intakes
  assert.equal(intake.status, 'skipped')
  assert.equal(intake.sourceIds.length, 3)
  assert.ok(intake.sourceIds.every(id => readSource(root, id) === null))
  assert.equal(llm.calls(), 0)
})

test('credential-like user and assistant originals never enter the extraction request', async t => {
  const sent = []
  const { capture, session, root } = setup(t, { reply: request => {
    sent.push(request.messages.map(message => message.content).flat().map(part => part.text).join('\n'))
    return '{"memories":[]}'
  } })
  const user = (id, content) => capture.observe(session, { type: 'user/message',
    data: { id, role: 'user', source: { kind: 'user' }, content } })
  user('secret', 'password: fictional-review-value-8472')
  user('mixed', '青岚快照每天 02:10 执行。')
  capture.observe(session, { type: 'assistant/message',
    data: { message: { role: 'assistant', content: 'access_token = fictional-assistant-value-19' } } })
  capture.observe(session, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  await capture.flush()
  assert.equal(sent.length, 0)
  assert.ok(readTurnIntakes(root).intakes[0].sourceIds.every(id => readSource(root, id) === null))
  feed(capture, session, '青岚快照每天 02:10 执行。')
  await capture.flush()
  assert.equal(sent.length, 1)
  assert.match(sent[0], /青岚快照/u)
  assert.equal(sent[0].includes('fictional-review-value'), false)
  assert.equal(sent[0].includes('fictional-assistant-value'), false)
})

test('a quoted no-save example in a discussion is not treated as a current-turn opt-out', async (t) => {
  const { capture, session, llm } = setup(t, { reply: '{"memories":[]}' })
  feed(capture, session, '请解释示例“不要保存这次问答”在隐私规则中的含义。', '这是对示例规则的讨论。')
  await capture.flush()
  assert.equal(llm.calls(), 1)
})


test('extraction reports prompt token telemetry', async (t) => {
  const seen = []
  const { capture, session } = setup(t, { reply: REPLY, onExtraction: (stats) => seen.push(stats) })
  feed(capture, session, '记住：这个仓库用 pnpm，要求 Node 22 以上。')
  await capture.flush()
  assert.equal(seen.length, 1)
  assert.ok(seen[0].promptTokens > 0)
  assert.ok(seen[0].transcriptChars > 0)
  assert.equal(seen[0].items, 1)
  assert.equal(seen[0].applied, 1)
})
