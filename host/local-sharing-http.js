import { randomUUID, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { createLocalSharingService } from './local-sharing.js'

const PAGE = fileURLToPath(new URL('../web/local-sharing.html', import.meta.url))
const SCRIPT = fileURLToPath(new URL('../web/local-sharing.js', import.meta.url))
const STYLE = fileURLToPath(new URL('../web/local-sharing.css', import.meta.url))
const MAX_BODY = 32 * 1024
const MAX_HEADER = 64 * 1024

function send(response, status, value, headers = {}) {
  const body = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value))
  response.writeHead(status, { 'cache-control': 'no-store', 'content-length': body.length, ...headers })
  response.end(body)
}

function json(response, status, value) {
  send(response, status, value, { 'content-type': 'application/json; charset=utf-8' })
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    request.on('data', chunk => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('request body is too large'), { status: 413 }))
        request.destroy()
      } else chunks.push(chunk)
    })
    request.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) }
      catch { reject(Object.assign(new Error('request body must be valid JSON'), { status: 400 })) }
    })
    request.on('error', reject)
  })
}

function equalToken(actual, expected) {
  if (typeof actual !== 'string' || actual.length !== expected.length) return false
  return timingSafeEqual(Buffer.from(actual), Buffer.from(expected))
}

export function createLocalSharingHttpServer({ root, profileIdentity, token, instanceId, port = 0, onStop = null,
  onListening = null, onClose = null }) {
  if (typeof token !== 'string' || token.length < 32) throw new TypeError('a local service token is required')
  const service = createLocalSharingService({ root, profileIdentity })
  let server
  const handle = async (request, response) => {
    const address = server.address()
    const origin = `http://127.0.0.1:${address.port}`
    const host = request.headers.host
    if (host !== `127.0.0.1:${address.port}`) return json(response, 403, { error: 'local host only' })
    const url = new URL(request.url ?? '/', origin)
    if (request.method === 'GET' && url.pathname === '/healthz') {
      return json(response, 200, { service: 'dsh-memory-local', instanceId })
    }
    if (request.method === 'GET' && url.pathname === '/') {
      return send(response, 200, readFileSync(PAGE), { 'content-type': 'text/html; charset=utf-8',
        'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
        'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' })
    }
    if (request.method === 'GET' && url.pathname === '/app.js') {
      return send(response, 200, readFileSync(SCRIPT), { 'content-type': 'text/javascript; charset=utf-8',
        'x-content-type-options': 'nosniff' })
    }
    if (request.method === 'GET' && url.pathname === '/app.css') {
      return send(response, 200, readFileSync(STYLE), { 'content-type': 'text/css; charset=utf-8',
        'x-content-type-options': 'nosniff' })
    }
    const authorization = /^Bearer ([A-Za-z0-9_-]+)$/u.exec(String(request.headers.authorization ?? ''))?.[1]
    if (!equalToken(authorization, token)) return json(response, 401, { error: 'local service token required' })
    if (request.method !== 'GET' && request.headers.origin !== undefined && request.headers.origin !== origin) {
      return json(response, 403, { error: 'cross-origin request rejected' })
    }
    try {
      if (request.method === 'GET' && url.pathname === '/api/status') {
        return json(response, 200, { projects: service.projects(), profile: 'active' })
      }
      const projectKey = url.searchParams.get('projectKey') ?? undefined
      if (request.method === 'GET' && url.pathname === '/api/list') {
        return json(response, 200, service.list({ projectKey, query: url.searchParams.get('query') ?? undefined,
          limit: Number(url.searchParams.get('limit') ?? 50), offset: Number(url.searchParams.get('offset') ?? 0),
          status: url.searchParams.get('status') ?? undefined }))
      }
      if (request.method === 'GET' && url.pathname === '/api/search') {
        return json(response, 200, service.search(url.searchParams.get('query') ?? '', projectKey,
          Number(url.searchParams.get('limit') ?? 12)))
      }
      if (request.method === 'GET' && url.pathname === '/api/brief') return json(response, 200, service.brief({ projectKey }))
      if (request.method === 'GET' && url.pathname === '/api/scenes') return json(response, 200, service.scenes({ projectKey }))
      if (request.method === 'GET' && url.pathname === '/api/rules') return json(response, 200, service.coreRules())
      if (request.method === 'GET' && url.pathname === '/api/reports') {
        return json(response, 200, service.recentReports(projectKey, Number(url.searchParams.get('limit') ?? 20),
          Number(url.searchParams.get('offset') ?? 0)))
      }
      if (request.method === 'POST' && url.pathname === '/api/forget') {
        const input = await readBody(request)
        return json(response, 200, service.forget(input.id, input.projectKey))
      }
      if (request.method === 'POST' && url.pathname === '/api/remember') {
        const input = await readBody(request)
        const sessionId = typeof input.sessionId === 'string' && input.sessionId !== '' ? input.sessionId : `web:${randomUUID()}`
        return json(response, 200, service.remember({ client: 'web', sessionId, messageId: input.messageId ?? randomUUID(),
          text: input.originalUserMessage, requestedProjectKey: input.projectKey }))
      }
      if (request.method === 'POST' && url.pathname === '/__admin/stop') {
        if (request.headers.origin !== undefined && request.headers.origin !== origin) return json(response, 403, { error: 'origin rejected' })
        json(response, 200, { stopped: true, instanceId })
        setTimeout(() => onStop?.(), 20).unref?.()
        return
      }
      return json(response, 404, { error: 'not found' })
    } catch (error) {
      return json(response, error?.status ?? 400, { error: error instanceof Error ? error.message : String(error) })
    }
  }

  server = createServer({ maxHeaderSize: MAX_HEADER }, (request, response) => { void handle(request, response) })
  server.requestTimeout = 15_000
  server.headersTimeout = 10_000
  server.on('clientError', (_error, socket) => socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'))
  let closePromise
  return {
    server,
    service,
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
          server.removeListener('error', reject)
          const address = server.address()
          try { onListening?.(address) }
          catch (error) { reject(error); return }
          resolve(address)
        })
      })
    },
    close() {
      if (closePromise) return closePromise
      service.close()
      closePromise = new Promise(resolve => {
        const finish = () => { try { onClose?.() } finally { resolve() } }
        if (!server.listening) { finish(); return }
        server.close(finish)
      })
      return closePromise
    },
  }
}
