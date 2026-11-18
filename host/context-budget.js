import { estimateTokens } from './recall.js'

const positive = value => Number.isSafeInteger(value) && value > 0
const sameRoute = (left, right) => left?.provider === right.provider && left?.model === right.model
const messageEstimates = new WeakMap()

function estimateVisibleMessage(message) {
  const cached = messageEstimates.get(message)
  if (cached !== undefined) return cached
  const content = typeof message?.content === 'string' ? message.content : JSON.stringify(message?.content ?? [])
  const tokens = estimateTokens(content) + 4
  if (message && typeof message === 'object' && Object.isFrozen(message)) messageEstimates.set(message, tokens)
  return tokens
}

async function windowFor(ctx, selection, context, signal) {
  if (sameRoute(context, selection) && positive(context.contextWindow)) return context.contextWindow
  const llm = ctx.get('llm')
  if (typeof llm?.resolveModelInfo !== 'function') return null
  const timeout = AbortSignal.timeout(750)
  const bounded = signal ? AbortSignal.any([signal, timeout]) : timeout
  if (bounded.aborted) return null
  try {
    const info = await Promise.race([
      llm.resolveModelInfo(selection.provider, selection.model, bounded),
      new Promise(resolve => bounded.addEventListener('abort', () => resolve(null), { once: true })),
    ])
    return positive(info?.context?.contextWindow) ? info.context.contextWindow : null
  } catch {
    return null
  }
}

/** Limit memories using the current route and the host's model-visible surface. */
export async function memoryBudgetFor(ctx, { agent, session, selection, messages, maxTokens, signal }) {
  if (typeof selection?.provider !== 'string' || typeof selection.model !== 'string') return maxTokens
  const window = await windowFor(ctx, selection, session.requestContext?.(), signal)
  if (window === null) return maxTokens

  const header = session.requestHeader?.()
  const routeMatches = sameRoute(header?.config, selection)
  const currentRouteHeader = routeMatches ? header : { config: selection, tools: header?.tools }
  const meter = ctx.get('tokenMeter')
  const estimate = (message) => {
    const visible = estimateVisibleMessage(message)
    try {
      const measured = meter?.estimateMessage?.(message)
      if (Number.isFinite(measured) && measured >= 0) return Math.max(visible, measured)
    } catch {}
    return visible
  }
  let measurement
  try { measurement = meter?.measure?.(session, currentRouteHeader) } catch {}
  let history = Number.isFinite(measurement?.totalTokens) ? Math.max(0, measurement.totalTokens) : 0
  if (measurement?.baseline?.kind !== 'usage') {
    // A provider usage anchor already accounts for its tokenizer. A heuristic
    // baseline may undercount CJK text, so use the more conservative estimate.
    const visible = (session.deriveMessages?.() ?? []).reduce((total, message) => total + estimateVisibleMessage(message), 0)
    const tools = header?.tools?.length ? estimateTokens(JSON.stringify(header.tools)) : 0
    history = Math.max(history, visible + tools)
  }

  const output = positive(agent.options?.maxTokens) ? agent.options.maxTokens
    : routeMatches && positive(header.config.maxTokens) ? header.config.maxTokens
      : Math.min(4096, Math.max(256, Math.floor(window / 8)))
  // The next system/tool projection can still change after pre-step.
  const headroom = Math.min(2048, Math.max(128, Math.ceil(window * .04)))
  const pending = messages.reduce((total, message) => total + estimate(message), 0)
  return Math.max(0, Math.min(maxTokens, Math.floor(window - history - pending - output - headroom)))
}
