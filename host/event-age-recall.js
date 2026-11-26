import { calendarOrderClauses, readDayCount, sourceCalendarDay, sourceEventDate } from './calendar-recall.js'
import { estimateTokens } from './recall.js'
import { isRecallSourceStatement } from './source-passages.js'
import { sourceSentences } from './sentences.js'
import { statedTimeMeasures } from './time-measure-recall.js'
import { tokenize } from './tokenize.js'

const DAY = 86_400_000
const ENGLISH_ACTIONS = new Map([
  ['attend', 'attended|went to|participated in|took part in|got back from|returned from|came back from|did|ran'],
  ['participate', 'participated in|took part in|did|ran'],
  ['buy', 'bought|purchased|paid for|got'],
  ['harvest', 'harvested'],
  ['meet', 'met up with|met with|caught up with|catch up with|met'],
  ['watch', 'watched'],
  ['visit', 'visited|went to'],
  ['receive', 'received|got'],
  ['order', 'ordered'],
  ['finish', 'finished|completed'],
  ['start', 'started|began'],
  ['submit', 'submitted|turned in'],
  ['launch', 'launched'],
  ['install', 'installed'],
  ['join', 'joined'],
  ['send', 'sent'],
])
const ENGLISH_ASK = new Map([
  ['participate in', 'participate'], ['go to', 'attend'], ['purchase', 'buy'], ['meet up with', 'meet'], ['meet with', 'meet'],
  ['get', 'receive'], ['complete', 'finish'], ['begin', 'start'], ...[...ENGLISH_ACTIONS.keys()].map(action => [action, action]),
])
const ENGLISH_PAST = new Map([...ENGLISH_ACTIONS].flatMap(([action, past]) => past.split('|')
  .filter(verb => !/back from|returned from|^(?:did|ran)$/u.test(verb)).map(verb => [verb, action])))
ENGLISH_PAST.set('went to', 'attend')
const PAST_WORDING = { attend:'attended', participate:'took part in', buy:'bought', harvest:'harvested', meet:'met', watch:'watched', visit:'visited',
  receive:'received', order:'ordered', finish:'finished', start:'started', submit:'submitted', launch:'launched',
  install:'installed', join:'joined', send:'sent' }
const CHINESE_ACTIONS = new Map([
  ['购买', 'buy'], ['买下', 'buy'], ['买', 'buy'], ['参加', 'attend'], ['参与', 'attend'], ['观看', 'watch'], ['看', 'watch'],
  ['参观', 'visit'], ['见', 'meet'], ['收到', 'receive'], ['下单', 'order'], ['完成', 'finish'], ['做完', 'finish'],
  ['开始', 'start'], ['提交', 'submit'], ['上线', 'launch'], ['安装', 'install'], ['加入', 'join'], ['发送', 'send'],
])
const CHINESE_UNITS = { 天: 'day', 周: 'week', 星期: 'week', 礼拜: 'week', 月: 'month', 个月: 'month' }
const EN_QUESTION = /^how many (?<unit>days|weeks|months) ago did (?<actor>i|we) (?<event>[^?！!；;<>\n]{1,130})$/iu
const EN_SINCE = /^how many (?<unit>days|weeks|months) (?:have |has )?passed since (?<actor>i|we) (?<event>[^?！!；;<>\n]{1,130})$/iu
const ZH_VERBS = [...CHINESE_ACTIONS.keys()].join('|')
const ZH_QUESTION = new RegExp(String.raw`^(?<actor>我们|我)(?<verb>${ZH_VERBS})(?:了)?(?<object>[^?？,，；;。<>]{1,55}?)(?:是|在)?(?:几|多少)(?<unit>天|周|星期|礼拜|个月|月)前$`, 'u')
const ZH_STATEMENT = new RegExp(String.raw`^(?:\u0000[,，]?)?(?<actor>我们|我)(?:[在于]?\u0000)?(?:刚刚|刚|已经|也)?(?<verb>${ZH_VERBS})(?:了)?(?<object>[^\u0000，,。！？]+?)(?:了)?(?:\u0000)?[。！]?$`, 'u')
const NO_EVENT = /\b(?:if|not|never|maybe|might|would|could|plan(?:ned|ning)?|supposed|scheduled|imagined|example|heard|claimed|said|every|usually)\b|计划|打算|原定|假设|没(?:有|去|参加|买|见)|未曾|据说|转述|并非/u
const MULTIPLE = /\b(?:when|after|before|as soon as|since|or|and)\b|的时候|那天|之前|之后|以及|或者/iu
const PRONOUN = /^(?:it|them|that|this|one|something|anything|here|there|它|它们|这件事|那个|这个)$/iu
const EN_ASK_VERB = new RegExp(String.raw`^(?<verb>${[...ENGLISH_ASK.keys()].join('|')})\s+`, 'iu')
const EN_PAST_VERB = new RegExp(String.raw`^(?<verb>${[...ENGLISH_PAST.keys()].join('|')})\s+`, 'iu')
const EN_ACTOR = String.raw`\b(?<actor>i|we)(?:['’]ve)?\s+(?:(?:just|already|actually|finally|also|recently|have|had)\s+){0,4}`
const EN_DATE_LEAD = /^(?:(?:oh,\s*and\s+)?by the way,\s*)?(?:today|yesterday|last (?:week|month|year)|[^,?.!]{1,30} ago|on [^,?.!]{2,33})\s*[,，]?\s*$/iu
const SAME_DAY_EVENT = /\b(?:i|we)\s+(?:had|ate|met|saw|spoke|played)\b[^;!?]{0,75}\b(?<date>today|yesterday)\s+when\s*$/iu
const ACTOR_BREAK = /\b(?:he|she|they|someone|who|which|that|when|if|else)\b/iu
const NEXT_EVENT = /\s+(?:and|or|when|where|before|after|because|while|rather than|instead of|but|so|[-–—])\s+/iu
const RETURN_DATE = /\b(?:that|which)\s+(?:ran|took place|happened|occurred|was held)(?=\s)/iu
const PREFIX_WORDS = new Set(['a', 'an', 'the', 'my', 'our', 'new', 'first', 'recent', 'day', 'two', 'three'])
const NAME_FOLLOWERS = new Set(['today', 'yesterday', 'last', 'on', 'at', 'in', 'with', 'over', 'for', 'from', 'by',
  'which', 'that', 'a', 'an', 'was', 'is', 'about', 'around', 'roughly', 'approximately'])
const ANSWER_UNCERTAIN = /\b(?:not|never|unknown|uncertain|about|around|roughly|approximately|can't|cannot)\b|无法|不确定|未知|并非|不是|大约|左右|差不多/iu

export function eventAgeQuery(query) {
  const text = String(query ?? '').normalize('NFKC').trim().replace(/[?？]+$/u, '')
  const chinese = ZH_QUESTION.exec(text.replace(/\s+/gu, ''))
  if (chinese) {
    const { actor, verb, object, unit } = chinese.groups
    return MULTIPLE.test(object) || PRONOUN.test(object) ? null
      : { language: 'zh', actor, unit: CHINESE_UNITS[unit], action: CHINESE_ACTIONS.get(verb), name: [object], search: object,
        eventLabel: verb + object }
  }
  const direct = EN_QUESTION.exec(text)
  const match = direct ?? EN_SINCE.exec(text)
  if (!match) return null
  const { event, actor, unit } = match.groups
  const verb = (direct ? EN_ASK_VERB : EN_PAST_VERB).exec(event)
  if (!verb) return null
  const label = event.slice(verb[0].length)
  const name = tokenize(label.replace(/^(?:the|a|an|my|our)\s+/iu, ''))
  if (!name.length || name.length > 12 || MULTIPLE.test(label) || PRONOUN.test(name.join(' '))) return null
  const action = (direct ? ENGLISH_ASK : ENGLISH_PAST).get(verb.groups.verb.toLowerCase())
  return { language: 'en', actor: actor.toLowerCase(), unit: unit.toLowerCase().slice(0, -1), action, name, search: name.join(' '),
    eventLabel: label.replace(/^(?:my|our)\s+/iu, 'your ').replace(/\s+/gu, ' ').trim() }
}

function namesObject(text, name) {
  const words = tokenize(text)
  return words.some((_, from) => {
    if (!words.slice(0, from).every(word => PREFIX_WORDS.has(word) || /^\d+$/u.test(word))) return false
    const next = words[from + name.length]
    return name.every((word, offset) => words[from + offset] === word) &&
      (next === undefined || NAME_FOLLOWERS.has(next) || Number.isSafeInteger(readDayCount(next)))
  })
}

function englishEvent(record, clause, plan, direct, coordinated) {
  const match = direct.exec(clause) ?? coordinated.exec(clause)
  if (!match || plan.actor === 'we' && match.groups.actor.toLowerCase() !== 'we' ||
      ACTOR_BREAK.test(match.groups.lead ?? '') || NO_EVENT.test(match.groups.lead ?? '')) return null
  const prefix = clause.slice(0, match.index)
  const linked = SAME_DAY_EVENT.exec(prefix)
  if (linked ? /\b(?:if|imagined|pretend|hypothetical|example|never)\b/iu.test(prefix) : NO_EVENT.test(prefix)) return null
  const objectStart = match.index + match[0].length
  const object = clause.slice(objectStart).split(NEXT_EVENT)[0]
  if (!namesObject(object, plan.name) || NO_EVENT.test(object) || /^back\s+(?:from|into)\b/iu.test(object)) return null
  const from = linked ? prefix.lastIndexOf(linked.groups.date) : EN_DATE_LEAD.test(prefix) ? 0 : match.index
  const quote = clause.slice(from, objectStart + object.length).trim()
  const verb = match.groups.verb.toLowerCase()
  const returned = /back from|returned from/iu.test(verb)
  const held = returned ? RETURN_DATE.exec(object) : null
  const dated = held ? object.slice(held.index) : quote
  const time = sourceEventDate(record, quote, { dated })
  return { quote, day: returned && !held ? null : time.day, zone: time.zone,
    returnDay: returned && !held ? time.day : null, conditional: plan.action === 'buy' && verb === 'got' }
}

function chineseEvent(record, clause, plan) {
  if (NO_EVENT.test(clause)) return null
  const time = sourceEventDate(record, clause)
  const match = ZH_STATEMENT.exec(time.marked.replace(/\s+/gu, ''))
  if (!match || match.groups.actor !== plan.actor || CHINESE_ACTIONS.get(match.groups.verb) !== plan.action ||
      match.groups.object !== plan.name[0]) return null
  return { quote: clause, day: time.day, zone: time.zone, conditional: false }
}

function eventAgeMatcher(plan) {
  const verbs = ENGLISH_ACTIONS.get(plan.action)
  const direct = new RegExp(String.raw`${EN_ACTOR}(?<verb>${verbs})\s+`, 'iu')
  const coordinated = new RegExp(String.raw`${EN_ACTOR}(?<lead>[^;!?]{2,68}?)\s+and\s+(?<verb>${verbs})\s+`, 'iu')
  return record => sourceSentences(record.content).filter(isRecallSourceStatement).flatMap(sentence =>
    calendarOrderClauses(sentence).flatMap(piece => {
      const clause = piece.trim()
      const proof = plan.language === 'zh' ? chineseEvent(record, clause, plan) : englishEvent(record, clause, plan, direct, coordinated)
      return proof && isRecallSourceStatement(proof.quote) ? [proof] : []
    }))
}

function anniversary(date, months) {
  const year = date.getUTCFullYear(), month = date.getUTCMonth() + months
  const day = Math.min(date.getUTCDate(), new Date(Date.UTC(year, month + 1, 0)).getUTCDate())
  return Date.UTC(year, month, day) / DAY
}

function ageParts(from, through, unit) {
  const days = through - from
  if (unit === 'day') return [[days, 'day']]
  if (unit === 'week') return [[Math.floor(days / 7), 'week'], ...(days % 7 ? [[days % 7, 'day']] : [])]
  const start = new Date(from * DAY), end = new Date(through * DAY)
  let months = (end.getUTCFullYear() - start.getUTCFullYear()) * 12 + end.getUTCMonth() - start.getUTCMonth()
  if (anniversary(start, months) > through) months--
  const remainder = through - anniversary(start, months)
  return [[months, 'month'], ...(remainder ? [[remainder, 'day']] : [])]
}

const dateLabel = day => new Date(day * DAY).toISOString().slice(0, 10)

export function retrieveEventAge(index, plan, { projectKey, clock, maxTokens, maxItems, scanLimit, skipCapture, accepts }) {
  const now = clock.eventTime
  const proofsFor = eventAgeMatcher(plan)
  const scan = index.findEvidence(['event'], {
    projectKey, now, maxTokens: scanLimit, allMatches: true, wholeSentences: true, acceptOriginal: true,
    lookupQuery: () => plan.search,
    distinctKey: (_lane, hit) => hit.record.id,
    match: (_lane, hit) => {
      if (!accepts(hit)) return null
      const observations = proofsFor(hit.record)
      return observations.length ? { ...hit, observations } : null
    },
  })
  const hits = index.validateMany(scan.matches.map(item => item.hit), projectKey, { now })
  const observations = hits.flatMap(hit => hit.observations.map(proof => ({ hit, proof })))
  const zh = plan.language === 'zh', questionDay = sourceCalendarDay(clock)
  const days = new Set(observations.map(row => JSON.stringify([row.proof.day, row.proof.zone])))
  const chosen = observations.find(row => !row.proof.conditional) ?? observations[0]
  const note = (zh ? '按核算的时间回答，保留条件。' : 'Use the verified calculation, including any condition.') +
    (skipCapture ? (zh ? '本轮不提炼。' : ' Do not capture this turn.') : '')
  const block = (line, hasRemainder = false) => {
    const precision = hasRemainder ? (zh ? '先给确切天数，再保留完整的拆分。' : ' State the exact days first and preserve the breakdown.') : ''
    return `<memory-context source="dsh-memory" note="${note}${precision}">\n${line}\n</memory-context>`
  }
  const known = !scan.incomplete && days.size === 1 && questionDay !== null &&
    chosen.proof.zone === clock.timeZone && chosen.proof.day !== null && chosen.proof.day <= questionDay
  if (known && maxItems > 0) {
    const { proof } = chosen
    const days = questionDay - proof.day
    const rawParts = ageParts(proof.day, questionDay, plan.unit)
    const parts = rawParts.filter(([count]) => count > 0 || rawParts.length === 1)
    const elapsed = parts.map(([n, unit]) => zh ? `${n} ${{ day:'天', week:'周', month:'个月' }[unit]}`
      : `${n} ${unit}${n === 1 ? '' : 's'}`).join(zh ? ' ' : ' and ')
    const date = dateLabel(proof.day)
    const event = proof.conditional ? `If you mean when you got ${plan.eventLabel}, it was`
      : `You ${PAST_WORDING[plan.action]} ${plan.eventLabel}`
    const interval = zh ? (parts.length > 1 ? `${days} 天前（${elapsed}）` : `${elapsed}前`)
      : (parts.length > 1 ? `${days} days ago (${elapsed})` : `${elapsed} ago`)
    const localDate = parts.length > 1 ? `，日期是 ${date}。` : `（${date}）。`
    const line = zh ? `你${plan.eventLabel}是在 ${interval}${localDate}` : `Answer to the question: ${event} ${interval}, on ${date}.`
    const text = block(line, parts.length > 1)
    if (estimateTokens(text) <= maxTokens) return {
      text, hits: [chosen.hit], injected: [{ row: chosen, text: line, selectedQuote: proof.quote }],
      complete: true, eventAge: { days, parts, conditional: proof.conditional, projected: true, action: plan.action },
      scannedTokens: scan.tokens, budgetOmitted: false,
    }
  }
  // A return can still be shown as evidence. Its date does not determine
  // the date of an earlier activity with the same name.
  const returned = chosen?.proof.returnDay
  if (!scan.incomplete && maxItems > 0 && Number.isSafeInteger(returned) && questionDay !== null && returned <= questionDay &&
      observations.every(({ proof }) => proof.day === null && proof.returnDay === returned && proof.zone === clock.timeZone)) {
    const line = `You reported returning from ${plan.eventLabel} on ${dateLabel(returned)}. The attendance date is unknown.`
    const text = block(line)
    if (estimateTokens(text) <= maxTokens) return {
      text, hits: [chosen.hit], injected: [{ row: chosen, text: line, selectedQuote: chosen.proof.quote }],
      complete: false, eventAge: { days: null, boundedByReturn: true, projected: true },
      scannedTokens: scan.tokens, budgetOmitted: false,
    }
  }
  const text = block(zh ? '现有记忆不足以确定事件距今多久。' : 'The available memories do not establish how long ago this happened.')
  return { text: hits.length && estimateTokens(text) <= maxTokens ? text : '', hits: hits.slice(0, 4), injected: [],
    complete: false, eventAge: { days: null }, scannedTokens: scan.tokens, budgetOmitted: scan.incomplete || known }
}

export function matchesEventAgeAnswer(answer, age) {
  if (age.days === null || ANSWER_UNCERTAIN.test(answer)) return false
  if (age.conditional && !/\b(?:if|assuming|when you got|when you received)\b|如果|假如|拿到时|收到时/iu.test(answer)) return false
  const verb = PAST_WORDING[age.action]
  if (verb) {
    const relative = new RegExp(String.raw`\b(?:it (?:was|happened|occurred)|(?:I|you|we) ${verb}(?: [^.!?,]{0,110}?)?)\s+(?<when>the day before yesterday|today|yesterday|tomorrow)\b`, 'giu')
    const offsets = { today: 0, yesterday: 1, 'the day before yesterday': 2, tomorrow: -1 }
    for (const match of answer.matchAll(relative)) if (offsets[match.groups.when.toLowerCase()] !== age.days) return false
  }
  const expected = age.parts.map(([count, unit]) => count + ' ' + unit)
  const text = answer.replace(/[*_]/gu, '').replace(/\d{4}年\s*\d{1,2}月\s*\d{1,2}[日号]/gu, '')
  const claims = sourceSentences(text).flatMap(sentence => sentence.split(/[()（）]|(?<=\bago\b|(?:天|周|星期|礼拜|个月|月)前)/iu))
    .map(phrase => new Set(statedTimeMeasures('duration', phrase))).filter(values => values.size > 0)
  return claims.length > 0 && claims.every(values => values.size === 1 && values.has(age.days + ' day') ||
    values.size === expected.length && expected.every(value => values.has(value)))
}
