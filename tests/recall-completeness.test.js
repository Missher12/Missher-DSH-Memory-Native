import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'
import { apply } from '../index.js'
import { buildRecord } from '../host/records.js'
import { projectIdentity, scopePaths } from '../host/paths.js'
import { recallQueryPlan, recallSubjectTerms } from '../host/recall.js'
import { blockSourceRecall, readSource, saveSource } from '../host/capture-journal.js'
import { grantSourceRecall } from '../host/source-passages.js'
import { assessAnswerCoverage } from '../host/answer-coverage.js'
import { declaredCountQuery, matchesDeclaredCountAnswer } from '../host/declared-count.js'
import { describeQuantities, quantityEvidence, quantityRecallPlan, quantityResultCovered, unsupportedQuantityResult } from '../host/quantity-recall.js'
import { matchesEventCountAnswer } from '../host/event-count-recall.js'
import { calendarComparison, calendarEventEvidence, calendarIntervalFromProofs, formatCalendarInterval, matchesCalendarAnswer } from '../host/calendar-recall.js'

test('weeks since a personal event bind both dates to the observed actions and ordinal', () => {
  const asked = 'How many weeks had passed since I recovered from the flu when I went on my 10th jog outdoors?'
  const plan = calendarComparison(asked)
  assert.deepEqual(plan?.events, ['the day I recovered from the flu', 'the day I went on my 10th jog outdoors'])
  const earlier = Date.UTC(2023, 0, 19, 13), later = Date.UTC(2023, 3, 10, 15)
  const prove = (position, content, at) => calendarEventEvidence({ kind: 'source', content, sourceRefs: [{
    sourceId: 'unit-source', role: 'user', sourceKind: 'user', excerpt: content, from: 0, to: content.length,
    eventTime: at, timeZone: 'UTC',
  }] }, plan.events[position], undefined, { personalSince: true, allowReturnBounds: true })
  const recovery = prove(0, "I'm feeling better now that I finally recovered from the flu today.", earlier)
  const run = prove(1, 'I went on my 10th jog outdoors today.', later)
  const result = calendarIntervalFromProofs(plan, [[recovery], [run]])
  assert.equal(result?.days, 81)
  assert.match(formatCalendarInterval(result), /11 weeks and 4 days \(81 days\)/u)
  assert.equal(matchesCalendarAnswer('Eleven weeks and four days had passed.', result), true)
  assert.equal(matchesCalendarAnswer('You recovered from the flu by January 19, 2023. You went on your 10th jog outdoors on April 10, 2023. Therefore, 81 days had passed, which is equivalent to 11 weeks and 4 days.', result), true)
  assert.equal(matchesCalendarAnswer('You recovered from the flu on January 19, 2023 and went on your 10th jog outdoors on April 10, 2023. 81 days.', result), true)
  assert.equal(matchesCalendarAnswer('You recovered from the flu on January 20, 2023 and went on your 10th jog outdoors on April 10, 2023. 81 days.', result), false)
  assert.equal(matchesCalendarAnswer('You recovered from the flu on January 19, 2023 and went on your 10th jog outdoors on April 11, 2023. 81 days.', result), false)
  assert.equal(matchesCalendarAnswer('You recovered from the flu on April 10, 2023 and went on your 10th jog outdoors on January 19, 2023. 81 days.', result), false)
  assert.equal(matchesCalendarAnswer('Your 10th jog outdoors was 81 days after you recovered from the flu.', result), true)
  assert.equal(matchesCalendarAnswer('Fifteen weeks had passed.', result), false)
  assert.equal(matchesCalendarAnswer('81 days had passed since you went on your 10th jog outdoors when you recovered from the flu.', result), false)
  assert.equal(matchesCalendarAnswer('You recovered from the flu 11 weeks and 4 days after your 10th jog outdoors.', result), false)
  assert.equal(matchesCalendarAnswer('The 10th jog outdoors happened 81 days before you recovered from the flu.', result), false)
  assert.equal(matchesCalendarAnswer('From your 10th jog outdoors to your recovery from the flu, 81 days passed.', result), false)
  assert.equal(matchesCalendarAnswer('At least 81 days had passed from recovery from the flu to your 10th jog outdoors.', result), false)
  assert.equal(matchesCalendarAnswer('It was 3.5 weeks, or 81 days.', result), false)
  assert.equal(calendarIntervalFromProofs(plan, [[run], [recovery]]), null)
  assert.equal(calendarIntervalFromProofs(plan, [[recovery], []]), null)
  for (const [position, content, at] of [
    [0, 'I recovered from a cold today after my brother recovered from the flu.', earlier],
    [0, 'I recovered from the flu vaccine today.', earlier],
    [0, 'We recovered from the flu today.', earlier],
    [0, 'I planned to recover from the flu today.', earlier],
    [1, 'I went on my 9th jog outdoors today after my friend went on her 10th jog outdoors.', later],
    [1, 'I went on my 9th jog outdoors today.', later],
    [1, 'I went on my 10th jog outdoors on April 12, 2023.', later],
    [1, 'I went on my 10th jog outdoors last week but today I took it easy.', later],
  ]) assert.equal(prove(position, content, at), null, content)
})

test('an exact week interval does not validate an unresolved range or remainder', () => {
  const events = ['the day I recovered from the flu', 'the day I went on my 10th jog outdoors']
  const result = { events, dates: ['2023-04-03', '2023-04-10'], days: 7, unit: 'weeks' }
  assert.equal(matchesCalendarAnswer('One week had passed.', result), true)
  assert.equal(matchesCalendarAnswer('Seven days had passed.', result), true)
  assert.equal(matchesCalendarAnswer('One week and a few days had passed.', result), false)
  assert.equal(matchesCalendarAnswer('Zero or one week had passed.', result), false)
  assert.equal(matchesCalendarAnswer('Between zero and one week had passed.', result), false)
})

test('personal elapsed-time rephrasing retains the two dates and recognizes week conversion', () => {
  const prompts = [
    'When I went on my 10th jog outdoors, how many weeks had passed since I recovered from the flu?',
    'How many weeks had elapsed since I recovered from the flu when I went on my 10th jog outdoors?',
    'How many days had gone by since I recovered from the flu when I went on my 10th jog outdoors?',
    'How many weeks elapsed between the day I went on my 10th jog outdoors and the day I recovered from the flu?',
  ]
  const events = ['the day I recovered from the flu', 'the day I went on my 10th jog outdoors']
  const day = iso => Date.parse(iso + 'T00:00:00Z') / 86_400_000
  const dates = [day('2023-01-19'), day('2023-04-10')]
  for (const [position, prompt] of prompts.entries()) {
    const plan = calendarComparison(prompt)
    assert.equal(plan?.requiresBothDates, true, prompt)
    const reversed = position === prompts.length - 1
    assert.deepEqual(plan.events, reversed ? [...events].reverse() : events)
    assert.equal(plan.ordered, !reversed)
    const proofs = (reversed ? [...dates].reverse() : dates).map(value => [{ day: value, days: [value] }])
    const result = calendarIntervalFromProofs(plan, proofs)
    assert.equal(result.days, 81)
    assert.deepEqual(result.events, events)
    assert.equal(calendarIntervalFromProofs(plan, [proofs[0], []]), null)
    if (position === 2) {
      assert.equal(matchesCalendarAnswer('81 days had gone by.', result), true)
      continue
    }
    assert.equal(matchesCalendarAnswer('There are 7 days in a week. 81 days equals 11 weeks and 4 days.', result), true)
    assert.equal(matchesCalendarAnswer('There are 8 days per week. 81 days equals 11 weeks and 4 days.', result), false)
    assert.equal(matchesCalendarAnswer('There are 7 days in a week. 81 days or 12 weeks had passed.', result), false)
  }
})

const versions = [['pnpm','9.12.3'],['Node','22.13.1'],['Redis','7.2.4'],['PostgreSQL','16.3'],
  ['Vite','8.5.1'],['React','19.2.1'],['TypeScript','5.8.2'],['Vitest','3.1.4']]
const question = `琥珀项目的 ${versions.map(([name])=>name).join('、')} 版本分别是多少？`

async function setup(t, inject = {}, fixtureContents = null, prepare, sessionQuery) {
  const root=mkdtempSync(join(tmpdir(),'memory-completeness-')),cwd=join(root,'project'),dataDir=join(root,'data')
  const key=projectIdentity(cwd).key, loc=scopePaths(dataDir,'project',key), handlers={},disposers=[]
  mkdirSync(loc.dir,{recursive:true})
  const contents=fixtureContents ?? [...versions.map(([name,version])=>`琥珀项目的 ${name} 版本是 ${version}。`),
    ...Array.from({length:50},(_,i)=>`无关仓储零件编号为 STOCK-${i}。`)]
  const rows=contents.map((item,i)=>{
    const fixture=typeof item==='string'?{content:item}:item
    const built=buildRecord({scope:'project',projectKey:key,kind:'fact',confidence:.95,...fixture},{id:`mem_complete_${i}`,now:Date.now()})
    assert.ok(built.ok)
    return {...built.record,status:fixture.status??'active'}
  })
  writeFileSync(loc.file,rows.map(row=>JSON.stringify(row)).join('\n')+'\n')
  prepare?.(dataDir, key, cwd)
  let routeReady
  const ready=new Promise(resolve=>{routeReady=resolve})
  const sessions={get:id=>id==='new-session'?{id,header:{cwd}}:undefined}
  apply({get:name=>name==='webServer'?{register(route){routeReady(route);return()=>{}}}:name==='sessions'?sessions:
    name==='sessionQuery'?sessionQuery:undefined,
    on:(name,handler)=>{handlers[name]=handler;return()=>{}},
    effect:factory=>{const dispose=factory();if(typeof dispose==='function')disposers.push(dispose)},
    logger:{warn(){},info(){},debug(){}}},
    {dataDir,capture:{enabled:false},maintenance:{enabled:false},obsidian:{autoSync:false},inject:{maxTokens:600,...inject}})
  const route=await ready
  t.after(()=>{for(const dispose of disposers.reverse())dispose();rmSync(root,{recursive:true,force:true})})
  return async(query=question, clientTimeZone, submission)=>{
    const messages=[{id:submission?.id??'question',role:'user',source:{kind:'user',clientTimeZone},content:query}]
    if (submission) {
      await handlers['session/event'](sessions.get('new-session'), {
        type:'agent/inbox/spliced',time:submission.at,seq:1,data:{inserted:messages},
      })
    }
    const response=await handlers['agent/pre-step']({agent:{session:{id:'new-session',header:{cwd}}},messages},async()=>({kind:'enter',messages}))
    const block=response.messages.filter(m=>m.source?.kind==='memory').flatMap(m=>m.content.map(b=>b.text)).join('\n')
    let stats
    const request=Readable.from([Buffer.from(JSON.stringify({method:'stats',input:{scope:'project',projectKey:key,sessionId:'new-session'}}))]);request.method='POST'
    await route.handler(request,{writeHead(){},end(body){const reply=JSON.parse(body);assert.equal(reply.ok,true);stats=reply.value}})
    return {block,report:stats.lastRecall}
  }
}

test('ordinary English questions retain named subjects and recover factual clauses before a conversational question', async t => {
  const poster = 'I presented my Ironside project poster inside Juniper campus.'
  const play = 'The play I attended at Arbor Hall was Cedar Glass'
  let storedRoot, project, posterId, playId
  const ask = await setup(t, {}, [], (root, projectKey) => {
    storedRoot = root
    project = projectKey
    function remember(messageId, text, scope = projectKey) {
      const { id } = saveSource(root, { sessionId: 'ordinary-project-chat', messageId, text,
        projectKey: scope, role: 'user', sourceKind: 'user', eventTime: Date.now() - 1000 })
      assert.ok(grantSourceRecall(root, readSource(root, id), scope, { remembered: true }))
      return id
    }
    posterId = remember('poster', poster)
    playId = remember('play', 'The venue opened early. ' + play + ', have you heard of it?')
    remember('other-subject', 'I presented my Northfield project poster inside Cedar Hill campus.')
    remember('conditional', 'That tour is over. If I attended a play at Arbor Hall, could you guess the title Frost Vale?')
    remember('other-project', 'The play I attended at Arbor Hall was Silver River.', 'other-project')
  })
  const first = await ask('At which campus did I present my Ironside project poster?')
  assert.match(first.block, /Juniper campus/u)
  assert.doesNotMatch(first.block, /Cedar Hill/u)
  assert.equal(first.report.questions[0].injected[0].sourceRefs[0].sourceId, posterId)
  const second = await ask('Which play did I attend at Arbor Hall?')
  assert.match(second.block, new RegExp(play, 'u'))
  assert.doesNotMatch(second.block, /heard of it|Frost Vale|Silver River/u)
  assert.equal(second.report.questions[0].injected[0].sourceRefs[0].sourceId, playId)
  blockSourceRecall(storedRoot, { projectKey: project, sourceRefs: [{ sourceId: playId }] })
  const after = await ask('Which play did I attend at Arbor Hall?')
  assert.doesNotMatch(after.block, /Cedar Glass|Frost Vale|Silver River/u)
})

test('the previous value can be verified directly from a recorded change in ordinary chat', async t => {
  const now = Date.UTC(2026, 10, 25, 14)
  t.mock.method(Date, 'now', () => now)
  const original = "I just changed my last name and I'm still getting used to it, my old name was Harbor, but now it's Lumen."
  let root, chosen
  const ask = await setup(t, {}, [], (data, key) => {
    root = data
    const add = (name, text, project = key, at = now - 86400_000) => durationSource(data, project, name, text, at)
    chosen = add('change', 'Do you have advice about paperwork? ' + original)
    add('current-only', 'My last name is Slate.')
    add('someone-else', "My coworker's previous last name was Grantham.")
    add('conditional', 'If I changed my last name from Moss to Amber, it would be a surprise.')
    add('unbound', "My old name was Valley, but now it's Canyon.")
    add('foreign', 'I changed my last name from Indigo to Merrow.', 'other-project')
    add('future', 'I changed my last name from Bay to Cove.', key, now + 86400_000)
  })
  const prompt = 'What was my last name before I changed it?'
  const { block, report } = await ask(prompt, 'UTC')
  assert.ok(block.includes(original))
  assert.doesNotMatch(block, /Slate|Grantham|Moss|Valley|Indigo|Bay/u)
  assert.deepEqual(report.questions[0].injected.flatMap(hit => hit.sourceRefs.map(ref => ref.sourceId)), [chosen])
  assert.ok(report.questions[0].injected.every(hit => hit.verified))
  assert.equal(assessAnswerCoverage(report.questions[0], 'Your previous last name was Harbor.').answerCoverage, 'covered')
  assert.equal(assessAnswerCoverage(report.questions[0], 'Your previous last name was Lumen.').answerCoverage, 'unverified')
  assert.equal(assessAnswerCoverage(report.questions[0], 'Your last name is Harbor now.').answerCoverage, 'unverified')
  assert.equal(assessAnswerCoverage(report.questions[0], 'Your old last name before you changed it was Harbor.').answerCoverage, 'covered')
  assert.equal(assessAnswerCoverage(report.questions[0], 'Your previous last name was Harbor; your former last name was Quartz.').answerCoverage, 'unverified')
  blockSourceRecall(root, { sourceRefs: [{ sourceId: chosen }] })
  assert.equal((await ask(prompt, 'UTC')).block, '')
})

test('a past work role inside a mixed message remains usable and conflicting prior values stay unresolved', async t => {
  const now = Date.UTC(2026, 10, 25, 14)
  t.mock.method(Date, 'now', () => now)
  let chosen
  const ask = await setup(t, {}, [], (root, key) => {
    const add = (name, text) => durationSource(root, key, name, text, now - 86400_000)
    chosen = add('old-role', "I've used Tally in my previous role as a lab technician at a small startup and I'm familiar with its features. Can you explain its calendar?")
    add('volunteer', "I used it in my previous volunteer role as a literacy tutor.")
    add('quoted-script', 'The demo script reads: my previous job was a pilot.')
    add('new-job', 'I am currently a studio assistant.')
    add('label-a', 'My previous archive label was Birch Stable.')
    add('label-b', 'My previous archive label was Birch Classic.')
    add('known-name', 'My previous cabinet label was Lantern.')
    add('elaborated-statement', "I read about newer tools, which was a shift from my previous view on automation - I used to prefer manual review, but I've been trying other options.")
    add('same-line-dispute', 'My old sync mode was Light; my former sync mode was Turbo.')
    add('another-report', 'My previous sync mode was Light.')
  })
  const work = await ask('What was my previous occupation?', 'UTC')
  assert.match(work.block, /lab technician at a small startup/u)
  assert.doesNotMatch(work.block, /studio assistant|literacy tutor|pilot|explain its calendar/u)
  assert.deepEqual(work.report.questions[0].injected.flatMap(hit => hit.sourceRefs.map(ref => ref.sourceId)), [chosen])
  assert.equal(assessAnswerCoverage(work.report.questions[0], 'You were a lab technician at a small startup.').answerCoverage, 'covered')
  assert.equal(assessAnswerCoverage(work.report.questions[0], 'Your previous occupation was a lab technician at a small startup. You were familiar with Tally.').answerCoverage, 'covered')
  const elaborated = await ask('What was my previous view on automation?', 'UTC')
  assert.match(elaborated.block, /I used to prefer manual review/u)
  const conflict = await ask('What was my previous archive label?', 'UTC')
  assert.equal(conflict.block, '')
  assert.equal(conflict.report.questions[0].injected.length, 0)
  assert.equal((await ask('What was my previous sync mode?', 'UTC')).block, '')
  assert.doesNotMatch((await ask('What was my cabinet label as of 2026-11-21?', 'UTC')).block, /Lantern/u)
  assert.ok(recallQueryPlan('What was my previous cabinet label as of 2026-11-21?').every(plan => !plan.stateField))
})

test('an explicitly recorded before and after value can answer two Chinese slots without swapping their coverage', async t => {
  const now = Date.UTC(2026, 10, 25, 14)
  t.mock.method(Date, 'now', () => now)
  const original = '我把构建通道从青桥稳定改成云桥预览。'
  let chosen
  const ask = await setup(t, {}, [], (root, key) => {
    const add = (name, text, project = key) => durationSource(root, project, name, text, now - 86400_000)
    chosen = add('confirmed-switch', '插件的迁移已经核对了。' + original)
    add('different-field', '我把发布频道从松岭改成霁白。')
    add('considered', '我打算把构建通道从落雨改成茉莉。')
    add('quoted-script', '同事的测试稿写着：我的构建通道原来是临时通道。')
    add('someone-else', '同事把构建通道从苍岚改成静水。')
    add('other-project', '我把构建通道从雪岭改成烟火。', 'other-project')
  })
  const full = await ask('我的构建通道原来和现在分别是什么？', 'Asia/Shanghai')
  assert.ok(full.block.includes(original))
  assert.doesNotMatch(full.block, /松岭|落雨|临时通道|苍岚|雪岭/u)
  assert.deepEqual(full.report.questions.map(slot => slot.injected.map(hit => hit.sourceRefs[0].sourceId)), [[chosen], [chosen]])
  const check = answer => full.report.questions.map(slot => assessAnswerCoverage(slot, answer, full.report.questions).answerCoverage)
  assert.deepEqual(check('构建通道原来是青桥稳定，现在是云桥预览。'), ['covered', 'covered'])
  assert.deepEqual(check('根据记忆，您的构建通道原来是在“青桥稳定”状态，现在是“云桥预览”状态。'), ['covered', 'covered'])
  assert.deepEqual(check('构建通道原来是云桥预览，现在是青桥稳定。'), ['unverified', 'unverified'])
})

test('previous state is withheld when comma-separated values disagree', async t => {
  const eventTime = Date.now() - 86400_000
  const ask = await setup(t, {}, [], (root, key) => {
    durationSource(root, key, 'english-conflict',
      'My previous sync mode was Light, my former sync mode was Turbo.', eventTime)
    durationSource(root, key, 'chinese-conflict',
      '我的构建通道原来是青桥稳定，我的构建通道之前是云桥预览。', eventTime, 'Asia/Shanghai')
  })

  for (const prompt of ['What was my previous sync mode?', '我的构建通道原来是什么？']) {
    await t.test(prompt, async () => {
      const { block, report } = await ask(prompt, 'Asia/Shanghai')
      assert.equal(block, '')
      assert.equal(report.questions[0].injected.length, 0)
    })
  }
})

test('verified previous state does not mark a conflicting answer covered', async t => {
  const ask = await setup(t, {}, [], (root, key) => {
    durationSource(root, key, 'same-value',
      'My previous sync mode was Light, my former sync mode was Light.', Date.now() - 86400_000)
  })
  const { block, report } = await ask('What was my previous sync mode?', 'UTC')
  assert.match(block, /My previous sync mode was Light/u)
  const grade = answer => assessAnswerCoverage(report.questions[0], answer).answerCoverage
  assert.equal(grade('Your previous sync mode was Light, your former sync mode was Light.'), 'covered')
  assert.equal(grade('Your previous sync mode was Light, your former sync mode was Turbo.'), 'unverified')
})

test('typed fields can cite an adjacent sentence that refers to the same snapshot in one original message', async t => {
  const now = Date.UTC(2026, 10, 25, 14)
  t.mock.method(Date, 'now', () => now)
  let root, originalId
  const original = '灰桦快照已完成调整。它每天凌晨3点执行，保留37天，因为旧窗口只覆盖到上月末。'
  const ask = await setup(t, {}, [], (data, key) => {
    root = data
    const add = (name, text, project = key) => durationSource(data, project, name, text, now - 86400_000)
    originalId = add('confirmed-reference', original)
    add('mixed-subjects', '灰桦快照和白桦快照都已定版。它每天凌晨1点执行，保留26天。')
    add('intervening-subject', '灰桦快照已定版。松塔快照刚上线。它每天凌晨6点执行，保留11天。')
    add('uncertain-change', '灰桦快照刚讨论过。它可能在凌晨8点执行，请按保留17天试算。')
    add('incompatible-type', '灰桦快照已定版。该系统每天凌晨9点执行，保留19天。')
    add('other-project', '灰桦快照刚完成调整。它每天凌晨5点执行，保留61天。', 'another-project')
  })
  const question = '灰桦快照每天几点执行，灰桦快照保留多久，灰桦快照为什么改？'
  const full = await ask(question, 'Asia/Shanghai')
  assert.match(full.block, /灰桦快照已完成调整。它每天凌晨3点执行，保留37天，因为旧窗口只覆盖到上月末。/u)
  assert.match(full.block, /修改原因单独用「因为」说明，其余只报原话的值。/u)
  assert.doesNotMatch(full.block, /凌晨[15689]点|保留(?:26|11|17|19|61)天/u)
  assert.deepEqual(full.report.questions.map(slot => slot.injected.map(hit => hit.sourceRefs[0].sourceId)), [[originalId], [originalId], [originalId]])
  assert.ok(full.report.questions.every(slot => slot.injected.every(hit => hit.text.includes(original))))
  blockSourceRecall(root, { sourceRefs: [{ sourceId: originalId }] })
  const forgotten = await ask(question, 'Asia/Shanghai')
  assert.doesNotMatch(forgotten.block, /凌晨3点|37天|旧窗口只覆盖/u)
  assert.equal(forgotten.report.questions.every(slot => slot.injected.length === 0), true)
})

test('personal education recall requires completed study, matching level and field, and a stated institution', async t => {
  const now = Date.UTC(2026, 10, 25, 14)
  t.mock.method(Date, 'now', () => now)
  let selected
  const teaching = 'I completed my undergrad in CS at Pine Creek University.'
  const ask = await setup(t, {}, [], (root, key) => {
    const add = (name, text, scope = key) => durationSource(root, scope, name, text, now - 86400_000)
    selected = add('completed', teaching)
    assert.ok(grantSourceRecall(root, readSource(root, selected), key, { remembered: true }))
    add('different-level', "I completed my master's degree in Computer Science at Shale University.")
    add('different-major', "I completed my Bachelor's degree in Data Science at Red Cedar University.")
    add('plan-only', "I'm planning to complete my Bachelor's degree in Computer Science at Indigo University.")
    add('someone-else', "My teammate completed her Bachelor's degree in Computer Science at Trout University.")
    add('fiction', "In my novel, I completed my Bachelor's degree in Computer Science at Granite University.")
    add('foreign', 'I completed my undergrad in CS at Blue Peak University.', 'unrelated-project')
  })
  const result = await ask("Where did I complete my Bachelor's degree in Computer Science?", 'UTC')
  assert.match(result.block, /Pine Creek University/u)
  assert.doesNotMatch(result.block, /Shale University|Red Cedar University|Indigo University|Trout University|Blue Peak University|Granite University/u)
  const slot = result.report.questions[0]
  assert.deepEqual(slot.injected[0].sourceRefs.map(ref => ref.sourceId), [selected])
  assert.equal(slot.injected[0].verified, true)
  const correct = "You completed your Bachelor's degree in Computer Science at Pine Creek University."
  assert.deepEqual(assessAnswerCoverage(slot, correct), { answerCoverage: 'covered', answerExcerpt: correct })
  assert.equal(assessAnswerCoverage(slot, 'Pine Creek University.').answerCoverage, 'covered')
  assert.equal(assessAnswerCoverage(slot, "You finished your Master's degree in Computer Science at Pine Creek University.").answerCoverage, 'unverified')
  assert.equal(assessAnswerCoverage(slot, "You did not finish your Bachelor's degree in Computer Science at Pine Creek University.").answerCoverage, 'unverified')
  assert.equal(assessAnswerCoverage(slot, "Pine Creek University. You didn't complete your degree at Pine Creek University.").answerCoverage, 'unverified')
  assert.equal(assessAnswerCoverage(slot, correct + " You also completed your Bachelor's in CS at Indigo University.").answerCoverage, 'unverified')
})

test('personal gift recall keeps the actual gift tied to the requested recipient and occasion', async t => {
  const now = Date.UTC(2026, 10, 25, 14)
  t.mock.method(Date, 'now', () => now)
  let selected, root
  const actual = "For my sister's birthday, I got her a red wool scarf."
  const ask = await setup(t, {}, [], (data, key) => {
    root = data
    const add = (name, text) => durationSource(data, key, name, text, now - 86400_000)
    selected = add('present', actual)
    add('list', "I've bought gifts for my sister's birthday, my mom, my neighbor, and my brother.")
    add('unspecified', "I bought several nice gifts for my sister's birthday.")
    add('different-occasion', "I bought a blue handbag for my sister's graduation.")
    add('different-recipient', "I bought a green camera for my cousin's birthday.")
    add('future', "I am planning to buy a yellow backpack for my sister's birthday.")
  })
  const question = "What did I buy for my sister's birthday gift?"
  const result = await ask(question, 'UTC')
  assert.match(result.block, /red wool scarf/u)
  assert.doesNotMatch(result.block, /bought gifts|several nice gifts|blue handbag|green camera|yellow backpack/u)
  assert.deepEqual(result.report.questions[0].injected[0].sourceRefs.map(ref => ref.sourceId), [selected])
  assert.equal((await ask("What did I buy for my uncle's birthday gift?", 'UTC')).block, '')
  blockSourceRecall(root, { sourceRefs: [{ sourceId: selected }] })
  assert.equal((await ask(question, 'UTC')).block, '')
})

test('received birthday gifts cannot borrow the giver from another family member', async t => {
  const now = Date.UTC(2026, 10, 25, 13)
  t.mock.method(Date, 'now', () => now)
  const ask = await setup(t, {}, [
    "I got a stand mixer as a birthday gift from my sister.",
  ], (root,key) => {
    durationSource(root, key, 'sister-mixer', "I got a stand mixer as a birthday gift from my sister.", now - 3000)
    durationSource(root, key, 'fathers-birthday', "I got my father a blue camera for his birthday.", now - 2000)
    durationSource(root, key, 'fathers-anniversary', "My father gave me a small telescope for my anniversary.", now - 1000)
  })
  for (const question of ['What did my dad give me as a birthday gift?', 'What did my dad gave me as a birthday gift?',
    'What birthday gift did I get from my dad?']) {
    const result = await ask(question, 'UTC')
    const slot = result.report.questions[0]
    assert.deepEqual(slot.injected, [])
    assert.doesNotMatch(result.block, /stand mixer|blue camera|small telescope/u)
    const outcome = assessAnswerCoverage(slot, 'Your dad did not give you a birthday gift. Your sister gave you a stand mixer.')
    assert.notEqual(outcome.answerCoverage, 'covered')
  }
})

test('a received gift answer requires the item, giver and occasion to agree', async t => {
  const now = Date.UTC(2026, 10, 25, 13)
  t.mock.method(Date, 'now', () => now)
  let expected
  const asked = 'What did my dad give me as a birthday gift?'
  const ask = await setup(t, {}, [], (root,key) => {
    expected = durationSource(root, key, 'dad-scarf', 'My father gave me a red wool scarf for my birthday.', now - 3000)
    durationSource(root, key, 'sister-gloves', 'My sister gave me green gloves for my birthday.', now - 2000)
    durationSource(root, key, 'dad-conditional', 'If my father gave me a yellow backpack for my birthday, I would use it.', now - 2000)
    durationSource(root, key, 'wrong-birthday', 'My father gave me a blue backpack for my uncle’s birthday.', now - 1000)
    durationSource(root, 'foreign', 'outside', 'My father gave me a green camera for my birthday.', now - 1000)
  })
  const result = await ask(asked, 'UTC')
  const slot = result.report.questions[0]
  assert.deepEqual(slot.injected.map(hit => hit.sourceRefs[0].sourceId), [expected])
  const grade = answer => assessAnswerCoverage(slot,answer).answerCoverage
  assert.equal(grade('Your dad gave you a red wool scarf for your birthday.'), 'covered')
  assert.equal(grade('A red wool scarf.'), 'covered')
  for (const answer of [
    'Your sister gave you a red wool scarf.',
    'Your dad did not give you anything. Your sister gave you a red wool scarf.',
    'Your dad gave me a red wool scarf.',
    'Your dad gave you a wool scarf and a blue backpack.',
    'Your dad gave you a red wool scarf for your anniversary.',
  ]) assert.equal(grade(answer), 'unverified', answer)
})

test('coverage cannot back a gift from the wrong giver by matching item words', () => {
  const selectedQuote = "I actually got my new stand mixer as a birthday gift from my sister last month, and it's been a game-changer for making caramel."
  const report = {
    query:'What did my dad gave me as a birthday gift',
    injected:[{ kind:'source', verified:true, text:'- [Original] '+selectedQuote, selectedQuote }],
  }
  const answer = 'Based on the information provided, your dad did not give you a birthday gift. Your sister gave you a new stand mixer as a birthday gift, which has been helpful for making caramel.'
  assert.equal(assessAnswerCoverage(report, answer).answerCoverage, 'unverified')
})

test('an earlier mistaken description is matched to the thing that was actually recorded', async t => {
  const now = Date.UTC(2026, 10, 25, 14)
  t.mock.method(Date, 'now', () => now)
  let selected
  const ask = await setup(t, {}, [], (root, key) => {
    const add = (name, text) => durationSource(root, key, name, text, now - 86400_000)
    selected = add('condition', 'I recently had bronchitis, which I initially thought was just a cold.')
    add('wrong-object', 'I had an allergic reaction, which I thought was just a rash.')
    add('third-person', 'My teammate had a migraine, which she initially thought was just a cold.')
    add('hypothesis', 'This is an example. If I had the flu, I might think it was just a cold.')
  })
  const result = await ask('What health issue did I initially think was just a cold?', 'UTC')
  assert.match(result.block, /bronchitis/u)
  assert.doesNotMatch(result.block, /allergic reaction|migraine|flu/u)
  assert.deepEqual(result.report.questions[0].injected[0].sourceRefs.map(ref => ref.sourceId), [selected])
})

test('an adjacent reference preserves an English device attribute without joining different messages', async t => {
  const now = Date.UTC(2026, 10, 25, 14)
  t.mock.method(Date, 'now', () => now)
  let display
  const original = 'I finished setting up my Alder TV. Its screen measures 42 inches.'
  const ask = await setup(t, {}, [], (data, key) => {
    const add = (name, text) => durationSource(data, key, name, text, now - 86400_000)
    display = add('one-device', original)
    add('two-devices', 'I set up the Alder TV and the Juniper TV. Its screen measures 73 inches.')
    add('title-only', 'I also checked my Alder TV.')
    add('attribute-only', 'Its screen measures 86 inches.')
    add('old', 'I checked my Alder TV. It used to have a 32-inch screen.')
    add('purchase-intent', 'I am considering replacing my Alder TV. It might be a 64-inch model.')
    add('negated', 'I inspected my Alder TV. It does not have a 69-inch display.')
  })
  const result = await ask('What size is my new Alder TV?', 'UTC')
  assert.ok(result.block.includes(original))
  assert.doesNotMatch(result.block, /\b(?:32|64|69|73|86)\b/u)
  assert.deepEqual(result.report.questions[0].injected[0].sourceRefs.map(ref => ref.sourceId), [display])
  assert.equal(result.report.questions[0].injected[0].verified, false)
})

test('a past event can use the original dated statement without treating it as an effective setting', async t => {
  t.mock.method(Date, 'now', () => Date.UTC(2026, 10, 22, 2))
  let remembered
  const ask = await setup(t, {}, [], (root, projectKey) => {
    const add = (messageId, text, at, timeZone = 'UTC', scope = projectKey) => {
      const source = saveSource(root, { sessionId: 'earlier-chat', messageId, projectKey: scope,
        role: 'user', sourceKind: 'user', text, eventTime: at, at, timeZone })
      assert.ok(grantSourceRecall(root, readSource(root, source.id), scope, { remembered: true }))
      return source.id
    }
    remembered = add('matching', 'I inspected the bronze valve WX-719 last month.', Date.UTC(2026, 10, 3))
    add('outside', 'I inspected the bronze valve WX-104 yesterday.', Date.UTC(2026, 10, 3))
    add('undated-event', 'I inspected the bronze valve WX-975.', Date.UTC(2026, 9, 14))
    add('planned', 'I planned to inspect the bronze valve WX-966 last month.', Date.UTC(2026, 10, 3))
    add('wrong-clause', 'I inspected the bronze valve WX-311, and last month I replaced the filter.', Date.UTC(2026, 10, 3))
    add('another-person', 'I met the colleague who inspected the bronze valve WX-544 last month.', Date.UTC(2026, 10, 3))
    add('outside-bound', 'I inspected the bronze valve WX-503 before last month.', Date.UTC(2026, 10, 3))
    add('future-message', 'I inspected the bronze valve WX-599 last month.', Date.UTC(2026, 10, 30))
    add('chinese', '我上个月检查了青铜阀门 HV-972。', Date.UTC(2026, 10, 3))
    add('foreign', 'I inspected the bronze valve WX-401 last month.', Date.UTC(2026, 10, 3), 'UTC', 'foreign-workspace')
    const revoked = add('forgotten', 'I inspected the bronze valve WX-683 last month.', Date.UTC(2026, 10, 3))
    blockSourceRecall(root, { sourceRefs: [{ sourceId: revoked }] })
  })
  const { block, report } = await ask('Which bronze valve did I inspect last month?', 'UTC')
  assert.match(block, /WX-719/u)
  assert.doesNotMatch(block, /WX-(?:104|975|966|311|544|503|599|401|683)|时有效/u)
  assert.deepEqual(report.questions.flatMap(slot => slot.injected.flatMap(hit => hit.sourceRefs.map(ref => ref.sourceId))), [remembered])
  assert.match((await ask('我上个月检查了什么阀门？', 'UTC')).block, /HV-972/u)
})

test('a question about a personal event uses the client civil day and keeps effective-time queries separate', async t => {
  t.mock.method(Date, 'now', () => Date.UTC(2026, 10, 22, 23, 30))
  const ask = await setup(t, {}, [], (root, projectKey) => {
    const recent = Date.UTC(2026, 10, 16, 1)
    const source = saveSource(root, { sessionId: 'old-chat', messageId: 'one', projectKey,
      role: 'user', sourceKind: 'user', text: 'I finished the cedar maintenance checklist today. Can you recommend another one?',
      at: recent, eventTime: recent, timeZone: 'UTC' })
    assert.ok(grantSourceRecall(root, readSource(root, source.id), projectKey, { remembered: true }))
  })
  const query = 'Which maintenance checklist did I finish a week ago?'
  assert.match((await ask(query, 'Pacific/Kiritimati')).block, /cedar maintenance checklist/u)
  assert.doesNotMatch((await ask(query, 'UTC')).block, /cedar maintenance checklist/u)
  assert.doesNotMatch((await ask(query)).block, /cedar maintenance checklist/u)
  assert.doesNotMatch((await ask('截至2026年11月16日，维护清单是什么配置？', 'UTC')).block, /cedar maintenance checklist/u)
})

test('event counts combine dates across chats and collapse repeated attendance evidence', async t => {
  const today = Date.UTC(2026, 10, 25, 12)
  t.mock.method(Date, 'now', () => today)
  const confirmed = []
  const ask = await setup(t, {}, [], (root, projectKey) => {
    const add = (id, text, at, scope = projectKey) => {
      const source = saveSource(root, { sessionId: 'history-' + id, messageId: id, at, eventTime: at, timeZone: 'UTC',
        projectKey: scope, role: 'user', sourceKind: 'user', text })
      assert.ok(grantSourceRecall(root, readSource(root, source.id), scope, { remembered: true }))
      return source.id
    }
    confirmed.push(add('cedar', 'I attended the Cedar incident review workshop on 2026-11-04.', today - 9 * 86_400_000))
    confirmed.push(add('cedar-repeat', 'I joined the Cedar incident review workshop on 2026-11-04.', today - 7 * 86_400_000))
    confirmed.push(add('birch', 'I took part in the Birch incident review workshop yesterday.', Date.UTC(2026, 10, 20, 15)))
    add('before-window', 'I attended the Opal incident review workshop on 2026-10-23.', today - 86_400_000)
    add('third-party', 'My colleague attended the Garnet incident review workshop yesterday.', today)
    add('planned', "I'll attend the Amber incident review workshop tomorrow.", today)
    add('negated', 'I did not attend the Flint incident review workshop yesterday.', today)
    add('zero', 'I attended no Onyx incident review workshops on 2026-11-12.', today)
    add('future', 'I attended the Fable incident review workshop yesterday.', today + 86_400_000)
    add('different-project', 'I attended the Moss incident review workshop yesterday.', today, 'other-project')
    const forgotten = add('forgotten', 'I attended the Clay incident review workshop this morning.', today)
    blockSourceRecall(root, { sourceRefs: [{ sourceId: forgotten }] })
  })
  const { block, report } = await ask('How many incident review workshops have I attended in the past month?', 'UTC')
  const question = report.questions[0]
  assert.equal(question.detail, 'event-count')
  assert.equal(question.eventCount.confirmed, 2)
  assert.equal(question.eventCount.complete, true)
  assert.match(block, /2 recorded attendances/u)
  assert.equal((block.match(/Cedar incident review workshop/gu) ?? []).length, 1)
  assert.match(block, /2026-11-19.*Birch incident review workshop/u)
  assert.doesNotMatch(block, /Opal|Garnet|Amber|Flint|Onyx|Fable|Moss|Clay/u)
  const refs = question.injected.flatMap(item => item.sourceRefs.map(ref => ref.sourceId))
  assert.equal(refs.length, 2)
  assert.ok(refs.includes(confirmed[2]) && confirmed.slice(0, 2).some(id => refs.includes(id)))
  assert.equal(assessAnswerCoverage(question, 'Two workshops are recorded.').answerCoverage, 'covered')
  assert.equal(assessAnswerCoverage(question, 'Three workshops are recorded.').answerCoverage, 'unverified')
  assert.equal(assessAnswerCoverage(question, 'Two workshops were recorded. Actually, three workshops were recorded.').answerCoverage, 'unverified')
})

test('dinner attendance binds a renamed gathering to a dated user statement at the same venue', async t => {
  const now = Date.UTC(2023, 4, 30, 14, 40)
  t.mock.method(Date, 'now', () => now)
  const ids = new Map()
  let data, addFixture
  const ask = await setup(t, {}, [], (root, projectKey) => {
    data = root
    const add = (sessionId, messageId, text, at, scope = projectKey) => {
      const source = saveSource(root, { sessionId, messageId, projectKey: scope, role: 'user', sourceKind: 'user',
        eventTime: at, timeZone: 'UTC', at, text })
      assert.ok(grantSourceRecall(root, readSource(root, source.id), scope))
      ids.set(messageId, source.id)
    }
    addFixture = add
    const sunday = Date.UTC(2023, 4, 21, 13), monday = Date.UTC(2023, 4, 22, 11)
    add('cookout', 'barbecue-date', "I've had a good experience with a BBQ theme, like the one we had at Sean's place two weeks ago, where we watched a baseball game together.", sunday)
    add('cookout', 'named-parties', "I've had experience with dinner parties, like the one we had at Mira's place yesterday, where we had a potluck, and also at Sean's place, where we had a BBQ and watched a baseball game together.", sunday + 1000)
    add('feast', 'feast-date', "I attended a lovely Greek feast at Celia's place last week.", monday)
    add('feast', 'feast-name', "Speaking of dinner parties, I've had a lovely experience at Celia's place recently, where we played games after the Greek feast.", monday + 1000)
    add('unrelated', 'different-session', "I attended a lovely Greek feast at Celia's place on May 6, 2023.", monday)
    add('feast', 'future', "I will attend a Greek feast at Celia's place tomorrow.", monday + 2000)
    add('cookout', 'conflicting-project', "I've had a good experience with a BBQ theme, like the one we had at Sean's place four weeks ago, where we watched a baseball game together.", sunday, 'other-project')
  })
  const query = 'How many dinner parties have I attended in the past month?'
  const { report, block } = await ask(query, 'UTC', { id: 'first-dinner', at: now })
  const slot = report.questions[0]
  assert.equal(slot.eventCount.confirmed, 3)
  assert.equal(slot.eventCount.complete, true)
  const sources = [...new Set(slot.injected.flatMap(item => item.sourceRefs.map(ref => ref.sourceId)))].sort()
  assert.deepEqual(sources, ['barbecue-date', 'named-parties', 'feast-date', 'feast-name'].map(key => ids.get(key)).sort())
  assert.match(block, /3 recorded dinner parties/u)
  assert.match(block, /- two weeks ago ·/u)
  assert.equal(block.split('\n').filter(line => line.startsWith('- ')).length, 3)
  assert.doesNotMatch(block, /2023-05-07/u)
  assert.doesNotMatch(block, /May 6|four weeks ago|tomorrow/u)
  assert.equal(assessAnswerCoverage(slot, 'Three dinner parties are recorded.').answerCoverage, 'covered')
  assert.equal(assessAnswerCoverage(slot, 'Three dinner parties were recorded in the last month.').answerCoverage, 'covered')
  assert.equal(assessAnswerCoverage(slot, 'Three dinner parties were recorded in the past 24 days.').answerCoverage, 'unverified')
  const reworded = await ask('Over the past month, how many dinner parties did I go to?', 'UTC', { id: 'leading-window', at: now })
  const rewordedSlot = reworded.report.questions[0]
  assert.deepEqual(rewordedSlot.eventCount, slot.eventCount)
  assert.deepEqual([...new Set(rewordedSlot.injected.flatMap(item => item.sourceRefs.map(ref => ref.sourceId)))].sort(), sources)
  const shanghai = await ask(query, 'Asia/Shanghai', { id: 'shanghai-date-window', at: now })
  assert.equal(shanghai.report.questions[0].eventCount.confirmed, 3)
  assert.equal(shanghai.report.questions[0].eventCount.complete, true)
  const boundary = await ask('How many dinner parties have I attended in the past 23 days?', 'UTC', { id: 'near-boundary', at: now })
  assert.equal(boundary.report.questions[0].eventCount.confirmed, 2)
  assert.equal(boundary.report.questions[0].eventCount.complete, false)
  addFixture('cookout', 'second-barbecue-date', "I've had a good experience with a BBQ theme, like the one we had at Sean's place on May 10, 2023, where we watched a baseball game together.", Date.UTC(2023, 4, 21, 14))
  const ambiguous = await ask(query, 'UTC', { id: 'conflicting-date', at: now })
  assert.equal(ambiguous.report.questions[0].eventCount.confirmed, 2)
  assert.equal(ambiguous.report.questions[0].eventCount.complete, false)
  blockSourceRecall(data, { sourceRefs: [{ sourceId: ids.get('second-barbecue-date') }] })
  blockSourceRecall(data, { sourceRefs: [{ sourceId: ids.get('barbecue-date') }] })
  const reduced = await ask(query, 'UTC', { id: 'second-dinner', at: now })
  assert.equal(reduced.report.questions[0].eventCount.confirmed, 2)
  assert.equal(reduced.report.questions[0].eventCount.complete, false)
  assert.match(reduced.block, /at least 2 recorded dinner parties/u)
  assert.doesNotMatch(reduced.block, /two weeks ago/u)
})

test('undated and ambiguous events and a tight injection budget cannot become an exact total', async t => {
  const now = Date.UTC(2026, 10, 25, 12)
  t.mock.method(Date, 'now', () => now)
  const ask = await setup(t, { maxItems: 2 }, [], (root, projectKey) => {
    const occurred = [
      ['one', 'I attended the Alder emergency drill #preparedness on 2026-11-10.'],
      ['confusable', 'I attended another emergency drill #training on 2026-11-10.'],
      ['undated', 'I attended the Slate emergency drill. The date is still unclear.'],
      ['outside', 'I attended the Birch emergency drill on 2026-10-12.'],
    ]
    for (const [messageId, text] of occurred) {
      const source = saveSource(root, { sessionId: 'earlier-' + messageId, messageId, projectKey,
        role: 'user', sourceKind: 'user', text, eventTime: now, at: now, timeZone: 'UTC' })
      assert.ok(grantSourceRecall(root, readSource(root, source.id), projectKey, { remembered: true }))
    }
  })
  const { block, report } = await ask('How many emergency drills did I attend in the past month?', 'UTC')
  assert.equal(report.questions[0].eventCount.confirmed, 1)
  assert.equal(report.questions[0].eventCount.complete, false)
  assert.match(block, /at least 1 recorded attendance/u)
  assert.match(block, /total is unknown/u)
  assert.doesNotMatch(block, /Birch/u)
  assert.equal(assessAnswerCoverage(report.questions[0], 'Exactly one drill.').answerCoverage, 'unverified')
})

test('same-day events with separate identifiers count separately and a later correction removes its attendance', async t => {
  const now = Date.UTC(2026, 10, 25, 12)
  t.mock.method(Date, 'now', () => now)
  const desk = (root, projectKey) => {
    const sourceRows = [
      ['first', 'I attended the emergency drill #DR-101 on 2026-11-10.'],
      ['second', 'I attended the emergency drill #DR-202 on 2026-11-10.'],
      ['original', 'I attended the emergency drill #DR-303 on 2026-11-08.'],
      ['correction', "Actually, I didn't attend the emergency drill #DR-303 on 2026-11-08."],
    ]
    for (const [index, [messageId, text]] of sourceRows.entries()) {
      const at = now + index - sourceRows.length
      const source = saveSource(root, { sessionId: 'earlier-' + messageId, messageId, projectKey,
        role: 'user', sourceKind: 'user', text, eventTime: at, at, timeZone: 'UTC' })
      assert.ok(grantSourceRecall(root, readSource(root, source.id), projectKey, { remembered: true }))
    }
  }
  const sentence = 'How many emergency drills did I attend in the past month?'
  const ask = await setup(t, {}, [], desk)
  const { block, report } = await ask(sentence, 'UTC')
  assert.equal(report.questions[0].eventCount.confirmed, 2)
  assert.equal(report.questions[0].eventCount.complete, true)
  assert.match(block, /DR-101/u)
  assert.match(block, /DR-202/u)
  assert.doesNotMatch(block, /DR-303/u)

  const askWithBudget = await setup(t, { maxItems: 1 }, [], desk)
  const clipped = await askWithBudget(sentence, 'UTC')
  assert.equal(clipped.report.questions[0].eventCount.confirmed, 1)
  assert.equal(clipped.report.questions[0].eventCount.complete, false)
  assert.match(clipped.block, /total is unknown/u)
})

test('Chinese event counts keep the client calendar boundary when a message uses yesterday', async t => {
  const now = Date.UTC(2026, 11, 1, 0, 15)
  t.mock.method(Date, 'now', () => now)
  const ask = await setup(t, {}, [], (root, projectKey) => {
    for (const [messageId, text] of [
      ['day-boundary', '我昨天参加了苍桦应急演练。'],
      ['explicit-date', '我于2026-11-09参加了赤松应急演练。'],
      ['this-month', '我今天参加了楠木应急演练。'],
    ]) {
      const source = saveSource(root, { sessionId: 'earlier-' + messageId, messageId, projectKey,
        role: 'user', sourceKind: 'user', text, eventTime: now - 1000, at: now - 1000, timeZone: 'Asia/Shanghai' })
      assert.ok(grantSourceRecall(root, readSource(root, source.id), projectKey, { remembered: true }))
    }
  })
  const { block, report } = await ask('上个月我参加了几次应急演练？', 'Asia/Shanghai')
  assert.equal(report.questions[0].eventCount.confirmed, 2)
  assert.equal(report.questions[0].eventCount.complete, true)
  assert.match(block, /2026-11-30.*苍桦应急演练/u)
  assert.doesNotMatch(block, /楠木/u)
  assert.equal(assessAnswerCoverage(report.questions[0], '记录了两次应急演练。').answerCoverage, 'covered')
})

test('an abbreviated title keeps the named person in the same recall question', async t => {
  const ask = await setup(t, {}, [], (root, projectKey) => {
    const source = saveSource(root, { sessionId: 'earlier-chat', messageId: 'other-doctor', projectKey,
      role: 'user', sourceKind: 'user', text: 'I see Dr. Patel twice a week for a routine check.' })
    assert.ok(grantSourceRecall(root, readSource(root, source.id), projectKey, { remembered: true }))
  })
  const query = 'How often do I see Dr. Nolan?'
  assert.deepEqual(recallQueryPlan(query, '', false).map(plan => plan.role), ['root'])
  assert.deepEqual(recallQueryPlan('How often do I see my doctor, Dr. Nolan?', '', false).map(plan => plan.role), ['root'])
  const missing = await ask(query, 'UTC')
  assert.equal(missing.report.questions.length, 1)
  assert.doesNotMatch(missing.block, /Patel/u)
  assert.match((await ask('How often do I see Dr. Patel?', 'UTC')).block, /twice a week/u)
})

test('a named appointment frequency uses the latest explicit cadence', async t => {
  const now = Date.UTC(2026, 10, 13)
  t.mock.method(Date, 'now', () => now)
  let chosen
  const ask = await setup(t, {}, [], (root, projectKey) => {
    const add = (messageId, text, ago) => {
      const at = now - ago
      const source = saveSource(root, { sessionId: 'past-' + messageId, messageId, projectKey, at, eventTime: at,
        role: 'user', sourceKind: 'user', text, timeZone: 'UTC' })
      assert.ok(grantSourceRecall(root, readSource(root, source.id), projectKey, { remembered: true }))
      return source.id
    }
    add('older', 'I see Dr. Patel every two weeks.', 5000)
    add('conversation', 'Dr. Patel helped me find a pharmacy.', 1000)
    chosen = add('newer', 'And by the way, speaking of appointments, I see Dr. Patel every week now.', 2500)
    add('different-person', 'I see Dr. Nolan every month.', 500)
  })
  const { block, report } = await ask('How often do I see my doctor, Dr. Patel?', 'UTC')
  assert.equal(report.questions[0].detail, 'frequency')
  assert.match(block, /I see Dr\. Patel every week/u)
  assert.doesNotMatch(block, /pharmacy|two weeks|Nolan/u)
  assert.deepEqual(report.questions[0].injected.map(hit => hit.sourceRefs[0].sourceId), [chosen])
  assert.equal(assessAnswerCoverage(report.questions[0], 'Once a week.').answerCoverage, 'covered')
  assert.equal(assessAnswerCoverage(report.questions[0], 'Every two weeks.').answerCoverage, 'unverified')
})

test('an independent question after a comma remains a separate recall slot', () => {
  for (const query of [
    'How long have I used Quartz, who owns Quartz?',
    'How often do I see Dr. Patel, who introduced me to Dr. Nolan?',
  ]) {
    const parts = recallQueryPlan(query, '', false).filter(plan => plan.role === 'subquestion')
    assert.equal(parts.length, 2, query)
  }
})

test('ongoing activity recall binds the duration to the requested action', async t => {
  const at = Date.UTC(2026, 10, 12)
  t.mock.method(Date, 'now', () => at + 1000)
  const ask = await setup(t, {}, [], (root, projectKey) => {
    for (const [messageId, text] of [
      ['answer', "I've been maintaining the Aster gallery for seventeen months."],
      ['old-work', "I've been visiting the Aster gallery for four years."],
    ]) {
      const source = saveSource(root, { sessionId: 'old-chat', messageId, projectKey, eventTime: at, at,
        role: 'user', sourceKind: 'user', text, timeZone: 'UTC' })
      assert.ok(grantSourceRecall(root, readSource(root, source.id), projectKey, { remembered: true }))
    }
  })
  const { block, report } = await ask('How long have I been maintaining my current Aster gallery?', 'UTC')
  assert.equal(report.questions[0].detail, 'duration')
  assert.match(block, /seventeen months/u)
  assert.doesNotMatch(block, /four years/u)
  assert.equal(assessAnswerCoverage(report.questions[0], '17 months.').answerCoverage, 'covered')
})

test('an elapsed-use question chooses a dated statement for the named object from another session', async t => {
  const date = month => Date.UTC(2026, month, 12)
  t.mock.method(Date, 'now', () => date(10))
  let expected
  const ask = await setup(t, {}, [], (root, projectKey) => {
    const add = (id, text, month, scope = projectKey) => {
      const source = saveSource(root, { sessionId: 'archive-' + id, messageId: id, projectKey: scope,
        role: 'user', sourceKind: 'user', text, at: date(month), eventTime: date(month), timeZone: 'UTC' })
      assert.ok(grantSourceRecall(root, readSource(root, source.id), scope, { remembered: true }))
      return source.id
    }
    add('earlier', "I've used the staging database, Quartz, for six months now.", 6)
    expected = add('recent', "Quartz recently passed an audit. By the way, speaking of staging, I just realized I've used Quartz for about nine months now.", 9)
    add('different-action', "I've been repairing Quartz for 21 days.", 9)
    add('different-object', "I've used the reporting database for 40 months, while Quartz is being inspected.", 9)
    add('hypothetical', "If I've used Quartz for 51 months, the estimate is too high.", 9)
    add('future', "I've used Quartz for 71 months now.", 11)
    add('other-project', "I've used Quartz for 81 months now.", 10, 'other-project')
    const revoked = add('revoked', "I've used Quartz for 91 months now.", 10)
    blockSourceRecall(root, { sourceRefs: [{ sourceId: revoked }] })
  })
  const { block, report } = await ask('How long have I used my staging database, Quartz?', 'UTC')
  assert.equal(report.questions.length, 1)
  assert.match(block, /I've used Quartz for about nine months now/u)
  assert.match(block, /Recorded duration for staging database Quartz was about nine months on 2026-10-12/u)
  assert.match(block, /2026-10-12/u)
  assert.doesNotMatch(block, /passed an audit|six months|(?:21|40|51|71|81|91) (?:days|months)/u)
  assert.deepEqual(report.questions[0].injected.map(hit => hit.sourceRefs[0].sourceId), [expected])
  assert.equal(report.questions[0].injected[0].selectedQuote, "I've used Quartz for about nine months now")
  assert.equal(assessAnswerCoverage(report.questions[0], 'About 9 months.').answerCoverage, 'covered')
  assert.equal(assessAnswerCoverage(report.questions[0], '大约9个月。').answerCoverage, 'covered')
  assert.equal(assessAnswerCoverage(report.questions[0], '9 weeks.').answerCoverage, 'unverified')
  assert.equal(assessAnswerCoverage(report.questions[0], 'About 9 months. The duration was 4 years.').answerCoverage, 'unverified')
  assert.equal(assessAnswerCoverage(report.questions[0], 'You used Quartz for about nine months. There is no information about how long you used the staging database.').answerCoverage, 'unverified')
  const withUnrelatedToolError = 'The tool failed because the optional parameter was not omitted. You used Quartz for about nine months.'
  assert.deepEqual(assessAnswerCoverage(report.questions[0], withUnrelatedToolError),
    { answerCoverage: 'covered', answerExcerpt: 'You used Quartz for about nine months.' })
})

function measureSources(root, projectKey, now, records) {
  return Object.fromEntries(records.map(([id, text, age = 1, scope = projectKey]) => {
    const at = now - age * 86_400_000
    const source = saveSource(root, { sessionId: 'measure-' + id, messageId: id, projectKey: scope,
      role: 'user', sourceKind: 'user', text, at, eventTime: at, timeZone: 'UTC' })
    assert.ok(grantSourceRecall(root, readSource(root, source.id), scope, { remembered: true }))
    return [id, source.id]
  }))
}

test('explicit remaining amounts use the right object and never substitute its total or pace', async t => {
  const now = Date.UTC(2026, 10, 25)
  t.mock.method(Date, 'now', () => now)
  let root, projectKey, sources
  const ask = await setup(t, {}, [], (directory, key) => {
    root = directory
    projectKey = key
    sources = measureSources(directory, key, now, [
      ['left', 'I have 76 pages left to read in the Aster Atlas.'],
      ['total', 'The Aster Atlas has 340 pages.', 0],
      ['pace', 'I read 12 pages of the Aster Atlas each night.', 0],
      ['done', 'I read 264 pages of the Aster Atlas.', 0],
      ['other-role', 'I have 42 pages left to translate in the Aster Atlas.', 0],
      ['wrong-title', 'I have 85 pages left to read in the Aster Journal.', 0],
      ['crossed-title', 'I have 55 pages left to read in the Aster Journal instead of the Aster Atlas.', 0],
      ['foreign', 'I have 96 pages left to read in the Aster Atlas.', 0, 'other-project'],
      ['han', '《海岸地图》还剩二十页没读。'],
      ['han-total', '《海岸地图》共有八十页。', 0],
    ])
  })
  const question = "How many pages do I have left to read in the 'Aster Atlas'?"
  const found = await ask(question, 'UTC')
  const slot = found.report.questions[0]
  assert.equal(slot.declaredCount.value, '76')
  assert.deepEqual(slot.injected.flatMap(hit => hit.sourceRefs.map(ref => ref.sourceId)), [sources.left])
  assert.doesNotMatch(found.block, /340|264|85|96|42|55|12 pages/u)
  assert.equal(assessAnswerCoverage(slot, 'You have 76 pages left to read.').answerCoverage, 'covered')
  assert.equal(assessAnswerCoverage(slot, 'You have already read 76 pages.').answerCoverage, 'unverified')
  assert.equal(assessAnswerCoverage(slot, 'You have 76 pages left to summarize.').answerCoverage, 'unverified')
  assert.equal(assessAnswerCoverage(slot, 'You have 76 pages left to read in the Aster Journal.').answerCoverage, 'unverified')
  const chinese = (await ask('《海岸地图》还剩多少页没读？', 'UTC')).report.questions[0]
  assert.equal(chinese.declaredCount.value, '20')
  assert.deepEqual(chinese.injected.flatMap(hit => hit.sourceRefs.map(ref => ref.sourceId)), [sources.han])
  assert.equal(assessAnswerCoverage(chinese, '还剩二十页没读。').answerCoverage, 'covered')
  assert.equal(assessAnswerCoverage(chinese, '已经读了二十页。').answerCoverage, 'unverified')
  blockSourceRecall(root, { projectKey, sourceRefs: [{ sourceId: sources.left }] })
  const forgotten = await ask(question, 'UTC')
  assert.equal(forgotten.report.questions[0].declaredCount.value, null)
  assert.deepEqual(forgotten.report.questions[0].injected, [])
})

test('an age at an event requires the right person, event and explicitly recorded age', async t => {
  const now = Date.UTC(2026, 10, 25)
  t.mock.method(Date, 'now', () => now)
  let sources
  const ask = await setup(t, {}, [], (root, key) => {
    sources = measureSources(root, key, now, [
      ['birthday', 'The green compass my aunt gave me on my nineteenth birthday is in my desk.'],
      ['other-birthday', 'My aunt gave me the green compass at her thirty-fifth birthday party.', 0],
      ['wrong-event', 'My aunt gave me a blue key on my twenty-second birthday.', 0],
      ['later', 'I turned 26 last month.', 0],
      ['separate-clauses', 'My aunt gave me the green compass. I got a new desk on my eighteenth birthday.', 0],
      ['unrelated-age', 'My aunt gave me the green compass and sent a welcome card when I turned twenty-two.', 0],
      ['tentative', 'Sylvia is finishing her residency next May.', 0],
    ])
  })
  const age = await ask('How old was I when my aunt gave me the green compass?', 'UTC')
  const slot = age.report.questions[0]
  assert.equal(slot.declaredCount.value, '19')
  assert.deepEqual(slot.injected.flatMap(hit => hit.sourceRefs.map(ref => ref.sourceId)), [sources.birthday])
  assert.match(age.block, /Verified age at the event: 19 years old/u)
  assert.match(age.block, /on my nineteenth birthday/u)
  assert.equal(assessAnswerCoverage(slot, 'You were nineteen years old.').answerCoverage, 'covered')
  assert.equal(assessAnswerCoverage(slot, 'She was nineteen years old.').answerCoverage, 'unverified')
  assert.equal(assessAnswerCoverage(slot, 'You were nineteen years old when you got your degree.').answerCoverage, 'unverified')
  const projected = await ask('How old will Sylvia be when I finish my residency?', 'UTC')
  assert.equal(projected.report.questions[0].declaredCount.value, null)
  assert.deepEqual(projected.report.questions[0].injected, [])
})

test('a total for an explicit span requires a completed span carrying the total', async t => {
  const now = Date.UTC(2026, 10, 25)
  t.mock.method(Date, 'now', () => now)
  let sources, dataDir, projectKey
  const ask = await setup(t, {}, [], (root, key) => {
    dataDir = root
    projectKey = key
    sources = measureSources(root, key, now, [
      ['partial', 'I spent four years in college before I considered an engineering degree.', 0],
      ['future', 'I plan to spend nine years in education from secondary school to the completion of my engineering degree.', 0],
      ['other-span', 'I spent five years in education from secondary school to the completion of my arts degree.', 0],
      ['partial-span', 'I spent 6 years in formal education from secondary school to the completion of my engineering degree excluding my first year.', 0],
      ['total', 'I spent a total of 11 years in formal education from secondary school to the completion of my engineering degree.', 2],
    ])
  })
  const query = 'How many years in total did I spend in formal education from secondary school to the completion of my engineering degree?'
  const good = (await ask(query, 'UTC')).report.questions[0]
  assert.equal(good.declaredCount.value, '11')
  assert.deepEqual(good.injected.flatMap(hit => hit.sourceRefs.map(ref => ref.sourceId)), [sources.total])
  assert.equal(assessAnswerCoverage(good, '11 years.').answerCoverage, 'covered')
  assert.equal(assessAnswerCoverage(good, '11 years from secondary school to the completion of your arts degree.').answerCoverage, 'unverified')
  blockSourceRecall(dataDir, { projectKey, sourceRefs: [{ sourceId: sources.total }] })
  const missing = (await ask(query, 'UTC')).report.questions[0]
  assert.equal(missing.declaredCount.value, null)
  assert.deepEqual(missing.injected, [])
})

test('remaining pages are calculated only from the same book and the latest authorized position', async t => {
  const now = Date.UTC(2026, 10, 25)
  t.mock.method(Date, 'now', () => now)
  let root, key, sources
  const ask = await setup(t, {}, [], (directory, projectKey) => {
    root = directory
    key = projectKey
    sources = measureSources(root, key, now, [
      ['count', '记住：The Silver Almanac has 440 pages.', 3],
      ['position', 'I am currently on page 250 of the Silver Almanac.', 1],
      ['earlier', 'I was on page 110 of the Silver Almanac.', 3],
      ['quotation', '“I am on page 300 of the Silver Almanac.”', 0],
      ['secondhand', 'My sister said I am on page 290 of the Silver Almanac.', 0],
      ['pace', 'I read 25 pages of the Silver Almanac each week.', 0],
      ['similar', 'The Silver Almanac Workbook has 600 pages.', 0],
      ['foreign', 'The Silver Almanac has 630 pages.', 0, 'different-project'],
    ])
  })
  const query = 'How many pages do I have left to read in the Silver Almanac?'
  const found = await ask(query, 'UTC')
  const slot = found.report.questions[0]
  assert.equal(slot.declaredCount.value, '190')
  assert.deepEqual(new Set(slot.injected.flatMap(hit => hit.sourceRefs.map(ref => ref.sourceId))), new Set([sources.count, sources.position]))
  assert.match(found.block, /440\s*−\s*250\s*=\s*190/u)
  assert.doesNotMatch(found.block, /110|290|300|600|630|25 pages/u)
  assert.equal(assessAnswerCoverage(slot, '190 pages remain.').answerCoverage, 'covered')
  assert.equal(assessAnswerCoverage(slot, '根据记录，你还有190页需要阅读在Silver Almanac中。').answerCoverage, 'covered')
  assert.equal(assessAnswerCoverage(slot, '你在《Silver Almanac》中还有190页需要阅读。').answerCoverage, 'covered')
  assert.equal(assessAnswerCoverage(slot, '你还有190页需要阅读在Silver Almanac Workbook中。').answerCoverage, 'unverified')
  assert.equal(assessAnswerCoverage(slot, '你在《Silver Almanac Workbook》中还有190页需要阅读。').answerCoverage, 'unverified')
  blockSourceRecall(root, { projectKey: key, sourceRefs: [{ sourceId: sources.count }] })
  const missing = (await ask(query, 'UTC')).report.questions[0]
  assert.equal(missing.declaredCount.value, null)
  assert.deepEqual(missing.injected, [])
})

test('a sum of study years needs a supported beginning, graduation and continuous recorded periods', async t => {
  const now = Date.UTC(2026, 10, 25)
  t.mock.method(Date, 'now', () => now)
  let root, key, sources
  const ask = await setup(t, {}, [], (directory, projectKey) => {
    root = directory
    key = projectKey
    sources = measureSources(root, key, now, [
      ['start', 'I attended Falcon High School from 2009 to 2013.'],
      ['end', "I graduated with a Bachelor's degree from Harbor University in 2019, which took me four years to complete."],
      ['false-bridge', 'I traveled from 2013 to 2015 while thinking about college.'],
      ['degree-plan', "I considered applying for a Master's degree in 2021."],
    ])
  })
  const query = degree => 'How many years in total did I spend in formal education from high school to the completion of my ' + degree + ' degree?'
  const first = await ask(query("Bachelor's"), 'UTC', { id: 'uncertain', at: now })
  assert.equal(first.report.questions[0].declaredCount.value, null)
  assert.deepEqual(first.report.questions[0].injected, [])
  assert.deepEqual(new Set(first.report.questions[0].notInjected.flatMap(hit => hit.sourceRefs.map(ref => ref.sourceId))), new Set([sources.start, sources.end]))
  assert.match(first.block, /do not establish the total time spent/iu)
  assert.doesNotMatch(first.block, /traveled|Master's degree|2009|2019|four years/u)
  assert.deepEqual((await ask(query("Master's"), 'UTC', { id: 'wrong-end', at: now })).report.questions[0].injected, [])
  const college = measureSources(root, key, now, [['college', 'I attended Pine College from 2013 to 2015.']]).college
  const complete = await ask(query("Bachelor's"), 'UTC', { id: 'continuous', at: now })
  const slot = complete.report.questions[0]
  assert.equal(slot.declaredCount.value, '10')
  assert.deepEqual(new Set(slot.injected.flatMap(hit => hit.sourceRefs.map(ref => ref.sourceId))), new Set([sources.start, college, sources.end]))
  assert.match(complete.block, /4\s*\+\s*2\s*\+\s*4\s*=\s*10/u)
  const periods = "You attended Falcon High School from 2009 to 2013, which is a period of 4 years. Then you attended Pine College from 2013 to 2015, which is 2 years. Finally, you completed your Bachelor's degree from Harbor University in 2019, which took 4 years."
  const arithmetic = 'Add the years from each stage: 4 years (high school) + 2 years (college) + 4 years (degree) = 10 years.'
  const total = "You spent a total of 10 years in formal education from high school to the completion of your Bachelor's degree."
  const scopedMath = "The total years spent in formal education from high school to the completion of your Bachelor's degree is 4 + 2 + 4 = 10 years."
  for (const answer of ['10 years.', total, arithmetic, [periods, arithmetic, total].join(' '), [periods, scopedMath].join(' ')]) {
    assert.equal(assessAnswerCoverage(slot, answer).answerCoverage, 'covered', answer)
  }
  for (const answer of [
    periods,
    [periods, total.replace('10 years', '4 years')].join(' '),
    [periods.replace('from 2013 to 2015', 'from 2014 to 2016'), total].join(' '),
    [periods.replace('Pine College', 'Birch College'), total].join(' '),
    [arithmetic.replace('4 years (high school)', '2 years (high school)'), total].join(' '),
    [total, "Your formal education took 4 years."].join(' '),
    total.replace("Bachelor's", "Master's"),
    scopedMath.replace("Bachelor's", "Master's"),
  ]) assert.equal(assessAnswerCoverage(slot, answer).answerCoverage, 'unverified', answer)
})

test('recall ties an allocated duration to its activity and cadence, using the latest statement', async t => {
  const now = Date.UTC(2026, 10, 25)
  t.mock.method(Date, 'now', () => now)
  let sources
  const ask = await setup(t, {}, [], (root, key) => {
    sources = measureSources(root, key, now, [
      ['earlier', 'I dedicate thirty minutes every day to practicing classical guitar.', 6],
      ['current', "By the way, I've been practicing classical guitar for about seventy minutes daily, and it feels easier now.", 2],
      ['weekly', 'I spend two hours per week practicing classical guitar.', 1],
      ['session', 'I spend forty minutes per session practicing classical guitar.', 0],
      ['different-activity', 'I spend ninety minutes every day practicing bass guitar.', 0],
      ['plan', 'I plan to spend three hours a day practicing classical guitar.', 0],
      ['example', 'My teacher said, “I practice classical guitar for six hours daily.”', 0],
      ['another-project', 'I practice classical guitar for seven hours daily.', 1, 'other-music-project'],
      ['future', 'I practice classical guitar for eight hours daily.', -1],
    ])
  })
  const daily = await ask('How much time do I dedicate to practicing classical guitar every day?', 'UTC')
  const slot = daily.report.questions[0]
  assert.equal(slot.detail, 'duration')
  assert.deepEqual(slot.injected.map(hit => hit.sourceRefs[0].sourceId), [sources.current])
  assert.match(daily.block, /Keep the period and qualifiers such as about/u)
  assert.match(daily.block, /practicing classical guitar for about seventy minutes daily/u)
  assert.doesNotMatch(daily.block, /thirty|forty|ninety|(?:two|three|six|seven|eight) hours/u)
  assert.equal(assessAnswerCoverage(slot, 'About 70 minutes every day.').answerCoverage, 'covered')
  assert.equal(assessAnswerCoverage(slot, 'About 70 minutes per lesson.').answerCoverage, 'unverified')
  assert.equal(assessAnswerCoverage(slot, 'Exactly 70 minutes each day.').answerCoverage, 'unverified')
  const weekly = await ask('How long do I spend practicing classical guitar each week?', 'UTC')
  assert.deepEqual(weekly.report.questions[0].injected.map(hit => hit.sourceRefs[0].sourceId), [sources.weekly])
  const missing = await ask('How much time do I spend practicing classical guitar each month?', 'UTC')
  assert.deepEqual(missing.report.questions[0].injected, [])
})

test('cumulative time uses the latest authorized range for the same work', async t => {
  const now = Date.UTC(2026, 10, 25)
  t.mock.method(Date, 'now', () => now)
  let root, sources
  const ask = await setup(t, {}, [], (directory, key) => {
    root = directory
    sources = measureSources(directory, key, now, [
      ['old', "I've been working on an abstract ocean sculpture at home, and I've spent around 5-6 hours on it so far.", 8],
      ['other', 'I have spent nine hours on my abstract garden sculpture.', 2],
      ['session', 'I have spent thirteen hours on my abstract ocean sculpture today.', 2],
      ['workflow', 'I have put in fourteen hours per session on my abstract ocean sculpture.', 2],
      ['subtotal', 'I have spent fifteen hours on my abstract ocean sculpture, excluding the first day.', 2],
      ['plan', 'I plan to spend sixteen hours on my abstract ocean sculpture.', 2],
      ['other-actor', 'We have spent seventeen hours on our abstract ocean sculpture.', 2],
      ['other-project', 'I have spent eighteen hours on my abstract ocean sculpture.', 2, 'other-project'],
      ['future', 'I have spent nineteen hours on my abstract ocean sculpture.', -1],
    ])
    sources.current = durationSource(directory, key, 'ordinary-current',
      "By the way, I've been spending a lot of time on my abstract ocean sculpture lately - I've already put in 10-12 hours, and it's still a work in progress.",
      now - 3 * 86_400_000)
  })
  const question = 'How many hours have I spent on my abstract ocean sculpture?'
  const result = await ask(question, 'UTC')
  const slot = result.report.questions[0]
  assert.equal(slot.detail, 'duration')
  assert.deepEqual(slot.injected.map(hit => hit.sourceRefs[0].sourceId), [sources.current])
  assert.deepEqual(slot.injected[0].timeMeasureValues, ['10–12 hour'])
  assert.match(result.block, /put in 10-12 hours/u)
  const grade = answer => assessAnswerCoverage(slot, answer).answerCoverage
  for (const value of ['10–12 hours.', '600 to 720 minutes.', 'You have spent between 10 and 12 hours on your abstract ocean sculpture.']) {
    assert.equal(grade(value), 'covered', value)
  }
  for (const value of ['Exactly 12 hours.', 'About 11 hours.', 'You spent 10–12 hours per session.',
    'You have spent 10–12 hours on your abstract garden sculpture.', 'You have spent 10–12 hours on it today.']) {
    assert.equal(grade(value), 'unverified', value)
  }
  blockSourceRecall(root, { sourceRefs: [{ sourceId: sources.current }] })
  const fallback = await ask(question, 'UTC')
  assert.deepEqual(fallback.report.questions[0].injected.map(hit => hit.sourceRefs[0].sourceId), [sources.old])
  assert.equal(assessAnswerCoverage(fallback.report.questions[0], 'Around 5 to 6 hours.').answerCoverage, 'covered')
  assert.equal(assessAnswerCoverage(fallback.report.questions[0],
    'Based on the recorded information, you have spent about 5-6 hours on your abstract ocean sculpture.').answerCoverage, 'covered')
  assert.equal(assessAnswerCoverage(fallback.report.questions[0], 'Exactly 5 to 6 hours.').answerCoverage, 'unverified')
})

test('a race personal best uses the latest supported record for the same race', async t => {
  const now = Date.UTC(2026, 10, 25, 13)
  t.mock.method(Date, 'now', () => now)
  let root, oldId, latestId
  const latest = "I'm training for another charity 5K run coming up and I was wondering if you could give me some tips on how to improve my endurance. By the way, I'm hoping to beat my personal best time of 25:50 this time around."
  const ask = await setup(t, {}, [], (data, key) => {
    root = data
    const add = (id, text, offset, project = key) => durationSource(root, project, id, text, now + offset)
    oldId = add('past-best', "I'm happy to say that I recently set a personal best time in a charity 5K run with a time of 27:12.", -4000)
    latestId = add('updated-best', latest, -3000)
    add('no-number', "I'm getting ready for a charity 5K run. By the way, I'm hoping to beat my personal best time this time around.", -100)
    add('different-race', 'I set my personal best time in the charity 10K run with a time of 56:12.', -100)
    add('different-kind', 'I set my personal best time in the park 5K run with a time of 22:14.', -100)
    add('different-person', 'My sister set her personal best in the charity 5K run with a time of 22:18.', -100)
    add('hypothetical', 'If I set a personal best time in a charity 5K run with a time of 22:19, I would celebrate.', -100)
    add('example', 'Example:\nI set a personal best time in the charity 5K run with a time of 22:17.', -100)
    add('narration', 'The story reads that I set a personal best time in a charity 5K run with a time of 22:16.', -100)
    add('target', "I'm training for the charity 5K run. I'm hoping to run it in 22:20.", -100)
    add('ambiguous-race', "I'm training for the charity 5K run and the park 10K run. I'm hoping to beat my personal best time of 22:21.", -100)
    add('unanchored', "I'm hoping to beat my personal best time of 22:23.", -100)
    add('unrelated-race', "I'm training for the charity 5K run. I am also training for the park 5K run. I'm hoping to beat my personal best time of 22:26.", -100)
    add('future', 'I set a personal best time in a charity 5K run with a time of 22:24.', 100)
    add('other-project', 'I set a personal best time in a charity 5K run with a time of 22:25.', -100, 'foreign')
  })
  const question = 'What was my personal best time in the charity 5K run?'
  const result = await ask(question, 'UTC')
  const slot = result.report.questions[0]
  assert.equal(slot.detail, 'duration')
  assert.deepEqual(slot.injected.map(hit => hit.sourceRefs[0].sourceId), [latestId])
  assert.deepEqual(slot.injected[0].timeMeasureValues, ['1550 second'])
  assert.ok(latest.includes(slot.injected[0].selectedQuote))
  assert.match(slot.injected[0].selectedQuote, /another charity 5K run.*25:50/u)
  const grade = answer => assessAnswerCoverage(slot, answer).answerCoverage
  for (const text of ['25:50.', '25 minutes and 50 seconds.', 'Your personal best time in the charity 5K run was 25 minutes and 50 seconds (25:50).',
    'Based on the recorded information, your personal best time was 25:50.']) {
    assert.equal(grade(text), 'covered', text)
  }
  for (const text of ['Your personal best time in the charity 10K run was 25:50.', 'Your personal best was 27:12.',
    'Your target time for the charity 5K run is 25:50.', "Your friend’s personal best was 25:50.",
    '25:50 PM.', 'Around 25 minutes and 50 seconds.', '25:50 or 27:12.']) {
    assert.equal(grade(text), 'unverified', text)
  }
  const earlier = await ask(question, 'UTC', { id: 'before-updated-best', at: now - 3500 })
  assert.deepEqual(earlier.report.questions[0].injected.map(hit => hit.sourceRefs[0].sourceId), [oldId])
  blockSourceRecall(root, { sourceRefs: [{ sourceId: latestId }] })
  const fallback = await ask(question, 'UTC')
  assert.deepEqual(fallback.report.questions[0].injected.map(hit => hit.sourceRefs[0].sourceId), [oldId])
  assert.equal(assessAnswerCoverage(fallback.report.questions[0], '27 minutes and 12 seconds.').answerCoverage, 'covered')
  const withoutEvidence = await ask('What was my personal best time in the charity 15K run?', 'UTC')
  assert.deepEqual(withoutEvidence.report.questions[0].injected, [])
  assert.doesNotMatch(withoutEvidence.block, /27:12|56:12|22:14/u)
})

test('conflicting race bests at the same timestamp stay disputed', async t => {
  const now = Date.UTC(2026, 10, 25)
  t.mock.method(Date, 'now', () => now)
  const ask = await setup(t, {}, [], (root, key) => {
    measureSources(root, key, now, [
      ['first-best', 'I set a personal best time in the charity 5K run with a time of 25:50.', 1],
      ['other-best', 'I recorded a personal best in a charity 5K run with a time of 26:07.', 1],
    ])
  })
  const result = await ask('What was my personal best time in the charity 5K run?', 'UTC')
  const slot = result.report.questions[0]
  assert.equal(slot.injected.length, 2)
  assert.ok(slot.injected.every(hit => hit.timeMeasureDisputed))
  assert.equal(assessAnswerCoverage(slot, '25:50.').answerCoverage, 'unverified')
})

test('same-time cumulative durations stay disputed', async t => {
  const now = Date.UTC(2026, 10, 25)
  t.mock.method(Date, 'now', () => now)
  const ask = await setup(t, {}, [], (root, key) => {
    measureSources(root, key, now, [
      ['first', 'I have spent ten hours on my coastal mural.', 1],
      ['conflict', 'I have logged twelve hours on my coastal mural so far.', 1],
    ])
  })
  const result = await ask('How much time have I spent on my coastal mural so far?', 'UTC')
  const slot = result.report.questions[0]
  assert.equal(slot.detail, 'duration')
  assert.equal(slot.injected.length, 2)
  assert.ok(slot.injected.every(hit => hit.timeMeasureDisputed))
  assert.equal(assessAnswerCoverage(slot, 'Exactly 10 hours.').answerCoverage, 'unverified')
})

test('中文组合问题只核对各项投入时长，撤回原话后原值无法召回', async t => {
  const now = Date.UTC(2026, 10, 25)
  t.mock.method(Date, 'now', () => now)
  let sources, dataDir, projectKey
  const ask = await setup(t, {}, [], (root, key) => {
    dataDir = root
    projectKey = key
    sources = measureSources(root, key, now, [
      ['writing', '我每天花四十分钟写周报。', 2],
      ['language', '我每周学西班牙语两个小时。', 2],
      ['locale', '我每天花八十分钟写月报。', 1],
      ['planned', '我打算每天花三小时写周报。', 1],
      ['alternate', '我每周写周报九小时。', 1],
      ['once', '我上周写周报花了六小时。', 0],
      ['condition', '我每天花十五分钟写周报才有可能完成这个假设中的任务。', 0],
    ])
  })
  const query = '我每天花多少时间写周报？我每周学西班牙语多久？'
  const { block, report } = await ask(query, 'UTC')
  assert.deepEqual(report.questions.map(slot => slot.detail), ['duration', 'duration'])
  assert.match(block, /保留按天、周或月的口径和「约」等限定/u)
  assert.deepEqual(report.questions.map(slot => slot.injected.map(hit => hit.sourceRefs[0].sourceId)), [[sources.writing], [sources.language]])
  assert.doesNotMatch(block, /八十分钟|三小时|九小时|六小时|十五分钟/u)
  for (const slot of report.questions) {
    assert.equal(assessAnswerCoverage(slot, '写周报每天40分钟，学西班牙语每周2小时。', report.questions).answerCoverage, 'covered')
    assert.equal(assessAnswerCoverage(slot, '写周报每周40分钟，学西班牙语每天2小时。', report.questions).answerCoverage, 'unverified')
  }
  blockSourceRecall(dataDir, { projectKey, sourceRefs: [{ sourceId: sources.writing }] })
  const after = await ask(query, 'UTC')
  assert.doesNotMatch(after.block, /四十分钟/u)
  assert.deepEqual(after.report.questions.map(slot => slot.injected.map(hit => hit.sourceRefs[0].sourceId)), [[], [sources.language]])
})

test('a completed stay links the duration only to its own narrated destination', async t => {
  const now = Date.UTC(2026, 10, 25)
  t.mock.method(Date, 'now', () => now)
  let sources
  const ask = await setup(t, {}, [], (root, key) => {
    sources = measureSources(root, key, now, [
      ['named', 'I visited the Amber Gardens when I was in Japan two years ago. I spent two weeks traveling alone around the country.'],
      ['lodging', 'I stayed in small hostels during my trip to Japan. We talked to other travelers.'],
      ['plan', "I'm thinking about traveling in Korea for three weeks next spring."],
      ['someone-else', 'My sister stayed in Japan for nine weeks.'],
      ['two-places', 'I spent twelve weeks traveling around Japan and Denmark.'],
      ['crossed-location', 'I was in Denmark last year. My brother went to Italy and I spent seven weeks there.'],
      ['other-project', 'I stayed in Denmark for thirteen weeks.', 1, 'different-project'],
    ])
  })
  const known = await ask('How long was I in Japan for?', 'UTC')
  assert.equal(known.report.questions[0].detail, 'duration')
  assert.match(known.block, /Amber Gardens.*two weeks traveling alone/u)
  assert.doesNotMatch(known.block, /nine weeks|small hostels|twelve weeks/u)
  assert.deepEqual(known.report.questions[0].injected.map(hit => hit.sourceRefs[0].sourceId), [sources.named])
  assert.equal(assessAnswerCoverage(known.report.questions[0], 'Two weeks.').answerCoverage, 'covered')
  for (const place of ['Korea', 'Denmark']) {
    const missing = await ask('How long was I in ' + place + ' for?', 'UTC')
    assert.equal(missing.block, '')
    assert.deepEqual(missing.report.questions[0].injected, [])
  }
})

test('the commute keeps its each-way meaning and a completed task uses its own elapsed time', async t => {
  const now = Date.UTC(2026, 10, 25)
  t.mock.method(Date, 'now', () => now)
  const ask = await setup(t, {}, [], (root, key) => {
    measureSources(root, key, now, [
      ['commute', "I've been listening to audiobooks during my daily commute, which takes 45 minutes each way."],
      ['leisure', 'The drive to my gym takes 15 minutes.'],
      ['task', 'Also, by the way, I just assembled the birch bookshelf recently and it took me four hours, which went well.'],
      ['task-other', 'I assembled the desk and it took me two hours, before I assembled the birch bookshelf.'],
      ['task-ambiguous', 'I assembled a chair before the birch bookshelf and it took me 47 minutes.'],
      ['move', 'It took me and my friends around five hours to move everything into the new apartment, but it was worth it.'],
    ])
  })
  const commute = await ask('How long is my daily commute to work?', 'UTC')
  assert.match(commute.block, /45 minutes each way/u)
  assert.doesNotMatch(commute.block, /15 minutes/u)
  const slot = commute.report.questions[0]
  assert.equal(slot.detail, 'duration')
  assert.equal(assessAnswerCoverage(slot, 'About 45 minutes one way.').answerCoverage, 'covered')
  assert.equal(assessAnswerCoverage(slot, '45 minutes round trip.').answerCoverage, 'unverified')
  const elapsed = await ask('How long did it take me to assemble the birch bookshelf?', 'UTC')
  assert.match(elapsed.block, /four hours/u)
  assert.doesNotMatch(elapsed.block, /two hours|47 minutes/u)
  assert.equal(elapsed.report.questions[0].detail, 'duration')
  assert.match((await ask('How long did it take to move to the new apartment?', 'UTC')).block, /five hours/u)
})

test('a routine change keeps both periods from one original and rejects a different activity', async t => {
  const now = Date.UTC(2026, 10, 25)
  t.mock.method(Date, 'now', () => now)
  let sources
  const ask = await setup(t, {}, [], (root, key) => {
    sources = measureSources(root, key, now, [
      ['both', 'I used to play tennis with my friends at the city park every week, but now I play tennis with my friends at the city park every other week.'],
      ['different-place', 'I play tennis with my friends at the private club twice a week.', 0],
      ['future-plan', "I'm planning to play tennis with my friends at the city park every day next month.", 0],
      ['future-clock', 'I play tennis with my friends at the city park twice a month.', -1],
    ])
  })
  const query = 'How often do I play tennis with my friends at the city park previously? How often do I play now?'
  const { block, report } = await ask(query, 'UTC')
  assert.equal(report.questions.length, 2)
  assert.deepEqual(report.questions.map(slot => slot.detail), ['frequency', 'frequency'])
  assert.match(block, /Earlier frequency.*every week/u)
  assert.match(block, /Current frequency.*every other week/u)
  assert.doesNotMatch(block, /twice a week|every day|twice a month/u)
  for (const slot of report.questions) {
    assert.deepEqual(slot.injected.map(hit => hit.sourceRefs[0].sourceId), [sources.both])
    assert.equal(assessAnswerCoverage(slot, 'Previously, every week. Now, every other week.', report.questions).answerCoverage, 'covered')
    assert.equal(assessAnswerCoverage(slot, 'The earlier frequency was weekly. The current frequency is every other week.', report.questions).answerCoverage, 'covered')
    assert.equal(assessAnswerCoverage(slot, 'Previously, every other week. Now, every week.', report.questions).answerCoverage, 'unverified')
  }
  assert.equal((await ask('How often do I play table tennis with my friends at the city park?', 'UTC')).block, '')
})

test('a routine can cite an earlier cadence when the old venue is unconfirmed', async t => {
  const now = Date.UTC(2026, 10, 25)
  t.mock.method(Date, 'now', () => now)
  const ask = await setup(t, {}, [], (root, key) => {
    measureSources(root, key, now, [
      ['older', 'I saw some people playing tennis at the riverside park. That reminds me of my own weekly tennis sessions with friends.', 80],
      ['current', "By the way, I'm planning to play tennis with my friends at the riverside park this Sunday, like we do every other week."],
    ])
  })
  const query = 'How often do I play tennis with my friends at the riverside park previously? How often do I play now?'
  const { block, report } = await ask(query, 'UTC')
  assert.match(block, /weekly tennis sessions with friends/u)
  assert.match(block, /earlier venue is unconfirmed/iu)
  assert.match(block, /Earlier frequency at the requested venue is unknown/u)
  assert.match(block, /like we do every other week/u)
  assert.equal(report.questions[0].injected[0].verified, false)
  assert.equal(report.questions[1].injected[0].verified, true)
})

test('the item limit preserves a disputed duration when only one quote fits', async t => {
  const now = Date.UTC(2026, 10, 25)
  t.mock.method(Date, 'now', () => now)
  const ask = await setup(t, { maxItems: 1 }, [], (root, key) => {
    measureSources(root, key, now, [
      ['one-stay', 'I stayed in Japan for two weeks.', 100],
      ['another-report', 'I stayed in Japan for six weeks.', 40],
    ])
  })
  const { block, report } = await ask('How long was I in Japan for?', 'UTC')
  const slot = report.questions[0]
  assert.equal(slot.injected.length, 1)
  assert.match(block, /duration.*disputed/u)
  assert.equal(assessAnswerCoverage(slot, 'Two weeks.').answerCoverage, 'unverified')
  assert.equal(assessAnswerCoverage(slot, 'Six weeks.').answerCoverage, 'unverified')
})

test('中文停留和通勤的两个时长各读各的原话', async t => {
  const now = Date.UTC(2026, 10, 25)
  t.mock.method(Date, 'now', () => now)
  let sources
  const ask = await setup(t, {}, [], (root, key) => {
    sources = measureSources(root, key, now, [
      ['stay', '去年我在京都住了两个星期。'],
      ['trip', '我计划在京都待六周。', 0],
      ['same-prefix', '我在京都站附近住了九天。', 0],
      ['third-party', '我同事在大阪住了九周。', 0],
      ['commute', '我平时上班通勤单程四十五分钟，往返一个半小时。'],
    ])
  })
  const { block, report } = await ask('我在京都待了多久？上班通勤单程多久？', 'UTC')
  assert.deepEqual(report.questions.map(slot => slot.detail), ['duration', 'duration'])
  assert.deepEqual(report.questions.map(slot => slot.injected.map(hit => hit.sourceRefs[0].sourceId)), [[sources.stay], [sources.commute]])
  assert.match(block, /京都.*两个星期/u)
  assert.match(block, /通勤.*单程四十五分钟/u)
  assert.doesNotMatch(block, /六周|九天|九周|一个半小时/u)
  const answer = '京都：两个星期。上班通勤：单程45分钟。'
  for (const slot of report.questions) {
    assert.equal(assessAnswerCoverage(slot, answer, report.questions).answerCoverage, 'covered')
    assert.equal(assessAnswerCoverage(slot, '在京都待了两周，上班通勤单程45分钟。', report.questions).answerCoverage, 'covered')
  }
  assert.equal(assessAnswerCoverage(report.questions[1], answer.replace('单程45分钟', '来回45分钟'), report.questions).answerCoverage, 'unverified')
  const roundTrip = await ask('通勤来回多久？', 'UTC')
  assert.deepEqual(roundTrip.report.questions[0].injected[0].timeMeasureValues, ['1.5 hour round trip'])
  assert.doesNotMatch(roundTrip.block, /四十五分钟/u)
  assert.equal(assessAnswerCoverage(roundTrip.report.questions[0], '往返90分钟。').answerCoverage, 'covered')
  assert.deepEqual((await ask('我在大阪停留了多久？', 'UTC')).report.questions[0].injected, [])
})

test('中文前后频率在同一条原话中识别明确变化', async t => {
  const now = Date.UTC(2026, 10, 25)
  t.mock.method(Date, 'now', () => now)
  let sources
  const ask = await setup(t, {}, [], (root, key) => {
    sources = measureSources(root, key, now, [
      ['change', '我以前每周和朋友在东门公园打一次网球，现在改成隔周一次了。'],
      ['elsewhere', '我目前每周和朋友在西门公园打两次网球。', 0],
      ['plan', '我打算每周和朋友在东门公园打三次网球。', 0],
    ])
  })
  const question = '我以前和朋友在东门公园多久打一次网球？现在呢？'
  const { block, report } = await ask(question, 'UTC')
  assert.deepEqual(report.questions.map(slot => slot.detail), ['frequency', 'frequency'])
  assert.deepEqual(report.questions.map(slot => slot.injected.map(hit => hit.sourceRefs[0].sourceId)), [[sources.change], [sources.change]])
  assert.match(block, /以前.*每周/u)
  assert.match(block, /现在.*隔周/u)
  assert.doesNotMatch(block, /西门|三次/u)
  for (const slot of report.questions) {
    assert.equal(assessAnswerCoverage(slot, '以前每周一次，现在隔周一次。', report.questions).answerCoverage, 'covered')
    assert.equal(assessAnswerCoverage(slot, '以前一周一次，现在两周一次。', report.questions).answerCoverage, 'covered')
    assert.equal(assessAnswerCoverage(slot, '以前隔周一次，现在每周一次。', report.questions).answerCoverage, 'unverified')
  }
  assert.equal((await ask('我多久和朋友在东门公园打一次乒乓球？', 'UTC')).block, '')
  const followUp = recallQueryPlan('现在呢？', '我以前和朋友在东门公园多久打一次网球？', true)
  assert.equal(followUp[0].timeMeasure.period, 'current')
  assert.equal(followUp[0].timeMeasure.scope.activity, '网球')
})

test('中文任务耗时只取已完成的原话，并核对中文数字', async t => {
  const now = Date.UTC(2026, 10, 25)
  t.mock.method(Date, 'now', () => now)
  const ask = await setup(t, {}, [], (root, key) => {
    measureSources(root, key, now, [
      ['task', '我花了半个小时组装好白桦书架。'],
      ['plan', '我计划花两个小时组装白桦书架。', 0],
      ['question', '我组装白桦书架花了四个小时吗？上周还在看说明书。', 0],
      ['use-cn', '我已经用青舟缓存九个月了。'],
      ['use-en', "I've used Quartz for seven months now."],
    ])
  })
  const task = await ask('我组装白桦书架花了多久？', 'UTC')
  assert.match(task.block, /半个小时/u)
  assert.doesNotMatch(task.block, /两个小时|四个小时/u)
  assert.equal(assessAnswerCoverage(task.report.questions[0], '半小时。').answerCoverage, 'covered')
  assert.equal(assessAnswerCoverage(task.report.questions[0], '30分钟。').answerCoverage, 'covered')
  const cn = await ask('我用青舟缓存多久了？', 'UTC')
  assert.equal(assessAnswerCoverage(cn.report.questions[0], '九个月。').answerCoverage, 'covered')
  const en = await ask('我用了 Quartz 多久？', 'UTC')
  assert.match(en.block, /seven months/u)
  assert.equal(assessAnswerCoverage(en.report.questions[0], '七个月。').answerCoverage, 'covered')
})

const anchoredDurationQuestion = 'How long had I been taking piano lessons when I bought the maple keyboard?'
function durationSource(root, projectKey, messageId, text, eventTime, timeZone = 'UTC') {
  const source = saveSource(root, { sessionId: 'earlier-' + messageId, messageId, projectKey,
    role: 'user', sourceKind: 'user', text, eventTime, at: Date.now(), timeZone })
  assert.ok(grantSourceRecall(root, readSource(root, source.id), projectKey))
  return source.id
}

test('a place question joins an asserted action and location across authorized conversations', async t => {
  const now = Date.UTC(2026, 10, 25, 10)
  t.mock.method(Date, 'now', () => now)
  let root, actionId, placeId
  const action = 'I displayed my cobalt sensor at my first optics conference.'
  const place = 'I attended my first optics conference at Juniper University.'
  const ask = await setup(t, {}, [], (data, key) => {
    root = data
    const add = (id, text, at = now - 3600_000, scope = key) => durationSource(data, scope, id, text, at)
    actionId = add('check-action', action)
    placeId = add('check-place', place)
    add('another-event', 'I attended my first materials conference at Holly University.')
    add('unrelated-venue', 'I attended my second optics conference at Maple University.')
    add('claim-about-someone', 'I heard that my first optics conference took place at Cedar University.')
    add('planned', 'My first optics conference was supposed to take place at Fir University.')
    add('future', 'My first optics conference took place at Future University.', now + 1)
    add('foreign', 'My first optics conference took place at Other University.', now - 1,
      projectIdentity(join(data, 'other', 'project')).key)
    add('han-action', '我在我的第一场材料研讨会上展示了玄石样机。')
    add('han-place', '我的第一场材料研讨会在栖雾大学举行。')
  })
  const prompt = 'At which university did I present my cobalt sensor?'
  const result = await ask(prompt,'UTC')
  const slot = result.report.questions[0]
  assert.equal(slot.eventLocation?.name, 'Juniper University')
  assert.deepEqual(slot.injected.map(evidence => evidence.selectedQuote), [action, place])
  assert.deepEqual(slot.injected.flatMap(hit => hit.sourceRefs.map(ref => ref.sourceId)), [actionId, placeId])
  assert.ok(slot.injected.every(evidence => result.block.includes(evidence.text)))
  assert.doesNotMatch(result.block, /Holly|Maple|Cedar|Fir|Future|Other University/u)
  assert.equal(assessAnswerCoverage(slot, 'You presented it at Juniper University.').answerCoverage, 'covered')
  assert.equal(assessAnswerCoverage(slot, '你是在这所大学（Juniper University）展示的。').answerCoverage, 'covered')
  assert.equal(assessAnswerCoverage(slot, 'Juniper University. Actually, Maple University.').answerCoverage, 'unverified')
  assert.equal(assessAnswerCoverage(slot, 'It was not at Juniper University.').answerCoverage, 'unverified')
  const chinese = await ask('我在哪所大学展示了玄石样机？','UTC')
  assert.equal(chinese.report.questions[0].eventLocation?.name, '栖雾大学')
  assert.match(chinese.block, /我的第一场材料研讨会在栖雾大学举行/u)
  assert.equal(assessAnswerCoverage(chinese.report.questions[0], '你是在栖雾大学展示的。').answerCoverage, 'covered')
  blockSourceRecall(root, { sourceRefs: [{ sourceId: placeId }] })
  const forgotten = await ask(prompt,'UTC')
  assert.equal(forgotten.report.questions[0].eventLocation, undefined)
  assert.doesNotMatch(forgotten.block, /Juniper|Future|Other University/u)
  const partial = await setup(t, {}, ['I presented my cobalt sensor at my first optics conference.'])
  const incomplete = await partial(prompt,'UTC')
  assert.ok(incomplete.report.questions[0].injected.length > 0)
  assert.equal(assessAnswerCoverage(incomplete.report.questions[0],
    'You displayed your cobalt sensor at your first optics conference.').answerCoverage, 'unverified')
  assert.ok(incomplete.report.unresolved.length > 0)
})

test('a place association needs a unique event and enough budget for both original statements', async t => {
  const now = Date.UTC(2026, 10, 25, 10)
  t.mock.method(Date, 'now', () => now)
  const seed = ({ conflict, action = 'I tested the amber monitor at workshop AX-112.',
    place = 'Workshop AX-112 took place at Marrow Campus.' } = {}) => (root, projectKey) => {
    const add = (name, text) => durationSource(root, projectKey, name, text, now - 1000)
    add('action', action)
    add('place', place)
    add('named-other', 'Workshop AX-113 took place at Clover Campus.')
    if (conflict) add('conflict', 'Workshop AX-112 was held at Poppy Campus.')
  }
  const prompt = 'At which campus did I test the amber monitor?'
  const ask = await setup(t, {}, [], seed())
  assert.equal((await ask(prompt,'UTC')).report.questions[0].eventLocation?.name, 'Marrow Campus')
  const conflict = await setup(t, {}, [], seed({ conflict: true }))
  assert.equal((await conflict(prompt,'UTC')).report.questions[0].eventLocation, undefined)
  const joint = await setup(t, {}, [], seed({ place: 'Workshop AX-112 took place at Marrow Campus and Needle Campus.' }))
  assert.equal((await joint(prompt,'UTC')).report.questions[0].eventLocation, undefined)
  const prefix = await setup(t, {}, [], seed({ action: 'I tested the amber monitor at workshop AX-112 afterparty.' }))
  assert.equal((await prefix(prompt,'UTC')).report.questions[0].eventLocation, undefined)
  const namedInAction = await setup(t, {}, [], seed({ action: 'I tested the amber monitor at workshop AX-112 at Peak Campus.' }))
  assert.equal((await namedInAction(prompt,'UTC')).report.questions[0].eventLocation, undefined)
  const corrected = await setup(t, {}, ['The amber monitor was tested at Peak Campus.'], seed())
  const current = await corrected(prompt,'UTC')
  assert.equal(current.report.questions[0].eventLocation, undefined)
  assert.match(current.block, /Peak Campus/u)
  assert.doesNotMatch(current.block, /Marrow Campus/u)
  const tight = await setup(t, { maxItems: 1 }, [], seed())
  const limited = await tight(prompt,'UTC')
  assert.equal(limited.report.questions[0].eventLocation, undefined)
  assert.doesNotMatch(limited.block, /Marrow Campus/u)
})

test('an event age uses the historical local day and the queued question day', async t => {
  const now = Date.UTC(2026,10,25,8,10)
  const zone = 'America/Los_Angeles'
  t.mock.method(Date,'now',()=>now)
  let root, confirmed
  const ask = await setup(t,{},[],(data,key)=>{
    root = data
    confirmed = durationSource(root,key,'attended','I attended the Copperline workshop today.',Date.UTC(2026,10,18,7,50),zone)
    durationSource(root,key,'hypothetical','I was planning to attend the Copperline workshop yesterday.',now-86400_000,zone)
    durationSource(root,key,'other-event','I attended the Riverside workshop yesterday and mentioned the Copperline workshop.',now-86400_000,zone)
    durationSource(root,key,'after-question','I attended the Copperline workshop today.',Date.UTC(2026,10,25,8,0),zone)
    blockSourceRecall(root,{sourceRefs:[{sourceId:durationSource(root,key,'revoked','I attended the Copperline workshop today.',now-10*86400_000,zone)}]})
    durationSource(root,'foreign-project','foreign','I attended the Copperline workshop today.',now-86400_000,zone)
  })
  // The observation issued just after midnight is later than this queued question.
  const result = await ask('How many days ago did I attend the Copperline workshop?',zone,{
    id:'age-queued',at:Date.UTC(2026,10,25,7,55),
  })
  const slot = result.report.questions[0]
  assert.equal(slot.eventAge?.days,7)
  assert.deepEqual(slot.injected.flatMap(hit=>hit.sourceRefs.map(ref=>ref.sourceId)),[confirmed])
  assert.equal(slot.injected[0].selectedQuote,'I attended the Copperline workshop today.')
  assert.match(result.block,/attended the Copperline workshop 7 days ago/u)
  assert.equal(assessAnswerCoverage(slot,'It was seven days ago.').answerCoverage,'covered')
  assert.equal(assessAnswerCoverage(slot,'It was eight days ago.').answerCoverage,'unverified')
})

test('a completed event age can express weeks with remaining days and calendar months', async t => {
  const now = Date.UTC(2027,1,28,12)
  t.mock.method(Date,'now',()=>now)
  const ask = await setup(t,{},[],(root,key)=>{
    durationSource(root,key,'equipment','I bought the amber stand today.',now-8*86400_000)
    durationSource(root,key,'ledger','I finished the Aurora ledger today.',Date.UTC(2027,0,31,12))
    durationSource(root,key,'zh-event','我两周前参加了青梧巡检。',now-2*86400_000)
  })
  const weeks=await ask('How many weeks ago did I buy the amber stand?','UTC')
  assert.equal(weeks.report.questions[0].eventAge?.days,8)
  assert.match(weeks.block,/8 days ago \(1 week and 1 day\)/u)
  assert.equal(assessAnswerCoverage(weeks.report.questions[0],'One week and one day ago.').answerCoverage,'covered')
  assert.equal(assessAnswerCoverage(weeks.report.questions[0],
    'You bought the amber stand 1 week and 1 day ago. Therefore, you bought it 1 week ago.').answerCoverage,'unverified')
  assert.equal(assessAnswerCoverage(weeks.report.questions[0],
    'It was one week and one day ago, which is eight days ago.').answerCoverage,'covered')
  assert.equal(assessAnswerCoverage(weeks.report.questions[0],
    'It was eight days (one week and one day) ago.').answerCoverage,'covered')
  const months=await ask('How many months ago did I finish the Aurora ledger?','UTC')
  assert.match(months.block,/1 month ago/u)
  assert.equal(assessAnswerCoverage(months.report.questions[0],'It was a month ago.').answerCoverage,'covered')
  const chinese=await ask('我参加青梧巡检是几天前？','UTC')
  assert.equal(chinese.report.questions[0].eventAge?.days,16)
  assert.match(chinese.block,/参加青梧巡检.*16 天前/u)
  assert.equal(assessAnswerCoverage(chinese.report.questions[0],'十六天前。').answerCoverage,'covered')
})

test('uncertain dates, conflicting originals and a different clock zone cannot establish an event age', async t => {
  const now = Date.UTC(2026,10,25,13)
  t.mock.method(Date,'now',()=>now)
  const ask = await setup(t,{},[],(root,key)=>{
    durationSource(root,key,'approximate','I attended the Wren workshop about two weeks ago.',now-2*86400_000)
    durationSource(root,key,'first','I visited the Cedar archive today.',now-5*86400_000)
    durationSource(root,key,'second','I visited the Cedar archive today.',now-7*86400_000)
    durationSource(root,key,'other-clock','I submitted the Pine packet today.',now-3*86400_000,'America/Los_Angeles')
  })
  for (const query of [
    'How many days ago did I attend the Wren workshop?',
    'How many days ago did I visit the Cedar archive?',
    'How many days ago did I submit the Pine packet?',
  ]){
    const result=await ask(query,'UTC')
    assert.equal(result.report.questions[0].eventAge?.days,null)
    assert.equal(result.report.questions[0].injected.length,0)
    assert.doesNotMatch(result.block,/\d+ days ago/u)
  }
})

test('a same-day event keeps its linked date while a return date alone supplies no exact age', async t => {
  const now = Date.UTC(2026,10,25,13)
  t.mock.method(Date,'now',()=>now)
  const ask = await setup(t,{},[],(root,key)=>{
    durationSource(root,key,'same-day','I ate lunch at the studio today when we watched the Cedar Final — everyone enjoyed it.',
      now-5*86400_000)
    durationSource(root,key,'return','I got back from the Lantern seminar today.',now-2*86400_000)
    durationSource(root,key,'held','I got back from the Ridge seminar that ran from 2 PM to 4 PM yesterday.',now-2*86400_000)
  })
  const watched=await ask('How many days ago did I watch the Cedar Final?','UTC')
  assert.equal(watched.report.questions[0].eventAge?.days,5)
  assert.equal(watched.report.questions[0].injected[0].selectedQuote,'today when we watched the Cedar Final')
  const returned=await ask('How many days ago did I attend the Lantern seminar?','UTC')
  assert.equal(returned.report.questions[0].eventAge?.days,null)
  assert.equal(returned.report.questions[0].eventAge?.boundedByReturn,true)
  assert.match(returned.report.questions[0].injected[0].selectedQuote,/got back from the Lantern seminar/u)
  assert.match(returned.block,/returning from the Lantern seminar.*attendance date is unknown/u)
  assert.doesNotMatch(returned.block,/\d+ days ago/u)
  const held=await ask('How many days ago did I attend the Ridge seminar?','UTC')
  assert.equal(held.report.questions[0].eventAge?.days,3)
})

test('time already spent at a named event uses two original clocks and independent authorized quotes', async t => {
  const now = Date.UTC(2026, 10, 25, 13)
  const zone = 'America/Los_Angeles'
  t.mock.method(Date, 'now', () => now)
  let root, evidence
  const ask = await setup(t, {}, [], (dataDir, key) => {
    root = dataDir
    evidence = [
      durationSource(root, key, 'activity', "I've been taking weekly piano lessons with my instructor for six weeks now.",
        Date.UTC(2026, 10, 25, 0, 30), zone),
      durationSource(root, key, 'acquisition', 'I bought the maple keyboard two weeks ago.',
        Date.UTC(2026, 10, 25, 8, 15), zone),
    ]
    for (const [id, text] of [
      ['different-activity', "I've been taking piano lessons for beginners for three weeks now."],
      ['accessory', 'I bought the maple keyboard stand yesterday.'],
      ['plan', 'I intended to buy the maple keyboard on November 24, 2026.'],
      ['ordered', 'I ordered the maple keyboard yesterday.'],
      ['different-person', 'My colleague bought the maple keyboard yesterday.'],
      ['date-in-another-clause', 'I bought the maple keyboard at a shop I visited two weeks ago.'],
    ]) durationSource(root, key, id, text, now, zone)
    durationSource(root, 'other-project', 'foreign', 'I bought the maple keyboard yesterday.', now, zone)
  })
  const { block, report } = await ask(anchoredDurationQuestion, zone)
  const slot = report.questions[0]
  assert.equal(slot.durationAtEvent?.days, 29)
  assert.deepEqual(slot.injected.map(hit => hit.sourceRefs[0].sourceId), evidence)
  assert.ok(slot.injected.every(hit => block.includes(hit.text)))
  assert.equal(slot.durationAtEvent.projected, true)
  assert.ok(slot.injected.every(hit => hit.selectedQuote && hit.sourceRefs[0].excerpt.includes(hit.selectedQuote)))
  assert.match(block, /Answer to the question: You had been taking piano lessons for 29 days when you bought the maple keyboard\.\n<\/memory-context>$/u)
  assert.doesNotMatch(block, /stand|for beginners|colleague|visited|intended|ordered|six weeks|two weeks ago/u)
  assert.equal(assessAnswerCoverage(slot, 'At the purchase I had been taking piano lessons for 29 days.').answerCoverage, 'covered')
  assert.equal(assessAnswerCoverage(slot, 'I had been taking the lessons for six weeks.').answerCoverage, 'unverified')
  assert.equal(assessAnswerCoverage(slot, "29 days. I can't determine the duration at the purchase.").answerCoverage, 'unverified')

  blockSourceRecall(root, { sourceRefs: [{ sourceId: evidence[0] }] })
  const after = await ask(anchoredDurationQuestion, zone)
  assert.equal(after.report.questions[0].durationAtEvent?.days, null)
  assert.deepEqual(after.report.questions[0].injected, [])
  assert.match(after.block, /Answer to the question: The available memories do not establish the duration at that event\./u)
  assert.doesNotMatch(after.block, /six weeks|29 days/u)
})

test('time already spent does not resolve conflicting events or dates outside the ongoing statement', async t => {
  const at = Date.UTC(2026, 10, 25, 13)
  t.mock.method(Date, 'now', () => at)
  const ask = await setup(t, {}, [], (root, key) => {
    durationSource(root, key, 'activity', "I've been taking piano lessons for six weeks now.", at)
    durationSource(root, key, 'first-purchase', 'I bought the maple keyboard on November 10, 2026.', at)
    durationSource(root, key, 'second-purchase', 'I bought the maple keyboard on November 12, 2026.', at)
    durationSource(root, key, 'old-purchase', 'I bought the birch keyboard on October 10, 2026.', at)
    durationSource(root, key, 'late-purchase', 'I bought the cedar keyboard on November 25, 2026.', at, 'Pacific/Kiritimati')
  })
  for (const item of ['maple', 'birch', 'cedar']) {
    const result = await ask(anchoredDurationQuestion.replace('maple', item), 'UTC')
    assert.equal(result.report.questions[0].durationAtEvent?.days, null, item)
    assert.deepEqual(result.report.questions[0].injected, [], item)
    assert.doesNotMatch(result.block, /\b\d+ (?:days|weeks)\b/u, item)
  }
})

test('time already spent keeps both observations together when the request only has room for one', async t => {
  const at = Date.UTC(2026, 10, 25, 13)
  t.mock.method(Date, 'now', () => at)
  const ask = await setup(t, { maxItems: 1 }, [], (root, key) => {
    durationSource(root, key, 'activity', "I've been taking piano lessons for six weeks now.", at)
    durationSource(root, key, 'purchase', 'I bought the maple keyboard two weeks ago.', at)
  })
  const result = await ask(anchoredDurationQuestion, 'UTC')
  assert.deepEqual(result.report.budgetOmitted, [anchoredDurationQuestion])
  assert.equal(result.report.questions[0].durationAtEvent?.days, null)
  assert.deepEqual(result.report.questions[0].injected, [])
  assert.doesNotMatch(result.block, /six weeks|two weeks|four weeks|28 days/u)
})

test('time already spent can show a conditional result for an acquired item with a nearby qualifier', async t => {
  const at = Date.UTC(2026, 10, 25, 13)
  t.mock.method(Date, 'now', () => at)
  const ask = await setup(t, {}, [], (root, key) => {
    durationSource(root, key, 'activity', "I've been taking weekly ceramics classes with a new tutor, Robin, for six weeks now.", at)
    durationSource(root, key, 'acquisition', "I'm looking for pottery glaze ideas. I just got a kiln two weeks ago and I want to try it.", at)
  })
  const result = await ask('When I bought the pottery kiln, how long had I been taking ceramics classes?', 'UTC')
  const slot = result.report.questions[0]
  assert.equal(slot.durationAtEvent?.days, 28)
  assert.equal(slot.durationAtEvent?.conditional, true)
  assert.match(result.block, /Answer to the question: If you mean when you got the kiln, you had been taking ceramics classes for 4 weeks at that time\./u)
  assert.doesNotMatch(result.block, /pottery glaze ideas|six weeks|two weeks ago/u)
  assert.match(slot.injected[1].selectedQuote, /pottery glaze ideas[\s\S]+got a kiln two weeks ago/u)
  assert.equal(assessAnswerCoverage(slot, 'Four weeks when you bought it.').answerCoverage, 'unverified')
  assert.equal(assessAnswerCoverage(slot, 'If you mean when you bought the kiln, it had been four weeks.').answerCoverage, 'unverified')
  assert.equal(assessAnswerCoverage(slot, 'It had been four weeks when you got your desk lamp.').answerCoverage, 'unverified')
  assert.equal(assessAnswerCoverage(slot, 'It had been four weeks when you got a desk lamp instead of a kiln.').answerCoverage, 'unverified')
  assert.equal(assessAnswerCoverage(slot, 'It had been four weeks when you got the kiln cover.').answerCoverage, 'unverified')
  assert.equal(assessAnswerCoverage(slot, 'If the kiln you got was the pottery kiln, it had been four weeks.').answerCoverage, 'covered')
})

test('中文询问事件发生时已使用多久按各自原消息日期核对', async t => {
  const at = Date.UTC(2026, 10, 25, 13)
  t.mock.method(Date, 'now', () => at)
  let evidence
  const ask = await setup(t, {}, [], (root, key) => {
    const zone = 'Asia/Shanghai'
    evidence = [
      durationSource(root, key, 'continued', '我已经用青舟缓存六个星期了。', at, zone),
      durationSource(root, key, 'completed', '两周前，我完成了白鹭迁移。', at, zone),
    ]
    durationSource(root, key, 'other', '昨天我完成了白鹭迁移说明。', at, zone)
    durationSource(root, key, 'plan', '我打算在10天前完成白鹭迁移。', at, zone)
    durationSource(root, key, 'past-use', '我以前用青舟缓存八个星期。', at, zone)
    durationSource(root, 'other-project', 'foreign-cn', '昨天我完成了白鹭迁移。', at, zone)
  })
  const { block, report } = await ask('我完成白鹭迁移那天，已经用青舟缓存多久了？', 'Asia/Shanghai')
  const slot = report.questions[0]
  assert.equal(slot.durationAtEvent?.days, 28)
  assert.deepEqual(slot.injected.map(hit => hit.sourceRefs[0].sourceId), evidence)
  assert.ok(slot.injected.every(hit => block.includes(hit.text)))
  assert.match(block, /4 周/u)
  assert.doesNotMatch(block, /迁移说明|打算|六个星期|两周前|八个星期/u)
  assert.deepEqual(slot.injected.map(hit => hit.selectedQuote), ['我已经用青舟缓存六个星期了。', '两周前，我完成了白鹭迁移。'])
  assert.equal(assessAnswerCoverage(slot, '完成迁移时已经用了四周。').answerCoverage, 'covered')
  assert.equal(assessAnswerCoverage(slot, '完成迁移时已经用了六周。').answerCoverage, 'unverified')
})

test('a personal count requires an explicit assertion about the requested unit and uses the newest original event', async t => {
  const now = Date.UTC(2026, 10, 25, 13)
  t.mock.method(Date, 'now', () => now)
  let root, recent
  const query = 'How many stars do I need to reach Gold in the Cedar Rewards program?'
  const ask = await setup(t, {}, [], (dataDir, projectKey) => {
    root = dataDir
    const add = (id, line, age, key = projectKey) => durationSource(root, key, id, line, now - age * 86_400_000)
    add('older-count', 'I need 100 stars to reach Gold in the Cedar Rewards program.', 24)
    recent = add('current-count', 'I actually need 125 stars to reach Gold in the Cedar Rewards program.', 3)
    add('topic-only', "I'm trying to reach Gold and wondering how the stars work in the Cedar Rewards program.", 1)
    add('balance', 'I have 74 stars while trying to reach Gold in the Cedar Rewards program.', 1)
    add('wrong-tier', 'I need 40 stars to reach Silver in the Cedar Rewards program.', 1)
    add('wrong-program', 'I need 30 stars to reach Gold in the Spruce Rewards program.', 1)
    add('quoted-person', 'My colleague said, "I need 85 stars to reach Gold in the Cedar Rewards program."', 1)
    add('related-unit', 'I need 60 star fragments to reach Gold in the Cedar Rewards program.', 1)
    add('plan', 'I think I might need 90 stars to reach Gold in the Cedar Rewards program.', 1)
    add('other-project', 'I need 65 stars to reach Gold in the Cedar Rewards program.', 1, 'foreign-project')
    add('future', 'I need 97 stars to reach Gold in the Cedar Rewards program.', -1)
  })
  const current = await ask(query, 'UTC')
  const slot = current.report.questions[0]
  assert.equal(slot.declaredCount?.value, '125')
  assert.deepEqual(slot.injected.map(hit => hit.sourceRefs[0].sourceId), [recent])
  assert.match(current.block, /125 stars/u)
  assert.doesNotMatch(current.block, /100 stars|74 stars|40 stars|30 stars|85 stars|60 star|65 stars|90 stars|97 stars|wondering/u)
  assert.equal(assessAnswerCoverage(slot, 'You need 125 stars to reach Gold.').answerCoverage, 'covered')
  assert.equal(assessAnswerCoverage(slot, '你需要125stars来达到Gold。').answerCoverage, 'covered')
  assert.equal(assessAnswerCoverage(slot, '根据之前的记忆，你需要 **125 stars** 来达到 Gold。').answerCoverage, 'covered')
  assert.equal(assessAnswerCoverage(slot, '你已经拥有125 stars。').answerCoverage, 'unverified')
  assert.equal(assessAnswerCoverage(slot, '你需要125 stars碎片来达到 Gold。').answerCoverage, 'unverified')
  assert.equal(assessAnswerCoverage(slot, 'You currently have 125 stars.').answerCoverage, 'unverified')
  assert.equal(assessAnswerCoverage(slot, 'You need 125 stars. Actually, you need 100 stars.').answerCoverage, 'unverified')
  blockSourceRecall(root, { sourceRefs: [{ sourceId: recent }] })
  const after = await ask(query, 'UTC')
  assert.equal(after.report.questions[0].declaredCount?.value, '100')
  assert.doesNotMatch(after.block, /125 stars/u)
})

test('count coverage treats a numeral as a whole and rejects approximations', () => {
  const required = { ...declaredCountQuery('How many stars do I need to reach Gold?'), value: '20' }
  assert.equal(matchesDeclaredCountAnswer('You need at least twenty stars.', required), true)
  for (const answer of [
    'You need one hundred twenty stars.',
    'You need one thousand and twenty stars.',
    'You need more than twenty stars.',
    'You need about twenty stars.',
    'You need between 15 and twenty stars.',
  ]) assert.equal(matchesDeclaredCountAnswer(answer, required), false, answer)
  const owned = { ...declaredCountQuery('我现在有多少台扫码器？'), value: '7' }
  assert.equal(matchesDeclaredCountAnswer('你有七台扫码器。', owned), true)
  assert.equal(matchesDeclaredCountAnswer('你有大约七台扫码器。', owned), false)
  assert.equal(matchesDeclaredCountAnswer('你有七台扫码器 左右。', owned), false)
})

test('a redeemable count preserves the program scope and accepts explicitly counted entitlements', async t => {
  const now = Date.UTC(2026, 10, 25, 13)
  t.mock.method(Date, 'now', () => now)
  let expected
  const ask = await setup(t, {}, [], (root, key) => {
    durationSource(root, key, 'old-redemption', "I've accumulated enough points for a single free night's stay at any Ash Hotel.", now - 432_000_000)
    expected = durationSource(root, key, 'updated-redemption', "I've accumulated enough points for two free night's stays at any Ash Hotel.", now - 86_400_000)
    durationSource(root, key, 'planning', "I'm considering redeeming my Ash Hotel points for a stay.", now)
    durationSource(root, key, 'other-issuer', "I can redeem four free night's stays at any Fir Hotel.", now)
    durationSource(root, key, 'expired', "I could redeem eight free night's stays at any Ash Hotel before the points expired.", now)
    durationSource(root, key, 'guest-passes', "I've accumulated enough points for two guest passes at any Ash Hotel.", now)
  })
  const result = await ask("How many free night's stays can I redeem at any Ash Hotel with my accumulated points?", 'UTC')
  const slot = result.report.questions[0]
  assert.equal(slot.declaredCount?.value, '2')
  assert.deepEqual(slot.injected.map(hit => hit.sourceRefs[0].sourceId), [expected])
  assert.match(result.block, /two free night's stays/u)
  assert.doesNotMatch(result.block, /single free|four free|eight free|considering/u)
  assert.equal(assessAnswerCoverage(slot, 'You can redeem two free nights.').answerCoverage, 'covered')
  assert.equal(assessAnswerCoverage(slot, 'You can redeem three free nights.').answerCoverage, 'unverified')
  const passes = await ask('How many guest passes can I redeem at any Ash Hotel?', 'UTC')
  const passSlot = passes.report.questions[0]
  assert.equal(assessAnswerCoverage(passSlot, '您可以在 Ash Hotel redeem 两个嘉宾通行证。').answerCoverage, 'covered')
  assert.equal(assessAnswerCoverage(passSlot, '您可以通过点数在 Ash Hotel redeem两个客座通行证。').answerCoverage, 'covered')
  assert.equal(assessAnswerCoverage(passSlot, '您可以在 Ash Hotel 兑换三个嘉宾通行证。').answerCoverage, 'unverified')
  assert.equal(assessAnswerCoverage(passSlot, '您可以在 Ash Hotel 兑换两个嘉宾通行证套件。').answerCoverage, 'unverified')
  assert.equal(assessAnswerCoverage(passSlot, '您可以在 Ash Hotel 兑换两个停车通行证。').answerCoverage, 'unverified')
})

test('a tried collection count selects the latest actual update for the named collection', async t => {
  const now = Date.UTC(2026, 10, 25, 13)
  t.mock.method(Date, 'now', () => now)
  let root, current, older
  const ask = await setup(t, {}, [], (directory, key) => {
    root = directory
    const add = (id, text, at, project = key) => durationSource(directory, project, id, text, at)
    older = add('older', "Also, by the way, I've been loving Emma's recipes on her channel, I've already tried out two of them.", now - 3000)
    current = add('current', "By the way, I've tried out 3 of Emma's recipes so far, and they're all amazing!", now - 2000)
    add('other', "I have tried four of Maya's recipes so far.", now - 1000)
    add('plans', "I plan to try out five of Emma's recipes.", now - 1000)
    add('bookmarks', "I have saved six of Emma's recipes.", now - 1000)
    add('example', "Here is a test example:\nI have tried ten of Emma's recipes.", now - 1000)
    add('other-actor', "We have tried seven of Emma's recipes.", now - 1000)
    add('other-project', "I have tried eight of Emma's recipes.", now - 1000, 'other-project')
    add('future', "I have tried nine of Emma's recipes.", now + 1000)
  })
  const question = "How many of Emma's recipes have I tried out?"
  const result = await ask(question)
  const slot = result.report.questions[0]
  assert.equal(slot.declaredCount?.value, '3')
  assert.deepEqual(slot.injected.map(hit => hit.sourceRefs[0].sourceId), [current])
  assert.equal(assessAnswerCoverage(slot, "You've tried three of Emma's recipes so far.").answerCoverage, 'covered')
  assert.equal(assessAnswerCoverage(slot, "You've tried three of Maya's recipes.").answerCoverage, 'unverified')
  assert.equal(assessAnswerCoverage(slot, "You've saved three of Emma's recipes.").answerCoverage, 'unverified')
  const queued = await ask(question, 'UTC', { id: 'asked-before-update', at: now - 2500 })
  assert.equal(queued.report.questions[0].declaredCount?.value, '2')
  assert.deepEqual(queued.report.questions[0].injected.map(hit => hit.sourceRefs[0].sourceId), [older])
  blockSourceRecall(root, { sourceRefs: [{ sourceId: current }] })
  const fallback = await ask(question)
  assert.equal(fallback.report.questions[0].declaredCount?.value, '2')
  assert.deepEqual(fallback.report.questions[0].injected.map(hit => hit.sourceRefs[0].sourceId), [older])
  assert.match(fallback.block, /Emma's recipes.*tried out two/iu)
})

test('only an adjacent context in the same original can scope a tried count', async t => {
  const now = Date.UTC(2026, 10, 25, 13)
  t.mock.method(Date, 'now', () => now)
  let expected
  const ask = await setup(t, {}, [], (root, key) => {
    const add = (id, text, at) => durationSource(root, key, id, text, at)
    expected = add('linked', "By the way, have you tried any good Korean restaurants in my city lately? I've tried four different ones so far, and I'm always looking for new recommendations.", now - 3000)
    add('wrong-place', "Have you tried any good Korean restaurants in your city lately? I've tried five different ones so far.", now - 2000)
    add('switched', "Have you tried Korean restaurants in my city? Let's switch to Thai restaurants. I've tried eight different ones so far.", now - 1000)
    add('recent-only', "I have tried seven Korean restaurants in my city this week.", now - 1000)
    add('unbound', "I've tried nine of them so far.", now)
  })
  const result = await ask('How many Korean restaurants have I tried in my city?')
  const slot = result.report.questions[0]
  assert.equal(slot.declaredCount?.value, '4')
  assert.deepEqual(slot.injected.map(hit => hit.sourceRefs[0].sourceId), [expected])
  assert.match(result.block, /Korean restaurants in my city lately\? I've tried four different ones so far/u)
  assert.equal(assessAnswerCoverage(slot, "You've tried four Korean restaurants in your city.").answerCoverage, 'covered')
  assert.equal(assessAnswerCoverage(slot, "You've tried four Korean restaurants in another city.").answerCoverage, 'unverified')
  assert.equal(assessAnswerCoverage(slot, "You've tried four Korean restaurants in your city this week.").answerCoverage, 'unverified')
})

test('same-time count conflicts and another unit cannot establish a current count', async t => {
  const now = Date.UTC(2026, 10, 25, 13)
  t.mock.method(Date, 'now', () => now)
  const ask = await setup(t, {}, [], (root, key) => {
    durationSource(root, key, 'stock-a', '我现在在北门仓有五块树莓派。', now)
    durationSource(root, key, 'stock-b', '我现在在北门仓有八块树莓派。', now)
    durationSource(root, key, 'another-warehouse', '我现在在南门仓有十三块树莓派。', now)
    durationSource(root, key, 'unrelated-unit', '我现在在北门仓有二十块采集卡。', now)
    durationSource(root, key, 'prefix-unit', '我现在在北门仓有九块树莓派外壳。', now)
  })
  const result = await ask('我在北门仓现在有多少块树莓派？', 'UTC')
  assert.equal(result.report.questions[0].declaredCount?.value, null)
  assert.deepEqual(result.report.questions[0].injected, [])
  assert.doesNotMatch(result.block, /五块|八块|十三块|二十块/u)
  const wrong = await ask('我在北门仓现在有多少个探头？', 'UTC')
  assert.equal(wrong.block, '')
  const memoryOnly = await ask('只根据已有记忆回答，不调用工具。我在北门仓现在有多少个探头？', 'UTC')
  assert.match(memoryOnly.block, /现有记忆不足以确定数量/u)
  assert.match(memoryOnly.block, /note="直接说明数量无法从记忆确定。/u)
  assert.deepEqual(memoryOnly.report.questions[0].injected, [])
})

test('completed series totals use the latest same-author original and the activity scope', async t => {
  const now = Date.UTC(2026, 10, 25, 13)
  t.mock.method(Date, 'now', () => now)
  let dataDir, earlier, current, short
  const named = "I've been brushing up on my Python skills by watching Ava Reed's Python programming series on YouTube, and I've completed 20 videos so far."
  const latest = "I've completed 30 videos of Ava Reed's Python series, and I'm excited to apply my Python skills to parsing documents."
  const ask = await setup(t, {}, [], (root, key) => {
    dataDir = root
    const add = (id, text, offset, scope = key) => durationSource(root, scope, id, text, now + offset)
    earlier = add('series-before', named, -3000)
    short = add('short-first-name', "I've completed 30 videos so far for Ava's series and I'll start the cloud course.", -1000)
    current = add('series-now', latest, -1000)
    add('other-author', "I've completed 58 videos of Ava Green's Python programming series.", 0)
    add('other-title', "I've completed 61 videos of Ava Reed's Python testing series.", 0)
    add('other-owner', "We've completed 62 videos of Ava Reed's Python programming series.", 0)
    add('other-unit', "I've completed 63 exercises from Ava Reed's Python programming series.", 0)
    add('not-complete', "I started 64 videos of Ava Reed's Python programming series.", 0)
    add('interval', "I've completed 65 videos of Ava Reed's Python programming series this week.", 0)
    add('scenario', "Here is a test example:\nI've completed 66 videos of Ava Reed's Python programming series.", 0)
    add('different-topic', "I've finished my Rust course, and I've completed 67 Rust lessons so far.", 0)
    add('future', "I've completed 99 videos of Ava Reed's Python programming series.", 1)
    add('foreign', "I've completed 76 videos of Ava Reed's Python programming series.", 0, 'foreign-project')
  })
  const question = "How many videos of Ava Reed's Python programming series have I completed so far?"
  const result = await ask(question, 'UTC')
  const slot = result.report.questions[0]
  assert.equal(slot.declaredCount?.value, '30')
  assert.deepEqual(slot.injected.map(hit => hit.sourceRefs[0].sourceId), [current])
  assert.equal(slot.injected[0].selectedQuote, latest)
  assert.ok(result.block.includes(latest))
  const cover = answer => assessAnswerCoverage(slot, answer).answerCoverage
  assert.equal(cover("You completed 30 videos of Ava Reed's Python programming series."), 'covered')
  assert.equal(cover('Thirty videos.'), 'covered')
  assert.equal(cover("You completed 30 videos of Ava Green's Python programming series."), 'unverified')
  assert.equal(cover("You completed 30 videos of Ava Reed's Python testing series."), 'unverified')
  assert.equal(cover("You completed 30 videos of Ava Reed's Python programming series today."), 'unverified')
  const queued = await ask(question, 'UTC', { id:'series-before-update', at:now - 2500 })
  assert.equal(queued.report.questions[0].declaredCount?.value, '20')
  assert.deepEqual(queued.report.questions[0].injected.map(hit => hit.sourceRefs[0].sourceId), [earlier])
  blockSourceRecall(dataDir, {sourceRefs:[{sourceId:current}]})
  const ambiguous = await ask(question,'UTC')
  assert.equal(ambiguous.report.questions[0].declaredCount?.value, null)
  assert.deepEqual(ambiguous.report.questions[0].injected, [])
  blockSourceRecall(dataDir, {sourceRefs:[{sourceId:short}]})
  const inherited = await ask(question,'UTC')
  assert.equal(inherited.report.questions[0].declaredCount?.value, '20')
  assert.deepEqual(inherited.report.questions[0].injected.map(hit => hit.sourceRefs[0].sourceId), [earlier])
})

test('compound number words cannot bypass unit and series validation', () => {
  const stock = { ...declaredCountQuery('How many dozen eggs do we have stored in our refrigerator?'), value:'32' }
  assert.equal(matchesDeclaredCountAnswer('Thirty-two.', stock), true)
  assert.equal(matchesDeclaredCountAnswer('Thirty-two dozen eggs.', stock), true)
  assert.equal(matchesDeclaredCountAnswer('Thirty-two crates of melons.', stock), false)
  assert.equal(matchesDeclaredCountAnswer('Thirty-two total species of wildlife.', stock), false)
  const series = { ...declaredCountQuery("How many videos of Ava Reed's Python series have I completed so far?"), value:'32' }
  assert.equal(matchesDeclaredCountAnswer('Thirty-two videos.', series), true)
  assert.equal(matchesDeclaredCountAnswer('Thirty-two lessons.', series), false)
  const owned = { ...declaredCountQuery('我现在有多少台扫码器？'), value:'32' }
  assert.equal(matchesDeclaredCountAnswer('三十二。', owned), true)
  assert.equal(matchesDeclaredCountAnswer('三十二台电动机。', owned), false)
})

test('a shortened series title requires evidence for the same topic and full creator', async t => {
  const now = Date.UTC(2026, 10, 25, 13)
  t.mock.method(Date, 'now', () => now)
  const ask = await setup(t, {}, [], (root, key) => {
    durationSource(root, key, 'full', "I've completed 11 episodes of Su Lin's Rust programming series.", now - 2000)
    durationSource(root, key, 'abbreviated', "I've completed 12 episodes of Su Lin's Rust series.", now - 1000)
    durationSource(root, key, 'topic-other', "I've completed 13 episodes of another person's Rust series, and I've applied my Rust skills.", now)
  })
  const result = await ask("How many episodes of Su Lin's Rust programming series have I completed so far?", 'UTC')
  assert.equal(result.report.questions[0].declaredCount?.value, null)
  assert.deepEqual(result.report.questions[0].injected, [])
  assert.doesNotMatch(result.block, /11 episodes|12 episodes|13 episodes/u)
})

test('an explicit counted reference keeps its same-statement noun and separates plans that follow it', async t => {
  const now = Date.UTC(2026, 10, 25, 13)
  t.mock.method(Date, 'now', () => now)
  let expected
  const ask = await setup(t, {}, [], (root, key) => {
    durationSource(root, key, 'unrelated-reference', "Speaking of my relay boards, I've got eleven of them.", now)
    durationSource(root, key, 'old-inventory', 'I have two test benches.', now - 172_800_000)
    expected = durationSource(root, key, 'new-inventory',
      "Speaking of my test benches, I've got seven of them, so I might lend a few to the team.", now - 86_400_000)
  })
  const result = await ask('How many test benches do I currently have?', 'UTC')
  assert.equal(result.report.questions[0].declaredCount?.value, '7')
  assert.deepEqual(result.report.questions[0].injected.map(hit => hit.sourceRefs[0].sourceId), [expected])
  assert.match(result.block, /Speaking of my test benches, I've got seven of them/u)
  assert.doesNotMatch(result.block, /might lend|eleven|two test/u)
})

test('an underspecified correction does not replace a scoped amount or present the older amount as current', async t => {
  const now = Date.UTC(2026, 10, 25, 13)
  t.mock.method(Date, 'now', () => now)
  const ask = await setup(t, {}, [], (root, key) => {
    durationSource(root, key, 'older-definition', 'I need 80 credits to unlock Amber in the Juniper program.', now - 86_400_000)
    durationSource(root, key, 'unknown-program-correction', 'Actually, I need 60 credits to unlock Amber, not 80.', now)
  })
  const result = await ask('How many credits do I need to unlock Amber in the Juniper program?', 'UTC')
  assert.equal(result.report.questions[0].declaredCount?.value, null)
  assert.deepEqual(result.report.questions[0].injected, [])
  assert.match(result.block, /note="No verified count was found\. Answer that the count cannot be determined from memory\./u)
  assert.match(result.block, /- \[Count\] Unknown\./u)
  assert.doesNotMatch(result.block, /60|80/u)
})

test('a same-park species update keeps the authorized bird list separate from other totals', async t => {
  const now = Date.UTC(2026, 10, 25, 13)
  t.mock.method(Date, 'now', () => now)
  let root, earlierId, newestId
  const earlier = "By the way, speaking of bird identification, I've been keeping track of the species I've seen in my local park, and I've managed to spot 27 different species so far."
  const newest = "By the way, speaking of woodpeckers, I just saw a Northern Flicker in my local park last weekend, which brings my total species count to 32."
  const ask = await setup(t, {}, [], (data, key) => {
    root = data
    const add = (id, quote, offset, project = key) => durationSource(root, project, id, quote, now + offset)
    earlierId = add('earlier-bird-total', earlier, -4500)
    newestId = add('new-bird-total', newest, -3500)
    add('another-place', newest.replace('my local park', 'my riverside park').replace('32.', '41.'), -2500)
    add('another-species', "Speaking of butterflies, I just saw a Monarch in my local park, which brings my total species count to 42.", -2500)
    add('plan', "Speaking of birds, I could spot a Northern Flicker in my local park, which would bring my total species count to 43.", -2500)
    add('separate-observer', "Speaking of woodpeckers, we saw a Northern Flicker in our local park, which brings our total species count to 44.", -2500)
    add('old-subtotal', "I have spotted 45 species of birds in my local park this week.", -2500)
    add('example', "Example:\nI have seen 46 different species of birds in my local park.", -2500)
    add('future', "I have seen 47 different species of birds in my local park.", 100)
    add('outside-project', "I have seen 48 different species of birds in my local park.", -2500, 'foreign')
  })
  const question = 'How many different species of birds have I seen in my local park?'
  const result = await ask(question, 'UTC')
  const slot = result.report.questions[0]
  assert.equal(slot.declaredCount?.value, '32')
  assert.deepEqual(slot.injected.map(hit => hit.sourceRefs[0].sourceId), [earlierId, newestId])
  assert.ok(earlier.includes(slot.injected[0].selectedQuote))
  assert.equal(slot.injected[1].selectedQuote, newest)
  assert.match(result.block, /species count to 32/u)
  assert.doesNotMatch(result.block, /\b(?:27|41|42|43|44|45|46|47|48)\b/u)
  const grade = answer => assessAnswerCoverage(slot, answer).answerCoverage
  for (const answer of ['32 different species of birds.', 'Thirty-two bird species.',
    'You have seen 32 different species of birds in your local park.',
    'According to the original quote provided, you have seen 32 different species of birds in your local park.',
    'Based on the recorded information, you have spotted 32 different bird species in your local park.']) {
    assert.equal(grade(answer), 'covered', answer)
  }
  for (const answer of ['You saw 32 birds.', 'You saw 32 different species of insects in your local park.',
    'You have seen 27 species of birds in your local park.', 'You have seen 32 bird species in the riverside park.',
    'You observed 32 bird species in your local park this month.', 'Thirty-two total species of wildlife.',
    'According to the original quote provided in your last session, you have seen 32 different species of birds in your local park.']) {
    assert.equal(grade(answer), 'unverified', answer)
  }
  const queued = await ask(question, 'UTC', { id:'before-species-update', at:now - 4000 })
  assert.equal(queued.report.questions[0].declaredCount?.value, '27')
  assert.deepEqual(queued.report.questions[0].injected.map(hit => hit.sourceRefs[0].sourceId), [earlierId])
  blockSourceRecall(root, { sourceRefs: [{ sourceId: earlierId }] })
  const noCategory = await ask(question, 'UTC')
  assert.equal(noCategory.report.questions[0].declaredCount?.value, null)
  assert.deepEqual(noCategory.report.questions[0].injected, [])
  assert.doesNotMatch(noCategory.block, /\b32\b/u)
})

test('an explicitly observed bird total survives a competing wildlife list, while a loose update does not', async t => {
  const now = Date.UTC(2026, 10, 25, 13)
  t.mock.method(Date, 'now', () => now)
  let root, project, latest
  const ask = await setup(t, {}, [], (data, key) => {
    root = data
    project = key
    durationSource(root, project, 'bird-list',
      "I've been tracking the species of birds I've seen in my local park, and I've spotted 12 different species so far.", now - 5000)
    durationSource(root, project, 'wildlife-list',
      "I've been keeping track of all species I've seen in my local park.", now - 4000)
    latest = durationSource(root, project, 'ambiguous-update',
      "Speaking of woodpeckers, I just saw a flicker in my local park, which brings my total species count to 33.", now - 3000)
  })
  const question = 'How many different species of birds have I seen in my local park?'
  const ambiguous = await ask(question, 'UTC')
  assert.equal(ambiguous.report.questions[0].declaredCount?.value, null)
  assert.deepEqual(ambiguous.report.questions[0].injected, [])
  blockSourceRecall(root, { sourceRefs: [{ sourceId: latest }] })
  const restored = await ask(question, 'UTC')
  assert.equal(restored.report.questions[0].declaredCount?.value, '12')
  const exact = durationSource(root, project, 'explicit-bird-count',
    "I've seen 34 different species of birds in my local park so far.", now - 1000)
  const named = await ask(question, 'UTC')
  assert.equal(named.report.questions[0].declaredCount?.value, '34')
  assert.deepEqual(named.report.questions[0].injected.map(hit => hit.sourceRefs[0].sourceId), [exact])
})

test('an explicit competing observation total blocks an unqualified species update', async t => {
  const now = Date.UTC(2026, 10, 25, 13)
  t.mock.method(Date, 'now', () => now)
  const ask = await setup(t, {}, [], (root, key) => {
    durationSource(root, key, 'birds-list',
      "I've been tracking the species of birds I've seen in my local park, and I've spotted 27 different species.", now - 5000)
    durationSource(root, key, 'wildlife-count',
      "I've recorded 31 total species of wildlife in my local park.", now - 4000)
    durationSource(root, key, 'update',
      "Speaking of woodpeckers, I just saw a flicker in my local park, which brings my total species count to 32.", now - 3000)
  })
  const result = await ask('How many different species of birds have I seen in my local park?', 'UTC')
  assert.equal(result.report.questions[0].declaredCount?.value, null)
  assert.deepEqual(result.report.questions[0].injected, [])
})

test('a bird subgroup tracker does not establish the number of all bird species', async t => {
  const now = Date.UTC(2026, 10, 25, 13)
  t.mock.method(Date, 'now', () => now)
  const ask = await setup(t, {}, [], (root, key) => {
    durationSource(root, key, 'woodpecker-list',
      "Speaking of woodpeckers, I've been keeping track of the species I've seen in my local park, and I've observed five different species.", now - 5000)
    durationSource(root, key, 'update',
      "Speaking of woodpeckers, I just saw a flicker in my local park, which brings my total species count to six.", now - 3000)
  })
  const result = await ask('How many different species of birds have I seen in my local park?', 'UTC')
  assert.equal(result.report.questions[0].declaredCount?.value, null)
  assert.deepEqual(result.report.questions[0].injected, [])
})

test('a cumulative completion count uses the latest milestone in the same activity', async t => {
  const now = Date.UTC(2026, 10, 25, 13)
  t.mock.method(Date, 'now', () => now)
  let latest, older, dataDir
  const ask = await setup(t, {}, [], (root, key) => {
    dataDir = root
    older = durationSource(root, key, 'earlier-progress',
      "I've completed 4 projects since starting painting classes, and I'm happy with my progress.", now - 3000)
    latest = durationSource(root, key, 'latest-milestone',
      "I'm looking for ideas for my next project. By the way, I just finished my 5th project since starting painting classes.", now - 2000)
    durationSource(root, key, 'plan', 'I plan to complete nine projects since starting painting classes.', now - 1000)
    durationSource(root, key, 'other-activity', 'I finished my 7th project since starting pottery classes.', now - 1000)
    durationSource(root, key, 'different-action', 'I started my 6th project since starting painting classes.', now - 1000)
    durationSource(root, key, 'labeled-project', 'I completed project number 8 since starting painting classes.', now - 1000)
    durationSource(root, key, 'different-owner', 'We completed twelve projects since starting painting classes.', now - 1000)
    durationSource(root, 'other-project', 'foreign', 'I completed twenty projects since starting painting classes.', now - 1000)
    durationSource(root, key, 'future', 'I completed ten projects since starting painting classes.', now + 1000)
  })
  const question = 'How many projects have I completed since starting painting classes?'
  const result = await ask(question, 'UTC')
  const slot = result.report.questions[0]
  assert.equal(slot.declaredCount?.value, '5')
  assert.deepEqual(slot.injected.map(hit => hit.sourceRefs[0].sourceId), [latest])
  assert.match(result.block, /finished my 5th project since starting painting classes/u)
  const grade = answer => assessAnswerCoverage(slot, answer).answerCoverage
  assert.equal(grade('You have completed five projects since starting painting classes.'), 'covered')
  assert.equal(grade('Based on the information provided in your memory context, you have completed 5 projects since starting painting classes.'), 'covered')
  assert.equal(grade('You finished your fifth project since starting painting classes, but you skipped the first four.'), 'unverified')
  assert.equal(grade('You finished your fifth project since starting painting classes.'), 'covered')
  assert.equal(grade('Five projects.'), 'covered')
  assert.equal(grade('You completed five projects since starting pottery classes.'), 'unverified')
  assert.equal(grade('You completed four projects since starting painting classes.'), 'unverified')
  assert.equal(grade('You completed four projects. You finished your fifth project.'), 'unverified')
  blockSourceRecall(dataDir, { sourceRefs: [{ sourceId: latest }] })
  const fallback = await ask(question, 'UTC')
  assert.equal(fallback.report.questions[0].declaredCount?.value, '4')
  assert.deepEqual(fallback.report.questions[0].injected.map(hit => hit.sourceRefs[0].sourceId), [older])
})

test('regular writing progress uses the latest count from the same writing activity', async t => {
  const now = Date.UTC(2026, 10, 25, 13)
  t.mock.method(Date, 'now', () => now)
  let root, latestId, olderId
  const latest = "By the way, I've been writing regularly for three months now, and it's been amazing - I've even managed to complete 7 short stories since I started."
  const older = "Speaking of which, I was wondering, do you think it's a good idea to set a goal for a certain number of short stories per month? I've written four so far since I started writing regularly, and I'm hoping to keep the momentum going."
  const ask = await setup(t, {}, [], (dataRoot, key) => {
    root = dataRoot
    const add = (id, quote, at) => durationSource(root, key, id, quote, now + at)
    olderId = add('writing-previous', older, -3000)
    latestId = add('writing-latest', latest, -2000)
    add('different-activity', "I've been reading regularly for three months now, and it's been amazing - I've completed 71 short stories since I started.", -1000)
    add('different-object', "I've been writing regularly for three months now - I've completed 72 longer stories since I started.", -1000)
    add('different-owner', "We've been writing regularly for three months now - we've completed 73 short stories since we started.", -1000)
    add('other-author', "I've been writing regularly for three months now - Jane completed 74 short stories since she started.", -1000)
    add('conditional', "If I've been writing regularly for three months now - I've completed 75 short stories since I started.", -1000)
    add('conditional-clause', "If I had more time, I wrote 85 short stories since I started writing regularly.", -1000)
    add('quoted-example', "Example:\nI've written 89 short stories since I started writing regularly.", -1000)
    add('quoted-goal', "Example:\nDid you set a goal for a certain number of short stories per month? I've written 90 so far since I started writing regularly.", -1000)
    add('unsupported-ref', "I've completed 76 short stories since I started.", -1000)
    add('unrelated-bare', "I've written 77 so far since I started writing regularly.", -1000)
    add('other-deadline', "Did you set a goal for a certain number of short stories per month? I've written 78 so far since I started editing regularly.", -1000)
    add('plan', "I've been writing regularly for three months now - I plan to complete 79 short stories since I started.", -1000)
    add('future', "I've written 80 short stories since I started writing regularly.", 1000)
    durationSource(root, 'different-project', 'outside', "I've written 81 short stories since I started writing regularly.", now - 1000)
  })
  const question = 'How many short stories have I written since I started writing regularly?'
  const result = await ask(question, 'UTC')
  const slot = result.report.questions[0]
  assert.equal(slot.declaredCount?.value, '7')
  assert.deepEqual(slot.injected.map(hit => hit.sourceRefs[0].sourceId), [latestId])
  assert.equal(slot.injected[0].selectedQuote, latest)
  const grade = answer => assessAnswerCoverage(slot, answer).answerCoverage
  assert.equal(grade('You have written 7 short stories since you started writing regularly.'), 'covered')
  assert.equal(grade('You have written seven short stories.'), 'covered')
  assert.equal(grade('You have completed seven short stories.'), 'covered')
  assert.equal(grade('Based on the information provided, you have managed to complete 7 short stories since you started writing regularly.'), 'covered')
  assert.equal(grade('You have written seven short stories so far since you started writing regularly.'), 'covered')
  assert.equal(grade('You have read seven short stories.'), 'unverified')
  assert.equal(grade('You have written seven short stories since you started editing regularly.'), 'unverified')
  const queued = await ask(question, 'UTC', { id: 'writing-queued', at: now - 2500 })
  assert.deepEqual(queued.report.questions[0].injected.map(hit => hit.sourceRefs[0].sourceId), [olderId])
  blockSourceRecall(root, { sourceRefs: [{ sourceId: latestId }] })
  const fallback = await ask(question, 'UTC')
  assert.equal(fallback.report.questions[0].declaredCount?.value, '4')
  assert.deepEqual(fallback.report.questions[0].injected.map(hit => hit.sourceRefs[0].sourceId), [olderId])
  assert.ok(older.includes(fallback.report.questions[0].injected[0].selectedQuote))
})

test('answer coverage binds leadership counts to the initial role and current period', () => {
  const old = { verified: true, kind: 'source',
    text: '- [用户原文（未提炼）] I lead a team of 4 engineers in my new role as Senior Software Engineer.' }
  const latest = { verified: true, kind: 'source',
    text: '- [用户原文（未提炼）] And by the way, I have been enjoying my role as Senior Software Engineer for a while, especially the part where I now lead a team of five engineers.' }
  const questions = [
    { query: 'How many engineers do I lead when I just started my new role as Senior Software Engineer',
      detail: null, injected: [old, latest] },
    { query: 'How many engineers do I lead now', detail: null, injected: [latest] },
  ]
  const grade = answer => questions.map(question => assessAnswerCoverage(question, answer, questions).answerCoverage)
  assert.deepEqual(grade('You led a team of 4 engineers when you started your new role as Senior Software Engineer. Now, you lead a team of 5 engineers.'),
    ['covered', 'covered'])
  assert.deepEqual(grade('When you started your new role as Senior Software Engineer, you led four engineers. You currently lead five engineers.'),
    ['covered', 'covered'])
  assert.deepEqual(grade('You now lead five engineers, but when you started your new role as Senior Software Engineer, you led four engineers.'),
    ['covered', 'covered'])
  assert.deepEqual(grade('When you started your new role as Senior Software Engineer, you led 5 engineers. Now, you lead 4 engineers.'),
    ['unverified', 'unverified'])
  assert.deepEqual(grade('You led 4 engineers when you started your role as Data Scientist. Now, you lead five engineers.'),
    ['unverified', 'covered'])
  assert.deepEqual(grade('You led 4 engineers when you started your new role as Senior Software Engineer. Now, you lead 5 engineers. You currently lead 6 engineers.'),
    ['covered', 'unverified'])
  assert.deepEqual(grade('You lead 4 engineers and 5 engineers.'), ['unverified', 'unverified'])
})

test('collection progress uses the latest explicit total from the same collecting period', async t => {
  const now = Date.UTC(2026, 10, 25, 13)
  t.mock.method(Date, 'now', () => now)
  let dataDir, older, latest, newYork
  const quote = "I just realized I've added 25 new postcards to my collection since I started collecting again."
  const ask = await setup(t, {}, [], (root, key) => {
    dataDir = root
    const add = (id, text, age) => durationSource(root, key, id, text, now - age)
    older = add('older', "I've added 17 new postcards since I started collecting again.", 5000)
    latest = add('latest', 'Speaking of which, ' + quote, 3000)
    add('increment', "I added 8 more postcards to my collection.", 2500)
    add('different-object', "I've added 90 new stamps to my collection since I started collecting again.", 2200)
    add('different-period', "I've added 91 new postcards to my collection since I started collecting as a child.", 2000)
    add('different-owner', "I've added 92 new postcards to our collection since I started collecting again.", 1500)
    add('different-action', "I've completed 93 new postcards since I started collecting again.", 1300)
    add('hypothetical', "If I include online listings, I've added 94 new postcards since I started collecting again.", 1100)
    add('future', "I've added 95 new postcards since I started collecting again.", -1000)
    newYork = add('new-york', "I've added 9 New York postcards since I started collecting again.", 2300)
    add('york', "I've added 95 York postcards since I started collecting again.", 1700)
    durationSource(root, 'other-project', 'elsewhere', "I've added 96 new postcards since I started collecting again.", now - 1000)
  })
  const question = 'How many new postcards have I added to my collection since I started collecting again?'
  const { report } = await ask(question, 'UTC')
  const [slot] = report.questions
  assert.equal(slot.declaredCount?.value, '25')
  assert.deepEqual(slot.injected.map(hit => hit.sourceRefs[0].sourceId), [latest])
  assert.equal(slot.injected[0].selectedQuote, quote)
  const grade = answer => assessAnswerCoverage(slot, answer).answerCoverage
  assert.equal(grade('You have added 25 new postcards to your collection since you started collecting again.'), 'covered')
  assert.equal(grade('You have added 17 new postcards to your collection since you started collecting again.'), 'unverified')
  assert.equal(grade('You have completed 25 new postcards since you started collecting again.'), 'unverified')
  assert.equal(grade('You added 25 new postcards to my collection.'), 'unverified')
  assert.equal(grade('You added 25 new postcards since you started collecting as a child.'), 'unverified')
  blockSourceRecall(dataDir, { sourceRefs: [{ sourceId: latest }] })
  const fallback = await ask(question, 'UTC')
  const [surviving] = fallback.report.questions
  assert.equal(surviving.declaredCount?.value, '17')
  assert.deepEqual(surviving.injected.map(hit => hit.sourceRefs[0].sourceId), [older])
  assert.equal(assessAnswerCoverage(surviving, '25 new postcards.').answerCoverage, 'unverified')
  const named = await ask('How many New York postcards have I added since I started collecting again?', 'UTC')
  assert.equal(named.report.questions[0].declaredCount?.value, '9')
  assert.deepEqual(named.report.questions[0].injected.map(hit => hit.sourceRefs[0].sourceId), [newYork])
})

test('conflicting cumulative counts stay unresolved when the observations share a timestamp', async t => {
  const now = Date.UTC(2026, 10, 25, 13)
  t.mock.method(Date, 'now', () => now)
  const ask = await setup(t, {}, [], (root, key) => {
    durationSource(root, key, 'direct-total', 'We completed three inspection rounds since joining the audit team.', now - 1000)
    durationSource(root, key, 'conflicting-total', 'We finished our fourth inspection round since we joined the audit team.', now - 1000)
  })
  const result = await ask('How many inspection rounds have we completed since joining the audit team?', 'UTC')
  assert.equal(result.report.questions[0].declaredCount?.value, null)
  assert.deepEqual(result.report.questions[0].injected, [])
})

test('a completed ordinal does not count earlier unfinished work', async t => {
  const now = Date.UTC(2026, 10, 25, 13)
  t.mock.method(Date, 'now', () => now)
  const ask = await setup(t, {}, [], (root, key) => {
    durationSource(root, key, 'asserted-before-gap', 'I completed four projects since starting painting classes.', now - 3000)
    durationSource(root, key, 'skipped', 'I finished my fifth project since starting painting classes, but I skipped the first four.', now - 1000)
    durationSource(root, key, 'pending', 'I finished my fourth report since starting writing classes. I still have to finish the first three.', now - 1000)
  })
  const questions = [
    'How many projects have I completed since starting painting classes?',
    'How many reports have I completed since starting writing classes?',
  ]
  for (const question of questions) {
    const result = await ask(question, 'UTC')
    assert.equal(result.report.questions[0].declaredCount?.value, null)
    assert.deepEqual(result.report.questions[0].injected, [])
  }
})

test('a literal total is usable even when completion skipped earlier work', async t => {
  const now = Date.UTC(2026, 10, 25, 13)
  t.mock.method(Date, 'now', () => now)
  const ask = await setup(t, {}, [], (root, key) => {
    durationSource(root, key, 'skipped-and-counted',
      "I've completed two reports since starting writing classes, but I skipped the first three.", now - 1000)
  })
  const result = await ask('How many reports have I completed since starting writing classes?')
  const slot = result.report.questions[0]
  assert.equal(slot.declaredCount?.value, '2')
  assert.match(result.block, /completed two reports/u)
  assert.equal(assessAnswerCoverage(slot,
    'You completed two reports since starting writing classes. You skipped the first three.').answerCoverage, 'covered')
})

test('an updated requirement quotes both authorized adjacent user messages', async t => {
  const now = Date.UTC(2026, 10, 25, 13)
  t.mock.method(Date, 'now', () => now)
  const anchor = "I'm trying to unlock Amber in my Juniper program, which I know requires a certain number of credits."
  const correction = 'Actually, I need 60 credits to unlock Amber, not 80.'
  let dataDir, scope, previous, changed
  const ask = await setup(t, {}, [], (root, key) => {
    dataDir = root
    scope = key
    durationSource(root, key, 'older-req', 'I need 80 credits to unlock Amber in my Juniper program.', now - 2000)
    const add = (messageId, text, eventSeq, previousUserSourceId) => {
      const { id } = saveSource(root, { sessionId: 'named-plan', messageId, text, eventSeq,
        projectKey: key, role: 'user', sourceKind: 'user', eventTime: now - 1000 + eventSeq, previousUserSourceId })
      assert.ok(grantSourceRecall(root, readSource(root, id), key))
      return id
    }
    previous = add('goal', anchor + ' Can you remind me how many credits I need to unlock Amber?', 11)
    changed = add('correction', correction + ' Thanks for the help.', 18, previous)
  })
  const question = 'How many credits do I need to unlock Amber in my Juniper program?'
  const { block, report } = await ask(question)
  const slot = report.questions[0]
  assert.equal(slot.declaredCount?.value, '60')
  assert.deepEqual(slot.injected.map(hit => hit.sourceRefs[0].sourceId), [previous, changed])
  assert.ok(slot.injected.every(hit => hit.verified && hit.sourceRefs[0].excerpt.includes(hit.selectedQuote)))
  assert.ok(slot.injected.every(hit => block.includes(hit.selectedQuote)))
  assert.match(block, /60 credits to unlock Amber/u)
  assert.doesNotMatch(block, /80 credits|Thanks for the help/u)
  assert.equal(assessAnswerCoverage(slot, 'You need 60 credits to unlock Amber.').answerCoverage, 'covered')
  blockSourceRecall(dataDir, { sourceRefs: [{ sourceId: previous }] })
  const withoutAnchor = await ask(question)
  assert.equal(withoutAnchor.report.questions[0].declaredCount?.value, null)
  assert.deepEqual(withoutAnchor.report.questions[0].injected, [])
  assert.doesNotMatch(withoutAnchor.block, /60 credits|80 credits|Juniper program/u)
  assert.equal(grantSourceRecall(dataDir, readSource(dataDir, previous), scope), false)
})

test('stocked inventory uses the newest original for the same container and unit', async t => {
  const now = Date.UTC(2026, 10, 25, 13)
  t.mock.method(Date, 'now', () => now)
  let dataDir, oldId, latestId
  const early = 'I need to use some of our eggs, we have a lot stocked up in the fridge - 30 dozen at the moment!'
  const latest = "I was thinking of using some of our fresh eggs from the coop - we've got 20 dozen stocked up in the fridge right now."
  const ask = await setup(t, {}, [], (root, key) => {
    dataDir = root
    const add = (id, text, at, project = key) => durationSource(root, project, id, text, at)
    oldId = add('previous-stock', early, now - 2000)
    latestId = add('latest-stock', latest, now - 1000)
    add('other-location', 'We have 42 dozen eggs stocked up in our garage fridge.', now)
    add('other-unit', 'We have 24 eggs stored in our fridge.', now)
    add('other-kind', "We've got 60 dozen tomatoes stocked up in our fridge.", now)
    add('other-owner', 'I have 29 dozen eggs stocked up in my fridge.', now)
    add('estimate', 'We have around 38 dozen eggs stocked up in our fridge.', now)
    add('plan', 'We plan to have 45 dozen eggs stored in our fridge tomorrow.', now)
    add('quoted-example', 'For example, we have 52 dozen eggs stocked up in our fridge.', now)
    add('unrelated-anchor', "I like our eggs and our berries - we've got 71 dozen stored in our fridge.", now)
    add('split-anchor', "We've got 80 dozen stored in our fridge.", now)
    add('future', 'We have 99 dozen eggs stocked up in our fridge.', now + 1)
    add('foreign', 'We have 96 dozen eggs stocked up in our fridge.', now, 'foreign-project')
  })
  const question = 'How many dozen eggs do we currently have stocked up in our refrigerator?'
  const found = await ask(question, 'UTC')
  const slot = found.report.questions[0]
  assert.equal(slot.declaredCount?.value, '20')
  assert.deepEqual(slot.injected.map(hit => hit.sourceRefs[0].sourceId), [latestId])
  assert.ok(found.block.includes(latest))
  assert.ok(slot.injected[0].sourceRefs[0].excerpt.includes(slot.injected[0].selectedQuote))
  const coverage = answer => assessAnswerCoverage(slot, answer).answerCoverage
  assert.equal(coverage('You have 20 dozen eggs in your fridge.'), 'covered')
  assert.equal(coverage('We currently have 20 dozen eggs stocked up in our fridge.'), 'covered')
  assert.equal(coverage("We've got 20 dozen eggs stored in our fridge."), 'covered')
  assert.equal(coverage('We currently have 20 dozen eggs stocked up in your refrigerator.'), 'unverified')
  assert.equal(coverage('I have 20 dozen eggs in my fridge.'), 'unverified')
  assert.equal(coverage('20 dozen.'), 'covered')
  assert.equal(coverage('You have 20 eggs in your fridge.'), 'unverified')
  assert.equal(coverage('You have 20 dozen eggs in your garage fridge.'), 'unverified')
  assert.equal(coverage('You have roughly 20 dozen eggs in your fridge.'), 'unverified')
  assert.equal(coverage('20 dozen eggs. You have 30 dozen eggs in your fridge.'), 'unverified')
  const queued = await ask(question, 'UTC', { id: 'stock-queued-before-update', at: now - 1500 })
  assert.equal(queued.report.questions[0].declaredCount?.value, '30')
  assert.deepEqual(queued.report.questions[0].injected.map(hit => hit.sourceRefs[0].sourceId), [oldId])
  blockSourceRecall(dataDir, { sourceRefs: [{ sourceId: latestId }] })
  const prior = await ask(question, 'UTC')
  assert.equal(prior.report.questions[0].declaredCount?.value, '30')
  assert.deepEqual(prior.report.questions[0].injected.map(hit => hit.sourceRefs[0].sourceId), [oldId])
})

test('answering a stock question keeps the literal object and storage owner', async t => {
  const now = Date.UTC(2026, 10, 25, 13)
  t.mock.method(Date, 'now', () => now)
  const ask = await setup(t, {}, [], (root, key) => {
    durationSource(root, key, 'true-stock', 'I keep four boxes of amber bulbs stored in my back cabinet.', now - 1000)
    durationSource(root, key, 'mixed-stock', 'I have seven boxes of amber bulbs stocked in our back cabinet.', now)
    durationSource(root, key, 'other-bulbs', 'I have nine boxes of white bulbs stored in my back cabinet.', now)
    durationSource(root, key, 'not-inside', 'I keep six boxes of amber bulbs stored on my back cabinet.', now)
  })
  const question = 'How many boxes of amber bulbs do I have stored in my back cabinet?'
  const result = await ask(question, 'UTC')
  const slot = result.report.questions[0]
  assert.equal(slot.declaredCount?.value, '4')
  assert.match(result.block, /four boxes of amber bulbs/u)
  assert.doesNotMatch(result.block, /seven|nine|six/u)
  assert.equal(assessAnswerCoverage(slot, 'Four boxes of amber bulbs.').answerCoverage, 'covered')
})

test('legacy requirements use the native predecessor and never skip a hidden user message', async t => {
  const now = Date.UTC(2026, 10, 25, 13)
  t.mock.method(Date, 'now', () => now)
  const sessions = new Map()
  let shifted = false, historicalRead = 0, previous, changed
  const ask = await setup(t, {}, [], (root, key, cwd) => {
    durationSource(root, key, 'past-tier', 'I need 75 stamps to reach Gold in the Rowan program.', now - 2000)
    const events = new Map()
    const add = (messageId, text, seq, save = true) => {
      const data = { id: messageId, role: 'user', source: { kind: 'user' }, content: text }
      events.set(seq, { type: 'user/message', seq, data })
      if (!save) return
      const { id } = saveSource(root, { sessionId: 'older-native-chat', messageId, text, eventSeq: seq,
        projectKey: key, role: 'user', sourceKind: 'user', eventTime: now - 1000 + seq })
      assert.ok(grantSourceRecall(root, readSource(root, id), key))
      return id
    }
    previous = add('goal', "I'm trying to reach Gold in my Rowan program.", 8)
    add('intervened', 'Do not save this. I switched to the Elm program.', 12, false)
    changed = add('quantity', 'Actually, I need 52 stamps to reach Gold, not 75.', 14)
    sessions.set('older-native-chat', { id: 'older-native-chat', header: { cwd }, inheritedEventCount: 0,
      eventAt(seq) { return seq === 12 && !shifted ? { seq, type: 'turn/end' } :
        events.get(seq) ?? { seq, type: 'assistant/message' } } })
  }, {
    async inspectSession(id, read) {
      historicalRead++
      const session = sessions.get(id)
      if (!session) throw new Error('no such session')
      return read(session)
    },
  })
  const question = 'How many stamps do I need to reach Gold in my Rowan program?'
  const found = await ask(question)
  assert.equal(found.report.questions[0].declaredCount?.value, '52')
  assert.deepEqual(found.report.questions[0].injected.map(hit => hit.sourceRefs[0].sourceId), [previous, changed])
  assert.equal(historicalRead, 1)
  shifted = true
  const after = await ask(question)
  assert.equal(after.report.questions[0].declaredCount?.value, null)
  assert.deepEqual(after.report.questions[0].injected, [])
  assert.doesNotMatch(after.block, /52 stamps|75 stamps|Elm program/u)
})

test('a current audience count uses the named account in the same original and excludes unrelated scopes', async t => {
  const now = Date.UTC(2026, 10, 25, 13)
  t.mock.method(Date, 'now', () => now)
  const own = "I just checked my AshVid account. I just checked and I'm now at 46 followers, which is a nice milestone!"
  let chosen, dataDir
  const ask = await setup(t, {}, [], (root, key) => {
    dataDir = root
    const add = (name, text, at, project = key) => durationSource(root, project, name, text, at)
    add('old-direct', 'I have 30 AshVid followers.', now - 172_800_000)
    chosen = add('updated', own, now - 86_400_000)
    add('foreign-account', "I just checked my FirVid account. I'm now at 90 followers.", now - 2000)
    add('two-accounts', "I checked my AshVid account and my BirchVid account. I'm now at 73 followers.", now - 1500)
    add('amount-for-other-account', 'I checked my AshVid account. I now have 887 followers on FirVid.', now - 1200)
    add('plan', 'I checked my AshVid account. I expect to have 100 followers tomorrow.', now - 1000)
    add('other-owner', 'I checked my AshVid account. My coworker now has 78 followers.', now - 950)
    add('another-unit', "I checked my AshVid account. I'm now at 55 views.", now - 900)
    add('quoted-example', "Here is a test example:\nI checked my AshVid account. I'm now at 22 followers.", now - 800)
    add('split-topic', 'I just checked my AshVid account.', now - 600)
    add('split-value', 'I now have 850 followers.', now - 500)
    add('foreign-project', "I checked my AshVid account. I'm now at 66 followers.", now - 400, 'other-project')
    add('future', "I checked my AshVid account. I'm now at 99 followers.", now + 1)
  })
  const query = 'How many AshVid followers do I currently have?'
  const full = await ask(query, 'UTC')
  const slot = full.report.questions[0]
  assert.equal(slot.declaredCount?.value, '46')
  assert.deepEqual(slot.injected.flatMap(hit => hit.sourceRefs.map(ref => ref.sourceId)), [chosen])
  assert.ok(slot.injected[0].sourceRefs[0].excerpt.includes(slot.injected[0].selectedQuote))
  assert.match(full.block, /checked my AshVid account.*46 followers/su)
  assert.doesNotMatch(full.block, /30 followers|90 followers|73 followers|887|850|66 followers|99 followers/u)
  assert.equal(assessAnswerCoverage(slot, 'You have 46 followers on AshVid.').answerCoverage, 'covered')
  assert.equal(assessAnswerCoverage(slot, 'You have 46 followers on FirVid.').answerCoverage, 'unverified')
  assert.equal(assessAnswerCoverage(slot, 'On FirVid, you have 46 followers.').answerCoverage, 'unverified')
  assert.equal(assessAnswerCoverage(slot, 'Your FirVid account has 46 followers.').answerCoverage, 'unverified')
  assert.equal((await ask('How many followers do I currently have on my AshVid account?', 'UTC')).report.questions[0].declaredCount?.value, '46')
  blockSourceRecall(dataDir, { sourceRefs: [{ sourceId: chosen }] })
  assert.equal((await ask(query, 'UTC')).report.questions[0].declaredCount?.value, '30')
})

test('a measured audience update can continue a single personal topic across an intervening request', async t => {
  const now = Date.UTC(2026, 10, 25, 13)
  t.mock.method(Date, 'now', () => now)
  const own = "I'm trying to increase my social media presence. Can you help me generate engaging promotional content on CoastCast? By the way, I just checked and I'm now at 91 subscribers."
  let chosen
  const ask = await setup(t, {}, [], (root, key) => {
    chosen = durationSource(root, key, 'owned-topic', own, now - 86_400_000)
    durationSource(root, key, 'research-topic',
      "I'm preparing a report about a competitor. Can you help me generate content on CoastCast? I just checked and I'm now at 28 subscribers.", now)
    durationSource(root, key, 'several-apps',
      "I'm trying to increase my social media presence. Can you help me generate content on CoastCast and PineStream? I just checked and I'm now at 57 subscribers.", now)
    durationSource(root, key, 'switching-accounts',
      "I'm trying to increase my social media presence on PineStream. Can you help me generate content on CoastCast? I just checked and I'm now at 38 subscribers.", now)
  })
  const { block, report } = await ask('How many CoastCast subscribers do I currently have?', 'UTC')
  assert.equal(report.questions[0].declaredCount?.value, '91')
  assert.deepEqual(report.questions[0].injected.flatMap(hit => hit.sourceRefs.map(ref => ref.sourceId)), [chosen])
  assert.match(block, /content on CoastCast.*91 subscribers/su)
  assert.doesNotMatch(block, /28 subscribers|57 subscribers/u)
})

test('a scoped correction keeps its positive count and an adjacent warehouse value keeps its location', async t => {
  const now = Date.UTC(2026, 10, 25, 13)
  t.mock.method(Date, 'now', () => now)
  let correction, warehouse
  const ask = await setup(t, {}, [], (root, key) => {
    durationSource(root, key, 'older-definition', 'I need 80 credits to unlock Amber in the Juniper program.', now - 172_800_000)
    correction = durationSource(root, key, 'same-message-correction',
      'I checked my Juniper program. Actually, I need 60 credits to unlock Amber, not 80.', now - 86_400_000)
    durationSource(root, key, 'other-issuer-correction',
      'I checked my Fir program. Actually, I need 50 credits to unlock Amber, not 80.', now)
    warehouse = durationSource(root, key, 'warehouse-count', '我核对了北门仓的库存。我现在有七块树莓派。', now - 1000)
    durationSource(root, key, 'other-warehouse', '我核对了南门仓的库存。我现在有九块树莓派。', now)
    durationSource(root, key, 'other-person', '我核对了北门仓的库存。同事有三十块树莓派。', now)
  })
  const required = await ask('How many credits do I need to unlock Amber in the Juniper program?', 'UTC')
  const slot = required.report.questions[0]
  assert.equal(slot.declaredCount?.value, '60')
  assert.deepEqual(slot.injected.flatMap(hit => hit.sourceRefs.map(ref => ref.sourceId)), [correction])
  assert.ok(slot.injected[0].sourceRefs[0].excerpt.includes(slot.injected[0].selectedQuote))
  assert.match(required.block, /Juniper program.*60 credits/su)
  assert.doesNotMatch(required.block, /50 credits|80 credits/u)
  assert.ok(matchesDeclaredCountAnswer('You need 60 credits to unlock Amber, not 80.', slot.declaredCount))
  assert.equal(matchesDeclaredCountAnswer('You need 80 credits to unlock Amber, not 60.', slot.declaredCount), false)
  const inventory = await ask('我在北门仓现在有多少块树莓派？', 'Asia/Shanghai')
  assert.equal(inventory.report.questions[0].declaredCount?.value, '7')
  assert.deepEqual(inventory.report.questions[0].injected.flatMap(hit => hit.sourceRefs.map(ref => ref.sourceId)), [warehouse])
  assert.match(inventory.block, /北门仓.*七块树莓派/su)
  assert.doesNotMatch(inventory.block, /九块|三十块/u)
})

test('an active compact count and a disagreeing original both remain visible for verification', async t => {
  const now = Date.UTC(2026, 10, 25, 13)
  t.mock.method(Date, 'now', () => now)
  let root, original
  const ask = await setup(t, {}, ['I currently have 6 relay boards in the East Station cabinet.'], (dataDir, key) => {
    root = dataDir
    original = durationSource(root, key, 'other-count', 'I have 8 relay boards in the East Station cabinet.', now)
  })
  const query = 'How many relay boards do I currently have in the East Station cabinet?'
  const disputed = await ask(query, 'UTC')
  const slot = disputed.report.questions[0]
  assert.equal(slot.declaredCount?.value, null)
  assert.deepEqual(slot.injected, [])
  assert.ok(slot.hits.some(hit => hit.id === 'mem_complete_0') &&
    slot.hits.some(hit => hit.sourceRefs[0]?.sourceId === original))
  assert.doesNotMatch(disputed.block, /6 relay boards|8 relay boards/u)
  blockSourceRecall(root, { sourceRefs: [{ sourceId: original }] })
  const resolved = await ask(query, 'UTC')
  assert.equal(resolved.report.questions[0].declaredCount?.value, '6')
  assert.deepEqual(resolved.report.questions[0].injected.map(hit => hit.id), ['mem_complete_0'])
})

test('eight named objects remain independent questions and inherit the shared version property',()=>{
  const slots=recallQueryPlan(question,'',false).filter(part=>part.role==='subquestion')
  assert.equal(slots.length,8)
  for(const [name] of versions) assert.ok(slots.some(slot=>slot.entityTerms.includes(name.toLowerCase())&&/版本/u.test(slot.query)),name)
})

test('English attribute words do not damage longer entity names', () => {
  assert.deepEqual(recallSubjectTerms('What was the transport collaboration?'), ['transport', 'collaboration'])
})

test('a shared counting question reserves separate evidence for each named subject', async t => {
  let left, right
  const ask = await setup(t, {}, [], (root, projectKey) => {
    const add = (sessionId, text, project = projectKey) => {
      const saved = saveSource(root, { sessionId, messageId: 'source', text, projectKey: project, role: 'user', sourceKind: 'user' })
      assert.ok(grantSourceRecall(root, readSource(root, saved.id), project, { remembered: true }))
      return saved.id
    }
    left = add('first-lap', 'I recorded 4 field inspections for the Aurora district.')
    right = add('second-lap', 'I recorded 7 field inspections for the Bay district.')
    add('wrong-unit', 'I recorded 91 work hours for the Aurora district.')
    add('wrong-context', 'The Bay district recorded 92 requests. I recorded 93 field inspections for the Quartz district.')
    add('foreign', 'I recorded 94 field inspections for the Bay district.', 'foreign-multisource')
  })
  const { block, report } = await ask('What is the total number of field inspections recorded for the Aurora district and Bay district?')
  assert.match(block, /4 field inspections/u)
  assert.match(block, /7 field inspections/u)
  assert.doesNotMatch(block, /9[1-4]/u)
  assert.deepEqual(report.questions.map(slot => slot.injected.flatMap(hit => hit.sourceRefs.map(ref => ref.sourceId))), [[left], [right]])
  assert.equal(report.quantityCheck.result, '11')
  assert.match(block, /4 \+ 7 = 11 field inspections/u)
  const answer = 'The Aurora district recorded 4 field inspections. The Bay district recorded 7 field inspections. Total 11.'
  const swapped = 'The Aurora district recorded 7 field inspections. The Bay district recorded 4 field inspections.'
  assert.ok(report.questions.every(slot => assessAnswerCoverage(slot, answer).answerCoverage === 'covered'))
  assert.ok(report.questions.every(slot => assessAnswerCoverage(slot, swapped).answerCoverage === 'unverified'))
  assert.ok(quantityResultCovered(report.quantityCheck, 'The total number of field inspections completed for both districts is 11.'))
  assert.ok(quantityResultCovered(report.quantityCheck, '11'))
  assert.equal(quantityResultCovered(report.quantityCheck, 'I recorded 11 working hours.'), false)
  assert.equal(quantityResultCovered(report.quantityCheck, 'The total is 10. The total is 11.'), false)
  const explicit = await ask('What is the total number of field inspections recorded for the Aurora district and Bay district? Please list each count separately.')
  assert.equal(explicit.report.quantityCheck.result, '11')
})

test('a Chinese total excludes other units and keeps a missing side visible', async t => {
  const ask = await setup(t, {}, [
    '青松站完成了12次巡检。', '橘湾站完成了7次巡检。', '青松站消耗了45小时。', '雾松站完成了61次巡检。',
  ])
  const { block, report } = await ask('青松站和橘湾站合计多少次巡检？')
  assert.match(block, /12次巡检/u)
  assert.match(block, /7次巡检/u)
  assert.doesNotMatch(block, /45小时|61次巡检/u)
  assert.deepEqual(report.questions.map(slot => slot.injected.map(hit => hit.id)), [['mem_complete_0'], ['mem_complete_1']])
  const partial = await ask('青松站和梧桐站合计多少次巡检？')
  assert.match(partial.block, /12次巡检/u)
  assert.equal(partial.report.missing.length, 1)
  assert.match(partial.report.missing[0], /梧桐站/u)
  assert.equal(partial.report.quantityCheck.result, null)
  assert.match(partial.block, /合计 = 无依据/u)
})

test('a price difference keeps the budget and actual cost as separate evidence', async t => {
  const ask = await setup(t, {}, [], (root, projectKey) => {
    for (const [sessionId, text] of [
      ['planned', 'I set the fabrication budget to $3,850.'],
      ['paid', 'The actual fabrication cost was $2,275.'],
      ['unrelated', 'The actual fabrication cost review took 92 hours.'],
    ]) {
      const saved = saveSource(root, { sessionId, messageId: 'one', text, projectKey, role: 'user', sourceKind: 'user' })
      assert.ok(grantSourceRecall(root, readSource(root, saved.id), projectKey, { remembered: true }))
    }
  })
  const { block, report } = await ask('How much more was the fabrication budget than the actual fabrication cost?')
  assert.match(block, /\$3,850/u)
  assert.match(block, /\$2,275/u)
  assert.doesNotMatch(block, /92 hours/u)
  assert.deepEqual(report.questions.map(slot => slot.injected.length), [1, 1])
  assert.equal(report.quantityCheck.result, '1575')
  assert.match(block, /3850 − 2275 = \$1575/u)
  assert.ok(quantityResultCovered(report.quantityCheck, 'The difference is $1,575.'))
  assert.equal(quantityResultCovered(report.quantityCheck, 'The difference is €1,575.'), false)
})

test('fundraising differences require the original goal and the amount raised at the same event', async t => {
  const now = Date.UTC(2026, 10, 25, 14)
  t.mock.method(Date, 'now', () => now)
  let root, goal, raised
  const ask = await setup(t, {}, [], (data, key) => {
    root = data
    const add = (id, text, project = key, at = now - 3600_000) => durationSource(data, project, id, text, at)
    goal = add('initial-goal', "I recently participated in a charity cycling event where I initially aimed to raise $200 in donations for the local children's hospital.")
    raised = add('actual-raised', 'I recently participated in a charity cycling event and raised $250 in donations, which was a great experience.')
    add('revised-target', 'My revised fundraising goal for the charity cycling event was $210.')
    add('other-event', 'I participated in a charity running event and raised $600 in donations.')
    add('other-participant', 'I participated in a charity cycling event and my sister raised $300 in donations.')
    add('unrelated-total', 'At the charity cycling event, our team raised $500 in donations.')
    add('pledge', 'At the charity cycling event, I expected to raise $1000 in donations.')
    add('delta-only', 'At the charity cycling event, I raised $42 more than my initial goal.')
    add('future', 'I participated in a charity cycling event and raised $900 in donations.', key, now + 3600_000)
    add('foreign', 'I participated in a charity cycling event and raised $800 in donations.', 'same-name-other-project')
  })
  const question = 'How much more money did I raise than my initial goal in the charity cycling event?'
  const full = await ask(question, 'UTC')
  assert.equal(full.report.quantityCheck?.result, '50')
  assert.deepEqual(full.report.questions.map(slot => slot.injected.map(hit => hit.sourceRefs[0].sourceId)), [[raised], [goal]])
  assert.match(full.block, /250 − 200 = \$50/u)
  assert.doesNotMatch(full.block, /\$(?:210|600|300|500|1000|900|800|42)\b/u)
  assert.ok(quantityResultCovered(full.report.quantityCheck, 'You raised $50 more than your initial fundraising goal.'))
  assert.ok(quantityResultCovered(full.report.quantityCheck, 'You exceeded your original goal by $50.'))
  assert.equal(quantityResultCovered(full.report.quantityCheck, 'You raised $50 less than your initial goal.'), false)
  assert.equal(quantityResultCovered(full.report.quantityCheck, 'You raised $50 more than your initial goal at the charity running event.'), false)
  assert.equal(quantityResultCovered(full.report.quantityCheck, 'You raised $50 more than your initial goal. The difference was $150.'), false)
  assert.equal(quantityResultCovered(full.report.quantityCheck, 'You raised $250 in total. Your goal was $200.'), false)
  assert.equal(quantityResultCovered(full.report.quantityCheck, 'For the charity running event, the difference is $50.'), false)
  assert.equal(quantityResultCovered(full.report.quantityCheck, 'The total raised was $50.'), false)
  const [actual, initial] = full.report.questions
  assert.equal(assessAnswerCoverage(actual, 'You raised $250 in donations.').answerCoverage, 'covered')
  assert.equal(assessAnswerCoverage(initial, 'Your initial fundraising goal was $200.').answerCoverage, 'covered')
  assert.equal(assessAnswerCoverage(actual, 'You raised $250 more than your initial goal.').answerCoverage, 'unverified')
  assert.equal(assessAnswerCoverage(initial, 'Your revised fundraising goal was $200.').answerCoverage, 'unverified')


  blockSourceRecall(root, { sourceRefs: [{ sourceId: goal }] })
  const partial = await ask(question, 'UTC')
  assert.equal(partial.report.quantityCheck?.result, null)
  assert.deepEqual(partial.report.questions.map(slot => slot.injected.map(hit => hit.sourceRefs[0].sourceId)), [[raised], []])
  assert.ok(unsupportedQuantityResult(partial.report.quantityCheck, 'You raised $50 more than your initial goal.'))
  assert.equal(unsupportedQuantityResult(partial.report.quantityCheck, 'The record says you raised $250. The original goal is unknown.'), false)
  assert.doesNotMatch(partial.block, /\$(?:50|200)\b/u)
})

test('meal totals keep unclassified meals separate and verify an exact partial answer', () => {
  const [fajitas, soup] = quantityRecallPlan('What is the total number of lunch meals from chicken fajitas and lentil soup?')
  const mixed = 'I ate chicken fajitas for lunch today. My first two servings were dinners. This is the third meal I got from my chicken fajitas.'
  const soupProof = quantityEvidence(soup, 'My lentil soup lasted me for 5 lunches.')
  assert.equal(quantityEvidence(fajitas, mixed), null)
  assert.equal(quantityEvidence(fajitas, 'I got at least 3 lunches from my chicken fajitas.'), null)
  assert.equal(describeQuantities([fajitas, soup], [null, soupProof]).result, null)

  const confirmed = quantityEvidence(fajitas, 'I got 3 lunches from my chicken fajitas.')
  assert.equal(describeQuantities([fajitas, soup], [confirmed, soupProof]).result, '8')
  const report = { ...soup, injected: [{ verified: true, text: soupProof.quote }] }
  const answer = 'The number of lunch meals from the lentil soup was 5.'
  assert.equal(assessAnswerCoverage(report, answer).answerCoverage, 'covered')
  assert.equal(assessAnswerCoverage(report, answer.replace('lunch ', '')).answerCoverage, 'unverified')
})

test('a fare comparison grounds the two modes independently and forgets a missing operand', async t => {
  const now = Date.UTC(2026, 10, 25, 14)
  t.mock.method(Date, 'now', () => now)
  let root, taxi, train
  const ask = await setup(t, {}, [], (data, key) => {
    root = data
    const add = (id, text, project = key, at = now - 3600_000) => durationSource(data, project, id, text, at)
    taxi = add('commute-taxi', 'I tracked my daily commute expenses. I missed my train and had to take a taxi, which cost me $12.')
    train = add('commute-train', 'My daily train fare is actually $6.')
    add('different-route', 'I took a taxi from the airport to my hotel, which cost me $69.')
    add('other-owner', 'My colleague took a taxi for their daily commute, which cost them $94.')
    add('neighbor', 'For my daily commute comparison, my neighbor took a taxi that cost $40.')
    add('planned', 'For my daily commute, I plan to take a taxi that will cost me $90.')
    add('other-charge', 'On my daily commute the taxi driver charged a separate airport fee of $70.')
    add('future', 'I took a taxi for my daily commute and it cost $81.', key, now + 3600_000)
    add('foreign', 'My daily train fare is $77.', 'another-project')
  })
  const question = 'For my daily commute, how much more expensive was the taxi ride compared to the train fare?'
  const full = await ask(question, 'UTC')
  assert.equal(full.report.quantityCheck?.result, '6')
  assert.deepEqual(full.report.questions.map(slot => slot.injected.map(hit => hit.sourceRefs[0].sourceId)), [[taxi], [train]])
  assert.match(full.block, /12 − 6 = \$6/u)
  assert.doesNotMatch(full.block, /\$(?:69|94|40|90|70|81|77)/u)
  assert.ok(quantityResultCovered(full.report.quantityCheck, 'The difference was $6.'))
  assert.ok(quantityResultCovered(full.report.quantityCheck, 'The taxi ride was $6 more expensive than the train fare for my daily commute.'))
  assert.equal(quantityResultCovered(full.report.quantityCheck, 'The train fare was $6 more expensive than the taxi ride.'), false)
  assert.equal(quantityResultCovered(full.report.quantityCheck, 'The taxi ride was $6 more expensive than the train fare. The difference is $7.'), false)
  assert.equal(quantityResultCovered(full.report.quantityCheck, 'The difference was €6.'), false)
  assert.equal(assessAnswerCoverage(full.report.questions[0], 'You mentioned that the taxi ride cost $12.').answerCoverage, 'covered')
  assert.equal(assessAnswerCoverage(full.report.questions[0], 'Your train fare cost $12.').answerCoverage, 'unverified')

  blockSourceRecall(root, { sourceRefs: [{ sourceId: train }] })
  const partial = await ask(question, 'UTC')
  assert.equal(partial.report.quantityCheck?.result, null)
  assert.deepEqual(partial.report.questions.map(slot => slot.injected.map(hit => hit.sourceRefs[0].sourceId)), [[taxi], []])
  assert.ok(unsupportedQuantityResult(partial.report.quantityCheck, 'The difference was $6.'))
  assert.doesNotMatch(partial.block, /\$6\b/u)
})

test('savings from documented estimates retain the route, currency and uncertainty', async t => {
  const now = Date.UTC(2026, 10, 25, 14)
  t.mock.method(Date, 'now', () => now)
  let rail, taxi
  const ask = await setup(t, {}, [], (root, key) => {
    const add = (id, text) => durationSource(root, key, id, text, now - 3600_000)
    rail = add('train-estimate', "I was thinking of taking the train from the airport to my hotel, my friend told me it's only around $10.")
    taxi = add('cab-estimate', 'I was told that taking a taxi from the airport to my hotel would cost around $60.')
    add('backwards', 'I was told the taxi from the hotel to the airport costs around $99.')
    add('wrong-route', 'The train from the airport to my office would cost around $4.')
    add('uncertain', 'The approach is hypothetical. If the train from the airport to my hotel were to cost $75, would it be worth it?')
    add('bundle', 'The train and taxi from the airport to my hotel together cost $78.')
    add('bounded', 'The taxi from the airport to my hotel would cost at least $40.')
  })
  const saved = await ask('How much will I save by taking the train from the airport to my hotel instead of a taxi?', 'UTC')
  assert.equal(saved.report.quantityCheck?.result, '50')
  assert.equal(saved.report.quantityCheck?.estimated, true)
  assert.deepEqual(saved.report.questions.map(slot => slot.injected.map(hit => hit.sourceRefs[0].sourceId)), [[taxi], [rail]])
  assert.match(saved.block, /60 − 10 ≈ \$50/u)
  assert.doesNotMatch(saved.block, /\$(?:99|4\b|75|78|40)/u)
  assert.ok(quantityResultCovered(saved.report.quantityCheck, 'You would save about $50.'))
  assert.ok(quantityResultCovered(saved.report.quantityCheck,
    'Based on the fares provided, you would save approximately $50 by taking the train from the airport to your hotel instead of a taxi.'))
  assert.equal(quantityResultCovered(saved.report.quantityCheck, 'You would save about $50 by taking the taxi instead of a train.'), false)
  assert.equal(quantityResultCovered(saved.report.quantityCheck, 'You will save exactly $50.'), false)
  assert.equal(quantityResultCovered(saved.report.quantityCheck, 'You would save about €50.'), false)
  assert.equal(quantityResultCovered(saved.report.quantityCheck, 'You would save about $50. The savings would be about €40.'), false)

  const partial = await ask('How much will I save by taking the bus from the airport to my hotel instead of a taxi?', 'UTC')
  assert.equal(partial.report.quantityCheck.result, null)
  assert.deepEqual(partial.report.questions.map(slot => slot.injected), [[], []])
  assert.deepEqual(partial.report.questions[0].notInjected.map(hit => hit.sourceRefs[0].sourceId), [taxi])
  assert.match(partial.block, /The savings cannot be calculated from the recorded fares[.]/u)
  assert.match(partial.block, /No verified bus fare is available/u)
  assert.doesNotMatch(partial.block, /\$60/u)
  assert.equal(unsupportedQuantityResult(partial.report.quantityCheck, 'You would save about $60.'), true)
})

test('a corrected payment quote and an earlier quote must be for the same named supplier', async t => {
  const now = Date.UTC(2026, 10, 25, 14)
  t.mock.method(Date, 'now', () => now)
  let initial, final, root
  const ask = await setup(t, {}, [], (data, key) => {
    root = data
    const add = (id, text, days) => durationSource(data, key, id, text, now - days * 86_400_000)
    initial = add('initial-trip', 'I am finalizing payment for the trip with Fern Travel Agency under booking reference TRIP-772. They initially quoted me $2,500 for the entire trip.', 1)
    final = add('corrected-trip', 'I booked the trip with Fern Travel Agency under booking reference TRIP-772. The corrected price for the entire trip was $2,800.', 5)
    add('wrong-role', 'I booked a trip with Fern Travel Agency. The optional baggage fee was $700.', 2)
    add('not-an-offer', 'I booked the trip with Fern Travel Agency. The original price might have been $1,200.', 3)
  })
  const question = 'How much more did I have to pay for the trip after the initial quote?'
  const full = await ask(question, 'UTC')
  assert.equal(full.report.quantityCheck?.result, '300')
  assert.deepEqual(full.report.questions.map(slot => slot.injected.map(hit => hit.sourceRefs[0].sourceId)), [[final], [initial]])
  assert.ok(quantityResultCovered(full.report.quantityCheck, 'You had to pay $300 more for the trip after the initial quote.'))
  const stated = 'The corrected price for the trip was $2,800, while the initial quote was $2,500.'
  assert.deepEqual(full.report.questions.map(slot => assessAnswerCoverage(slot, stated).answerCoverage), ['covered', 'covered'])
  assert.equal(assessAnswerCoverage(full.report.questions[0], 'The corrected price for the trip was €2,800.').answerCoverage, 'unverified')
  assert.doesNotMatch(full.block, /\$(?:700|1,200)/u)
  blockSourceRecall(root, { sourceRefs: [{ sourceId: initial }] })
  const key = full.report.projectKey
  durationSource(root, key, 'another-booking', 'I booked a trip with Fern Travel Agency under booking reference TRIP-828. They initially quoted me $2,200 for the entire trip.', now - 86400_000)
  const mismatched = await ask(question, 'UTC')
  assert.equal(mismatched.report.quantityCheck?.result, null)
  assert.doesNotMatch(mismatched.block, /\$600\b|\$300\b|\$2,500/u)
})

test('a named travel agency and ticket quote can supply both amounts while the booking identity is unresolved', async t => {
  const now = Date.UTC(2026, 10, 25, 14)
  t.mock.method(Date, 'now', () => now)
  let revised, initial
  const ask = await setup(t, {}, [], (root, key) => {
    revised = durationSource(root, key, 'revised', 'I booked the trip with Fern Travel Agency. The revised price was $4,200 for the trip.', now - 86400_000)
    initial = durationSource(root, key, 'initial', 'I am finalizing the payment for my flight tickets with Fern Travel Agency. They initially quoted me $3,800 for the entire trip.', now - 2 * 86400_000)
  })
  const full = await ask('How much more did I have to pay for the trip after the initial quote?', 'UTC')
  assert.deepEqual(full.report.questions.map(slot => slot.injected.map(hit => hit.sourceRefs[0].sourceId)), [[revised], [initial]])
  assert.equal(full.report.quantityCheck?.result, null)
  assert.match(full.block, /Difference = insufficient evidence/u)
  assert.ok(unsupportedQuantityResult(full.report.quantityCheck, 'You had to pay $400 more for the trip after the initial quote.'))
})

test('the Chinese amount comparison keeps both currencies verbatim and avoids a false answer after a conflict', async t => {
  const ask = await setup(t, {}, ['铸模预算为3850元。', '实际铸模费用为2275元。', '设备价格为920美元。'])
  const { block, report } = await ask('铸模预算比实际铸模费用高多少钱？')
  assert.match(block, /3850元/u)
  assert.match(block, /2275元/u)
  assert.doesNotMatch(block, /920美元/u)
  const conflict = '铸模预算为3850元。铸模预算为4000元。实际铸模费用为2275元。'
  assert.equal(assessAnswerCoverage(report.questions[0], conflict).answerCoverage, 'unverified')
  assert.equal(assessAnswerCoverage(report.questions[1], conflict).answerCoverage, 'covered')
  const mixed = await ask('铸模预算比设备价格高多少钱？')
  assert.match(mixed.block, /3850元/u)
  assert.match(mixed.block, /920美元/u)
  assert.equal(mixed.report.quantityCheck.result, null)
  assert.match(mixed.block, /差额 = 无依据/u)
})

test('a purchase total needs the actual amount and authorized original for each named item', async t => {
  const now = Date.UTC(2026, 10, 25, 13)
  t.mock.method(Date, 'now', () => now)
  let root, clamp, mount
  const ask = await setup(t, {}, [], (data, key) => {
    root = data
    const add = (id, text, project = key) => durationSource(root, project, id, text, now - 86400_000)
    clamp = add('actual-clamp', 'Can I claim the cost of the copper clamp on my insurance? I remember it cost me $35.')
    mount = add('actual-mount', 'I bought the cedar mount. It cost me $28.')
    add('catalog', 'The catalog price of the copper clamp was $90.')
    add('later-plan', 'I plan to buy the cedar mount for $62.')
    add('quote-other-buyer', 'My colleague bought the copper clamp for $85.')
    add('together', 'I bought the copper clamp and cedar mount for $81.')
    add('unasked-bundle', 'I bought the copper clamp and a bolt kit for $101.')
    add('different-component', 'I bought the copper clamp spacer for $102.')
    add('shipping', 'I paid $7 for shipping the copper clamp.')
    add('adjacent-other', 'I bought a cable tie. It cost me $2. I looked at a copper clamp.')
    add('intervening-topic', 'Can I claim the cost of the copper clamp? I changed my power board. It cost me $74.')
    add('foreign', 'I paid $95 for the cedar mount.', 'different-project')
  })
  const query = 'What was the total cost of the copper clamp and cedar mount I purchased?'
  const full = await ask(query, 'UTC')
  assert.equal(full.report.quantityCheck?.result, '63')
  assert.deepEqual(full.report.questions.map(slot => slot.injected.map(hit => hit.sourceRefs[0].sourceId)), [[clamp], [mount]])
  assert.match(full.report.questions[1].injected[0].selectedQuote, /I bought the cedar mount.*It cost me \$28/u)
  assert.match(full.block, /35 \+ 28 = \$63/u)
  assert.doesNotMatch(full.block, /borrowing ceiling|closing price/u)
  assert.doesNotMatch(full.block, /\$(?:90|62|85|81|101|102|74|7\b|2\b|95)/u)
  assert.equal(quantityResultCovered(full.report.quantityCheck, 'The total cost was $63.'), true)
  assert.equal(quantityResultCovered(full.report.quantityCheck, '总价是 $63。'), true)
  assert.equal(quantityResultCovered(full.report.quantityCheck, 'The total cost was €63.'), false)
  assert.equal(quantityResultCovered(full.report.quantityCheck, 'The total cost was $63. Updated total: $73.'), false)

  blockSourceRecall(root, { sourceRefs: [{ sourceId: mount }] })
  const partial = await ask(query, 'UTC')
  assert.equal(partial.report.quantityCheck?.result, null)
  assert.deepEqual(partial.report.questions.map(slot => slot.injected.map(hit => hit.sourceRefs[0].sourceId)), [[clamp], []])
  assert.match(partial.block, /Total = insufficient evidence/u)
  assert.doesNotMatch(partial.block, /\$28|\$63/u)
  assert.ok(unsupportedQuantityResult(partial.report.quantityCheck, 'The total cost was $63.'))
  assert.equal(unsupportedQuantityResult(partial.report.quantityCheck, 'The copper clamp cost $35. The total is unknown.'), false)
})

test('a named purchase can be priced by an explicit same-statement reference to that item', async t => {
  const now = Date.UTC(2026, 10, 25, 13)
  t.mock.method(Date, 'now', () => now)
  const ask = await setup(t, {}, [], (root, key) => {
    durationSource(root, key, 'named-stand', 'I purchased the quilted stand for $27.', now - 86400_000)
    durationSource(root, key, 'reference',
      "I've had good experiences with canvas carry bags, like the one I got from Birch Market for $16.", now - 86400_000)
    durationSource(root, key, 'plan',
      'I am considering a canvas carry bag and might pay $90 for it.', now - 86400_000)
  })
  const result = await ask('What is the total cost of the quilted stand and canvas carry bag I purchased?', 'UTC')
  assert.equal(result.report.quantityCheck?.result, '43')
  assert.match(result.block, /27 \+ 16 = \$43/u)
  assert.doesNotMatch(result.block, /\$90/u)
})

test('actual spending questions require individually attributed receipts and keep the paid scope after forgetting', async t => {
  const now = Date.UTC(2026, 10, 25, 13)
  t.mock.method(Date, 'now', () => now)
  let dataDir, clamp, mount
  const ask = await setup(t, {}, [], (root, key) => {
    dataDir = root
    const add = (id, text, project = key, at = now - 86400_000) => durationSource(root, project, id, text, at)
    clamp = add('actual-clamp', 'I paid $41 for the copper clamp.')
    mount = add('actual-mount', 'I bought the cedar mount. It cost me $36.')
    add('budget', 'I planned to spend $120 on the cedar mount.')
    add('listed', 'The catalog price of the copper clamp was $91.')
    add('bundle', 'I paid $107 for the copper clamp and cedar mount.')
    add('group-expense', 'We paid $98 for the cedar mount.')
    add('shipping', 'I paid $7 for shipping the copper clamp.')
    add('other-spend', 'I paid $45 for the copper clamp bolts.')
    add('other-project', 'I paid $63 for the cedar mount.', 'another-project')
    add('future', 'I paid $72 for the copper clamp.', key, now + 86400_000)
  })
  for (const query of [
    'What is the total amount I spent on the copper clamp and the cedar mount?',
    'How much did I spend on the copper clamp and cedar mount in total?',
  ]) {
    const full = await ask(query, 'UTC')
    assert.equal(full.report.quantityCheck?.result, '77', query)
    assert.deepEqual(full.report.questions.map(slot => slot.injected.flatMap(hit => hit.sourceRefs.map(ref => ref.sourceId))),
      [[clamp], [mount]])
    assert.match(full.block, /41 \+ 36 = \$77/u)
    assert.doesNotMatch(full.block, /\$(?:120|91|107|98|7\b|45|63|72)/u)
    assert.equal(quantityResultCovered(full.report.quantityCheck, 'I spent $77 in total.'), true)
    assert.equal(quantityResultCovered(full.report.quantityCheck, 'You spent a total of $77 on the copper clamp and cedar mount.'), true)
    assert.equal(quantityResultCovered(full.report.quantityCheck, 'You spent a total of $77 on the copper clamp and hammer.'), false)
    assert.equal(quantityResultCovered(full.report.quantityCheck, 'You spent $77 in total, and you paid $88 in total.'), false)
  }

  const query = 'How much did I spend on the copper clamp and cedar mount?'
  blockSourceRecall(dataDir, { sourceRefs: [{ sourceId: mount }] })
  const partial = await ask(query, 'UTC')
  assert.equal(partial.report.quantityCheck?.result, null)
  assert.deepEqual(partial.report.questions.map(slot => slot.injected.flatMap(hit => hit.sourceRefs.map(ref => ref.sourceId))), [[clamp], []])
  assert.match(partial.block, /total cannot be determined/iu)
  assert.doesNotMatch(partial.block, /\$(?:36|77|98|107)/u)
  blockSourceRecall(dataDir, { sourceRefs: [{ sourceId: clamp }] })
  const absent = await ask(query, 'UTC')
  assert.equal(absent.block, '')
  assert.equal(absent.report.questions.length, 2)
  assert.ok(absent.report.questions.every(slot => slot.injected.length === 0))
})

test('an individually described purchase can recover an exact remembered receipt amount', async t => {
  const now = Date.UTC(2026, 10, 25, 13)
  t.mock.method(Date, 'now', () => now)
  let chosen
  const ask = await setup(t, {}, [], (root, key) => {
    const add = (id, text) => durationSource(root, key, id, text, now - 86400_000)
    chosen = add('exact-receipt', 'I remember buying a designer handbag for a pretty penny - $800, to be exact.')
    add('not-paid', 'I am saving up to buy the designer handbag for $590.')
    add('other-item', 'I remember buying a designer wallet for $58.')
    add('rough-claim', 'I bought a designer handbag for about $705.')
    add('unrelated-number', 'I remember buying a designer handbag for my sister - $100 was separately spent on wrapping.')
  })
  const result = await ask('How much did I spend on a designer handbag?', 'UTC')
  assert.equal(result.report.quantityCheck?.result, '800')
  assert.deepEqual(result.report.questions[0].injected.flatMap(hit => hit.sourceRefs.map(ref => ref.sourceId)), [chosen])
  assert.doesNotMatch(result.block, /\$(?:590|58\b|705|100)/u)
  assert.equal(quantityResultCovered(result.report.quantityCheck, 'You spent $800 on the designer handbag.'), true)
  assert.equal(quantityResultCovered(result.report.quantityCheck, 'You spent $800 on the designer wallet.'), false)
})

test('a Chinese spending question retains two purchase subjects and confirms only the user’s own amounts', async t => {
  const now = Date.UTC(2026, 10, 25, 13)
  t.mock.method(Date, 'now', () => now)
  let clamp, bracket
  const ask = await setup(t, {}, [], (root, key) => {
    const add = (id, text) => durationSource(root, key, id, text, now - 86400_000)
    clamp = add('own-clamp', '我买了青铜卡扣，实付18元。')
    bracket = add('own-bracket', '我购买了枫木挂架，实际支付22元。')
    add('other-buyer', '同事买了青铜卡扣，实付52元。')
    add('group-spend', '我们买了枫木挂架，实际支付68元。')
    add('shop-price', '枫木挂架标价99元。')
  })
  const result = await ask('我买青铜卡扣和枫木挂架一共花了多少钱？', 'Asia/Shanghai')
  assert.equal(result.report.quantityCheck?.result, '40')
  assert.deepEqual(result.report.questions.map(slot => slot.injected.flatMap(hit => hit.sourceRefs.map(ref => ref.sourceId))),
    [[clamp], [bracket]])
  assert.ok(quantityResultCovered(result.report.quantityCheck, '两样一共花了40元。'))
  assert.doesNotMatch(result.block, /(?:52|68|99)元/u)
})

test('a charge stated at the end of an expense list belongs to its named item', async t => {
  const now = Date.UTC(2026, 10, 25, 13)
  t.mock.method(Date, 'now', () => now)
  let washer, pass
  const ask = await setup(t, {}, [], (root, key) => {
    const add = (id, text) => durationSource(root, key, id, text, now - 86400_000)
    washer = add('maintenance', "I've been spending on vehicle maintenance lately, like the initial valve check and a wash station pass that cost $15.")
    pass = add('parking', 'I paid $50 for the parking day ticket.')
    add('other-cost', "I've been spending on vehicle maintenance, including a wash station pass and a windshield wipe that cost $24.")
    add('different-payer', 'We spent a bit on maintenance, including service and a wash station pass that cost $18.')
    add('hypothetical', 'If I spent money on maintenance, it would include a wash station pass that cost $29.')
  })
  const result = await ask('How much did I spend on wash station pass and parking day ticket?', 'UTC')
  assert.equal(result.report.quantityCheck?.result, '65')
  assert.deepEqual(result.report.questions.map(slot => slot.injected.flatMap(hit => hit.sourceRefs.map(ref => ref.sourceId))),
    [[washer], [pass]])
  assert.ok(quantityResultCovered(result.report.quantityCheck, 'You spent $65 on a wash station pass and a parking day ticket.'))
  assert.equal(quantityResultCovered(result.report.quantityCheck, 'You spent $15 on a wash station pass and $50 on a parking day ticket.'), false)
  assert.doesNotMatch(result.block, /\$(?:24|18|29)\b/u)
})

test('a named price question without attributable prices retains general source recall', async t => {
  const ask = await setup(t, {}, [], (data, projectKey) => {
    const saved = saveSource(data, { sessionId:'prior', messageId:'care-note', projectKey, role:'user', sourceKind:'user',
      text:"I picked up a new collar. I'm not sure it's the best one for Nilla. By the way, I also got her flea and tick prevention medication, it was $25 for a 3-month supply." })
    assert.ok(grantSourceRecall(data, readSource(data, saved.id), projectKey, { remembered: true }))
  })
  const result = await ask("What is the total cost of Nilla's vet visit and flea medication?", 'UTC')
  assert.ok(result.report)
  assert.equal(result.report.quantityCheck, undefined)
  assert.match(result.block, /flea and tick prevention medication/u)
  assert.ok(result.report.localDeepRecall.tokens <= result.report.localDeepRecall.limit)
})

test('a named price difference is absolute and avoids adding unlike currencies', async t => {
  const ask = await setup(t, {}, [
    'The Dockline adapter costs $37.',
    'The price of the Pinebay enclosure was $72.',
    'The shipping price of the Dockline adapter was $15.',
    '青桦滤芯价格是32元。', '北岸加湿盒价格是80美元。',
  ])
  const difference = await ask('What is the difference in price between the Dockline adapter and Pinebay enclosure?', 'UTC')
  assert.equal(difference.report.quantityCheck?.result, '35')
  assert.match(difference.block, /72 − 37 = \$35/u)
  assert.deepEqual(difference.report.questions.map(slot => slot.injected.map(hit => hit.id)), [['mem_complete_0'], ['mem_complete_1']])
  const mixed = await ask('青桦滤芯和北岸加湿盒一共多少钱？', 'UTC')
  assert.equal(mixed.report.quantityCheck?.result, null)
  assert.match(mixed.block, /32元/u)
  assert.match(mixed.block, /80美元/u)
  assert.match(mixed.block, /合计 = 无依据/u)
  const cnyTotal = { result: '40', unit: 'cny', measure: null, scopeRole: 'item-price' }
  assert.ok(quantityResultCovered(cnyTotal, 'The total price is 40 yuan.'))
  assert.ok(quantityResultCovered(cnyTotal, '两项一共是18 + 22 = 40元。'))
  assert.ok(quantityResultCovered(cnyTotal, '两项加起来为40元。'))
  assert.equal(quantityResultCovered(cnyTotal, 'The total cost is 40 dollars.'), false)
})

test('an item list keeps names with and intact and never allocates a bundle price to each item', async t => {
  const now = Date.UTC(2026, 10, 25, 13)
  t.mock.method(Date, 'now', () => now)
  let root, key, filters
  const ask = await setup(t, {}, [], (data, project) => {
    root = data; key = project
    durationSource(root, key, 'bundle', 'I bought the desk lamp and desk stand together for $48.', now - 86400_000)
    filters = durationSource(root, key, 'filter-set', 'I bought the filter and guard set for $9.', now - 86400_000)
  })
  const query = 'What is the total cost of the desk lamp, desk stand, and filter and guard set I bought?'
  const incomplete = await ask(query, 'UTC')
  assert.deepEqual(incomplete.report.questions.map(slot => slot.quantity?.subject), ['desk lamp', 'desk stand', 'filter and guard set'])
  assert.deepEqual(incomplete.report.questions.map(slot => slot.injected.map(hit => hit.sourceRefs[0].sourceId)), [[], [], [filters]])
  assert.equal(incomplete.report.quantityCheck?.result, null)
  assert.doesNotMatch(incomplete.block, /\$48/u)
  const separate = durationSource(root, key, 'separate-prices', 'I bought the desk lamp for $25; I bought the desk stand for $23.', now - 86400_000)
  const full = await ask(query, 'UTC')
  assert.deepEqual(full.report.questions.map(slot => slot.injected.map(hit => hit.sourceRefs[0].sourceId)), [[separate], [separate], [filters]])
  assert.equal(full.report.quantityCheck?.result, '57')
  assert.match(full.block, /25 \+ 23 \+ 9 = \$57/u)
})

test('a qualified count and a unique-entity question keep evidence without assuming additivity', async t => {
  const ask = await setup(t, {}, ['青松站约12次巡检。', '橘湾站7次巡检。',
    'The Aurora district recorded 4 unique visitors.', 'The Bay district recorded 7 unique visitors.'])
  for (const query of ['青松站和橘湾站合计多少次巡检？',
    'What is the total number of unique visitors recorded for Aurora district and Bay district?']) {
    const { block, report } = await ask(query)
    assert.deepEqual(report.questions.map(slot => slot.injected.length), [1, 1])
    assert.equal(report.quantityCheck.result, null)
    assert.doesNotMatch(block, /(?:12|4) \+ 7/u)
  }
})

test('a conflicting authorized source prevents a confident sum even when both named subjects are present', async t => {
  const ask = await setup(t, {}, [], (root, projectKey) => {
    for (const [index, text] of ['The Aurora district counted 4 field inspections.',
      'The Aurora district counted 6 field inspections.', 'The Bay district counted 7 field inspections.'].entries()) {
      const saved = saveSource(root, { sessionId: `session-${index}`, messageId: 'one', text,
        projectKey, role: 'user', sourceKind: 'user' })
      assert.ok(grantSourceRecall(root, readSource(root, saved.id), projectKey, { remembered: true }))
    }
  })
  const { block, report } = await ask('What is the total number of field inspections for the Aurora district and Bay district?')
  assert.match(block, /4 field inspections/u)
  assert.match(block, /6 field inspections/u)
  assert.match(block, /7 field inspections/u)
  assert.match(block, /Aurora district = conflicting evidence/u)
  assert.equal(report.quantityCheck.result, null)
})

test('answer style modifiers in either order are controls, not extra factual questions',()=>{
  for(const instruction of ['请逐项简短回答','请简短逐项回答','请逐项简洁作答','请简要回答']){
    const slots=recallQueryPlan(`${question}${instruction}，没有依据就说不知道；不要调用工具，也不要保存这次问答。`,'',false)
      .filter(part=>part.role==='subquestion')
    assert.equal(slots.length,8,instruction)
    assert.ok(slots.every(slot=>!slot.query.includes('回答')&&!slot.query.includes('作答')))
  }
  assert.ok(recallQueryPlan('用户希望什么风格的回答？','',false).some(part=>part.query.includes('风格')))
})

test('a polite instruction to answer from memory preserves the three real snapshot questions', () => {
  const snapshot = '澄湾快照每天几点执行、保留多久、为什么改时间？'
  for (const query of [
    snapshot + '请只根据记忆逐项回答。不要保存或提炼本轮问答。不要调用工具。',
    '请只根据记忆逐项回答：' + snapshot,
    '请根据已有记忆来分别简短作答：' + snapshot,
  ]) {
    const parts = recallQueryPlan(query).filter(part => part.role === 'subquestion')
    assert.deepEqual(parts.map(part => part.detail), ['clock', 'retention', 'reason'], query)
  }
})

test('standalone answer formats do not add questions or erase quoted source text', () => {
  const question = '雾杉备份每天几点执行、记录保留多久、为什么改时间？'
  for (const instruction of ['请按原话逐项回答', '请按表格回答', '只给结论']) {
    const parts = recallQueryPlan(`${question}${instruction}。不要保存本轮问答。`)
      .filter(part => part.role === 'subquestion')
    assert.deepEqual(parts.map(part => part.detail), ['clock', 'retention', 'reason'], instruction)
    assert.ok(parts.every(part => !part.query.includes(instruction)), instruction)
  }

  const quoted = recallQueryPlan('“请按原话逐项回答”是什么意思？')
  assert.ok(quoted.some(part => part.query.includes('请按原话逐项回答')))
})

test('a request to give only the unit does not add a recall question',()=>{
  const plan=recallQueryPlan('我偏好用什么计量单位？请只给单位。不要保存或提炼本轮问答。','',false)
  assert.deepEqual(plan.map(part=>part.query),['我偏好用什么计量单位'])
})

test('an elliptical floor question retains the object from its preceding location question',()=>{
  const slots=recallQueryPlan('雪松交接的备用物料盒放在哪里，哪一层？','',false).filter(p=>p.role==='subquestion')
  assert.equal(slots.length,2)
  assert.deepEqual(slots[1].entityTerms,slots[0].entityTerms)
  assert.equal(slots[1].detail,'floor')
})

test('a fresh session receives all eight versions when its configured budget fits',async t=>{
  const ask=await setup(t),{block,report}=await ask()
  for(const [name,version] of versions) assert.ok(block.includes(version),`${name} must reach the answer model`)
  assert.equal(report.covered.length,8)
  assert.deepEqual(report.missing,[])
})

test('the delivered coverage denominator excludes answer style instructions',async t=>{
  const ask=await setup(t),{block,report}=await ask(question+'请逐项简短回答，没有依据就说不知道。不要调用工具，也不要保存这次问答。')
  assert.equal(report.total,8)
  assert.equal(report.covered.length,8)
  assert.deepEqual(report.missing,[])
  assert.equal(versions.filter(([,version])=>block.includes(version)).length,8)
})

test('clock and retention stay bound to the named object when nearby clauses name another object',async t=>{
  const ask=await setup(t,{},[
    '碧潮方案的快照每天07:26运行，保留43天；赤潮方案的快照每天06:15运行，保留90天。',
    '碧潮方案的日志每天09:00运行，保留7天。',
    '碧潮计划的快照每天04:00运行，保留21天。',
    '紫杉清理任务每天03:30运行，保留14天。',
    '碧潮方案选择夜间传输，是为了避开白天校验窗口。',
  ])
  const {block,report}=await ask('碧潮方案快照每天几点运行，保留多久？缺少依据就说不知道。不要保存或提炼这次问答。')
  assert.match(block,/07:26/u,JSON.stringify(report,null,2))
  assert.match(block,/43天/u)
  assert.match(block,/碧潮方案的快照每天07:26运行，保留43天；赤潮方案的快照每天06:15运行，保留90天/u)
  assert.doesNotMatch(block,/09:00|7天|04:00|21天|03:30|14天/u)
  assert.equal(report.total,2)
  assert.equal(report.covered.length,2)
  assert.ok(report.covered.every(item=>item.evidence.some(evidence=>evidence.id==='mem_complete_0')))
  assert.deepEqual(report.missing,[])
})

test('a follow-on clock question about now uses the same object and a separate effective date', async t => {
  const ask = await setup(t, {}, [
    '栖港备份每天在 04:36 启动。',
    { content: '栖港备份过去在 00:18 开始。', status: 'superseded', validTo: Date.now() - 86_400_000 },
    '栖岗备份每天在 05:31 开始。',
  ])
  const { block, report } = await ask('栖港备份以前几点做，现在又是几点？')
  assert.match(block, /00:18/u)
  assert.match(block, /04:36/u)
  assert.doesNotMatch(block, /05:31/u)
  assert.equal(report.total, 2)
  assert.deepEqual(report.missing, [])
  assert.deepEqual(report.questions.map(item => item.injected.map(hit => hit.id)), [
    ['mem_complete_1'], ['mem_complete_0'],
  ])
})

test('current near-matches cannot crowd an older setting out of a historical subquestion', async t => {
  const ask = await setup(t, {}, [
    '栖港备份现在每天在 04:36 启动。',
    { content: '栖港备份旧执行时刻为 00:18。', status: 'superseded', validTo: Date.now() - 86_400_000 },
    ...Array.from({ length: 70 }, (_, index) => `栖港备份以前几点做？第 ${index} 份排查清单要补上栖港备份以前几点做。`),
  ])
  const { block, report } = await ask('栖港备份以前几点做，现在又是几点？')
  assert.match(block, /00:18/u)
  assert.match(block, /04:36/u)
  assert.doesNotMatch(block, /排查清单/u)
  assert.deepEqual(report.questions.map(item => item.injected.map(hit => hit.id)), [
    ['mem_complete_1'], ['mem_complete_0'],
  ])
})

test('a dated question ranks only settings effective on the target date', async t => {
  const ask = await setup(t, {}, [
    { content: '青浦镜像每天在 01:47 执行。', status: 'superseded',
      validFrom: Date.UTC(2025, 8, 1), validTo: Date.UTC(2025, 9, 1) },
    ...Array.from({ length: 70 }, (_, index) => ({
      content: `青浦镜像在2025-09-18几点执行？第 ${index} 项修订后统一每天在 05:38 执行。`,
      status: 'superseded', validFrom: Date.UTC(2025, 10, 1), validTo: Date.UTC(2025, 11, 1),
    })),
  ])
  for (const question of ['青浦镜像在2025-09-18几点执行？', '青浦镜像于2025年9月18日那天几点执行？']) {
    const { block, report } = await ask(question)
    assert.match(block, /01:47/u)
    assert.doesNotMatch(block, /05:38/u)
    assert.match(block, /2025-09-18 时有效/u)
    assert.doesNotMatch(block, /已失效/u)
    assert.deepEqual(report.questions.flatMap(item => item.injected.map(hit => hit.id)), ['mem_complete_0'])
    assert.ok(report.questions[0].injected.every(hit => block.includes(hit.text)))
  }
  const relative = recallQueryPlan('青浦镜像在三天前几点执行？').find(part => part.role === 'subquestion')
  assert.deepEqual(relative.entityTerms, ['青浦', '浦镜', '镜像'])
})

test('an English question word does not hide the evidence for a named dependency', async t => {
  const ask = await setup(t, {}, [
    'Production uses Next.js 15.1.7.',
    'Production uses Node.js 22.13.1.',
  ])
  const { block, report } = await ask('Which version of Next.js is in production?')
  assert.match(block, /15\.1\.7/u)
  assert.doesNotMatch(block, /22\.13\.1/u)
  assert.equal(report.covered.length, 1)
  assert.deepEqual(report.missing, [])
})

test('an English name question requires the requested object and evidence of its name', async t => {
  const ask = await setup(t, {}, [
    "My office cat's name is Juniper.",
    'My office rabbit likes to hide under the shelf.',
  ])
  const unknown = await ask('What is the name of my office rabbit?')
  assert.equal(unknown.block, '')
  assert.deepEqual(unknown.report.questions[0].injected, [])
  const known = await ask('What is the name of my office cat?')
  assert.match(known.block, /Juniper/u)
  assert.doesNotMatch(known.block, /shelf/u)
})

test('an original message after the current question cannot provide its answer', async t => {
  const now = Date.UTC(2026, 10, 25, 12)
  t.mock.method(Date, 'now', () => now)
  const question = 'What is the name of my office rabbit?'
  const ask = await setup(t, {}, [], (root, projectKey) => {
    const source = saveSource(root, { sessionId: 'later-chat', messageId: 'naming', projectKey,
      role: 'user', sourceKind: 'user', text: "My office rabbit's name is Clover.", at: now + 1000,
      eventTime: now + 1000, timeZone: 'UTC' })
    assert.ok(grantSourceRecall(root, readSource(root, source.id), projectKey, { remembered: true }))
  })
  const result = await ask(question, 'UTC')
  assert.equal(result.block, '')
  assert.deepEqual(result.report.questions[0].injected, [])
})

test('answer coverage keeps matching times, periods and retractions with their own question', () => {
  const make = (query, detail, entity, text, reasonPhrases) => ({
    query, detail, entityTerms: [entity], injected: [{ verified: true, text, reasonPhrases }],
  })
  const clock = make('灰桦快照几点执行', 'clock', '灰桦快照', '灰桦快照每天 04:37 执行。')
  const other = make('青岚快照几点执行', 'clock', '青岚快照', '青岚快照每天 06:30 执行。')
  const retention = make('灰桦快照保留多久', 'retention', '灰桦快照', '灰桦快照保留 37 天。')
  const cause = '旧窗口覆盖不到审计抽查'
  const reason = make('灰桦快照为什么改', 'reason', '灰桦快照', '灰桦快照因为' + cause + '而改。', [cause])
  const otherReason = make('青岚快照为什么改', 'reason', '青岚快照',
    '青岚快照因为每日写盘冲突而改。', ['每日写盘冲突'])
  const coverage = (question, answer, siblings) => assessAnswerCoverage(question, answer, siblings).answerCoverage

  assert.equal(coverage(clock, '青岚快照每天 04:37 执行。'), 'unverified')
  assert.equal(coverage(clock, '灰桦快照每天 04:37 执行。青岚快照每天 06:30 执行。'), 'covered')
  assert.equal(coverage(clock, '灰桦快照每天 04:37 执行。现行时间是 06:30。'), 'unverified')
  assert.equal(coverage(clock, '灰桦快照每天 04:37 执行。执行时间未明确说明。'), 'unverified')
  assert.equal(coverage(clock, '灰桦快照每天 04:37 执行。灰桦快照并不是每天 04:37 执行。'), 'unverified')
  assert.equal(coverage(clock, '灰桦快照以前每天 06:30 执行。现在每天 04:37 执行。'), 'covered')
  assert.equal(coverage(clock, '灰桦快照每天 04:37 执行，因为要避开 06:30 的导入。'), 'covered')
  assert.equal(coverage(clock, 'The snapshot runs at 4:37 a.m. every day.'), 'covered')
  assert.equal(coverage(clock, 'The snapshot runs at 4:37 p.m. every day.'), 'unverified')
  assert.equal(coverage(clock, '灰桦快照每天 04:37 执行。青岚快照每天 06:30 执行。', [clock, other]), 'covered')
  assert.equal(coverage(clock, '青岚快照每天 04:37 执行。', [clock, other]), 'unverified')
  assert.equal(coverage(retention, 'The snapshot is retained for 37 days.'), 'covered')
  assert.equal(coverage(retention, 'The snapshot is retained for 37 hours.'), 'unverified')
  assert.equal(coverage(retention, '灰桦快照保留 37 天。现行保留期限为 27 天。'), 'unverified')
  assert.equal(coverage(retention, '灰桦快照保留 37 天。The retention period is not recorded.'), 'unverified')
  assert.equal(coverage(reason, '不是因为' + cause + '。'), 'unverified')
  assert.equal(coverage(reason, '不是因为磁盘满了，而是因为' + cause + '。'), 'covered')
  assert.equal(coverage(reason, '因为' + cause + '。个别抽查的编号未详细说明。'), 'covered')
  assert.equal(coverage(reason, '青岚快照因为' + cause + '而改。'), 'unverified')
  assert.equal(coverage(reason, '灰桦快照因为' + cause + '而改。青岚快照的具体原因未详细说明。', [reason, otherReason]), 'covered')
})

test('coverage reports only delivered evidence after the item limit, with omitted questions explicit',async t=>{
  const ask=await setup(t,{maxItems:2}),{block,report}=await ask()
  assert.equal(versions.filter(([,version])=>block.includes(version)).length,2)
  assert.equal(report.covered.length,2)
  assert.ok(Array.isArray(report.retrieved),'Retrieved evidence is reported separately from delivered evidence')
  assert.equal(report.retrieved.length,8)
  assert.equal(report.budgetOmitted.length,6)
  assert.equal(report.missing.length,6)
  for(const covered of report.covered) for(const evidence of covered.evidence){
    const i=Number(evidence.id.split('_').at(-1));assert.ok(block.includes(versions[i][1]))
  }
})

test('token exhaustion cannot report evidence as delivered',async t=>{
  const ask=await setup(t,{maxTokens:110}),{block,report}=await ask()
  const delivered=versions.filter(([,version])=>block.includes(version)).length
  assert.ok(delivered<8)
  assert.equal(report.covered.length,delivered)
  assert.ok(Array.isArray(report.retrieved),'Retrieved evidence remains visible when the output budget is exhausted')
  assert.equal(report.retrieved.length,8)
  assert.equal(report.missing.length,8-delivered)
})

test('dated attendance uses the requested calendar month and the client year to date', async t => {
  const now = Date.UTC(2026, 0, 6, 12)
  t.mock.method(Date, 'now', () => now)
  const ask = await setup(t, {}, [], (root, projectKey) => {
    const add = (id, text, at, scope = projectKey) => {
      const source = saveSource(root, { sessionId: 'earlier-' + id, messageId: id, projectKey: scope,
        role: 'user', sourceKind: 'user', text, eventTime: at, at, timeZone: 'UTC' })
      assert.ok(grantSourceRecall(root, readSource(root, source.id), scope, { remembered: true }))
      return source.id
    }
    const earlier = Date.UTC(2026, 0, 5, 15)
    add('month-first', 'I attended the Cedar bat watching event on 2025-12-01.', earlier)
    add('month-last', 'I attended the Birch bat watching event on 2025-12-31.', earlier)
    add('older-year', 'I attended the Moss bat watching event on 2024-12-18.', earlier)
    add('previous-month', 'I attended the Elm bat watching event on 2025-11-30.', earlier)
    add('this-year', 'I attended the Oak bat watching event on 2026-01-01.', earlier)
    add('today', 'I attended the Maple bat watching event today.', now)
    add('future-date', 'I attended the Juniper bat watching event on 2026-01-20.', now)
    add('zh-year', '我于2026-01-03参加了楠木应急演练。', earlier)
    add('zh-other-year', '我于2025-12-28参加了赤松应急演练。', earlier)
    add('not-mine', 'My friend attended the Alder bat watching event on 2025-12-18.', earlier)
    add('canceled', 'I planned to attend the Pine bat watching event on 2025-12-18.', earlier)
    add('different-project', 'I attended the Flint bat watching event on 2025-12-18.', earlier, 'other-project')
    const forgotten = add('forgotten', 'I attended the Clay bat watching event on 2025-12-18.', earlier)
    blockSourceRecall(root, { sourceRefs: [{ sourceId: forgotten }] })
  })
  const december = await ask('How many bat watching events did I attend in December?', 'UTC')
  assert.equal(december.report.questions[0].eventCount?.confirmed, 2)
  assert.equal(december.report.questions[0].eventCount?.complete, true)
  assert.match(december.block, /Cedar/u)
  assert.match(december.block, /Birch/u)
  assert.doesNotMatch(december.block, /Moss|Elm|Oak|Maple|Alder|Pine|Flint|Clay/u)


  const decemberCount = december.report.questions[0].eventCount
  assert.equal(matchesEventCountAnswer('You attended 2 bat watching events in December 2025.', decemberCount), true)
  assert.equal(matchesEventCountAnswer('You attended 2 bat watching events in December 2024.', decemberCount), false)
  assert.equal(matchesEventCountAnswer('You attended 2 bat watching events in January.', decemberCount), false)
  assert.equal(matchesEventCountAnswer('You attended 2 bat watching events this year.', decemberCount), false)
  assert.equal(matchesEventCountAnswer('2', decemberCount), true)

  const explicitYear = await ask('How many bat watching events did I attend in December 2024?', 'UTC')
  assert.equal(explicitYear.report.questions[0].eventCount?.confirmed, 1)
  assert.match(explicitYear.block, /Moss/u)

  const thisYear = await ask('How many bat watching events have I attended in this year?', 'UTC')
  assert.equal(thisYear.report.questions[0].eventCount?.confirmed, 2)
  assert.equal(thisYear.report.questions[0].eventCount?.complete, true)
  assert.match(thisYear.block, /Oak/u)
  assert.match(thisYear.block, /Maple/u)
  assert.doesNotMatch(thisYear.block, /Cedar|Birch/u)

  const january = await ask('How many bat watching events did I attend in January 2026?', 'UTC')
  assert.equal(january.report.questions[0].eventCount?.confirmed, 2)
  assert.doesNotMatch(january.block, /Cedar|Birch|Moss|Juniper/u)

  const chinese = await ask('今年我参加了几次应急演练？', 'UTC')
  assert.equal(chinese.report.questions[0].eventCount?.confirmed, 1)
  assert.match(chinese.block, /楠木/u)
  assert.doesNotMatch(chinese.block, /赤松/u)


  const future = await ask('How many bat watching events did I attend in December 2030?', 'UTC')
  assert.equal(future.report.questions[0].detail, 'event-count')
  assert.equal(future.report.questions[0].eventCount?.complete, false)
  assert.deepEqual(future.report.questions[0].injected, [])
  const noZone = await ask('How many bat watching events did I attend in December?')
  assert.equal(noZone.report.questions[0].detail, 'event-count')
  assert.equal(noZone.report.questions[0].eventCount?.complete, false)
  assert.deepEqual(noZone.report.questions[0].injected, [])
})

test('total driving time uses completed one-way times for distinct destinations', async t => {
  const now = Date.UTC(2026, 10, 25, 15)
  t.mock.method(Date, 'now', () => now)
  const setupRoads = ({ blockTrip = false, conflict = false, denied = false } = {}) => async (root, projectKey) => {
    const add = (messageId, text, scope = projectKey) => {
      const at = now - 86_400_000
      const source = saveSource(root, { sessionId: 'earlier-' + messageId, messageId, projectKey: scope,
        role: 'user', sourceKind: 'user', text, at, timeZone: 'UTC', eventTime: at })
      assert.ok(grantSourceRecall(root, readSource(root, source.id), scope, { remembered: true }))
      return source.id
    }
    add('banks', "I've had some great experiences with coastal trips, like my recent trip to Outer Banks in North Carolina - it only took me four hours to drive there from my place.")
    add('tn', "I've had some experience with camping, like on my recent trip to the mountains in Tennessee - I drove for five hours to get there and it was totally worth it.")
    const dc = add('dc', "I've had some great experiences with my GPS device, like when I drove for six hours to Washington D.C. recently, but I'm not sure about the best route to take for my next trip.")
    if (!blockTrip) add('repeat', 'I drove for six hours to Washington D.C.')
    add('next-trip', "I'm planning to drive for eight hours to Savannah.")
    add('reported', 'My brother said I drove for twelve hours to Atlanta.')
    add('return', 'I drove for three hours back from Pine Valley.')
    add('round-trip', 'I drove for thirteen hours round trip to Seattle.')
    add('wrong-project', 'I drove for ten hours to Redmond.', 'other-project')
    if (denied) add('denied', "Actually, I never drove to Washington D.C.")
    if (conflict) add('conflict', 'I drove for seven hours to Washington D.C. on my last road trip.')
    if (blockTrip) blockSourceRecall(root, { sourceRefs: [{ sourceId: dc }] })
  }
  const query = 'How many hours in total did I spend driving to my three road trip destinations combined?'
  const ask = await setup(t, {}, [], setupRoads())
  const full = await ask(query, 'UTC')
  assert.equal(full.report.questions[0].detail, 'elapsed-interval')
  assert.match(full.block, /4 hours \+ 5 hours \+ 6 hours = 15 hours/u)
  assert.equal(full.report.questions[0].injected.length, 3)
  assert.doesNotMatch(full.block, /Savannah|Atlanta|Pine Valley|Seattle|Redmond/u)
  assert.match(full.block, /my GPS device/iu)
  const check = answer => assessAnswerCoverage(full.report.questions[0], answer).answerCoverage
  assert.equal(check('You spent a total of 15 hours driving to the three destinations.'), 'covered')
  assert.equal(check('4 hours + 5 hours + 6 hours = 15 hours.'), 'covered')
  const itemized = 'You spent a total of 15 hours driving to your three road trip destinations. This is calculated by adding the hours for each destination: 4 hours for Outer Banks in North Carolina, 5 hours for the mountains in Tennessee, and 6 hours for Washington D.C.'
  assert.equal(check(itemized), 'covered')
  assert.equal(check(itemized.replace('4 hours for Outer Banks', '5 hours for Outer Banks')), 'unverified')
  assert.equal(check(itemized.replace('Washington D.C.', 'Seattle')), 'unverified')
  assert.equal(check('2 hours + 5 hours + 8 hours = 15 hours.'), 'unverified')
  assert.equal(check('15 hours round trip.'), 'unverified')
  assert.equal(check('You drove 15 hours to Seattle.'), 'unverified')

  const disputed = await setup(t, {}, [], setupRoads({ conflict: true }))
  const conflict = await disputed(query, 'UTC')
  assert.doesNotMatch(conflict.block, /verified one-way|15 hours/iu)

  const canceled = await setup(t, {}, [], setupRoads({ denied: true }))
  const correction = await canceled(query, 'UTC')
  assert.doesNotMatch(correction.block, /Washington|15 hours/u)
  assert.match(correction.block, /total is unknown/u)

  const lost = await setup(t, {}, [], setupRoads({ blockTrip: true }))
  const clipped = await lost(query, 'UTC')
  assert.doesNotMatch(clipped.block, /verified one-way|15 hours/iu)
  assert.match(clipped.block, /total is unknown/u)
  assert.equal(clipped.report.questions[0].injected.length, 2)

  const budget = await setup(t, {maxItems: 2}, [], setupRoads())
  const short = await budget(query, 'UTC')
  assert.doesNotMatch(short.block, /verified one-way|15 hours/iu)
})

test('medical appointment counts preserve completed dated visits and uncertainty about undated records', async t => {
  const now = Date.UTC(2026, 2, 27, 15)
  t.mock.method(Date, 'now', () => now)
  const clinic = (undated, revoke = false) => async (root, projectKey) => {
    const add = (messageId, text, scope = projectKey) => {
      const at = now - 86_400_000
      const source = saveSource(root, { sessionId: 'earlier-' + messageId, messageId, projectKey: scope,
        role: 'user', sourceKind: 'user', text, eventTime: at, at, timeZone: 'UTC' })
      assert.ok(grantSourceRecall(root, readSource(root, source.id), scope, { remembered: true }))
      return source.id
    }
    const first = add('completed-visit', 'By the way, I finally went to see my primary care physician, Dr. Avery, on March 3rd, and the visit was helpful.')
    add('completed-followup', 'I recently had a follow-up appointment with my orthopedic surgeon, Dr. Chen, on March 20th, and it went well.')
    add('wrong-month', 'I had an appointment with my physician, Dr. Green, on February 27th, and it went well.')
    add('to-book', 'I plan to schedule an appointment with my doctor, Dr. Rose, on March 25th.')
    add('canceled', 'I had an appointment with my cardiologist, Dr. White, on March 16th, but it was canceled.')
    add('another-person', 'My brother went to see his primary care physician, Dr. Miller, on March 12th.')
    add('other-project', 'I had an appointment with my doctor, Dr. Martin, on March 14th.', 'other-project')
    if (undated) add('undated', 'I had an appointment with my primary care physician, but I did not write down the date.')
    if (revoke) blockSourceRecall(root, { sourceRefs: [{ sourceId: first }] })
  }

  const query = 'How many doctor’s appointments did I go to in March?'
  const ask = await setup(t, {}, [], clinic(true))
  const result = await ask(query, 'UTC')
  const counter = result.report.questions[0].eventCount
  assert.equal(counter?.confirmed, 2)
  assert.equal(counter?.complete, false)
  assert.match(result.block, /at least 2 recorded appointments/iu)
  assert.match(result.block, /Dr\. Avery/u)
  assert.match(result.block, /Dr\. Chen/u)
  assert.doesNotMatch(result.block, /Dr\. (?:Green|Rose|White|Miller|Martin)/u)
  assert.equal(assessAnswerCoverage(result.report.questions[0], 'Exactly two appointments.').answerCoverage, 'unverified')

  const noUnknown = await setup(t, {}, [], clinic(false))
  const complete = await noUnknown(query, 'UTC')
  assert.equal(complete.report.questions[0].eventCount?.confirmed, 2)
  assert.equal(complete.report.questions[0].eventCount?.complete, true)

  const dropped = await setup(t, {}, [], clinic(false, true))
  const partial = await dropped(query, 'UTC')
  assert.equal(partial.report.questions[0].eventCount?.confirmed, 1)
  assert.doesNotMatch(partial.block, /Dr\. Avery/u)
})

test('ordinary outbound drives do not establish a total for road-trip destinations', async t => {
  const ask = await setup(t, {}, [], (root, projectKey) => {
    for (const [name, text] of [
      ['north', 'I drove for one hour to North Mesa for work.'],
      ['east', 'I drove for two hours to Diamond Crossing for a delivery.'],
      ['west', 'I drove for three hours to Redwood Bay for groceries.'],
    ]) {
      const at = Date.now() - 1_000
      const source = saveSource(root, { sessionId: name, messageId: 'only', projectKey, text, at,
        eventTime: at, timeZone: 'UTC', role: 'user', sourceKind: 'user' })
      assert.ok(grantSourceRecall(root, readSource(root, source.id), projectKey, { remembered: true }))
    }
  })
  const result = await ask('How many hours in total did I spend driving to my three road trip destinations combined?', 'UTC')
  assert.doesNotMatch(result.block, /verified one-way|= 6 hours/iu)
  assert.equal(result.report.questions[0].elapsed, null)
})

test('relative weekend recall matches the weekend of the question and the date of each original', async t => {
  const now = Date.UTC(2026, 10, 24, 12)
  t.mock.method(Date, 'now', () => now)
  const ask = await setup(t, {}, [], (root, projectKey) => {
    const add = (messageId, text, eventTime, zone = 'UTC', scope = projectKey) => {
      const source = saveSource(root, { sessionId: 'earlier-' + messageId, messageId, projectKey: scope,
        role: 'user', sourceKind: 'user', text, eventTime, at: eventTime, timeZone: zone })
      assert.ok(grantSourceRecall(root, readSource(root, source.id), scope, { remembered: true }))
      return source.id
    }
    add('same-weekend', 'I finished the Cedar maintenance checklist last weekend.', Date.UTC(2026, 10, 23, 15))
    add('weekend-of-other-person', 'I finished the Spruce maintenance checklist, but last weekend she finished a different list.', Date.UTC(2026, 10, 23, 15))
    add('previous-weekend', 'I finished the Birch maintenance checklist last weekend.', Date.UTC(2026, 10, 20, 15))
    add('newer-weekend', 'I finished the Maple maintenance checklist on November 23rd.', Date.UTC(2026, 10, 23, 15))
    add('lost-zone', 'I finished the Garnet maintenance checklist last weekend.', Date.UTC(2026, 10, 23, 15), '')
    add('planned', 'I was planning to finish the Willow maintenance checklist last weekend.', Date.UTC(2026, 10, 23, 15))
    add('foreign', 'I finished the Flint maintenance checklist last weekend.', Date.UTC(2026, 10, 23, 15), 'UTC', 'external')
    const stone = add('forgotten', 'I finished the Clay maintenance checklist last weekend.', Date.UTC(2026, 10, 23, 15))
    blockSourceRecall(root, { sourceRefs: [{ sourceId: stone }] })
    add('game', 'I finally beat the Star Forge game last weekend.', Date.UTC(2026, 10, 20, 15))
    add('zh', '我上周末完成了水杉巡检清单。', Date.UTC(2026, 10, 23, 15))
  })
  const last = await ask('Which maintenance checklist did I finish last weekend?', 'UTC')
  assert.match(last.block, /Cedar maintenance checklist/u)
  assert.match(last.block, /2026-11-21.*2026-11-22/u)
  assert.doesNotMatch(last.block, /Birch|Maple|Garnet|Willow|Flint|Clay|Spruce/u)
  const prior = await ask('Which maintenance checklist did I finish two weekends ago?', 'UTC')
  assert.match(prior.block, /Birch maintenance checklist/u)
  assert.doesNotMatch(prior.block, /Cedar|Maple/u)
  const game = await ask('What game did I finally beat two weekends ago?', 'UTC')
  assert.match(game.block, /Star Forge/u)
  const zh = await ask('我上周末完成了哪个巡检清单？', 'UTC')
  assert.match(zh.block, /水杉巡检清单/u)
})

test('a weekend answer cannot substitute the original message’s relative time for the question date', async t => {
  const now = Date.UTC(2026, 10, 24, 12)
  t.mock.method(Date, 'now', () => now)
  const ask = await setup(t, {}, [], (root, projectKey) => {
    const at = Date.UTC(2026, 10, 20, 12)
    const source = saveSource(root, { sessionId: 'older-weekend-timing', messageId: 'joined-clock', projectKey,
      role: 'user', sourceKind: 'user', text: 'I finished the Birch maintenance checklist last weekend.',
      eventTime: at, at, timeZone: 'UTC' })
    assert.ok(grantSourceRecall(root, readSource(root, source.id), projectKey, { remembered: true }))
  })
  const { block, report } = await ask('Which maintenance checklist did I finish two weekends ago?', 'UTC')
  const tested = report.questions[0]
  const covered = text => assessAnswerCoverage(tested, text).answerCoverage
  assert.equal(covered('You finished the Birch maintenance checklist last weekend. There is no mention of a checklist finished two weekends ago.'), 'unverified')
  assert.equal(covered('You finished the Birch maintenance checklist on November 22, 2026.'), 'unverified')
  assert.equal(covered('You finished the Birch maintenance checklist between November 14 and 22, 2026.'), 'unverified')
  assert.equal(covered('You finished the Birch maintenance checklist two weekends ago.'), 'covered')
  assert.equal(covered('You finished the Birch maintenance checklist on November 14–15, 2026.'), 'covered')
  assert.equal(covered('You finished the Birch maintenance checklist.'), 'covered')
  assert.match(block, /Use the dated evidence for the period in the question/u)
  assert.match(block, /2026-11-14.*2026-11-15.*I finished the Birch maintenance checklist last weekend/u)
  assert.match(block, /Date-resolved statement.*during 2026-11-14.*2026-11-15/u)
})

test('an existing dated original remains available under the user memory budget', async t => {
  const now = Date.UTC(2026, 10, 24, 12)
  t.mock.method(Date, 'now', () => now)
  const detail = 'by checking the corrosion measurements, verifying the calibration labels, comparing the maintenance photographs, recording the available spare parts, marking the inspection points, and confirming the equipment inventory'
  const original = 'I finished the Birch maintenance checklist ' + detail + ' last weekend.'
  const ask = await setup(t, { maxTokens: 180 }, [], (root, projectKey) => {
    const at = Date.UTC(2026, 10, 20, 12)
    const source = saveSource(root, { sessionId: 'older-weekend-budget', messageId: 'long-original', projectKey,
      role: 'user', sourceKind: 'user', text: original, eventTime: at, at, timeZone: 'UTC' })
    assert.ok(grantSourceRecall(root, readSource(root, source.id), projectKey, { remembered: true }))
  })
  const { block, report } = await ask('Which maintenance checklist did I finish two weekends ago?', 'UTC')
  assert.ok(block.includes(original), block)
  assert.equal(report.questions[0].injected.length, 1)
  assert.ok(block.includes(report.questions[0].injected[0].text), 'the report must quote the exact text sent')
})

test('recorded market proceeds combine distinct completed receipts and explicit per-item prices', async t => {
  const now = Date.UTC(2026, 5, 2, 15)
  t.mock.method(Date, 'now', () => now)
  const sales = (forget = false, conflict = false, anotherDay = false) => async (root, projectKey) => {
    const add = (messageId, text, scope = projectKey) => {
      const at = now - 86_400_000
      const source = saveSource(root, { sessionId: 'market-' + messageId, messageId, projectKey: scope,
        role: 'user', sourceKind: 'user', text, at, timeZone: 'UTC', eventTime: at })
      assert.ok(grantSourceRecall(root, readSource(root, source.id), scope, { remembered: true }))
      return source.id
    }
    add('jam', 'By the way, I had a successful week, I just sold 15 jars of my homemade jam at the Homemade and Handmade Market on May 29th, earning $225.')
    add('jam-repeat', 'I sold 15 jars of my homemade jam at the Homemade and Handmade Market on May 29th, earning $225.')
    const plants = add('plants', 'By the way, I just sold 20 potted plants at the Summer Solstice Market for $7.50 each, and it went well.')
    add('herbs', "I had a successful season - I even sold 12 bunches of fresh organic herbs from my backyard garden at the farmers' market on May 15th, earning a total of $120.")
    add('other', 'My coworker sold 10 jars of jam at the Fun Market, earning $900.')
    add('other-owner', 'I sold 10 jars of your jam at the Shared Table Market, earning $901.')
    add('planned', 'I plan to sell 10 jars of jam at the Harvest Market, earning $900.')
    add('market-foreign', 'I sold 10 jars of jam at the Other Market, earning $900.', 'other-project')
    if (conflict) add('jam-conflict','I sold 15 jars of jam at the Homemade and Handmade Market on May 29th, earning $230.')
    if (anotherDay) add('jam-new-day','I sold 2 jars of jam at the Homemade and Handmade Market on May 30th, earning $10.')
    if (forget) blockSourceRecall(root, { sourceRefs: [{ sourceId: plants }] })
  }
  const ask = await setup(t, {}, [], sales())
  const prompt = 'What is the total amount of money I earned from selling my products at the markets?'
  const { block, report } = await ask(prompt, 'UTC')
  const q = report.questions[0]
  assert.equal(q.detail,'market-sales')
  assert.match(block,/recorded market proceeds.*\$495/iu)
  assert.match(block,/20.*\$7.50.*\$150/u)
  assert.equal(q.injected.length,3)
  assert.doesNotMatch(block,/Fun Market|Shared Table Market|Harvest Market|Other Market|\$90[01]/u)
  assert.equal(assessAnswerCoverage(q,'You earned $495 from selling your products at the markets.').answerCoverage,'covered')
  assert.equal(assessAnswerCoverage(q,'$490').answerCoverage,'unverified')
  assert.equal(assessAnswerCoverage(q,"The total amount of money you earned from selling your products at the markets is $495. You earned $225 from the honey, $150 from the potted plants, and $120 from the farmers' market.").answerCoverage,'unverified')
  assert.equal(assessAnswerCoverage(q,"The total amount of money you earned from selling your products at the markets is $495. $225 from Homemade and Handmade Market, $150 from the potted plants, and $120 from the farmers' market.").answerCoverage,'covered')
  assert.equal(assessAnswerCoverage(q,'You earned $495 from selling your products at the markets. You earned $200 from the Homemade and Handmade Market.').answerCoverage,'unverified')

  const modelReply = 'Based on the historical quotes provided, you earned $225 from selling jam, $150 from selling plants, and $120 from selling fresh herbs. Adding these amounts together gives a total of $225 + $150 + $120 = $495. The verified answer also states that the recorded market proceeds were $495.'
  assert.equal(assessAnswerCoverage(q, modelReply).answerCoverage, 'covered')
  assert.equal(assessAnswerCoverage(q, modelReply.replace('= $495', '= $575')).answerCoverage, 'unverified')
  assert.equal(assessAnswerCoverage(q, modelReply.replace('+ $120', '+ $130')).answerCoverage, 'unverified')
  assert.equal(assessAnswerCoverage(q, 'You earned $495 each.').answerCoverage, 'unverified')

  const itemized = `The recorded market receipts were:
- $225 from selling 15 jars of jam.
- $150 from selling 20 potted plants.
- $120 from selling 12 bunches of fresh organic herbs.
Adding these amounts together: $225 + $150 + $120 = $495.
The verified answer states that the total amount of money you earned from selling your products at the markets is $495.`
  assert.equal(assessAnswerCoverage(q, itemized).answerCoverage, 'covered')
  assert.equal(assessAnswerCoverage(q, itemized.replace('15 jars', '16 jars')).answerCoverage, 'unverified')
  const recap = itemized.replace('is $495.', 'is $495, which matches the sum of the amounts you earned from selling your products.')
  assert.equal(assessAnswerCoverage(q, recap).answerCoverage, 'covered')
  assert.equal(assessAnswerCoverage(q, recap.replace('which matches the sum', 'which is your monthly average')).answerCoverage, 'unverified')
  assert.equal(assessAnswerCoverage(q, itemized.replace('12 bunches of fresh organic herbs', '12 herbs')).answerCoverage, 'unverified')

  const disputed = await setup(t, {}, [], sales(false, true))
  const unresolved = await disputed(prompt, 'UTC')
  assert.match(unresolved.block,/total is unknown/iu)
  assert.doesNotMatch(unresolved.block,/\$[0-9]/u)
  assert.ok(unresolved.report.questions[0].notInjected.length > 0)

  const another = await setup(t, {}, [], sales(false, false, true))
  const expanded = await another(prompt, 'UTC')
  assert.match(expanded.block,/recorded market proceeds.*\$505/iu)
  assert.equal(expanded.report.questions[0].injected.length,4)

  const removed = await setup(t, {}, [], sales(true))
  const fewer = await removed(prompt, 'UTC')
  assert.doesNotMatch(fewer.block,/Summer Solstice|\$495/u)
  assert.match(fewer.block,/\$345/u)
  const remaining = 'From the quotes provided, you sold jam earning $225 and fresh organic herbs earning $120. The total amount of money you earned from selling your products at the markets is $345.'
  assert.equal(assessAnswerCoverage(fewer.report.questions[0], remaining).answerCoverage, 'covered')
  assert.equal(assessAnswerCoverage(fewer.report.questions[0], remaining.replace('jam earning $225','jam earning $120')).answerCoverage, 'unverified')
  const addressed = 'Based on the historical quotes provided, you earned $225 from selling your homemade jam and $120 from selling fresh organic herbs. The verified answer states that the total recorded market proceeds were $345. Therefore, the total amount of money you earned from selling your products at the markets is $345.'
  assert.equal(assessAnswerCoverage(fewer.report.questions[0], addressed).answerCoverage, 'covered')
  assert.equal(assessAnswerCoverage(fewer.report.questions[0], addressed.replace('your homemade jam', 'your friend’s homemade jam')).answerCoverage, 'unverified')
})

test('personal charity totals keep collective proceeds out and report any missing total', async t => {
  const now = Date.UTC(2026, 10, 25, 15)
  t.mock.method(Date, 'now', () => now)
  const seed = includeTotal => (root, projectKey) => {
    const add = (id, text, key = projectKey) => {
      const at = now - 1000
      const saved = saveSource(root, { sessionId:id, messageId:'receipt', projectKey:key, text, at,
        eventTime:at, timeZone:'UTC', role:'user', sourceKind:'user' })
      assert.ok(grantSourceRecall(root, readSource(root, saved.id), key, { remembered:true }))
    }
    add('team', "I volunteered at the charity bake sale and it was wonderful - we raised $1,000 for the children's hospital.")
    add('helped', 'I helped raise over $2,000 for the local animal shelter at the charity fair.')
    add('own-food', 'I ran in the charity event and raised $250 for a local food bank.')
    add('own-cancer', 'I completed the charity fitness challenge and managed to raise $500 for the American Cancer Society.')
    add('intent', 'I plan to raise $375 for charity.')
    add('other', 'I personally raised $850 in total for charity.', 'foreign')
    if (includeTotal) add('actual-total', 'I personally raised $750 in total for charity.')
  }
  const question = 'How much money did I raise for charity in total?'
  const partial = await setup(t, {}, [], seed(false))
  const result = await partial(question, 'UTC')
  assert.match(result.block, /personal total is unknown/iu)
  assert.doesNotMatch(result.block, /\$250|\$500|\$1,000|\$2,000|\$375|\$850/u)
  const withheld = result.report.questions[0].notInjected.flatMap(hit => hit.sourceRefs.map(ref => ref.excerpt)).join(' ')
  assert.match(withheld, /\$250/u)
  assert.match(withheld, /\$500/u)
  assert.equal(assessAnswerCoverage(result.report.questions[0], 'You raised $1,000 for charity.').answerCoverage, 'not-injected')

  const full = await setup(t, {}, [], seed(true))
  const answered = await full(question, 'UTC')
  assert.match(answered.block, /verified personal total.*\$750/iu)
  assert.equal(assessAnswerCoverage(answered.report.questions[0], 'You personally raised $750 in total for charity.').answerCoverage, 'covered')
  assert.equal(assessAnswerCoverage(answered.report.questions[0], 'The verified personal total is $750.').answerCoverage, 'covered')
  assert.equal(assessAnswerCoverage(answered.report.questions[0], 'Your team raised $750 in total for charity.').answerCoverage, 'unverified')
})

test('a days-ago question binds today to the original completed event and rejects a contradictory answer', async t => {
  const now = Date.UTC(2026, 3, 18, 1, 48)
  const day = 86_400_000
  t.mock.method(Date, 'now', () => now)
  const originals = (conflict = false, forget = false) => (root, projectKey) => {
    const source = (id, text, elapsed, scope = projectKey, timeZone = 'UTC') => {
      const at = now - elapsed * day
      const saved = saveSource(root, { sessionId: 'ago-' + id, messageId: id, role: 'user', sourceKind: 'user',
        text, projectKey: scope, at, eventTime: at, timeZone })
      assert.ok(grantSourceRecall(root, readSource(root, saved.id), scope, { remembered: true }))
      return saved.id
    }
    const value = source('actual', 'I just harvested my first batch of fresh herbs from the herb garden kit today and I want to use them up!', 3)
    source('different', 'I harvested my second batch of fresh herbs from the herb garden kit today.', 1)
    source('future', 'I harvested my first batch of fresh herbs from the herb garden kit today.', -1)
    source('elsewhere', 'I harvested my first batch of fresh herbs from the herb garden kit today.', 8, 'other-project')
    if (conflict) source('another-date', 'I harvested my first batch of fresh herbs from the herb garden kit yesterday.', 5)
    if (forget) blockSourceRecall(root,{ sourceRefs:[{sourceId:value}] })
  }

  const question = 'How many days ago did I harvest my first batch of fresh herbs from the herb garden kit?'
  const ask = await setup(t, {}, [], originals())
  const ok = await ask(question, 'UTC')
  const slot = ok.report.questions[0]
  assert.equal(slot.detail,'event-age')
  assert.equal(slot.eventAge.days,3)
  assert.match(ok.block,/3 days ago/u)
  assert.match(ok.block,/2026-04-15/u)
  assert.equal(slot.injected.length,1)
  assert.match(slot.injected[0].selectedQuote,/today$/u)
  assert.equal(assessAnswerCoverage(slot,'You harvested your first batch 3 days ago, on April 15.').answerCoverage,'covered')
  assert.equal(assessAnswerCoverage(slot,'You harvested your first batch 3 days ago. It was today.').answerCoverage,'unverified')
  assert.equal(assessAnswerCoverage(slot,'You harvested the first batch 0 days ago.').answerCoverage,'unverified')

  const noZone = await ask(question)
  assert.equal(noZone.report.questions[0].eventAge.days,null)
  assert.doesNotMatch(noZone.block,/I just harvested|3 days ago/u)
  const disputed = await setup(t, {}, [], originals(true))
  const unresolved = await disputed(question, 'UTC')
  assert.equal(unresolved.report.questions[0].eventAge.days,null)
  assert.doesNotMatch(unresolved.block,/I just harvested|3 days ago/u)
  const removed = await setup(t, {}, [], originals(false,true))
  assert.doesNotMatch((await removed(question, 'UTC')).block,/I just harvested|3 days ago/u)
})

test('birth counts combine completed events across sessions and count named twins separately', async t => {
  const now = Date.UTC(2025, 4, 13, 22)
  t.mock.method(Date, 'now', () => now)
  let project, data, add
  const ask = await setup(t, {}, [], (root, key) => {
    project = key
    data = root
    add = (sessionId, text, projectKey = key, eventTime = now - 1000) => {
      const source = saveSource(root, { projectKey, sessionId, messageId: 'line', text,
        role: 'user', sourceKind: 'user', at: eventTime, eventTime, timeZone: 'UTC' })
      assert.ok(grantSourceRecall(root, readSource(root, source.id), projectKey, { remembered: true }))
      return source.id
    }
    add('one', 'My friend Ingrid welcomed a baby named Ivo on April 2.')
    add('twins', "I'm sending gifts to my aunt's twins, Cleo and Dale, who were born in March.")
    add('another', 'My cousin Dana just had a baby girl named Ada in April, and I attended her shower in February.')
    add('couple', 'Our friends Jules and Kai welcomed their first baby, a girl named Bea, on March 27.')
    add('repeat', 'Our friends Jules and Kai had a baby named Bea on March 27.')
    add('older', 'My cousin Eli had a baby named Farah in January.')
    add('planning', 'My friend Gus is expecting a baby named Hugo in June.')
    add('hypothetical', 'If my friend Izzy had a baby named Janet on April 10, I would send a card.')
    add('stranger', 'My favorite radio host welcomed a baby named Leto in April.')
    add('relative-of-contact', "My cousin's neighbor welcomed a baby named Oona in April.")
    add('wish', 'I wish my friend Hal had a baby named Cory in April.')
    add('future-event', 'My friend Wyatt had a baby named Ty on June 1, 2025.')
    add('outside-project', 'My aunt welcomed a baby named Mina in April.', 'other-project')
    add('future-source', 'My cousin Nari had a baby named Opal in April.', key, now + 1000)
  })
  const question = 'How many babies were born to my friends and family in the last three months?'
  const { block, report } = await ask(question, 'UTC', { at: now, id: 'birth-count-query' })
  assert.match(block, /5 recorded births/u)
  for (const name of ['Ivo','Cleo','Dale','Ada','Bea']) assert.match(block, new RegExp(name,'u'))
  assert.doesNotMatch(block, /Farah|Hugo|Janet|Leto|Mina|Opal|Oona|Cory|Ty\b/u)
  assert.equal(report.questions.length, 1)
  assert.equal(report.questions[0].eventCount?.confirmed, 5)
  assert.equal(report.questions[0].eventCount?.complete, true)
  assert.equal(assessAnswerCoverage(report.questions[0], 'Five babies were born.').answerCoverage, 'covered')
  assert.equal(assessAnswerCoverage(report.questions[0], 'There were five recorded births.').answerCoverage, 'covered')
  assert.equal(assessAnswerCoverage(report.questions[0], 'Six babies were born.').answerCoverage, 'unverified')
  assert.equal(report.questions[0].injected.length, 4)
  const twins = report.questions[0].injected.find(hit => hit.text.includes('Cleo and Dale'))
  blockSourceRecall(data, { projectKey: project, sourceRefs: twins.sourceRefs })
  const after = await ask(question, 'UTC', { at: now, id: 'birth-count-after-forget' })
  assert.match(after.block, /3 recorded births/u)
  assert.doesNotMatch(after.block, /Cleo|Dale/u)
  add('conflicting-date', 'My friend Ingrid welcomed a baby named Ivo on January 3.')
  const conflict = await ask(question, 'UTC', { at: now, id: 'birth-count-conflict' })
  assert.equal(conflict.report.questions[0].eventCount?.complete, false)
  assert.equal(conflict.report.questions[0].eventCount?.confirmed, 2)
  assert.match(conflict.block, /separate identity or date unconfirmed/u)
})
