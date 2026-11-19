export const MIN_CONTINUATION_CHARS = 1200
export const MAX_CONTINUATION_DEPTH = 4
export const MAX_COMPLETION_ROUNDS = 2
export const RECOVERY_OUTPUT_TOKENS = 4096

export function emptyCapacityResult(task) {
  return task.callState === 'completed' && !String(task.resultText ?? '').trim() &&
    (['max-tokens', 'length'].includes(task.resultFinishKind) || /输出预算耗尽且无可用文本/u.test(task.reason ?? ''))
}

export function sameRoute(a, b) {
  return a?.provider === b?.provider && a?.model === b?.model && a?.reasoningEffort === b?.reasoningEffort
}

export function dayKey(ms) {
  const date = new Date(ms)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

export function nextDayStart(ms) {
  const date = new Date(ms)
  date.setHours(24, 0, 0, 0)
  return date.getTime()
}

// Older receipts used UTC dates. Interpret their original call timestamp;
// never reset an already-spent allowance merely because the plugin upgraded.
export function receiptDay(day, at, calendar) {
  return calendar !== 'local' && Number.isFinite(at) && new Date(at).toISOString().slice(0, 10) === day
    ? dayKey(at) : day
}

export function combineSignals(...signals) {
  const active = signals.filter(signal => signal !== null && typeof signal === 'object' &&
    typeof signal.addEventListener === 'function' && typeof signal.aborted === 'boolean')
  if (active.length <= 1) return active[0]
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(active)
  const controller = new AbortController()
  for (const signal of active) {
    if (signal.aborted) controller.abort(signal.reason)
    else signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true })
  }
  return controller.signal
}

// Explicit/manual calls bypass the automatic allowance. Preserve automatic
// calls separately so a later manual retry cannot erase their budget usage.
export function automaticBudget(task) {
  if (typeof task.automaticCallDay === 'string' && Number.isInteger(task.automaticCalls)) {
    return { day: receiptDay(task.automaticCallDay, task.automaticCallAt ?? task.lastCallAt, task.budgetReservation?.calendar),
      calls: Math.max(0, task.automaticCalls) }
  }
  return typeof task.lastCallAt === 'number' && !task.explicit && !task.manual
    ? { day: dayKey(task.lastCallAt), calls: 1 }
    : { day: null, calls: 0 }
}

/** Normalize provider usage without inventing zeros for missing fields. */
export function normalizeUsage(value) {
  if (value === null || typeof value !== 'object') return null
  const pick = (...names) => {
    for (const name of names) {
      const candidate = value[name]
      if (Number.isInteger(candidate) && candidate >= 0) return candidate
    }
    return undefined
  }
  const input = pick('inputTokens', 'input_tokens', 'promptTokens', 'prompt_tokens')
  const output = pick('outputTokens', 'output_tokens', 'completionTokens', 'completion_tokens')
  const total = pick('totalTokens', 'total_tokens')
  if (input === undefined && output === undefined && total === undefined) return null
  return {
    ...(input === undefined ? {} : { inputTokens: input }),
    ...(output === undefined ? {} : { outputTokens: output }),
    ...(total === undefined ? {} : { totalTokens: total }),
  }
}

/**
 * Split source messages into segment entries without truncating text.
 * Each entry records the source id plus a character range into that source.
 */
/** Split a task's covered source ranges into two contiguous children. */
export function splitRanges(entries) {
  const total = entries.reduce((sum, entry) => sum + (entry.to - entry.from), 0)
  if (total < MIN_CONTINUATION_CHARS * 2) return null
  const target = Math.floor(total / 2)
  const left = []
  const right = []
  let seen = 0
  let split = false
  for (const entry of entries) {
    const length = entry.to - entry.from
    if (split) {
      right.push({ ...entry })
      continue
    }
    if (seen + length <= target) {
      left.push({ ...entry })
      seen += length
      continue
    }
    const cut = target - seen
    if (cut > 0) left.push({ ...entry, to: entry.from + cut })
    if (entry.from + cut < entry.to) right.push({ ...entry, from: entry.from + cut })
    split = true
    seen += length
  }
  if (left.length === 0 || right.length === 0) return null
  return [left, right]
}
