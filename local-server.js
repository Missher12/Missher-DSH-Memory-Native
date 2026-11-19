#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { clearLocalSharingState, readLocalSharingState, startLocalSharing, standaloneNodeExecutable,
  statusLocalSharing, stopLocalSharing, writeLocalSharingReady } from './host/local-sharing-process.js'
import { createLocalSharingService } from './host/local-sharing.js'
import { handleClaudeHook, handleCodexHook } from './host/local-sharing-hooks.js'
import { createLocalSharingHttpServer } from './host/local-sharing-http.js'
import { serveLocalMcp } from './host/local-sharing-mcp.js'
import { projectIdentity } from './host/paths.js'

const ENTRY = fileURLToPath(import.meta.url)

function argumentsOf(argv) {
  const [command, ...rest] = argv
  const options = {}
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index]
    if (!value.startsWith('--')) throw new Error(`unexpected argument: ${value}`)
    const key = value.slice(2)
    const next = rest[index + 1]
    if (next === undefined || next.startsWith('--')) throw new Error(`missing value for --${key}`)
    options[key] = next
    index += 1
  }
  return { command, options }
}

function memoryRoot(options) {
  const root = options.root ?? process.env.DSH_MEMORY_ROOT
  if (typeof root !== 'string' || root.trim() === '') throw new Error('provide --root or set DSH_MEMORY_ROOT')
  return resolve(root)
}

function profileIdentity(root, supplied) {
  if (supplied) return supplied
  const owner = JSON.parse(readFileSync(resolve(root, 'data-owner.json'), 'utf8'))
  if (owner?.version !== 1 || typeof owner.identity !== 'string') throw new Error('the selected DSH memory root has no valid data-owner marker')
  return owner.identity
}

async function hook(command, root) {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  const projectKey = typeof input?.cwd === 'string' ? projectIdentity(input.cwd).key : null
  const service = createLocalSharingService({ root, projectKey })
  try {
    const output = command === 'claude-hook'
      ? await handleClaudeHook({ service, root, input })
      : await handleCodexHook({ service, root, input })
    process.stdout.write(`${JSON.stringify(output)}\n`)
  } finally { service.close() }
}

async function serve(root, identity, instanceId) {
  const state = readLocalSharingState(root)
  if (!state || state.instanceId !== instanceId || state.profileIdentity !== identity) {
    throw new Error('local sharing service state does not match this process')
  }
  let server
  server = createLocalSharingHttpServer({ root, profileIdentity: identity, token: state.token, instanceId,
    onStop: () => { void server.close() },
    onListening: address => writeLocalSharingReady(root, instanceId, address.port),
    onClose: () => clearLocalSharingState(root, instanceId),
  })
  try { await server.listen() }
  catch (error) { await server.close(); throw error }
}

function printClientConfig(root, projectPath) {
  const node = standaloneNodeExecutable()
  const args = [ENTRY, 'mcp', '--root', root, '--project', projectPath]
  const quote = value => JSON.stringify(value)
  const shellQuote = value => `'${String(value).replaceAll("'", "'\\''")}'`
  const quoteHookArgument = process.platform === 'win32'
    ? value => `"${String(value).replaceAll('"', '""')}"`
    : shellQuote
  const hookCommand = command => [node, ENTRY, command, '--root', root].map(quoteHookArgument).join(' ')
  const hookEntry = command => ({ type: 'command', command: hookCommand(command), timeout: 20 })
  const output = {
    claudeMcpJson: { mcpServers: { dsh_memory: { type: 'stdio', command: node, args } } },
    codexConfigToml: `[mcp_servers.dsh_memory]\ncommand = ${quote(node)}\nargs = [${args.map(quote).join(', ')}]\n`+
      'startup_timeout_sec = 20\n',
    claudeHooksJson: { hooks: {
      UserPromptSubmit: [{ hooks: [hookEntry('claude-hook')] }],
      Stop: [{ hooks: [hookEntry('claude-hook')] }],
    } },
    codexHooksJson: { hooks: {
      UserPromptSubmit: [{ hooks: [hookEntry('codex-hook')] }],
      Stop: [{ hooks: [hookEntry('codex-hook')] }],
    } },
  }
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
}

async function main() {
  const { command, options } = argumentsOf(process.argv.slice(2))
  const root = memoryRoot(options)
  if (command === 'start') {
    const result = await startLocalSharing({ root, profileIdentity: profileIdentity(root, options.profile) })
    process.stdout.write(`${JSON.stringify(result)}\n`)
  } else if (command === 'stop') {
    process.stdout.write(`${JSON.stringify(await stopLocalSharing(root))}\n`)
  } else if (command === 'status') {
    process.stdout.write(`${JSON.stringify(await statusLocalSharing(root))}\n`)
  } else if (command === 'print-config') {
    const projectPath = resolve(options.project ?? process.cwd())
    printClientConfig(root, projectPath)
  } else if (command === 'serve') {
    if (!options.profile || !options.instance) throw new Error('serve requires --profile and --instance')
    await serve(root, options.profile, options.instance)
  } else if (command === 'mcp') {
    const projectPath = resolve(options.project ?? process.cwd())
    const service = createLocalSharingService({ root, projectKey: projectIdentity(projectPath).key })
    try { await serveLocalMcp({ service, client: options.client ?? 'local' }) }
    finally { service.close() }
  } else if (command === 'claude-hook' || command === 'codex-hook') {
    await hook(command, root)
  } else {
    throw new Error('usage: local-server.js {start|stop|status|print-config|mcp|claude-hook|codex-hook}')
  }
}

if (process.argv[1] && resolve(process.argv[1]) === ENTRY) {
  main().catch(error => {
    const event = process.argv[2]
    if (event === 'claude-hook' || event === 'codex-hook') {
      process.stdout.write(`${JSON.stringify({ systemMessage: `DSH Memory hook unavailable: ${error.message}` })}\n`)
    } else {
      process.stderr.write(`${error.message}\n`)
      process.exitCode = 1
    }
  })
}
