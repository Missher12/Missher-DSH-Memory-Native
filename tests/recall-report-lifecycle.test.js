import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'
import { apply } from '../index.js'
import { projectIdentity } from '../host/paths.js'
import { prepareStorage } from '../host/storage-boundary.js'
import { createRecallReportStore } from '../host/recall-reports.js'
import { MemoryStore } from '../host/store.js'

function createHost(t) {
  const root = mkdtempSync(join(tmpdir(), 'memory-recall-report-lifecycle-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const home = join(root, 'home')
  const profileContext = { name: 'desktop', home, dir: join(home, 'profiles', 'desktop') }
  mkdirSync(profileContext.dir, { recursive: true })
  const preparedStorage = prepareStorage({ get: name => name === 'profileContext' ? profileContext : undefined }, {})
  const dataRoot = preparedStorage.root
  const store = new MemoryStore({ root: dataRoot }).open()
  const cwdA = join(root, 'project-a'), cwdB = join(root, 'project-b')
  const keyA = projectIdentity(cwdA).key, keyB = projectIdentity(cwdB).key
  store.write({ id: 'mem_session_a', kind: 'fact', scope: 'project', projectKey: keyA,
    sourceRefs: [{ sourceId: 'src_0123456789abcdef01234567', excerpt: '旧会话来源' }],
    content: '青岚快照每天04:20执行，保留47天。', confidence: .95 })
  store.write({ id: 'mem_session_b', kind: 'fact', scope: 'project', projectKey: keyB,
    content: '赤潮快照每天06:15执行，保留63天。', confidence: .95 })

  const sessions = new Map([
    ['session-a', { id: 'session-a', header: { cwd: cwdA } }],
    ['session-b', { id: 'session-b', header: { cwd: cwdB } }],
    ['session-old', { id: 'session-old', header: { cwd: cwdA } }],
  ])
  const liveSessions = new Map()
  let sessionStatCalls = 0
  let instance
  const instances = []
  const start = async (profile = profileContext) => {
    const handlers = {}, effects = []
    let routeReady
    const ready = new Promise(resolve => { routeReady = resolve })
    const webServer = { register(route) { routeReady(route); return () => {} } }
    apply({
      sessions: { get(id) { return liveSessions.get(id) } },
      get: name => name === 'webServer' ? webServer : name === 'profileContext' ? profile :
        name === 'sessionPersistence' ? { async stat(id) { sessionStatCalls++; return sessions.get(id) ?? null } } : undefined,
      on: (name, handler) => { handlers[name] = handler; return () => {} },
      effect: factory => { const dispose = factory(); if (typeof dispose === 'function') effects.push(dispose) },
      logger: { warn() {}, info() {}, debug() {} },
    }, { capture: { enabled: false }, maintenance: { enabled: false }, obsidian: { autoSync: false } })
    const route = await ready
    const panel = async (method, input) => {
      const request = Readable.from([Buffer.from(JSON.stringify({ method, input }))]); request.method = 'POST'
      let response
      await route.handler(request, { writeHead() {}, end(body) { response = JSON.parse(body) } })
      assert.equal(response.ok, true, response.error?.message)
      return response.value
    }
    const prepare = async (sessionId, cwd, messageId, query, seq) => {
      const messages = [{ id: messageId, ...(seq === undefined ? {} : { seq }), role: 'user', source: { kind: 'user' }, content: query }]
      const session = { id: sessionId, header: { cwd } }
      liveSessions.set(sessionId, session)
      const result = await handlers['agent/pre-step']({ agent: { session }, messages },
        async () => ({ kind: 'enter', messages }))
      return { handlers, panel, messages, session, result }
    }
    const dispose = () => { for (const effect of effects.reverse()) effect() }
    instance = { handlers, panel, prepare, dispose }
    instances.push(instance)
    return instance
  }

  t.after(() => { for (const active of instances.reverse()) active.dispose() })
  return { root, home, dataRoot, profileIdentity: preparedStorage.identity, cwdA, cwdB, keyA, keyB,
    sessions, liveSessions, get sessionStatCalls() { return sessionStatCalls }, start }
}

function complete(handlers, session, text, sequence) {
  handlers['session/event'](session, { type: 'assistant/message', ...(sequence === undefined ? {} : { seq: sequence }), data: { message: {
    role: 'assistant', source: { kind: 'assistant' }, content: [{ type: 'text', text }],
  } } })
  handlers['session/event'](session, { type: 'turn/end', ...(sequence === undefined ? {} : { seq: sequence + 1 }),
    data: { reason: { kind: 'completed' } } })
}

test('completed reports survive restart per cold host session and remain project/profile bound', async t => {
  const host = createHost(t)
  const first = await host.start()
  const beforeUnknownReport = host.sessionStatCalls
  assert.equal((await first.panel('stats', { scope: 'project', sessionId: 'session-old' })).lastRecall, null)
  assert.equal(host.sessionStatCalls, beforeUnknownReport + 1, 'stats resolves the trusted browse default even without a report')
  const a1 = await first.prepare('session-a', host.cwdA, 'a-first', '青岚快照每天几点执行？', 2)
  complete(a1.handlers, a1.session, '青岚快照每天04:20执行。', 2)
  const loadedA = host.liveSessions.get('session-a')
  host.liveSessions.set('session-a', { id: 'session-a', header: { cwd: host.cwdB } })
  const statCallsBeforeMovedRead = host.sessionStatCalls
  assert.equal((await first.panel('stats', { scope: 'project', sessionId: 'session-a' })).lastRecall, null)
  assert.equal(host.sessionStatCalls, statCallsBeforeMovedRead, 'a moved live session overrides its older stored header')
  host.liveSessions.set('session-a', loadedA)
  const b1 = await first.prepare('session-b', host.cwdB, 'b-first', '赤潮快照每天几点执行？', 4)
  complete(b1.handlers, b1.session, '赤潮快照每天06:15执行。', 4)
  const a2 = await first.prepare('session-a', host.cwdA, 'a-second', '青岚快照保留多久？', 6)
  a2.handlers['session/event'](a2.session, { type: 'turn/end', seq: 5, data: { reason: { kind: 'completed' } } })
  const pendingA2 = await a2.panel('stats', { scope: 'project', sessionId: 'session-a' })
  assert.equal(pendingA2.lastRecall.outcome, 'pending')
  assert.equal(pendingA2.lastRecall.questions[0].query.includes('保留多久'), true)
  complete(a2.handlers, a2.session, '青岚快照保留47天。', 6)
  first.dispose()

  const restarted = await host.start()
  host.liveSessions.clear()
  const noSessionBefore = host.sessionStatCalls
  const noSession = await restarted.panel('stats', { scope: 'project' })
  assert.equal(host.sessionStatCalls, noSessionBefore, 'a stats request without a session skips session persistence')
  assert.ok(noSession.browseableProjectKeys.includes(noSession.currentProjectKey))
  const beforeColdA = host.sessionStatCalls
  const statsA = await restarted.panel('stats', { scope: 'project', sessionId: 'session-a' })
  const reportA = statsA.lastRecall
  assert.equal(statsA.currentProjectKey, host.keyA)
  assert.equal(host.sessionStatCalls, beforeColdA + 1, 'cold stats reads session metadata once for both the default and report')
  const beforeColdB = host.sessionStatCalls
  const statsB = await restarted.panel('stats', { scope: 'project', sessionId: 'session-b' })
  const reportB = statsB.lastRecall
  assert.equal(statsB.currentProjectKey, host.keyB)
  assert.equal(host.sessionStatCalls, beforeColdB + 1, 'the second cold session is also resolved once')
  assert.equal(reportA.questions[0].query.includes('保留多久'), true)
  assert.match(reportA.questions[0].injected[0].text, /47天/u)
  assert.equal(reportA.questions[0].answerCoverage, 'covered')
  assert.equal(reportB.questions[0].query.includes('几点执行'), true)
  assert.match(reportB.questions[0].injected[0].text, /06:15/u)
  assert.equal(reportB.questions[0].answerCoverage, 'covered')
  const fallbackProject = (await restarted.panel('stats', { scope: 'project' })).currentProjectKey
  const unknownSession = await restarted.panel('stats', { scope: 'project', sessionId: 'missing-session', projectKey: host.keyA })
  assert.equal(unknownSession.lastRecall, null)
  assert.equal(unknownSession.currentProjectKey, fallbackProject, 'an unknown session uses the browse fallback, not the client hint')
  assert.equal((await restarted.panel('stats', { scope: 'project', sessionId: 'session-old' })).lastRecall, null)
  assert.equal((await restarted.panel('stats', { scope: 'project', sessionId: 'session-a', projectKey: host.keyB })).lastRecall, null)
  assert.equal((await restarted.panel('stats', { scope: 'project', sessionId: 'session-b', projectKey: host.keyA })).lastRecall, null)

  await restarted.panel('removeMemory', { id: 'mem_session_a', scope: 'project', projectKey: host.keyA })
  assert.equal((await restarted.panel('stats', { scope: 'project', sessionId: 'session-a' })).lastRecall, null)
  assert.ok((await restarted.panel('stats', { scope: 'project', sessionId: 'session-b' })).lastRecall)

  const movedSessionA = { id: 'session-a', header: { cwd: host.cwdB } }
  host.sessions.set('session-a', movedSessionA)
  host.liveSessions.set('session-a', movedSessionA)
  assert.equal((await restarted.panel('stats', { scope: 'project', sessionId: 'session-a' })).lastRecall, null)

  restarted.dispose()
  const restoredSessionA = { id: 'session-a', header: { cwd: host.cwdA } }
  host.sessions.set('session-a', restoredSessionA)
  host.liveSessions.set('session-a', restoredSessionA)
  const afterForgetRestart = await host.start()
  assert.equal((await afterForgetRestart.panel('stats', { scope: 'project', sessionId: 'session-a' })).lastRecall, null)
  assert.ok((await afterForgetRestart.panel('stats', { scope: 'project', sessionId: 'session-b' })).lastRecall)
  afterForgetRestart.dispose()

  const otherProfile = await host.start({ name: 'work', home: host.home, dir: join(host.home, 'profiles', 'work') })
  assert.equal((await otherProfile.panel('stats', { scope: 'project', sessionId: 'session-b' })).lastRecall, null)
})

test('cold report reads fall back to stored session metadata only when no live host session is loaded', async t => {
  const host = createHost(t)
  const first = await host.start()
  const prepared = await first.prepare('session-a', host.cwdA, 'a-report', '青岚快照每天几点执行？', 2)
  complete(prepared.handlers, prepared.session, '青岚快照每天04:20执行。', 2)
  first.dispose()
  host.liveSessions.delete('session-a')

  const restarted = await host.start()
  const beforeColdRead = host.sessionStatCalls
  const report = (await restarted.panel('stats', { scope: 'project', sessionId: 'session-a' })).lastRecall
  assert.equal(report.outcome, 'completed')
  assert.equal(host.sessionStatCalls, beforeColdRead + 1, 'cold authorization resolves persisted metadata')

  host.sessions.set('session-a', { id: 'session-a', header: { cwd: host.cwdB } })
  assert.equal((await restarted.panel('stats', { scope: 'project', sessionId: 'session-a' })).lastRecall, null)
  assert.equal(host.sessionStatCalls, beforeColdRead + 2, 'cold metadata from a moved project rejects the old report')

  host.sessions.delete('session-a')
  assert.equal((await restarted.panel('stats', { scope: 'project', sessionId: 'session-a' })).lastRecall, null)
  assert.equal(host.sessionStatCalls, beforeColdRead + 3, 'a deleted session cannot use its earlier project metadata')
})

test('a cached in-memory report is hidden when another writer persists its revocation', async t => {
  const host = createHost(t)
  const plugin = await host.start()
  const a = await plugin.prepare('session-a', host.cwdA, 'a-report', '青岚快照每天几点执行？', 2)
  complete(a.handlers, a.session, '青岚快照每天04:20执行。', 2)
  const b = await plugin.prepare('session-b', host.cwdB, 'b-report', '赤潮快照每天几点执行？', 4)
  complete(b.handlers, b.session, '赤潮快照每天06:15执行。', 4)
  const revoker = createRecallReportStore(host.dataRoot, host.profileIdentity)
  revoker.invalidateReferences({ recordIds: ['mem_session_a'] })

  assert.equal((await plugin.panel('stats', { scope: 'project', sessionId: 'session-a' })).lastRecall, null)
  assert.ok((await plugin.panel('stats', { scope: 'project', sessionId: 'session-b' })).lastRecall)
})

test('an edited source-backed memory can write a current report that survives a cold read', async t => {
  const host = createHost(t)
  const plugin = await host.start()
  const original = await plugin.prepare('session-a', host.cwdA, 'a-original', '青岚快照每天几点执行？', 2)
  complete(original.handlers, original.session, '青岚快照每天04:20执行，保留47天。', 2)

  const updatedText = '青岚快照新计划每天04:35执行，保留48天。'
  await plugin.panel('update', { id: 'mem_session_a', scope: 'project', projectKey: host.keyA,
    patch: { content: updatedText } })
  const revised = await plugin.prepare('session-a', host.cwdA, 'a-revised', '青岚快照新计划每天几点执行？', 6)
  complete(revised.handlers, revised.session, `${updatedText} 已确认。`, 6)
  plugin.dispose()

  const restarted = await host.start()
  const report = (await restarted.panel('stats', { scope: 'project', sessionId: 'session-a' })).lastRecall
  assert.equal(report?.outcome, 'completed')
  assert.match(report.questions[0].injected[0].text, /04:35/u)
  assert.deepEqual(report.questions[0].injected[0].sourceRefs, [])
  assert.deepEqual(report.questions[0].hits[0].sourceRefs, [])
  assert.ok(report.questions[0].injected[0].text.includes(updatedText), 'the current memory text remains in the report')
})
