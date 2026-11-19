import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'

const TOOL_LIST = [
  { name: 'memory_search', description: 'Search current project and global DSH memory; return exact record IDs, revisions, and authorized source evidence.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 50 } }, required: ['query'], additionalProperties: false } },
  { name: 'memory_project_brief', description: 'Read the evidence-backed brief for the project bound by this MCP server.',
    inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 200 }, offset: { type: 'integer', minimum: 0 } }, additionalProperties: false } },
  { name: 'memory_core_rules', description: 'Read confirmed global preferences and decisions with source evidence.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'memory_recent_reports', description: 'Read recent recall reports for the bound project. An absent answer excerpt means no answer was observed.',
    inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 100 }, offset: { type: 'integer', minimum: 0 } }, additionalProperties: false } },
]

function result(value, isError = false) {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], isError }
}

export function dispatchMcpRequest(service, request, { client = 'local', sessionId = null } = {}) {
  if (!request || request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
    return { jsonrpc: '2.0', id: request?.id ?? null, error: { code: -32600, message: 'invalid JSON-RPC request' } }
  }
  if (request.method.startsWith('notifications/')) return null
  const id = request.id ?? null
  if (request.method === 'initialize') return { jsonrpc: '2.0', id, result: {
    protocolVersion: typeof request.params?.protocolVersion === 'string' ? request.params.protocolVersion : '2024-11-05',
    capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'dsh-memory-local', version: '1.8.0-native' },
  } }
  if (request.method === 'ping') return { jsonrpc: '2.0', id, result: {} }
  if (request.method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: TOOL_LIST } }
  if (request.method !== 'tools/call') return { jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found' } }
  const name = request.params?.name
  const args = request.params?.arguments && typeof request.params.arguments === 'object' ? request.params.arguments : {}
  try {
    let value
    if (name === 'memory_search') value = service.search(args.query, undefined, args.limit ?? 12)
    else if (name === 'memory_project_brief') value = service.brief({ limit: args.limit ?? 100, offset: args.offset ?? 0 })
    else if (name === 'memory_core_rules') value = service.coreRules()
    else if (name === 'memory_recent_reports') value = service.recentReports(undefined, args.limit ?? 20, args.offset ?? 0)
    else return { jsonrpc: '2.0', id, error: { code: -32602, message: 'tool not found' } }
    return { jsonrpc: '2.0', id, result: result(value) }
  } catch (error) {
    return { jsonrpc: '2.0', id, result: result({ error: error instanceof Error ? error.message : String(error) }, true) }
  }
}

export async function serveLocalMcp({ service, input = process.stdin, output = process.stdout, client = 'local', sessionId = randomUUID() }) {
  const lines = createInterface({ input, crlfDelay: Infinity })
  for await (const line of lines) {
    if (line.trim() === '') continue
    let request, response
    try {
      request = JSON.parse(line)
      response = dispatchMcpRequest(service, request, { client, sessionId })
    } catch (error) {
      response = { jsonrpc: '2.0', id: request?.id ?? null,
        error: { code: -32700, message: error instanceof Error ? error.message : String(error) } }
    }
    if (response !== null) output.write(`${JSON.stringify(response)}\n`)
  }
}
