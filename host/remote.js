/**
 * Settings → Memory panel RPC.
 *
 * Two Host bindings are implemented, in preference order:
 *
 * 1. **Typert Remote (source mode).** A plain-JS `TypertRemoteService`
 *    subclass gets the `typertRemote` binding from its constructor, and every
 *    endpoint is marked by calling the exported `Remote(name)` decorator
 *    factory directly. The gateway's source-reflection mode derives the wire
 *    descriptor from the method name and its single `input` parameter, so no
 *    Typert code generator and no strict schema artifact are required. The
 *    client half `$mount`s hand-authored descriptors with the matching
 *    `input` wire field.
 *
 * 2. **Web-server handler fallback.** Only used when the protocol package
 *    cannot be resolved or the Remote binding is refused. It registers one
 *    exact POST route under a per-boot random path and injects that path into
 *    the page through the structured `webserver/index-inject` table. The
 *    client prefers the injected path and never mounts descriptors in that
 *    mode, so the two transports cannot both answer.
 *
 * Mutations reuse the capture pipeline's ordering: append the JSONL revision
 * through `MemoryStore`, then apply the same change to the in-memory
 * `MemoryIndex`; deletion writes a tombstone and drops the index document.
 *
 * @module dsh-memory/host/remote
 */

import { randomUUID } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  PANEL_METHODS,
  PANEL_PACKAGE,
  PANEL_SERVICE,
  PanelInputError,
  applyRemove,
  applyUpdate,
  computeActivity,
  computeProfile,
  computeStats,
  projectBrief,
  bulkAction,
  createBackup,
  exportData,
  importData,
  knowledgeGraph,
  knowledgeList,
  knowledgeNote,
  knowledgePromote,
  knowledgeSave,
  knowledgeSync,
  captureRetry,
  captureStatus,
  memoryHistory,
  mergeTopics,
  obsidianExport,
  obsidianImport,
  obsidianStatus,
  syncObsidian,
  resolveObsidianConflict,
  purgeMemory,
  restoreMemory,
  restoreRevision,
  topicSuggestions,
  listMemories,
  rebuildMemoryIndex,
  updateSettings,
} from './remote-contract.js'

/** Injection global the web-server fallback writes for the Client half. */
export const PANEL_BOOT_GLOBAL = '__DSH_MEMORY__'
/** Maximum accepted JSON request body of the fallback route. */
const MAX_BODY_BYTES = 256 * 1024
/** Typert protocol package; imported lazily so a Host-only load never needs it. */
const TYPERT_PROTOCOL = '@deepseek-ai/dsh-typert-protocol'

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

function sizeOf(value) {
  if (Array.isArray(value)) return value.length
  if (value !== null && typeof value === 'object') return Object.keys(value).length
  return undefined
}

/**
 * Diagnostic call log for the panel RPC. It answers one question that no Host
 * inspection can: did the live browser half actually reach the Host? A missing
 * file means the Settings section was never opened (or never called), a line
 * with `ok:false` is a real transport failure.
 */
function makePanelCallLogger(root) {
  if (typeof root !== 'string' || root === '') return () => {}
  return (entry) => {
    try {
      appendFileSync(join(root, 'panel-calls.jsonl'), `${JSON.stringify(entry)}\n`, { mode: 0o600 })
    } catch {
      // The log is advisory; never fail the panel call over it.
    }
  }
}

/**
 * Bind the pure contract operations to the live store/index/config.
 * @param {{ store: object, index: object, config: object, root?: string }} options
 */
export function createPanelBackend(options) {
  if (options.unavailable) {
    return Object.fromEntries(PANEL_METHODS.map(method => [method, method === 'stats'
      ? () => ({ health: options.getHealth(), unavailable: options.unavailable })
      : () => { throw new PanelInputError(options.unavailable.message) }]))
  }
  const backend = {
    isolation: options.isolation,
    store: options.store,
    index: options.index,
    synchronize: typeof options.synchronize === 'function' ? options.synchronize : null,
    getProfile: typeof options.getProfile === 'function' ? options.getProfile : null,
    getGraphRecords: typeof options.getGraphRecords === 'function' ? options.getGraphRecords : null,
    root: options.root ?? null,
    syncService: options.obsidianSync ?? null,
    getLastInjection: typeof options.getLastInjection === 'function' ? options.getLastInjection : null,
    getLastExtraction: typeof options.getLastExtraction === 'function' ? options.getLastExtraction : null,
    getLastRecall: typeof options.getLastRecall === 'function' ? options.getLastRecall : null,
    getSemanticStatus: typeof options.getSemanticStatus === 'function' ? options.getSemanticStatus : null,
    getSettingsIssue: typeof options.getSettingsIssue === 'function' ? options.getSettingsIssue : null,
    getCaptureStatus: typeof options.getCaptureStatus === 'function' ? options.getCaptureStatus : null,
    retryCapture: typeof options.retryCapture === 'function' ? options.retryCapture : null,
    refreshKnowledge: typeof options.refreshKnowledge === 'function' ? options.refreshKnowledge : null,
    get config() {
      return typeof options.getConfig === 'function' ? options.getConfig() : (options.config ?? {})
    },
    applySettings: typeof options.applySettings === 'function' ? options.applySettings : null,
  }
  backend.list = (input) => listMemories(backend, input)
  backend.stats = (input) => computeStats(backend, input)
  backend.projectBrief = (input) => projectBrief(backend, input)
  backend.activity = (input) => computeActivity(backend, input)
  backend.profile = (input) => computeProfile(backend, input)
  backend.update = (input) => applyUpdate(backend, input)
  backend.removeMemory = (input) => {
    const result = applyRemove(backend, input)
    options.invalidateRecall?.()
    return result
  }
  backend.rebuildIndex = () => rebuildMemoryIndex(backend)
  backend.updateSettings = (input) => updateSettings(backend, input)
  backend.exportData = () => exportData(backend)
  backend.importData = (input) => importData(backend, input)
  backend.backup = () => createBackup(backend)
  backend.restoreMemory = (input) => restoreMemory(backend, input)
  backend.purgeMemory = (input) => purgeMemory(backend, input)
  backend.history = (input) => memoryHistory(backend, input)
  backend.bulkAction = (input) => bulkAction(backend, input)
  backend.restoreRevision = (input) => restoreRevision(backend, input)
  backend.topicSuggestions = (input) => topicSuggestions(backend, input)
  backend.mergeTopics = (input) => mergeTopics(backend, input)
  backend.obsidianExport = (input) => obsidianExport(backend, input)
  backend.obsidianImport = (input) => obsidianImport(backend, input)
  backend.obsidianStatus = () => obsidianStatus(backend)
  backend.obsidianSync = () => syncObsidian(backend)
  backend.obsidianResolve = input => resolveObsidianConflict(backend, input)
  backend.knowledgeGraph = (input) => knowledgeGraph(backend, input)
  backend.knowledgePromote = (input) => knowledgePromote(backend, input)
  backend.knowledgeList = () => knowledgeList(backend)
  backend.knowledgeNote = (input) => knowledgeNote(backend, input)
  backend.knowledgeSave = (input) => knowledgeSave(backend, input)
  backend.knowledgeSync = (input) => knowledgeSync(backend, input)
  backend.captureStatus = () => captureStatus(backend)
  backend.captureRetry = (input) => captureRetry(backend, input)
  const logCall = makePanelCallLogger(backend.root)
  for (const method of PANEL_METHODS) {
    const operation = backend[method]
    backend[method] = (input) => {
      const at = Date.now()
      const refreshKnowledge = (resolved) => {
        const shouldRefresh = method === 'knowledgePromote' || method === 'knowledgeSave' && resolved?.saved !== false ||
          method === 'knowledgeSync' && backend.config?.obsidian?.autoSync !== true
        if (shouldRefresh) {
          try { backend.refreshKnowledge?.() } catch { /* Note edits stay successful if derived lookup refresh fails. */ }
        }
        return resolved
      }
      try {
        backend.synchronize?.()
        const value = operation(input)
        if (value !== null && typeof value === 'object' && typeof value.then === 'function') {
          return value.then(
            (resolved) => {
              refreshKnowledge(resolved)
              logCall({ at, method, ok: true, size: sizeOf(resolved) })
              return resolved
            },
            (error) => {
              logCall({ at, method, ok: false, error: messageOf(error) })
              throw error
            },
          )
        }
        refreshKnowledge(value)
        logCall({ at, method, ok: true, size: sizeOf(value) })
        return value
      } catch (error) {
        logCall({ at, method, ok: false, error: messageOf(error) })
        throw error
      }
    }
  }
  return backend
}

/**
 * Mark every endpoint on the prototype, then construct the Remote service.
 * Marking first keeps a failed binding from registering a half-service.
 * @param {object} ctx Cordis context owning the service
 * @param {object} backend contract operations
 */
export async function bindTypertRemote(ctx, backend) {
  const protocol = await import(TYPERT_PROTOCOL)
  const { Remote, TypertRemoteService } = protocol
  if (typeof Remote !== 'function' || typeof TypertRemoteService !== 'function') {
    throw new Error(`${TYPERT_PROTOCOL} does not export Remote/TypertRemoteService`)
  }

  class PanelRemote extends TypertRemoteService {
    constructor(context, delegate) {
      super(context, PANEL_SERVICE)
      this.delegate = delegate
    }

    async list(input) {
      return this.delegate.list(input)
    }

    async stats(input) {
      return this.delegate.stats(input)
    }

    async projectBrief(input) {
      return this.delegate.projectBrief(input)
    }

    async activity(input) {
      return this.delegate.activity(input)
    }

    async profile(input) {
      return this.delegate.profile(input)
    }

    async update(input) {
      return this.delegate.update(input)
    }

    async removeMemory(input) {
      return this.delegate.removeMemory(input)
    }

    async rebuildIndex(input) {
      return this.delegate.rebuildIndex(input)
    }

    async updateSettings(input) {
      return this.delegate.updateSettings(input)
    }

    async exportData(input) {
      return this.delegate.exportData(input)
    }

    async importData(input) {
      return this.delegate.importData(input)
    }

    async backup(input) {
      return this.delegate.backup(input)
    }

    async restoreMemory(input) {
      return this.delegate.restoreMemory(input)
    }

    async purgeMemory(input) {
      return this.delegate.purgeMemory(input)
    }

    async history(input) {
      return this.delegate.history(input)
    }

    async bulkAction(input) {
      return this.delegate.bulkAction(input)
    }

    async restoreRevision(input) {
      return this.delegate.restoreRevision(input)
    }

    async topicSuggestions(input) {
      return this.delegate.topicSuggestions(input)
    }

    async mergeTopics(input) {
      return this.delegate.mergeTopics(input)
    }

    async obsidianExport(input) {
      return this.delegate.obsidianExport(input)
    }

    async obsidianImport(input) {
      return this.delegate.obsidianImport(input)
    }

    async obsidianSync(input) { return this.delegate.obsidianSync(input) }

    async obsidianResolve(input) { return this.delegate.obsidianResolve(input) }

    async obsidianStatus(input) {
      return this.delegate.obsidianStatus(input)
    }

    async knowledgeGraph(input) {
      return this.delegate.knowledgeGraph(input)
    }

    async knowledgePromote(input) {
      return this.delegate.knowledgePromote(input)
    }

    async knowledgeList(input) {
      return this.delegate.knowledgeList(input)
    }

    async knowledgeNote(input) {
      return this.delegate.knowledgeNote(input)
    }

    async knowledgeSave(input) {
      return this.delegate.knowledgeSave(input)
    }

    async knowledgeSync(input) {
      return this.delegate.knowledgeSync(input)
    }

    async captureStatus(input) {
      return this.delegate.captureStatus(input)
    }

    async captureRetry(input) {
      return this.delegate.captureRetry(input)
    }
  }

  // A prototype-only receiver satisfies the decorator initializer's
  // `Object.getPrototypeOf(this)` without constructing the service first.
  const receiver = Object.create(PanelRemote.prototype)
  for (const method of PANEL_METHODS) {
    const implementation = PanelRemote.prototype[method]
    if (typeof implementation !== 'function') throw new Error(`missing Remote implementation ${method}`)
    Remote(method)(implementation, {
      private: false,
      static: false,
      name: method,
      addInitializer: (initializer) => initializer.call(receiver),
    })
  }

  return new PanelRemote(ctx, backend)
}

function sendJson(response, payload) {
  const body = JSON.stringify(payload)
  response.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  response.end(body)
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new PanelInputError('request body is too large'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (text === '') {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(text))
      } catch {
        reject(new PanelInputError('request body is not valid JSON'))
      }
    })
    request.on('error', (error) => reject(error))
  })
}

/**
 * Dispatch one wire request against the backend. Also the unit-tested seam for
 * the fallback transport.
 * @param {object} backend
 * @param {unknown} method
 * @param {unknown} input
 */
export async function dispatchPanel(backend, method, input) {
  if (typeof method !== 'string' || !PANEL_METHODS.includes(method)) {
    throw new PanelInputError(`unknown panel method: ${JSON.stringify(method)}`)
  }
  return backend[method](input)
}

/**
 * One raw HTTP exchange of the fallback transport: `POST {method, input}` and
 * always a JSON envelope, so the client has one parsing path.
 */
export async function handlePanelRequest(backend, request, response) {
  if (request.method !== 'POST') {
    response.writeHead(405, { allow: 'POST' })
    response.end()
    return
  }
  try {
    const payload = await readJsonBody(request)
    const body = payload !== null && typeof payload === 'object' ? payload : {}
    const value = await dispatchPanel(backend, body.method, body.input)
    sendJson(response, { ok: true, value })
  } catch (error) {
    sendJson(response, {
      ok: false,
      error: {
        code: error instanceof PanelInputError ? 'invalid-input' : 'internal',
        message: messageOf(error),
      },
    })
  }
}

/**
 * Register the fallback route and publish its path to the page.
 * @param {object} ctx
 * @param {object} backend
 */
export function bindWebServerPanel(ctx, backend) {
  const server = typeof ctx.get === 'function' ? ctx.get('webServer') : undefined
  if (server === undefined || server === null || typeof server.register !== 'function') {
    throw new Error('webServer service is not mounted')
  }
  const token = randomUUID().replace(/-/gu, '')
  const path = `/dsh-memory/${token}`
  const removeRoute = server.register({
    kind: 'exact',
    path,
    handler: (request, response) => handlePanelRequest(backend, request, response),
  })
  let removeInjection
  try {
    removeInjection = ctx.on('webserver/index-inject', (table) => {
      if (!Array.isArray(table)) return
      table.push({ kind: 'global', name: PANEL_BOOT_GLOBAL, value: { transport: 'web-server', path } })
    })
  } catch (error) {
    try {
      removeRoute?.()
    } catch {
      // The route disposer is advisory on a failed registration path.
    }
    throw error
  }
  const dispose = () => {
    try {
      removeInjection?.()
    } catch {
      // Disposal is best effort; the owning fiber is going away either way.
    }
    try {
      removeRoute?.()
    } catch {
      // Disposal is best effort; the owning fiber is going away either way.
    }
  }
  try {
    ctx.effect(() => dispose, 'dsh-memory.panel-rpc.webserver')
  } catch (error) {
    dispose()
    throw error
  }
  return { transport: 'web-server', path, dispose }
}

/**
 * Wire the panel transport once per plugin activation. Never rejects: a Host
 * without either carrier keeps capture/recall working and the panel reports
 * the unavailable state in the browser.
 * @param {object} ctx
 * @param {{ store: object, index: object, config: object, root?: string }} options
 * @returns {Promise<{ transport: 'typert' | 'web-server' | 'unavailable', reason?: string }>}
 */
export async function wirePanel(ctx, options) {
  const backend = createPanelBackend(options)
  let typertError
  try {
    await bindTypertRemote(ctx, backend)
    return { transport: 'typert' }
  } catch (error) {
    typertError = error
  }
  try {
    const fallback = bindWebServerPanel(ctx, backend)
    ctx.logger?.warn?.(
      `[dsh-memory] Settings panel uses the webServer fallback because the Typert Remote binding failed: ${messageOf(typertError)}`,
    )
    return { transport: fallback.transport, path: fallback.path }
  } catch (error) {
    const reason = `Typert Remote: ${messageOf(typertError)}; webServer fallback: ${messageOf(error)}`
    ctx.logger?.warn?.(`[dsh-memory] Settings panel RPC unavailable (${reason})`)
    return { transport: 'unavailable', reason }
  }
}
