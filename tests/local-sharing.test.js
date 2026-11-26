import assert from 'node:assert/strict'
import fs, { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Worker } from 'node:worker_threads'
import { prepareStorage } from '../host/storage-boundary.js'
import { createLocalSharingService } from '../host/local-sharing.js'
import { readSource, saveSource } from '../host/capture-journal.js'
import { grantSourceRecall, readGrantedSource } from '../host/source-passages.js'
import { MemoryStore } from '../host/store.js'
import { projectIdentity } from '../host/paths.js'
import { handleClaudeHook, handleCodexHook } from '../host/local-sharing-hooks.js'
import { dispatchMcpRequest } from '../host/local-sharing-mcp.js'

const PROJECT_A = 'same-topic-a'
const PROJECT_B = 'same-topic-b'

test('both local hooks keep friends and family in one birth count question', async t => {
  const { root, owner } = fixture(t)
  const cwd = join(root, 'birth-count-workspace')
  mkdirSync(cwd)
  const projectKey = projectIdentity(cwd).key
  const now = Date.UTC(2026, 10, 26, 12)
  t.mock.method(Date, 'now', () => now)
  const service = createLocalSharingService({ root, profileIdentity: owner.identity, projectKey, clock: () => now })
  t.after(() => service.close())
  for (const [sessionId, text] of [
    ['twins', 'My friend Ada welcomed twins named Iris and Noor on November 2, 2026.'],
    ['one', 'My cousin Dan had a baby girl named Uma on September 3, 2026.'],
  ]) {
    const source = saveSource(root, { projectKey, sessionId, messageId: 'original', text,
      role: 'user', sourceKind: 'user', at: now - 1000, eventTime: now - 1000, timeZone: 'UTC' })
    assert.ok(grantSourceRecall(root, readSource(root, source.id), projectKey, { remembered: true }))
  }
  const prompt = 'How many babies were born to my friends and family in the last three months?'
  for (const [provider, hook, field] of [
    ['codex', handleCodexHook, 'turn_id'], ['claude-code', handleClaudeHook, 'prompt_id'],
  ]) {
    const input = { cwd, session_id: 'count-births', [field]: 'count' }
    const submitted = await hook({ service, root, input: { ...input, hook_event_name: 'UserPromptSubmit', prompt } })
    assert.match(submitted.hookSpecificOutput?.additionalContext ?? '', /3 recorded births/u)
    await hook({ service, root, input: { ...input, hook_event_name: 'Stop', last_assistant_message: 'There were 3 recorded births.' } })
    const { questions } = service.reports.get(provider + ':count-births', projectKey)
    assert.equal(questions.length, 1)
    assert.equal(questions[0].eventCount.confirmed, 3)
    assert.equal(questions[0].injected.length, 2)
    assert.equal(questions[0].answerCoverage, 'covered')
  }
})

test('both local hooks verify duration at a named event and retract the derived answer on forget', async t => {
  const { root, owner } = fixture(t)
  const cwd = join(root, 'guitar-workspace')
  const foreign = join(root, 'other', 'guitar-workspace')
  mkdirSync(cwd)
  mkdirSync(foreign, { recursive: true })
  const projectKey = projectIdentity(cwd).key
  const foreignKey = projectIdentity(foreign).key
  const now = Date.UTC(2026, 10, 26, 12)
  const anchoredAt = Date.UTC(2026, 10, 25, 12)
  t.mock.method(Date, 'now', () => now)
  const service = createLocalSharingService({ root, profileIdentity: owner.identity, projectKey, clock: () => now })
  t.after(() => service.close())
  const add = (sessionId, text, at = anchoredAt, key = projectKey) => {
    const original = saveSource(root, { projectKey: key, sessionId, messageId: 'original', text,
      role: 'user', sourceKind: 'user', at, eventTime: at, timeZone: 'UTC' })
    assert.ok(grantSourceRecall(root, readSource(root, original.id), key, { remembered: true }))
    return original.id
  }
  const activityQuote = "I've been taking guitar lessons for six weeks."
  const eventQuote = 'I bought the new guitar amp two weeks ago.'
  const activity = add('guitar-lessons', activityQuote)
  const event = add('amp-purchase', eventQuote)
  add('separate-project-conflict', 'I bought the new guitar amp one week ago.', anchoredAt, foreignKey)
  add('future-amp-conflict', 'I bought the new guitar amp four weeks ago.', now + 1000)
  const prompt = 'How long had I been taking guitar lessons when I bought the new guitar amp?'
  const clients = [
    ['codex', handleCodexHook, 'turn_id'], ['claude-code', handleClaudeHook, 'prompt_id'],
  ]
  let eventRecord
  for (const [provider, hook, field] of clients) {
    const submit = (session, name, extra = {}) => hook({ service, root, input: {
      cwd, session_id: session, [field]: session, hook_event_name: name, ...extra,
    } })
    const context = (await submit('event-duration', 'UserPromptSubmit', { prompt })).hookSpecificOutput?.additionalContext ?? ''
    assert.match(context, /for 4 weeks when you bought the new guitar amp/u)
    assert.equal(context.match(/Answer to the question:/gu)?.length, 1)
    assert.doesNotMatch(context, /for six weeks|two weeks ago/u)
    await submit('event-duration', 'Stop', { last_assistant_message: 'You had been taking guitar lessons for four weeks when you bought the new guitar amp.' })
    const report = service.reports.get(provider + ':event-duration', projectKey)
    const question = report.questions[0]
    assert.equal(question.detail, 'duration-at-event')
    assert.deepEqual(question.durationAtEvent, { days: 28, conditional: false, projected: true })
    assert.equal(question.answerCoverage, 'covered')
    assert.deepEqual(new Set(question.injected.map(item => item.selectedQuote)), new Set([activityQuote.slice(0, -1), eventQuote]))
    assert.deepEqual(new Set(question.injected.flatMap(item => item.sourceRefs.map(ref => ref.sourceId))), new Set([activity, event]))
    eventRecord = question.injected.find(item => item.sourceRefs.some(ref => ref.sourceId === event)).id
    await submit('wrong-duration', 'UserPromptSubmit', { prompt })
    await submit('wrong-duration', 'Stop', { last_assistant_message: 'You had been taking lessons for six weeks.' })
    assert.equal(service.reports.get(provider + ':wrong-duration', projectKey).questions[0].answerCoverage, 'unverified')
  }
  service.forget(eventRecord, projectKey)
  for (const [provider, hook, field] of clients) {
    assert.equal(service.reports.get(provider + ':event-duration', projectKey), null)
    assert.equal(service.reports.get(provider + ':wrong-duration', projectKey), null)
    const submitted = await hook({ service, root, input: { cwd, session_id: 'after-forget',
      [field]: 'after-forget', hook_event_name: 'UserPromptSubmit', prompt } })
    const context = submitted.hookSpecificOutput?.additionalContext ?? ''
    assert.match(context, /memories do not establish the duration/u)
    assert.doesNotMatch(context, /for 4 weeks|six weeks|two weeks ago/u)
  }
  add('amp-acquisition', 'I got the new guitar amp two weeks ago.')
  for (const [provider, hook, field] of clients) {
    const input = { cwd, session_id: 'conditional-duration', [field]: 'acquisition' }
    const submitted = await hook({ service, root, input: { ...input, hook_event_name: 'UserPromptSubmit', prompt } })
    assert.match(submitted.hookSpecificOutput?.additionalContext ?? '', /If you mean when you got the new guitar amp.*for 4 weeks/u)
    await hook({ service, root, input: { ...input, hook_event_name: 'Stop',
      last_assistant_message: 'If you mean when you bought the amp, you had been taking guitar lessons for four weeks.' } })
    const conditional = service.reports.get(provider + ':conditional-duration', projectKey).questions[0]
    assert.deepEqual(conditional.durationAtEvent, { days: 28, conditional: true, projected: true, acquisitionObject: 'new guitar amp' })
    assert.equal(conditional.answerCoverage, 'unverified')
  }
})

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

test('another client cannot read an explicit original before its record batch commits', t => {
  const { root, owner } = fixture(t)
  const options = { root, profileIdentity: owner.identity, projectKey: PROJECT_A }
  const writer = createLocalSharingService(options)
  const reader = createLocalSharingService(options)
  t.after(() => { writer.close(); reader.close() })
  const input = { client: 'codex', sessionId: 'writer', messageId: 'explicit-save',
    text: '记住：Juniper 压力检测使用 Saffron Plover 操作清单。' }
  const query = 'Saffron Plover 操作清单'
  const pending = []
  const append = MemoryStore.prototype.appendBatch
  let failAppend = true
  t.mock.method(MemoryStore.prototype, 'appendBatch', function (records) {
    pending.push(reader.search(query).hits.length)
    if (failAppend) throw Object.assign(new Error('simulated record write failure'), { code: 'EIO' })
    return append.call(this, records)
  })
  assert.throws(() => writer.remember(input), /simulated record write failure/u)
  assert.equal(reader.search(query).hits.length, 0)
  failAppend = false
  const saved = writer.remember(input)
  assert.deepEqual(pending, [0, 0])
  assert.ok(reader.search(query).hits.some(hit => hit.sourceRefs.some(ref => ref.sourceId === saved.sourceId)))
  assert.equal(readGrantedSource(root, saved.sourceId, PROJECT_A).text, input.text)
})

test('a failed original grant preserves committed memory and retry repairs the same grant', async t => {
  const { root, owner } = fixture(t)
  const cwd = join(root, 'workspace')
  mkdirSync(cwd)
  const key = projectIdentity(cwd).key
  const service = createLocalSharingService({ root, profileIdentity: owner.identity, projectKey: key })
  const input = { cwd, session_id: 'writer', prompt_id: 'same-event', hook_event_name: 'UserPromptSubmit',
    prompt: '记住：Aster 校准报告保留 46 天。' }
  const rename = fs.renameSync
  const grantPrefix = join(root, 'capture', 'recall-grants', key, 'src_')
  let failGrant = true
  const patch = t.mock.method(fs, 'renameSync', (pending, file) => {
    if (failGrant && String(file).startsWith(grantPrefix)) throw Object.assign(new Error('could not publish original grant'), { code: 'EIO' })
    return rename(pending, file)
  })
  syncBuiltinESMExports()
  t.after(() => {
    patch.mock.restore()
    syncBuiltinESMExports()
    service.close()
  })
  const receipt = await handleClaudeHook({ service, root, input })
  assert.match(receipt.hookSpecificOutput.additionalContext, /记忆已保存，原话授权暂未完成/u)
  const query = 'Aster 校准报告 保留 46 天'
  const [saved] = service.search(query).hits.filter(hit => hit.kind === 'fact')
  const sourceId = saved.sourceRefs[0].sourceId
  assert.equal(readSource(root, sourceId).text, input.prompt)
  assert.equal(readGrantedSource(root, sourceId, key), null)
  failGrant = false
  const retry = await handleClaudeHook({ service, root, input: { ...input, prompt_id: 'retry-event', prompt: '记住' } })
  assert.doesNotMatch(retry.hookSpecificOutput?.additionalContext ?? '', /暂未完成|未保存/u)
  const [replay] = service.search(query).hits.filter(hit => hit.kind === 'fact')
  assert.equal(replay.id, saved.id)
  assert.equal(replay.revision, saved.revision)
  assert.equal(replay.sourceRefs[0].sourceId, sourceId)
  assert.equal(readGrantedSource(root, sourceId, key).text, input.prompt)
})

test('the local hooks deliver and grade only the latest cumulative time range', async t => {
  const { root, owner } = fixture(t)
  const cwd = join(root, 'workspace')
  mkdirSync(cwd)
  const key = projectIdentity(cwd).key
  const service = createLocalSharingService({ root, profileIdentity: owner.identity, projectKey: key })
  t.after(() => service.close())
  const add = (messageId, text, offset) => {
    const { id } = saveSource(root, { sessionId: 'dsh-time-history', messageId, role:'user', sourceKind:'user', projectKey:key,
      text, eventTime:Date.now() + offset })
    assert.ok(grantSourceRecall(root, readSource(root, id), key))
    return id
  }
  add('old-quoted-time','I have spent about 4-5 hours on my cedar model so far.', -3000)
  const latest = add('new-quoted-time',"I've already spent 7-9 hours on my cedar model, and it's still in progress.", -1000)
  add('subtotal','I have spent 10 hours on my cedar model this week.', -100)
  const prompt = 'How many hours have I spent on my cedar model?'
  const event = { cwd, session_id:'local-time', turn_id:'time-check' }
  const reply = await handleCodexHook({ service, root, input: { ...event, hook_event_name:'UserPromptSubmit', prompt } })
  const block = reply.hookSpecificOutput?.additionalContext ?? ''
  assert.match(block, /7-9 hours/u)
  assert.doesNotMatch(block, /4-5 hours|10 hours/u)
  const pending = service.reports.get('codex:local-time', key)
  assert.deepEqual(pending.questions[0].injected.map(item => item.sourceRefs[0].sourceId), [latest])
  await handleCodexHook({ service, root, input: { ...event, hook_event_name:'Stop',
    last_assistant_message:'You have spent 7–9 hours on your cedar model.' } })
  const completed = service.reports.get('codex:local-time', key)
  assert.equal(completed.questions[0].answerCoverage, 'covered')
  service.forget(pending.questions[0].injected[0].id)
  assert.equal(service.reports.get('codex:local-time', key), null)
})

test('both local clients use the latest race personal best and revoke its report', async t => {
  const { root, owner } = fixture(t)
  const cwd = join(root, 'race-workspace')
  mkdirSync(cwd)
  const key = projectIdentity(cwd).key
  const service = createLocalSharingService({ root, profileIdentity: owner.identity, projectKey: key })
  t.after(() => service.close())
  const add = (id, recorded, at) => {
    const { id: sourceId } = saveSource(root, { sessionId: 'race-history', messageId: id,
      role: 'user', sourceKind: 'user', projectKey: key, text: recorded, eventTime: at })
    assert.ok(grantSourceRecall(root, readSource(root, sourceId), key))
    return sourceId
  }
  const now = Date.now()
  add('earlier-race', 'I set a personal best time in the charity 5K run with a time of 27:12.', now - 3000)
  const latest = add('new-race-best', "I'm training for another charity 5K run. I'm hoping to beat my personal best time of 25:50.", now - 2000)
  add('different-5k', 'I set a personal best time in a park 5K run with a time of 22:14.', now - 1000)
  const prompt = 'What was my personal best time in the charity 5K run?'
  const clients = [['codex', handleCodexHook, { turn_id: 'race-test' }],
    ['claude-code', handleClaudeHook, { prompt_id: 'race-test' }]]
  let evidenceId
  for (const [name, hook, fields] of clients) {
    const source = { cwd, session_id: name + '-race', ...fields }
    const reply = await hook({ service, root, input: { ...source, prompt, hook_event_name: 'UserPromptSubmit' } })
    const block = reply.hookSpecificOutput?.additionalContext ?? ''
    assert.match(block, /25:50/u)
    assert.doesNotMatch(block, /27:12|22:14/u)
    const session = name + ':' + source.session_id
    const slot = service.reports.get(session, key).questions[0]
    assert.deepEqual(slot.injected.map(hit => hit.sourceRefs[0].sourceId), [latest])
    evidenceId = slot.injected[0].id
    if (name === 'codex') {
      await hook({ service, root, input: { ...source, hook_event_name: 'Stop',
        last_assistant_message: 'Your personal best time in the charity 5K run was 25:50.' } })
      assert.equal(service.reports.get(session, key).questions[0].answerCoverage, 'covered')
    }
  }
  service.forget(evidenceId)
  for (const [name] of clients) assert.equal(service.reports.get(name + ':' + name + '-race', key), null)
})

test('both local clients lose an inferred bird total when its earlier scope is revoked', async t => {
  const { root, owner } = fixture(t)
  const cwd = join(root, 'bird-workspace')
  mkdirSync(cwd)
  const key = projectIdentity(cwd).key
  const service = createLocalSharingService({ root, profileIdentity: owner.identity, projectKey: key })
  t.after(() => service.close())
  const add = (messageId, text, eventTime) => {
    const { id } = saveSource(root, { sessionId: 'bird-history', messageId, role: 'user', sourceKind: 'user',
      projectKey: key, text, eventTime })
    assert.ok(grantSourceRecall(root, readSource(root, id), key))
    return id
  }
  const now = Date.now()
  const parent = add('bird-scope', "I've been tracking the species of birds I've seen in my local park, and I've spotted 27 species so far.", now - 3000)
  const count = add('new-bird-total', "Speaking of woodpeckers, I just saw a flicker in my local park, which brings my total species count to 32.", now - 2000)
  const prompt = 'How many different species of birds have I seen in my local park?'
  const providers = [
    { provider: 'codex', run: handleCodexHook, id: 'turn_id' },
    { provider: 'claude-code', run: handleClaudeHook, id: 'prompt_id' },
  ]
  let scopeHit
  for (const { provider, run, id } of providers) {
    const active = { cwd, [id]: 'bird-test', session_id: provider + '-bird' }
    const outcome = await run({ service, root, input: { ...active, prompt, hook_event_name: 'UserPromptSubmit' } })
    const injected = outcome.hookSpecificOutput?.additionalContext ?? ''
    assert.match(injected, /species count to 32/u)
    assert.doesNotMatch(injected, /\b27\b/u)
    const session = provider + ':' + active.session_id
    const slot = service.reports.get(session, key).questions[0]
    assert.equal(slot.declaredCount?.value, '32')
    assert.deepEqual(slot.injected.map(hit => hit.sourceRefs[0].sourceId), [parent, count])
    scopeHit = slot.injected[0].id
    if (provider === 'codex') {
      await run({ service, root, input: { ...active, hook_event_name: 'Stop',
        last_assistant_message: 'You have seen 32 different species of birds in your local park.' } })
      assert.equal(service.reports.get(session, key).questions[0].answerCoverage, 'covered')
    }
  }
  service.forget(scopeHit)
  for (const { provider, run, id } of providers) {
    assert.equal(service.reports.get(provider + ':' + provider + '-bird', key), null)
    const own = { cwd, [id]: 'bird-followup', session_id: provider + '-after' }
    const result = await run({ service, root, input: { ...own, prompt, hook_event_name: 'UserPromptSubmit' } })
    assert.doesNotMatch(result.hookSpecificOutput?.additionalContext ?? '', /species count to 32/u)
  }
})

test('both local clients use a gift only when its giver and occasion match', async t => {
  const { root, owner } = fixture(t)
  const cwd = join(root, 'gift-workspace')
  mkdirSync(cwd)
  const key = projectIdentity(cwd).key
  const service = createLocalSharingService({ root, profileIdentity: owner.identity, projectKey: key })
  t.after(() => service.close())
  const add = (messageId, text, eventTime) => {
    const { id } = saveSource(root, { sessionId: 'gift-history', messageId, role:'user', sourceKind:'user', projectKey:key,
      text, eventTime })
    assert.ok(grantSourceRecall(root,readSource(root,id),key))
    return id
  }
  const now = Date.now()
  const expected = add('birthday','My father gave me a red wool scarf for my birthday. I play guitar on Saturdays.',now - 3000)
  add('other-donor','My sister gave me green gloves for my birthday.',now - 2000)
  add('other-occasion','My father gave me a small telescope for my anniversary.',now - 1000)
  const prompt = 'What did my dad give me as a birthday gift?'
  const providers = [['codex',handleCodexHook,'turn_id'],['claude-code',handleClaudeHook,'prompt_id']]
  let evidenceId
  for(const [provider, hook, keyOfId] of providers) {
    const input = {cwd,session_id:'gift-'+provider,[keyOfId]:'received-gift',prompt,hook_event_name:'UserPromptSubmit'}
    const reply = await hook({service, root, input})
    const context = reply.hookSpecificOutput?.additionalContext ?? ''
    assert.match(context,/red wool scarf/u)
    assert.doesNotMatch(context,/green gloves|small telescope|guitar/u)
    const reportKey = provider+':'+input.session_id
    const loaded = service.reports.get(reportKey,key).questions[0]
    assert.deepEqual(loaded.injected.map(hit=>hit.sourceRefs[0].sourceId),[expected])
    evidenceId=loaded.injected[0].id
    if(provider==='codex'){
      await hook({service,root,input:{...input,hook_event_name:'Stop',last_assistant_message:'Your father gave you a red wool scarf.'}})
      assert.equal(service.reports.get(reportKey,key).questions[0].answerCoverage,'covered')
    }
  }
  service.forget(evidenceId)
  for(const [provider,hook,keyOfId] of providers) {
    assert.equal(service.reports.get(provider+':gift-'+provider,key),null)
    const reply=await hook({service,root,input:{cwd,session_id:'after-'+provider,[keyOfId]:'after',prompt,hook_event_name:'UserPromptSubmit'}})
    assert.doesNotMatch(reply.hookSpecificOutput?.additionalContext ?? '',/scarf|gloves|telescope/u)
  }
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

test('local search and hooks deliver an exact original once when its saved memory has the same text', async t => {
  const { root, owner } = fixture(t)
  const cwd = join(root, 'shared-original')
  mkdirSync(cwd)
  const key = projectIdentity(cwd).key
  const service = createLocalSharingService({ root, profileIdentity: owner.identity, projectKey: key })
  t.after(() => service.close())
  const original = '银甸归档的校验版本固定为 v4.17。'
  const saved = service.remember({ client: 'codex', sessionId: 'author', messageId: 'original',
    text: '记住：' + original })
  const prompt = '银甸归档的校验是什么版本？'
  const sameEvidence = service.search(prompt).hits.filter(hit => hit.content === original)
  assert.equal(sameEvidence.length, 1)
  assert.equal(sameEvidence[0].id, saved.id)
  assert.equal(sameEvidence[0].sourceRefs[0].sourceId, saved.sourceId)
  for (const [handle, provider] of [[handleCodexHook, 'codex'], [handleClaudeHook, 'claude-code']]) {
    const input = { cwd, session_id: 'find-version', turn_id: 'lookup', prompt_id: 'lookup' }
    const result = await handle({ service, root, input: { ...input, hook_event_name: 'UserPromptSubmit', prompt } })
    const context = result.hookSpecificOutput?.additionalContext ?? ''
    assert.equal(context.split(original).length, 2)
    const [question] = service.reports.get(provider + ':find-version', key).questions
    assert.equal(question.injected.length, 1)
    assert.equal(question.injected[0].sourceRefs[0].sourceId, saved.sourceId)
  }
  service.forget(saved.id)
  assert.equal(service.search(prompt).hits.some(hit => hit.content.includes('v4.17')), false)
  for (const provider of ['codex', 'claude-code']) assert.equal(service.reports.get(provider + ':find-version', key), null)
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

test('both local client hooks check a calendar comparison without borrowing another sentence date', async t => {
  const { root, owner } = fixture(t)
  const cwd = join(root, 'calendar-workspace')
  mkdirSync(cwd)
  const key = projectIdentity(cwd).key
  const service = createLocalSharingService({ root, profileIdentity: owner.identity, projectKey: key })
  t.after(() => service.close())
  service.remember({ client: 'codex', sessionId: 'first-source', messageId: 'first', requestedProjectKey: key,
    text: '记住：青岚立项会在2026年4月10日举行。物料单在2026年4月12日提交。' })
  service.remember({ client: 'claude-code', sessionId: 'second-source', messageId: 'second', requestedProjectKey: key,
    text: '记住：云湾验收会在2026年4月16日举行。' })
  const prompt = '从青岚立项会到云湾验收会，中间隔了几天？'
  for (const [handle, provider, ids] of [[handleClaudeHook, 'claude-code', { prompt_id: 't1' }], [handleCodexHook, 'codex', { turn_id: 't1' }]]) {
    const input = { cwd, session_id: 'cross-calendar', ...ids }
    const injected = await handle({ service, root, input: { ...input, hook_event_name: 'UserPromptSubmit', prompt } })
    const context = injected.hookSpecificOutput.additionalContext
    assert.match(context, /2026年4月10日/u)
    assert.match(context, /2026年4月16日/u)
    assert.match(context, /=\s*6\s*天/u)
    assert.doesNotMatch(context, /4月12日/u)
    await handle({ service, root, input: { ...input, hook_event_name: 'Stop',
      last_assistant_message: '4月10日到4月16日相隔六天。' } })
    const report = service.reports.get(provider + ':cross-calendar', key)
    assert.deepEqual(report.questions.map(question => question.answerCoverage), ['covered', 'covered'])
  }
})

test('local hooks recall personal advice evidence in the right project and revoke the report', async t => {
  const { root, owner } = fixture(t)
  const cwd = join(root, 'advice-context')
  mkdirSync(cwd)
  const key = projectIdentity(cwd).key
  const at = Date.UTC(2026, 10, 25, 13)
  t.mock.method(Date, 'now', () => at)
  const service = createLocalSharingService({ root, profileIdentity: owner.identity, projectKey: key, clock: () => at })
  t.after(() => service.close())
  function add(sessionId, text, projectKey, eventTime) {
    const source = saveSource(root, { sessionId, projectKey, messageId: 'original',
      role: 'user', sourceKind: 'user', at: eventTime, eventTime, timeZone: 'UTC', text })
    assert.ok(grantSourceRecall(root, readSource(root, source.id), projectKey))
    return source.id
  }
  const own = add('owned', "I use a tempered glass protector on my iPhone 13 Pro. Can you suggest a case?", key, at - 1000)
  const walletText = "I'm also looking for a phone wallet case. Can you recommend one?"
  const wallets = new Set([add('wallet', walletText, key, at - 1000), add('wallet-copy', walletText, key, at - 1000)])
  add('future', 'I use my iPhone 16 in a navy case.', key, at + 1000)
  add('foreign', 'I use my iPhone 17 in a violet case.', projectIdentity(join(cwd, 'unrelated')).key, at - 1000)
  const prompt = 'Can you suggest some accessories for my phone?'
  const clients = [[handleCodexHook, 'codex'], [handleClaudeHook, 'claude-code']]
  let record
  for (const [handle, provider] of clients) {
    const input = { cwd, session_id: 'advice-session', turn_id: 'advice', prompt_id: 'advice' }
    const result = await handle({ service, root, input: { ...input, hook_event_name: 'UserPromptSubmit', prompt } })
    assert.match(result.hookSpecificOutput?.additionalContext ?? '', /iPhone 13 Pro/u)
    assert.equal(result.hookSpecificOutput.additionalContext.match(/phone wallet case/gu)?.length, 1)
    assert.doesNotMatch(result.hookSpecificOutput.additionalContext, /iPhone 16|iPhone 17|Can you suggest a case|Can you recommend/u)
    await handle({ service, root, input: { ...input, hook_event_name: 'Stop',
      last_assistant_message: 'Your iPhone 13 Pro already has a tempered glass protector.' } })
    const report = service.reports.get(provider + ':advice-session', key)
    const evidence = report.questions.flatMap(slot => slot.injected)
    assert.equal(evidence.length, 2)
    assert.ok(evidence.some(hit => wallets.has(hit.sourceRefs[0].sourceId)))
    record = evidence.find(hit => hit.sourceRefs[0].sourceId === own)?.id
    assert.ok(record)
  }
  service.forget(record, key)
  for (const [handle, provider] of clients) {
    assert.equal(service.reports.get(provider + ':advice-session', key), null)
    const fresh = await handle({ service, root, input: { cwd, session_id: 'after-forget', prompt_id: 'fresh',
      turn_id: 'fresh', hook_event_name: 'UserPromptSubmit', prompt } })
    assert.match(fresh.hookSpecificOutput?.additionalContext ?? '', /phone wallet case/u)
    assert.doesNotMatch(fresh.hookSpecificOutput.additionalContext, /iPhone 13 Pro/u)
  }
})

test('both local hooks keep the compact advice and a different fact from the same user message', async t => {
  const { root, owner } = fixture(t)
  const cwd = join(root, 'mixed-advice')
  mkdirSync(cwd)
  const key = projectIdentity(cwd).key
  const at = Date.UTC(2026, 10, 25, 13)
  t.mock.method(Date, 'now', () => at)
  const quote = "I'm looking for a new screen protector to replace the cracked one on my iPhone 13 Pro."
  const walletQuote = "I'm also looking for a phone wallet case with a removable card holder and a slim magnetic strap."
  const source = saveSource(root, { sessionId: 'before-extraction', projectKey: key, messageId: 'original',
    role: 'user', sourceKind: 'user', at: at - 1000, eventTime: at - 1000, timeZone: 'UTC',
    text: quote + ' ' + walletQuote })
  assert.ok(grantSourceRecall(root, readSource(root, source.id), key))
  for (const [sessionId, text] of [
    ['lanyard', 'I use a thin phone lanyard.'],
    ['pouch', 'I keep my phone inside a waterproof pouch.'],
  ]) {
    const extra = saveSource(root, { sessionId, projectKey: key, messageId: 'original',
      role: 'user', sourceKind: 'user', at: at - 1000, eventTime: at - 1000, timeZone: 'UTC', text })
    assert.ok(grantSourceRecall(root, readSource(root, extra.id), key))
  }
  const original = new MemoryStore({ root }).open()
  assert.ok(original.write({ id: 'mem_phone_accessories', kind: 'fact', scope: 'project', projectKey: key,
    content: 'For useful phone accessories, I asked for suggestions for a new screen protector to replace the cracked one on my iPhone 13 Pro.',
    confidence: .96, evidenceRole: 'user', sourceRefs: [{ sourceId: source.id, role: 'user', sourceKind: 'user' }] }).ok)
  const service = createLocalSharingService({ root, profileIdentity: owner.identity, projectKey: key, clock: () => at })
  t.after(() => service.close())
  const clients = [[handleCodexHook, 'codex'], [handleClaudeHook, 'claude-code']]
  const prompt = 'Can you suggest some useful accessories for my phone?'
  for (const [handle, provider] of clients) {
    const input = { cwd, session_id: 'mixed-advice', prompt_id: 'accessories', turn_id: 'accessories' }
    const output = await handle({ service, root, input: { ...input, hook_event_name: 'UserPromptSubmit', prompt } })
    const context = output.hookSpecificOutput?.additionalContext ?? ''
    assert.match(context, /phone wallet case/u)
    assert.match(context, /phone lanyard/u)
    assert.match(context, /waterproof pouch/u)
    assert.equal(context.match(/new screen protector/gu)?.length, 1)
    const report = service.reports.get(provider + ':mixed-advice', key)
    const items = report.questions[0].injected
    assert.equal(items.length, 4)
    assert.ok(items.some(item => item.id === 'mem_phone_accessories'))
    assert.ok(items.some(item => item.kind === 'source' && item.text === walletQuote))
  }
  service.forget('mem_phone_accessories', key)
  for (const [handle, provider] of clients) {
    assert.equal(service.reports.get(provider + ':mixed-advice', key), null)
    const input = { cwd, session_id: 'after-forget', prompt_id: 'fresh', turn_id: 'fresh', prompt,
      hook_event_name: 'UserPromptSubmit' }
    const result = await handle({ service, root, input })
    assert.doesNotMatch(result.hookSpecificOutput?.additionalContext ?? '', /screen protector|phone wallet case/u)
    assert.match(result.hookSpecificOutput?.additionalContext ?? '', /phone lanyard/u)
  }
})

test('local hooks verify the direction of a calendar interval from anchored original dates', async t => {
  const { root, owner } = fixture(t)
  const cwd = join(root, 'sale-calendar')
  mkdirSync(cwd)
  const key = projectIdentity(cwd).key
  const at = Date.UTC(2023, 11, 10, 18)
  t.mock.method(Date, 'now', () => at)
  const service = createLocalSharingService({ root, profileIdentity: owner.identity, projectKey: key, clock: () => at })
  t.after(() => service.close())
  const add = (sessionId, text, projectKey = key) => {
    const saved = saveSource(root, { sessionId, projectKey, messageId: 'main',
      role: 'user', sourceKind: 'user', at, eventTime: at, timeZone: 'UTC', text })
    assert.ok(grantSourceRecall(root, readSource(root, saved.id), projectKey, { remembered: true }))
    return saved.id
  }
  add('fair', 'I attended the Cedar Fair a week before Black Friday.')
  const purchase = add('item', 'I bought the Orion telescope on Black Friday.')
  add('outside', 'I attended the Cedar Fair three days before Black Friday.', projectIdentity(join(cwd, 'elsewhere')).key)
  const prompt = 'How many days before I bought the Orion telescope did I attend the Cedar Fair?'
  const clients = [[handleClaudeHook, 'claude-code'], [handleCodexHook, 'codex']]
  let delivered
  for (const [handle, provider] of clients) {
    const input = { cwd, session_id: 'before-redaction', prompt_id: 'day-difference', turn_id: 'day-difference' }
    const result = await handle({ service, root, input: { ...input, hook_event_name: 'UserPromptSubmit', prompt } })
    assert.match(result.hookSpecificOutput.additionalContext, /the Cedar Fair was 7 days before the purchase of the Orion telescope/iu)
    await handle({ service, root, input: { ...input, hook_event_name: 'Stop',
      last_assistant_message: 'The Cedar Fair was seven days before the purchase of the Orion telescope.' } })
    const report = service.reports.get(provider + ':before-redaction', key)
    assert.deepEqual(report.questions.map(question => question.answerCoverage), ['covered', 'covered'])
    delivered = report.questions.flatMap(slot => slot.injected).find(hit => hit.sourceRefs.some(ref => ref.sourceId === purchase))
    assert.ok(delivered)
  }
  service.forget(delivered.id, key)
  for (const [handle, provider] of clients) {
    assert.equal(service.reports.get(provider + ':before-redaction', key), null)
    const result = await handle({ service, root, input: { cwd, session_id: 'after-redaction',
      prompt_id: 'partial', turn_id: 'partial', hook_event_name: 'UserPromptSubmit', prompt } })
    assert.doesNotMatch(result.hookSpecificOutput?.additionalContext ?? '', /\[Verified date interval\]/u)
  }
})

test('both local client hooks verify the latest personal collection count since a restart', async t => {
  const { root, owner } = fixture(t)
  const cwd = join(root, 'shared-collection-history')
  mkdirSync(cwd)
  const key = projectIdentity(cwd).key
  const now = Date.UTC(2023, 11, 21, 21, 31)
  t.mock.method(Date, 'now', () => now)
  const service = createLocalSharingService({ root, profileIdentity: owner.identity, projectKey: key, clock: () => now })
  t.after(() => service.close())
  const add = (sessionId, text, day, projectKey = key) => {
    const eventTime = Date.parse(day + 'T12:00:00Z')
    const source = saveSource(root, { sessionId, messageId: 'original', projectKey, text,
      role: 'user', sourceKind: 'user', at: eventTime, eventTime, timeZone: 'UTC' })
    assert.ok(grantSourceRecall(root, readSource(root, source.id), projectKey, { remembered: true }))
    return source.id
  }
  add('older', 'By the way, speaking of my collection, could you help me list my postcards? I have added 17 new ones since I started collecting again.', '2023-08-11')
  add('delta', 'I just scored 8 more postcards for my collection.', '2023-11-29')
  const latest = add('latest', "I just realized I've added 25 new postcards to my collection since I started collecting again.", '2023-11-30')
  add('lifetime', 'I have 80 postcards in my collection in total.', '2023-12-07')
  add('other-object', 'I have added 35 new mugs to my collection since I started collecting again.', '2023-12-08')
  add('other-project', 'I have added 52 new postcards to my collection since I started collecting again.', '2023-12-09',
    projectIdentity(join(root, 'a-different-project')).key)
  const prompt = 'How many new postcards have I added to my collection since I started collecting again?'
  const clients = [[handleClaudeHook, 'claude-code'], [handleCodexHook, 'codex']]
  let record
  for (const [handle, provider] of clients) {
    for (const [sessionId, answer, coverage] of [
      ['older-answer', 'You have added 17 new postcards to your collection since you started collecting again.', 'unverified'],
      ['latest-answer', 'You have added 25 new postcards to your collection since you started collecting again.', 'covered'],
    ]) {
      const input = { cwd, session_id: sessionId, prompt_id: sessionId, turn_id: sessionId }
      const observed = await handle({ service, root, input: { ...input, hook_event_name: 'UserPromptSubmit', prompt } })
      const context = observed.hookSpecificOutput?.additionalContext ?? ''
      assert.match(context, /25 new postcards/u)
      assert.doesNotMatch(context, /\b(?:17|8|80|35|52)\s+(?:new |more )?(?:postcards|ones|mugs)/iu)
      await handle({ service, root, input: { ...input, hook_event_name: 'Stop', last_assistant_message: answer } })
      const report = service.reports.get(provider + ':' + sessionId, key)
      assert.equal(report.questions[0].answerCoverage, coverage)
      assert.deepEqual(report.questions[0].injected.flatMap(hit => hit.sourceRefs.map(ref => ref.sourceId)), [latest])
      record = report.questions[0].injected[0].id
    }
  }
  service.forget(record, key)
  for (const [handle, provider] of clients) {
    assert.equal(service.reports.get(provider + ':latest-answer', key), null)
    const observed = await handle({ service, root, input: { cwd, session_id: 'after-forget', prompt_id: 'after-forget',
      turn_id: 'after-forget', hook_event_name: 'UserPromptSubmit', prompt } })
    assert.doesNotMatch(observed.hookSpecificOutput?.additionalContext ?? '', /\b25 new postcards/u)
  }
})

test('both local client hooks grade the initial and current leadership counts separately', async t => {
  const { root, owner } = fixture(t)
  const cwd = join(root, 'leadership-workspace')
  mkdirSync(cwd)
  const key = projectIdentity(cwd).key
  const service = createLocalSharingService({ root, profileIdentity: owner.identity, projectKey: key })
  t.after(() => service.close())
  const early = Date.UTC(2023, 11, 10, 12)
  for (const [sessionId, text, at] of [
    ['initial', 'I lead a team of 4 engineers in my new role as Senior Software Engineer.', early],
    ['current', 'I have been enjoying my role as Senior Software Engineer for a while, especially the part where I now lead a team of five engineers.', early + 33 * 86_400_000],
  ]) {
    const original = saveSource(root, { sessionId, messageId: 'original', projectKey: key, text,
      role: 'user', sourceKind: 'user', at, eventTime: at, timeZone: 'UTC' })
    assert.ok(grantSourceRecall(root, readSource(root, original.id), key, { remembered: true }))
  }
  const prompt = 'How many engineers do I lead when I just started my new role as Senior Software Engineer? How many engineers do I lead now?'
  for (const [handle, provider] of [[handleClaudeHook, 'claude-code'], [handleCodexHook, 'codex']]) {
    for (const [sessionId, earlier, current, coverage] of [
      ['correct', 4, 5, 'covered'],
      ['reversed', 5, 4, 'unverified'],
    ]) {
      const input = { cwd, session_id: sessionId, prompt_id: sessionId, turn_id: sessionId }
      const submit = await handle({ service, root, input: { ...input, hook_event_name: 'UserPromptSubmit', prompt } })
      const context = submit.hookSpecificOutput?.additionalContext ?? ''
      assert.match(context, /4 engineers/u)
      assert.match(context, /five engineers/u)
      await handle({ service, root, input: { ...input, hook_event_name: 'Stop',
        last_assistant_message: `You led ${earlier} engineers when you started your new role as Senior Software Engineer. Now, you lead ${current} engineers.` } })
      const report = service.reports.get(provider + ':' + sessionId, key)
      assert.deepEqual(report.questions.map(q => q.answerCoverage), [coverage, coverage])
    }
  }
})

test('both local client hooks use the same remaining amount and withhold an incomplete task order', async t => {
  const { root, owner } = fixture(t)
  const cwd = join(root, 'shared-scope')
  mkdirSync(cwd)
  const key = projectIdentity(cwd).key
  const now = Date.parse('2026-11-24T12:00:00Z')
  let serviceClock = now - 86_400_000
  const service = createLocalSharingService({ root, profileIdentity: owner.identity, projectKey: key, clock: () => serviceClock })
  t.after(() => service.close())
  const add = (messageId, text, older = 1000) => {
    const eventTime = now - older
    const { id } = saveSource(root, { projectKey: key, sessionId: messageId, messageId, text, role: 'user',
      sourceKind: 'user', timeZone: 'UTC', eventTime, at: eventTime })
    assert.ok(grantSourceRecall(root, readSource(root, id), key, { remembered: true }))
    return id
  }
  service.remember({ client: 'codex', sessionId: 'old-amount', messageId: 'old-amount',
    text: '记住：I have 77 pages left to read in the Aster Atlas.' })
  serviceClock = now
  const current = add('current-amount', 'I have 26 pages left to read in the Aster Atlas.')
  add('progress', 'I finished reading 92 pages of the Aster Atlas.', 1)
  add('first-task', 'I fixed the cedar stairs on 2026-11-12.')
  add('not-the-task', 'I completed the proposal yesterday.')
  const remaining = 'How many pages do I have left to read in the Aster Atlas?'
  const order = 'Which task did I complete first, fixing the cedar stairs or buying the blue handrail?'
  for (const [handle, provider] of [[handleClaudeHook, 'claude-code'], [handleCodexHook, 'codex']]) {
    const invoke = input => handle({ service, root, input: { cwd, session_id: 'shared-question', ...input } })
    const ids = value => ({ turn_id: value, prompt_id: value })
    const response = await invoke({ ...ids('remaining'), hook_event_name: 'UserPromptSubmit', prompt: remaining })
    assert.match(response.hookSpecificOutput.additionalContext, /26 pages left/u)
    assert.doesNotMatch(response.hookSpecificOutput.additionalContext, /77 pages|92 pages/u)
    await invoke({ ...ids('remaining'), hook_event_name: 'Stop', last_assistant_message: 'You have 26 pages left to read.' })
    const completed = service.reports.get(`${provider}:shared-question`, key).questions[0]
    assert.equal(completed.answerCoverage, 'covered')
    assert.deepEqual(completed.injected.flatMap(hit => hit.sourceRefs.map(ref => ref.sourceId)), [current])
    const unknown = await invoke({ ...ids('order'), hook_event_name: 'UserPromptSubmit', prompt: order })
    assert.deepEqual(unknown, {})
    const missing = service.reports.get(`${provider}:shared-question`, key)
    assert.ok(missing.questions.every(slot => slot.injected.length === 0))
  }
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

test('source forgetting serializes with a cross-process promotion of an already authorized original', { timeout: 10_000 }, async t => {
  const { root, owner } = fixture(t)
  const workdir = join(root, 'workspace-a')
  mkdirSync(workdir)
  const key = projectIdentity(workdir).key
  const rememberInput = { client: 'codex', sessionId: 'race-session', messageId: 'race-event', requestedProjectKey: key,
    text: '记住：珊瑚星计划每周四执行，并发遗忘后不能留下检索结果。' }
  const source = saveSource(root, { sessionId: `codex:${rememberInput.sessionId}`, messageId: rememberInput.messageId,
    projectKey: key, role: 'user', sourceKind: 'user', sourceForm: 'codex', text: rememberInput.text })
  assert.ok(grantSourceRecall(root, readSource(root, source.id), key, { remembered: true }))
  const gate = new Int32Array(new SharedArrayBuffer(8))
  const workerData = { root, profileIdentity: owner.identity, projectKey: key, sharedBuffer: gate.buffer, rememberInput }
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

test('both local client hooks report the lower bound from a verified visit return and respect revocation', async t => {
  const { root, owner } = fixture(t)
  const cwd = join(root, 'shared-visit-bound')
  mkdirSync(cwd)
  const key = projectIdentity(cwd).key
  const service = createLocalSharingService({ root, profileIdentity: owner.identity, projectKey: key,
    clock: () => Date.parse('2026-01-16T12:00:00Z') })
  t.after(() => service.close())
  for (const [sessionId, text, date] of [
    ['return', 'I just got back from a guided tour at the North Coast Art Museum focused on collage.', '2026-01-08'],
    ['later', 'I attended the Alder Textile exhibit today.', '2026-01-15'],
  ]) {
    const at = Date.parse(date + 'T12:00:00Z')
    const source = saveSource(root, { sessionId, messageId: 'main', projectKey: key, text,
      role: 'user', sourceKind: 'user', at, eventTime: at, timeZone: 'UTC' })
    assert.ok(grantSourceRecall(root, readSource(root, source.id), key, { remembered: true }))
  }
  const prompt = 'How many days passed between my visit to the North Coast Art Museum (NCAM) and the Alder Textile exhibit?'
  const clients = [
    [handleClaudeHook, 'claude-code', { prompt_id: 'bound' }],
    [handleCodexHook, 'codex', { turn_id: 'bound' }],
  ]
  let delivery
  for (const [handle, provider, ids] of clients) {
    const input = { cwd, session_id: 'shared-visit-bound', ...ids }
    const injected = await handle({ service, root, input: { ...input, hook_event_name: 'UserPromptSubmit', prompt } })
    assert.match(injected.hookSpecificOutput.additionalContext, /At least 7 days elapsed/u)
    await handle({ service, root, input: { ...input, hook_event_name: 'Stop',
      last_assistant_message: 'At least seven days elapsed. The exact number is unknown.' } })
    const report = service.reports.get(provider + ':shared-visit-bound', key)
    assert.deepEqual(report.questions.map(slot => slot.answerCoverage), ['covered', 'covered'])
    delivery = report.questions[0].injected[0].id
  }
  service.forget(delivery, key)
  for (const [handle, provider] of clients) {
    assert.equal(service.reports.get(provider + ':shared-visit-bound', key), null)
    const input = { cwd, session_id: 'visit-bound-revoked', prompt_id: 'fresh', turn_id: 'fresh', hook_event_name: 'UserPromptSubmit', prompt }
    const injected = await handle({ service, root, input })
    assert.doesNotMatch(injected.hookSpecificOutput?.additionalContext ?? '', /guided tour|At least 7 days/u)
    assert.match(injected.hookSpecificOutput.additionalContext, /2026-01-15\b/u)
    await handle({ service, root, input: { ...input, hook_event_name: 'Stop',
      last_assistant_message: 'The Alder Textile exhibit was on January 15, 2026. The visit date is unknown, so the interval cannot be calculated.' } })
    const report = service.reports.get(provider + ':visit-bound-revoked', key)
    assert.deepEqual(report.questions.map(slot => slot.answerCoverage), ['no-evidence', 'covered'])
    assert.equal(report.questions[1].calendarDate, '2026-01-15')
  }
})

test('both local client hooks compare the same race and reject a previous-year result after revocation', async t => {
  const { root, owner } = fixture(t)
  const cwd = join(root, 'shared-race-year')
  mkdirSync(cwd)
  const key = projectIdentity(cwd).key
  const at = Date.parse('2024-01-01T12:00:00Z')
  const service = createLocalSharingService({ root, profileIdentity: owner.identity, projectKey: key, clock: () => at + 60_000 })
  t.after(() => service.close())
  let previous
  for (const [sessionId, text] of [['recent', 'I just finished a 5K in 35 minutes.'],
    ['previous', "I've done a 5K run last year, but it took me 45 minutes to complete."]]) {
    const source = saveSource(root, { sessionId, messageId:'original', projectKey:key, text, at, eventTime:at,
      timeZone:'UTC', role:'user', sourceKind:'user' })
    assert.ok(grantSourceRecall(root, readSource(root, source.id), key, { remembered:true }))
    if (sessionId==='previous') previous=source.id
  }
  const prompt = "How much faster did I finish the 5K run compared to my previous year's time?"
  const clients = [[handleClaudeHook, 'claude-code', { prompt_id:'race-year' }], [handleCodexHook, 'codex', { turn_id:'race-year' }]]
  let evidenceId
  for (const [handle, provider, ids] of clients) {
    const input = { cwd, session_id:'shared-race-year', ...ids }
    const output = await handle({ service, root, input:{ ...input, hook_event_name:'UserPromptSubmit', prompt } })
    assert.match(output.hookSpecificOutput.additionalContext,/10 minutes faster/u)
    assert.doesNotMatch(output.hookSpecificOutput.additionalContext, /Recent finishing time.*2024/u)
    await handle({ service, root, input:{ ...input, hook_event_name:'Stop', last_assistant_message:'You finished ten minutes faster.' } })
    const report = service.reports.get(provider+':shared-race-year',key)
    assert.equal(report.questions[0].answerCoverage,'covered')
    assert.equal(report.questions[0].elapsed.race.recent.year, null)
    const next = { ...input, session_id: 'shared-race-year-invented' }
    await handle({ service, root, input: { ...next, hook_event_name: 'UserPromptSubmit', prompt } })
    await handle({ service, root, input: { ...next, hook_event_name: 'Stop',
      last_assistant_message: 'You finished the 5K in 35 minutes in 2024. You were 10 minutes faster.' } })
    assert.equal(service.reports.get(provider + ':shared-race-year-invented', key).questions[0].answerCoverage, 'unverified')
    evidenceId=report.questions[0].injected.find(hit=>hit.sourceRefs.some(ref=>ref.sourceId===previous)).id
  }
  service.forget(evidenceId,key)
  for (const [handle, provider] of clients) {
    assert.equal(service.reports.get(provider+':shared-race-year',key),null)
    const output=await handle({service,root,input:{cwd,session_id:'fresh-race-year',prompt_id:'fresh',turn_id:'fresh',
      hook_event_name:'UserPromptSubmit',prompt}})
    assert.doesNotMatch(output.hookSpecificOutput?.additionalContext??'',/10 minutes faster|45 minutes/u)
  }
})

test('both local client hooks resolve the same weekend as DSH and revoke its evidence', async t => {
  const { root, owner } = fixture(t)
  const cwd = join(root, 'shared-activity-window')
  mkdirSync(cwd)
  const key = projectIdentity(cwd).key
  const now = Date.UTC(2026, 10, 24, 12)
  const service = createLocalSharingService({ root, profileIdentity: owner.identity, projectKey: key, clock: () => now })
  t.after(() => service.close())
  for (const [sessionId, text, at] of [
    ['last', 'I finished the Cedar maintenance checklist last weekend.', Date.UTC(2026, 10, 23, 15)],
    ['older', 'I finished the Birch maintenance checklist last weekend.', Date.UTC(2026, 10, 20, 15)],
    ['planned', 'I was planning to finish the Willow maintenance checklist last weekend.', Date.UTC(2026, 10, 23, 15)],
  ]) {
    const source = saveSource(root, { sessionId, messageId: 'original', projectKey: key, text, at, eventTime: at,
      timeZone: 'UTC', role: 'user', sourceKind: 'user' })
    assert.ok(grantSourceRecall(root, readSource(root, source.id), key, { remembered: true }))
  }
  const prompt = 'Which maintenance checklist did I finish last weekend?'
  const clients = [[handleClaudeHook, 'claude-code', { prompt_id: 'shared-weekend' }],
    [handleCodexHook, 'codex', { turn_id: 'shared-weekend' }]]
  const evidence = []
  for (const [handle, provider, ids] of clients) {
    const input = { cwd, session_id: 'shared-weekend', ...ids }
    const observed = await handle({ service, root, input: { ...input, hook_event_name: 'UserPromptSubmit', prompt } })
    const block = observed.hookSpecificOutput?.additionalContext ?? ''
    assert.match(block, /Cedar maintenance checklist/u)
    assert.match(block, /2026-11-21.*2026-11-22/u)
    assert.doesNotMatch(block, /Birch|Willow/u)
    await handle({ service, root, input: { ...input, hook_event_name: 'Stop', last_assistant_message: 'I finished the Cedar maintenance checklist.' } })
    const report = service.reports.get(provider + ':shared-weekend', key)
    assert.equal(report.questions[0].answerCoverage, 'covered')
    assert.equal(report.questions[0].injected.length, 1)
    evidence.push(report.questions[0].injected[0].id)

    const inconsistent = { ...input, session_id: 'wrong-shared-weekend' }
    await handle({ service, root, input: { ...inconsistent, hook_event_name: 'UserPromptSubmit', prompt } })
    await handle({ service, root, input: { ...inconsistent, hook_event_name: 'Stop',
      last_assistant_message: 'I finished the Cedar maintenance checklist two weekends ago.' } })
    assert.equal(service.reports.get(provider + ':wrong-shared-weekend', key).questions[0].answerCoverage, 'unverified')
  }
  assert.equal(evidence[0], evidence[1])
  service.forget(evidence[0], key)
  for (const [handle, provider, ids] of clients) {
    assert.equal(service.reports.get(provider + ':shared-weekend', key), null)
    const input = { cwd, session_id: 'shared-weekend-retry', ...ids, hook_event_name: 'UserPromptSubmit', prompt }
    const result = await handle({ service, root, input })
    assert.doesNotMatch(result.hookSpecificOutput?.additionalContext ?? '', /Cedar|Birch|Willow/u)
  }
})

test('both local client hooks preserve the uncertainty of an undated appointment', async t => {
  const { root, owner } = fixture(t)
  const cwd = join(root, 'shared-appointment-count')
  mkdirSync(cwd)
  const key = projectIdentity(cwd).key
  const now = Date.UTC(2026, 2, 27, 15)
  const service = createLocalSharingService({ root, profileIdentity: owner.identity, projectKey: key, clock: () => now })
  t.after(() => service.close())
  for (const [sessionId, text] of [
    ['first-visit', 'I finally went to see my primary care physician, Dr. Avery, on March 3rd.'],
    ['second-visit', 'I had a follow-up appointment with my orthopedic surgeon, Dr. Chen, on March 20th.'],
    ['unknown-visit', 'I had an appointment with my primary care physician, but I did not write down the date.'],
    ['planned-visit', 'I plan to schedule an appointment with my doctor, Dr. Rose, on March 25th.'],
  ]) {
    const at = now - 86_400_000
    const source = saveSource(root, { sessionId, messageId: 'original', projectKey: key, text, at, eventTime: at,
      timeZone: 'UTC', role: 'user', sourceKind: 'user' })
    assert.ok(grantSourceRecall(root, readSource(root, source.id), key, { remembered: true }))
  }
  const prompt = 'How many doctor’s appointments did I go to in March?'
  for (const [handle, provider] of [[handleClaudeHook, 'claude-code'], [handleCodexHook, 'codex']]) {
    const input = { cwd, session_id: 'shared-medical', prompt_id: 'shared-count', turn_id: 'shared-count' }
    const result = await handle({ service, root, input: { ...input, hook_event_name: 'UserPromptSubmit', prompt } })
    const block = result.hookSpecificOutput?.additionalContext ?? ''
    assert.match(block, /at least 2 recorded appointments/u)
    assert.doesNotMatch(block, /Dr\. Rose/u)
    await handle({ service, root, input: { ...input, hook_event_name: 'Stop', last_assistant_message: 'Exactly two appointments.' } })
    const report = service.reports.get(provider + ':shared-medical', key)
    assert.equal(report.questions[0].eventCount?.confirmed, 2)
    assert.equal(report.questions[0].eventCount?.complete, false)
    assert.equal(report.questions[0].answerCoverage, 'unverified')
  }
})

test('a later remember keeps the original local client submission clock for the other client', async t => {
  const { root, owner } = fixture(t)
  const cwd = join(root, 'shared-original-calendar-clock')
  mkdirSync(cwd)
  const key = projectIdentity(cwd).key
  let now = Date.UTC(2026, 10, 20, 12)
  t.mock.method(Date, 'now', () => now)
  const service = createLocalSharingService({ root, profileIdentity: owner.identity, projectKey: key, clock: () => now })
  t.after(() => service.close())
  const prior = { cwd, session_id: 'delayed-codex-remember', hook_event_name: 'UserPromptSubmit' }
  await handleCodexHook({ service, root, input: { ...prior, turn_id: 'original-friday',
    prompt: 'I finished the Birch maintenance checklist last weekend.' } })

  now = Date.UTC(2026, 10, 24, 12)
  await handleCodexHook({ service, root, input: { ...prior, turn_id: 'remember-on-tuesday', prompt: '记住' } })
  await handleCodexHook({ service, root, input: { ...prior, turn_id: 'new-tuesday',
    prompt: 'Remember that I finished the Cedar maintenance checklist last weekend.' } })

  service.rememberPrevious({ client: 'codex', sessionId: 'untimed-legacy', messageId: 'older-legacy',
    requestedProjectKey: key, text: 'I finished the Garnet maintenance checklist last weekend.' })
  const direct = { client: 'codex', sessionId: 'identity-less',
    requestedProjectKey: key, text: 'Remember that the maintenance check uses a short internal note.' }
  const first = service.remember(direct)
  now += 60_000
  const replayed = service.remember(direct)
  assert.equal(first.sourceId, replayed.sourceId)
  assert.equal(readSource(root, first.sourceId).eventTime, undefined)

  const check = async (question, id) => {
    const output = await handleClaudeHook({ service, root, input: { cwd, session_id: 'other-local-reader-' + id,
      prompt_id: id, hook_event_name: 'UserPromptSubmit', prompt: question } })
    return output.hookSpecificOutput?.additionalContext ?? ''
  }
  const older = await check('Which maintenance checklist did I finish two weekends ago?', 'older')
  assert.match(older, /2026-11-14.*2026-11-15.*Birch/u)
  assert.doesNotMatch(older, /Cedar|Garnet/u)
  const newer = await check('Which maintenance checklist did I finish last weekend?', 'newer')
  assert.match(newer, /2026-11-21.*2026-11-22.*Cedar/u)
  assert.doesNotMatch(newer, /Birch|Garnet/u)
})
test('both local hooks deliver every counted activity when one original describes two dates', async t => {
  const { root, owner } = fixture(t)
  const cwd = join(root, 'shared-joined-activities')
  mkdirSync(cwd)
  const key = projectIdentity(cwd).key
  const now = Date.UTC(2026, 11, 6, 12)
  const service = createLocalSharingService({ root, profileIdentity: owner.identity, projectKey: key, clock: () => now })
  t.after(() => service.close())
  const source = saveSource(root, { sessionId:'same-original', messageId:'two-activities', projectKey:key,
    text:'I attended the Bronze choir recital on 2026-11-10. I attended the Sage choir recital on 2026-11-11.',
    at:now - 1, eventTime:now - 1, timeZone:'UTC', role:'user', sourceKind:'user' })
  assert.ok(grantSourceRecall(root, readSource(root, source.id), key, { remembered:true }))
  const prompt = 'How many choir recitals did I attend in November?'
  for (const [client, handle, id] of [
    ['codex',handleCodexHook,{turn_id:'joint'}],['claude-code',handleClaudeHook,{prompt_id:'joint'}],
  ]) {
    const input = {cwd,session_id:'same-activity',...id}
    const observed = await handle({service,root,input:{...input,hook_event_name:'UserPromptSubmit',prompt}})
    const block = observed.hookSpecificOutput?.additionalContext ?? ''
    assert.match(block,/2 recorded attendances/u)
    assert.match(block,/Bronze choir recital on 2026-11-10/u)
    assert.match(block,/Sage choir recital on 2026-11-11/u)
    await handle({service,root,input:{...input,hook_event_name:'Stop',last_assistant_message:'2'}})
    const question = service.reports.get(client+':same-activity',key).questions[0]
    assert.equal(question.answerCoverage,'covered')
    assert.equal(question.injected.length,1)
    assert.match(question.injected[0].text,/Bronze[\s\S]*Sage/u)
  }
})

test('local hooks share market receipts and avoid assigning team donations to one person', async t => {
  const { root, owner } = fixture(t)
  const cwd = join(root, 'shared-personal-receipts')
  mkdirSync(cwd)
  const key = projectIdentity(cwd).key
  const at = Date.UTC(2026, 10, 25, 15)
  const service = createLocalSharingService({ root, profileIdentity: owner.identity, projectKey: key, clock: () => at + 500 })
  t.after(() => service.close())
  const sources = [
    ['cedar', 'I sold 5 jars of jam at the Cedar Market, earning $45.'],
    ['birch', 'I sold 12 baskets at the Birch Market for $5 each.'],
    ['team', 'I helped at the charity fair and we raised $1,000 for a local food bank.'],
    ['individual', 'I personally raised $250 for a local food bank during a charity event.'],
  ]
  for (const [sessionId, text] of sources) {
    const saved = saveSource(root, { sessionId, messageId: 'receipt', projectKey: key, text, at, eventTime: at,
      timeZone: 'UTC', role: 'user', sourceKind: 'user' })
    assert.ok(grantSourceRecall(root, readSource(root, saved.id), key, { remembered: true }))
  }
  const cases = [
    ['market', 'What is the total amount of money I earned from selling my products at the markets?',
      /recorded market proceeds.*\$105/u, /\$1,000/u, '$105', 'covered'],
    ['charity', 'How much money did I raise for charity in total?', /personal total is unknown/u, /\$1,000/u,
      'You raised $1,000 for charity.', 'not-injected'],
  ]
  for (const [handle, provider, ids] of [[handleCodexHook, 'codex', {turn_id:'receipt'}],
    [handleClaudeHook, 'claude-code', {prompt_id:'receipt'}]]) {
    for (const [id, prompt, expected, denied, answer, coverage] of cases) {
      const input = { cwd, session_id: 'receipts-' + id, ...ids }
      const result = await handle({ service, root, input: { ...input, hook_event_name: 'UserPromptSubmit', prompt } })
      const block = result.hookSpecificOutput?.additionalContext ?? ''
      assert.match(block, expected)
      assert.doesNotMatch(block, denied)
      await handle({ service, root, input: { ...input, hook_event_name: 'Stop', last_assistant_message: answer } })
      const report = service.reports.get(provider + ':' + input.session_id, key)
      assert.equal(report.questions[0].answerCoverage, coverage)
    }
  }
})

test('both local hooks use an original message date for days ago and revoke the checked timing answer', async t => {
  const { root, owner } = fixture(t)
  const cwd = join(root, 'shared-elapsed-event')
  mkdirSync(cwd)
  const key = projectIdentity(cwd).key
  const now = Date.UTC(2026, 3, 18, 12)
  const at = Date.UTC(2026, 3, 15, 12)
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const service = createLocalSharingService({ root, profileIdentity: owner.identity, projectKey: key, clock: () => now })
  t.after(() => service.close())
  const source = saveSource(root, { sessionId: 'dated-event', messageId: 'original', projectKey: key, at, eventTime: at, timeZone,
    text: 'I just harvested my first batch of fresh herbs from the herb garden kit today and I want to use them up!',
    role: 'user', sourceKind: 'user' })
  assert.ok(grantSourceRecall(root, readSource(root, source.id), key, { remembered: true }))
  const prompt = 'How many days ago did I harvest my first batch of fresh herbs from the herb garden kit?'
  const clients = [[handleClaudeHook, 'claude-code', { prompt_id: 'days-ago' }],
    [handleCodexHook, 'codex', { turn_id: 'days-ago' }]]
  const evidence = []
  for (const [handle, provider, ids] of clients) {
    const input = { cwd, session_id: 'dated-event', ...ids }
    const observed = await handle({ service, root, input: { ...input, hook_event_name: 'UserPromptSubmit', prompt } })
    assert.match(observed.hookSpecificOutput?.additionalContext ?? '', /3 days ago/u)
    await handle({ service, root, input: { ...input, hook_event_name: 'Stop',
      last_assistant_message: 'You harvested your first batch 3 days ago, on April 15.' } })
    const report = service.reports.get(provider + ':dated-event', key)
    assert.equal(report.questions[0].answerCoverage, 'covered')
    assert.equal(report.questions[0].injected[0].sourceRefs[0].sourceId, source.id)
    evidence.push(report.questions[0].injected[0].id)
  }
  assert.equal(evidence[0], evidence[1])
  service.forget(evidence[0], key)
  for (const [, provider] of clients) assert.equal(service.reports.get(provider + ':dated-event', key), null)
  const followup = await handleCodexHook({ service, root, input: { cwd, session_id: 'after-forget',
    turn_id: 'fresh-query', hook_event_name: 'UserPromptSubmit', prompt } })
  assert.doesNotMatch(followup.hookSpecificOutput?.additionalContext ?? '', /I just harvested|3 days ago/u)
})

test('local hooks only deliver estimated fare savings when both fares are verified', async t => {
  const { root, owner } = fixture(t)
  const cwd = join(root, 'airport-fare-workspace')
  mkdirSync(cwd)
  const projectKey = projectIdentity(cwd).key
  const now = Date.UTC(2026, 10, 26, 12)
  t.mock.method(Date, 'now', () => now)
  const service = createLocalSharingService({ root, profileIdentity: owner.identity, projectKey, clock: () => now })
  t.after(() => service.close())
  const add = (sessionId, text, key = projectKey) => {
    const src = saveSource(root, { sessionId, messageId: 'original', role: 'user', sourceKind: 'user',
      projectKey: key, text, at: now - 5000, eventTime: now - 5000, timeZone: 'UTC' })
    assert.ok(grantSourceRecall(root, readSource(root, src.id), key, { remembered: true }))
    return src.id
  }
  const taxi = add('cab', 'I was told that taking a taxi from the airport to my hotel would cost around $60.')
  add('reversed', 'I was told the bus from my hotel to the airport would cost around $19.')
  add('another-branch', 'I was told the bus from the airport to my hotel would cost around $27.', 'foreign-project')
  const prompt = 'How much will I save by taking the bus from the airport to my hotel instead of a taxi?'
  const clients = [['codex', handleCodexHook, 'turn_id'], ['claude-code', handleClaudeHook, 'prompt_id']]
  async function ask([provider, hook, field], session, reply) {
    const input = { cwd, session_id: session, [field]: session }
    const started = await hook({ service, root, input: { ...input, hook_event_name: 'UserPromptSubmit', prompt } })
    const context = started.hookSpecificOutput?.additionalContext ?? ''
    await hook({ service, root, input: { ...input, hook_event_name: 'Stop', last_assistant_message: reply } })
    return { context, report: service.reports.get(provider + ':' + session, projectKey) }
  }
  for (const client of clients) {
    const partial = await ask(client, 'partial', 'Savings cannot be calculated because the bus fare is missing.')
    assert.match(partial.context, /savings cannot be calculated.*verified bus fare/isu)
    assert.doesNotMatch(partial.context, /\$(?:60|19|27)\b/u)
    assert.equal(partial.report.quantityCheck?.result, null)
    assert.equal(partial.report.quantityCheck?.answerCoverage, 'no-evidence')
    assert.equal(partial.report.questions[0].notInjected[0].sourceRefs[0].sourceId, taxi)
    assert.ok(partial.report.questions.every(question => !question.injected.length))
  }
  const bus = add('bus', 'I was told that taking the bus from the airport to my hotel would cost around $12.')
  let deliveredBus
  for (const client of clients) {
    const complete = await ask(client, 'complete', 'You would save about $48 by taking the bus instead of the taxi.')
    assert.match(complete.context, /≈ \$48/u)
    assert.doesNotMatch(complete.context, /\$(?:19|27)\b/u)
    assert.equal(complete.report.quantityCheck?.result, '48')
    assert.equal(complete.report.quantityCheck?.answerCoverage, 'covered')
    const row = complete.report.questions.flatMap(question => question.injected).find(item => item.sourceRefs[0].sourceId === bus)
    assert.ok(row)
    deliveredBus = row.id
  }
  service.forget(deliveredBus, projectKey)
  for (const client of clients) {
    assert.equal(service.reports.get(client[0] + ':complete', projectKey), null)
    const rejected = await ask(client, 'after-forget', 'You would save about $60.')
    assert.match(rejected.context, /savings cannot be calculated/u)
    assert.doesNotMatch(rejected.context, /\$(?:60|12)\b/u)
    assert.equal(rejected.report.quantityCheck?.answerCoverage, 'unverified')
  }
  add('first-quote', 'I was told that taking the bus from the airport to my hotel would cost around $11.')
  add('second-quote', 'I was told that taking the bus from the airport to my hotel would cost around $15.')
  for (const client of clients) {
    const conflict = await ask(client, 'conflicting-fares', 'I found conflicting bus estimates and cannot calculate the savings.')
    assert.match(conflict.context, /the recorded bus fare estimates conflict/iu)
    assert.doesNotMatch(conflict.context, /\$\d/u)
    assert.equal(conflict.report.quantityCheck?.result, null)
  }
})
