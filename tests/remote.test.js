import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { MemoryIndex } from '../host/search.js'
import { MemoryStore } from '../host/store.js'
import {
  PanelInputError,
  listMemories,
} from '../host/remote-contract.js'
import {
  bindWebServerPanel,
  createPanelBackend,
  dispatchPanel,
  handlePanelRequest,
  wirePanel,
} from '../host/remote.js'

const NOW = 1_700_000_000_000
const KEY = 'DSH-Memory-abc'
const OTHER_KEY = 'DSH-Other-def'

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-memory-panel-'))
  if (t !== undefined && typeof t.after === 'function') {
    t.after(() => rmSync(root, { recursive: true, force: true }))
  }
  const store = new MemoryStore({ root, clock: () => NOW }).open()
  const index = new MemoryIndex()
  const config = { capture: { enabled: true }, inject: { enabled: true } }
  const backend = createPanelBackend({ store, index, config, root })
  return { root, store, index, config, backend }
}

function seed(store, index, overrides = {}) {
  const built = store.write({
    kind: 'fact',
    scope: 'project',
    projectKey: KEY,
    content: '该仓库使用 pnpm 并要求 Node 22 以上',
    tags: ['pnpm'],
    confidence: 0.9,
    importance: 0.7,
    ...overrides,
  })
  assert.equal(built.ok, true)
  index.upsert(built.record)
  return built.record
}

test('list projects only the requested scope and applies status/kind filters', (t) => {
  const { store, index, backend } = setup(t)
  seed(store, index, { content: '项目使用 pnpm 管理依赖' })
  seed(store, index, { kind: 'preference', content: '用户偏好中文回复', status: 'candidate' })
  seed(store, index, { scope: 'global', projectKey: null, content: '全局记忆使用本地 JSONL 存储' })

  const project = listMemories(backend, { scope: 'project', projectKey: KEY })
  assert.equal(project.items.length, 2)
  assert.equal(project.total, 2)

  const candidates = listMemories(backend, { scope: 'project', projectKey: KEY, status: 'candidate' })
  assert.equal(candidates.items.length, 1)
  assert.equal(candidates.items[0].kind, 'preference')

  const facts = listMemories(backend, { scope: 'project', projectKey: KEY, kind: 'fact' })
  assert.equal(facts.items.length, 1)
  assert.equal(facts.items[0].kind, 'fact')

  const global = listMemories(backend, { scope: 'global' })
  assert.equal(global.items.length, 1)
  assert.equal(global.items[0].scope, 'global')
})

test('list query is ranked by the shared index and matches CJK bigrams', (t) => {
  const { store, index, backend } = setup(t)
  seed(store, index, { content: '项目使用 pnpm 管理依赖', tags: ['pnpm'] })
  seed(store, index, { content: '用户偏好中文回复，代码注释用英文', tags: ['language'] })

  const hits = listMemories(backend, { scope: 'project', projectKey: KEY, query: '存储' })
  assert.equal(hits.items.length, 0)

  const dependency = listMemories(backend, { scope: 'project', projectKey: KEY, query: 'pnpm' })
  assert.equal(dependency.items.length, 1)
  assert.match(dependency.items[0].content, /pnpm/u)

  const chinese = listMemories(backend, { scope: 'project', projectKey: KEY, query: '中文' })
  assert.equal(chinese.items.length, 1)
  assert.match(chinese.items[0].content, /中文/u)

  const tagged = listMemories(backend, { scope: 'project', projectKey: KEY, query: 'pnpm' })
  assert.equal(tagged.shown, 1)
})

test('stats counts statuses, kinds, projects and capture flag', (t) => {
  const { store, index, backend } = setup(t)
  seed(store, index)
  const archived = seed(store, index, { kind: 'decision', content: '决定采用 JSONL 作为权威存储' })
  index.upsert(store.update(archived.id, { status: 'archived' }, [{ scope: 'project', projectKey: KEY }]))
  seed(store, index, { kind: 'preference', scope: 'global', projectKey: null, content: '全局偏好：简洁回答', status: 'candidate' })

  const stats = backend.stats({})
  assert.equal(stats.active, 1)
  assert.equal(stats.candidate, 1)
  assert.equal(stats.archived, 1)
  assert.equal(stats.superseded, 0)
  assert.equal(stats.total, 3)
  assert.equal(stats.projects, 1)
  assert.equal(stats.kinds.fact, 1)
  assert.equal(stats.kinds.decision, 0)
  assert.equal(stats.kinds.preference, 1)
  assert.equal(stats.captureEnabled, true)
  assert.equal(stats.injectEnabled, true)
  assert.equal(stats.currentProjectKey, KEY)
  assert.equal(stats.avgConfidence, 0.9)
  assert.equal(typeof stats.lastCapturedAt, 'number')
})

test('list paginates and reports per-kind counts', (t) => {
  const { store, index, backend } = setup(t)
  for (let index2 = 0; index2 < 5; index2 += 1) seed(store, index, { kind: 'fact', content: `事实记录内容第 ${index2} 条，用于分页测试` })
  seed(store, index, { kind: 'decision', content: '决策记录用于分页测试' })
  seed(store, index, { kind: 'preference', content: '偏好记录用于分页测试' })

  const first = listMemories(backend, { scope: 'project', projectKey: KEY, limit: 2 })
  assert.equal(first.items.length, 2)
  assert.equal(first.total, 7)
  assert.equal(first.shown, 2)
  assert.equal(first.offset, 0)
  assert.deepEqual(first.kindCounts, { preference: 1, fact: 5, decision: 1, episode: 0 })

  const second = listMemories(backend, { scope: 'project', projectKey: KEY, limit: 2, offset: 2 })
  assert.equal(second.items.length, 2)
  assert.equal(second.offset, 2)
  assert.notEqual(first.items[0].id, second.items[0].id)

  const facts = listMemories(backend, { scope: 'project', projectKey: KEY, kind: 'fact', limit: 2, offset: 4 })
  assert.equal(facts.total, 5)
  assert.equal(facts.items.length, 1)
  assert.equal(facts.kindCounts.fact, 5)
  assert.equal(facts.kindCounts.decision, 1)
})

test('profile groups durable preferences into evidence-backed traits', (t) => {
  const { store, index, backend } = setup(t)
  const first = seed(store, index, { kind: 'preference', scope: 'global', projectKey: null, content: '用户偏好简洁直接的中文回答', confidence: 0.9, topic: '沟通' })
  seed(store, index, { kind: 'preference', scope: 'global', projectKey: null, content: '用户偏好少客套的回复', confidence: 0.8, topic: '沟通' })
  seed(store, index, { kind: 'fact', content: '该仓库使用 pnpm 管理依赖' })

  const profile = backend.profile({ limit: 5 })
  assert.equal(profile.total, 1)
  assert.equal(profile.traits[0].topic, '沟通')
  assert.equal(profile.traits[0].evidenceCount, 2)
  assert.ok(profile.traits[0].evidence.some((item) => item.id === first.id))
})

test('update appends a revision and keeps the index current', (t) => {
  const { store, index, backend } = setup(t)
  const record = seed(store, index, { status: 'candidate' })

  const approved = backend.update({ id: record.id, scope: 'project', projectKey: KEY, patch: { status: 'active' } })
  assert.equal(approved.record.status, 'active')
  assert.equal(approved.record.revision, 2)

  const edited = backend.update({
    id: record.id,
    scope: 'project',
    projectKey: KEY,
    patch: { content: '该仓库使用 pnpm 并要求 Node 24 以上', tags: ['pnpm', 'node'], pinned: true },
  })
  assert.equal(edited.record.revision, 3)
  assert.deepEqual(edited.record.tags, ['pnpm', 'node'])
  assert.equal(edited.record.pinned, true)

  assert.equal(listMemories(backend, { scope: 'project', projectKey: KEY, query: 'Node' }).items.length, 1)
  assert.equal(listMemories(backend, { scope: 'project', projectKey: KEY, query: '存储' }).items.length, 0)

  const reopened = new MemoryStore({ root: store.root, clock: () => NOW }).open()
  assert.equal(reopened.list('project', KEY)[0].revision, 3)
  assert.equal(reopened.list('project', KEY)[0].content, '该仓库使用 pnpm 并要求 Node 24 以上')
})

test('update rejects unknown fields, invalid status and missing records', (t) => {
  const { store, index, backend } = setup(t)
  const record = seed(store, index)

  assert.throws(
    () => backend.update({ id: record.id, scope: 'project', projectKey: KEY, patch: { scope: 'global' } }),
    (error) => error instanceof PanelInputError && /unsupported field/u.test(error.message),
  )
  assert.throws(
    () => backend.update({ id: record.id, scope: 'project', projectKey: KEY, patch: { status: 'deleted' } }),
    (error) => error instanceof PanelInputError && /status must be one of/u.test(error.message),
  )
  assert.throws(
    () => backend.update({ id: 'mem_missing', scope: 'project', projectKey: KEY, patch: { pinned: true } }),
    (error) => error instanceof PanelInputError && /not found/u.test(error.message),
  )
  assert.equal(index.size, 1)
  assert.equal(store.list('project', KEY)[0].revision, 1)
})

test('remove writes a tombstone and drops the index document', (t) => {
  const { store, index, backend } = setup(t)
  const record = seed(store, index)

  const removed = backend.removeMemory({ id: record.id, scope: 'project', projectKey: KEY })
  assert.equal(removed.status, 'deleted')
  assert.equal(removed.revision, 2)
  assert.equal(index.size, 0)
  assert.equal(listMemories(backend, { scope: 'project', projectKey: KEY }).items.length, 0)
  assert.equal(index.search('pnpm', { projectKey: KEY }).length, 0)

  const tombstone = store.find(record.id, [{ scope: 'project', projectKey: KEY }])
  assert.equal(tombstone.status, 'deleted')
  assert.throws(
    () => backend.removeMemory({ id: record.id, scope: 'global' }),
    (error) => error instanceof PanelInputError,
  )
})

test('rebuildIndex restores a stale index from the JSONL authority', (t) => {
  const { store, index, backend } = setup(t)
  const record = seed(store, index)
  index.remove(record.id)
  assert.equal(index.size, 0)

  const rebuilt = backend.rebuildIndex({})
  assert.equal(rebuilt.indexed, 1)
  assert.equal(listMemories(backend, { scope: 'project', projectKey: KEY, query: 'pnpm' }).items.length, 1)
})

test('the latest-touched project becomes the implicit current project', (t) => {
  const { root, store, index, backend } = setup(t)
  seed(store, index, { projectKey: KEY, content: '第一个项目的记忆内容' })
  seed(store, index, { projectKey: OTHER_KEY, content: '第二个项目的记忆内容' })

  const first = join(root, 'projects', KEY, 'memories.jsonl')
  const second = join(root, 'projects', OTHER_KEY, 'memories.jsonl')
  utimesSync(first, new Date(NOW - 60_000), new Date(NOW - 60_000))
  utimesSync(second, new Date(NOW), new Date(NOW))

  const listed = listMemories(backend, { scope: 'project' })
  assert.equal(listed.currentProjectKey, OTHER_KEY)
  assert.equal(listed.projectKey, OTHER_KEY)
  assert.equal(listed.items.length, 1)
  assert.match(listed.items[0].content, /第二个项目/u)
})

test('dispatchPanel refuses unknown methods', async () => {
  const { backend } = setup()
  await assert.rejects(
    () => dispatchPanel(backend, 'dropEverything', {}),
    (error) => error instanceof PanelInputError && /unknown panel method/u.test(error.message),
  )
  const stats = await dispatchPanel(backend, 'stats', {})
  assert.equal(stats.total, 0)
})

class MockRequest extends EventEmitter {
  constructor(method, body) {
    super()
    this.method = method
    this.body = body
  }
}

function mockResponse() {
  return {
    statusCode: 0,
    headers: null,
    body: '',
    writeHead(statusCode, headers) {
      this.statusCode = statusCode
      this.headers = headers
    },
    end(chunk) {
      if (chunk !== undefined) this.body += chunk
    },
  }
}

async function exchange(backend, method, payload) {
  const request = new MockRequest(method, payload === undefined ? '' : JSON.stringify(payload))
  const response = mockResponse()
  const pending = handlePanelRequest(backend, request, response)
  request.emit('data', Buffer.from(request.body))
  request.emit('end')
  await pending
  return { response, payload: response.body === '' ? null : JSON.parse(response.body) }
}

test('the web-server fallback answers with one JSON envelope', async (t) => {
  const { store, index, backend } = setup(t)
  seed(store, index)

  const ok = await exchange(backend, 'POST', { method: 'stats', input: { scope: 'project' } })
  assert.equal(ok.response.statusCode, 200)
  assert.equal(ok.response.headers['cache-control'], 'no-store')
  assert.equal(ok.payload.ok, true)
  assert.equal(ok.payload.value.total, 1)

  const listed = await exchange(backend, 'POST', { method: 'list', input: { scope: 'project', projectKey: KEY } })
  assert.equal(listed.payload.value.items.length, 1)

  const denied = await exchange(backend, 'POST', { method: 'dropEverything', input: {} })
  assert.equal(denied.payload.ok, false)
  assert.equal(denied.payload.error.code, 'invalid-input')

  const get = await exchange(backend, 'GET')
  assert.equal(get.response.statusCode, 405)
  assert.equal(get.response.headers.allow, 'POST')
})


test('the web-server fallback registers a token route and a boot global', (t) => {
  const { backend } = setup(t)
  const routes = []
  const listeners = []
  const effects = []
  const ctx = {
    get(name) {
      if (name !== 'webServer') return undefined
      return {
        register(route) {
          routes.push(route)
          return () => {
            routes.splice(routes.indexOf(route), 1)
          }
        },
      }
    },
    on(name, listener) {
      listeners.push({ name, listener })
      return () => listeners.splice(listeners.indexOf(listeners[listeners.length - 1]), 1)
    },
    effect(fn) {
      effects.push(fn())
      return () => {}
    },
    logger: { warn() {} },
  }

  const bound = bindWebServerPanel(ctx, backend)
  assert.equal(bound.transport, 'web-server')
  assert.match(bound.path, /^\/dsh-memory\/[0-9a-f]{32}$/u)
  assert.equal(routes.length, 1)
  assert.equal(routes[0].kind, 'exact')
  assert.equal(routes[0].path, bound.path)

  const table = []
  assert.equal(listeners.length, 1)
  assert.equal(listeners[0].name, 'webserver/index-inject')
  listeners[0].listener(table)
  assert.deepEqual(table, [{ kind: 'global', name: '__DSH_MEMORY__', value: { transport: 'web-server', path: bound.path } }])

  assert.equal(effects.length, 1)
  effects[0]()
  assert.equal(routes.length, 0)
})

test('wirePanel falls back to the web server when the protocol import fails', async (t) => {
  const { backend } = setup(t)
  const routes = []
  const warnings = []
  const ctx = {
    get(name) {
      if (name !== 'webServer') return undefined
      return {
        register(route) {
          routes.push(route)
          return () => routes.splice(routes.indexOf(route), 1)
        },
      }
    },
    on() {
      return () => {}
    },
    effect(fn) {
      fn()
      return () => {}
    },
    logger: { warn(message) { warnings.push(message) } },
  }
  const result = await wirePanel(ctx, { store: backend.store, index: backend.index, config: backend.config })
  assert.equal(result.transport, 'web-server')
  assert.equal(routes.length, 1)
  assert.match(routes[0].path, /^\/dsh-memory\//u)
  assert.match(warnings.join('\n'), /webServer fallback/u)
})

test('wirePanel reports unavailable when neither carrier can bind', async (t) => {
  const { backend } = setup(t)
  const warnings = []
  const ctx = {
    get() {
      return undefined
    },
    on() {
      return () => {}
    },
    effect(fn) {
      fn()
      return () => {}
    },
    logger: { warn(message) { warnings.push(message) } },
  }
  const result = await wirePanel(ctx, { store: backend.store, index: backend.index, config: backend.config })
  assert.equal(result.transport, 'unavailable')
  assert.match(result.reason, /webServer fallback/u)
  assert.equal(warnings.length, 1)
})

test('panel actions feed back into confidence and importance', (t) => {
  const { store, index, backend } = setup(t)
  const record = seed(store, index, { status: 'candidate', confidence: 0.5, importance: 0.5 })
  const approved = backend.update({ id: record.id, scope: 'project', projectKey: KEY, patch: { status: 'active' } })
  assert.equal(approved.record.status, 'active')
  assert.ok(Math.abs(approved.record.confidence - 0.6) < 1e-9)
  assert.ok(Math.abs(approved.record.importance - 0.55) < 1e-9)

  const edited = backend.update({
    id: record.id,
    scope: 'project',
    projectKey: KEY,
    patch: { content: '该仓库使用 pnpm 并要求 Node 24 以上' },
  })
  assert.ok(Math.abs(edited.record.importance - 0.6) < 1e-9)

  const pinned = backend.update({ id: record.id, scope: 'project', projectKey: KEY, patch: { pinned: true } })
  assert.ok(pinned.record.importance >= 0.9)
})


test('updateSettings validates fields and calls the activation callback', (t) => {
  const { backend } = setup(t)
  const patches = []
  backend.applySettings = (patch) => {
    patches.push(patch)
    return { ...patch }
  }
  const result = backend.updateSettings({ injectMaxTokens: 800, captureEnabled: false })
  assert.equal(patches.length, 1)
  assert.deepEqual(patches[0], { injectMaxTokens: 800, captureEnabled: false })
  assert.equal(result.settings.captureEnabled, false)
  assert.throws(() => backend.updateSettings({ unknown: 1 }), /unsupported field/u)
  assert.throws(() => backend.updateSettings({ captureEnabled: 'yes' }), /must be a boolean/u)
  assert.throws(() => backend.updateSettings({}), /at least one field/u)
})

test('export, import and backup round-trip through the panel operations', (t) => {
  const source = setup(t)
  const target = setup(t)
  seed(source.store, source.index, { content: '导出用的项目记忆内容' })
  seed(source.store, source.index, { kind: 'preference', scope: 'global', projectKey: null, content: '导出用的全局偏好内容' })

  const payload = source.backend.exportData()
  assert.equal(payload.global.length, 1)
  assert.equal(payload.projects[KEY].length, 1)

  const dry = target.backend.importData({ payload, dryRun: true })
  assert.equal(dry.imported, 2)
  assert.equal(target.store.listAll().length, 0)

  const applied = target.backend.importData({ payload })
  assert.equal(applied.imported, 2)
  assert.equal(target.store.listAll().length, 2)
  assert.equal(listMemories(target.backend, { scope: 'project', projectKey: KEY, query: '导出' }).items.length, 1)

  const backup = source.backend.backup()
  assert.ok(typeof backup.path === 'string')
  assert.ok(existsSync(backup.path))
})
