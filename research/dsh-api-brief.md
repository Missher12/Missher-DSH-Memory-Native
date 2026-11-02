# DSH plugin API brief — exact contracts for a new memory plugin

Scope: what a NEW `@local/dsh-memory-*` bundle needs, derived from the installed Harness
(0.2.1-rc.4 packages, Cordis 4.0.5) and two reference plugins. Not a copy of TDAI.

Evidence tags used below:

- `[inspect:Host.Service/<key>]`, `[inspect:Host.Event/<name>]` = live `cordis_inspect_query`
  (authority for the running Harness).
- `[TDAI src/...]` = `/Users/missher/Documents/Codex-File/Deepseek-Corids/Missher-DSH-Memory-TDAI/src`
  and installed `~/.dsh/profiles/desktop/node_modules/@missher/dsh-memory-tdai/lib`.
- `[CM ...]` = `/tmp/cm-inspect/package/lib` (`@missher/dsh-context-manager` 0.10.2).
- `[asar ...]` = packages extracted read-only from
  `/Applications/DeepSeek Harness.app/Contents/Resources/app.asar` (host ships only built
  `lib/**/*.js`, no `.d.ts`; line numbers are from the extracted copy under `/tmp/asar/x/...`).

Verified today by an actual local Node probe unless marked *unverified*.

---

## A. Injection: `agent/pre-step` (+ the four useful lifecycle events)

### A1. Exact event contract `[inspect:Host.Event/agent/pre-step]`

```ts
'agent/pre-step'(
  this: Scoped<Agent>,
  payload: {
    agent: Agent                    // public shape: { readonly id: SessionId }
    messages: UserMessage[]
    turn: number
    step: number
    signal: AbortSignal
    modelSelection: Readonly<ModelSelection>   // captured step selection (provider/model/reasoningEffort?)
  },
  next: () => Promise<PreStepDecision>,
): Promise<PreStepDecision>

type PreStepDecision =
  | { kind: 'reject' }
  | { kind: 'enter'; messages: UserMessage[]; startsRequestSeries?: true }
```

Waterfall. Call `next()` to preserve current messages, then return a modified `enter` decision.
The returned `messages` array **replaces** the step input; there is no "append one message" API.

### A2. Inject one synthetic context message (TDAI's exact shape)

`[TDAI src/index.ts:95-125; createMemoryMessage at src/index.ts:170-177]`

```js
import { randomUUID } from 'node:crypto'

const MARK = { kind: 'memory', plugin: 'dsh-memory-mine' } // source marker is the idempotency key

function syntheticContextMessage(text) {
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    content: Object.freeze([{ type: 'text', text }]),
    source: Object.freeze(MARK),
  })
}

ctx.on('agent/pre-step', async (payload, next) => {
  const decision = await next()
  if (decision.kind === 'reject') return decision

  const base = decision.messages ?? payload.messages ?? []
  const retained = base.filter(m => !(m.source?.kind === 'memory' && m.source?.plugin === 'dsh-memory-mine'))
  const previous = base.length !== retained.length
  if (!shouldRecall(payload)) {
    return previous ? { ...decision, messages: retained } : decision
  }

  const block = recallBlock(payload)            // sync/cheap or precomputed in background
  if (!block) return previous ? { ...decision, messages: retained } : decision
  return { ...decision, messages: [...retained, syntheticContextMessage(block)] }
})
```

### A3. Idempotency rule (the important part)

There is no per-step dedupe token. TDAI makes injection idempotent by **re-deriving** every
step: it removes *all* messages whose `source` matches its own marker, then appends exactly one
fresh message. Consequences:

- The synthetic block never accumulates across steps/retries.
- Never mutate messages in place (`Object.freeze` the message/`source`/`content`);
  rebuild the array and spread `...decision` so `startsRequestSeries` and other decision fields survive.
- Only trust `decision.messages` after `next()`; it may already contain another plugin's messages.
- The message must be a real `UserMessage`: `role:'user'` and `content: TextBlock[]`
  (`MessageBase`/`UserMessage` in `[inspect:Host.Service/llm]` referenced types).
- Post-step dedupe state (e.g. "already recalled id X this session") belongs in your store, keyed by
  `(sessionId, turn|step)` or session id — never in closure globals that die with the plugin fiber.
- If recall should be exactly once per turn, gate on `payload.step`/`step/start` bookkeeping
  instead of relying on message history.

### A4. Lifecycle events available to a plugin `[inspect:Host.Event/*]`

| Event | Mode | Exact payload |
|---|---|---|
| `agent/created` | serial | `{ agent: Agent; source: 'startup'\|'resume'\|'clear'\|'compact'; signal?: AbortSignal }`; awaited before creation resolves, a throw fails creation |
| `session/event` | emit | `(session: Session, event: SessionEvent)` — `SessionEvent = { type, seq, time, data }` |
| `agent/turn-stopping` | serial | `{ agent: Agent; turn: number; signal: AbortSignal }`; awaited before the turn boundary commits; `agent.steer(...)` re-opens the turn |
| `agent/disposed` | emit | `{ agent: Agent }`; emitted after quiescence, before session detachment |
| `system-prompt/assemble` | waterfall | use `ctx.systemPrompt.section(...)` instead for a static section |
| `tools/pre-execute` / `tools/post-execute` | waterfall | tool policy / result offload |
| `llm/stream` | waterfall | intercept/observe model calls |

There is **no** host event literally named `turn/end`. `turn/end` is a `SessionEvent` type observed
through `session/event`:

```ts
// SessionEventType subset [inspect:Host.Event/session/event]
'turn/start': { turn: number }
'turn/end':   { turn: number; reason: TurnEndReason }
'step/start': { turn: number; step: number }
'step/end':   { turn: number; step: number }
'user/message': UserMessage
'assistant/message': { turn: number; step: number; message: AssistantMessage; stream: AssistantStreamRecord[]; usage?: TokenUsage; interrupted?: true }
'request/header': { header: EpochHeader; reason: RequestHeaderReason; startsSeries?: true }
'tool/result': { turn, step, message, error?, meta? }
```

Real consumer pattern `[TDAI src/memory.ts:1028-1060]`:

```js
ctx.on('session/event', (session, event) => {
  if (event.type === 'user/message') { const m = event.data; /* role/source filter */ }
  else if (event.type === 'assistant/message') { const m = event.data.message }
  else if (event.type === 'turn/end') { /* schedule background extraction once */ }
  if (event.type === 'request/header') { const { provider, model } = event.data.header.config }
})
```

Use `agent/turn-stopping` (serial, awaited) if extraction scheduling must finish before the turn closes;
use `session/event` + `turn/end` if it is fire-and-forget. Do not `await agent.whenIdle()` inside
`agent/created` (contract forbids it).

---

## B. Background LLM extraction

### B1. Service surface `[inspect:Host.Service/llm]`

```ts
ctx.llm.stream(options: GenerateOptions): AsyncIterable<StreamChunk>
ctx.llm.resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo>
ctx.llm.listModels(provider: string): Promise<LlmModelInfo[]>
ctx.llm.listProviders(): LlmProviderInfo[]
ctx.llm.prepareCall(config: LlmCallConfig, signal?, configure?): Promise<PreparedLlmCall>
ctx.llm.resolveCallConfig(config, signal?): Promise<LlmCallConfig>
```

`GenerateOptions` and chunks (live contract, not docs):

```ts
interface GenerateOptions {
  provider: string; model: string; reasoningEffort?: ReasoningEffortId
  messages: RequestMessage[]; system?: string; tools?: ToolSchema[]; toolHistory?: ToolHistory
  temperature?: number; maxTokens?: number; stop?: string[]; signal?: AbortSignal
  sessionId?: Branded<'SessionId'>; purpose?: 'compaction' | 'session-title'
}

// RequestMessage = Message | RequestUserInput
// RequestUserInput = { readonly role: 'user'; readonly content: UserMessage['content']; id?: never; source?: never }
//   → plain { role: 'user', content: [{ type: 'text', text }] } is valid, no id/source needed.

type StreamChunk =
  | { type: 'block-start'; index; blockType }
  | { type: 'text-delta'; index; text: string }
  | { type: 'reasoning-delta'; index; text }
  | { type: 'tool-call-delta'; index; id; name?; argumentsDelta }
  | { type: 'block-end'; index; block }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'finish'; reason: FinishReason; replayState? }
// FinishReason = {kind:'stop'|'tool-calls'|'max-tokens'} | {kind:'aborted', failure} | {kind:'error', failure}
// TokenUsage = { inputTokens; outputTokens; totalTokens?; cacheReadTokens?; cacheWriteTokens?; reasoningTokens? }
```

### B2. Exact stream loop + abort (copied shape from TDAI `src/extract.ts:262-331`)

```js
async function collectText(llm, route, messages, maxTokens, signal) {
  let text = ''
  let finish
  let failure
  const usage = {}
  try {
    for await (const chunk of llm.stream({
      provider: route.provider,
      model: route.model,
      ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
      messages,
      maxTokens,
      ...(signal === undefined ? {} : { signal }),
    })) {
      if (chunk.type === 'text-delta') text += chunk.text
      if (chunk.type === 'usage') Object.assign(usage, chunk.usage)
      if (chunk.type === 'finish') { finish = chunk.reason; Object.assign(usage, chunk.reason?.usage ?? {}) }
    }
  } catch (error) {
    failure = error
  }
  const terminal = failure !== undefined ? (signal?.aborted ? 'aborted' : 'stream-error')
    : finish?.kind === 'stop' ? 'stop' : (finish?.kind ?? 'missing-finish')
  if (terminal !== 'stop') throw new Error(`extraction failed: ${terminal}${failure ? `: ${failure.message}` : ''}`)
  return { text, usage }
}
```

Abort: pass the same `AbortSignal`; the stream rejects/ends. Treat `signal.aborted` as cancellation,
never retry after it. TDAI also treats `{ok:false}` parses as protocol failure and keeps the source
rows pending instead of committing an empty extraction — copy that rule.

### B3. Getting a provider/model route (order that actually works)

1. **Committed session route** (safest for reproducibility):
   `session.requestHeader()?.config` → `{ provider, model, reasoningEffort?, ... }`
   `[asar dsh-session/lib/types/index.js:758 requestHeader(): EpochHeader | undefined]`
   In `agent/pre-step` the same fact is `payload.modelSelection`.
   TDAI refuses to freeze a *provider default*; it pins the session's committed header only if it
   matches the captured route `[TDAI src/extract.ts:97-116]`.
2. **Explicit plugin config** (deterministic deployment): `config.extraction.provider` + `.model`.
   TDAI prefers this only when no committed route is supplied.
3. **Global default**: `ctx.agentDefaultModel.currentSelection()` →
   `{ provider, model, reasoningEffort? }` `[inspect:Host.Service/agentDefaultModel; asar dsh-agent-default-model/lib/index.js:38-45]`.
   Mutable mid-session, so snapshot it when a background job is created.

For the agent object use `ctx.sessions.get(agent.id)` (service `sessions.get`) or TDAI's
opportunistic `payload.agent.session` `[TDAI src/index.ts:105-106]`; `Agent.session` is not in the
public `Agent` interface, so prefer `ctx.sessions`.

Never let a background JSON extraction inherit `reasoningEffort: 'max'` (this profile has
`agent-default-model.reasoningEffort: max`). TDAI downgrades via `resolveModelInfo`:

```js
// TDAI src/extract.ts:38-44
const info = await llm.resolveModelInfo(provider, model, signal)
const offered = new Set(info.reasoning?.efforts.map(e => e.id) ?? [])
const reasoningEffort = ['off', 'none', 'minimal', 'low'].find(e => offered.has(e))
```

Config fields TDAI exposes for this: `extraction.{enabled,everyNConversations,idleSeconds,
maxMemoriesPerPass,provider,model,maxTokens,minTurnChars,maxWaitSeconds}` `[TDAI src/config.ts:39-57]`.
A new plugin only *needs* `{ enabled, provider?, model?, maxTokens? }` plus its own defaults.
Credentials are Host-owned: the plugin never reads keys or opens a provider connection.

Dependency: add `llm` to `inject` (hard) or `ctx.get('llm')` with undefined check (optional).
TDAI's structural approach (`inject: ['tools']`, optional `ctx.llm`) exists so embedded contexts
without LLM still load `[TDAI src/index.ts:25-26, src/dsh.ts:99-113]`.

---

## C. Plugin-owned storage

### C1. Decision table

| Option | Use when | Cost |
|---|---|---|
| `storageDomain` + `defineDomain` (recommended, host-managed) | structured records; want schema validation, versioning, backend routing, backup semantics | zod schemas; caller must `close()`; not guaranteed mounted |
| plain files under profile/DSH home | always works; SQLite/JSONL/logs; plugin fully owns format | you own migrations, locking, corruption handling, backup |
| `spillStore` | large tool results / text spills only | abstract service you must implement; session-scoped, not KV |
| `storage` hub | backend/data-form **providers** only | not a consumer store |

### C2. `storageDomain` exact use

`[inspect:Host.Service/storageDomain]` `[asar dsh-storage-domain/lib/index.js:61-75,190-273,381-424]`
`[CM lib/index.js:333-370]` (real consumer):

```js
import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'

const record = z.object({ id: z.string(), text: z.string(), createdAt: z.number() }).strict()

const SPEC = defineDomain({
  name: 'dsh_memory_mine',            // ^[a-z][a-z0-9_]*$ ; global schema must reject null
  version: 1,
  tables: { records: domainTable(record) },
})

// apply(ctx):
const domain = await ctx.storageDomain.open(SPEC)      // inject: ['storageDomain']
ctx.effect(() => () => domain.close(), 'memory.domain')
const table = domain.table('records')
await table.put('a', { id: 'a', text: '...', createdAt: Date.now() })
table.get('a'); [...table.entries()]; table.keys(); table.size; table.delete('a')
// domain.close() idempotent; ctx.storageDomain.closeAll() on facility unmount
```

Persistence/backup: the active storage backend decides the medium (profile `storages`, backend
plugin e.g. `@deepseek-ai/dsh-storage-json`); `defineDomain` version + `compatibleVersions` +
`invalidRecords: 'backup-and-skip'` give upgrade/repair semantics. `open()` validates every stored
record with your zod schema and fails with `invalid-record` otherwise `[asar dsh-storage-domain/lib/index.js:381-423]`.

### C3. `storage` and `spillStore` (do not misuse)

- `ctx.storage.mount(form, facility)` / `.form(form)` / `.backend.register|get|names()` are
  **provider** APIs; `backend.get(name)` throws `backend-not-found` `[asar dsh-storage/lib/index.js:35-137]`.
- `ctx.spillStore.saveText({ owner:{sessionId}, source:{kind:'tool',toolName,callId,label} |
  {kind:'session-reference',sessionId,label}, suggestedName, content })
  → { locator, bytes, retrievalHint }`; abstract, one impl per context, rejects on real storage
  failure, session-scoped private `[inspect:Host.Service/spillStore]`. Not a general store.

### C4. Plain-file pattern that matches Host conventions

```js
import { mkdirSync, writeFileSync, renameSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { homedir } from 'node:os'

function dataRoot(ctx, pluginName) {
  const homeFn = safeGet(ctx, 'dshHomePath')            // provided as a FUNCTION by dsh-app-boot
  const home = typeof homeFn === 'function' ? homeFn()
    : path.join(process.env.DSH_HOME?.trim() || path.join(homedir(), '.dsh'))
  const profileDir = safeGet(ctx, 'profileContext')?.dir // absolute profile dir at runtime
  const base = profileDir ? path.join(profileDir, pluginName) : path.join(home, pluginName)
  mkdirSync(base, { recursive: true, mode: 0o700 })
  return base
}

// atomic write; never symlink-follow blindly
const tmp = path.join(dir, `.${file}.${randomUUID()}.partial`)
writeFileSync(tmp, data, { encoding: 'utf8', mode: 0o600 })
renameSync(tmp, file)
```

Facts behind this:

- `dshHomePath` is provided by `dsh-app-boot` (`ctx.provide("dshHomePath", dshHomePath)`) and
  resolves explicit config → `$DSH_HOME` → `~/.dsh` `[asar dsh-app-boot/lib/index.js:4585;
  dsh-home-paths/lib/index.js:95-134]`.
- `profileContext` runtime object is `{ name, packageManager?, dir, patchPath, installAnchor,
  startedBundles, cwd, home, overlays, telemetryDisabledEnv }`
  `[asar dsh/lib/profile-boot-e2mS45fC.js:291-302]`; the inspect-declared interface only lists 4
  fields, so read it defensively.
- TDAI's `resolveMemoryRoot(dataDir, dshHome, profileDir)` is the reference:
  explicit `dataDir` wins; otherwise `<profileDir>/memory-tdai`; otherwise `$DSH_HOME/memory-tdai`;
  it validates the profile dir is absolute + a real directory, refuses a symlinked legacy root,
  and uses a `.profile-owner.json` ownership marker for adoption `[TDAI src/project.ts:95-126]`.
- Backup/resume: the profile dir is the unit DSH backs up (`~/.dsh/backups`); do **not** store state
  inside the package directory (replaced on upgrade; a linked directory is an exception, not a
  guarantee). Keep an explicit `schemaVersion` in your file and migrate on load. For SQLite, set
  WAL, close on fiber dispose (`ctx.effect`), and never assume your plugin is the only writer across
  restarts. `storageDomain` exists precisely to avoid re-implementing this.

---

## D. Client UI + Host⇄Client RPC (the "no codegen" answer)

### D1. `settings.section` slot — exact registration

`settings.section` is a **list-kind, root-scope** slot
`[asar dsh-client-ui-settings-general/lib/client.js:1434-1452,1555-1557]`; it renders
`renderSlot("settings.section", { close })`, so components receive `{ close }` plus your injected props
`[asar dsh-client-ui-settings-general/lib/client.js:346-350]`.

Live registration options actually used by shipped plugins
`[asar dsh-client-ui-settings-account/lib/client.js:5420-5430]`:

```js
ctx.slots.inject('settings.section', () => ctx.slots.register({
  name: 'settings.section',
  id: 'memory-mine',
  order: 16,
  label: () => t('nav'),          // string or () => locale string
  locale: 'settings.memory',      // optional i18n namespace
  inject: () => actions,          // props factory, re-evaluated per render
}, Dashboard))
```

TDAI's exact form `[TDAI src/client/index.tsx:32-38]` is the same with `label: () => 'Memory'`.
`ctx.slots.inject(key, cb)` waits for the declaration, re-runs on re-declaration and its disposer
cancels `cb` `[asar dsh-client-ui-renderer/lib/client.js:1348-1420]`. `label`/`locale` is how the
settings nav row gets its text; do not hardcode nav text in the panel.

### D2. Client module form (hand-authored JS, no build)

```js
window.__ModuleLoader__.load({
  id: '@local/dsh-memory-mine',
  factory(require) {
    const React = require('react')
    return {
      inject: ['slots', 'remote'],
      apply(ctx) {
        return ctx.remote.$mount(CONTRIBUTION).then(unmount => {
          const actions = { refresh: async () => unwrap(await ctx.get('remote.memoryMine').refresh({})) }
          const dispose = ctx.slots.inject('settings.section', () => ctx.slots.register({ ... }, Panel))
          return () => { dispose?.(); void unmount() }
        })
      },
    }
  },
})
```

`require` resolves React and host client services from the browser module table; `dsh.client.inject`
declares which client packages must be loaded first.

### D3. Host data: hand-authored descriptors + `$mount` — **works without Typert codegen**

TDAI proves it: its client entry is `{ package, descriptors }` (no `createTypertRemoteInfo`,
no decorators) and it calls `ctx.remote.$mount(...)`
`[TDAI lib/typert.remote-client.js; TDAI src/client/index.tsx:11-14]`. `$mount` walks
`contribution.package` + `contribution.descriptors` and registers each `namespace` as
`remote.<namespace>` `[asar dsh-api-gateway/lib/types/client/index.js:88-95,117-145,564-566]`.

Minimal descriptor (copy the shape verbatim `[TDAI lib/client/index.js:20661-20700]`):

```js
const strictCodec = (typeSymbol, schema) => ({ mode: 'strict', typeSymbol, create: () => schema })

const CONTRIBUTION = {
  package: '@local/dsh-memory-mine',
  descriptors: [
    {
      id: '@local/dsh-memory-mine#memoryMine/status',
      service: 'memoryMine',
      namespace: 'memoryMine',
      method: 'status',
      invocation: { kind: 'direct' },
      parameters: [],
      result: strictCodec('@local/dsh-memory-mine#Status', StatusSchema), // zod schema
      sourceLocation: { file: 'src/remote.js', line: 1, column: 1 },
    },
    {
      id: '@local/dsh-memory-mine#memoryMine/append',
      service: 'memoryMine', namespace: 'memoryMine', method: 'append',
      invocation: { kind: 'direct' },
      parameters: [{ name: 'request', wire: 'request', source: 'json',
        codec: strictCodec('@local/dsh-memory-mine#AppendRequest', AppendRequestSchema) }],
      result: strictCodec('@local/dsh-memory-mine#AppendAck', AppendAckSchema),
      sourceLocation: { file: 'src/remote.js', line: 1, column: 1 },
    },
  ],
}
```

Gateway requirements `[asar dsh-api-gateway/lib/types/client/index.js:146-188,597-611]`:
every parameter/uplink/invocation codec must have `mode: 'strict'`; `namespace`+`method` unique;
method name must not collide with the namespace service's own fields. Caller side:
`const r = await ctx.get('remote.memoryMine').append({ ... })` returns
`{ ok: true, value }` or `{ ok: false, error: RemoteError }` — unwrap it (TDAI does exactly that)
`[TDAI src/client/index.tsx:20-26]`.

**Can `ctx.typert.register(TYPERT)` replace this? No.** `typert` is the schema/reflection registry
(`register/get/resolve/list/getPackage` over `TypertContribution`); the transport Gateway discovers
services by reading a `typertRemote` binding on the service instance plus Remote method markers on its
prototype `[asar dsh-api-gateway/lib/types/index.js:237-241,1188-1203;
dsh-api-gateway/lib/index.js:1731-1739]`. Registering a `{package, face:'host', schemas,
invocations, model}` contribution (TDAI's `./typert` export) only populates reflection/metadata.

### D4. Host side: `TypertRemoteService` equivalent in plain JS — **proven**

Gateway-bindable host service = `typertRemote` binding + versioned method markers. In plain JS,
subclass `TypertRemoteService` (which installs the binding) and invoke the exported `Remote(name)`
decorator factory manually with a one-line initializer context:

```js
import { Remote, TypertRemoteService, remoteMethods } from '@deepseek-ai/dsh-typert-protocol'

export class MemoryMineRemote extends TypertRemoteService {
  constructor(ctx, backend) { super(ctx, 'memoryMine'); this.backend = backend }
  async status() { return this.backend.status() }
  async append(input) { return this.backend.append(appendSchema.parse(input)) }
}

export function bindRemote(ctx, backend) {
  const instance = new MemoryMineRemote(ctx, backend)       // registers service + typertRemote
  for (const method of ['status', 'append']) {
    const fn = Object.getPrototypeOf(instance)[method]
    Remote(method)(fn, {                                  // same factory the decorator syntax calls
      private: false, static: false, name: method,
      addInitializer: (init) => init.call(instance),       // marks Object.getPrototypeOf(instance)
    })
  }
  return instance
}
```

Probe executed today against the shipped protocol package:

```text
remoteMethods: [{"method":"status","invocation":{"kind":"direct"}}]
typertRemote: {"serviceKey":"widget","namespace":"widget"}
ctx.get('widget') -> object
```

Alternatives, in order of preference:

1. TypeScript source + real decorators (exact TDAI/CM form) compiled once. Cleanest; needs a build step.
2. The plain-JS `Remote(name)(fn, fakeContext)` shim above (no build; uses only public exports).
3. `bindTypertRemote(service, key, {namespace})` for a service that cannot extend
   `TypertRemoteService`; then attach the same markers.
4. Writing the prototype marker record by hand
   `{ version: 1, methods: [{ method, invocation:{kind:'direct'} }] }` under
   `'@deepseek-ai/dsh-typert-protocol/remote-methods'` — works but duplicates a private constant; avoid.

Guard pattern TDAI uses because embedded/test contexts may not own services
`[TDAI src/index.ts:40-89]`:

```js
if (typeof ctx.provide === 'function') {
  try { new MemoryMineRemote(ctx, backend) }
  catch (error) { ctx.logger?.warn?.(`[memory-mine] dashboard RPC unavailable: ${error.message}`) }
}
```

The service key must be a valid RPC segment `[A-Za-z0-9_$.-]+` and should match the descriptor
`namespace`; `super(ctx, key)` provides `ctx.<key>` and the binding in one step.

Unverified: an actual browser WebSocket round-trip of a hand-authored descriptor (no open page with
inspect auth today). The descriptor shape is taken from TDAI's shipped client bundle, and the gateway
validation path was read directly; the marker binding was executed locally.

---

## E. Config

One sentence: export `Config` (a Standard-Schema schema — DSH convention is
`@deepseek-ai/schemastery` `z.object({...})`; zod v4 also works because Cordis calls
`Config['~standard'].validate(rowConfig)`), and Cordis validates each loader row's `config` before
activation, then calls `apply(ctx, validatedConfig)` — see
`[asar cordis/lib/index.js:956-961]`; `.default()/.required()/.description()/.volatile()` feed the
settings/config-editor metadata; a patch `config:` replaces the row's config wholesale, never merges
`[host-plugin.md:61-64; cordis-composition-reference]`.

Real example `[asar dsh-agent-default-model/lib/index.js:17-25]`:

```js
import z from '@deepseek-ai/schemastery'
var AgentDefaultModelConfig = class extends Service {
  static Config = z.object({
    provider: z.string().required().volatile(),
    model: z.string().required().volatile(),
    reasoningEffort: z.string().volatile(),
  })
}
```

Function-form plugins use `export const Config = ...` beside `export function apply(ctx, config)`
(same file, `[host-plugin.md:57-64]`). TDAI instead hand-rolls defaults in `resolveConfig()` with a
plain TS interface `[TDAI src/config.ts]` — that works but loses schema validation and the settings
UI; a new plugin should declare a real schema.

---

## F. Packaging / install

### F1. Minimal bundle with Host + Client

```json
{
  "name": "@local/dsh-memory-mine",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./index.js",
    "./client": "./client.js",
    "./locale/*.json": "./locale/*.json",
    "./icon": "./icon.svg"
  },
  "files": ["index.js", "client.js", "cordis.patch.yml", "locale/*.json", "icon.svg"],
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "immediately": true,
      "inject": ["@deepseek-ai/dsh-client-ui-settings", "@deepseek-ai/dsh-api-remotes", "@deepseek-ai/dsh-client-locale"]
    }
  }
}
```

`cordis.patch.yml`:

```yaml
- insert:
    - id: memory-mine
      name: '@local/dsh-memory-mine'
      config: {}          # must satisfy the exported Config schema
```

Notes:

- `dsh.bundle.patch` is what makes the package a bundle `[host-plugin.md:5-27]`.
- `dsh.client.platform: 'web'` + `./client` export makes `client.js` load in the page;
  `immediately: true` loads it before the settings panel is opened (TDAI/WEB plugins use it for
  `$mount`); `dsh.client.inject` lists client packages that must be loaded first.
  The client artifact must be `window.__ModuleLoader__.load({ id: <package name>, factory })`
  and the id must equal the package name `[ui-plugin.md:9; TDAI lib/client/index.js:1-2]`.
- Locale: `locale/en.json` (and user language) with `meta.title`/`meta.description`; export
  `./locale/*.json` `[host-plugin.md:29-51]`.
- Icon: `icon.svg`/`.png`/`.jpg`/`.webp` ≤ 256 KiB inside the package; export `./icon` or a
  top-level `package.json` `"icon"` path. Missing → default artwork; malformed → diagnostic
  `[host-plugin.md:33-53]`.
- If the Host half needs no client, omit `dsh.client` and the `./client` export entirely.

### F2. Install

`plugin_manager` `action: install_bundle`, `target:` the **absolute package directory**
`[host-plugin.md:68; cordis-plugin-development skill]`. It writes the profile dependency and selects
the bundle; do not hand-edit the profile's `package.json`/`cordis.patch.yml`.

Linked (directory) install caveats `[host-plugin.md:35]`:

- It links the checkout; `files` does **not** filter a linked directory — every file you leave there
  is part of the installed plugin. Keep `files` accurate anyway for packed distribution.
- JS edits are picked up by HMR on remount; replacing an *installed* package needs a restart to load
  a fresh module generation. `application: applied` / warnings decide liveness, not logs.
- `restart-required` means the change is not live; `failed` needs diagnosis; `overridden` means a
  higher-priority patch layer wins.
- The profile here installs reference plugins as packed `file:...tgz`
  (`~/.dsh/profiles/desktop/package.json`), while some `@missher/sb-host-*` rows use directory
  `file:` specs — a directory install is a normal supported form.
- Client bundle changes reload without a page refresh only while `pnpm run dev:web` rebuilds their
  bundles from this checkout; otherwise rebuild the client artifact and refresh the page.

---

## What was verified vs. unverified

Verified here:

- Host `Service`/`Event` contracts queried live (`llm`, `storage`, `storageDomain`, `spillStore`,
  `agentDefaultModel`, `profileContext`, `sessions`; `agent/pre-step`, `agent/created`,
  `agent/turn-stopping`, `session/event`).
- TDAI/CM source and compiled bundles read for the injection, extraction, descriptor and client
  registration shapes.
- Plain-JS host Remote binding probe passed (markers visible, `typertRemote` binding present,
  service registered, method callable) using the shipped `@deepseek-ai/dsh-typert-protocol`.

Unverified / blockers:

- Live Client inspect (`Slots.listSubTree`, client `Service`/`Builtin`) timed out because no
  authenticated Web page is connected (`GET /` → 401). `settings.section` options/props above come
  from shipped registrations and the renderer source, not from the live slot tree.
- No browser round-trip of a hand-authored descriptor, and no end-to-end install of a new
  Host+Client bundle (this task authorized research only). Treat `ctx.remote.$mount(...)` +
  `ctx.get('remote.<ns>')` as proven-by-reference, not proven-by-run.
- The app ships built `lib/**/*.js` only; `.d.ts` files are absent from `app.asar`, so all type text
  above is reconstructed from live inspect contracts plus shipped JSDoc/JS. Line numbers for
  `[asar ...]` refer to the extracted archive copy.
