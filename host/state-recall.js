import { sourceSentences } from './sentences.js'

const ENGLISH_PRIOR = /^what (?:was|were) (?<owner>my|our) (?:(?:previous|old|former) (?<explicit>.+)|(?<changed>.+?) before (?:i|we) (?:changed|updated|renamed|replaced) (?:it|them))$/iu
const ENGLISH_PAIR = /^what (?:were|are) (?<owner>my|our) (?:previous and current|old and new) (?<field>.+)$/iu
const CHINESE_PRIOR = /^(?<owner>我(?:们)?)的?(?:(?:原来|之前|以前)的(?<leading>.+?)|(?<trailing>.+?)(?:原来|之前|以前))是(?:什么|多少|哪个)$/u
const CHINESE_PAIR = /^(?<owner>我(?:们)?)的(?<field>.+?)(?:原来和现在|之前和现在)分别是(?:什么|多少|哪个)$/u
const ENGLISH_UPDATE = /\s+before (?:i|we) (?:changed|updated|renamed|replaced) (?:it|them)$/iu
const WORK = /^(?:occupation|job|work role)$/iu
const NON_ASSERTION = /^(?:[>"“'‘「『]|引用[:：])|[?？]|n['’]t\b|\b(?:if|unless|maybe|might|would|could|imagined?|fictional|fictitious|pretend|said|told|quoted|reported|example|not|never|planned?|considering|instead of)\b|假设|可能|准备|打算|计划|拟将|曾想|示例|举例|虚构|据说|转述|并非|不是/u
const ENGLISH_CLAUSE_BOUNDARY = /[;；]|,\s+(?:(?:and|but)\s+)?(?=(?:your|my|our|the)\s+)/iu
const CHINESE_CLAUSE_BOUNDARY = /[;；]|[,，]\s*(?=(?:我(?:们)?|你(?:们)?|您)的)/u
const QUOTED_FIELD = /\b(?:reads?|says?|wrote|writes?|transcript|quotation)\s*[:：]|(?:同事|稿件|文档|脚本|样例|测试稿)(?:中|里)?(?:写着|写道|说)\s*[:：]/iu
const PATTERN_FLAGS = 'iu'
const escaped = value => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')

function eligibleField(field) {
  return field.length >= 2 && field.length <= 85 &&
    !/[<>{}:：;；!?？.。/，,]/u.test(field) &&
    !/\b(?:before|after|and|or|then|when)\b|[与或]/iu.test(field)
}

function plan(field, owner, language, phase) {
  const kind = language === 'en' && WORK.test(field) ? 'work' : 'field'
  return { field, owner, language, phase, kind }
}

/** Recognize a question about a stated value or an explicit change. */
export function stateFieldPlans(question, rootQuery) {
  const text = String(question).normalize('NFKC').trim().replace(/[?？。]+$/u, '').trim()
  const enPair = ENGLISH_PAIR.exec(text)?.groups
  const zhPair = CHINESE_PAIR.exec(text)?.groups
  const en = ENGLISH_PRIOR.exec(text)?.groups
  const zh = CHINESE_PRIOR.exec(text)?.groups
  const matched = enPair ?? zhPair ?? en ?? zh
  if (!matched) return null
  const language = enPair || en ? 'en' : 'zh'
  const owner = matched.owner.toLowerCase()
  let field = (matched.field ?? matched.explicit ?? matched.changed ?? matched.leading ?? matched.trailing).trim().replace(ENGLISH_UPDATE, '')
  if (enPair) field = field.replace(/\b(versions|labels|channels|names|settings|modes|goals)$/iu, word => word.slice(0, -1))
  if (!eligibleField(field)) return null
  const previous = plan(field, owner, language, 'previous')
  if (!enPair && !zhPair) return [{ query: rootQuery, role: 'root', entityTerms: [], stateField: previous }]
  const current = plan(field, owner, language, 'current')
  return [
    { query: rootQuery, role: 'root', entityTerms: [] },
    ...[previous, current].map(stateField => ({
      query: language === 'zh' ? `${owner}的${field}${stateField.phase === 'previous' ? '原来' : '现在'}是什么`
        : `What ${stateField.phase === 'previous' ? 'was' : 'is'} ${owner} ${stateField.phase} ${field}`,
      role: 'subquestion', entityTerms: [], stateField,
    })),
  ]
}

export function stateFieldSearch({ field, language, kind }) {
  if (kind === 'work') return 'previous role occupation worked job'
  return field + (language === 'zh' ? ' 原来 之前 现在 改成' : ' previous old current changed')
}

function cleanValue(value, language) {
  const stop = language === 'zh' ? /[，,；;。！？]|\s+(?:现在|目前|如今)/u
    : /[,;!?]|\s+(?:but|and|whereas)\s+(?=(?:now|currently|my|our|your|it|i|we|you)\b)/iu
  const text = String(value ?? '').split(stop, 1)[0].trim()
  const quotedState = language === 'zh' ? /^(?:在|处于)?\s*[“"「『]([^”"」』]+)[”"」』]\s*(?:状态|模式|通道)?$/u.exec(text) : null
  const result = (quotedState?.[1] ?? text)
    .replace(/^["“'‘「『\s]+|["”'’」』.。\s]+$/gu, '')
  return result && result.length <= 100 && !/\bor\b|或是|或者/iu.test(result) ? result : null
}

export function stateValueKey(value) {
  return value.normalize('NFKC').toLowerCase().replace(/^(?:an?|the)\s+/u, '').replace(/\s+/gu, ' ').trim()
}

function after(sentence, match, language) {
  return match ? cleanValue(sentence.slice(match.index + match[0].length), language) : null
}

function englishValue(state, sentence, answer) {
  const field = state.kind === 'work' ? '(?:occupation|job|work role)' : escaped(state.field)
  const owned = answer ? '(?:your|my|our|the)' : escaped(state.owner)
  const actor = answer ? '(?:you|i|we)' : state.owner === 'our' ? 'we' : 'i'
  const past = state.phase === 'previous'
  const change = new RegExp(String.raw`\b${actor}(?:['’]ve)?\s+(?:(?:just|recently|already|actually)\s+){0,3}(?:changed|updated|switched|renamed)\s+${owned}\s+${field}\s+from\s+(?<old>[^;,!?]{1,110}?)\s+to\s+`, PATTERN_FLAGS).exec(sentence)
  if (change) return past ? cleanValue(change.groups.old, 'en') : after(sentence, change, 'en')

  const marker = past ? '(?:previous|old|former|prior)' : '(?:current|new)'
  const verb = past ? '(?:was|were|used to be)' : '(?:is|are)'
  const beforeChange = String.raw`before\s+(?:(?:you|i|we)\s+(?:changed|updated|renamed|replaced)|(?:changing|updating|renaming|replacing))\s+(?:it|them)`
  const qualifier = answer && past ? String.raw`(?:\s+${beforeChange})?` : ''
  const direct = new RegExp(String.raw`\b${owned}\s+${marker}\s+${field}${qualifier}\s+${verb}\s+`, PATTERN_FLAGS).exec(sentence)
  if (direct) return after(sentence, direct, 'en')
  if (past) {
    const explanatory = new RegExp(String.raw`\b${owned}\s+${marker}\s+${field}\s*[-–—:]\s*${actor}\s+used to\s+(?:be|use|prefer|follow)\s+`, PATTERN_FLAGS).exec(sentence)
    if (explanatory) return after(sentence, explanatory, 'en')
    if (answer) {
      const beforeReply = new RegExp(String.raw`\b${owned}\s+${field}\s+${beforeChange}\s+${verb}\s+`, PATTERN_FLAGS).exec(sentence)
      if (beforeReply) return after(sentence, beforeReply, 'en')
    }
  }

  // A generic "old name" is a surname only when the same sentence names the change.
  const surname = /^(?:last name|surname)$/iu.test(state.field)
  const label = new RegExp(String.raw`\b${owned}\s+(?:old|previous|former)\s+${field}\s+(?:was|were)\s+`, PATTERN_FLAGS)
  const changedSurname = surname && new RegExp(String.raw`\b${actor}\b[^,;.!?]{0,45}\bchanged\s+${owned}\s+(?:last name|surname)\b`, PATTERN_FLAGS).exec(sentence)
  const oldName = changedSurname && new RegExp(String.raw`\b${owned}\s+old name\s+was\s+`, PATTERN_FLAGS).exec(sentence)
  if (oldName?.index < changedSurname?.index) return null
  if (past && oldName) return after(sentence, oldName, 'en')
  if (!past && (oldName || label.test(sentence))) {
    return after(sentence, /\b(?:now|currently)\s+(?:(?:it|that)(?:['’]s|\s+is)\s+)?/iu.exec(sentence), 'en')
  }
  if (past && state.kind === 'work') {
    const work = new RegExp(String.raw`\b${owned}\s+(?:previous|former|prior)\s+role\s+as\s+`, PATTERN_FLAGS).exec(sentence)
    const formerJob = after(sentence, work, 'en')
    if (formerJob && /\b(?:at|for)\s+(?:\S+\s*){1,8}$/iu.test(formerJob) && !/\bvolunteer\b/iu.test(formerJob)) return formerJob
    if (answer) {
      const worked = new RegExp(String.raw`\b${actor}\s+(?:(?:were|was)\s+(?=(?:an?)\s+)|(?:previously worked as|used to work as)\s+)`, PATTERN_FLAGS).exec(sentence)
      return after(sentence, worked, 'en')
    }
  }
  return null
}

function chineseValue(state, sentence, answer) {
  const field = escaped(state.field)
  const actor = answer ? '(?:我|我们|你|您)' : escaped(state.owner)
  const owned = answer ? `(?:${actor}的)?` : `${actor}的`
  const boundary = '(^|[\\s,，:：;；。])'
  const past = state.phase === 'previous'
  const change = new RegExp(String.raw`${boundary}${actor}(?:已经|刚刚|刚|已)?把\s*(?:我的|我们的)?${field}\s*从\s*(?<old>[^，,；;。！？]{1,100}?)\s*(?:改为|改成|换成|切换到)\s*`, 'u').exec(sentence)
  if (change) return past ? cleanValue(change.groups.old, 'zh') : after(sentence, change, 'zh')
  const marker = past ? '(?:原来|之前|以前)' : '(?:现在|目前|如今)'
  const stated = new RegExp(String.raw`${boundary}(?:${owned}${field}\s*${marker}\s*(?:就是|是|为)|${owned}${marker}的\s*${field}\s*(?:就是|是|为))\s*`, 'u').exec(sentence)
  if (stated) return after(sentence, stated, 'zh')
  const previous = new RegExp(String.raw`${boundary}${owned}${field}\s*(?:原来|之前|以前)\s*(?:是|为)`, 'u')
  return !past && previous.test(sentence) ? after(sentence, /[，,；;]\s*(?:现在|目前|如今)(?:就是|是|为)\s*/u.exec(sentence), 'zh') : null
}

function fieldClaims(state, text, answer) {
  const distinct = new Map()
  const valueIn = state.language === 'zh' ? chineseValue : englishValue
  const clauseBoundary = state.language === 'zh' ? CHINESE_CLAUSE_BOUNDARY : ENGLISH_CLAUSE_BOUNDARY
  for (const quote of sourceSentences(text)) {
    if (NON_ASSERTION.test(quote) || QUOTED_FIELD.test(quote)) continue
    const clauses = quote.split(clauseBoundary)
    for (const clause of clauses.length === 1 ? clauses : [quote, ...clauses]) {
      const value = valueIn(state, clause.trim(), answer)
      if (value) distinct.set(stateValueKey(value), { quote, value })
    }
  }
  return distinct
}

export function stateFieldEvidence(state, text) {
  const distinct = fieldClaims(state, text, false)
  if (distinct.size > 1) return { conflicting: true }
  return distinct.size === 1 ? distinct.values().next().value : null
}

export function statedFieldAnswer(state, answer, expected, single) {
  const claims = fieldClaims(state, String(answer ?? ''), true)
  if (claims.size) return claims.size === 1 ? claims.get(expected)?.quote ?? null : null
  const bare = single ? cleanValue(String(answer ?? ''), state.language) : null
  return bare && !NON_ASSERTION.test(String(answer ?? '')) && stateValueKey(bare) === expected
    ? String(answer).trim() : null
}
