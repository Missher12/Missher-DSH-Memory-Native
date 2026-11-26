import { explicitlyAsksCurrentTime, matchesRecallAttribute, matchesRecallEntity, recallAnchorTerms, recallEvidenceClauses, recallPropertyMeasures, recallTimeIntent, recallUnitProperty } from './recall.js'
import { calendarWindowAnswerMatches, matchesCalendarAnswer, matchesCalendarDateAnswer, readDayCount } from './calendar-recall.js'
import { matchesDurationAtEventAnswer } from './duration-at-event-recall.js'
import { matchesEventAgeAnswer } from './event-age-recall.js'
import { matchesDeclaredCountAnswer } from './declared-count.js'
import { matchesElapsedAnswer } from './elapsed-recall.js'
import { matchesReportedCounterAnswer } from './counter-recall.js'
import { matchesTimelineAnswer } from './timeline-recall.js'
import { matchesEventLocationAnswer } from './event-location-recall.js'
import { matchesMarketSalesAnswer } from './market-sales-recall.js'
import { matchesExpenseAnswer } from './dated-expenses-recall.js'
import { matchesPersonalFundraisingAnswer } from './personal-fundraising-recall.js'
import { matchesEventCountAnswer } from './event-count-recall.js'
import { scopedMoneyAnswerQuote, quantityEvidence, quantityProofKey } from './quantity-recall.js'
import { discountPriceAnswer } from './purchase-recall.js'
import { sourceSentences } from './sentences.js'
import { stateFieldEvidence, statedFieldAnswer, stateValueKey } from './state-recall.js'
import { originalStudyInstitution, personalSourceQuestion, receivedGiftAnswer } from './source-recall.js'
import { matchesRecordedTimeAnswer, racePersonalBestAnswer, timeMeasureEvidence, timeMeasureIntent, statedTimeMeasures, timeMeasureAnswerPeriod, timeMeasureClauses, timeMeasureValueKey } from './time-measure-recall.js'

const ANSWER_STOP_ATOMS = new Set(['每天', '每日', '执行', '运行', '保留', '开始', '结束', '采用', '选择', '使用', '计划', '项目', '记忆', '事实', '来源', '因为', '所以', '由于', '为了', '以便', '避开', '避免', '原因', '缘于', '出于', '否则', '免得', '防止', '需要'])
const UNCONFIRMED_VALUE = /(?:并不是|不是|并非|不在|不确定|未确认|不能确认|无法确认|没有依据|可能是|大概是|\b(?:not|unknown|uncertain|cannot confirm|can't confirm|could be|might be|maybe)\b)/iu
const MISSING_MEASUREMENT = /(?:无法(?:确定|判断)|没有(?:记录|提到|说明)|未(?:知|记录|说明)|\b(?:can(?:not|'t)|unable to)\s+(?:determine|tell|establish|verify)\b|\bno\s+(?:specific\s+)?(?:information|evidence|mention|record)\b|\bI(?:'m| am)\s+not sure\b)/iu
const COMMON_ANSWER_WORDS = new Set('also about after again before does from have into more must only should than that their them then there these this through under were what when where which while will with would'.split(' '))
const DATE_LEAD_IN = /^(?:而)?\s*(?:在|于|截至|(?:as of|on)\s+)?\s*\d{4}(?:\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日|[-/]\d{1,2}[-/]\d{1,2})(?:\s*(?:时|那天|当天|当日))?$/iu
const VERSION_LEAD_IN = /^(?:而|则|至于)?\s*(?:按|在)?\s*(?:现在|当前|目前|如今|现行|以前|之前|过去|当时|原来|旧版|上一版)(?:的)?(?:规则|设置|配置|方案)?(?:下|中)?$|^(?:now|currently|previously|under the (?:current|previous) (?:policy|configuration|rules?))$/iu
const OUTSIDE_EXPLICIT_DATE = /\d{4}(?:\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日|[-/]\d{1,2}[-/]\d{1,2})\s*(?:之|以)?[前后]|\b(?:before|after)\s+\d{4}[-/]\d{1,2}[-/]\d{1,2}/iu
const CLOCK_ATOM = /(?<![\d:])(?:0?[1-9]|1[0-2])(?::[0-5]\d)?\s*[ap]\.?\s*m\.?(?![a-z\d])|(?<![\d:])(?:[01]?\d|2[0-3])[:：][0-5]\d(?![\d:])|(?:凌晨|早上|上午|下午|晚上|每日|每天).{0,6}[一二三四五六七八九十\d]+点/giu
const RETENTION_ATOM = /\d+(?:\.\d+)?\s*(?:seconds?|minutes?|hours?|days?|weeks?|months?|years?)\b|(?:\d+(?:\.\d+)?|[零一二两三四五六七八九十半]+)\s*(?:天|日|周|星期|个月|月|年|小时|分钟|秒)|(?:永久|长期)(?=保留)/giu
const RETENTION_PREDICATE = /保留|留存|保存|\b(?:retain(?:ed|s)?|retention|keep|kept|stored for)\b/iu
const LEADERSHIP_QUERY = /^how many (?<unit>[a-z]+(?: [a-z]+){0,2}) (?:do|did) (?<actor>i|we) lead (?<when>now|currently|when \k<actor> (?:just )?(?:started|began) (?:my|our|the) (?:new )?role as (?<role>[a-z][a-z0-9 -]{1,70}))[?？]?$/iu
const LEADERSHIP_AMOUNT = String.raw`(?:\d+|(?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)[- ][a-z]+|[a-z]+)`
const LEADERSHIP_CURRENT = /\b(?:now|currently|at present)\b/iu
const LEADERSHIP_INITIAL = /\b(?:initially|at first|when (?:i|we|you) (?:just )?(?:started|began)|(?:my|our|your) new role as)\b/iu
const LEADERSHIP_ROLE = /\brole as (?<title>[a-z][a-z0-9 -]{1,70}?)(?=\s+for (?:a while|some time)\b|[,.!?;]|$)/iu
const LEADERSHIP_UNCERTAIN = /\b(?:about|around|roughly|approximately|if|or|said|told|quoted|would|might)\b|n['’]t\b/iu
const VALUE_EXPLANATION = /因为|由于|为了|以便|\b(?:because|due to|so that)\b/iu
const REASON_CUE = /因为|由于|为了|以便|避开|避免|原因|缘于|出于|否则|免得|防止/u
const DENIES_VALUE = /并不是|不是|并非|不在|\bnot\b(?!\s+(?:sure|certain|confirmed|verified|specified|recorded|known)\b)/iu
const SHARED_ANSWER = /都|均|皆|\b(?:both|each|all)\b/iu
const DENIES_REASON = /(?:并不是|不是|并非|不能确定是|无法确认是|可能是)\s*(?:因为|由于|为了)|\b(?:not because|not due to|not the reason)\b/iu
const UNAVAILABLE_CJK = /(?:(?:仍|还|尚|都|均|暂时)\s*)?(?:不明确|不清楚|不详|未知|无法(?:确定|确认)|(?:未|没有)(?:(?:被|有|详细|明确|具体)\s*)*(?:说明|记录|提供|注明|写明|确认|提及))/
const UNAVAILABLE_EN = /(?:(?:is|was|has been)\s+)?(?:unclear|unknown|unconfirmed|(?:not|never)\s+(?:given|specified|recorded|explained|provided|confirmed))\b/

function unavailableField(cjk, english) {
  const separator = '\\s*[:：]?\\s*'
  return new RegExp(`(?:${cjk})${separator}${UNAVAILABLE_CJK.source}|\\b(?:${english})\\b${separator}${UNAVAILABLE_EN.source}`, 'iu')
}
const FIELD_UNAVAILABLE = {
  clock: unavailableField('(?:执行|调度|启动|开始|运行|具体|现行|当前)(?:的)?(?:时间|时刻)', '(?:start|execution|current|scheduled) time|schedule'),
  retention: unavailableField('(?:保留|留存|保存)(?:期限|时间|时长|多久)', 'retention(?: period)?'),
  reason: unavailableField('原因|理由', 'reason|rationale'),
}

function normalizedAnswerText(text) {
  return String(text ?? '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
}

function matchesSelectedQuote(quote, sentence, query) {
  if (UNCONFIRMED_VALUE.test(sentence)) return false
  const normalizedQuote = normalizedAnswerText(quote)
  if (normalizedQuote.length >= 8 && normalizedAnswerText(sentence).includes(normalizedQuote)) return true
  // For a semantic match, the answer may share words with the evidence rather
  // than with the question. Count distinct words beyond the question itself.
  const words = text => new Set(text.toLowerCase().replace(/\b(?:sign[- ]off|authori[sz]ation)\b/gu, 'approval')
    .match(/\b[a-z][a-z0-9-]{3,}\b/gu) ?? [])
  const promptWords = words(query), answerWords = words(sentence)
  const shared = [...words(quote)].filter(word => !COMMON_ANSWER_WORDS.has(word) && answerWords.has(word))
  return shared.length >= 3 && shared.filter(word => !promptWords.has(word)).length >= 2
}

function studyAnswerCoverage(question, answer, plan) {
  if (!plan?.studyAnswer) return null
  const schools = new Set(question.injected.filter(hit => hit.verified === true && hit.kind === 'source')
    .map(hit => originalStudyInstitution(plan, hit.selectedQuote ?? hit.text.replace(/^\s*-\s*\[[^\]]+\]\s*/u, '')))
    .filter(Boolean).map(normalizedAnswerText))
  if (schools.size === 0) return null
  if (schools.size > 1) return { answerCoverage: 'unverified', answerExcerpt: null }
  const [school] = schools
  const sentences = sourceSentences(String(answer ?? ''))
  const disputed = sentences.some(sentence => normalizedAnswerText(sentence).includes(school) &&
    (UNCONFIRMED_VALUE.test(sentence) || /n['’]t\b|\b(?:if|whether|probably|perhaps|planning)\b/iu.test(sentence)))
  const claims = sentences.flatMap(sentence => {
    const match = plan.studyAnswer.exec(sentence)
    const claimed = normalizedAnswerText(match?.groups.place ?? match?.groups.school ?? sentence)
    return match || claimed === school ? [{ sentence, claimed }] : []
  })
  const covered = !disputed && claims.length > 0 && claims.every(({ claimed }) => claimed === school)
  return covered ? { answerCoverage: 'covered', answerExcerpt: claims[0].sentence.slice(0, 240) }
    : { answerCoverage: 'unverified', answerExcerpt: null }
}

function stripAnswerReasonLeadIn(value) {
  const prefix = /^(?:原因(?:是|在于)?|是|因为|由于|为了|以便|为|在于|要|去|能够|可以|尽量|避开|避免|防止|免得|以免)\s*/u
  let phrase = String(value ?? '').trim()
  while (phrase !== '') {
    const next = phrase.replace(/^[\s\p{P}\p{S}]+/u, '').replace(prefix, '').trim()
    if (next === phrase) break
    phrase = next
  }
  return phrase
}

function answerEvidenceReasonPhrases(value) {
  const body = String(value ?? '').replace(/^\s*-\s*\[[^\]]+\]\s*/u, '')
  return body.split(/[。！？!?；;\n]+/u).map(text => text.trim()).filter(Boolean).map(clause => {
    const cue = REASON_CUE.exec(clause)
    return cue ? stripAnswerReasonLeadIn(clause.slice(cue.index + cue[0].length)) : ''
  }).filter(Boolean)
}

function answerEvidenceText(question, injectedText) {
  const body = String(injectedText ?? '').replace(/^\s*-\s*\[[^\]]+\]\s*/u, '')
  const clauses = body.split(/[。！？!?；;\n]+/u).map(text => text.trim()).filter(Boolean)
  if (question.detail === 'floor') {
    return [...body.matchAll(/第?[\d零一二三四五六七八九十百]+[层楼]|[上下顶底]层|地下.{0,5}层|\bfloor\s*\d+\b/giu)].map(match => match[0]).join(' ')
  }
  return clauses.filter(clause => matchesRecallAttribute({ record: { content: clause } }, question.query, question.detail, question.entityTerms ?? [])).join(' ')
}

function answerEvidenceAtoms(question, injectedText) {
  const body = String(injectedText ?? '').normalize('NFKC')
  if (question.detail === 'clock') return [...body.matchAll(CLOCK_ATOM)].map(match => match[0])
  if (question.detail === 'retention') return body.split(/[。！？!?；;\n]+/u).flatMap(clause =>
    RETENTION_PREDICATE.test(clause) ? [...clause
      .replace(/(?<!\d)\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日/gu, ' ')
      .matchAll(RETENTION_ATOM)].map(match => match[0]) : [])
  if (question.detail === 'reason') return answerEvidenceReasonPhrases(injectedText)
  const query = normalizedAnswerText(question.query)
  const source = answerEvidenceText(question, injectedText)
  const atoms = new Set()
  for (const match of source.matchAll(/(?<!\d)\d{1,4}(?::\d{1,2})?(?:\.\d+)?(?:\s*(?:天|日|小时|分钟|秒|年|周|次|%|GB|MB|TB|版本))?/giu)) {
    const atom = normalizedAnswerText(match[0])
    if (atom.length >= 2 && !query.includes(atom)) atoms.add(atom)
  }
  for (const match of source.matchAll(/\b[A-Za-z][A-Za-z0-9_.-]{2,}\b/gu)) {
    const atom = normalizedAnswerText(match[0])
    if (!query.includes(atom)) atoms.add(atom)
  }
  for (const run of source.matchAll(/[\p{Script=Han}]{2,}/gu)) {
    const chars = [...run[0]]
    const max = Math.min(chars.length, 12)
    for (let size = 2; size <= max; size += 1) for (let start = 0; start + size <= chars.length; start += 1) {
      const atom = chars.slice(start, start + size).join('')
      if (!ANSWER_STOP_ATOMS.has(atom) && !query.includes(atom)) atoms.add(atom)
    }
  }
  return [...atoms].sort((left, right) => right.length - left.length)
}

function normalizeAnswerEvidenceValue(detail, value) {
  const text = String(value ?? '').normalize('NFKC').replace(/\s+/gu, '').toLowerCase()
  if (detail === 'clock') {
    const meridiem = /^(\d{1,2})(?::(\d{2}))?([ap])m$/u.exec(text.replace(/\./gu, ''))
    if (meridiem) return `${Number(meridiem[1]) % 12 + (meridiem[3] === 'p' ? 12 : 0)}:${meridiem[2] ?? '00'}`
    const match = /^(\d{1,2}):(\d{2})$/u.exec(text)
    return match ? `${Number(match[1])}:${match[2]}` : normalizedAnswerText(text)
  }
  if (detail === 'retention') {
    const match = /^(\d+(?:\.\d+)?)(个月|小时|分钟|星期|天|日|周|月|年|秒|seconds?|minutes?|hours?|days?|weeks?|months?|years?)$/u.exec(text)
    if (!match) return normalizedAnswerText(text)
    const unit = ({ 日: '天', 星期: '周', 个月: '月', second: '秒', minute: '分钟', hour: '小时',
      day: '天', week: '周', month: '月', year: '年' })[match[2].replace(/s$/u, '')] ?? match[2]
    return `${Number(match[1])}${unit}`
  }
  return normalizedAnswerText(text)
}

function explicitTimeKey(text, now) {
  const intent = recallTimeIntent(text, now)
  if (intent.kind === 'as-of') return intent.at
  if (intent.kind === 'history' || explicitlyAsksCurrentTime(text)) return intent.kind
  return null
}

function subjectKey(question) {
  return [...(question.entityTerms ?? [])].sort().join('\0')
}

function namedObjectSuffix(question) {
  return recallAnchorTerms(question.query).find(term => /^\p{Script=Han}{3,}$/u.test(term))?.slice(-2)
}

function namesAnotherObject(text, suffix, terms) {
  if (!suffix || typeof text !== 'string' || matchesRecallEntity({ record: { content: text } }, terms)) return false
  return recallAnchorTerms(text.replace(/(?:这[个项次]|那[个项次]|该|此)(?=\p{Script=Han})/gu, ' '))
    .some(term => term.endsWith(suffix))
}

function scopedAnswerClauses(question, questions, clauses) {
  const own = subjectKey(question)
  if (own === '') return clauses
  const subjects = new Map([[own, question.entityTerms]])
  for (const other of questions) {
    const key = subjectKey(other)
    if (key && other.detail === question.detail) subjects.set(key, other.entityTerms)
  }
  const suffix = namedObjectSuffix(question)
  if (subjects.size === 1 && !suffix) return clauses
  let current = subjects.size === 1 ? [own] : []
  return clauses.map(clause => {
    const label = clause.split(question.detail === 'reason' ? REASON_CUE : VALUE_EXPLANATION, 1)[0]
    const hit = { record: { content: label } }
    const named = [...subjects].filter(([, terms]) => matchesRecallEntity(hit, terms))
    if (named.length > 0) current = named.length === 1 || SHARED_ANSWER.test(clause) ? named.map(([key]) => key) : []
    else if (namesAnotherObject(label, suffix, question.entityTerms)) current = []
    return current.includes(own) ? clause : ''
  })
}

function valueClaims(question, questions, answer) {
  const now = Date.now()
  const time = explicitTimeKey(question.query, now) ?? 'current'
  const group = subjectKey(question)
  const needsLabel = questions.some(other => {
    if (other === question || other.detail !== question.detail) return false
    const otherGroup = subjectKey(other)
    if (group && otherGroup && otherGroup !== group) return false
    const otherTime = explicitTimeKey(other.query, now)
    return otherTime !== null && otherTime !== time
  })
  const suffix = needsLabel && question.entityTerms?.length ? namedObjectSuffix(question) : undefined
  if (namesAnotherObject(answer, suffix, question.entityTerms)) return []
  const clauses = String(answer ?? '').split(/(?<=[。！？!?；;，,])|\n+/u)
  const scoped = scopedAnswerClauses(question, questions, clauses)
  return scoped.flatMap((raw, index) => {
    const clause = raw.trim()
    if (!clause || /[？?]$/u.test(clause) ||
        (typeof time === 'number' && OUTSIDE_EXPLICIT_DATE.test(clause))) return []
    const assertion = clause.replace(/[；;，,]+$/u, '')
    const previous = clauses[index - 1]?.trimStart() ?? ''
    const label = /[，,]$/u.test(previous) ? previous.slice(0, -1).trim() : ''
    // Only a standalone time label can set the scope of the next clause.
    const prefix = DATE_LEAD_IN.test(label) || VERSION_LEAD_IN.test(label) ? previous : ''
    const ownTime = explicitTimeKey(assertion, now)
    const claim = ownTime === null && prefix ? prefix + raw.trimEnd().replace(/[；;，,]+$/u, '') : assertion
    const claimedTime = ownTime ?? explicitTimeKey(prefix, now)
    const matches = needsLabel ? claimedTime === time : claimedTime === null || claimedTime === time
    return matches ? [claim] : []
  })
}

function leadershipCountCoverage(question, answer, questions) {
  const asked = LEADERSHIP_QUERY.exec(question.query)?.groups
  if (!asked) return null
  const sameUnit = questions.flatMap(other => {
    const candidate = LEADERSHIP_QUERY.exec(other.query)?.groups
    return candidate?.unit.toLowerCase() === asked.unit.toLowerCase() &&
      candidate.actor.toLowerCase() === asked.actor.toLowerCase() ? [candidate] : []
  })
  if (sameUnit.length !== 2 || sameUnit.filter(scope => scope.role).length !== 1) return null
  const initial = Boolean(asked.role)
  const title = sameUnit.find(scope => scope.role).role.toLowerCase().trim()
  const claims = (text, reply) => {
    const actor = reply ? `(?:you|${asked.actor})` : asked.actor
    const pattern = new RegExp(String.raw`\b${actor}\s+(?:(?:now|currently|initially)\s+)?(?:lead|led|manage|managed)\s+(?:a\s+(?:team|group)\s+of\s+)?(?<count>${LEADERSHIP_AMOUNT})\s+${asked.unit}\b`, 'giu')
    return sourceSentences(text).flatMap(sentence => sentence.split(/[;；]|\s+(?:and|but|whereas)\s+(?=(?:now|currently|initially|at first|when|i|we|you)\b)/iu))
      .flatMap(clause => {
        const present = LEADERSHIP_CURRENT.test(clause)
        const prior = LEADERSHIP_INITIAL.test(clause)
        const phase = prior === present ? null : prior
        const named = LEADERSHIP_ROLE.exec(clause)?.groups.title.toLowerCase().trim()
        return [...clause.matchAll(pattern)].flatMap(match => {
          const value = readDayCount(match.groups.count)
          return Number.isSafeInteger(value) && value >= 0
            ? [{ value, phase, named, clause, uncertain: UNCONFIRMED_VALUE.test(clause) || LEADERSHIP_UNCERTAIN.test(clause) }] : []
        })
      })
  }
  const expected = new Set(question.injected.filter(hit => hit.verified === true && hit.kind === 'source')
    .flatMap(hit => claims(hit.selectedQuote ?? hit.text.replace(/^\s*-\s*\[[^\]]+\]\s*/u, ''), false))
    .filter(claim => claim.phase === initial && !claim.uncertain && (initial ? claim.named === title : !claim.named || claim.named === title))
    .map(claim => claim.value))
  const stated = claims(String(answer ?? ''), true)
  const relevant = stated.filter(claim => claim.phase === initial)
  const covered = expected.size === 1 && relevant.length > 0 && stated.every(claim => claim.phase !== null) &&
    relevant.every(claim => !claim.uncertain && expected.has(claim.value) && (!claim.named || claim.named === title))
  return covered ? { answerCoverage: 'covered', answerExcerpt: relevant[0].clause.trim().slice(0, 240) }
    : { answerCoverage: 'unverified', answerExcerpt: null }
}

function compactRetentionAnswer(question, questions, answer) {
  if (question.detail !== 'retention') return null
  const fields = questions.map(item => item.detail)
  if (new Set(fields).size !== fields.length ||
      fields.some(detail => !['clock', 'retention', 'reason'].includes(detail))) return null
  const subject = subjectKey(question), now = Date.now()
  const time = explicitTimeKey(question.query, now)
  if (questions.some(item => subjectKey(item) !== subject || explicitTimeKey(item.query, now) !== time)) return null
  const parts = String(answer ?? '').trim().replace(/[。.]$/u, '').split(/[，,；;\n]+/u).map(part => part.trim())
  if (parts.length !== fields.length || parts.some(part => !part)) return null
  const matchesEntire = (part, pattern) => {
    const value = part.normalize('NFKC')
    return [...value.matchAll(pattern)].some(match => match[0] === value)
  }
  // Accept an unlabeled value only in an ordered answer with an unambiguous field.
  const clock = fields.indexOf('clock'), reason = fields.indexOf('reason')
  if (clock >= 0 && !matchesEntire(parts[clock], CLOCK_ATOM)) return null
  if (reason >= 0 && (RETENTION_PREDICATE.test(parts[reason]) ||
      [...parts[reason].matchAll(RETENTION_ATOM)].length > 0)) return null
  const retention = parts[fields.indexOf('retention')]
  return retention && matchesEntire(retention, RETENTION_ATOM) ? retention : null
}

function consistentValueCoverage(question, answer, questions) {
  const pending = { answerCoverage: 'unverified', answerExcerpt: null }
  const expected = new Set(question.injected.filter(evidence => evidence.verified === true)
    .flatMap(evidence => expectedAtoms(question, evidence.text))
    .map(value => normalizeAnswerEvidenceValue(question.detail, value)))
  if (expected.size !== 1) return pending
  const compact = compactRetentionAnswer(question, questions, answer)
  let match = compact && expected.has(normalizeAnswerEvidenceValue(question.detail, compact)) ? compact : null
  for (const clause of valueClaims(question, questions, answer)) {
    const statement = clause.split(VALUE_EXPLANATION, 1)[0]
    if (FIELD_UNAVAILABLE[question.detail].test(statement)) return pending
    const values = answerEvidenceAtoms(question, statement).map(value => normalizeAnswerEvidenceValue(question.detail, value))
    if (values.length === 0) continue
    if (UNCONFIRMED_VALUE.test(statement)) {
      if (values.some(value => expected.has(value)) || !DENIES_VALUE.test(statement)) return pending
      continue
    }
    if (values.some(value => !expected.has(value))) return pending
    match ??= clause
  }
  return match ? { answerCoverage: 'covered', answerExcerpt: match.slice(0, 240) } : pending
}

function consistentReasonCoverage(question, answer, questions) {
  const pending = { answerCoverage: 'unverified', answerExcerpt: null }
  const expected = question.injected.filter(evidence => evidence.verified === true).flatMap(evidence =>
    Array.isArray(evidence.reasonPhrases)
      ? evidence.reasonPhrases.filter(phrase => typeof phrase === 'string' && evidence.text.includes(phrase))
        .map(stripAnswerReasonLeadIn)
      : answerEvidenceReasonPhrases(evidence.text)).map(normalizedAnswerText).filter(Boolean)
  const supports = text => answerEvidenceReasonPhrases(text).some(value =>
    expected.some(phrase => normalizedAnswerText(value).includes(phrase)))
  let match = null
  const sentences = scopedAnswerClauses(question, questions, sourceSentences(String(answer ?? '')))
  for (const sentence of sentences) {
    if (FIELD_UNAVAILABLE.reason.test(sentence)) return pending
    const clauses = sentence.split(/[,，;；]|(?=而是(?:因为|由于))/u)
    if (clauses.some(clause => DENIES_REASON.test(clause) && supports(clause))) return pending
    if (supports(sentence)) match ??= sentence
  }
  return match ? { answerCoverage: 'covered', answerExcerpt: match.slice(0, 240) } : pending
}

function expectedAtoms(question, text) {
  const atoms = answerEvidenceAtoms(question, text)
  // A single verified value can be supplied by a short quote. When one record
  // has several values, use the same object boundary we used for retrieval.
  if (!question.entityTerms?.length ||
      new Set(atoms.map(value => normalizeAnswerEvidenceValue(question.detail, value))).size < 2) return atoms
  const source = String(text).replace(/^\s*-\s*\[[^\]]+\]\s*/u, '')
  return answerEvidenceAtoms(question, recallEvidenceClauses(source, question.entityTerms).join('；'))
}

function quantityAnswerCoverage(question, answer) {
  if (['fare-comparison', 'trip-quote', 'fundraising-comparison'].includes(question.quantity.scope?.role)) {
    const quote = scopedMoneyAnswerQuote(question, answer)
    return quote ? { answerCoverage: 'covered', answerExcerpt: quote.slice(0, 240) }
      : { answerCoverage: 'unverified', answerExcerpt: null }
  }
  const expected = new Set(question.injected.filter(evidence => evidence.verified === true)
    .map(evidence => quantityProofKey(quantityEvidence(question, String(evidence.text).replace(/^\s*-\s*\[[^\]]+\]\s*/u, '')))).filter(Boolean))
  const claim = quantityEvidence(question, answer)
  return expected.size === 1 && claim && expected.has(quantityProofKey(claim))
    ? { answerCoverage: 'covered', answerExcerpt: claim.quote.slice(0, 240) }
    : { answerCoverage: 'unverified', answerExcerpt: null }
}

function valueConflictCoverage(question, answer, questions) {
  const fullAnswer = String(answer ?? '').trim()
  const hasOtherEntity = questions.some(other => other !== question && other.detail === question.detail &&
    other.entityTerms?.length && JSON.stringify(other.entityTerms) !== JSON.stringify(question.entityTerms))
  const text = hasOtherEntity ? fullAnswer.split(/[。！？!\n；;]+/u)
    .filter(line => matchesRecallEntity({ record: { content: line } }, question.entityTerms)).join('。') : fullAnswer
  const alternatives = new Set((question.conflictingValues ?? [])
    .map(value => normalizeAnswerEvidenceValue(question.detail, value)))
  const mentioned = new Set(answerEvidenceAtoms(question, text).map(value => normalizeAnswerEvidenceValue(question.detail, value)))
  const acknowledges = /(?:不一致|(?:互相|相互|有|存在)冲突|说法不同|各有不同|无法(?:确定|确认)|待核对|需确认|\b(?:conflict(?:ing)?|disagree|cannot (?:determine|confirm)|unresolved)\b)/iu.test(text)
  const declaresWinner = text.split(/[。！？;；\n]+/u).some(clause => !UNCONFIRMED_VALUE.test(clause) &&
    /(?:以.{1,32}为准|(?:我|我们)(?:已)?(?:确定|确认)|(?:实际|正确|现行|当前)(?:值|设置|时间|期限)?(?:就是|是|应为|为)|(?:因此|所以|应当|最终|建议).{0,10}(?:采用|确定|仍按)|\b(?:therefore use|the (?:actual|correct) (?:time|value) is)\b)/iu.test(clause) &&
    answerEvidenceAtoms(question, clause).some(value => alternatives.has(normalizeAnswerEvidenceValue(question.detail, value))))
  return acknowledges && !declaresWinner && alternatives.size > 1 && [...alternatives].every(value => mentioned.has(value))
    ? { answerCoverage: 'covered', answerExcerpt: text.slice(0, 240) }
    : { answerCoverage: 'unverified', answerExcerpt: null }
}

export function assessAnswerCoverage(question, answer, questions = []) {
  if (!Array.isArray(question.injected) || !question.injected.some(evidence => evidence.verified === true)) {
    if ((question.notInjected?.length ?? 0) > 0) return { answerCoverage: 'not-injected', answerExcerpt: null }
    if ((question.hits?.length ?? 0) === 0) return { answerCoverage: 'no-evidence', answerExcerpt: null }
    return { answerCoverage: 'unverified', answerExcerpt: null }
  }
  if (question.eventWindow && !calendarWindowAnswerMatches(answer, question.eventWindow)) {
    return { answerCoverage: 'unverified', answerExcerpt: null }
  }
  if (question.stateField) {
    const expected = new Set(question.injected.filter(hit => hit.verified === true).flatMap(hit => {
      const quote = hit.selectedQuote ?? hit.text.replace(/^\s*-\s*\[[^\]]+\]\s*/u, '')
      const proof = stateFieldEvidence(question.stateField, quote)
      return proof?.value ? [stateValueKey(proof.value)] : []
    }))
    const excerpt = expected.size === 1
      ? statedFieldAnswer(question.stateField, answer, expected.values().next().value, questions.length <= 1)
      : null
    return excerpt ? { answerCoverage: 'covered', answerExcerpt: excerpt.slice(0, 240) }
      : { answerCoverage: 'unverified', answerExcerpt: null }
  }
  if (question.valueConflict) return valueConflictCoverage(question, answer, questions)
  if (question.counter) {
    const text = String(answer ?? '').trim()
    return matchesReportedCounterAnswer(text, question.counter, questions.flatMap(item => item.counter ? [item.counter] : []))
      ? { answerCoverage: 'covered', answerExcerpt: text.slice(0, 240) }
      : { answerCoverage: 'unverified', answerExcerpt: null }
  }
  if (question.elapsed) {
    const text = String(answer ?? '').trim()
    return matchesElapsedAnswer(text, question.elapsed)
      ? { answerCoverage: 'covered', answerExcerpt: text.slice(0, 240) }
      : { answerCoverage: 'unverified', answerExcerpt: null }
  }
  if (question.declaredCount) {
    const text = String(answer ?? '').trim()
    return matchesDeclaredCountAnswer(text, question.declaredCount)
      ? { answerCoverage: 'covered', answerExcerpt: text.slice(0, 240) }
      : { answerCoverage: 'unverified', answerExcerpt: null }
  }
  if (question.durationAtEvent) {
    const text = String(answer ?? '').trim()
    return matchesDurationAtEventAnswer(text, question.durationAtEvent)
      ? { answerCoverage: 'covered', answerExcerpt: text.slice(0, 240) }
      : { answerCoverage: 'unverified', answerExcerpt: null }
  }
  if (question.eventAge) {
    const text = String(answer ?? '').trim()
    return matchesEventAgeAnswer(text, question.eventAge)
      ? { answerCoverage: 'covered', answerExcerpt: text.slice(0, 240) }
      : { answerCoverage: 'unverified', answerExcerpt: null }
  }
  if (question.eventLocation) {
    const text = String(answer ?? '').trim()
    return matchesEventLocationAnswer(text, question.eventLocation)
      ? { answerCoverage: 'covered', answerExcerpt: text.slice(0, 240) }
      : { answerCoverage: 'unverified', answerExcerpt: null }
  }
  if (question.eventLocationIncomplete) return { answerCoverage: 'unverified', answerExcerpt: null }
  if (question.detail === 'dated-expenses') {
    const text = String(answer ?? '').trim()
    return matchesExpenseAnswer(text, question.expenses)
      ? { answerCoverage: 'covered', answerExcerpt: text.slice(0, 240) }
      : { answerCoverage: 'unverified', answerExcerpt: null }
  }
  if (question.detail === 'market-sales' || question.detail === 'personal-fundraising') {
    const text = String(answer ?? '').trim()
    const sales = question.detail === 'market-sales'
    const matches = sales ? matchesMarketSalesAnswer(text, question.marketSales)
      : matchesPersonalFundraisingAnswer(text, question.personalFundraising)
    return matches
      ? { answerCoverage: 'covered', answerExcerpt: text.slice(0, 240) }
      : { answerCoverage: 'unverified', answerExcerpt: null }
  }
  if (question.eventCount) {
    const text = String(answer ?? '').trim()
    return matchesEventCountAnswer(text, question.eventCount)
      ? { answerCoverage: 'covered', answerExcerpt: text.slice(0, 240) }
      : { answerCoverage: 'unverified', answerExcerpt: null }
  }
  if (question.timeline) {
    const text = String(answer ?? '').trim()
    return !UNCONFIRMED_VALUE.test(text) && matchesTimelineAnswer(text, question.timeline)
      ? { answerCoverage: 'covered', answerExcerpt: text.slice(0, 240) }
      : { answerCoverage: 'unverified', answerExcerpt: null }
  }
  if (question.detail === 'event-date') {
    const text = String(answer ?? '').trim()
    const bounded = Number.isSafeInteger(question.calendar?.minimumDays)
    const covered = question.calendarDate ? matchesCalendarDateAnswer(text, question.query, question.calendarDate)
      : (bounded || !UNCONFIRMED_VALUE.test(text)) && matchesCalendarAnswer(text, question.calendar)
    return covered ? { answerCoverage: 'covered', answerExcerpt: text.slice(0, 240) }
      : { answerCoverage: 'unverified', answerExcerpt: null }
  }
  if (question.quantity) return quantityAnswerCoverage(question, answer)
  if (question.purchasePrice) {
    const quote = discountPriceAnswer(question.purchasePrice, answer, question.purchaseValue)
    return quote ? { answerCoverage: 'covered', answerExcerpt: quote.slice(0, 240) }
      : { answerCoverage: 'unverified', answerExcerpt: null }
  }
  if (question.detail === 'clock' || question.detail === 'retention') return consistentValueCoverage(question, answer, questions)
  if (question.detail === 'reason') return consistentReasonCoverage(question, answer, questions)
  if (question.detail === 'duration' || question.detail === 'frequency') {
    if (question.injected.some(hit => hit.timeMeasureDisputed)) return { answerCoverage: 'unverified', answerExcerpt: null }
    const plan = timeMeasureIntent(question.query)
    const verified = question.injected.filter(hit => hit.verified === true)
    const expected = new Set(verified.flatMap(hit =>
      hit.timeMeasureValues ?? [timeMeasureEvidence(plan, hit.selectedQuote ?? hit.text.replace(/^\s*-\s*\[[^\]]+\]\s*/u, ''))?.value])
      .filter(Boolean).map(timeMeasureValueKey))
    const text = String(answer ?? '').trim()
    if (plan?.mode === 'race-best') {
      return expected.size === 1 && expected.has(racePersonalBestAnswer(plan, text))
        ? { answerCoverage: 'covered', answerExcerpt: text.slice(0, 240) }
        : { answerCoverage: 'unverified', answerExcerpt: null }
    }
    const separatePeriods = question.timeMeasurePeriod &&
      questions?.filter(other => other.detail === 'frequency' && other.timeMeasurePeriod).length > 1
    const subjects = new Set(questions.filter(slot => slot.detail === question.detail && slot.timeMeasureSubject)
      .map(slot => slot.timeMeasureSubject))
    const separateSubjects = !separatePeriods && question.timeMeasureSubject && subjects.size > 1
    const clauseSubject = clause => {
      const lower = clause.toLowerCase().replace(/\s+/gu, '')
      const found = [...subjects].filter(subject => lower.includes(subject.toLowerCase().replace(/\s+/gu, '')))
      return found.length === 1 ? found[0] : null
    }
    const clauses = separatePeriods ? timeMeasureClauses(text) : separateSubjects
      ? sourceSentences(text).flatMap(sentence => {
        const parts = sentence.split(/([,;，；])/u)
        const combined = [parts[0]]
        for (let i = 1; i + 1 < parts.length; i += 2) {
          const clause = parts[i + 1]
          const subject = clauseSubject(clause)
          if (subject && subject !== clauseSubject(combined.at(-1))) combined.push(clause)
          else combined[combined.length - 1] += parts[i] + clause
        }
        return combined
      }) : sourceSentences(text)
    const relevant = separatePeriods ? clauses.filter(sentence => timeMeasureAnswerPeriod(sentence) === question.timeMeasurePeriod)
      : separateSubjects ? clauses.filter(sentence => clauseSubject(sentence) === question.timeMeasureSubject) : clauses
    const claims = relevant
      .map(sentence => ({ sentence, values: statedTimeMeasures(question.detail, sentence, { direction: question.timeMeasureDirection, cumulative: plan?.mode === 'cumulative' }) }))
      .filter(claim => claim.values.length > 0)
    const allTagged = !separatePeriods || clauses.every(sentence => timeMeasureAnswerPeriod(sentence) ||
      statedTimeMeasures(question.detail, sentence).length === 0)
    const allNamed = !separateSubjects || clauses.every(sentence => clauseSubject(sentence) ||
      statedTimeMeasures(question.detail, sentence).length === 0)
    const excerpts = verified.map(hit => hit.selectedQuote ?? hit.text)
    if (expected.size === 1 && allTagged && allNamed && claims.length > 0 && !MISSING_MEASUREMENT.test(relevant.join(' ')) &&
        claims.every(({ sentence, values }) => !UNCONFIRMED_VALUE.test(sentence) &&
          matchesRecordedTimeAnswer(plan, sentence, excerpts) && values.every(value => expected.has(timeMeasureValueKey(value))))) {
      return { answerCoverage: 'covered', answerExcerpt: claims[0].sentence.slice(0, 240) }
    }
    return { answerCoverage: 'unverified', answerExcerpt: null }
  }
  const valueProperty = recallUnitProperty(question.query)
  const measured = new Set(question.injected.filter(item => item.verified).flatMap(item => recallPropertyMeasures(question.query, item.text) ?? []))
  if (measured.size > 0 || valueProperty === 'display' || valueProperty === 'network') {
    const text = String(answer ?? '').trim()
    const parts = sourceSentences(text).flatMap(sentence => sentence.split(/\s+(?:and|but|while)\s+|以及|并且/iu))
    const clauses = scopedAnswerClauses(question, questions, parts)
    const stated = clauses.flatMap(clause => {
      const values = recallPropertyMeasures(question.query, clause) ?? []
      return values.map(value => ({ value, uncertain: UNCONFIRMED_VALUE.test(clause) }))
    })
    const covered = measured.size === 1 && stated.length > 0 && stated.every(row => !row.uncertain && measured.has(row.value))
    return covered ? { answerCoverage: 'covered', answerExcerpt: text.slice(0, 240) }
      : { answerCoverage: 'unverified', answerExcerpt: null }
  }
  const personal = personalSourceQuestion(question.query)
  if (personal?.receivedGift) {
    const quotes = question.injected.filter(hit => hit.verified === true)
      .map(hit => hit.selectedQuote ?? hit.text.replace(/^\s*-\s*\[[^\]]+\]\s*/u, ''))
    return receivedGiftAnswer(personal, answer, quotes)
      ? { answerCoverage: 'covered', answerExcerpt: String(answer ?? '').trim().slice(0, 240) }
      : { answerCoverage: 'unverified', answerExcerpt: null }
  }
  const study = studyAnswerCoverage(question, answer, personal)
  if (study) return study
  const leadership = leadershipCountCoverage(question, answer, questions)
  if (leadership) return leadership
  const sentences = String(answer ?? '').split(/(?<=[。！？!?])\s*|\n+/u).map(text => text.trim()).filter(Boolean)
  if (sentences.length === 0) return { answerCoverage: 'unverified', answerExcerpt: null }
  for (const evidence of question.injected) {
    if (evidence.verified !== true) continue
    if (!question.detail && typeof evidence.selectedQuote === 'string' && evidence.text.includes(evidence.selectedQuote)) {
      const match = sourceSentences(answer).find(sentence => matchesSelectedQuote(evidence.selectedQuote, sentence, question.query))
      if (match) return { answerCoverage: 'covered', answerExcerpt: match.slice(0, 240) }
      continue
    }
    const atoms = answerEvidenceAtoms(question, evidence.text)
    for (const sentence of sentences) {
      const matches = atoms.some(atom => normalizedAnswerText(sentence).includes(atom))
      if (matches) return { answerCoverage: 'covered', answerExcerpt: sentence.slice(0, 240) }
    }
  }
  return { answerCoverage: 'unverified', answerExcerpt: null }
}
