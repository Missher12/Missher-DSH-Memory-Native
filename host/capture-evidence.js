import { analyzeUserMessageControls } from './user-controls.js'
import { tokenize } from './tokenize.js'
import { looksSensitive } from './records.js'

export const EXPLICIT_MEMORY_PATTERN = /记住|记一下|记下这个|别忘|以后都|从现在起|remember (?:this|that)|don'?t forget|from now on/iu
const MAX_EVIDENCE_EXCERPT = 240

// Short confirmed decisions qualify for normal (budgeted) capture. Only a
// direct assertion counts; questions, hypotheticals and opt-outs still skip.
export function isOrdinaryDecision(source) {
  if (!isDirectUserSource(source) || memoryOptOut(source)) return false
  return (source.text.match(/[^。！？!?\n]+[？?]?/gu) ?? []).some(sentence =>
    !/(?:如果|假如|要不要|是否|能不能|要是|可能|打个比方|假设|吗\s*$|[？?]|should we|what if)/iu.test(sentence) &&
    /(?:我(?:们)?(?:已)?决定|我们(?:就|改用)|定为|改为|改成|改到|改在|从今(?:起|以后)|以后(?:都|统一)|先(?:别|不)(?:升|改|迁移)|we decided|we(?:'ll| will) (?:switch|use))/iu.test(sentence))
}

// Use enclosing sentences so an extractor cannot quote "升级" out of
// "不要升级". Offsets refer to the stored original JS string (UTF-16).
export function locateSourceSentence(entry, needle) {
  const { source, from, to } = entry
  const start = source.text.indexOf(needle, from)
  if (start < from || start + needle.length > to || source.text.indexOf(needle, start + 1) >= 0 ||
      source.text.indexOf(needle) !== start) return null
  const end = start + needle.length
  const boundary = /[。！？!?；;\n]|\.(?=\s|$)/gu
  let left = 0, right = source.text.length
  for (const match of source.text.matchAll(boundary)) {
    if (match.index + 1 <= start) left = match.index + 1
    else if (match.index >= end - 1) { right = match.index + 1; break }
  }
  while (left < start && /\s/u.test(source.text[left])) left++
  if (left < from || right > to || right - left > MAX_EVIDENCE_EXCERPT) return null
  return { from: left, to: right, excerpt: source.text.slice(left, right) }
}
export function memoryOptOut(source) {
  if (!isDirectUserSource(source)) return false
  const head = source.text.slice(0, 600)
  return analyzeUserMessageControls(head).noSaveDirective ||
    (/虚构(?:测试|验收)?(?:材料|资料)/u.test(head) && /测试|验收/u.test(head) && !EXPLICIT_MEMORY_PATTERN.test(head))
}

/** Token-set Jaccard overlap of two statements, used to collapse near duplicates. */
export function similarity(left, right) {
  const a = new Set(tokenize(left))
  const b = new Set(tokenize(right))
  if (a.size === 0 || b.size === 0) return 0
  let shared = 0
  for (const token of a) if (b.has(token)) shared += 1
  return shared / (a.size + b.size - shared)
}

/** Shared-token coverage of a statement against a source segment. */
export function coverage(statement, source) {
  const a = new Set(tokenize(statement))
  if (a.size === 0) return { ratio: 0, shared: 0 }
  const b = new Set(tokenize(source))
  let shared = 0
  for (const token of a) if (b.has(token)) shared += 1
  return { ratio: shared / a.size, shared }
}

export function hasEvidenceMatch(value) {
  return value.shared >= 2 && value.ratio >= 0.08
}

/** A user question that merely shares topic words cannot confirm a value. */
export function hasDirectUserSupport(statement, source) {
  const value = coverage(statement, source)
  if (!hasEvidenceMatch(value)) return false
  const sourceText = String(source ?? '').toLowerCase()
  for (const entity of entitiesOf(statement)) {
    if (!sourceText.includes(entity.toLowerCase())) return false
  }
  const literals = text => [...text.matchAll(/\d+(?:[.:：]\d+)*(?:\s*(?:毫秒|秒钟?|分钟|小时|天|个月|年|次|mib|gib|mb|gb|ms|%))?/giu)]
    .map(match => match[0].replace(/\s+/gu, '').replace(/：/gu, ':').toLowerCase())
  const available = literals(sourceText)
  for (const value of literals(statement)) {
    if (!available.some(sourceValue => sourceValue === value ||
        (/^[\d.:]+$/u.test(value) && sourceValue.match(/^[\d.:]+/u)?.[0] === value))) return false
  }
  return true
}

export const NEGATION_PATTERN = /(?:不|没|别|勿|禁止|never|\bnot\b|\bno\b)/iu

function entitiesOf(text) {
  return new Set(String(text ?? '').match(/\b[A-Za-z][A-Za-z0-9_.-]{1,}\b/gu) ?? [])
}

export function differentNamedServices(left, right) {
  const names = text => [...String(text).matchAll(/(?:服务|实例|集群)\s*[-:：]?\s*([A-Za-z][\w-]*)|\b([A-Za-z][\w-]*)\s*(?:服务|实例|集群)/giu)]
    .map(match => (match[1] ?? match[2]).toLowerCase())
  const a = names(left), b = names(right)
  return a.length > 0 && b.length > 0 && !a.some(name => b.includes(name))
}

export function disjointEntities(left, right) {
  if (differentNamedServices(left, right)) return true
  const a = entitiesOf(left)
  const b = entitiesOf(right)
  if (a.size === 0 || b.size === 0) return false
  for (const value of a) if (b.has(value)) return false
  return true
}

function numbersOf(text) {
  return new Set(String(text ?? '').match(/\d+(?:\.\d+)?/gu) ?? [])
}

/** Whether two similar statements carry conflicting values or polarity. */
export function conflictingValues(left, right) {
  const a = numbersOf(left)
  const b = numbersOf(right)
  for (const value of a) if (!b.has(value)) return true
  for (const value of b) if (!a.has(value)) return true
  return NEGATION_PATTERN.test(String(left)) !== NEGATION_PATTERN.test(String(right))
}

export function sourceLabel(source) {
  if (source.role === 'assistant') return '助手'
  if (source.sourceKind === 'user') return '用户'
  return `内部上下文（${source.sourceKind ?? 'unknown'}）`
}

/** Only native user messages are confirming evidence; internal user-role rows are not. */
export function isDirectUserSource(source) {
  return source.role === 'user' && (source.sourceKind === 'user' || source.sourceKind === 'unknown')
}

export function isModelEvidenceSource(entry) {
  return !looksSensitive(entry.source.text) && !memoryOptOut(entry.source) &&
    (isDirectUserSource(entry.source) || entry.source.role === 'assistant')
}

export function sourceIdLine(entry) {
  return `[${entry.sourceId}] ${sourceLabel(entry)}：${entry.text}`
}
