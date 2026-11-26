export function sourceEventTime(value) {
  return Number.isSafeInteger(value) && Math.abs(value) <= 8.64e15 ? value : undefined
}

export function sourceEventSequence(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

export function normalizeClientTimeZone(value) {
  if (typeof value !== 'string' || value.length > 128 ||
      !/^(?:UTC|[a-z_+-]+(?:\/[a-z0-9_+-]+)+)$/iu.test(value)) return undefined
  try { return new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone }
  catch { return undefined }
}

export function sourceTimeReference(source) {
  const eventTime = sourceEventTime(source.eventTime)
  return {
    at: source.at,
    eventTime,
    eventSeq: sourceEventSequence(source.eventSeq),
    timeZone: eventTime !== undefined && source.role === 'user' && source.sourceKind === 'user'
      ? source.timeZone : undefined,
  }
}

export function sourceAvailableAt(reference, now) {
  const at = sourceEventTime(reference?.eventTime) ?? sourceEventTime(reference?.at)
  return at !== undefined && at <= now
}
