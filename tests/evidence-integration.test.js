import assert from 'node:assert/strict'
import fs, { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'
import { apply } from '../index.js'
import { MemoryStore } from '../host/store.js'
import { projectIdentity } from '../host/paths.js'
import { estimateTokens } from '../host/recall.js'
import { saveSource, readSource } from '../host/capture-journal.js'
import { grantSourceRecall, SourcePassageIndex } from '../host/source-passages.js'
import { recallReportSessionKey } from '../host/recall-reports.js'
import { calendarEventEvidence } from '../host/calendar-recall.js'
import { matchesElapsedAnswer } from '../host/elapsed-recall.js'

async function waitForStart(started, label, timeoutMs = 5000) {
  let timer
  try {
    await Promise.race([started, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} did not start within ${timeoutMs}ms`)), timeoutMs)
    })])
  } finally { clearTimeout(timer) }
}

async function setup(t, records = [], llm, testOptions) {
  const root = mkdtempSync(join(tmpdir(), 'memory-evidence-integration-'))
  const dataDir = join(root, 'data'), cwd = join(root, 'project'), key = projectIdentity(cwd).key
  const store = new MemoryStore({ root: dataDir }).open(), handlers = {}, effects = [], warnings = [], liveSessions = new Map()
  for (const row of records) {
    assert.ok(store.write({ kind: 'fact', scope: 'project', projectKey: key, confidence: .95, ...row }).ok)
    if (row.status === 'superseded') store.update(row.id, { status: row.status }, [{ scope: 'project', projectKey: key }])
  }
  let onRoute
  const routeReady = new Promise(resolve => { onRoute = resolve })
  const webServer = { register(route) { onRoute(route); return () => {} } }
  testOptions?.beforeApply?.({ root, dataDir, cwd, key })
  apply({ sessions: { get: id => liveSessions.get(id) },
    get: name => name === 'webServer' ? webServer : name === 'llm' ? llm : testOptions?.host?.[name],
    on: (name, fn) => { handlers[name] = fn; return () => {} },
    effect: factory => { effects.push(factory); return () => {} }, logger: { warn(...args) { warnings.push(args.join(' ')) }, info() {} },
  }, { dataDir, capture: { enabled: false }, maintenance: { enabled: false }, obsidian: { autoSync: false },
    ...testOptions?.config?.(key) }, testOptions)
  testOptions?.afterApply?.()
  const route = await routeReady
  t.after(() => { for (const effect of effects) { try { effect()?.() } catch {} }; rmSync(root, { recursive: true, force: true }) })
  const panel = async (method, input) => {
    const request = Readable.from([Buffer.from(JSON.stringify({ method, input }))]); request.method = 'POST'
    let response
    await route.handler(request, { writeHead() {}, end(body) { response = JSON.parse(body) } })
    assert.equal(response.ok, true, response.error?.message)
    return response.value
  }
  let turn = 0
  const prepare = async (content, sessionId = 'session-integration', sessionState = {}) => {
    const messages = [{ id: `query-${++turn}`, role: 'user', source: { kind: 'user' }, content }]
    const session = { id: sessionId, header: { cwd }, ...sessionState }
    liveSessions.set(sessionId, session)
    const result = await handlers['agent/pre-step']({
      agent: { session }, messages,
      modelSelection: { provider: 'host-provider', model: 'host-model' },
    }, async () => ({ kind: 'enter', messages }))
    return { result, messages, session,
      block: result.messages.filter(m => m.source?.kind === 'memory').flatMap(m => m.content.map(b => b.text)).join('\n') }
  }
  const ask = async (...args) => (await prepare(...args)).block
  return { root, dataDir, key, cwd, panel, ask, prepare, handlers, store, warnings }
}

function completeAnswer(handlers, session, text, reason = 'completed') {
  handlers['session/event'](session, { type: 'assistant/message', data: { message: {
    role: 'assistant', source: { kind: 'assistant' }, content: [{ type: 'text', text }],
  } } })
  handlers['session/event'](session, { type: 'turn/end', data: { reason: { kind: reason } } })
}

test('personal advice recalls a stated constraint for the subject being discussed', async t => {
  const at = Date.UTC(2026, 10, 25, 13)
  t.mock.method(Date, 'now', () => at)
  const { dataDir, key, panel, prepare } = await setup(t)
  const add = (sessionId, text, projectKey = key, eventTime = at - 1000) => {
    const saved = saveSource(dataDir, { sessionId, projectKey, messageId: 'original',
      role: 'user', sourceKind: 'user', at: eventTime, eventTime, timeZone: 'UTC', text })
    assert.ok(grantSourceRecall(dataDir, readSource(dataDir, saved.id), projectKey))
    return saved.id
  }
  const preference = add('recipe', "I'm trying to reduce my sugar intake, so I've started making my own flavored creamer with almond milk and vanilla extract. Can you suggest a way to store it?")
  add('counterfactual', 'If I made my own creamer, I would use condensed milk.')
  add('someone-else', 'My neighbor makes creamer with caramel syrup.')
  add('different-owner', 'My roommate has a creamer with caramel syrup.')
  add('other-clause', 'I use a whisk every day, she makes creamer with rum.')
  add('unrelated', 'I use chocolate syrup in my coffee.')
  add('older-device', 'I sold my iPhone 11 last year.')
  const device = add('current-device', "I'm looking for a new screen protector to replace the cracked one on my iPhone 13 Pro. Can you recommend one?")
  const walletText = "I'm also looking for a phone wallet case. Can you recommend one?"
  const wallets = new Set([add('wallet', walletText), add('wallet-copy', walletText)])
  add('old-request', "I'm looking for some recommendations for my phone.")
  add('chinese', '我平时用无糖燕麦奶做咖啡奶精。')
  const faucet = add('kitchen', "I'm also having issues with my kitchen faucet, it's been leaking slightly.")
  const utensils = add('utensils', 'I also need to organize my kitchen utensils, can you suggest a good layout?')
  add('foreign-utensils', 'My neighbor needs a different kitchen utensil organizer.')
  add('visit', 'During my previous visit to Denver, I enjoyed the live music scene.')
  add('future-device', 'I use my iPhone 16 with a leather case.', key, at + 5000)
  add('different-project', 'I make creamer with rose syrup.', projectIdentity(join(dataDir, 'other-project')).key)
  const question = 'I was thinking of trying a new coffee creamer recipe. Any recommendations?'
  const turn = await prepare(question, 'advice-from-original')
  assert.match(turn.block, /own flavored creamer with almond milk and vanilla extract/u)
  assert.doesNotMatch(turn.block, /condensed milk|caramel syrup|chocolate syrup|rose syrup|with rum|Can you suggest/u)
  const report = (await panel('stats', { projectKey: key, sessionId: turn.session.id })).lastRecall
  const hits = report.questions.flatMap(slot => slot.injected)
  assert.deepEqual(hits.flatMap(hit => hit.sourceRefs.map(ref => ref.sourceId)), [preference])

  const accessory = await prepare('Can you suggest some useful accessories for my phone?', 'advice-device')
  assert.match(accessory.block, /iPhone 13 Pro/u)
  assert.equal(accessory.block.match(/phone wallet case/gu)?.length, 1)
  assert.doesNotMatch(accessory.block, /iPhone 11|iPhone 16|Can you recommend|some recommendations/u)
  const phoneReport = (await panel('stats', { projectKey: key, sessionId: accessory.session.id })).lastRecall
  const phoneSources = phoneReport.questions.flatMap(slot => slot.injected.flatMap(hit => hit.sourceRefs.map(ref => ref.sourceId)))
  assert.equal(phoneSources.length, 2)
  assert.ok(phoneSources.includes(device))
  assert.ok(phoneSources.some(id => wallets.has(id)))
  const chinese = await prepare('我想做个咖啡奶精，有什么建议？', 'advice-chinese')
  assert.match(chinese.block, /无糖燕麦奶/u)
  const maintenance = await prepare("My kitchen's a bit of a mess. Any tips for keeping it clean?", 'advice-kitchen')
  assert.match(maintenance.block, /kitchen faucet/u)
  assert.match(maintenance.block, /need to organize my kitchen utensils/u)
  assert.doesNotMatch(maintenance.block, /neighbor|suggest a good layout/u)
  const kitchenReport = (await panel('stats', { projectKey: key, sessionId: maintenance.session.id })).lastRecall
  assert.deepEqual(new Set(kitchenReport.questions.flatMap(slot => slot.injected.flatMap(hit =>
    hit.sourceRefs.map(ref => ref.sourceId)))), new Set([faucet, utensils]))
  const trip = await prepare("I'm planning a trip to Denver soon. Any suggestions on what to do there?", 'advice-trip')
  assert.match(trip.block, /previous visit to Denver.*live music scene/u)

  await panel('removeMemory', { id: hits[0].id, scope: 'project', projectKey: key })
  assert.equal((await panel('stats', { projectKey: key, sessionId: turn.session.id })).lastRecall, null)
  assert.doesNotMatch((await prepare(question, 'advice-after-forget')).block, /almond milk|rose syrup/u)
})

test('a compact memory leaves room for different original advice evidence', async t => {
  const at = Date.UTC(2026, 10, 25, 13)
  t.mock.method(Date, 'now', () => at)
  const compact = 'For useful phone accessories, I asked for suggestions for a new screen protector to replace the cracked one on my iPhone 13 Pro.'
  const { dataDir, key, panel, prepare, store } = await setup(t)
  const add = (sessionId, text, projectKey = key, eventTime = at - 1000) => {
    const original = saveSource(dataDir, { sessionId, projectKey, messageId: 'original',
      role: 'user', sourceKind: 'user', at: eventTime, eventTime, timeZone: 'UTC', text })
    assert.ok(grantSourceRecall(dataDir, readSource(dataDir, original.id), projectKey))
    return original.id
  }
  const duplicate = add('before-extraction',
    "I'm looking for a new screen protector to replace the cracked one on my iPhone 13 Pro. Can you recommend one?")
  assert.ok(store.write({ id: 'mem_phone_accessory', kind: 'fact', scope: 'project', projectKey: key,
    content: compact, confidence: .96, evidenceRole: 'user', observedAt: at - 1000,
    sourceRefs: [{ sourceId: duplicate, role: 'user', sourceKind: 'user' }] }).ok)
  const wallet = add('wallet-need', "I'm also looking for a phone wallet case. Can you recommend one?")
  add('other', 'I use a phone case with a folding stand.', projectIdentity(join(dataDir, 'other')).key)
  add('future', 'I use my iPhone 16 in a navy case.', key, at + 1000)
  const prompt = 'Can you suggest some useful accessories for my phone?'
  const turn = await prepare(prompt, 'advice-with-both-layers')
  assert.match(turn.block, /new screen protector/u)
  assert.match(turn.block, /phone wallet case/u)
  assert.equal(turn.block.match(/new screen protector/gu)?.length, 1)
  assert.doesNotMatch(turn.block, /folding stand|iPhone 16|Can you recommend/u)
  const report = (await panel('stats', { projectKey: key, sessionId: turn.session.id })).lastRecall
  const injected = report.questions.flatMap(question => question.injected)
  assert.equal(injected.length, 2)
  assert.ok(injected.some(hit => hit.id === 'mem_phone_accessory'))
  assert.deepEqual(new Set(injected.flatMap(hit => hit.sourceRefs.map(ref => ref.sourceId))), new Set([wallet, duplicate]))
  assert.deepEqual(injected.filter(hit => hit.kind === 'source').flatMap(hit => hit.sourceRefs.map(ref => ref.sourceId)), [wallet])

  const preparePassages = SourcePassageIndex.prototype.prepare
  const delayed = t.mock.method(SourcePassageIndex.prototype, 'prepare', async function (projectKey, signal) {
    await new Promise(resolve => setTimeout(resolve, 330))
    return preparePassages.call(this, projectKey, signal)
  })
  const slowTurn = await prepare(prompt, 'advice-while-originals-prepare')
  assert.match(slowTurn.block, /new screen protector/u)
  assert.match(slowTurn.block, /phone wallet case/u)
  assert.equal(delayed.mock.callCount(), 1)
  delayed.mock.restore()

  const unavailable = t.mock.method(SourcePassageIndex.prototype, 'prepare', async () => false)
  const coldTurn = await prepare(prompt, 'advice-with-unavailable-originals')
  assert.match(coldTurn.block, /new screen protector/u)
  assert.doesNotMatch(coldTurn.block, /wallet case/u)
  assert.equal(unavailable.mock.callCount(), 1)
  unavailable.mock.restore()

  const source = injected.find(hit => hit.kind === 'source')
  await panel('removeMemory', { id: source.id, scope: 'project', projectKey: key })
  assert.equal((await panel('stats', { projectKey: key, sessionId: turn.session.id })).lastRecall, null)
  const next = await prepare(prompt, 'advice-after-forget-original')
  assert.match(next.block, /new screen protector/u)
  assert.doesNotMatch(next.block, /wallet case/u)
})

test('organization advice recalls the same item from adjacent sentences in one user message', async t => {
  const at = Date.UTC(2026, 10, 25, 13)
  t.mock.method(Date, 'now', () => at)
  const { dataDir, key, panel, prepare } = await setup(t)
  const add = (sessionId, text, projectKey = key, eventTime = at - 1000, messageId = 'original') => {
    const saved = saveSource(dataDir, { sessionId, projectKey, messageId, text,
      role: 'user', sourceKind: 'user', at: eventTime, eventTime, timeZone: 'UTC' })
    assert.ok(grantSourceRecall(dataDir, readSource(dataDir, saved.id), projectKey))
    return saved.id
  }
  const prompt = 'I also need help organizing my kitchen utensils, can you suggest ways to use my utensil holder?'
  const statement = 'I recently bought a new utensil holder to keep countertops clutter-free.'
  const faucet = add('faucet', "I'm also having issues with my kitchen faucet, it's been leaking slightly.")
  const original = add('holder', prompt + ' ' + statement)
  add('scope', prompt + ' I bought a camera bag to keep my lenses tidy.')
  add('other-actor', prompt + ' My neighbor bought a utensil holder to keep her counters tidy.')
  add('copied', 'I spent the morning reading.\n> ' + prompt + ' I bought a utensil holder to keep towels organized.')
  add('beneficiary', prompt + ' I bought a utensil holder to keep her cabinets organized.')
  add('hypothetical', prompt + ' I would buy a utensil holder to keep the rack organized.')
  add('hypothetical-topic', 'I might organize my kitchen some day, can you suggest ways to use my utensil holder? I bought a utensil holder to keep the wardrobe organized.')
  add('quoted-topic', 'She said she was organizing my kitchen, can you suggest ways to use my utensil holder? I bought a utensil holder to keep necklaces organized.')
  add('unrelated-request', 'I write about my kitchen, can you recommend a brand for my utensil holder? I bought a utensil holder to keep the island clean.')
  add('split', 'I want to tidy my kitchen, can you suggest ways to use my cutlery tray?', key, at - 1000, 'first')
  add('split', 'I bought a cutlery tray to keep the drawer organized.', key, at - 1000, 'second')
  add('future', prompt + ' I bought a utensil holder to keep my windowsill tidy.', key, at + 1000)
  add('foreign', prompt + ' I bought a utensil holder to keep my table tidy.', projectIdentity(join(dataDir, 'other')).key)
  const question = "My kitchen's becoming a bit of a mess. Any tips for keeping it clean?"
  const turn = await prepare(question, 'organization-advice')
  assert.ok(turn.block.includes(statement))
  assert.match(turn.block, /kitchen faucet/u)
  assert.doesNotMatch(turn.block, /can you suggest|need help organizing|camera bag|neighbor|towels|cabinet|rack|wardrobe|necklace|island|cutlery tray|windowsill|table tidy/u)
  const report = (await panel('stats', { projectKey: key, sessionId: turn.session.id })).lastRecall
  const hits = report.questions.flatMap(slot => slot.injected)
  assert.deepEqual(new Set(hits.flatMap(hit => hit.sourceRefs.map(ref => ref.sourceId))), new Set([faucet, original]))
  const holder = hits.find(hit => hit.sourceRefs.some(ref => ref.sourceId === original))
  await panel('removeMemory', { id: holder.id, scope: 'project', projectKey: key })
  assert.doesNotMatch((await prepare(question, 'organization-after-forget')).block, /utensil holder|cutlery tray/u)
})

test('explicit units distinguish display dimensions, network speeds, and storage from other properties', async t => {
  const { dataDir, key, cwd, panel, prepare, handlers } = await setup(t)
  const other = projectIdentity(join(cwd, '..', 'another', 'project')).key
  const add = (entry, text, projectKey = key) => {
    const saved = saveSource(dataDir, { sessionId: entry, messageId: 'facts', text, projectKey, role: 'user', sourceKind: 'user' })
    assert.ok(grantSourceRecall(dataDir, readSource(dataDir, saved.id), projectKey, { remembered: true }))
    return saved.id
  }
  const capacity = add('capacity', 'The latest report confirms the Spruce render cache uses 384 MiB.')
  add('port', 'The Spruce render cache is available on port 7447.')
  const screen = add('screen', 'I set up my new Orion 52-inch 4K TV.')
  add('memory', 'My new Orion TV has 16 GB of memory.')
  const speed = add('speed', 'My Cedar internet plan provides a download speed of 500 Mbps.')
  add('upload', 'The upload speed on my Cedar internet plan is 38 Mbps. The download speed was not recorded.')
  add('cost', 'My Cedar internet plan bills 500 dollars each year.')
  const reduction = add('discount', 'I received a 17% discount on my first purchase from BrightPeak clothing.')
  add('discount-threshold', 'BrightPeak clothing asks customers to spend $80 to qualify for a discount.')
  add('wrong-project', 'My new Orion TV is 92 inches.', other)

  const cases = [
    ['What is the capacity of the Spruce render cache?', capacity, /384 MiB/u, /7447/u],
    ['What size is my new Orion TV?', screen, /52-inch/u, /16 GB|92 inches/u],
    ['What is the download speed of the Cedar internet plan?', speed, /500 Mbps/u, /500 dollars|38 Mbps/u],
    ['What was the discount I got on my first purchase from BrightPeak clothing?', reduction, /17% discount/u, /\$80/u],
  ]
  const reports = []
  for (const [query, source, expected, excluded] of cases) {
    const turn = await prepare(query, 'property-' + source)
    const report = (await panel('stats', { projectKey: key, sessionId: turn.session.id })).lastRecall
    reports.push({ source, block: turn.block, report, expected, excluded, session: turn.session })
  }
  for (const { source, block, report, expected, excluded } of reports) {
    assert.match(block, expected)
    assert.doesNotMatch(block, excluded)
    assert.deepEqual(report.questions[0].injected.flatMap(hit => hit.sourceRefs.map(ref => ref.sourceId)), [source])
  }
  for (const [index, answer] of [[0, 'The Spruce render cache uses 384 MB.'],
    [1, 'The Orion TV is 52 centimeters and has a 4K screen.'],
    [2, 'The Cedar internet plan downloads at 500 MB/s.']]) {
    const { session } = reports[index]
    completeAnswer(handlers, session, answer)
    const { lastRecall } = await panel('stats', { projectKey: key, sessionId: session.id })
    assert.equal(lastRecall.questions[0].answerCoverage, 'unverified', answer)
  }
  const equivalent = await prepare(cases[2][0], 'equivalent-download')
  completeAnswer(handlers, equivalent.session, 'The Cedar download speed is 0.5 Gbps.')
  assert.equal((await panel('stats', { projectKey: key, sessionId: equivalent.session.id })).lastRecall.questions[0].answerCoverage, 'covered')
  const archived = reports[1]
  const evidence = archived.report.questions[0].injected[0]
  assert.equal((await panel('removeMemory', { scope: 'project', projectKey: key, id: evidence.id })).status, 'deleted')
  assert.equal((await panel('stats', { projectKey: key, sessionId: archived.session.id })).lastRecall, null)
  assert.equal((await prepare(cases[1][0], 'screen-after-forget')).block, '')
})

test('a following speed update stays attached to the explicitly named internet connection', async t => {
  const { dataDir, key, panel, prepare } = await setup(t)
  const add = (sessionId, text) => {
    const saved = saveSource(dataDir, { sessionId, messageId: 'facts', text, projectKey: key, role: 'user', sourceKind: 'user' })
    assert.ok(grantSourceRecall(dataDir, readSource(dataDir, saved.id), key, { remembered: true }))
    return saved.id
  }
  const support = 'My internet speed has been steady lately. I upgraded to 640 Mbps about two weeks ago.'
  const original = add('upgrade', support + ' Do you have ideas for improving Wi-Fi coverage?')
  add('different-device', 'My new internet plan has been stable. I upgraded my external disk to 950 MB/s.')
  add('different-context', 'My internet speed is good. My external disk measures 970 MB/s.')
  add('prospective', 'I am planning to increase my internet speed to 900 Mbps next year.')
  add('other-turn', 'I upgraded to 880 Mbps yesterday.')
  const query = 'What speed is my new internet plan?'
  const turn = await prepare(query, 'internet-scope')
  assert.ok(turn.block.includes(support))
  assert.doesNotMatch(turn.block, /950|970|900|880|coverage/u)
  const { lastRecall } = await panel('stats', { projectKey: key, sessionId: turn.session.id })
  const evidence = lastRecall.questions[0].injected[0]
  assert.equal(evidence.sourceRefs[0].sourceId, original)
  assert.ok(evidence.text.includes(support))
  assert.equal((await panel('removeMemory', { scope: 'project', projectKey: key, id: evidence.id })).status, 'deleted')
  assert.equal((await prepare(query, 'internet-after-forget')).block, '')
})

test('named counters use separate evidence and retain a verified same-session subject reference', async t => {
  const { dataDir, cwd, key, panel, prepare, handlers } = await setup(t)
  const sibling = projectIdentity(join(cwd, '..', 'other', 'project')).key
  const at = Date.UTC(2026, 5, 8)
  const add = (sessionId, eventSeq, text, projectKey = key) => {
    const { id } = saveSource(dataDir, { sessionId, messageId: String(eventSeq), text, projectKey,
      role: 'user', sourceKind: 'user', at, eventTime: at, timeZone: 'UTC', eventSeq })
    assert.ok(grantSourceRecall(dataDir, readSource(dataDir, id), projectKey))
    return id
  }
  const live = add('live-session', 1, 'My recent Facebook Live session on garden tools got 12 comments.')
  const anchor = add('video-session', 2, 'I am updating my YouTube channel. My most popular video is about repairing a hinge.')
  add('video-session', 4, 'I am also working on a new title for the tutorial.')
  const video = add('video-session', 6, 'My most popular video has 13 comments.')
  add('wrong-metric', 1, 'My recent Facebook Live session had 930 views.')
  add('not-exact', 1, 'My recent Facebook Live session had between 12 and 30 comments.')
  add('future-value', 1, 'I hope my most popular YouTube video will receive 99 comments.')
  add('other-thread', 1, 'My most popular video received 31 comments.')
  add('someone-else', 1, "My friend's most popular YouTube video had 77 comments.")
  add('same-name-foreign', 1, 'My most popular YouTube video got 84 comments.', sibling)
  add('unranked-tiktok', 1, 'My TikTok video has 523 views.')
  const directRank = add('ranked-youtube', 1, 'My most popular YouTube video has 600 views.')
  const q = 'What is the total number of comments on my recent Facebook Live session and my most popular YouTube video?'
  const turn = await prepare('Answer using memory only. Give each known count and the total, or explain which item is missing. Do not use tools. ' + q, 'counters-all')
  assert.match(turn.block, /12 \+ 13 = 25 comments/u)
  assert.match(turn.block, /most popular video is about repairing a hinge/u)
  assert.doesNotMatch(turn.block, /930|30 comments|99 comments|31 comments|77 comments|84 comments/u)
  completeAnswer(handlers, turn.session, 'The recent Facebook Live session got 12 comments. The most popular YouTube video had 13 comments. The total is 25 comments.')
  const read = id => panel('stats', { projectKey: key, sessionId: id }).then(result => result.lastRecall)
  const report = await read(turn.session.id)
  assert.equal(report.quantityCheck.result, '25')
  assert.deepEqual(report.questions.map(slot => slot.answerCoverage), ['covered', 'covered'])
  assert.deepEqual(report.questions.map(slot => slot.injected.flatMap(proof => proof.sourceRefs.map(ref => ref.sourceId))), [[live], [anchor, video]])

  const natural = await prepare(q, 'counters-natural-answer')
  const total = 'The total number of comments on your recent Facebook Live session and your most popular YouTube video is 25. '
  completeAnswer(handlers, natural.session, total + 'This is 12 comments for the Facebook Live session and 13 comments for the most popular YouTube video.')
  const naturalReport = await read(natural.session.id)
  assert.deepEqual(naturalReport.questions.map(slot => slot.answerCoverage), ['covered', 'covered'])
  assert.equal(naturalReport.quantityCheck.answerCoverage, 'covered')
  const swapped = await prepare(q, 'counters-swapped-inline')
  completeAnswer(handlers, swapped.session, total + 'This is 13 comments for the Facebook Live session and 12 comments for the most popular YouTube video.')
  const swappedReport = await read(swapped.session.id)
  assert.deepEqual(swappedReport.questions.map(slot => slot.answerCoverage), ['unverified', 'unverified'])
  assert.equal(swappedReport.quantityCheck.answerCoverage, 'unverified')

  const referenced = report.questions[1].injected.find(proof => proof.sourceRefs[0].sourceId === anchor)
  assert.equal((await panel('removeMemory', { projectKey: key, scope: 'project', id: referenced.id })).status, 'deleted')
  assert.equal(await read(turn.session.id), null)
  const incomplete = await prepare(q, 'counters-incomplete')
  assert.match(incomplete.block, /\nTotal cannot be determined[^\n]*\n- recent facebook live session · 12 comments/u)
  assert.doesNotMatch(incomplete.block, /25 comments|13 comments|31 comments/u)
  assert.equal((await read(incomplete.session.id)).questions[1].injected.length, 0)
  completeAnswer(handlers, incomplete.session, 'The total number of comments on my recent Facebook Live session is 12. The overall total cannot be determined.')
  assert.equal((await read(incomplete.session.id)).quantityCheck.answerCoverage, 'no-evidence')
  const fabricated = await prepare(q, 'counters-incomplete-answer')
  completeAnswer(handlers, fabricated.session, 'The total is 12 comments.')
  assert.equal((await read(fabricated.session.id)).quantityCheck.answerCoverage, 'unverified')
  add('only-third-party', 1, "My friend's most popular Twitch video got 73 comments.")
  const absent = await prepare('What is the total number of comments on my latest Bilibili clip and my most popular Twitch video?', 'wrong-owner-only')
  assert.equal(absent.block, '')
  assert.deepEqual((await read(absent.session.id)).questions.map(item => item.injected.length), [0, 0])
  const rankQuery = 'What is the total number of views on my most popular videos on YouTube and TikTok?'
  const popularity = await prepare(rankQuery, 'rank-not-estimated')
  assert.match(popularity.block, /600 views/u)
  assert.doesNotMatch(popularity.block, /523 views|1123/u)
  const rankReport = await read(popularity.session.id)
  assert.equal(rankReport.quantityCheck.result, null)
  const current = rankReport.questions[0].injected.find(proof => proof.sourceRefs[0].sourceId === directRank)
  await panel('removeMemory', { projectKey: key, scope: 'project', id: current.id })

  const viewed = add('ranking-history', 1, 'My tutorial about differential gearboxes on YouTube had 542 views.')
  add('ranking-history', 2, 'I am posting my bicycle maintenance tutorial on YouTube, which is my most popular video.')
  assert.doesNotMatch((await prepare(rankQuery, 'wrong-ranked-video')).block, /542 views/u)
  const ranked = add('ranking-history', 3, 'I am sharing my differential gearboxes tutorial on YouTube, which is my most popular video.')
  const linked = await prepare(rankQuery, 'later-rank-proof')
  assert.match(linked.block, /542 views/u)
  assert.doesNotMatch(linked.block, /523 views/u)
  assert.match(linked.block, /Evidence for the same item above \(most popular youtube video\)\n- \[Original\][^\n]+\n- \[Original\][^\n]+542 views/u)
  assert.deepEqual((await read(linked.session.id)).questions[0].injected.flatMap(row => row.sourceRefs.map(ref => ref.sourceId)), [ranked, viewed])
  completeAnswer(handlers, linked.session, 'The total number of views on your most popular videos on YouTube is 542. The TikTok count is missing. The overall total cannot be determined.')
  const rankedAnswer = await read(linked.session.id)
  assert.deepEqual(rankedAnswer.questions.map(item => item.answerCoverage), ['covered', 'no-evidence'])
  assert.equal(rankedAnswer.quantityCheck.answerCoverage, 'no-evidence')
  const falseTotal = await prepare(rankQuery, 'wrong-platform-total')
  completeAnswer(handlers, falseTotal.session, 'The total number of views on your most popular videos on YouTube and TikTok is 542.')
  assert.equal((await read(falseTotal.session.id)).quantityCheck.answerCoverage, 'unverified')
  add('ranking-history', 4, 'I am sharing my bicycle maintenance tutorial on YouTube, which is my most popular video.')
  assert.doesNotMatch((await prepare(rankQuery, 'ranking-changed')).block, /542 views/u)
})

test('different counters share their named scope without borrowing a different unit or record', async t => {
  const { dataDir, key, panel, prepare, handlers, store } = await setup(t)
  const add = (sessionId, text) => {
    const { id } = saveSource(dataDir, { sessionId, messageId: 'counter', text, projectKey: key, role: 'user', sourceKind: 'user' })
    assert.ok(grantSourceRecall(dataDir, readSource(dataDir, id), key, { remembered: true }))
    return id
  }
  const goals = add('goals', 'I played in the Juniper indoor soccer league and scored 4 goals.')
  const assists = add('assists', 'I recorded 7 assists in the Juniper indoor soccer league.')
  add('another-league', 'I scored 51 goals in the Rowan indoor soccer league.')
  add('combined-only', 'I recorded 80 goals and assists combined in the Juniper indoor soccer league.')
  add('stats-on-teammates', 'My teammate scored 91 goals in the Juniper indoor soccer league.')
  add('team-totals', 'My team in the Juniper indoor soccer league scored 78 goals.')
  const q = 'What is the total number of goals and assists I have in the Juniper indoor soccer league?'
  const turn = await prepare(q, 'goals-and-assists')
  assert.match(turn.block, /4 \+ 7 = 11/u)
  assert.doesNotMatch(turn.block, /51 goals|78 goals|80 goals|91 goals/u)
  completeAnswer(handlers, turn.session, 'In the Juniper indoor soccer league, you had 7 goals and 4 assists. The total is 11.')
  const { lastRecall } = await panel('stats', { projectKey: key, sessionId: turn.session.id })
  assert.deepEqual(lastRecall.questions.map(slot => slot.injected.flatMap(proof => proof.sourceRefs.map(ref => ref.sourceId))), [[goals], [assists]])
  assert.deepEqual(lastRecall.questions.map(slot => slot.answerCoverage), ['unverified', 'unverified'])
  assert.equal(lastRecall.quantityCheck.answerCoverage, 'unverified')
  add('disputed-value', 'I recorded 14 assists in the Juniper indoor soccer league.')
  const dispute = await prepare(q, 'disputed-counters')
  assert.doesNotMatch(dispute.block, /(?:7|14) assists|= 11|= 18/u)
  add('cn-live', '青松直播收到十二条评论。')
  add('cn-video', '橘湾短片有七条评论。')
  const chinese = await prepare('青松直播和橘湾短片一共多少条评论？', 'chinese-counters')
  assert.match(chinese.block, /12 \+ 7 = 19条评论/u)
  completeAnswer(handlers, chinese.session, '青松直播有12条评论，橘湾短片有7条评论，合计19条评论。')
  const verifiedChinese = (await panel('stats', { projectKey: key, sessionId: chinese.session.id })).lastRecall
  assert.equal(verifiedChinese.quantityCheck.answerCoverage, 'covered')
  for (const text of ['The Pine dashboard recorded 6 requests.', 'The Maple dashboard recorded 9 requests.']) {
    assert.ok(store.write({ scope: 'project', projectKey: key, content: text, kind: 'fact', confidence: .95 }).ok)
  }
  const older = await prepare('What is the total number of requests on the Pine dashboard and Maple dashboard?', 'older-standalone-counts')
  assert.match(older.block, /6 \+ 9 = 15 requests/u)
  const oldReport = (await panel('stats', { projectKey: key, sessionId: older.session.id })).lastRecall
  assert.deepEqual(oldReport.questions.map(item => item.injected[0].kind), ['fact', 'fact'])
})

test('a delivery interval links both authorized dates for the same named item', async t => {
  const { dataDir, cwd, key, panel, prepare, handlers, warnings } = await setup(t)
  const foreignCwd = join(cwd, '..', 'another', 'project')
  const foreign = projectIdentity(foreignCwd).key
  const grant = (sessionId, text, projectKey = key) => {
    const at = Date.UTC(2026, 3, 30)
    const entry = saveSource(dataDir, { projectKey, sessionId, messageId: 'statement', text, at, eventTime: at,
      timeZone: 'UTC', role: 'user', sourceKind: 'user' })
    assert.ok(grantSourceRecall(dataDir, readSource(dataDir, entry.id), projectKey, { remembered: true }))
    return entry.id
  }
  const order = grant('checkout', 'I also ordered a new Larch tablet case online on April 11th, after I spilled coffee.')
  const arrival = grant('unboxing', 'I just started using my new Larch tablet case and it feels sturdy. It arrived on April 16th.')
  grant('planning', 'I expect the Larch tablet case to arrive on April 14th.')
  grant('someone-else', 'My sister bought the Larch tablet case on April 4th.')
  grant('different-product', 'I received the Larch tablet case charger on April 12th.')
  grant('broken-reference', 'My Larch tablet case feels sturdy. My tablet stand looks different. It arrived on April 18th.')
  grant('shipped', 'My Larch tablet case shipped on April 13th.')
  grant('approximate', 'My Larch tablet case arrived around April 21st.')
  grant('neighboring-date', 'I ordered a Larch tablet case that was featured on April 10th.')
  grant('other-checkout', 'I ordered a Larch tablet case on April 2nd.', foreign)
  const abroad = grant('other-unboxing', 'I received the Larch tablet case on April 9th.', foreign)
  const question = 'How many days did it take for my Larch tablet case to arrive after I ordered it?'
  const main = await prepare(question, 'wait-main')
  assert.match(main.block, /2026-04-16 − 2026-04-11 = 5 days/u, warnings.join('\n'))
  assert.match(main.block, /ordered a new Larch tablet case online on April 11th/u)
  assert.match(main.block, /Larch tablet case and it feels sturdy\. It arrived on April 16th/u)
  assert.doesNotMatch(main.block, /April (?:2nd|4th|9th|10th|12th|13th|14th|18th|21st)|coffee/u)
  completeAnswer(handlers, main.session, 'The Larch tablet case took five days to arrive, from April 11th to April 16th.')
  const stats = (sessionId, projectKey = key) => panel('stats', { sessionId, projectKey }).then(row => row.lastRecall)
  const report = (await stats(main.session.id)).questions[0]
  assert.equal(report.answerCoverage, 'covered')
  assert.deepEqual(report.injected.flatMap(hit => hit.sourceRefs.map(ref => ref.sourceId)), [order, arrival])
  const other = await prepare(question, 'wait-other', { header: { cwd: foreignCwd } })
  assert.match(other.block, /2026-04-09 − 2026-04-02 = 7 days/u)
  completeAnswer(handlers, other.session, 'Seven days.')
  assert.ok((await stats(other.session.id, foreign)).questions[0].injected.some(hit =>
    hit.sourceRefs.some(ref => ref.sourceId === abroad)))
  const bad = await prepare(question, 'answer-reversed')
  completeAnswer(handlers, bad.session, 'It took five days from April 16th to April 11th.')
  assert.equal((await stats(bad.session.id)).questions[0].answerCoverage, 'unverified')
  grant('repeat-order', 'I ordered the Larch tablet case again on April 12th.')
  const disputed = await prepare(question, 'delivery-disputed')
  assert.equal(disputed.block, '')
  assert.equal((await stats(disputed.session.id)).questions[0].injected.length, 0)
  const target = report.injected.find(hit => hit.sourceRefs[0].sourceId === arrival)
  assert.equal((await panel('removeMemory', { id: target.id, scope: 'project', projectKey: key })).status, 'deleted')
  assert.equal(await stats(main.session.id), null)
  assert.ok(await stats(other.session.id, foreign))
  assert.equal((await prepare(question, 'delivery-forgotten')).block, '')
  grant('receipt-a', 'I ordered the Hazel reading lamp on April 2nd, order #HZ-12.')
  grant('receipt-b', 'I received the Hazel reading lamp on April 9th, order #HZ-29.')
  const differentOrder = await prepare('How many days did it take for my Hazel reading lamp to arrive after I ordered it?', 'different-orders')
  assert.equal(differentOrder.block, '')
  grant('voided-order', 'I ordered my Alder keyboard on April 2nd.')
  grant('cancel-confirmed', 'I cancelled my order for the Alder keyboard.')
  grant('replacement-arrival', 'I received the Alder keyboard on April 9th.')
  const cancelled = await prepare('How many days did it take for my Alder keyboard to arrive after I ordered it?', 'cancelled-order')
  assert.equal(cancelled.block, '')
  const bought = grant('cn-purchase', '我在4月7日买了曜石读卡器。')
  const got = grant('cn-arrival', '我在4月12日收到了曜石读卡器。')
  const chinese = await prepare('我买了曜石读卡器后，等了几天才收到？', 'cn-delivery')
  assert.match(chinese.block, /2026-04-12 − 2026-04-07 = 5 天/u)
  completeAnswer(handlers, chinese.session, '从4月7日到4月12日，等了五天。')
  const cnReport = (await stats(chinese.session.id)).questions[0]
  assert.equal(cnReport.answerCoverage, 'covered')
  assert.deepEqual(cnReport.injected.flatMap(hit => hit.sourceRefs.map(ref => ref.sourceId)), [bought, got])
})

test('elapsed date questions preserve weeks and separate starting a book from finishing it', async t => {
  const { dataDir, key, prepare, panel, handlers } = await setup(t)
  const store = (sessionId, text, eventTime) => {
    const saved = saveSource(dataDir, { projectKey: key, sessionId, messageId: 'logged', text, at: eventTime, eventTime, timeZone: 'UTC',
      role: 'user', sourceKind: 'user' })
    assert.ok(grantSourceRecall(dataDir, readSource(dataDir, saved.id), key))
    return saved.id
  }
  const day = date => Date.parse('2026-05-' + date + 'T02:00:00Z')
  const purchase = store('bought', 'I just bought a new Alder racket online today, and I plan to try it out this Saturday.', day('05'))
  const delivery = store('received', 'I just received my new Alder racket today.', day('12'))
  store('quote', '“I bought an Alder racket on 2026-05-04.”', day('05'))
  const started = store('opened-book', 'I just started “River Steps” by Mara Vale today.', day('03'))
  const finished = store('closed-book', 'I just finished a historical novel, “River Steps” by Mara Vale, today.', day('19'))
  const described = store('described-item', "My satchel looks sturdy - it's got room for my camera, spare batteries, and other gear. I've been using it all week. I bought it on 5/17.", day('22'))
  const delivered = store('described-arrival', 'I received my camera satchel on 5/21.', day('22'))
  const orderedSameDay = store('same-day-order', 'I ordered a Hazel hub on May 18th.', day('20'))
  const arrivedSameDay = store('same-day-arrival', 'I received the Hazel hub on May 18th.', day('20'))
  store('mixed-items', 'My satchel looks sturdy. My new case has room for my camera. I bought it on May 2nd.', day('20'))
  store('wrong-title', 'I finished reading “River Steps Workbook” by Mara Vale on May 17th.', day('20'))
  store('wrong-author', 'I finished reading “River Steps” by Tomas Reed today.', day('21'))
  for (const [sessionId, query, math, answer, ids] of [
    ['lead-time', 'How many weeks passed between the day I bought my Alder racket and the day I received it?', /7 days = 1 week/u,
      '7 days or 1 week passed between the day you bought the Alder racket on 2026-05-05 and received it on 2026-05-12.', [purchase, delivery]],
    ['book-span', 'How many days did it take me to finish “River Steps” by Mara Vale?', /= 16 days/u, 'It took 16 days.', [started, finished]],
    ['described-span', 'How many days did it take for my camera satchel to arrive after I bought it?', /= 4 days/u,
      'It took four days, from 5/17 to 5/21.', [described, delivered]],
    ['same-day', 'How many days did it take for my Hazel hub to arrive after I ordered it?', /= 0 days/u,
      'It arrived the same day.', [orderedSameDay, arrivedSameDay]],
  ]) {
    const turn = await prepare(query, sessionId)
    assert.match(turn.block, math)
    completeAnswer(handlers, turn.session, answer)
    const item = (await panel('stats', { sessionId, projectKey: key })).lastRecall.questions[0]
    assert.deepEqual(item.injected.flatMap(hit => hit.sourceRefs.map(ref => ref.sourceId)), ids)
    assert.equal(item.answerCoverage, 'covered')
  }
  store('ordered-ambiguous', 'I ordered the Bluebird turntable on 5/4.', day('10'))
  store('delivered-ambiguous', 'I received the Bluebird turntable on May 10th.', day('10'))
  const ambiguous = await prepare('How many days did it take for my Bluebird turntable to arrive after I ordered it?', 'ambiguous-month-day')
  assert.equal(ambiguous.block, '')
})

test('recall reports follow the active session and project through the completed turn', async t => {
  const otherCwd = join(tmpdir(), 'dsh-memory-report-other-project')
  const otherKey = projectIdentity(otherCwd).key
  const { key, cwd, panel, prepare, handlers } = await setup(t, [
    { id: 'mem_report_a', content: '青岚快照每天04:20执行，保留47天，因为要避开每日导入的磁盘峰值。' },
    { id: 'mem_report_b', projectKey: otherKey, content: '赤潮快照每天06:15执行，保留63天，因为要避开早间归档。' },
  ])
  const questionA = '青岚快照每天几点执行，保留多久，为什么改时间？'
  const questionB = '赤潮快照每天几点执行，保留多久，为什么改时间？'
  const a = await prepare(questionA, 'session-a')
  const b = await prepare(questionB, 'session-b', { header: { cwd: otherCwd } })
  const c = await prepare(questionA, 'session-c')
  const aSession = { id: 'session-a', header: { cwd } }
  const bSession = { id: 'session-b', header: { cwd: otherCwd } }
  completeAnswer(handlers, aSession, '青岚快照每天04:20执行，保留47天，因为要避开每日导入的磁盘峰值。')
  completeAnswer(handlers, bSession, '赤潮快照每天06:15执行，保留63天，因为要避开早间归档。')
  completeAnswer(handlers, c.session, '青岚快照每天04:20执行。')

  const reportA = (await panel('stats', { sessionId: 'session-a', scope: 'project', projectKey: key })).lastRecall
  const reportB = (await panel('stats', { sessionId: 'session-b', scope: 'project', projectKey: otherKey })).lastRecall
  assert.equal(reportA.projectKey, key)
  assert.equal(reportB.projectKey, otherKey)
  assert.equal(reportA.turnKey, 'id:' + a.messages[0].id)
  assert.equal(reportB.turnKey, 'id:' + b.messages[0].id)
  assert.equal(reportA.outcome, 'completed')
  assert.equal(reportA.questions.length, 3)
  assert.ok(reportA.questions.every(question => question.answerCoverage === 'covered'))
  assert.ok(reportA.questions.every(question => question.answerExcerpt !== null))
  assert.ok(reportA.questions.some(question => question.injected.some(evidence => evidence.text.includes('04:20'))))
  assert.equal(reportB.questions.filter(question => question.answerCoverage === 'covered').length, 3)
  const reportC = (await panel('stats', { sessionId: 'session-c', scope: 'project', projectKey: key })).lastRecall
  assert.equal(reportC.questions.filter(question => question.answerCoverage === 'covered').length, 1)
  assert.equal(reportC.questions.filter(question => question.answerCoverage === 'unverified').length, 2)
  assert.equal((await panel('stats', { scope: 'project', projectKey: key })).lastRecall, null)
})

test('activation leaves the existing knowledge directory for background verification and the first turn gets its note', async t => {
  const originalOpen = fs.openSync
  let openedAtActivation = 0, initialOpens = -1
  const stopProbe = () => { fs.openSync = originalOpen; syncBuiltinESMExports() }
  t.after(stopProbe)
  const { ask } = await setup(t, [], undefined, { semantic: { enabled: false }, beforeApply({ dataDir, key }) {
    const dir = join(dataDir, 'knowledge')
    mkdirSync(dir, { recursive: true })
    for (let i = 0; i < 80; i++) writeFileSync(join(dir, `${i}.md`), [
      '---', 'dsh_knowledge: true', 'scope: project', `projectKey: ${key}`, '---',
      i === 79 ? '# 望潮快照' : '# Archive attachment',
      i === 79 ? '望潮快照每天 03:47 执行。' : 'Equipment inventory is archived separately.', '',
    ].join('\n'))
    const physicalDirectory = fs.realpathSync(dir)
    fs.openSync = (file, ...rest) => {
      if (typeof file === 'string' && file.startsWith(physicalDirectory + sep) && file.endsWith('.md')) openedAtActivation++
      return originalOpen(file, ...rest)
    }
    syncBuiltinESMExports()
  }, afterApply() { initialOpens = openedAtActivation; stopProbe() } })
  assert.equal(initialOpens, 0)
  assert.match(await ask('望潮快照每天几点执行？', 'first-knowledge-turn'), /03:47/u)
})

test('retention and reason inherit the named backup, and reason coverage requires a specific phrase', async t => {
  const fog = '雾杉备份每天03:42执行，保留61天，为了避开每日导入的磁盘峰值。'
  const whale = '砂鲸快照每天05:10执行，保留90天，因为要避开批量校验的 CPU 峰值。'
  const { key, prepare, panel, handlers } = await setup(t, [
    { id: 'mem_fog_backup', content: fog },
    { id: 'mem_whale_snapshot', content: whale },
  ])
  const queryFog = '雾杉备份每天几点执行、记录保留多久、为什么改时间？请按原话逐项回答。不要保存本轮问答。'
  const preparedFog = await prepare(queryFog, 'session-fog-backup')
  const pendingFog = (await panel('stats', { sessionId: 'session-fog-backup', scope: 'project', projectKey: key })).lastRecall
  assert.equal(pendingFog.total, 3)
  assert.deepEqual(pendingFog.questions.map(question => question.detail), ['clock', 'retention', 'reason'])
  assert.ok(pendingFog.questions[1].injected.some(evidence => evidence.id === 'mem_fog_backup'))
  assert.ok(pendingFog.questions[2].injected.some(evidence => evidence.id === 'mem_fog_backup'))
  assert.ok(pendingFog.questions.every(question => question.injected.every(evidence => evidence.id !== 'mem_whale_snapshot')))
  completeAnswer(handlers, preparedFog.session, '雾杉备份每天03:42执行，保留61天，因为要避开巡检占用的磁盘峰值。')
  const reportFog = (await panel('stats', { sessionId: 'session-fog-backup', scope: 'project', projectKey: key })).lastRecall
  assert.deepEqual(reportFog.questions.map(question => question.answerCoverage), ['covered', 'covered', 'unverified'])

  const preparedFogExact = await prepare(queryFog, 'session-fog-backup-exact')
  completeAnswer(handlers, preparedFogExact.session, '雾杉备份每天03:42执行，保留61天，因为要避开每日导入的磁盘峰值。')
  const reportFogExact = (await panel('stats', { sessionId: 'session-fog-backup-exact', scope: 'project', projectKey: key })).lastRecall
  assert.deepEqual(reportFogExact.questions.map(question => question.answerCoverage), ['covered', 'covered', 'covered'])

  const queryWhale = '砂鲸快照每天几点执行、记录保留多久、为什么改时间？请按原话逐项回答。不要保存本轮问答。'
  const preparedWhale = await prepare(queryWhale, 'session-whale-snapshot')
  const pendingWhale = (await panel('stats', { sessionId: 'session-whale-snapshot', scope: 'project', projectKey: key })).lastRecall
  assert.equal(pendingWhale.total, 3)
  assert.deepEqual(pendingWhale.questions.map(question => question.detail), ['clock', 'retention', 'reason'])
  assert.ok(pendingWhale.questions[1].injected.some(evidence => evidence.id === 'mem_whale_snapshot'))
  assert.ok(pendingWhale.questions[2].injected.some(evidence => evidence.id === 'mem_whale_snapshot'))
  assert.ok(pendingWhale.questions.every(question => question.injected.every(evidence => evidence.id !== 'mem_fog_backup')))
  completeAnswer(handlers, preparedWhale.session, whale)
  const reportWhale = (await panel('stats', { sessionId: 'session-whale-snapshot', scope: 'project', projectKey: key })).lastRecall
  assert.deepEqual(reportWhale.questions.map(question => question.answerCoverage), ['covered', 'covered', 'covered'])
})

test('clock and retention answer coverage compares complete values', async t => {
  const { key, prepare, panel, handlers } = await setup(t, [
    { id: 'mem_exact_backup_values', content: '雾杉备份每天02:37执行，保留41天。' },
  ])
  const query = '雾杉备份每天几点执行，记录保留多久？'
  const mismatched = await prepare(query, 'session-mismatched-values')
  completeAnswer(handlers, mismatched.session, '雾杉备份每天12:37执行，保留141天。')
  const mismatchReport = (await panel('stats', { sessionId: 'session-mismatched-values', scope: 'project', projectKey: key })).lastRecall
  assert.deepEqual(mismatchReport.questions.map(question => question.answerCoverage), ['unverified', 'unverified'])

  const equivalent = await prepare(query, 'session-equivalent-values')
  completeAnswer(handlers, equivalent.session, '雾杉备份每天 2：37 执行，保留 041 天。')
  const equivalentReport = (await panel('stats', { sessionId: 'session-equivalent-values', scope: 'project', projectKey: key })).lastRecall
  assert.deepEqual(equivalentReport.questions.map(question => question.answerCoverage), ['covered', 'covered'])
})

test('compact snapshot answers bind an unlabeled retention value to its own question', async t => {
  const { key, prepare, panel, handlers } = await setup(t, [
    { id: 'mem_compact_snapshot', content: '雾舟快照每天06:17执行，保留37天，因为要避开清晨的镜像写盘峰值。' },
    { id: 'mem_other_snapshot', content: '松港快照保留52天。' },
  ])
  const query = '雾舟快照每天几点执行、保留多久、为什么改时间？'
  const cases = [
    [query, '06:17，37 天，避开清晨的镜像写盘峰值', ['covered', 'covered', 'covered']],
    [query, '06:17，137 天，避开清晨的镜像写盘峰值', ['covered', 'unverified', 'covered']],
    [query, '37 天，06:17，避开清晨的镜像写盘峰值', ['covered', 'unverified', 'covered']],
    ['雾舟快照保留多久？', '37 天。', ['covered']],
    ['雾舟快照保留多久，松港快照保留多久？', '37 天，52 天。', ['unverified', 'unverified']],
  ]
  for (const [index, [question, answer, expected]] of cases.entries()) {
    const turn = await prepare(question, 'compact-values-' + index)
    assert.match(turn.block, /37天/u)
    completeAnswer(handlers, turn.session, answer)
    const report = (await panel('stats', { projectKey: key, sessionId: turn.session.id })).lastRecall
    assert.deepEqual(report.questions.map(item => item.answerCoverage), expected, answer)
    if (index === 0) assert.equal(report.questions[1].answerExcerpt, '37 天')
  }
})

test('answer coverage does not trade the past and current values between two clock questions', async t => {
  const { key, prepare, panel, handlers } = await setup(t, [
    { id: 'mem_snapshot_past', content: '栖港备份过去每天00:18启动。', status: 'superseded', validTo: Date.now() - 86_400_000 },
    { id: 'mem_snapshot_now', content: '栖港备份目前每天04:36启动。' },
  ])
  const query = '栖港备份以前几点做，现在又是几点？'
  const swapped = await prepare(query, 'session-swapped-times')
  assert.match(swapped.block, /00:18/u)
  assert.match(swapped.block, /04:36/u)
  completeAnswer(handlers, swapped.session, '以前04:36启动，现在00:18启动。')
  const incorrect = (await panel('stats', { sessionId: swapped.session.id, projectKey: key })).lastRecall
  assert.deepEqual(incorrect.questions.map(question => question.answerCoverage), ['unverified', 'unverified'])

  const qualified = await prepare(query, 'session-labelled-times')
  completeAnswer(handlers, qualified.session, '现在04:36启动，以前00:18启动。')
  const correct = (await panel('stats', { sessionId: qualified.session.id, projectKey: key })).lastRecall
  assert.deepEqual(correct.questions.map(question => question.answerCoverage), ['covered', 'covered'])
  assert.deepEqual(correct.questions.map(question => question.answerExcerpt), ['以前00:18启动。', '现在04:36启动'])
})

test('a rejected clock and an explicitly uncertain duration are not supported answers', async t => {
  const { key, prepare, panel, handlers } = await setup(t, [
    { id: 'mem_negative_value', content: '雾杉备份每天02:37执行，保留41天。' },
  ])
  const prepared = await prepare('雾杉备份每天几点执行，保留多久？', 'session-denied-values')
  completeAnswer(handlers, prepared.session, '每天不是02:37执行。不能确认保留41天。')
  const report = (await panel('stats', { sessionId: prepared.session.id, projectKey: key })).lastRecall
  assert.deepEqual(report.questions.map(question => question.answerCoverage), ['unverified', 'unverified'])
  assert.ok(report.questions.every(question => question.injected.length > 0))
})

test('the completed recall report withholds coverage only for the answer that retracts its reason', async t => {
  const cause = '旧窗口覆盖不到审计抽查'
  const { key, panel, prepare, handlers } = await setup(t, [
    { id: 'mem_cause_retraction', content: '灰桦快照保留37天，因为' + cause + '。' },
  ])
  const question = '灰桦快照保留多久，为什么改？'
  const first = await prepare(question, 'session-reason-retracted')
  assert.match(first.block, /37天/u)
  assert.ok(first.block.includes(cause))
  completeAnswer(handlers, first.session, '根据提供的记忆证据，灰桦快照的保留期限是37天，且改是因为旧窗口覆盖不到审计抽查。关于为什么改，记忆中提到的调整原因是在“知识笔记”中，但具体原因未详细说明。')
  const report = (await panel('stats', { scope: 'project', sessionId: first.session.id, projectKey: key })).lastRecall
  assert.deepEqual(report.questions.map(item => [item.detail, item.answerCoverage]), [['retention', 'covered'], ['reason', 'unverified']])
  assert.equal(report.questions[1].answerExcerpt, null)

  const second = await prepare(question, 'session-reason-supported')
  completeAnswer(handlers, second.session, '灰桦快照保留37天，因为' + cause + '。单次抽查编号未详细说明。')
  const ordinary = (await panel('stats', { scope: 'project', sessionId: second.session.id, projectKey: key })).lastRecall
  assert.deepEqual(ordinary.questions.map(item => item.answerCoverage), ['covered', 'covered'])
})

test('another object in the same evidence cannot validate the returned clock or duration', async t => {
  const { key, prepare, panel, handlers } = await setup(t, [
    { id: 'mem_combined_values_for_report', content: '碧潮方案的快照每天07:26运行，保留43天；赤潮方案的快照每天06:15运行，保留90天。' },
  ])
  const prepared = await prepare('碧潮方案快照每天几点运行，保留多久？', 'session-nearby-answers')
  assert.match(prepared.block, /07:26.*43天.*06:15.*90天/u)
  completeAnswer(handlers, prepared.session, '碧潮方案的快照每天06:15运行，保留90天。')
  const report = (await panel('stats', { sessionId: prepared.session.id, projectKey: key })).lastRecall
  assert.deepEqual(report.questions.map(question => question.answerCoverage), ['unverified', 'unverified'])
})

test('reason coverage strips repeated cause prefixes before comparing the source phrase', async t => {
  const { key, prepare, panel, handlers } = await setup(t, [
    { id: 'mem_reason_prefixes', content: '星芒快照改到03:42的原因是为了避开每日导入的磁盘峰值。' },
  ])
  const prepared = await prepare('星芒快照为什么改到03:42？', 'session-reason-prefixes')
  completeAnswer(handlers, prepared.session, '原因：避开每日导入的磁盘峰值。')
  const report = (await panel('stats', { sessionId: 'session-reason-prefixes', scope: 'project', projectKey: key })).lastRecall
  assert.equal(report.questions.length, 1)
  assert.equal(report.questions[0].detail, 'reason')
  assert.equal(report.questions[0].answerCoverage, 'covered')
})

test('multi-question answer coverage is independent, and repeated question values do not collapse slots', async t => {
  const { key, panel, prepare, handlers } = await setup(t, [
    { id: 'mem_same_value_snapshot', content: '银帆快照每天04:20执行，报表也每天04:20开始。' },
    { id: 'mem_retention_value', content: '银帆快照保留47天。' },
  ])
  const prepared = await prepare('银帆快照几点执行，报表几点开始，银帆快照保留多久？', 'session-partial')
  completeAnswer(handlers, prepared.session, '银帆快照和报表都在04:20。保留期限我无法确认。')
  const report = (await panel('stats', { sessionId: 'session-partial', scope: 'project', projectKey: key })).lastRecall
  assert.equal(report.questions.length, 3)
  assert.equal(report.questions.filter(question => question.answerCoverage === 'covered').length, 2)
  assert.equal(report.questions.filter(question => question.answerCoverage === 'unverified').length, 1)
  assert.equal(report.questions.filter(question => question.query.includes('几点') || question.query.includes('开始')).length, 2)
})

test('duplicate native inbox and user events do not erase the report for the same turn', async t => {
  const { key, panel, prepare, handlers } = await setup(t, [
    { id: 'mem_duplicate_native_event', content: '星芒快照每天在03:42执行，保留61天。' },
  ])
  const prepared = await prepare('星芒快照每天几点执行，保留多久？', 'session-duplicate-event')
  const input = prepared.messages[0]
  handlers['session/event'](prepared.session, { type: 'user/message', data: input })
  handlers['session/event'](prepared.session, { type: 'agent/inbox/spliced', data: { inserted: [input] } })
  completeAnswer(handlers, prepared.session, '星芒快照每天在03:42执行，保留61天。')
  const report = (await panel('stats', { sessionId: prepared.session.id, scope: 'project', projectKey: key })).lastRecall
  assert.ok(report)
  assert.equal(report.outcome, 'completed')
  assert.deepEqual(report.questions.map(question => question.answerCoverage), ['covered', 'covered'])
})

test('no-evidence, unanswered, aborted and forget outcomes never claim answer coverage', async t => {
  const { key, panel, prepare, handlers } = await setup(t, [
    { id: 'mem_forget_report', content: '碧潮交接的备用代号是雨燕七号。' },
  ])
  const noEvidence = await prepare('火星的公转周期是多少？', 'session-empty')
  completeAnswer(handlers, noEvidence.session, '火星的公转周期是687天。')
  const emptyReport = (await panel('stats', { sessionId: 'session-empty', scope: 'project', projectKey: key })).lastRecall
  assert.ok(emptyReport.questions.every(question => question.answerCoverage !== 'covered'))

  const unanswered = await prepare('碧潮交接的备用代号是什么？', 'session-unanswered')
  handlers['session/event'](unanswered.session, { type: 'assistant/message', data: { message: {
    role: 'assistant', source: { kind: 'candidate' }, content: [{ type: 'text', text: '雨燕七号。' }],
  } } })
  handlers['session/event'](unanswered.session, { type: 'tool/result', data: { content: '雨燕七号。' } })
  handlers['session/event'](unanswered.session, { type: 'assistant/message', data: { message: {
    role: 'assistant', channel: 'analysis', source: { kind: 'assistant' }, content: [{ type: 'text', text: '雨燕七号。' }],
  } } })
  handlers['session/event'](unanswered.session, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  const unansweredReport = (await panel('stats', { sessionId: 'session-unanswered', scope: 'project', projectKey: key })).lastRecall
  assert.equal(unansweredReport.outcome, 'completed')
  assert.ok(unansweredReport.questions.every(question => question.answerCoverage === 'unverified'))
  assert.ok(unansweredReport.questions.every(question => question.answerExcerpt === null))

  const aborted = await prepare('碧潮交接的备用代号是什么？', 'session-aborted')
  completeAnswer(handlers, aborted.session, '雨燕七号。', 'aborted')
  const abortedReport = (await panel('stats', { sessionId: 'session-aborted', scope: 'project', projectKey: key })).lastRecall
  assert.equal(abortedReport.outcome, 'aborted')
  assert.ok(abortedReport.questions.every(question => question.answerCoverage !== 'covered'))

  await panel('removeMemory', { id: 'mem_forget_report', scope: 'project', projectKey: key })
  assert.equal((await panel('stats', { sessionId: 'session-unanswered', scope: 'project', projectKey: key })).lastRecall, null)
})

test('the routed model capacity and the host measurement shrink the real injection budget to zero', async t => {
  let occupied = 850
  let route = 'host-model'
  const meter = { measure: () => ({ totalTokens: occupied }), estimateMessage: () => 20 }
  const ctxWindow = 1500
  const { ask, panel } = await setup(t, [
    { id: 'mem_silver_snapshot', content: '银帆快照每天 04:20 执行，保留 47 天。' },
  ], { async resolveModelInfo(provider, model) {
    assert.equal(provider, 'host-provider')
    assert.equal(model, 'host-model')
    return { context: { contextWindow: ctxWindow } }
  } }, { host: { tokenMeter: meter } })
  const state = { requestContext: () => ({ provider: 'host-provider', model: route, contextWindow: ctxWindow }),
    requestHeader: () => ({ config: { provider: 'host-provider', model: 'host-model', maxTokens: 300 } }) }
  const question = '银帆快照每天几点执行，保留多久？'
  assert.match(await ask(question, 'session-budget', state), /04:20/u)
  const first = (await panel('stats', { sessionId: 'session-budget' })).contextUsage
  assert.ok(first.budget < 360 && first.budget >= first.tokens && first.tokens > 0)
  route = 'previous-model'
  occupied = 1490
  assert.equal(await ask(question, 'session-budget', state), '')
  const second = (await panel('stats', { sessionId: 'session-budget' })).contextUsage
  assert.equal(second.budget, 0)
  assert.equal(second.tokens, 0)
})

test('context usage reports the final memory block and clears on a miss in the same session', async t => {
  const { ask, panel } = await setup(t, [
    { id: 'mem_snapshot_retention', content: '青岚快照每天 04:20 执行，保留 47 天。' },
  ])
  const usageOf = async sessionId => (await panel('stats', { sessionId })).contextUsage
  assert.equal(await usageOf('session-a'), null)
  const block = await ask('青岚快照每天几点执行，保留多久？', 'session-a')
  assert.match(block, /04:20/u)
  const used = await usageOf('session-a')
  assert.equal(used.tokens, estimateTokens(block))
  assert.equal(used.budget, 360)
  assert.equal(used.items, 1)
  assert.equal(await usageOf('session-b'), null)
  assert.equal(await ask('火星的公转周期是多少？', 'session-b'), '')
  assert.equal((await usageOf('session-b')).tokens, 0)
  assert.deepEqual(await usageOf('session-a'), used)
  assert.equal(await ask('月球的直径是多少？', 'session-a'), '')
  const missed = await usageOf('session-a')
  assert.equal(missed.tokens, 0)
  assert.equal(missed.items, 0)
  assert.equal(await usageOf(undefined), null)
})

test('deep recall searches only the missing snapshot reason and never treats a saved question as evidence', async t => {
  const { ask, panel, dataDir, key } = await setup(t, [
    { id: 'mem_quartz_clock', content: '灰晶快照每天在 03:42 执行。' },
    { id: 'mem_quartz_retention', content: '灰晶快照保留 61 天。' },
  ], {
    async *stream() { assert.fail('Exact original evidence does not need a provider selection call') },
  })
  const grant = (messageId, text) => {
    const source = readSource(dataDir, saveSource(dataDir, { sessionId: 'remember-source', messageId,
      projectKey: key, role: 'user', sourceKind: 'user', text }).id)
    assert.ok(grantSourceRecall(dataDir, source, key))
  }
  grant('real-reason', '记住：灰晶快照改到 03:42，因为要避开每日导入的磁盘峰值。')
  grant('unconfirmed-question', '记住：关机单统一晚班发出。灰晶快照改期是因为审核流程吗？')
  const answer = await ask('灰晶快照每天几点执行、保留多久、为什么改时间？')
  for (const text of ['03:42', '61 天', '避开每日导入的磁盘峰值']) assert.ok(answer.includes(text))
  assert.doesNotMatch(answer, /审核流程/u)
  const report = (await panel('stats', { sessionId: 'session-integration' })).lastRecall
  assert.equal(report.covered.length, 3)
  assert.deepEqual(report.localDeepRecall.queries, ['灰晶快照 为什么改时间'])
  assert.equal(report.localDeepRecall.limit, 50000)
  assert.ok(report.localDeepRecall.tokens > 0 && report.localDeepRecall.tokens <= 50000)
  const original = report.covered.flatMap(row => row.evidence).find(item => item.kind === 'source')
  assert.ok(original)
  await panel('removeMemory', { id: original.id, scope: 'project', projectKey: key })
  assert.doesNotMatch(await ask('灰晶快照为什么改时间？', 'another-session'), /磁盘峰值|审核流程/u)
})

test('unextracted original evidence remains usable without another paid call, but is not reported as confirmed coverage', async t => {
  const {dataDir,key,panel,ask}=await setup(t)
  const source=readSource(dataDir,saveSource(dataDir,{sessionId:'source-session',projectKey:key,role:'user',sourceKind:'user',text:'碧潮交接的备用联络代号是雨燕七号。'}).id)
  grantSourceRecall(dataDir,source,key)
  const answer=await ask('碧潮交接的备用联络代号是什么？')
  assert.match(answer,/雨燕七号/u)
  assert.match(answer,/用户原文（未提炼）/u)
  assert.match(answer,/可按用户所述引用/u)
  assert.doesNotMatch(answer,/\[事实\]/u)
  const report=(await panel('stats',{scope:'project',projectKey:key,sessionId:'session-integration'})).lastRecall
  assert.equal(report.covered.length,0)
  assert.equal(report.candidates.length,1)
  const id=report.candidates[0].evidence[0].id
  await assert.rejects(()=>panel('removeMemory',{id,scope:'project',projectKey:projectIdentity('/another').key}))
  await panel('removeMemory',{id,scope:'project',projectKey:key})
  assert.doesNotMatch(await ask('碧潮交接的备用联络代号是什么？'),/雨燕七号/u)
})

test('forgetting an original source removes every current recall report that cites its evidence', async t => {
  const { dataDir, key, cwd, panel, ask, handlers } = await setup(t)
  const saved = saveSource(dataDir, { sessionId: 'source-session', messageId: 'source-forget', projectKey: key,
    role: 'user', sourceKind: 'user', text: '碧潮交接的备用联络代号是雨燕七号。' })
  const source = readSource(dataDir, saved.id)
  assert.ok(grantSourceRecall(dataDir, source, key))

  const answer = await ask('碧潮交接的备用联络代号是什么？')
  assert.match(answer, /雨燕七号/u)
  const session = { id: 'session-integration', header: { cwd } }
  completeAnswer(handlers, session, '碧潮交接的备用联络代号是雨燕七号。')
  const report = (await panel('stats', { sessionId: session.id, projectKey: key })).lastRecall
  const evidence = report.questions.flatMap(question => [...question.hits, ...question.injected, ...question.notInjected])
    .find(item => item.kind === 'source' && item.sourceRefs.some(ref => ref.sourceId === saved.id))
  assert.ok(evidence)

  await panel('removeMemory', { id: evidence.id, scope: 'project', projectKey: key })
  assert.equal((await panel('stats', { sessionId: session.id, projectKey: key })).lastRecall, null)
})

test('cross-session calendar comparison retrieves both dated events and checks the stated interval', async t => {
  const { dataDir, key, panel, prepare, handlers } = await setup(t)
  const grant = (projectKey, sessionId, text) => {
    const saved = saveSource(dataDir, { projectKey, sessionId, messageId: 'event', role: 'user', sourceKind: 'user',
      at: Date.UTC(2026, 5, 13, 12), text })
    assert.ok(grantSourceRecall(dataDir, readSource(dataDir, saved.id), projectKey, { remembered: true }))
    return saved.id
  }
  const workshop = grant(key, 'workshop-history', 'I attended the workshop on Practical Change Design on June 10. Can you help with the review checklist?')
  const review = grant(key, 'review-plan', 'The Raven review I have been preparing for is scheduled for June 17, 2026. Could anyone attend on June 27 instead?')
  grant(key, 'nearby-noise', 'The Crow review was on June 12. The checklists were ready on June 9.')
  grant(projectIdentity(join(dataDir, 'private-other-project')).key, 'another-project', 'The Raven review was on June 25, 2026.')
  const question = "How many days before the Raven review I was preparing for did I attend the workshop on 'Practical Change Design'?"
  const solved = await prepare(question, 'event-gap-correct')
  assert.match(solved.block, /June 10/u)
  assert.match(solved.block, /June 17/u)
  assert.doesNotMatch(solved.block, /June (?:9|12|25|27)/u)
  completeAnswer(handlers, solved.session, 'The workshop was seven days before the Raven review.')
  const report = (await panel('stats', { sessionId: solved.session.id, projectKey: key })).lastRecall
  assert.equal(report.total, 2)
  assert.deepEqual(report.questions.map(item => item.answerCoverage), ['covered', 'covered'])
  const cited = report.questions.flatMap(item => item.injected.flatMap(evidence => evidence.sourceRefs.map(ref => ref.sourceId)))
  assert.deepEqual(new Set(cited), new Set([workshop, review]))

  const incorrect = await prepare(question, 'event-gap-incorrect')
  completeAnswer(handlers, incorrect.session, 'June 10 and June 17 are nine days apart.')
  const missed = (await panel('stats', { sessionId: incorrect.session.id, projectKey: key })).lastRecall
  assert.deepEqual(missed.questions.map(item => item.answerCoverage), ['unverified', 'unverified'])

  const reversed = await prepare(question, 'event-gap-reversed')
  completeAnswer(handlers, reversed.session, 'The Raven review was seven days before the workshop on Practical Change Design.')
  const inverted = (await panel('stats', { sessionId: reversed.session.id, projectKey: key })).lastRecall
  assert.deepEqual(inverted.questions.map(item => item.answerCoverage), ['unverified', 'unverified'])

  const reviewEvidence = report.questions.flatMap(item => item.injected)
    .find(item => item.sourceRefs.some(ref => ref.sourceId === review))
  await panel('removeMemory', { id: reviewEvidence.id, scope: 'project', projectKey: key })
  assert.equal((await panel('stats', { sessionId: solved.session.id, projectKey: key })).lastRecall, null)
  const partial = await prepare(question, 'event-gap-after-forget')
  assert.match(partial.block, /June 10/u)
  assert.doesNotMatch(partial.block, /June (?:17|25)|= 7/u)
  completeAnswer(handlers, partial.session, 'The workshop was on June 10. I have no date for the Raven review.')
  const unresolved = (await panel('stats', { sessionId: partial.session.id, projectKey: key })).lastRecall
  assert.equal(unresolved.missing.length, 1)
  assert.match(unresolved.missing[0], /Raven review/u)
})

test('an elapsed week comparison reads ordinary authorized originals across sessions', async t => {
  const at = Date.UTC(2023, 3, 11, 12)
  t.mock.method(Date, 'now', () => at)
  const { dataDir, key, cwd, panel, prepare, handlers } = await setup(t)
  const add = (sessionId, text, stamp, projectKey = key) => {
    const timestamp = Date.parse(stamp)
    const source = saveSource(dataDir, { projectKey, sessionId, messageId: 'recollection',
      role: 'user', sourceKind: 'user', eventTime: timestamp, at: timestamp, timeZone: 'UTC', text })
    assert.ok(grantSourceRecall(dataDir, readSource(dataDir, source.id), projectKey))
    return source.id
  }
  const recovery = add('recovery', 'I finally recovered from the flu today.', '2023-01-19T13:00:00Z')
  const jog = add('jog', 'I went on my 10th jog outdoors today.', '2023-04-10T15:00:00Z')
  add('friend', 'I went on my 9th jog outdoors today after my friend went on her 10th jog outdoors.', '2023-04-09T10:00:00Z')
  add('later-message', 'I went on my 10th jog outdoors today.', '2023-04-12T10:00:00Z')
  add('another-project', 'I went on my 10th jog outdoors today.', '2023-04-08T10:00:00Z', projectIdentity(join(cwd, 'another')).key)

  const query = 'How many weeks had passed since I recovered from the flu when I went on my 10th jog outdoors?'
  const turn = await prepare(query, 'week-interval-confirmed')
  assert.match(turn.block, /11 weeks and 4 days \(81 days\)/u)
  completeAnswer(handlers, turn.session, 'It had been 81 days, which is equivalent to 11 weeks and 4 days.')
  const report = (await panel('stats', { projectKey: key, sessionId: turn.session.id })).lastRecall
  assert.deepEqual(report.questions.map(question => question.answerCoverage), ['covered', 'covered'])
  const injected = report.questions.flatMap(question => question.injected)
  assert.deepEqual(new Set(injected.flatMap(hit => hit.sourceRefs.map(ref => ref.sourceId))), new Set([recovery, jog]))
  const deleted = injected.find(hit => hit.sourceRefs.some(ref => ref.sourceId === jog))
  await panel('removeMemory', { id: deleted.id, scope: 'project', projectKey: key })
  assert.equal((await panel('stats', { projectKey: key, sessionId: turn.session.id })).lastRecall, null)
  assert.doesNotMatch((await prepare(query, 'week-interval-after-forget')).block, /weeks and|Verified date interval/u)
})

test('an event-order question grounds both occurrences across sessions and clears the conclusion after forgetting', async t => {
  const { dataDir, key, cwd, panel, prepare, handlers } = await setup(t)
  const add = (sessionId, text, stamp, projectKey = key, timeZone = 'Asia/Shanghai') => {
    const source = saveSource(dataDir, { projectKey, sessionId, messageId: 'trip', text, role: 'user', sourceKind: 'user',
      eventTime: Date.parse(stamp), timeZone, at: Date.parse(stamp) })
    assert.ok(grantSourceRecall(dataDir, readSource(dataDir, source.id), projectKey))
    return source.id
  }
  const tram = add('old-tram', 'Can you help plan a trip? I just got back from a tram ride today, so I am planning to rest.', '2026-04-02T15:30:00Z')
  const ferry = add('later-ferry', 'I took a ferry to the island today.', '2026-04-02T17:30:00Z')
  add('ferry-plans', 'I am planning to take a ferry on 2026-04-09.', '2026-04-08T10:00:00Z')
  add('unrelated-tram', 'I took a taxi to the tram station today.', '2026-04-05T10:00:00Z')
  const foreign = projectIdentity(join(cwd, 'other')).key
  add('foreign-tram', 'I took a tram today.', '2026-04-12T12:00:00Z', foreign)
  const question = 'Which mode of transport did I use most recently, a tram or a ferry?'
  const verified = await prepare(question, 'trip-most-recent')
  assert.match(verified.block, /got back from a tram ride today/u)
  assert.match(verified.block, /took a ferry to the island today/u)
  assert.match(verified.block, /\[Verified event order\].*ferry/u)
  assert.match(verified.block, /原话所述日期 2026-04-03/u)
  assert.doesNotMatch(verified.block, /planning to rest/u)
  assert.doesNotMatch(verified.block, /2026-04-09|tram station/u)
  completeAnswer(handlers, verified.session, 'I used the ferry most recently.')
  const { lastRecall } = await panel('stats', { sessionId: verified.session.id, projectKey: key })
  assert.deepEqual(lastRecall.questions.map(question => question.answerCoverage), ['covered', 'covered'])
  const supplied = lastRecall.questions.flatMap(question => question.injected)
  assert.deepEqual(new Set(supplied.flatMap(item => item.sourceRefs.map(ref => ref.sourceId))), new Set([tram, ferry]))

  const reversed = await prepare(question, 'trip-incorrect-order')
  completeAnswer(handlers, reversed.session, 'I used the tram most recently.')
  const wrong = (await panel('stats', { sessionId: reversed.session.id, projectKey: key })).lastRecall
  assert.deepEqual(wrong.questions.map(item => item.answerCoverage), ['unverified', 'unverified'])

  const comparative = await prepare(question, 'trip-comparative-answer')
  completeAnswer(handlers, comparative.session, 'I took the ferry more recently than the tram.')
  const confirmed = (await panel('stats', { sessionId: comparative.session.id, projectKey: key })).lastRecall
  assert.deepEqual(confirmed.questions.map(item => item.answerCoverage), ['covered', 'covered'])

  const noClaim = await prepare(question, 'trip-without-comparison')
  completeAnswer(handlers, noClaim.session, 'I remember taking the ferry on the island.')
  const incomplete = (await panel('stats', { sessionId: noClaim.session.id, projectKey: key })).lastRecall
  assert.deepEqual(incomplete.questions.map(item => item.answerCoverage), ['unverified', 'unverified'])

  const evidence = supplied.find(item => item.sourceRefs.some(ref => ref.sourceId === ferry))
  await panel('removeMemory', { id: evidence.id, scope: 'project', projectKey: key })
  assert.equal((await panel('stats', { sessionId: verified.session.id, projectKey: key })).lastRecall, null)
  const partial = await prepare(question, 'trip-after-forget')
  assert.match(partial.block, /tram ride/u)
  assert.doesNotMatch(partial.block, /ferry to the island|\[Verified event order\]/u)
  assert.match(partial.block, /\[Event order unconfirmed\]/u)
})

test('a purchase comparison carries approximate original dates without a definite order', async t => {
  const { dataDir, key, prepare } = await setup(t)
  const add = (sessionId, text) => {
    const eventTime = Date.parse('2026-05-29T12:00:00Z')
    const source = saveSource(dataDir, { projectKey: key, sessionId, messageId: 'purchase', text,
      role: 'user', sourceKind: 'user', at: eventTime, eventTime, timeZone: 'UTC' })
    assert.ok(grantSourceRecall(dataDir, readSource(dataDir, source.id), key))
  }
  add('bed', 'I recently got a new oak dog bed for Nova about three weeks ago from the pet store.')
  add('pads', "I'm looking for a toy for my puppy, Ash. I've been using those reusable training pads from the shop. I got a set of 10 for $25 about a month ago, and they've been helpful.")
  add('other-item', 'I purchased a refill for the vacuum on 2026-04-10. The dog bed is comfortable.')
  const request = await prepare('Which item did I purchase first, the dog bed for Nova or the training pads for Ash?', 'purchase-order')
  assert.match(request.block, /dog bed for Nova about three weeks ago/u)
  assert.match(request.block, /training pads.*a set of 10 for \$25 about a month ago/su)
  assert.doesNotMatch(request.block, /vacuum|\[Verified event order\]/u)
  assert.match(request.block, /\[Event order unconfirmed\]/u)
})

test('travel order compares completed trips with the requested companions across original user turns', async t => {
  const { dataDir, key, cwd, prepare, panel, handlers } = await setup(t)
  const at = Date.parse('2026-06-14T16:30:00Z')
  const sibling = join(cwd, '..', 'sibling', 'project')
  const siblingKey = projectIdentity(sibling).key
  const add = (sessionId, text, projectKey = key) => {
    const saved = saveSource(dataDir, { projectKey, sessionId, messageId: 'trip', text, role: 'user', sourceKind: 'user',
      at, eventTime: at, timeZone: 'Asia/Shanghai' })
    assert.ok(grantSourceRecall(dataDir, readSource(dataDir, saved.id), projectKey))
    return saved.id
  }
  const family = add('family-trip', 'Just last month, I went on a ten-day trip to Patagonia with my parents and younger sister.')
  const solo = add('solo-trip', "I've had experience travelling solo before, like when I went to Kyoto last year and had time to do anything I wanted.")
  add('planning', 'I am planning a solo trip to Kyoto on 2027-01-05.')
  add('other-person', 'My coworker took a solo trip to Kyoto on 2024-01-12.')
  add('second-hand', 'My coworker said I went solo to Kyoto on 2024-02-11.')
  add('different-party', 'I went to Kyoto with my family on 2024-03-11.')
  add('another-event-date', 'I went to Kyoto alone and met my friend on 2024-05-11.')
  add('another-traveller-date', 'I went to Kyoto alone and my aunt arrived on 2024-06-11.')
  add('different-destination', 'I took a solo trip to Kyoto City Hall on 2024-07-11.')
  const otherFamily = add('other-family', 'I took a family trip to Patagonia on 2023-08-10.', siblingKey)
  const otherSolo = add('other-solo', 'I went solo to Kyoto on October 20, 2024.', siblingKey)

  const question = 'Which trip did I take first, the one to Patagonia with family or the solo trip to Kyoto?'
  const first = await prepare(question, 'travel-order')
  assert.match(first.block, /\[Verified event order\] First: the solo trip to Kyoto\./u)
  assert.match(first.block, /2025-01-01–2025-12-31[^\n]*travelling solo before, like when I went to Kyoto last year/u)
  assert.match(first.block, /2026-05-01–2026-05-31[^\n]*Patagonia with my parents and younger sister/u)
  assert.doesNotMatch(first.block, /2023-08|2024-|2027-01/u)
  completeAnswer(handlers, first.session, 'You went to Kyoto before the trip to Patagonia.')
  const { lastRecall } = await panel('stats', { sessionId: first.session.id, projectKey: key })
  assert.deepEqual(lastRecall.questions.map(row => row.answerCoverage), ['covered', 'covered'])
  const injected = lastRecall.questions.flatMap(row => row.injected)
  assert.deepEqual(new Set(injected.flatMap(item => item.sourceRefs.map(ref => ref.sourceId))), new Set([family, solo]))
  const wrongParty = await prepare(question, 'travel-order-wrong-party')
  completeAnswer(handlers, wrongParty.session, 'The family trip to Kyoto was first.')
  const wrong = (await panel('stats', { sessionId: wrongParty.session.id, projectKey: key })).lastRecall
  assert.deepEqual(wrong.questions.map(row => row.answerCoverage), ['unverified', 'unverified'])

  const other = await prepare(question, 'travel-order-other', { header: { cwd: sibling } })
  assert.match(other.block, /\[Verified event order\] First: the one to Patagonia with family\./u)
  assert.match(other.block, /2024-10-20[^\n]*on October 20, 2024/u)
  assert.doesNotMatch(other.block, /2025-01|2026-05/u)
  completeAnswer(handlers, other.session, 'The family trip to Patagonia was first.')
  const { lastRecall: otherReport } = await panel('stats', { sessionId: other.session.id, projectKey: siblingKey })
  assert.deepEqual(new Set(otherReport.questions.flatMap(row => row.injected.flatMap(item => item.sourceRefs.map(ref => ref.sourceId)))),
    new Set([otherFamily, otherSolo]))

  const forgotten = injected.find(item => item.sourceRefs.some(ref => ref.sourceId === solo))
  assert.equal((await panel('removeMemory', { id: forgotten.id, scope: 'project', projectKey: key })).status, 'deleted')
  assert.equal((await panel('stats', { sessionId: first.session.id, projectKey: key })).lastRecall, null)
  assert.ok((await panel('stats', { sessionId: other.session.id, projectKey: siblingKey })).lastRecall)
  const after = await prepare(question, 'travel-order-forgotten')
  assert.match(after.block, /Patagonia with my parents and younger sister/u)
  assert.match(after.block, /\[Event order unconfirmed\]/u)
  assert.doesNotMatch(after.block, /I went to Kyoto last year|\[Verified event order\]/u)
})

test('旅行先后区分同一目的地的独行和家庭出游', async t => {
  const { dataDir, key, prepare, panel, handlers } = await setup(t)
  const at = Date.parse('2026-10-13T13:00:00Z')
  for (const [sessionId, text] of [
    ['family', '上个月我和爸妈去了厦门旅游。'],
    ['solo', '去年我独自去了厦门。'],
    ['someone-else', '我妹妹去年独自去了厦门。'],
    ['other-date', '我独自去了厦门，朋友2024年7月10日才到。'],
    ['negation', '我今年并没有独自去厦门。'],
  ]) {
    const saved = saveSource(dataDir, { projectKey: key, sessionId, messageId: 'trip', text,
      role: 'user', sourceKind: 'user', at, eventTime: at, timeZone: 'Asia/Shanghai' })
    assert.ok(grantSourceRecall(dataDir, readSource(dataDir, saved.id), key))
  }
  const question = '我先去的是哪里，跟家人去厦门还是独自去厦门？'
  const turn = await prepare(question, 'one-place-two-trips')
  assert.match(turn.block, /\[先后核对\] 先独自去厦门，后跟家人去厦门/u)
  assert.match(turn.block, /2025-01-01–2025-12-31[^\n]*去年我独自去了厦门/u)
  assert.match(turn.block, /2026-09-01–2026-09-30[^\n]*上个月我和爸妈去了厦门/u)
  assert.doesNotMatch(turn.block, /我妹妹|并没有/u)
  completeAnswer(handlers, turn.session, '先独自去厦门，之后才和家人去厦门。')
  const { lastRecall } = await panel('stats', { sessionId: turn.session.id, projectKey: key })
  assert.deepEqual(lastRecall.questions.map(row => row.answerCoverage), ['covered', 'covered'])
})

test('named activities keep attendance, ownership, and return dates tied to the right event', async t => {
  const { dataDir, key, cwd, prepare, panel, handlers } = await setup(t)
  const sibling = join(cwd, '..', 'sibling', 'project')
  const siblingKey = projectIdentity(sibling).key
  const add = (sessionId, text, stamp, projectKey = key) => {
    const at = Date.parse(stamp)
    const source = saveSource(dataDir, { projectKey, sessionId, messageId: 'activity', text, role: 'user',
      sourceKind: 'user', at, eventTime: at, timeZone: 'Asia/Shanghai' })
    assert.ok(grantSourceRecall(dataDir, readSource(dataDir, source.id), projectKey))
    return source.id
  }
  const early = '2026-05-06T07:00:00Z', late = '2026-06-15T07:00:00Z'
  const reception = add('reception', "I just came back from Maya’s reception at the museum today, and it got me thinking about my wedding plans.", early)
  const wedding = add('wedding', "I walked down the aisle as a bridesmaid at my aunt's wedding today.", late)
  add('different-host', "I attended Nora's reception at Maya's gallery on 2026-02-07.", early)
  add('different-wedding', "I attended my sister's wedding today. I mentioned my aunt's wedding.", early)
  add('preparation', "I attended my aunt's wedding rehearsal on 2026-03-08.", early)
  add('only-plans', "I am planning Maya's reception on 2026-07-19.", early)
  add('another-date', "I attended my aunt's wedding and my sister visited on 2026-04-12.", late)
  add('repeated-claim', "My friend said I attended Maya's reception on 2026-04-28.", early)
  const otherWedding = add('other-wedding', "My aunt's wedding was held on March 10, 2025.", early, siblingKey)
  const otherReception = add('other-reception', "I attended Maya's reception on 2025-03-20.", late, siblingKey)
  const question = "Which event happened first, my aunt's wedding or Maya's reception?"
  const active = await prepare(question, 'named-activities')
  assert.match(active.block, /\[Verified event order\] Maya's reception happened before my aunt's wedding\. First event: Maya's reception\./u)
  assert.doesNotMatch(active.block, /today|2026-0[56]-|came back from Maya|walked down the aisle/iu)
  assert.deepEqual(active.result.messages.map(message => message.source?.kind), ['memory', 'user'])
  assert.doesNotMatch(active.block, /2026-0[2347]-|2025-|wedding rehearsal|Nora/u)
  completeAnswer(handlers, active.session, "Maya’s reception was first. It had already happened by May 6, before your aunt’s wedding on June 15.")
  const { lastRecall } = await panel('stats', { sessionId: active.session.id, projectKey: key })
  assert.deepEqual(lastRecall.questions.map(slot => slot.answerCoverage), ['covered', 'covered'])
  const injected = lastRecall.questions.flatMap(slot => slot.injected)
  assert.deepEqual(new Set(injected.flatMap(item => item.sourceRefs.map(ref => ref.sourceId))), new Set([reception, wedding]))
  assert.equal(injected.flatMap(item => item.sourceRefs).find(ref => ref.sourceId === reception).eventTime, Date.parse(early))
  assert.match(injected.flatMap(item => item.sourceRefs).find(ref => ref.sourceId === reception).excerpt, /at the museum today/u)
  assert.match(injected.flatMap(item => item.sourceRefs).find(ref => ref.sourceId === wedding).excerpt, /wedding today/u)
  assert.ok(injected.every(item => active.block.split('\n').includes(item.text)))
  assert.equal(new Set(injected.map(item => item.text)).size, 1)
  const followedBy = await prepare(question, 'named-activities-followed-by-answer')
  completeAnswer(handlers, followedBy.session, "Maya's reception happened first, followed by your aunt's wedding.")
  const { lastRecall: followedByReport } = await panel('stats', { sessionId: followedBy.session.id, projectKey: key })
  assert.deepEqual(followedByReport.questions.map(slot => slot.answerCoverage), ['covered', 'covered'])
  const reversed = await prepare(question, 'named-activities-reversed-followed-by-answer')
  completeAnswer(handlers, reversed.session, "Your aunt's wedding happened first, followed by Maya's reception.")
  const { lastRecall: reversedReport } = await panel('stats', { sessionId: reversed.session.id, projectKey: key })
  assert.deepEqual(reversedReport.questions.map(slot => slot.answerCoverage), ['unverified', 'unverified'])
  const wrongHost = await prepare(question, 'named-activities-wrong-answer')
  completeAnswer(handlers, wrongHost.session, "Nora's reception at Maya's gallery was first.")
  const { lastRecall: wrongReport } = await panel('stats', { sessionId: wrongHost.session.id, projectKey: key })
  assert.deepEqual(wrongReport.questions.map(slot => slot.answerCoverage), ['unverified', 'unverified'])
  const exactOverclaim = await prepare(question, 'named-activities-unsupported-exact-day')
  completeAnswer(handlers, exactOverclaim.session, "First, Maya’s reception happened on 2026-05-06 ≤. It had already happened by that day.")
  const { lastRecall: exactReport } = await panel('stats', { sessionId: exactOverclaim.session.id, projectKey: key })
  assert.deepEqual(exactReport.questions.map(slot => slot.answerCoverage), ['unverified', 'unverified'])
  const latest = await prepare("Which occasion took place most recently, my aunt's wedding or Maya's reception?", 'named-activities-latest')
  assert.ok(latest.block.endsWith("- [Verified event order] Maya's reception happened before my aunt's wedding. Most recent event: my aunt's wedding.\n</memory-context>"))
  completeAnswer(handlers, latest.session, "The most recent occasion was your aunt's wedding.")
  const { lastRecall: latestReport } = await panel('stats', { sessionId: latest.session.id, projectKey: key })
  assert.deepEqual(latestReport.questions.map(slot => slot.answerCoverage), ['covered', 'covered'])
  const latestQuestion = "Which occasion took place most recently, my aunt's wedding or Maya's reception?"
  const contradictory = await prepare(latestQuestion, 'named-activities-contradictory-claim')
  completeAnswer(handlers, contradictory.session, "The most recent event was your aunt's wedding. This occurred before Maya's reception.")
  const { lastRecall: contradictoryReport } = await panel('stats', { sessionId: contradictory.session.id, projectKey: key })
  assert.deepEqual(contradictoryReport.questions.map(slot => slot.answerCoverage), ['unverified', 'unverified'])
  const localeDate = await prepare(latestQuestion, 'named-activities-day-first-claim')
  completeAnswer(handlers, localeDate.session, "The most recent occasion was your aunt's wedding. Maya's reception at the museum, which took place on the 6th of May, 2026, was earlier.")
  const { lastRecall: localeReport } = await panel('stats', { sessionId: localeDate.session.id, projectKey: key })
  assert.deepEqual(localeReport.questions.map(slot => slot.answerCoverage), ['unverified', 'unverified'])
  const returnDate = await prepare(latestQuestion, 'named-activities-day-first-return')
  completeAnswer(handlers, returnDate.session, "The most recent occasion was your aunt's wedding. You came back from Maya's reception on the 6th of May, 2026.")
  const { lastRecall: returnReport } = await panel('stats', { sessionId: returnDate.session.id, projectKey: key })
  assert.deepEqual(returnReport.questions.map(slot => slot.answerCoverage), ['covered', 'covered'])

  const other = await prepare(question, 'named-activities-other', { header: { cwd: sibling } })
  assert.match(other.block, /\[Verified event order\] my aunt's wedding happened before Maya's reception\. First event: my aunt's wedding\./u)
  assert.doesNotMatch(other.block, /was held|March 10|202[56]-/u)
  completeAnswer(handlers, other.session, "Your aunt's wedding came first.")
  const { lastRecall: otherReport } = await panel('stats', { sessionId: other.session.id, projectKey: siblingKey })
  assert.deepEqual(new Set(otherReport.questions.flatMap(slot => slot.injected.flatMap(item => item.sourceRefs.map(ref => ref.sourceId)))),
    new Set([otherWedding, otherReception]))

  const forgotten = injected.find(item => item.sourceRefs.some(ref => ref.sourceId === reception))
  assert.equal((await panel('removeMemory', { id: forgotten.id, scope: 'project', projectKey: key })).status, 'deleted')
  assert.equal((await panel('stats', { sessionId: active.session.id, projectKey: key })).lastRecall, null)
  assert.ok((await panel('stats', { sessionId: other.session.id, projectKey: siblingKey })).lastRecall)
  const after = await prepare(question, 'named-activities-forgotten')
  assert.equal(after.block, 'There is not enough dated evidence to determine the order of the two events.')
  assert.doesNotMatch(after.block, /2026-05-06|came back from Maya|walked down the aisle/u)
  const { lastRecall: afterReport } = await panel('stats', { sessionId: after.session.id, projectKey: key })
  assert.ok(afterReport.questions.every(slot => slot.injected.length === 0))
  assert.deepEqual(afterReport.questions.flatMap(slot => slot.notInjected.flatMap(hit => hit.sourceRefs.map(ref => ref.sourceId))), [wedding])
})

test('a first-completed task comparison verifies each named action in its own authorized original', async t => {
  const { dataDir, key, cwd, prepare, panel, handlers } = await setup(t)
  const otherCwd = join(cwd, '..', 'other', 'project')
  const otherKey = projectIdentity(otherCwd).key
  const add = (sessionId, text, projectKey = key) => {
    const source = saveSource(dataDir, { projectKey, sessionId, messageId: 'action', text, role: 'user', sourceKind: 'user',
      eventTime: Date.parse('2026-10-22T12:00:00Z'), timeZone: 'UTC' })
    assert.ok(grantSourceRecall(dataDir, readSource(dataDir, source.id), projectKey, { remembered: true }))
    return source.id
  }
  const first = add('repair', 'I fixed the cedar stairs on 2026-10-12.')
  const second = add('purchase', 'I purchased the blue handrail on 2026-10-15.')
  add('plan', 'I was planning to fix the cedar stairs in September.')
  add('different-person', 'My neighbor fixed the cedar stairs on 2026-10-01.')
  add('generic-task', 'I completed the proposal on 2026-10-01. The next assigned task is a workshop.')
  add('wrong-action', 'I painted the blue handrail on 2026-10-02.')
  add('other-repair', 'I repaired the cedar stairs on 2026-10-20.', otherKey)
  add('other-purchase', 'I bought the blue handrail on 2026-10-09.', otherKey)
  const question = 'Which task did I complete first, fixing the cedar stairs or buying the blue handrail?'
  const turn = await prepare(question, 'comparison-actual')
  assert.match(turn.block, /\[Verified event order\].*fixing the cedar stairs/iu)
  assert.doesNotMatch(turn.block, /proposal|neighbor|painted|workshop|September/u)
  completeAnswer(handlers, turn.session, 'You fixed the cedar stairs first.')
  const { lastRecall } = await panel('stats', { sessionId: turn.session.id, projectKey: key })
  assert.deepEqual(lastRecall.questions.map(slot => slot.answerCoverage), ['covered', 'covered'])
  assert.deepEqual(lastRecall.questions.map(slot => slot.injected.flatMap(hit => hit.sourceRefs.map(ref => ref.sourceId))), [[first], [second]])
  const explained = await prepare(question, 'comparison-explained')
  completeAnswer(handlers, explained.session, 'Based on the memory evidence, you first repaired the cedar stairs on 2026-10-12, and then purchased the blue handrail on 2026-10-15. Therefore, the task of repairing the cedar stairs was completed first.')
  const explainedReport = (await panel('stats', { sessionId: explained.session.id, projectKey: key })).lastRecall
  assert.deepEqual(explainedReport.questions.map(slot => slot.answerCoverage), ['covered', 'covered'])
  const reversed = await prepare(question, 'comparison-reversed')
  completeAnswer(handlers, reversed.session, 'You first bought the blue handrail, and then fixed the cedar stairs.')
  const reversedReport = (await panel('stats', { sessionId: reversed.session.id, projectKey: key })).lastRecall
  assert.deepEqual(reversedReport.questions.map(slot => slot.answerCoverage), ['unverified', 'unverified'])
  const other = await prepare(question, 'other-same-name', { header: { cwd: otherCwd } })
  assert.match(other.block, /\[Verified event order\].*buying the blue handrail/iu)
  const target = lastRecall.questions[1].injected[0]
  await panel('removeMemory', { id: target.id, scope: 'project', projectKey: key })
  assert.equal((await panel('stats', { sessionId: turn.session.id, projectKey: key })).lastRecall, null)
  const missing = await prepare(question, 'comparison-missing')
  assert.doesNotMatch(missing.block, /proposal|painted|workshop|\[Verified event order\]/u)
  const report = (await panel('stats', { sessionId: missing.session.id, projectKey: key })).lastRecall
  assert.deepEqual(report.questions.map(slot => slot.injected.length), [0, 0])
})

test('two dated returns do not prove the order of the named events', async t => {
  const { dataDir, key, prepare, panel, handlers } = await setup(t)
  const originals = new Map()
  for (const [sessionId, text, date] of [
    ['lecture', "Today, I have just got back from Rana's lecture.", '2026-08-02T05:00:00Z'],
    ['workshop', "I returned from Rui's workshop on August 4, 2026.", '2026-08-04T05:00:00Z'],
  ]) {
    const at = Date.parse(date)
    const source = saveSource(dataDir, { projectKey: key, sessionId, messageId: 'activity', text, role: 'user',
      sourceKind: 'user', at, eventTime: at, timeZone: 'Asia/Shanghai' })
    assert.ok(grantSourceRecall(dataDir, readSource(dataDir, source.id), key))
    originals.set(source.id, { excerpt: text, eventTime: at })
  }
  const turn = await prepare("Which event happened first, Rana's lecture or Rui's workshop?", 'both-returns')
  assert.equal(turn.block, 'There is not enough dated evidence to determine the order of the two events.')
  assert.doesNotMatch(turn.block, /today|August 4|2026-08-0[24]|got back|returned from|\[Verified event order\]/iu)
  completeAnswer(handlers, turn.session, 'I cannot determine which event came first from the available evidence.')
  const { lastRecall } = await panel('stats', { sessionId: turn.session.id, projectKey: key })
  assert.deepEqual(lastRecall.questions.map(slot => slot.answerCoverage), ['not-injected', 'not-injected'])
  assert.ok(lastRecall.questions.every(slot => slot.calendar === null && slot.injected.length === 0))
  const related = lastRecall.questions.flatMap(slot => slot.notInjected.flatMap(hit => hit.sourceRefs))
  assert.deepEqual(new Map(related.map(ref => [ref.sourceId, { excerpt: ref.excerpt, eventTime: ref.eventTime }])), originals)
})

test('open museum chronology finds dated visits without named options or cross-project evidence', async t => {
  const { dataDir, key, cwd, prepare, panel, handlers } = await setup(t)
  const foreign = projectIdentity(join(cwd, '..', 'outside', 'project')).key
  const seed = (sessionId, text, date, projectKey = key) => {
    const at = Date.parse(date + 'T13:00:00Z')
    const original = saveSource(dataDir, { projectKey, sessionId, messageId:'visit', text, role:'user',
      sourceKind:'user', at, eventTime:at, timeZone:'UTC' })
    assert.ok(grantSourceRecall(dataDir, readSource(dataDir, original.id), projectKey))
    return original.id
  }
  const alder = seed('spring-visit', 'I visited the Alder Museum today with my family.', '2026-04-07')
  const birch = seed('tour', "I saw it in person yesterday at the Birch Museum of Art's exhibition.", '2026-05-10')
  const orchid = seed('guided', 'I am planning to visit the Orchid Museum again soon. I attended their guided tour today.', '2026-06-11')
  seed('plan', 'I am planning to visit the West Museum next week.', '2026-06-11')
  seed('negative', 'I never visited the South Museum.', '2026-03-01')
  seed('someone-else', 'My friend visited the Echo Museum today.', '2026-05-03')
  seed('photo', 'I saw a photograph of the Frame Museum today.', '2026-05-03')
  seed('quoted', 'Here is a line from a book. "I visited the Ink Museum today".', '2026-05-03')
  seed('future', 'I visited the Clock Museum tomorrow.', '2026-05-03')
  seed('online', "I attended the Cedar Museum's online tour today.", '2026-05-03')
  seed('foreign-museum', 'I visited the Remote Museum today.', '2026-01-05', foreign)
  const question = 'What is the order of the three museums I visited from earliest to latest?'
  const turn = await prepare(question, 'open-museum-order')
  assert.match(turn.block, /Verified order of recorded museum visits/u)
  assert.match(turn.block, /Alder Museum \(2026-04-07\)[\s\S]+Birch Museum of Art \(2026-05-09\)[\s\S]+Orchid Museum \(2026-06-11\)/u)
  assert.doesNotMatch(turn.block, /(?:West|South|Echo|Frame|Ink|Clock|Cedar|Remote) Museum/u)
  assert.deepEqual(turn.result.messages.map(message => message.source?.kind), ['memory','user'])
  completeAnswer(handlers, turn.session, 'Alder Museum, then Birch Museum of Art, then Orchid Museum.')
  const { lastRecall } = await panel('stats', { sessionId:turn.session.id, projectKey:key })
  assert.equal(lastRecall.questions[0].answerCoverage, 'covered')
  const injected = lastRecall.questions[0].injected
  assert.deepEqual(new Set(injected.flatMap(item => item.sourceRefs.map(ref => ref.sourceId))), new Set([alder,birch,orchid]))
  assert.ok(injected.every(item=>turn.block.includes(item.text)))
  for (const answer of [
    'Alder Museum, then Birch Museum of Art, then Orchid Museum. Orchid Museum was before Alder Museum.',
    'Alder Museum (2026-04-08), then Birch Museum of Art (2026-05-09), then Orchid Museum (2026-06-11).',
  ]) {
    const next = await prepare(question, 'open-museum-unsupported')
    completeAnswer(handlers, next.session, answer)
    const result = await panel('stats', { sessionId:next.session.id, projectKey:key })
    assert.equal(result.lastRecall.questions[0].answerCoverage, 'unverified')
  }

  const forgotten = injected.find(item=>item.sourceRefs.some(ref=>ref.sourceId===birch))
  assert.equal((await panel('removeMemory',{id:forgotten.id,scope:'project',projectKey:key})).status,'deleted')
  assert.equal((await panel('stats',{sessionId:turn.session.id,projectKey:key})).lastRecall,null)
  const next = await prepare(question, 'open-museum-after-forget')
  assert.match(next.block,/evidence does not establish the full order/iu)
  assert.doesNotMatch(next.block,/Birch Museum|Remote Museum/u)
})

test('open trip chronology preserves repeated dated trips and keeps return bounds uncertain', async t => {
  const { dataDir, key, prepare, panel, handlers } = await setup(t)
  const add = (sessionId, text, stamp) => {
    const at = Date.parse(stamp + 'T08:00:00Z')
    const source = saveSource(dataDir,{projectKey:key,sessionId,messageId:'trip',text,role:'user',sourceKind:'user',
      at,eventTime:at,timeZone:'UTC'})
    assert.ok(grantSourceRecall(dataDir,readSource(dataDir,source.id),key))
    return source.id
  }
  const first = add('early', 'I took a road trip to Cedar Valley today.', '2026-02-11')
  add('ack', 'Yesterday I took a road trip to Cedar Valley.', '2026-02-12')
  const later = add('late', 'I took a road trip to Cedar Valley today.', '2026-06-02')
  const unknown = add('returned', 'I just got back from a day hike to Pine Peak today.', '2026-04-03')
  add('planned', 'I want to go on a road trip to Slate Coast.', '2026-04-04')
  const turn = await prepare('What is the order of the three trips I took from earliest to latest?', 'open-trips')
  assert.match(turn.block, /evidence does not establish the full order/iu)
  assert.match(turn.block, /Cedar Valley \(2026-02-11\)[\s\S]+Cedar Valley \(2026-06-02\)/u)
  assert.match(turn.block, /Pine Peak \(date unknown\)/u)
  assert.doesNotMatch(turn.block,/Slate Coast|2026-04-03/u)
  completeAnswer(handlers, turn.session, 'First I went to Pine Peak, then Cedar Valley twice.')
  const { lastRecall } = await panel('stats',{sessionId:turn.session.id,projectKey:key})
  assert.equal(lastRecall.questions[0].answerCoverage,'unverified')
  const ids=new Set(lastRecall.questions[0].injected.flatMap(item=>item.sourceRefs.map(ref=>ref.sourceId)))
  assert.ok(ids.has(unknown) && ids.has(later) && ids.size===3)
  const bounded = lastRecall.questions[0].injected.find(item => item.sourceRefs.some(ref => ref.sourceId === unknown))
  assert.equal(bounded.eventPeriod, '≤ 2026-04-03')
  assert.ok(ids.has(first) || lastRecall.questions[0].hits.some(item=>item.sourceRefs.some(ref=>ref.sourceId===first)))
})

test('same-day Chinese event evidence does not infer an order from the messages', async t => {
  const { dataDir, key, prepare, handlers, panel } = await setup(t)
  for (const [sessionId, text, timestamp] of [
    ['earlier-message', '今天青岚验收会举行了。', '2026-04-18T01:00:00Z'],
    ['later-message', '今天水杉审查会举行了。', '2026-04-18T09:00:00Z'],
  ]) {
    const at = Date.parse(timestamp)
    const source = saveSource(dataDir, { projectKey: key, sessionId, messageId: 'event', text, role: 'user', sourceKind: 'user',
      at, eventTime: at, timeZone: 'Asia/Shanghai' })
    assert.ok(grantSourceRecall(dataDir, readSource(dataDir, source.id), key))
  }
  const checked = await prepare('青岚验收会和水杉审查会，哪个先发生？', 'same-day-chinese')
  assert.match(checked.block, /今天青岚验收会举行了/u)
  assert.match(checked.block, /今天水杉审查会举行了/u)
  assert.doesNotMatch(checked.block, /\[先后核对\]/u)
  completeAnswer(handlers, checked.session, '青岚验收会先发生。')
  const { lastRecall } = await panel('stats', { sessionId: checked.session.id, projectKey: key })
  assert.deepEqual(lastRecall.questions.map(item => item.answerCoverage), ['unverified', 'unverified'])
})

test('a purchase discount joins both amounts from the same receipt across sessions and withdraws after forgetting', async t => {
  const { dataDir, key, cwd, prepare, panel, handlers } = await setup(t)
  const seed = (sessionId, text, projectKey = key) => {
    const at = Date.parse('2026-09-01T13:00:00Z')
    const source = saveSource(dataDir, { sessionId, messageId: 'purchase', text, projectKey,
      role: 'user', sourceKind: 'user', at, eventTime: at, timeZone: 'UTC' })
    assert.ok(grantSourceRecall(dataDir, readSource(dataDir, source.id), projectKey))
    return source.id
  }
  const list = seed('list-price', 'The original price of Harbor Atlas on receipt BK-731 was $40.')
  const paid = seed('settled-price', 'I bought Harbor Atlas for $30 on receipt BK-731.')
  seed('other-item', 'The original price of River Atlas on receipt BK-731 was $63.')
  seed('two-items-one-sentence', 'I bought River Atlas for $72 on receipt BK-731 and showed Harbor Atlas to a friend.')
  seed('long-shipping-total', 'The shop was quiet. '.repeat(19) + 'I paid $30 for Harbor Atlas on receipt BK-731 including $4 of shipping.')
  seed('planned-buy', 'I might buy Harbor Atlas for $19 on receipt BK-731.')
  seed('other-project', 'I bought Harbor Atlas for $11 on receipt BK-731.', projectIdentity(join(cwd, 'other')).key)
  const prompt = 'What percentage discount did I get on Harbor Atlas?'
  const request = await prepare(prompt, 'discount-same-receipt')
  assert.match(request.block, /original price of Harbor Atlas on receipt BK-731 was \$40/u)
  assert.match(request.block, /bought Harbor Atlas for \$30 on receipt BK-731/u)
  assert.match(request.block, /\[Verified discount\].*25%/u)
  assert.doesNotMatch(request.block, /\$(?:63|19|11|72|4)\b/u)
  completeAnswer(handlers, request.session, 'The user bought Harbor Atlas for $30 on receipt BK-731, which was originally priced at $40. The discount was 25%.')
  const { lastRecall: report } = await panel('stats', { sessionId: request.session.id, projectKey: key })
  assert.equal(report.quantityCheck.result, '25')
  assert.equal(report.quantityCheck.answerCoverage, 'covered')
  assert.deepEqual(report.questions.map(part => part.answerCoverage), ['covered', 'covered'])
  const evidence = report.questions.flatMap(part => part.injected)
  assert.deepEqual(new Set(evidence.flatMap(item => item.sourceRefs.map(ref => ref.sourceId))), new Set([list, paid]))

  const incorrect = await prepare(prompt, 'discount-incorrect')
  completeAnswer(handlers, incorrect.session, 'The discount was 35%. I paid $30, and the original price was $40.')
  const { lastRecall: wrong } = await panel('stats', { sessionId: incorrect.session.id, projectKey: key })
  assert.equal(wrong.quantityCheck.answerCoverage, 'unverified')

  const unrelated = await prepare(prompt, 'discount-unrelated-percent')
  completeAnswer(handlers, unrelated.session, 'The sales tax was 25%.')
  const { lastRecall: wrongTopic } = await panel('stats', { sessionId: unrelated.session.id, projectKey: key })
  assert.equal(wrongTopic.quantityCheck.answerCoverage, 'unverified')

  const hit = evidence.find(item => item.sourceRefs.some(ref => ref.sourceId === list))
  await panel('removeMemory', { id: hit.id, scope: 'project', projectKey: key })
  assert.equal((await panel('stats', { sessionId: request.session.id, projectKey: key })).lastRecall, null)
  const after = await prepare(prompt, 'discount-after-forget')
  assert.match(after.block, /bought Harbor Atlas for \$30/u)
  assert.match(after.block, /\[Discount unconfirmed\]/u)
  assert.doesNotMatch(after.block, /\$40|\[Verified discount\]/u)
})

test('two purchases of the same item do not lend one another a price', async t => {
  const { dataDir, key, prepare, panel, handlers } = await setup(t)
  const at = Date.parse('2026-08-10T04:00:00Z')
  for (const [sessionId, text] of [
    ['first-order', '青岚旅行灯在订单 QL-102 的原价是 200 元。'],
    ['second-order', '我在订单 QL-202 买了青岚旅行灯，实际支付了 120 元。'],
  ]) {
    const source = saveSource(dataDir, { sessionId, messageId: 'purchase', text, projectKey: key,
      role: 'user', sourceKind: 'user', at, eventTime: at, timeZone: 'Asia/Shanghai' })
    assert.ok(grantSourceRecall(dataDir, readSource(dataDir, source.id), key))
  }
  const request = await prepare('青岚旅行灯的折扣百分比是多少？', 'discount-different-receipts')
  assert.match(request.block, /QL-102.*200 元/u)
  assert.match(request.block, /QL-202.*120 元/u)
  assert.match(request.block, /\[折扣待核对\]/u)
  assert.doesNotMatch(request.block, /\[折扣核对\]|40%/u)
  completeAnswer(handlers, request.session, '折扣是 40%。')
  const { lastRecall } = await panel('stats', { sessionId: request.session.id, projectKey: key })
  assert.equal(lastRecall.quantityCheck.result, null)
  assert.equal(lastRecall.quantityCheck.answerCoverage, 'no-evidence')

  const source = saveSource(dataDir, { sessionId: 'first-paid', messageId: 'purchase',
    text: '我在订单 QL-102 买了青岚旅行灯，实付 150 元。', projectKey: key,
    role: 'user', sourceKind: 'user', at, eventTime: at, timeZone: 'Asia/Shanghai' })
  assert.ok(grantSourceRecall(dataDir, readSource(dataDir, source.id), key))
  const specific = await prepare('青岚旅行灯在订单 QL-102 的折扣百分比是多少？', 'discount-selected-receipt')
  assert.match(specific.block, /\[折扣核对\].*25%/u)
  assert.doesNotMatch(specific.block, /QL-202|120 元/u)
})

test('a unique dated purchase ties a later description to its paid amount across sessions', async t => {
  const { dataDir, key, prepare, panel, handlers } = await setup(t)
  const at = Date.parse('2026-07-11T08:00:00Z')
  for (const [sessionId, eventSeq, text] of [
    ['shop-diary', 2, 'I paid $60 for the only Copper Ridge lantern I bought at Meridian Outfitters yesterday.'],
    ['lantern-review', 2, 'My only purchase at Meridian Outfitters yesterday was the Copper Ridge lantern.'],
    ['lantern-review', 4, 'It was originally priced at $80.'],
  ]) {
    const source = saveSource(dataDir, { sessionId, messageId: 'purchase-' + eventSeq, text, projectKey: key,
      role: 'user', sourceKind: 'user', at, eventTime: at, eventSeq, timeZone: 'Asia/Shanghai' })
    assert.ok(grantSourceRecall(dataDir, readSource(dataDir, source.id), key))
  }
  const request = await prepare('What percentage discount did I get on the Copper Ridge lantern?', 'discount-dated-purchase')
  assert.match(request.block, /\[Verified discount\].*25%/u)
  assert.match(request.block, /My only purchase at Meridian Outfitters yesterday was the Copper Ridge lantern/u)
  assert.match(request.block, /originally priced at \$80/u)
  assert.match(request.block, /paid \$60 for the only Copper Ridge lantern/u)
  completeAnswer(handlers, request.session, 'The discount was 25%.')
  const { lastRecall } = await panel('stats', { sessionId: request.session.id, projectKey: key })
  const bridge = lastRecall.questions.flatMap(item => item.injected).find(item => item.text.includes('My only purchase'))
  assert.ok(bridge)
  await panel('removeMemory', { id: bridge.id, scope: 'project', projectKey: key })
  assert.equal((await panel('stats', { sessionId: request.session.id, projectKey: key })).lastRecall, null)
  const after = await prepare('What percentage discount did I get on the Copper Ridge lantern?', 'discount-bridge-forgotten')
  assert.match(after.block, /paid \$60/u)
  assert.doesNotMatch(after.block, /\$80|\[Verified discount\]/u)
})

test('a previously recorded discount remains available when the original amounts were never stored', async t => {
  const { prepare } = await setup(t, [
    { id: 'mem_named_discount', content: 'I received a 15% discount on the North Reed field guide.' },
  ])
  const request = await prepare('What percentage discount did I get on the North Reed field guide?', 'discount-legacy-note')
  assert.match(request.block, /15% discount on the North Reed field guide/u)
})

test('a borrowing ceiling and final sale price keep their roles across original user turns', async t => {
  const { dataDir, key, cwd, prepare, panel, handlers } = await setup(t)
  const at = Date.parse('2026-09-07T09:00:00Z')
  const add = (sessionId, text, projectKey = key) => {
    const source = saveSource(dataDir, { sessionId, messageId: 'house', text, projectKey,
      role: 'user', sourceKind: 'user', at, eventTime: at, timeZone: 'Asia/Shanghai' })
    assert.ok(grantSourceRecall(dataDir, readSource(dataDir, source.id), projectKey))
    return source.id
  }
  const cap = add('mortgage', 'I received pre-approval for the Orchard House mortgage. The lender said I can borrow up to $625,000.')
  const sale = add('closing', 'I bought Orchard House last week. The final sale price was $585,000.')
  add('actual-debt', 'I actually borrowed $490,000 for Orchard House.')
  add('asking-price', 'The asking price of Orchard House was $680,000.')
  add('wrong-house', 'I bought Alder House. The final sale price was $450,000.')
  add('misleading-house', 'I mentioned Orchard House earlier. The final sale price for Alder House was $471,000 while Orchard House was still being discussed.')
  add('different-project', 'The final sale price of Orchard House was $317,000.', projectIdentity(join(cwd, 'other')).key)
  const query = 'How much more was the mortgage pre-approval amount for Orchard House than the final sale price of Orchard House?'
  const request = await prepare(query, 'loan-ceiling-sale')
  assert.match(request.block, /lender said I can borrow up to \$625,000/u)
  assert.match(request.block, /final sale price was \$585,000/u)
  assert.match(request.block, /Borrowing ceiling.*625,000/u)
  assert.match(request.block, /625000 − 585000 = \$40000/u)
  assert.doesNotMatch(request.block, /\$(?:490|680|450|471|317),000/u)
  completeAnswer(handlers, request.session, 'The pre-approval limit for Orchard House was $625,000. The final sale price of Orchard House was $585,000. The difference is $40,000.')
  const { lastRecall } = await panel('stats', { sessionId: request.session.id, projectKey: key })
  assert.equal(lastRecall.quantityCheck.result, '40000')
  assert.equal(lastRecall.quantityCheck.answerCoverage, 'covered')
  assert.deepEqual(lastRecall.questions.map(slot => slot.answerCoverage), ['covered', 'covered'])
  const quotes = lastRecall.questions.flatMap(slot => slot.injected)
  assert.deepEqual(new Set(quotes.flatMap(item => item.sourceRefs.map(ref => ref.sourceId))), new Set([cap, sale]))

  const comparative = await prepare(query, 'loan-ceiling-comparative-answer')
  completeAnswer(handlers, comparative.session, 'The final sale price was $40,000 lower than the mortgage pre-approval amount.')
  const { lastRecall: sameDifference } = await panel('stats', { sessionId: comparative.session.id, projectKey: key })
  assert.equal(sameDifference.quantityCheck.answerCoverage, 'covered')
  assert.deepEqual(sameDifference.questions.map(slot => slot.answerCoverage), ['unverified', 'unverified'])

  const wrong = await prepare(query, 'loan-ceiling-wrong-claim')
  completeAnswer(handlers, wrong.session, 'I actually borrowed $625,000 for Orchard House. The final sale price of Orchard House was $585,000.')
  const { lastRecall: incorrect } = await panel('stats', { sessionId: wrong.session.id, projectKey: key })
  assert.deepEqual(incorrect.questions.map(slot => slot.answerCoverage), ['unverified', 'covered'])

  const source = quotes.find(item => item.sourceRefs.some(ref => ref.sourceId === cap))
  await panel('removeMemory', { id: source.id, scope: 'project', projectKey: key })
  assert.equal((await panel('stats', { sessionId: request.session.id, projectKey: key })).lastRecall, null)
  const after = await prepare(query, 'loan-ceiling-forgotten')
  assert.match(after.block, /\$585,000/u)
  assert.doesNotMatch(after.block, /\$625,000|\$40,?000/u)
})

test('reach keeps an estimate and the other channel’s follower count in their own measures', async t => {
  const { dataDir, key, cwd, prepare, panel, handlers } = await setup(t)
  const at = Date.parse('2026-09-08T10:00:00Z')
  const add = (sessionId, text, projectKey = key) => {
    const source = saveSource(dataDir, { sessionId, messageId: 'marketing', text, projectKey,
      role: 'user', sourceKind: 'user', at, eventTime: at, timeZone: 'Asia/Shanghai' })
    assert.ok(grantSourceRecall(dataDir, readSource(dataDir, source.id), projectKey))
    return source.id
  }
  const reached = add('video-campaign', 'I want to run another YouTube ad campaign. What do you recommend? My previous ad campaign, which ran for five days, reached around 2,400 people.')
  const followers = add('mastodon-creator', 'I am working on Mastodon engagement. I collaborated with a creator who promoted my product to her 11,000 followers.')
  add('wrong-campaign', 'An unrelated campaign reached 8,001 people, and the YouTube ad campaign received good feedback.')
  add('foreign-reach', 'The Mastodon creator promotion reached 9,999 people.', projectIdentity(join(cwd, 'other')).key)
  const request = await prepare('What was the total number of people reached by my YouTube ad campaign and Mastodon creator promotion?', 'reach-different-measures')
  assert.match(request.block, /reached around 2,400 people/u)
  assert.match(request.block, /actual reach.*(?:unknown|no evidence)/iu)
  assert.doesNotMatch(request.block, /8,001|9,999|11,?000|13,?400/u)
  completeAnswer(handlers, request.session, 'The YouTube ad campaign reached exactly 2,400 people. The Mastodon creator promotion reached 11,000 people. The total reach is 13,400 people.')
  const { lastRecall } = await panel('stats', { sessionId: request.session.id, projectKey: key })
  assert.equal(lastRecall.quantityCheck.result, null)
  assert.equal(lastRecall.quantityCheck.answerCoverage, 'unverified')
  assert.deepEqual(lastRecall.questions.map(slot => slot.answerCoverage), ['unverified', 'unverified'])
  assert.match(lastRecall.missing[0], /Mastodon/u)
  assert.deepEqual(new Set(lastRecall.questions.flatMap(slot => slot.injected.flatMap(item => item.sourceRefs.map(ref => ref.sourceId)))), new Set([reached]))
  const related = lastRecall.questions.flatMap(slot => slot.hits).find(item => item.measure === 'followers')
  assert.equal(related.sourceRefs[0].sourceId, followers)
  assert.match(related.sourceRefs[0].excerpt, /11,000 followers/u)
  assert.equal(related.verified, false)
  const alone = await prepare('What was the total number of people reached by Mastodon creator promotion and Bay campaign?', 'reach-related-only')
  assert.match(alone.block, /Combined reach is unknown/u)
  assert.doesNotMatch(alone.block, /11,?000/u)
  await panel('removeMemory', { id: related.id, scope: 'project', projectKey: key })
  assert.equal((await panel('stats', { sessionId: request.session.id, projectKey: key })).lastRecall, null)
})

test('reach totals require explicit per-channel arithmetic, independent of unique audience size', async t => {
  const { prepare } = await setup(t, [
    { content: 'The Aurora campaign reached 600 people.' },
    { content: 'The Bay campaign reached 700 people.' },
  ])
  const audience = await prepare('What was the total number of people reached by the Aurora campaign and Bay campaign?', 'reach-audience')
  assert.match(audience.block, /600 people/u)
  assert.match(audience.block, /700 people/u)
  assert.doesNotMatch(audience.block, /\b1300\b/u)
  const reported = await prepare('What was the sum of the reported reach counts for the Aurora campaign and Bay campaign?', 'reach-channel-counts')
  assert.match(reported.block, /600 \+ 700 = 1300/u)
  assert.match(reported.block, /per-channel/iu)
})

test('named loan and sale roles keep Chinese amounts tied to the requested house', async t => {
  const { prepare, handlers, panel, key } = await setup(t, [
    { content: '青岚阁贷款预批额度为650000元。' },
    { content: '青岚阁实际成交价为570000元。' },
    { content: '青岚阁装修报价为43000元。' },
    { content: '海棠居实际成交价为480000元，同时讨论了青岚阁的交房安排。' },
  ])
  const request = await prepare('青岚阁贷款预批额度比青岚阁实际成交价高多少元？', 'loan-ceiling-chinese')
  assert.match(request.block, /获批借款上限.*650000元/u)
  assert.match(request.block, /650000 − 570000 = 80000元/u)
  assert.doesNotMatch(request.block, /43000元|480000元/u)
  completeAnswer(handlers, request.session, '青岚阁获批借款上限为650000元。青岚阁实际成交价为570000元。两者相差80000元。')
  const { lastRecall } = await panel('stats', { sessionId: request.session.id, projectKey: key })
  assert.deepEqual(lastRecall.questions.map(slot => slot.answerCoverage), ['covered', 'covered'])
  assert.equal(lastRecall.quantityCheck.answerCoverage, 'covered')
  const comparative = await prepare('青岚阁贷款预批额度比青岚阁实际成交价高多少元？', 'loan-ceiling-chinese-comparative')
  completeAnswer(handlers, comparative.session, '青岚阁贷款预批额度比青岚阁实际成交价高80000元。')
  const { lastRecall: sameDifference } = await panel('stats', { sessionId: comparative.session.id, projectKey: key })
  assert.equal(sameDifference.quantityCheck.answerCoverage, 'covered')
})

test('two named properties keep loan and sale amounts separate when the question leaves the property unnamed', async t => {
  const { prepare, handlers, panel, key } = await setup(t, [
    { content: 'The pre-approval amount for Alder House was $625,000.' },
    { content: 'The final sale price of Orchard House was $585,000.' },
  ])
  const request = await prepare('How much more was the mortgage pre-approval amount than the final sale price of the house?', 'loan-sale-different-properties')
  assert.match(request.block, /Alder House was \$625,000/u)
  assert.match(request.block, /Orchard House was \$585,000/u)
  assert.doesNotMatch(request.block, /625000 − 585000|40000/u)
  completeAnswer(handlers, request.session, 'The difference is $40,000.')
  const { lastRecall } = await panel('stats', { sessionId: request.session.id, projectKey: key })
  assert.equal(lastRecall.quantityCheck.result, null)
})

test('a conflicting user source prevents a scoped amount check from trusting a compact memory alone', async t => {
  const { prepare, dataDir, key, handlers, panel } = await setup(t, [
    { content: 'The pre-approval amount for Alder House was $625,000.' },
    { content: 'The final sale price of Alder House was $565,000.' },
  ])
  const source = saveSource(dataDir, { sessionId: 'other-preapproval', messageId: 'letter', projectKey: key,
    role: 'user', sourceKind: 'user', text: 'The pre-approval amount for Alder House was $598,000.' })
  assert.ok(grantSourceRecall(dataDir, readSource(dataDir, source.id), key))
  const request = await prepare('How much more was the pre-approval amount for Alder House than the final sale price of Alder House?', 'loan-sale-conflict')
  assert.match(request.block, /\$625,000/u)
  assert.match(request.block, /\$598,000/u)
  assert.match(request.block, /conflicting evidence/u)
  completeAnswer(handlers, request.session, 'The difference is $60,000.')
  const { lastRecall } = await panel('stats', { sessionId: request.session.id, projectKey: key })
  assert.equal(lastRecall.quantityCheck.result, null)
})

test('a calendar comparison keeps the requested year and rejects a date belonging to a different event', async t => {
  const trace = []
  const { ask, panel, warnings } = await setup(t, [
    { id: 'mem_calendar_left', kind: 'episode', content: '青岚立项会在2026年4月10日举行。' },
    { id: 'mem_calendar_old', kind: 'episode', content: '青岚立项会在2025年4月10日举行。' },
    { id: 'mem_calendar_right', kind: 'episode', content: '云湾验收会在2026年4月16日举行。' },
    { id: 'mem_calendar_mixed', kind: 'episode', content: '已讨论云湾验收会。山岩验收会在2026年4月20日举行。' },
  ], undefined, { recallObserver: event => trace.push(event) })
  const answer = await ask('从2026年的青岚立项会到2026年的云湾验收会，中间隔了几天？')
  assert.match(answer, /2026年4月10日/u, JSON.stringify({ warnings, trace }))
  assert.match(answer, /2026年4月16日/u)
  assert.doesNotMatch(answer, /2025年|4月20日/u)
  const report = (await panel('stats', { sessionId: 'session-integration' })).lastRecall
  assert.deepEqual(report.questions.map(item => item.injected.map(evidence => evidence.id)), [['mem_calendar_left'], ['mem_calendar_right']])
})

test('relative calendar recall uses the original client day and stops computing after forgetting', async t => {
  const { dataDir, key, panel, prepare } = await setup(t)
  const grant = (sessionId, text, timestamp = {}) => {
    const saved = saveSource(dataDir, { projectKey: key, sessionId, messageId: 'event',
      role: 'user', sourceKind: 'user', at: Date.UTC(2026, 1, 14, 15), text, ...timestamp })
    assert.ok(grantSourceRecall(dataDir, readSource(dataDir, saved.id), key, { remembered: true }))
    return saved.id
  }
  const sourceId = grant('shanghai-history', '昨天我完成了水杉检修。', {
    eventTime: Date.parse('2026-02-11T17:30:00Z'), timeZone: 'Asia/Shanghai',
  })
  grant('explicit-date-history', '紫藤巡检在2026年2月13日举行。')
  const legacyId = grant('history-without-zone', '昨天我完成了槐树检修。', { eventTime: Date.parse('2026-02-11T17:30:00Z') })
  const question = '水杉检修和紫藤巡检相隔几天？'
  const verified = await prepare(question, 'new-session-client-day')
  assert.match(verified.block, /2026-02-13 − 2026-02-11 = 2 天/u)
  const report = (await panel('stats', { sessionId: verified.session.id, projectKey: key })).lastRecall
  const original = report.questions.flatMap(item => item.injected).find(item => item.sourceRefs.some(ref => ref.sourceId === sourceId))
  assert.ok(original)
  assert.equal(original.sourceRefs[0].eventTime, Date.parse('2026-02-11T17:30:00Z'))
  assert.equal(original.sourceRefs[0].timeZone, 'Asia/Shanghai')
  assert.doesNotMatch((await prepare('槐树检修和紫藤巡检相隔几天？', 'unknown-client-day')).block, /\[日期差核对\]/u)
  assert.equal(readSource(dataDir, legacyId).text, '昨天我完成了槐树检修。')

  await panel('removeMemory', { id: original.id, scope: 'project', projectKey: key })
  assert.equal((await panel('stats', { sessionId: verified.session.id, projectKey: key })).lastRecall, null)
  const afterForget = await prepare(question, 'new-session-after-forget')
  assert.doesNotMatch(afterForget.block, /昨天我完成了水杉检修|\[日期差核对\]/u)
})

test('a relative date uses the clock on the matching clause and declines conflicting originals', () => {
  const excerpt = '昨天我完成了水杉检修。'
  const ref = { sourceId: 'original', role: 'user', sourceKind: 'user', excerpt,
    from: 0, to: excerpt.length, eventTime: Date.parse('2026-02-11T17:30:00Z'), timeZone: 'Asia/Shanghai' }
  const unrelated = { ...ref, sourceId: 'other', excerpt: '昨天我完成了桫椤点检。', eventTime: Date.parse('2026-02-12T17:30:00Z') }
  const record = { content: excerpt, sourceRefs: [unrelated, ref] }
  const expected = Date.UTC(2026, 1, 11) / 86_400_000
  assert.equal(calendarEventEvidence(record, '水杉检修').day, expected)
  assert.equal(calendarEventEvidence({ ...record, sourceRefs: [unrelated] }, '水杉检修'), null)
  assert.equal(calendarEventEvidence({ ...record, sourceRefs: [ref, { ...ref, sourceId: 'later', eventTime: unrelated.eventTime }] }, '水杉检修'), null)
})

test('a personal interval grounds both occurrences using their original client dates', async t => {
  const { dataDir, key, panel, prepare, handlers } = await setup(t)
  const add = (sessionId, text, date) => {
    const eventTime = Date.parse(date + 'T17:30:00Z')
    const saved = saveSource(dataDir, { sessionId, messageId: 'event', projectKey: key, text,
      role: 'user', sourceKind: 'user', at: eventTime, eventTime, timeZone: 'Asia/Shanghai' })
    assert.ok(grantSourceRecall(dataDir, readSource(dataDir, saved.id), key, { remembered: true }))
    return saved.id
  }
  const start = add('watering', 'By the way, I started watering my balcony herb garden every morning today.', '2023-03-21')
  const finish = add('harvest', 'I just harvested my first batch of fresh herbs from the balcony garden today.', '2023-04-14')
  add('other-owner', 'My neighbour harvested the first batch of fresh herbs from the balcony garden today.', '2023-04-09')
  add('plan', 'I planned to harvest the first batch of fresh herbs from the balcony garden today.', '2023-04-10')
  add('reported-action', 'I told my neighbour that she harvested the first batch of fresh herbs today.', '2023-04-12')
  add('date-of-different-action', 'I recently harvested my first batch of fresh herbs and cooked with them today.', '2023-04-13')
  const question = 'How many days passed between the day I started watering my balcony herb garden and the day I harvested my first batch of fresh herbs?'
  const turn = await prepare(question, 'personal-interval')
  assert.match(turn.block, /2023-04-15 − 2023-03-22 = 24 天/u)
  completeAnswer(handlers, turn.session, 'Twenty-four days passed.')
  const { lastRecall } = await panel('stats', { sessionId: turn.session.id, projectKey: key })
  assert.deepEqual(lastRecall.questions.map(slot => slot.answerCoverage), ['covered', 'covered'])
  assert.deepEqual(lastRecall.questions.map(slot => slot.injected.flatMap(hit => hit.sourceRefs.map(ref => ref.sourceId))), [[start], [finish]])
  await panel('removeMemory', { id: lastRecall.questions[0].injected[0].id, scope: 'project', projectKey: key })
  const forgotten = await prepare(question, 'personal-interval-forgotten')
  assert.doesNotMatch(forgotten.block, /\[日期差核对\]|started watering/u)
})

test('a personal date interval preserves a named recipient through appositive commas', async t => {
  const { dataDir, key, panel, prepare, handlers } = await setup(t)
  const add = (sessionId, text, date) => {
    const eventTime = Date.parse(date + 'T12:00:00Z')
    const saved = saveSource(dataDir, { sessionId, messageId: 'event', projectKey: key, text,
      role: 'user', sourceKind: 'user', at: eventTime, eventTime, timeZone: 'UTC' })
    assert.ok(grantSourceRecall(dataDir, readSource(dataDir, saved.id), key, { remembered: true }))
    return saved.id
  }
  const repotted = add('repot', 'By the way, I repot the previous spider plant today, and it looks happier.', '2023-03-04')
  const gift = add('gift', 'I gave my neighbor, Mrs. Johnson, a few cuttings from my spider plant today.', '2023-03-18')
  add('someone-else', 'I gave my neighbor, Ms. Webb, a few cuttings from my spider plant today.', '2023-03-11')
  add('other-action', 'I gave my neighbor, Mrs. Johnson, a few cuttings from my spider plant, and I picked up a watering can today.', '2023-03-17')
  add('reversed-gift', 'My neighbor, Mrs. Johnson, gave me a few cuttings from my spider plant today.', '2023-03-16')
  const question = 'How many days passed between the day I repotted the previous spider plant and the day I gave my neighbor, Mrs. Johnson, a few cuttings from my spider plant?'
  const turn = await prepare(question, 'dated-gift')
  assert.match(turn.block, /2023-03-18 − 2023-03-04 = 14 天/u)
  assert.match(turn.block, /I gave my neighbor, Mrs\. Johnson, a few cuttings from my spider plant today/u)
  assert.doesNotMatch(turn.block, /Ms\. Webb|watering can|gave me/u)
  completeAnswer(handlers, turn.session, 'Fourteen days passed.')
  const { lastRecall } = await panel('stats', { sessionId: turn.session.id, projectKey: key })
  assert.deepEqual(lastRecall.questions.map(slot => slot.answerCoverage), ['covered', 'covered'])
  assert.deepEqual(lastRecall.questions.map(slot => slot.injected.flatMap(hit => hit.sourceRefs.map(ref => ref.sourceId))), [[repotted], [gift]])
})

test('dated comparisons resolve offsets and purchases tied to calendar anchors', async t => {
  const at = Date.UTC(2023, 11, 10, 17, 17)
  t.mock.method(Date, 'now', () => at)
  const { dataDir, key, panel, prepare, handlers } = await setup(t)
  const add = (sessionId, text, projectKey = key) => {
    const saved = saveSource(dataDir, { sessionId, projectKey, messageId: 'main',
      role: 'user', sourceKind: 'user', at, eventTime: at, timeZone: 'UTC', text })
    assert.ok(grantSourceRecall(dataDir, readSource(dataDir, saved.id), projectKey, { remembered: true }))
    return saved.id
  }
  const market = add('market', "By the way, I attended the annual Holiday Market at the local mall a week before Black Friday, and I saw jewelry there, but I'm not sure if that's her style.")
  const phone = add('phone', 'I got my iPhone 13 Pro at a discounted price of $800 from a shop on Black Friday.')
  add('gift', 'I got my iPhone 13 Pro as a gift on Black Friday 2022.')
  add('wish', 'I wish I had bought my iPhone 13 Pro on Black Friday 2022.')
  add('dream', 'I dreamed that I bought my iPhone 13 Pro on Black Friday 2022.')
  add('rented-device', 'I got my iPhone 13 Pro from a rental shop for $25 on Black Friday 2022.')
  add('similar-device', 'I bought an iPhone 14 Pro on Black Friday 2022.')
  add('hypothetical', 'If I attended the Holiday Market two weeks before Black Friday, I could share a report.')
  add('unfulfilled-event', 'I wish I had attended the Holiday Market two weeks before Black Friday.')
  add('approximate', 'I attended the Holiday Market about two weeks before Black Friday.')
  add('fractional', 'I attended the Holiday Market 1.5 days before Black Friday.')
  add('future', 'I attended the Holiday Market a week before Black Friday 2024.')
  add('wrong-project', 'I attended the Holiday Market three days before Black Friday.',
    projectIdentity(join(dataDir, 'other-project')).key)
  add('explicit-offset', 'I attended the Cedar Workshop three days after November 15, 2023.')
  add('explicit-date', 'I bought the silver kettle on November 20, 2023.')
  add('explicit-holiday-year', 'I attended the Birch Meeting two days before Black Friday, 2022.')
  add('explicit-holiday-purchase', 'I bought the bronze lamp on November 25, 2022.')
  const question = 'How many days before I bought the iPhone 13 Pro did I attend the Holiday Market?'
  const result = await prepare(question, 'anchored-calendar')
  assert.match(result.block, /the Holiday Market was 7 days before the purchase of the iPhone 13 Pro/iu)
  assert.match(result.block, /a week before Black Friday/u)
  assert.doesNotMatch(result.block, /as a gift|iPhone 14|2024|two weeks|three days before/u)
  completeAnswer(handlers, result.session, 'Seven days.')
  const { lastRecall } = await panel('stats', { sessionId: result.session.id, projectKey: key })
  assert.deepEqual(lastRecall.questions.map(slot => slot.answerCoverage), ['covered', 'covered'])
  assert.deepEqual(lastRecall.questions.map(slot => slot.injected.flatMap(hit => hit.sourceRefs.map(ref => ref.sourceId))), [[market], [phone]])
  const reverse = await prepare(question, 'reversed-anchor-answer')
  completeAnswer(handlers, reverse.session, 'The purchase of the iPhone 13 Pro was seven days before the Holiday Market.')
  const reversed = (await panel('stats', { sessionId: reverse.session.id, projectKey: key })).lastRecall
  assert.deepEqual(reversed.questions.map(slot => slot.answerCoverage), ['unverified', 'unverified'])

  const offset = await prepare('How many days before I bought the silver kettle did I attend the Cedar Workshop?', 'explicit-anchor')
  assert.match(offset.block, /2023-11-20 − 2023-11-18 = 2 天/u)
  const year = await prepare('How many days before I bought the bronze lamp did I attend the Birch Meeting?', 'explicit-anchor-year')
  assert.match(year.block, /2022-11-25 − 2022-11-23 = 2 天/u)

  await panel('removeMemory', { id: lastRecall.questions[1].injected[0].id, scope: 'project', projectKey: key })
  assert.equal((await panel('stats', { sessionId: result.session.id, projectKey: key })).lastRecall, null)
  const forgotten = await prepare(question, 'anchored-after-forget')
  assert.doesNotMatch(forgotten.block, /discounted price|\[Verified date interval\]/u)
})

test('calendar comparisons expose conflicting dates without calculating a verified interval', async t => {
  const { dataDir, key, panel, prepare, handlers } = await setup(t)
  const events = [
    ['start-date-source', 'The Mendel kickoff took place on 2026-04-10.'],
    ['two-possible-dates-a', 'The Reed review is scheduled on 2026-04-16.'],
    ['two-possible-dates-b', 'The Reed review is scheduled on 2026-04-18.'],
  ]
  for (const [sessionId, text] of events) {
    const saved = saveSource(dataDir, { sessionId, messageId: 'main', projectKey: key, role: 'user', sourceKind: 'user', text })
    assert.ok(grantSourceRecall(dataDir, readSource(dataDir, saved.id), key, { remembered: true }))
  }
  const request = await prepare('How many days elapsed between the Mendel kickoff and the Reed review?', 'ambiguous-calendar')
  for (const date of ['2026-04-10', '2026-04-16', '2026-04-18']) assert.ok(request.block.includes(date))
  assert.doesNotMatch(request.block, /\[日期差核对\]/u)
  completeAnswer(handlers, request.session, 'They are six days apart.')
  const report = (await panel('stats', { sessionId: request.session.id, projectKey: key })).lastRecall
  assert.deepEqual(report.questions.map(item => item.answerCoverage), ['unverified', 'unverified'])
})

test('an elapsed-day answer joins the dated statement with its earlier named participant', async t => {
  const { dataDir, key, panel, prepare, handlers, warnings } = await setup(t)
  const question = 'How many days did it take to finish the intake review after starting to work with Livia?'
  const grant = (sessionId, eventSeq, content, projectKey = key) => {
    const saved = saveSource(dataDir, { projectKey, sessionId, messageId: `line-${eventSeq}`, eventSeq,
      role: 'user', sourceKind: 'user', at: Date.UTC(2026, 2, 2), text: content })
    assert.ok(grantSourceRecall(dataDir, readSource(dataDir, saved.id), projectKey, { remembered: true }))
    return saved.id
  }
  const anchor = grant('earlier-intake', 4, 'I have been working with an intake coordinator, Livia, on this trial.')
  const from = grant('earlier-intake', 8, 'I started working with her on 2/15.')
  const until = grant('review-date', 5, 'I finished the intake review on 3/1.')
  grant('unrelated-history', 3, 'I started working with her on 2/24.')
  grant('earlier-intake', 9, 'I am working with Daniel on other matters.')
  const foreign = projectIdentity(join(dataDir, 'another-project')).key
  grant('earlier-intake', 6, 'I am working with Rita on foreign account reviews.', foreign)
  const prepared = await prepare(question, 'calendar-linked-date')
  assert.match(prepared.block, /2026-03-01 − 2026-02-15 = 14 天/u, warnings.join('\n'))
  assert.match(prepared.block, /intake coordinator, Livia/u)
  assert.match(prepared.block, /started working with her on 2\/15/u)
  assert.doesNotMatch(prepared.block, /2\/24|Daniel|Rita/u)
  completeAnswer(handlers, prepared.session, 'It took fourteen days.')
  const report = (await panel('stats', { sessionId: prepared.session.id, projectKey: key })).lastRecall
  assert.deepEqual(report.questions.map(slot => slot.answerCoverage), ['covered', 'covered'])
  const sourceIds = slot => new Set(slot.injected.flatMap(hit => hit.sourceRefs.map(ref => ref.sourceId)))
  assert.deepEqual(sourceIds(report.questions[0]), new Set([anchor, from]))
  assert.deepEqual(sourceIds(report.questions[1]), new Set([until]))

  const ref = report.questions[0].injected.flatMap(hit => hit.sourceRefs).find(row => row.sourceId === anchor)
  await panel('removeMemory', { id: `source:${anchor}:${ref.from}:${ref.to}`, scope: 'project', projectKey: key })
  assert.equal((await panel('stats', { sessionId: prepared.session.id, projectKey: key })).lastRecall, null)
  const forgotten = await prepare(question, 'calendar-linked-date-after-forget')
  assert.doesNotMatch(forgotten.block, /\[日期差核对\]|2\/15|2\/24|Rita/u)
  assert.match(forgotten.block, /finished the intake review on 3\/1/u)
})

test('short dates and pronouns need a single defensible chronological reading', async t => {
  const { dataDir, cwd, panel, prepare } = await setup(t)
  const question = 'How many days did it take to finish the intake review after starting to work with Livia?'
  const cases = [
    { name: 'old-with-clock', earlier: { eventTime: Date.UTC(2026, 2, 1) }, later: { eventTime: Date.UTC(2026, 2, 2) }, days: 14 },
    { name: 'unknown-order' },
    { name: 'another-person', earlier: { eventSeq: 1 }, later: { eventSeq: 3 }, competing: 'I interviewed Alice for the partnership yesterday.' },
    { name: 'two-date-orders', earlier: { eventSeq: 1 }, later: { eventSeq: 3 }, from: '1/15', to: '3/4' },
  ]
  for (const { name, earlier, later, competing, from = '2/15', to = '3/1', days } of cases) {
    const project = join(cwd, name), projectKey = projectIdentity(project).key
    const add = (sessionId, messageId, text, chronology) => {
      const source = saveSource(dataDir, { sessionId, messageId, projectKey, text,
        role: 'user', sourceKind: 'user', at: Date.UTC(2026, 2, 2), ...chronology })
      assert.ok(grantSourceRecall(dataDir, readSource(dataDir, source.id), projectKey, { remembered: true }))
    }
    add(name, 'partner', 'I am working with Livia on the intake trial.', earlier)
    if (competing) add(name, 'competing', competing, { eventSeq: 2 })
    add(name, 'started', `I started working with her on ${from}.`, later)
    add(`${name}-review`, 'finished', `I finished the intake review on ${to}.`)
    const answer = await prepare(question, name, { header: { cwd: project } })
    const { lastRecall } = await panel('stats', { sessionId: name, projectKey })
    assert.equal(lastRecall.questions[0].calendar?.days, days, name)
    if (days !== undefined) assert.match(answer.block, /= 14 天/u)
    else assert.doesNotMatch(answer.block, /\[日期差核对\]|interviewed Alice/u)
    if (name === 'unknown-order' || name === 'another-person') assert.doesNotMatch(answer.block, /started working with her/u)
  }
  for (const content of ['I might have finished the intake review on 3/1.', 'I finished 3/4 of the intake review.']) {
    assert.equal(calendarEventEvidence({ content, observedAt: Date.UTC(2026, 2, 2) }, 'finish the intake review'), null)
  }
})

test('a high vector score cannot inject unrelated global memories for a physical-location question',async t=>{
  // Adversarial similarity exercises the policy boundary, not embedding quality.
  const engine={state:'ready',async embed(texts){return texts.map(()=>[1,...Array(383).fill(0)])},dispose(){}}
  const {ask,panel}=await setup(t,[{id:'mem_ui_preference',scope:'global',projectKey:null,kind:'preference',
    content:'用户要求界面设计先用可交互的 HTML demo 做方案预览，再落到真实面板。'},
    {id:'mem_unrelated_global',scope:'global',projectKey:null,kind:'fact',content:'用户今天要整理 Git 仓库。'}],undefined,{semantic:{enabled:true,engine}})
  assert.equal(await ask('雪松交接的备用物料盒放在哪里？'),'')
  assert.equal((await panel('stats',{scope:'global',sessionId:'session-integration'})).lastRecall.candidates.length,0)
})

test('answering a global preference cannot inject an unrelated or foreign project preference via the profile',async t=>{
  const {ask,panel}=await setup(t,[
    {id:'mem_unit_preference',kind:'preference',scope:'global',content:'我在所有项目都偏好用公制单位。',confidence:.90},
    {id:'mem_color_preference',kind:'preference',scope:'global',content:'我偏好用浅色背景。',confidence:.98},
    {id:'mem_foreign_preference',kind:'preference',projectKey:'other-project',content:'本项目的外发报告标题要用玉竹四号。',confidence:.99},
  ])
  const block=await ask('我的单位偏好是什么？')
  assert.match(block,/公制单位/u)
  assert.doesNotMatch(block,/玉竹四号|浅色背景/u)
  const report=(await panel('stats',{scope:'global',sessionId:'session-integration'})).lastRecall
  assert.deepEqual(report.covered.flatMap(item=>item.evidence.map(e=>e.id)),['mem_unit_preference'])
})

test('a preference question matches its requested category instead of the common wording around it',async t=>{
  const {ask,panel}=await setup(t,[
    {id:'mem_metric',kind:'preference',scope:'global',content:'我在所有项目都偏好用公制单位。'},
    {id:'mem_light_theme',kind:'preference',scope:'global',content:'我偏好用浅色背景。'},
  ])
  const block=await ask('我偏好用什么计量单位？请只给单位。不要保存或提炼本轮问答。')
  assert.match(block,/公制单位/u)
  assert.doesNotMatch(block,/浅色背景/u)
  const report=(await panel('stats',{scope:'global',sessionId:'session-integration'})).lastRecall
  assert.equal(report.total,1)
  assert.equal(report.covered.length,1)
})

test('an explicitly different project name blocks otherwise matching evidence while unnamed facts remain usable',async t=>{
  const query='霁海项目的离线构建识别码是什么？'
  const other=await setup(t,[{id:'mem_other_named_project',content:'夜航项目的离线构建识别码是云雀六号。'}])
  assert.equal(await other.ask(query),'')
  const same=await setup(t,[{id:'mem_same_named_project',content:'霁海工程的离线构建识别码是云雀六号。'}])
  assert.match(await same.ask(query),/云雀六号/u)
  const implicit=await setup(t,[{id:'mem_implicit_project',content:'离线构建识别码是云雀六号。'}])
  assert.match(await implicit.ask(query),/云雀六号/u)
})

test('semantic fallback carries each attempt through candidate fusion without a provider call',async t=>{
  const engine={state:'ready',modes:[],async embed(texts,mode){this.modes.push(mode);return texts.map(()=>[1,...Array(383).fill(0)])},dispose(){}}
  const {ask,warnings}=await setup(t,[{id:'mem_semantic_fallback',content:'交接工具的登记名称是雨燕七号。'}],undefined,
    {semantic:{enabled:true,engine}})
  const answer=await ask('紫杉巡检的备用代号是什么？')
  assert.ok(engine.modes.includes('query'),'the mock local query embedding reaches semantic recall')
  assert.match(answer,/雨燕七号/u)
  assert.ok(!warnings.some(message=>message.includes('query is not defined')),warnings.join('\n'))
})

test('direct lexical evidence without tags survives disabled and failed semantic recall',async t=>{
  for (const tags of [[], ['pnpm']]) {
    for (const semanticMode of ['disabled', 'failed']) {
      const engine={state:'ready',calls:0,async embed(){this.calls++;throw new Error('offline fixture')},dispose(){}}
      const {ask,warnings}=await setup(t,[{id:`mem_${tags.length}_${semanticMode}`,content:'会话 A 决定项目使用 pnpm 管理依赖',tags}],undefined,
        {semantic:{enabled:semanticMode==='failed',engine}})
      const answer=await ask('pnpm 依赖和 Node 版本')
      if (semanticMode === 'failed') assert.ok(engine.calls>0,'the missing Node slot exercises the unavailable semantic lane')
      else assert.equal(engine.calls,0)
      assert.match(answer,/pnpm 管理依赖/u,`tags=${JSON.stringify(tags)}, semantic=${semanticMode}`)
      assert.doesNotMatch(answer,/Node 版本要求是/u)
      assert.ok(!warnings.some(message=>message.includes('offline fixture')),warnings.join('\n'))
    }
  }
})

test('apply rechecks memory authority after passage embedding before persisting a vector', async t => {
  let begin, release
  const started = new Promise(resolve => { begin=resolve })
  const engine={state:'ready',async embed(texts,mode){
    if(mode==='passage') { begin();await new Promise(resolve=>{release=resolve}) }
    return texts.map(()=>[1,...Array(383).fill(0)])
  },dispose(){}}
  const {dataDir,key,panel,ask}=await setup(t,[{id:'mem_revoked_during_embedding',content:'夜航项目的离线构建识别码是云雀六号。'}],undefined,
    {semantic:{enabled:true,engine}})
  const pending=ask('霁海系统的版本追踪编号是多少？')
  try { await waitForStart(started, 'memory passage embedding') }
  catch (error) { release?.(); await pending; throw error }
  await panel('removeMemory',{id:'mem_revoked_during_embedding',scope:'project',projectKey:key})
  release()
  await pending
  assert.equal((await panel('stats',{scope:'project',projectKey:key,sessionId:'session-integration'})).lastRecall,null,
    'a recall already in progress cannot repopulate a report after forgetting')
  assert.equal(await ask('霁海系统的版本追踪编号是多少？'),'')
  const report=await panel('stats',{scope:'project',projectKey:key,sessionId:'session-integration'})
  assert.equal(report.semantic.total,0)
  assert.equal(report.semantic.indexed,0)
  assert.equal(existsSync(join(dataDir,'.cache','semantic','multilingual-e5-small-761b726-v1',key+'.jsonl')),false)
})

test('editing an unrelated record does not cancel another session recall already in flight', async t => {
  let begin, release
  const started = new Promise(resolve => { begin = resolve })
  const waiting = new Promise(resolve => { release = resolve })
  const engine = { state: 'ready', async embed(texts, mode) {
    if (mode === 'query') { begin(); await waiting }
    return texts.map(() => [1, ...Array(383).fill(0)])
  }, dispose() {} }
  const { key, panel, prepare, handlers } = await setup(t, [
    { id: 'mem_edit_during_recall', content: '无关记录的机房提示音是青鸟三声。' },
    { id: 'mem_recall_other_session', content: '青岚构建工具使用 Vite 8.4.2。' },
  ], undefined, { semantic: { enabled: true, engine } })

  const pending = prepare('青岚构建工具是什么版本？苍穹遥测服务的地区配置是什么？', 'session-other')
  try { await waitForStart(started, 'unrelated session query embedding') }
  catch (error) { release(); await pending; throw error }
  await panel('update', { id: 'mem_edit_during_recall', scope: 'project', projectKey: key,
    patch: { content: '无关记录的机房提示音现在是白鹭两声。' } })
  release()
  const prepared = await pending
  assert.match(prepared.block, /Vite 8\.4\.2/u)
  completeAnswer(handlers, prepared.session, '青岚构建工具使用 Vite 8.4.2。')
  const report = (await panel('stats', { scope: 'project', projectKey: key, sessionId: 'session-other' })).lastRecall
  assert.equal(report.outcome, 'completed')
  assert.match(report.questions[0].injected[0].text, /Vite 8\.4\.2/u)
})

test('apply rechecks source grants after passage embedding before persisting a vector', async t => {
  let begin, release
  const started = new Promise(resolve => { begin=resolve })
  const engine={state:'ready',async embed(texts,mode){
    if(mode==='passage') { begin();await new Promise(resolve=>{release=resolve}) }
    return texts.map(()=>[1,...Array(383).fill(0)])
  },dispose(){}}
  const {dataDir,key,ask}=await setup(t,[],undefined,{semantic:{enabled:true,engine}})
  const source=readSource(dataDir,saveSource(dataDir,{sessionId:'grant-session',projectKey:key,role:'user',sourceKind:'user',text:'值守证书的备用联系编号是木槿三号。'}).id)
  assert.equal(grantSourceRecall(dataDir,source,key),true,'the safe user fact must be granted before testing revocation')
  const pending=ask('值守证书的备用联系编号是什么？')
  try { await waitForStart(started, 'source passage embedding') }
  catch (error) { release?.(); await pending; throw error }
  unlinkSync(join(dataDir,'capture','recall-grants',key,source.id+'.json'))
  release()
  await pending
  assert.equal(await ask('值守证书的临时口令是什么？'),'')
  assert.equal(existsSync(join(dataDir,'.cache','semantic','multilingual-e5-small-761b726-v1',key+'.jsonl')),false)
})

test('a note imported through the activated panel is immediately recalled without a restart', async t => {
  const { root, key, panel, ask } = await setup(t, Array.from({ length: 64 }, (_, i) => ({
    id: `mem_other_${i}`, content: `无关设备的盘点编号为 OTHER-${i}。`,
  })))
  const vaultPath = join(root, 'vault'), folder = 'Notes', dest = join(vaultPath, folder, 'knowledge')
  mkdirSync(dest, { recursive: true })
  writeFileSync(join(dest, 'build.md'), `---\ndsh_knowledge: true\nscope: project\nprojectKey: ${key}\n---\n青岩构建配置\n\n青岩项目的构建工具使用 Vite 8.4.2。\n`)
  assert.equal((await panel('knowledgeSync', { direction: 'import', vaultPath, folder })).imported, 1)
  assert.match(await ask('青岩项目的构建工具是什么版本？'), /Vite 8\.4\.2/u)
})

test('long notes deliver the actual sentences for separate questions in the right project', async t => {
  const { root, dataDir, cwd, panel, ask } = await setup(t)
  const otherCwd = join(root, 'other', 'project')
  mkdirSync(cwd, { recursive: true })
  mkdirSync(otherCwd, { recursive: true })
  const { key } = projectIdentity(cwd), { key: otherKey } = projectIdentity(otherCwd)
  assert.notEqual(key, otherKey)
  const vaultPath = join(root, 'vault'), folder = 'Notes', dir = join(vaultPath, folder, 'knowledge')
  mkdirSync(dir, { recursive: true })
  const padding = '交接内容已核对，相关批次另存附件。\n'.repeat(2700)
  const clock = '海雾快照每天 03:47 执行。'
  const retention = '海雾快照保留 39 天。'
  const reason = '海雾快照更改时间，是为了避开每周归档的磁盘峰值。'
  const makeNote = (file, projectKey, title, body) => writeFileSync(join(dir, file),
    ['---', 'dsh_knowledge: true', 'scope: project', 'projectKey: ' + projectKey,
      '---', title, '', body].join('\n'))
  makeNote('operator.md', key, '# 海雾快照几点执行、保留多久', [padding, clock, '附录校验已完成。', retention].join('\n'))
  makeNote('appendix.md', key, '# 四月并行任务记录', padding + reason)
  makeNote('another-operator.md', otherKey, '# 海雾快照', '海雾快照每天 18:23 执行，保留 66 天，因为另一台机房没有夜间值班。')
  assert.equal((await panel('knowledgeSync', { direction: 'import', vaultPath, folder })).imported, 3)
  assert.ok(existsSync(join(dataDir, 'knowledge', 'appendix.md')))

  const question = '海雾快照每天几点执行、保留多久、为什么改时间？'
  const result = await ask(question, 'long-notes-main')
  const report = (await panel('stats', { scope: 'project', projectKey: key, sessionId: 'long-notes-main' })).lastRecall
  assert.deepEqual(report.questions.map(item => item.detail), ['clock', 'retention', 'reason'])
  for (const [index, sentence] of [clock, retention, reason].entries()) {
    assert.ok(result.includes(sentence), 'missing source sentence: ' + sentence + '\n' + result)
    assert.ok(report.questions[index].injected.some(evidence => evidence.text.includes(sentence)))
  }
  assert.doesNotMatch(result, /18:23|66 天|交接内容已核对/u)
  const other = await ask(question, 'long-notes-other', { header: { cwd: otherCwd } })
  assert.match(other, /18:23.*66 天/u)
  assert.doesNotMatch(other, /03:47|39 天|每周归档/u)
})

test('a Markdown table grounds retention in the named row and retention column', async t => {
  let selectedEmptyRow = false
  const llm = { async *stream(request) {
    const content = request.messages.at(-1).content
    const text = typeof content === 'string' ? content : content.map(part => part.text ?? '').join('')
    const data = JSON.parse(text.slice(text.indexOf('{"query"')))
    const candidate = data.candidates.find(item => item.id === 'note:operations.md' && item.content.includes('旧手册曾写保留 85 天'))
    const selections = []
    if (candidate) {
      selectedEmptyRow = true
      selections.push({ slot: 0, id: candidate.id, revision: candidate.revision, quote: '旧手册曾写保留 85 天' })
    }
    yield { type: 'text-delta', text: JSON.stringify({ selections }) }
    yield { type: 'finish', reason: { kind: 'stop' }, usage: { inputTokens: 250, outputTokens: 30, totalTokens: 280 } }
  } }
  const { root, key, panel, ask, prepare, handlers } = await setup(t, [], llm)
  const vaultPath = join(root, 'vault'), folder = 'Notes', dir = join(vaultPath, folder, 'knowledge')
  mkdirSync(dir, { recursive: true })
  const header = '| 任务 | 每日执行时间 | 保留期限 | 调整原因 |'
  const row = '| 雾舟快照 | 06:17 | 37 天 | 避开清晨的镜像写盘峰值 |'
  writeFileSync(join(dir, 'operations.md'), [
    '---', 'dsh_knowledge: true', 'scope: project', `projectKey: ${key}`, '---', '# 机房交接手册', '',
    header, '| --- | --- | --- | --- |', row,
    '| 启岚快照 | 19:24 | 74 天 | 错开主库迁移 |',
    '| 雪帆快照 | 08:13 | | 旧手册曾写保留 85 天，待值班确认 |', '',
  ].join('\n'))
  assert.equal((await panel('knowledgeSync', { direction: 'import', vaultPath, folder })).imported, 1)
  const { block, session } = await prepare('雾舟快照每天几点执行、保留多久、为什么改时间？', 'table-note')
  completeAnswer(handlers, session, '雾舟快照每天执行时间是06:17，保留期限是37天，改时间的原因是避开清晨的镜像写盘峰值。')
  const report = (await panel('stats', { scope: 'project', projectKey: key, sessionId: 'table-note' })).lastRecall
  assert.deepEqual(report.questions.map(item => item.detail), ['clock', 'retention', 'reason'])
  for (const item of report.questions) {
    assert.ok(item.injected.some(evidence => evidence.text.includes(row) && evidence.text.includes(header)), item.detail)
    assert.equal(item.answerCoverage, 'covered', item.detail)
  }
  assert.doesNotMatch(block, /19:24|74 天|85 天/u)
  await ask('雪帆快照保留多久？', 'table-empty')
  const absent = (await panel('stats', { scope: 'project', projectKey: key, sessionId: 'table-empty' })).lastRecall
  assert.equal(selectedEmptyRow, true)
  assert.equal(absent.questions[0].injected.length, 0)
})

test('different current values from the same project are delivered and assessed as a conflict', async t => {
  const linkedId = 'mem_yanbei_provenance'
  const { root, dataDir, key, panel, prepare, handlers } = await setup(t, [
    { id: linkedId, content: '值班交接手册的登记来源已核对。' },
  ])
  const vaultPath = join(root, 'vault'), folder = 'Notes', dir = join(vaultPath, folder, 'knowledge')
  mkdirSync(dir, { recursive: true })
  const other = projectIdentity(join(root, 'other', 'project')).key
  const write = (file, projectKey, title, text, linked) => writeFileSync(join(dir, file), [
    '---', 'dsh_knowledge: true', 'scope: project', `projectKey: ${projectKey}`,
    ...(linked ? [`memoryId: ${linked}`] : []), '---', `# ${title}`, '## 当前设置', text, '',
  ].join('\n'))
  write('runbook-a.md', key, '雁背快照', '雁背快照每天 04:37 执行，保留 37 天。', linkedId)
  write('runbook-b.md', key, '周例会交接附件', '雁背快照每天 05:42 执行，保留 45 天。')
  write('runbook-other.md', other, '雁背快照值班交接单', '雁背快照每天 21:36 执行，保留 59 天。')
  assert.equal((await panel('knowledgeSync', { direction: 'import', vaultPath, folder })).imported, 3)
  const question = '雁背快照目前每天几点执行、保留多久？'
  const last = async sessionId => (await panel('stats', { scope: 'project', projectKey: key, sessionId })).lastRecall
  const accepted = await prepare(question, 'note-conflict-both')
  assert.match(accepted.block, /现行来源不一致/u)
  for (const value of ['04:37', '05:42', '37 天', '45 天']) assert.ok(accepted.block.includes(value), value)
  assert.doesNotMatch(accepted.block, /21:36|59 天/u)
  completeAnswer(handlers, accepted.session, '两份现行来源不一致，执行时间分别为04:37和05:42，保留期限分别为37天和45天，当前值需确认。')
  const report = await last('note-conflict-both')
  assert.deepEqual(report.questions.map(item => item.detail), ['clock', 'retention'])
  for (const item of report.questions) {
    assert.equal(item.valueConflict, true)
    assert.deepEqual(item.injected.map(evidence => evidence.noteFile).sort(), ['runbook-a.md', 'runbook-b.md'])
    assert.equal(item.answerCoverage, 'covered')
  }

  const one = await prepare(question, 'note-conflict-picked')
  completeAnswer(handlers, one.session, '雁背快照当前每天04:37执行，保留37天。')
  assert.ok((await last('note-conflict-picked')).questions.every(item => item.answerCoverage === 'unverified'))
  const contradicted = await prepare(question, 'note-conflict-picked-after-noting')
  completeAnswer(handlers, contradicted.session,
    '两份记录不一致，写的是04:37和05:42，分别保留37天和45天。我确认现行是05:42，保留45天。')
  assert.ok((await last('note-conflict-picked-after-noting')).questions.every(item => item.answerCoverage === 'unverified'))

  await panel('updateSettings', { injectMaxTokens: 100 })
  const limited = await prepare(question, 'note-conflict-limited')
  assert.doesNotMatch(limited.block, /04:37|05:42|37 天|45 天/u)
  const omitted = await last('note-conflict-limited')
  assert.ok(omitted.questions.every(item => item.valueConflict === true && item.injected.length === 0 && item.notInjected.length === 2))

  await panel('updateSettings', { injectMaxTokens: 420 })
  const hidden = join(dataDir, 'knowledge', 'runbook-b.md')
  writeFileSync(hidden, readFileSync(hidden, 'utf8').replace('05:42', '05:55'))
  const changed = await prepare(question, 'note-conflict-edited')
  assert.match(changed.block, /05:55/u)
  assert.match(changed.block, /04:37/u)
  assert.doesNotMatch(changed.block, /05:42/u)

  assert.equal((await panel('removeMemory', { id: linkedId, scope: 'project', projectKey: key })).status, 'deleted')
  assert.equal(await last('note-conflict-both'), null)
  const fresh = await prepare(question, 'note-conflict-forgotten')
  assert.match(fresh.block, /05:55/u)
  assert.doesNotMatch(fresh.block, /04:37|现行来源不一致/u)
})

test('matching notation, different schedules and explicitly excluded values do not create a conflict', async t => {
  const { root, key, panel, prepare } = await setup(t)
  const vaultPath = join(root, 'vault'), folder = 'Notes', dir = join(vaultPath, folder, 'knowledge')
  mkdirSync(dir, { recursive: true })
  const write = (file, section, time) => writeFileSync(join(dir, file), [
    '---', 'dsh_knowledge: true', 'scope: project', `projectKey: ${key}`, '---', '# 池松快照交接',
    `## ${section}`, `池松快照每天 ${time} 执行。`, '',
  ].join('\n'))
  write('weekday-a.md', '工作日', '4:09')
  write('weekday-b.md', '工作日', '04:09')
  write('weekend.md', '周末', '19:20')
  for (const [index, time] of ['03:18', '06:42'].entries()) {
    writeFileSync(join(dir, `excluded-${index}.md`), [
      '---', 'dsh_knowledge: true', 'scope: project', `projectKey: ${key}`, '---', '# 雨港快照',
      '## 当前设置', `雨港快照不会在 ${time} 执行。`, '',
    ].join('\n'))
  }
  assert.equal((await panel('knowledgeSync', { direction: 'import', vaultPath, folder })).imported, 5)
  const { block } = await prepare('池松快照目前每天几点执行？', 'note-clock-schedule')
  assert.match(block, /4:09|19:20/u)
  assert.doesNotMatch(block, /现行来源不一致/u)
  const report = (await panel('stats', { sessionId: 'note-clock-schedule', scope: 'project', projectKey: key })).lastRecall
  assert.ok(!report.questions[0].valueConflict)
  const excluded = await prepare('雨港快照目前每天几点执行？', 'note-clock-excluded')
  assert.doesNotMatch(excluded.block, /现行来源不一致/u)
})

test('an unqualified schedule question uses current note sections and skips retired settings', async t => {
  const { root, key, panel, prepare } = await setup(t)
  const vaultPath = join(root, 'vault'), folder = 'Notes', dir = join(vaultPath, folder, 'knowledge')
  mkdirSync(dir, { recursive: true })
  const write = (file, title, sections) => writeFileSync(join(dir, file), [
    '---', 'dsh_knowledge: true', 'scope: project', `projectKey: ${key}`, '---', `# ${title}`, ...sections, '',
  ].join('\n'))
  write('backup.md', '苔岬冷备', [
    '## 旧版配置', '苔岬冷备每天 03:41 执行。',
    '## 本期规则', '苔岬冷备每天 06:53 执行。',
  ])
  write('retired.md', '北汊备份', ['## V1（已作废）', '北汊备份每天 19:27 执行。'])
  assert.equal((await panel('knowledgeSync', { direction: 'import', vaultPath, folder })).imported, 2)
  const current = await prepare('苔岬冷备每天几点执行？', 'unqualified-current')
  assert.match(current.block, /苔岬冷备每天 06:53 执行/u)
  assert.doesNotMatch(current.block, /03:41|现行来源不一致/u)
  const retired = await prepare('北汊备份每天几点执行？', 'unqualified-retired')
  assert.doesNotMatch(retired.block, /19:27/u)
  const { lastRecall } = await panel('stats', { sessionId: retired.session.id, scope: 'project', projectKey: key })
  assert.deepEqual(lastRecall.questions[0].injected, [])
  assert.match((await panel('knowledgeNote', { file: 'backup.md' })).body, /03:41/u)
})

test('one note supplies distinct historical and current evidence for each question', async t => {
  const { root, key, panel, prepare, handlers } = await setup(t)
  const vaultPath = join(root, 'vault'), folder = 'Notes', dir = join(vaultPath, folder, 'knowledge')
  mkdirSync(dir, { recursive: true })
  const write = (file, title, sections) => writeFileSync(join(dir, file), [
    '---', 'dsh_knowledge: true', 'scope: project', `projectKey: ${key}`, '---', `# ${title}`, ...sections, '',
  ].join('\n'))
  const previous = 'Atlas 快照每天 01:42 执行。'
  const current = 'Atlas 快照每天 05:27 执行。'
  const reason = 'Atlas 快照调整执行时间是因为要避开主库校验窗口。'
  write('schedule.md', 'Atlas 快照', [
    '## 旧版配置', previous, '## 维护记录', '附录只记工作台编号。\n'.repeat(600),
    '## 现行规则', current, reason,
  ])
  write('old-policies.md', '海雾日志', [
    '## V1（已停用）', '海雾日志每天 07:12 执行。',
    '## 旧版规则', '海雾日志每天 04:36 执行。',
    '## 现行配置', '海雾日志每天 09:41 执行。',
  ])
  assert.equal((await panel('knowledgeSync', { direction: 'import', vaultPath, folder })).imported, 2)
  const result = await prepare('Atlas 快照原来每天几点执行、现在每天几点执行，为什么改？', 'mixed-note-versions')
  for (const quote of [previous, current, reason]) assert.ok(result.block.includes(quote), result.block)
  const stats = async sessionId => (await panel('stats', { scope: 'project', projectKey: key, sessionId })).lastRecall
  const report = await stats(result.session.id)
  assert.deepEqual(report.questions.map(question => question.detail), ['clock', 'clock', 'reason'])
  for (const [index, quote] of [previous, current, reason].entries()) {
    const text = report.questions[index].injected.map(item => item.text).join('\n')
    assert.ok(text.includes(quote), text)
    for (const other of [previous, current, reason].filter(item => item !== quote)) assert.ok(!text.includes(other), text)
  }
  completeAnswer(handlers, result.session, '旧版是 05:27。现在是 01:42。原因是要避开主库校验窗口。')
  const wrong = await stats(result.session.id)
  assert.deepEqual(wrong.questions.map(question => question.answerCoverage), ['unverified', 'unverified', 'covered'])
  const historic = await prepare('Atlas 快照上一版每天几点执行？', 'one-old-note')
  assert.match(historic.block, /01:42/u)
  assert.doesNotMatch(historic.block, /05:27/u)
  const dated = await prepare('Atlas 快照在 2025-03-02 每天几点执行？', 'unknown-note-date')
  assert.doesNotMatch(dated.block, /01:42|05:27/u)
  const ambiguous = await prepare('海雾日志上一版每天几点执行？', 'ambiguous-prior-note')
  assert.doesNotMatch(ambiguous.block, /07:12|04:36|09:41/u)
})

test('semantic knowledge lookup ranks present clauses without obsolete and example text', async t => {
  const indexed = []
  const current = 'Supplier substitution requires written authorization from finance.'
  const old = 'Vendor replacement uses verbal sign-off from purchasing.'
  const example = 'Vendor replacement uses a rubber stamp in this example.'
  const makeVector = score => [score, Math.sqrt(1 - score ** 2), ...Array(382).fill(0)]
  const engine = { state: 'ready', async embed(texts, mode) {
    if (mode === 'query') return texts.map(() => makeVector(1))
    indexed.push(...texts)
    await new Promise(resolve => setTimeout(resolve, 40))
    return texts.map(text => makeVector(text.includes(old) ? 1 : text.includes(current) ? 0.9 : 0))
  }, dispose() {} }
  const { root, key, panel, prepare } = await setup(t, [], undefined, { semantic: { enabled: true, engine } })
  const vaultPath = join(root, 'vault'), folder = 'Notes', dir = join(vaultPath, folder, 'knowledge')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'handover.md'), [
    '---', 'dsh_knowledge: true', 'scope: project', `projectKey: ${key}`, '---', '# Handover handbook',
    '## Retired policy', old, '## Physical storage',
    ...Array.from({ length: 20 }, (_, index) => `Shelf ${index} contains field kits and packing dividers.`),
    '\x60\x60\x60text', example, '\x60\x60\x60', '## Approved procedure', current, '',
  ].join('\n'))
  assert.equal((await panel('knowledgeSync', { direction: 'import', vaultPath, folder })).imported, 1)
  const query = 'How should we get sign-off when replacing a vendor?'
  const result = await prepare(query, 'semantic-current-section')
  assert.ok(!indexed.some(text => text.includes(old) || text.includes(example)), indexed.join('\n'))
  assert.ok(indexed.includes(current))
  assert.ok(result.block.includes(current), result.block)
  assert.doesNotMatch(result.block, /verbal sign-off|rubber stamp/u)
  const { lastRecall } = await panel('stats', { sessionId: result.session.id, scope: 'project', projectKey: key })
  assert.equal(lastRecall.questions[0].injected[0].noteFile, 'handover.md')
  assert.equal(lastRecall.questions[0].injected[0].verified, false)
})

test('a selected clock from another named task cannot cover a retired-only question', async t => {
  const wrong = '栎叶备份每天 07:26 执行。'
  let returnedSelection = false
  const llm = { async *stream(request) {
    const content = request.messages.at(-1).content
    const text = typeof content === 'string' ? content : content.map(part => part.text ?? '').join('')
    const payload = JSON.parse(text.slice(text.indexOf('{"query"')))
    const match = payload.candidates.find(item => item.id === 'note:unrelated.md' && item.content.includes(wrong))
    const selections = match ? [{ slot: 0, id: match.id, revision: match.revision, quote: wrong }] : []
    returnedSelection ||= selections.length === 1
    yield { type: 'text-delta', text: JSON.stringify({ selections }) }
    yield { type: 'finish', reason: { kind: 'stop' }, usage: { inputTokens: 220, outputTokens: 30, totalTokens: 250 } }
  } }
  const engine = { state: 'ready', async embed(texts) {
    return texts.map(() => [1, ...Array(383).fill(0)])
  }, dispose() {} }
  const { root, key, panel, prepare, handlers } = await setup(t, [], llm, { semantic: { enabled: true, engine } })
  const vaultPath = join(root, 'vault'), folder = 'Notes', dir = join(vaultPath, folder, 'knowledge')
  mkdirSync(dir, { recursive: true })
  const write = (file, body) => writeFileSync(join(dir, file), [
    '---', 'dsh_knowledge: true', 'scope: project', `projectKey: ${key}`, '---', ...body, '',
  ].join('\n'))
  write('retired.md', ['# 夜杉镜像', '## 退役方案', '夜杉镜像每天 03:19 执行。'])
  write('unrelated.md', ['# 栎叶备份', '## 当前方案', wrong])
  assert.equal((await panel('knowledgeSync', { direction: 'import', vaultPath, folder })).imported, 2)
  const { block, session } = await prepare('夜杉镜像现在每天几点执行？', 'retired-named-task')
  completeAnswer(handlers, session, '没有可核实的现行时间。')
  assert.ok(returnedSelection)
  assert.doesNotMatch(block, /03:19|07:26/u)
  const { lastRecall } = await panel('stats', { sessionId: session.id, scope: 'project', projectKey: key })
  assert.deepEqual(lastRecall.questions[0].injected, [])
  assert.equal(lastRecall.questions[0].answerCoverage, 'no-evidence')
})

test('one long note keeps separate semantic evidence for two questions', async t => {
  const approvals = 'Supplier substitution requires written authorization from finance.'
  const credentials = 'The service desk performs manual identity verification and reissues credentials.'
  const question = 'How do we get sign-off when replacing a vendor, and what should a locked-out employee do?'
  const vector = (approval, credential) => [approval, credential, Math.sqrt(1 - approval ** 2 - credential ** 2), ...Array(381).fill(0)]
  const engine = { state: 'ready', async embed(texts, mode) {
    return texts.map(text => mode === 'query'
      ? /vendor/u.test(text) ? vector(1, 0) : vector(0, 1)
      : text.includes(approvals) ? vector(.95, 0) : text.includes(credentials) ? vector(0, .94) : vector(0, 0))
  }, dispose() {} }
  const requests = []
  let wrongSlot = false
  const llm = { async *stream(request) {
    const text = request.messages[0].content.map(part => part.text ?? '').join('')
    const data = JSON.parse(text.slice(text.indexOf('{"query"')))
    requests.push(data)
    const selections = data.slots.flatMap(({ slot, query }) => {
      const quote = !wrongSlot && query.includes('vendor') ? approvals : credentials
      const candidate = data.candidates.find(row =>
        (wrongSlot || row.slots === undefined || row.slots.includes(slot)) && row.content.includes(quote))
      return candidate ? [{ slot, id: candidate.id, revision: candidate.revision, quote }] : []
    })
    yield { type: 'text-delta', text: JSON.stringify({ selections }) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  } }
  const { root, key, panel, prepare, handlers } = await setup(t, [], llm, { semantic: { enabled: true, engine } })
  const vaultPath = join(root, 'vault'), folder = 'Notes', dir = join(vaultPath, folder, 'knowledge')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'operations.md'), [
    '---', 'dsh_knowledge: true', 'scope: project', `projectKey: ${key}`, '---', '# Operations manual',
    '## Procurement', approvals, '## Storage', 'Packing sheets are filed by serial number.\n'.repeat(45),
    '## Account recovery', credentials, '',
  ].join('\n'))
  assert.equal((await panel('knowledgeSync', { direction: 'import', vaultPath, folder })).imported, 1)
  const result = await prepare(question, 'two-semantic-note-sections')
  assert.equal(requests.length, 1)
  assert.equal(requests[0].slots.length, 2)
  for (const quote of [approvals, credentials]) {
    assert.ok(requests[0].candidates.some(row => row.content.includes(quote)), JSON.stringify(requests[0].candidates))
    assert.ok(result.block.includes(quote), result.block)
  }
  completeAnswer(handlers, result.session, 'Obtain written sign-off from finance.')
  const { lastRecall } = await panel('stats', { sessionId: result.session.id, scope: 'project', projectKey: key })
  assert.deepEqual(lastRecall.questions.map(item => item.answerCoverage), ['covered', 'unverified'])
  for (const [i, quote] of [approvals, credentials].entries()) {
    const [citation] = lastRecall.questions[i].injected
    assert.equal(citation.noteFile, 'operations.md')
    assert.equal(citation.verified, true)
    assert.ok(citation.text.includes(quote), citation.text)
    assert.ok(!citation.text.includes(i === 0 ? credentials : approvals), citation.text)
  }
  wrongSlot = true
  const rejected = await prepare(question, 'rejected-wrong-note-section')
  assert.equal(requests.length, 2)
  assert.ok(rejected.block.includes(credentials), rejected.block)
  assert.ok(!rejected.block.includes(approvals), rejected.block)
  const rejectedReport = (await panel('stats', { sessionId: rejected.session.id, scope: 'project', projectKey: key })).lastRecall
  assert.deepEqual(rejectedReport.questions.map(item => item.injected.length), [0, 1])

  delete llm.stream
  const fallback = await prepare(question, 'local-fallback-note-sections')
  assert.equal(requests.length, 2)
  const fallbackReport = (await panel('stats', { sessionId: fallback.session.id, scope: 'project', projectKey: key })).lastRecall
  for (const [i, quote] of [approvals, credentials].entries()) {
    assert.ok(fallback.block.includes(quote), fallback.block)
    const [citation] = fallbackReport.questions[i].injected
    assert.equal(citation.verified, false)
    assert.ok(citation.text.includes(quote) && !citation.text.includes(i === 0 ? credentials : approvals), citation.text)
  }
})

test('dated semantic recall limits both model selection and original quotes to each effective period', async t => {
  const prior = 'Supplier substitution requires written authorization from finance.'
  const current = 'Supplier substitution requires a recorded approval by the operations director.'
  const obsolete = 'Vendor replacement uses verbal sign-off from purchasing.'
  const foreign = 'Vendor replacement requires two signatures from warehouse leads.'
  const vectors = [], requests = []
  const vector = score => [score, Math.sqrt(1 - score ** 2), ...Array(382).fill(0)]
  const engine = { state: 'ready', async embed(texts, mode) {
    if (mode === 'query') return texts.map(() => vector(1))
    vectors.push(...texts)
    return texts.map(text => vector(text.includes(prior) || text.includes(current) ? .98 :
      text.includes(obsolete) || text.includes(foreign) ? 1 : 0))
  }, dispose() {} }
  const llm = { async *stream(request) {
    const text = request.messages[0].content.map(part => part.text ?? '').join('')
    const payload = JSON.parse(text.slice(text.indexOf('{"query"')))
    requests.push(payload)
    const selections = payload.slots.flatMap(({ slot, query }) => {
      const quote = query.includes('2025-03-02') ? prior : current
      const candidate = payload.candidates.find(row => row.slots?.includes(slot) &&
        (row.content.includes(quote) || row.content.includes(foreign)))
      return candidate ? [{ slot, id: candidate.id, revision: candidate.revision,
        quote: candidate.content.includes(quote) ? quote : foreign }] : []
    })
    yield { type: 'text-delta', text: JSON.stringify({ selections }) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  } }
  const from = Date.UTC(2025, 0, 1), change = Date.UTC(2025, 3, 1)
  const { root, key, panel, prepare, handlers, store } = await setup(t, [], llm, { semantic: { enabled: true, engine } })
  const parent = store.write({ id: 'approval-handbook', scope: 'project', projectKey: key, kind: 'fact',
    status: 'active', content: 'The operations group kept a signed copy of the handbook.', validFrom: from, validTo: change })
  assert.ok(parent.ok)
  const vaultPath = join(root, 'vault'), folder = 'Notes', dir = join(vaultPath, folder, 'knowledge')
  mkdirSync(dir, { recursive: true })
  const write = (file, projectKey, fields, title, body) => writeFileSync(join(dir, file), [
    '---', 'dsh_knowledge: true', 'scope: project', `projectKey: ${projectKey}`, ...fields, '---', `# ${title}`, ...body, '',
  ].join('\n'))
  write('previous.md', key, ['status: superseded', `validFrom: ${from}`, `validTo: ${change}`, `memoryId: ${parent.record.id}`],
    'Retired policy', ['## Deprecated procedure', obsolete, '## Approved procedure', prior])
  write('current.md', key, [`validFrom: ${change}`], 'Vendor desk', [current])
  const otherCwd = join(root, 'other', 'project'), otherKey = projectIdentity(otherCwd).key
  write('foreign.md', otherKey, [`validFrom: ${from}`], 'Vendor desk', [foreign])
  assert.equal((await panel('knowledgeSync', { direction: 'import', vaultPath, folder })).imported, 3)

  const datedQuestion = 'How did we get sign-off when replacing a vendor on 2025-03-02?'
  const report = async (turn, projectKey = key) => (await panel('stats', { scope: 'project', projectKey, sessionId: turn.session.id })).lastRecall
  const dated = await prepare(datedQuestion, 'dated-paraphrase')
  assert.ok(dated.block.includes(prior), dated.block)
  assert.match(dated.block, /2025-03-02 时有效/u)
  assert.ok(vectors.includes(prior))
  for (const text of [current, obsolete, foreign]) {
    assert.ok(!vectors.includes(text), vectors.join('\n'))
    assert.ok(!requests[0].candidates.some(candidate => candidate.content.includes(text)))
  }
  assert.deepEqual((await report(dated)).questions[0].injected.map(hit => [hit.noteFile, hit.verified]), [['previous.md', true]])

  const compared = await prepare(`${datedQuestion.slice(0, -1)}, and how do we get sign-off when replacing a vendor now?`, 'mixed-dates')
  assert.ok(compared.block.includes(prior) && compared.block.includes(current), compared.block)
  assert.match(compared.block, /\[知识笔记 · 现行\]/u)
  const picked = requests.at(-1).candidates.filter(row => row.kind === 'knowledge')
  assert.deepEqual(Object.fromEntries(picked.map(row => [row.id, row.slots])), { 'note:previous.md': [0], 'note:current.md': [1] })
  completeAnswer(handlers, compared.session, `${prior} ${current}`)
  assert.deepEqual((await report(compared)).questions.map(q => q.injected.map(hit => [hit.noteFile, hit.verified])),
    [[['previous.md', true]], [['current.md', true]]])

  const originalStream = llm.stream
  delete llm.stream
  const local = await prepare(datedQuestion, 'dated-local')
  assert.match(local.block, /\[待核实候选原文 · 2025-03-02 时有效\]/u)
  assert.ok(local.block.includes(prior))
  assert.equal((await report(local)).questions[0].injected[0].verified, false)
  llm.stream = originalStream
  assert.equal((await panel('removeMemory', { id: parent.record.id, scope: 'project', projectKey: key })).status, 'deleted')
  assert.equal(await report(dated), null)
  assert.equal(await report(compared), null)
  const count = requests.length
  const forgotten = await prepare(datedQuestion, 'after-forgetting')
  assert.ok(!forgotten.block.includes(prior))
  assert.equal(requests.length, count)
  const other = await prepare(datedQuestion, 'isolated-dated-paraphrase', { header: { cwd: otherCwd } })
  assert.ok(!other.block.includes(prior))
  assert.ok(other.block.includes(foreign), other.block)
  assert.equal((await report(other, otherKey)).questions[0].injected[0].noteFile, 'foreign.md')
})

test('an explicit note validity interval can answer a dated question with semantic recall disabled', async t => {
  const { root, key, panel, prepare } = await setup(t, [], undefined, { semantic: { enabled: false } })
  const vaultPath = join(root, 'vault'), folder = 'Notes', dir = join(vaultPath, folder, 'knowledge')
  mkdirSync(dir, { recursive: true })
  const note = (name, start, section, time, end = null) => writeFileSync(join(dir, name + '.md'), [
    '---', 'dsh_knowledge: true', 'scope: project', 'projectKey: ' + key,
    ...(start === null ? [] : ['validFrom: ' + start]),
    ...(end === null ? [] : ['validTo: ' + end]), '---', '# 河灰快照', ...section,
    '河灰快照每天 ' + time + ' 执行。', '',
  ].join('\n'))
  note('dated', Date.UTC(2025, 0, 1), ['## 已废弃的设置', '河灰快照每天 00:18 执行。', '## 当期规则'], '04:37',
    Date.UTC(2025, 3, 1))
  note('later', Date.UTC(2025, 4, 1), [], '06:14')
  note('undated', null, [], '03:21')
  assert.equal((await panel('knowledgeSync', { direction: 'import', vaultPath, folder })).imported, 3)
  const answer = await prepare('河灰快照 2025-03-02 每天几点执行？', 'dated-note')
  assert.match(answer.block, /04:37/u)
  assert.doesNotMatch(answer.block, /00:18|06:14|03:21/u)
  assert.doesNotMatch(answer.block, /· \d{4}-\d{2}-\d{2}）/u)
  const report = (await panel('stats', { sessionId: answer.session.id, scope: 'project', projectKey: key })).lastRecall
  assert.deepEqual(report.questions[0].injected.map(item => item.noteFile), ['dated.md'])
  assert.equal(report.questions[0].injected[0].verified, true)
  assert.doesNotMatch((await prepare('河灰快照现在每天几点执行？', 'current-note')).block, /04:37|00:18/u)
  assert.doesNotMatch((await prepare('河灰快照 2024-12-01 每天几点执行？', 'before-note')).block, /04:37|06:14|03:21/u)
})

test('recall reports keep comma-delimited date labels and distinguish dates from retention values', async t => {
  const change = Date.UTC(2025, 3, 1)
  const { key, panel, prepare, handlers } = await setup(t, [
    { id: 'past-schedule', content: '河灰快照每天04:37执行，保留2天。', validFrom: Date.UTC(2025, 0, 1), validTo: change },
    { id: 'current-schedule', content: '河灰快照每天06:14执行。', validFrom: change },
  ])
  const compare = '河灰快照在 2025-03-02 每天几点执行？现在每天几点执行？'
  const clockCoverage = async (reply, sessionId) => {
    const turn = await prepare(compare, sessionId)
    assert.match(turn.block, /\[事实 · 2025-03-02 时有效\] 河灰快照每天04:37/u)
    assert.match(turn.block, /\[事实 · 现行\] 河灰快照每天06:14/u)
    completeAnswer(handlers, turn.session, reply)
    return (await panel('stats', { scope: 'project', projectKey: key, sessionId })).lastRecall.questions
      .map(({ answerCoverage, answerExcerpt }) => [answerCoverage, answerExcerpt])
  }
  assert.deepEqual(await clockCoverage('2025 年 3 月 2 日时，河灰快照每天是04:37。而现行规则下，该快照每天是06:14。', 'comparison'), [
    ['covered', '2025 年 3 月 2 日时，河灰快照每天是04:37。'], ['covered', '而现行规则下，该快照每天是06:14。'],
  ])
  assert.deepEqual(await clockCoverage('2025-03-02 是06:14，而现在是04:37。', 'swapped'), [
    ['unverified', null], ['unverified', null],
  ])
  assert.deepEqual(await clockCoverage('2025-03-02 时，不确定，每天04:37。现在，每天是06:14？', 'uncertain'), [
    ['unverified', null], ['unverified', null],
  ])
  assert.deepEqual(await clockCoverage('2025年3月2日时，河道快照在04:37执行。而现在，河灰快照在06:14执行。', 'other-subject'), [
    ['unverified', null], ['covered', '而现在，河灰快照在06:14执行。'],
  ])
  assert.deepEqual(await clockCoverage('河道快照有两条运行规则。2025年3月2日是04:37。现行规则是06:14。', 'wrong-subject-throughout'), [
    ['unverified', null], ['unverified', null],
  ])
  assert.deepEqual(await clockCoverage('河灰快照在2025-03-02之前每天04:37执行。现在06:14执行。', 'outside-date'), [
    ['unverified', null], ['covered', '现在06:14执行。'],
  ])
  const retention = await prepare('河灰快照 2025 年 3 月 2 日保留多久？', 'dated-retention')
  assert.match(retention.block, /河灰快照[^。\n]*保留2天/u)
  completeAnswer(handlers, retention.session, '2025 年 3 月 2 日时，河灰快照保留 9 天。')
  const checked = (await panel('stats', { sessionId: retention.session.id, scope: 'project', projectKey: key })).lastRecall
  assert.equal(checked.questions[0].injected[0].verified, true)
  assert.equal(checked.questions[0].answerCoverage, 'unverified')
})

test('an explicit Markdown alias locates evidence without turning metadata into an answer', async t => {
  const { root, key, panel, ask } = await setup(t)
  const vaultPath = join(root, 'vault'), folder = 'Notes', dir = join(vaultPath, folder, 'knowledge')
  mkdirSync(dir, { recursive: true })
  const source = '白鹭项目的构建工具使用 Vite 8.4.2。'
  writeFileSync(join(dir, 'build.md'), [
    '---', 'dsh_knowledge: true', 'scope: project', 'projectKey: ' + key,
    'aliases: [Northwind]', 'topic: 构建', '---', '# 白鹭项目', '', source,
  ].join('\n'))
  assert.equal((await panel('knowledgeSync', { direction: 'import', vaultPath, folder })).imported, 1)
  const answer = await ask('Northwind 的构建工具是什么版本？')
  assert.ok(answer.includes(source))
  assert.match(answer, /白鹭项目，别名 Northwind/u)
  assert.doesNotMatch(await ask('白鹭项目的构建工具是什么版本？'), /别名 Northwind/u)
  assert.doesNotMatch(await ask('Northwind 采用的数据库是什么版本？'), /Vite 8\.4\.2/u)
})

test('a note section identifies short facts without borrowing values from a sibling section', async t => {
  const { root, key, panel, ask } = await setup(t)
  const vaultPath = join(root, 'vault'), folder = 'Notes', dir = join(vaultPath, folder, 'knowledge')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'schedule.md'), [
    '---', 'dsh_knowledge: true', 'scope: project', 'projectKey: ' + key, '---',
    '# 四月值守记录',
    '## 昼林快照', '### 当前安排', '- 每天 03:34 执行。', '- 保留期限：48 天。',
    '## 夜林快照', '- 每天 11:52 执行。', '- 保留期限：67 天。',
    '~~~', '## 昼林快照', '- 每天 14:23 执行。', '- 保留期限：93 天。', '~~~',
  ].join('\n'))
  assert.equal((await panel('knowledgeSync', { direction: 'import', vaultPath, folder })).imported, 1)
  const result = await ask('昼林快照每天几点执行、保留多久？', 'qa-note-heading')
  assert.match(result, /每天 03:34 执行/u)
  assert.match(result, /保留期限：48 天/u)
  assert.doesNotMatch(result, /11:52|67 天|14:23|93 天/u)
  const { lastRecall } = await panel('stats', { scope: 'project', projectKey: key, sessionId: 'qa-note-heading' })
  assert.deepEqual(lastRecall.questions.map(item => item.injected[0]?.noteFile), ['schedule.md', 'schedule.md'])
})

test('forgetting a linked memory removes completed knowledge reports, including legacy reports', async t => {
  const id = 'mem_knowledge_forget'
  const { root, dataDir, key, panel, prepare, handlers } = await setup(t, [
    { id, content: '归档员已经完成上个月的纸质清单登记。' },
  ])
  const vaultPath = join(root, 'vault'), folder = 'Notes', dir = join(vaultPath, folder, 'knowledge')
  mkdirSync(dir, { recursive: true })
  const evidence = '桦湾轮换工单的检索编号是 MOSAIC-743-A。'
  const note = (file, extra, body) => writeFileSync(join(dir, file), [
    '---', 'dsh_knowledge: true', 'scope: project', 'projectKey: ' + key,
    ...extra, '---', '# 工单索引', body,
  ].join('\n'))
  note('indexed-ticket.md', ['memoryId: ' + id], evidence)
  note('unrelated.md', [], '茶山巡检的复核编号是 HAZEL-917-B。')
  assert.equal((await panel('knowledgeSync', { direction: 'import', vaultPath, folder })).imported, 2)
  const linkedQuestion = '桦湾轮换工单的检索编号是什么？'
  const legacy = 'session-linked-legacy', current = 'session-linked-current', unrelated = 'session-independent'
  const path = session => join(dataDir, 'recall-reports', recallReportSessionKey(session) + '.json')
  for (const session of [legacy, current, unrelated]) {
    const independent = session === unrelated
    const step = await prepare(independent ? '茶山巡检的复核编号是什么？' : linkedQuestion, session)
    assert.match(step.block, independent ? /HAZEL-917-B/u : /MOSAIC-743-A/u)
    completeAnswer(handlers, step.session, independent ? 'HAZEL-917-B。' : evidence)
    assert.ok(existsSync(path(session)))
  }
  const previousFormat = JSON.parse(readFileSync(path(legacy), 'utf8'))
  assert.deepEqual([...new Set(previousFormat.report.questions.flatMap(item => item.hits.map(hit => hit.id)))],
    ['note:indexed-ticket.md'])
  writeFileSync(path(legacy), JSON.stringify(previousFormat, (name, value) => name === 'noteAuthority' ? undefined : value))
  assert.equal((await panel('removeMemory', { id, scope: 'project', projectKey: key })).status, 'deleted')
  for (const session of [legacy, current]) {
    assert.equal(existsSync(path(session)), false)
    assert.equal((await panel('stats', { sessionId: session, scope: 'project', projectKey: key })).lastRecall, null)
  }
  assert.ok(existsSync(path(unrelated)))
  assert.ok((await panel('stats', { sessionId: unrelated, scope: 'project', projectKey: key })).lastRecall)
  assert.doesNotMatch((await prepare(linkedQuestion, 'session-after-forget')).block, /MOSAIC-743-A/u)
})

test('one product version cannot mark a different product slot covered; verified paraphrases can', async t => {
  let calls = 0
  const llm = { async *stream(request) {
    calls++
    const data = JSON.parse(request.messages.at(-1).content)
    yield { type: 'text-delta', text: JSON.stringify({ selections: data.slots
      .filter(slot => !slot.query.includes('构建'))
      .map(slot => ({ slot: slot.slot, id: 'mem_relation', revision: 1, quote: slot.query.includes('版本') ? '11.4.7' : 'MariaDB' })) }) }
    yield { type: 'finish', reason: { kind: 'stop' }, usage: { inputTokens: 250, outputTokens: 50, totalTokens: 300 } }
  } }
  // The collector wraps the selection instructions and JSON in a text message.
  const stream = llm.stream.bind(llm)
  llm.stream = request => {
    const content = request.messages.at(-1).content
    const text = typeof content === 'string' ? content : content.map(p => p.text ?? '').join('')
    return stream({ ...request, messages: [{ content: text.slice(text.indexOf('{"query"')) }] })
  }
  const { key, panel, ask } = await setup(t, [
    { id: 'mem_relation', content: '青岩项目的关系型数据库采用 MariaDB 11.4.7。' },
    { id: 'mem_unrelated', content: '青岩快照每天 06:12 生成，保留 41 天。' },
  ], llm)
  const result = await ask('青岩项目最终把结构化数据交给哪款关系型持久化产品、哪个版本？青岩项目的构建工具及版本是什么？请简短逐项回答。')
  assert.match(result, /MariaDB 11\.4\.7/u)
  assert.doesNotMatch(result, /06:12|41 天/u)
  assert.equal(calls, 1)
  const report = (await panel('stats', { scope: 'project', projectKey: key, sessionId: 'session-integration' })).lastRecall
  assert.equal(report.missing.length, 2)
  assert.ok(report.missing.every(query => /构建/u.test(query)))
  assert.ok(report.covered.every(item => !item.query.includes('构建')))
})

test('current and previous values retain the current change reason as a separate question', async t => {
  const { ask } = await setup(t, [
    { id: 'mem_old_ttl', content: '青岩快照保留 17 天。', status: 'superseded' },
    { id: 'mem_new_ttl', content: '青岩项目现在确认变更：快照保留期限从 17 天改为 29 天，因为月度追溯需要覆盖完整账期。每日 06:12 生成的安排不变。' },
    { id: 'mem_old_reason', content: '青岩快照调整保留期限，是为了节省磁盘容量。', status: 'superseded' },
    { id: 'mem_other_project', content: '红杉项目现在确认变更：快照保留 82 天，因为审计要求。' },
    { id: 'mem_other_object', content: '青岩项目的红杉快照保留 74 天，因为容量足够。' },
  ])
  const result = await ask('青岩快照现在保留多久，改之前是多久，为什么改保留期限？')
  assert.match(result, /17 天/u); assert.match(result, /29 天/u)
  assert.match(result, /覆盖完整账期/u); assert.doesNotMatch(result, /节省磁盘容量/u)
  assert.doesNotMatch(result, /82 天|74 天/u)
})

test('recall follows an explicit person relation across two separate memories', async t => {
  const { ask } = await setup(t, [
    { id: 'mem_project_lead', content: '青岩项目的负责人是林青。' },
    { id: 'mem_leave_handoff', content: '林青请假时，交付值班由周岚接手。' },
    { id: 'mem_name_cooccurrence', content: '林青和周岚属于同一个值班组。' },
  ])

  const result = await ask('青岩项目的负责人是谁，他请假时谁接手？')

  assert.match(result, /青岩项目的负责人是林青/u)
  assert.match(result, /林青请假时，交付值班由周岚接手/u)
  assert.doesNotMatch(result, /同一个值班组/u)
})

test('a role-based relation question joins its owner fact without exposing co-occurrence', async t => {
  const positive = await setup(t, [
    { id: 'mem_role_owner', content: '桐湾项目的值班负责人是许岚。' },
    { id: 'mem_role_delegate', content: '许岚请假时，由顾宁代班。' },
  ])
  const result = await positive.ask('桐湾项目的负责人请假时谁代班？')
  assert.match(result, /许岚/u)
  assert.match(result, /顾宁/u)

  const unrelated = await setup(t, [
    { id: 'mem_role_owner', content: '桐湾项目的值班负责人是许岚。' },
    { id: 'mem_role_cooccurrence', content: '许岚和顾宁一起讨论过请假手续。' },
  ])
  assert.equal(await unrelated.ask('桐湾项目的负责人请假时谁代班？'), '')
})

test('a chosen plan connects only to its separately recorded causal reason', async t => {
  const project = await setup(t, [
    { id: 'mem_backup_decision', kind: 'decision', content: '沐桥项目的备份方式最终采用星港方案。' },
    { id: 'mem_backup_reason', content: '选择星港方案，是因为它允许夜间限速传输。' },
    { id: 'mem_wrong_plan_reason', content: '选择云岚方案，是因为它允许夜间限速传输。' },
    { id: 'mem_cooccurring_reason', content: '星港方案和夜间限速传输曾被同时讨论。' },
    { id: 'mem_foreign_reason', projectKey: projectIdentity('/foreign-project').key,
      content: '选择星港方案，是因为另一个项目需要审计留痕。' },
  ])
  const query = '沐桥项目的备份方式最终采用哪个方案，为什么选这个方案？'
  const answer = await project.ask(query)
  assert.match(answer, /星港方案/u)
  assert.match(answer, /允许夜间限速传输/u)
  assert.doesNotMatch(answer, /云岚方案|同时被讨论|另一个项目/u)

  await project.panel('removeMemory', { id: 'mem_backup_decision', scope: 'project', projectKey: project.key })
  assert.doesNotMatch(await project.ask(query), /允许夜间限速传输/u)
})

test('a denied plan cannot establish a decision-reason bridge', async t => {
  const { ask } = await setup(t, [
    { id: 'mem_denied_backup', kind: 'decision', content: '沐桥项目的备份方式并未采用星港方案。' },
    { id: 'mem_denied_reason', content: '选择星港方案，是因为它允许夜间限速传输。' },
  ])
  const answer = await ask('沐桥项目的备份方式最终采用哪个方案，为什么选这个方案？')
  assert.doesNotMatch(answer, /允许夜间限速传输/u)
})

test('a return from a visit proves an elapsed lower bound without asserting its exact date', async t => {
  const { dataDir, key, panel, prepare, handlers } = await setup(t)
  const day = date => Date.parse(date + 'T12:00:00Z')
  const grant = (sessionId, text, date, timeZone = 'UTC') => {
    const source = saveSource(dataDir, { sessionId, messageId: 'main', projectKey: key, text,
      role: 'user', sourceKind: 'user', at: day(date), eventTime: day(date), timeZone })
    assert.ok(grantSourceRecall(dataDir, readSource(dataDir, source.id), key, { remembered: true }))
    return source.id
  }
  const visit = grant('return', 'I just got back from a guided tour at the North Coast Art Museum focused on collage, and it inspired me.',
    '2026-01-08')
  const exhibit = grant('exhibit', "I have always been interested in textiles, which is why I attended the Alder Textile exhibit today.", '2026-01-15')
  grant('someone-else', 'My colleague just got back from a tour of the North Coast Art Museum.', '2026-01-12')
  grant('other-place', 'I just got back from an online tour of the North Coast Art Museum Annex.', '2026-01-13')
  grant('unconfirmed', 'If I get back from a tour at the North Coast Art Museum today, I will tell you about it.', '2026-01-14')
  grant('other-clock', 'I attended the Cedar Light exhibit today.', '2026-01-20', 'Asia/Tokyo')
  grant('planned-exhibit', 'I will attend the Pine Loom exhibit today.', '2026-01-17')
  const question = 'How many days passed between my visit to the North Coast Art Museum (NCAM) and the Alder Textile exhibit?'
  const reportFor = sessionId => panel('stats', { sessionId, projectKey: key }).then(stats => stats.lastRecall)
  const good = await prepare(question, 'visit-bound')
  assert.match(good.block, /at least 7 days/iu)
  assert.match(good.block, /Keep the phrase 'at least'/u)
  assert.match(good.block, /exact number (?:is unknown|cannot be determined)/iu)
  assert.match(good.block, /got back from a guided tour at the North Coast Art Museum/u)
  assert.match(good.block, /I attended the Alder Textile exhibit today/u)
  assert.doesNotMatch(good.block, /colleague|Annex|If I get back|= 7 天/u)
  completeAnswer(handlers, good.session, 'At least seven days passed. The exact number is unknown. The earlier event was on or before January 8, 2026.')
  const goodReport = await reportFor(good.session.id)
  assert.deepEqual(goodReport.questions.map(slot => slot.answerCoverage), ['covered', 'covered'])
  for (const [slot, sourceId] of [visit, exhibit].entries()) {
    assert.deepEqual(goodReport.questions[slot].injected.flatMap(hit => hit.sourceRefs.map(ref => ref.sourceId)), [sourceId])
  }
  for (const [id, answer] of [
    ['visit-exact-claim', 'Exactly seven days passed.'],
    ['visit-false-date', 'At least seven days passed. You visited the North Coast Art Museum on January 8, 2026.'],
    ['visit-false-first-date', 'At least seven days passed. The first event happened on January 8, 2026.'],
    ['visit-false-earlier-date', 'At least seven days passed. The earlier visit was January 8, 2026.'],
    ['visit-speculative-lower-bound', 'At least seven days may have passed.'],
    ['visit-conflicting-claim', 'At least seven days passed. The visits were seven days apart.'],
    ['visit-negated-claim', 'At least seven days did not pass.'],
    ['visit-wrong-later-date', 'At least seven days passed. The Alder Textile exhibit occurred on January 16, 2026.'],
    ['visit-wrong-later-reference', 'At least seven days passed. The later event was on January 16, 2026.'],
  ]) {
    const request = await prepare(question, id)
    completeAnswer(handlers, request.session, answer)
    assert.ok((await reportFor(id)).questions.every(slot => slot.answerCoverage !== 'covered'), id)
  }
  const differentZone = await prepare(question.replace('Alder Textile', 'Cedar Light'), 'visit-zone')
  assert.doesNotMatch(differentZone.block, /at least \d+ days/iu)
  const planned = await prepare(question.replace('Alder Textile', 'Pine Loom'), 'visit-and-plan')
  assert.doesNotMatch(planned.block, /at least \d+ days/iu)
  const deliveredVisit = goodReport.questions[0].injected[0]
  await panel('removeMemory', { id: deliveredVisit.id, scope: 'project', projectKey: key })
  assert.equal(await reportFor(good.session.id), null)
  const removed = await prepare(question, 'visit-removed')
  assert.doesNotMatch(removed.block, /got back from a guided tour|at least \d+ days/iu)
  assert.match(removed.block, /2026-01-15\b/u)
  assert.match(removed.block, /I attended the Alder Textile exhibit today/u)
  completeAnswer(handlers, removed.session,
    'The Alder Textile exhibit was on January 15, 2026. The museum visit date is unknown, so the interval cannot be calculated.')
  const partial = await reportFor(removed.session.id)
  assert.deepEqual(partial.questions.map(slot => slot.answerCoverage), ['no-evidence', 'covered'])
  assert.equal(partial.questions[1].calendarDate, '2026-01-15')
  assert.equal(partial.questions[1].calendar, null)
  for (const [id, answer] of [
    ['wrong-day', 'The Alder Textile exhibit was on January 16, 2026. The interval is unknown.'],
    ['wrong-occasion', 'The Cedar Light exhibit was on January 15, 2026. The interval is unknown.'],
    ['unsupported-interval', 'The Alder Textile exhibit was on January 15, 2026. Exactly seven days passed.'],
  ]) {
    const request = await prepare(question, 'partial-date-' + id)
    completeAnswer(handlers, request.session, answer)
    assert.equal((await reportFor(request.session.id)).questions[1].answerCoverage, 'unverified', id)
  }
})

test('an explicit completed visit gives an exact interval despite an acronym in the question', async t => {
  const { dataDir, key, prepare } = await setup(t)
  for (const [sessionId, text, date] of [
    ['visit', 'My visit to the North Coast Art Museum happened on January 3, 2026.', '2026-01-08'],
    ['event', 'I attended the Alder Textile exhibit on January 15, 2026.', '2026-01-15'],
  ]) {
    const at = Date.parse(date + 'T12:00:00Z')
    const source = saveSource(dataDir, { sessionId, messageId: 'main', projectKey: key, text,
      role: 'user', sourceKind: 'user', at, eventTime: at, timeZone: 'UTC' })
    assert.ok(grantSourceRecall(dataDir, readSource(dataDir, source.id), key, { remembered: true }))
  }
  const question = 'How many days passed between my visit to the North Coast Art Museum (NCAM) and the Alder Textile exhibit?'
  const request = await prepare(question, 'explicit-visit')
  assert.match(request.block, /2026-01-15 − 2026-01-03 = 12 天/u)
})

test('a quoted event title accepts its dated completed walk or volunteer action across original sessions', async t => {
  const { dataDir, key, panel, prepare, handlers } = await setup(t)
  const at = Date.parse('2023-03-14T21:24:00Z')
  const add = (sessionId, text) => {
    const saved = saveSource(dataDir, { sessionId, messageId: 'main', projectKey: key, text,
      role: 'user', sourceKind: 'user', at, eventTime: at, timeZone: 'UTC' })
    assert.ok(grantSourceRecall(dataDir, readSource(dataDir, saved.id), key, { remembered: true }))
    return saved.id
  }
  const a = add('completed-walk', 'I just did the "Pine Trail" 5K walk on February 21st and enjoyed it.')
  const b = add('completed-cleanup', 'By the way, I recently volunteered at the Shore Cleanup event on March 7th and enjoyed it.')
  add('planned', 'I was planning to do the "Pine Trail" event on March 12th.')
  add('similar-name', 'I did the "Pine Trail Youth" event on March 13th.')
  add('not-attended', 'I did not attend the "Pine Trail" event on March 13th.')
  add('different-party', 'My sister attended the "Pine Trail" event on February 22nd.')
  const question = "How many days had passed between the 'Pine Trail' event and the 'Shore Cleanup' event?"
  const request = await prepare(question, 'quoted-dated-walk')
  assert.match(request.block, /2023-03-07 − 2023-02-21 = 14 天/u)
  assert.match(request.block, /I just did the "Pine Trail" 5K walk on February 21st/u)
  assert.doesNotMatch(request.block, /March 12|March 13|February 22|Pine Trail Youth/u)
  completeAnswer(handlers, request.session, 'Fourteen days had passed.')
  const report = (await panel('stats', { sessionId: request.session.id, projectKey: key })).lastRecall
  assert.deepEqual(report.questions.map(slot => slot.answerCoverage), ['covered', 'covered'])
  assert.deepEqual(report.questions.map(slot => slot.injected.flatMap(hit => hit.sourceRefs.map(ref => ref.sourceId))), [[a], [b]])
  const wrongDate = await prepare(question, 'quoted-dated-walk-wrong-date')
  completeAnswer(handlers, wrongDate.session, 'Fourteen days had passed. The "Pine Trail" 5K walk was on February 22, 2023.')
  const wrongReport = (await panel('stats', { sessionId: wrongDate.session.id, projectKey: key })).lastRecall
  assert.ok(wrongReport.questions.every(slot => slot.answerCoverage === 'unverified'))
  const archived = report.questions[0].injected[0].id
  await panel('removeMemory', { id: archived, scope: 'project', projectKey: key })
  assert.equal((await panel('stats', { sessionId: request.session.id, projectKey: key })).lastRecall, null)
  const after = await prepare(question, 'quoted-dated-walk-revoked')
  assert.doesNotMatch(after.block, /February 21|= 14 天/u)
})

test('a race improvement compares actual finishing times with the requested previous calendar year', async t => {
  const { dataDir, key, panel, prepare, handlers } = await setup(t)
  const at = Date.now() - 10_000
  const year = new Date(at).getUTCFullYear()
  const add = (sessionId, text, stamp = at) => {
    const saved = saveSource(dataDir, { sessionId, messageId:'main', projectKey:key, text,
      role:'user', sourceKind:'user', at:stamp, eventTime:stamp, timeZone:'UTC' })
    assert.ok(grantSourceRecall(dataDir, readSource(dataDir, saved.id), key, { remembered:true }))
    return saved.id
  }
  const current = add('current', 'By the way, I just got back into running and recently finished a 5K in 35 minutes.')
  const earlier = add('previous', "I've done a 5K run last year, but it took me 45 minutes to complete.")
  add('wrong-year', 'Last time we spoke I had other hobbies. I finished a 5K last year in 48 minutes.', Date.UTC(year - 2, 8, 5))
  add('wrong-distance', 'I recently finished a 10K in 60 minutes.')
  add('goal', 'I hope to finish another 5K in 25 minutes.')
  add('another-runner', 'My friend finished a 5K last year in 19 minutes.')
  add('hypothetical', 'If I had finished a 5K last year in 30 minutes, I would have won.')
  const question = "How much faster did I finish the 5K run compared to my previous year's time?"
  const ready = await prepare(question, 'race-year-comparison')
  assert.match(ready.block, /45 minutes − 35 minutes = 10 minutes faster/u)
  assert.doesNotMatch(ready.block, /48 minutes|60 minutes|25 minutes|19 minutes|30 minutes/u)
  completeAnswer(handlers, ready.session, 'I was ten minutes faster than last year.')
  const readReport = id => panel('stats', {sessionId:id, projectKey:key}).then(data => data.lastRecall)
  const report = await readReport(ready.session.id)
  assert.equal(report.questions[0].answerCoverage, 'covered')
  const sourceIds = report.questions[0].injected.flatMap(hit=>hit.sourceRefs.map(ref=>ref.sourceId))
  assert.deepEqual(new Set(sourceIds), new Set([current,earlier]))
  const wrong = await prepare(question, 'race-year-reversed')
  completeAnswer(handlers, wrong.session, 'I was ten minutes slower than last year.')
  assert.equal((await readReport(wrong.session.id)).questions[0].answerCoverage,'unverified')
  const uncertain = await prepare(question, 'race-year-negated')
  completeAnswer(handlers, uncertain.session, "I wasn't ten minutes faster than last year.")
  assert.equal((await readReport(uncertain.session.id)).questions[0].answerCoverage,'unverified')
  const remove = report.questions[0].injected.find(hit=>hit.sourceRefs[0].sourceId===earlier)
  await panel('removeMemory',{id:remove.id, scope:'project', projectKey:key})
  assert.equal(await readReport(ready.session.id), null)
  const missing = await prepare(question, 'race-year-after-revocation')
  assert.doesNotMatch(missing.block, /45 minutes|10 minutes faster/u)
})

test('race coverage verifies the named race, stated times, years and direction', () => {
  const comparison = {
    raceDifferenceSeconds: 600,
    race: { label: '5k', previous: { year: 2022, seconds: 2700 }, recent: { year: 2023, seconds: 2100 } },
  }
  const cases = [
    ['You finished the 5K run 10 minutes faster compared to your previous year’s time.', true],
    ['10 minutes', true],
    ['You were ten minutes faster than last year.', true],
    ['You finished the 5K in 35 minutes this year and in 45 minutes last year, 10 minutes faster.', true],
    ['Last year, you finished the 5K in 45 minutes. This year you finished the 5K in 35 minutes. You were 10 minutes faster.', true],
    ['45 minutes − 35 minutes = 10 minutes faster.', true],
    ['You finished the seaside half marathon 10 minutes faster compared to your previous year’s time.', false],
    ['You finished the 5K in 25 minutes this year and in 35 minutes last year. You were 10 minutes faster.', false],
    ['You finished the 5K in 45 minutes this year and in 35 minutes last year. You were 10 minutes faster.', false],
    ['50 minutes − 40 minutes = 10 minutes faster.', false],
    ['You finished the 5K in 35 minutes in 2024. You were 10 minutes faster.', false],
    ['You finished the 5K 10 minutes faster than last year. You finished the seaside half marathon in 35 minutes.', false],
    ['You were 10 minutes slower.', false],
    ['You were 10 minutes faster. Actually you were 5 minutes slower.', false],
  ]
  assert.deepEqual(cases.map(([answer, expected]) => [answer, matchesElapsedAnswer(answer, comparison), expected])
    .filter(([, actual, expected]) => actual !== expected), [])
  const undated = { ...comparison, race: { ...comparison.race, recent: { year: null, seconds: 2100 } } }
  assert.equal(matchesElapsedAnswer('You finished the 5K 10 minutes faster than last year.', undated), true)
  assert.equal(matchesElapsedAnswer('You finished the 5K in 35 minutes this year. You were 10 minutes faster.', undated), false)
  assert.equal(matchesElapsedAnswer('You finished the 5K in 35 minutes in 2023. You were 10 minutes faster.', undated), false)
})

test('verified differences reject a right result stated with wrong operands', async t => {
  const { prepare, panel, handlers } = await setup(t, [
    { content:'I raised $250 in the charity cycling event.' },
    { content:'My initial goal for the charity cycling event was $200.' },
    { content:'The pre-approval limit for Orchard House was $625,000.' },
    { content:'The final sale price of Orchard House was $585,000.' },
    { content:'I paid $80 for the winter jacket.' },
    { content:'I paid $60 for the boots.' },
  ])
  const fundraiser = 'How much more money did I raise than my initial goal in the charity cycling event?'
  const mortgage = 'How much more was the mortgage pre-approval amount for Orchard House than the final sale price of Orchard House?'
  const purchase = 'What is the total amount I spent on the winter jacket and the boots?'
  for (const [id, question, amount, text, expected] of [
    ['wrong-both', fundraiser, '50', 'You raised $350. Your initial goal was $300. You exceeded your initial goal by $50.', 'unverified'],
    ['wrong-compound', fundraiser, '50', 'You raised $350 against your initial goal of $300. You exceeded your initial goal by $50.', 'unverified'],
    ['wrong-equation', fundraiser, '50', 'The difference is $350 - $300 = $50.', 'unverified'],
    ['reversed-equation', fundraiser, '50', 'The difference is $200 - $250 = $50.', 'unverified'],
    ['wrong-currency', fundraiser, '50', 'The difference is €250 - €200 = $50.', 'unverified'],
    ['wrong-operator', fundraiser, '50', 'The difference is $45 + $5 = $50.', 'unverified'],
    ['correct-explicit', fundraiser, '50', 'You raised $250. Your initial goal was $200. You exceeded your initial goal by $50.', 'covered'],
    ['correct-equation', fundraiser, '50', 'The difference is $250 - $200 = $50.', 'covered'],
    ['bare', fundraiser, '50', '$50', 'covered'],
    ['wrong-mortgage', mortgage, '40000', 'The difference is $640,000 - $600,000 = $40,000.', 'unverified'],
    ['correct-mortgage', mortgage, '40000', 'The difference is $625,000 - $585,000 = $40,000.', 'covered'],
    ['wrong-purchase-sum', purchase, '140', 'The total is $70 + $70 = $140.', 'unverified'],
    ['reordered-purchase-sum', purchase, '140', 'The total is $60 + $80 = $140.', 'covered'],
  ]) {
    const request = await prepare(question, id)
    completeAnswer(handlers, request.session, text)
    const report = (await panel('stats', { sessionId:request.session.id })).lastRecall
    assert.equal(report.quantityCheck.result, amount, id)
    assert.equal(report.quantityCheck.answerCoverage, expected, id)
  }
})
