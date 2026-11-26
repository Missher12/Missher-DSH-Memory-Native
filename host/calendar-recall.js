/** Event dates are facts in the evidence, independent of record validity. */
import { sourceSentenceBreaks, sourceSentences } from './sentences.js'
import { sourceEventTime } from './source-time.js'

const DAY = 86_400_000
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const YEAR = /(?<![\p{L}\p{N}])([12]\d{3})(?:\s*年的?|(?=\b))/iu
const ENGLISH_FILLER = new Set(['i', 'we', 'the', 'a', 'an', 'my', 'our', 'your', 'its', 'of', 'on', 'in', 'at', 'for', 'to', 'that', 'really'])
const EVENT_WORDS = new Map(Object.entries({ starting: 'start', started: 'start', begin: 'start', beginning: 'start', began: 'start',
  working: 'work', worked: 'work', finished: 'finish', complete: 'finish', completed: 'finish',
  found: 'find', saw: 'find', seen: 'find', see: 'find', loved: 'love', loves: 'love', repotted: 'repot' }))
const UNCERTAIN_DATE = /(?:不是|并非|尚未确定|未定|不确定|尚未确认|暂定|原定|取消|待确认|\b(?:not|if|maybe|might|possibly|probably|tentative|unconfirmed|cancelled|canceled|tbd|originally\s+(?:set|scheduled))\b)/iu
const DATE_LIMIT = /(?:\b(?:since|by|before|after|from|until)\s*|(?:自|截至|早于|晚于|起于)\s*)$/iu
const DATE = /(?<!\d)(?<isoYear>[12]\d{3})[-/](?<isoMonth>\d{1,2})[-/](?<isoDay>\d{1,2})(?!\d)|(?<![\p{L}\d/])(?<shortA>\d{1,2})\/(?<shortB>\d{1,2})(?![\p{L}\d/])|(?:(?<hanYear>[12]\d{3})\s*年\s*)?(?<hanMonth>\d{1,2})\s*月\s*(?<hanDay>\d{1,2})\s*[日号]|(?<![\p{L}])(?<englishMonth>jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(?<englishDay>\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(?<englishYear>[12]\d{3}))?\b|(?<relative>前天|昨天|今天|明天|后天|\b(?:yesterday|today|tomorrow)\b)/giu
const WORK_WITH_PRONOUN = /\b(?:I|we)\s+(?:(?:started|began)(?:\s+to)?\s+)?(?:work|worked|working)\s+with\s+(?:her|him)(?=\s+on\b|[.!?;,\s]*$)/giu
const WORK_WITH_NAME = /^(?:I|[Ww]e)(?:['’](?:ve|m|re))?\s+(?:(?:am|are|was|were|have|had|been|started|began|recently|just)\s+){0,5}(?:work|worked|working)\s+with\s+(?:(?:a|an|my|the)\s+[a-z][a-z '-]{1,42},\s*)?(?<name>\p{Lu}[\p{L}'’-]+(?:\s+\p{Lu}[\p{L}'’-]+)?)(?=$|[\s,.;!?])/u
const PERSON_MENTION = /\b(?:ask(?:ed)?|met|interview(?:ed)?|call(?:ed)?|contact(?:ed)?|emailed|invited|spoke\s+with)\s+(\p{Lu}[\p{L}'’-]+(?:\s+\p{Lu}[\p{L}'’-]+)?)(?=$|[\s,.;!?])/gu
const PERSONAL_DAY_LABEL = /^the\s+(?:day|date)\s+(?=(?:I|we)\s+)/iu

function eventName(value, keepAction) {
  const text = value.trim().replace(/^[，,；;:\s]+|[，,；;:\s]+$/gu, '')
  return (keepAction ? text : text.replace(/^(?:(?:i|we|you|they)\s+)?(?:attend|hold|host|visit|complete|begin|finish|have|join|go\s+to)\s+/iu, ''))
    .replace(/\s+(?:i|we)\s+(?:was|were|had\s+been|have\s+been)\s+(?:preparing|planning|getting\s+ready)\s+for$/iu, '')
    .replace(/\s+(?:take\s+place|occur|happen|begin|end|start|finish)$/iu, '')
    .replace(/(?:的(?:时候|那天)|举行时|发生时)$/u, '').trim()
}

export function calendarEventTerms(label) {
  return (label.normalize('NFKC').replace(PERSONAL_DAY_LABEL, '').replace(YEAR, '').toLowerCase()
    .match(/[\p{Script=Han}]+|[a-z][a-z0-9_-]*/gu) ?? [])
    .filter(word => !ENGLISH_FILLER.has(word))
    .map(word => EVENT_WORDS.get(word) ?? word)
}

function visitPlace(label) {
  const match = /^(my|our)\s+visit\s+to\s+(.+)$/iu.exec(label)
  if (!match) return null
  const [, owner, namedPlace] = match
  const suffix = /\s+\(([A-Z][A-Za-z]{1,11})\)$/u.exec(namedPlace)
  const fullName = suffix ? namedPlace.slice(0, suffix.index) : namedPlace
  const initials = fullName.replace(/^the\s+/iu, '').split(/\s+/u).map(word => word[0]).join('')
  const alias = suffix?.[1].toLowerCase() === initials.toLowerCase() ? suffix[1] : null
  return { owner: owner.toLowerCase(), place: alias ? fullName : namedPlace, alias }
}

export function calendarDateSearchLabel(label) {
  return visitPlace(label)?.place ?? quotedEventTitle(label) ??
    (PERSONAL_DAY_LABEL.test(label) ? label.replace(PERSONAL_DAY_LABEL, '') : undefined)
}

function quotedEventTitle(label) {
  const match = /^(?:the\s+)?(?:"([^"]+)"|'([^']+)'|“([^”]+)”|‘([^’]+)’)\s+event$/iu.exec(label)
  return match?.slice(1).find(Boolean)
}

const TRIP_HEAD = /^(?:trips?|journeys?|vacations?|holidays?|visits?)$/iu
const TASK_ORDER = /^which\s+.{1,45}?\s+did\s+(?<actor>I|we)\s+(?<verb>start|begin|finish reading|complete|finish)\s+(?<direction>first|earliest|last|most recently|latest)\s*[,：:]\s*(?<left>.+?)\s+or\s+(?<right>.+)$/iu
const TASK_VERBS = new Map([
  ['fix', 'fixed|repaired|(?:completed|finished) (?:fixing|repairing)'],
  ['buy', 'bought|purchased|paid for'],
  ['build', 'assembled|built|(?:completed|finished) (?:assembling|building)'],
  ['read', '(?:completed|finished) reading'],
  ['submit', 'submitted|turned in'],
  ['start', '(?:started|began)(?: working on| building| making)?'],
  ['complete', 'completed|finished'],
])
const COMPLETED_TASKS = [
  [/^(?:fixing|repairing)\s+/iu, 'fix'],
  [/^(?:buying|purchasing)\s+/iu, 'buy'],
  [/^(?:assembling|building)\s+/iu, 'build'],
  [/^reading\s+/iu, 'read'],
  [/^submitting\s+/iu, 'submit'],
]
const EN_TRIP_CHOICE = /^(?:(?:the|an?|my|our)\s+)?(?:(?<mode>solo|family)\s+)?(?:trip|journey|vacation|holiday|visit|one)\s+to\s+(?<destination>[\p{L}\p{N}'’ -]{1,72}?)(?:\s+(?<party>with\s+(?:(?:my|our|the)\s+)?family|solo|alone|by myself))?$/iu
const ZH_TRIP_CHOICE = /^(?<party>和家人|跟家人|带家人|独自|一个人|单独)?(?:去|到)(?<destination>[\p{Script=Han}a-zA-Z0-9· ]{1,48}?)(?:旅游|旅行|度假)?$/u

function tripChoice(label, language) {
  const match = (language === 'en' ? EN_TRIP_CHOICE : ZH_TRIP_CHOICE).exec(label)
  if (!match) return null
  const { mode, party, destination } = match.groups
  if (/\b(?:with|solo|alone|for|by myself|last (?:month|year))\b/iu.test(destination)) return null
  const lone = mode?.toLowerCase() === 'solo' || /^(?:solo|alone|by myself|独自|一个人|单独)$/iu.test(party ?? '')
  const family = mode?.toLowerCase() === 'family' || /^(?:with\b|和|跟|带)/iu.test(party ?? '')
  if (lone && family) return null
  return { destination: destination.trim(), party: lone ? 'solo' : family ? 'family' : null }
}

function taskComparison(text) {
  const match = TASK_ORDER.exec(text)
  if (!match) return null
  const { actor, verb, direction, left, right } = match.groups
  const events = [left, right].map(label => label.trim().replace(/^[“‘"']|[”’"']$/gu, ''))
  const tasks = events.map(label => {
    if (/^finish reading$/iu.test(verb)) return { object: label, verb: 'read' }
    if (/^(?:start|begin)$/iu.test(verb)) return { object: label, verb: 'start' }
    const action = COMPLETED_TASKS.find(([lead]) => lead.test(label))
    return action ? { object: label.replace(action[0], ''), verb: action[1] }
      : { object: label, verb: 'complete' }
  })
  if (tasks.some(task => !calendarEventTerms(task.object).length || /[<>,;\n]|\b(?:and|or)\b/iu.test(task.object)) ||
      tasks[0].verb === tasks[1].verb && calendarEventTerms(tasks[0].object).join(' ') === calendarEventTerms(tasks[1].object).join(' ')) return null
  const order = /^(?:first|earliest)$/iu.test(direction) ? 'first' : 'last'
  return { events, action: 'task', order, language: 'en', actor: actor.toLowerCase(), tasks }
}

function eventOrderComparison(text) {
  if (text.length > 400) return null
  const task = taskComparison(text)
  if (task) return task
  const english = /^which\s+(?:(.{1,65}?)\s+did\s+(?:I|we)\s+|(?:event|activity|occasion)\s+)?(use|ride|take|go on|buy|purchase|order|happened|occurred|took place|was held|was|came)\s+(first|earliest|last|most recently|latest)\s*[,：:]\s*(.+?)\s+or\s+(.+)$/iu.exec(text)
  const chineseTrip = /^(?:我(?:们)?)?(先|最后|最近)去(?:了哪[里儿]|的是哪里|哪[里儿])[,，:：]\s*(.+?)\s*(?:还是|或)\s*(.+)$/u.exec(text)
  const chinese = /^(?:我(?:们)?)?(先|最后|最近)(购买|买|乘坐|坐|使用|用)(?:的是|过|了|的)?哪(?:个|件|种|一件|一个)[,，:：]\s*(.+?)\s*(?:还是|或)\s*(.+)$/u.exec(text)
  const occurrence = /^(.+?)\s*(?:和|与|还是)\s*(.+?)[,，]\s*(?:哪(?:一个|个|件事)|哪个事件)(先发生|最先发生|最后发生|后发生)$/u.exec(text)
  if (!english && !chinese && !chineseTrip && !occurrence) return null
  const [verb, direction, ...pair] = english ? english.slice(2) : chineseTrip ? ['去', ...chineseTrip.slice(1)]
    : chinese ? [chinese[2], chinese[1], ...chinese.slice(3)] : ['发生', occurrence[3], ...occurrence.slice(1, 3)]
  const events = pair.map(event => eventName(event, true))
  const terms = events.map(calendarEventTerms)
  if (terms.some(words => !words.length) || terms[0].join(' ') === terms[1].join(' ')) return null
  const language = english ? 'en' : 'zh'
  const order = /^(?:first|earliest|先(?:发生)?|最先发生)$/iu.test(direction) ? 'first' : 'last'
  if (chineseTrip || TRIP_HEAD.test(english?.[1] ?? '') && /^(?:take|go on)$/iu.test(verb)) {
    const trips = events.map(label => tripChoice(label, language))
    if (trips.some(trip => !trip) || trips[0].destination.toLowerCase() === trips[1].destination.toLowerCase() &&
        (!trips[0].party || !trips[1].party || trips[0].party === trips[1].party)) return null
    return { events, action: 'travel', order, language, trips }
  }
  if (/^go on$/iu.test(verb)) return null
  const action = /^(?:buy|purchase|order|购买|买)$/iu.test(verb) ? 'purchase'
    : /^(?:use|ride|take|乘坐|坐|使用|用)$/iu.test(verb) ? 'use' : 'occur'
  return { events, action, order, language }
}

const PERSONAL_INTERVAL_VERB = String.raw`(?:(?:had|have)\s+)?(?:passed|elapsed|gone\s+by)`
const PERSONAL_INTERVAL_SINCE = String.raw`how many (?<unit>days|weeks)\s+${PERSONAL_INTERVAL_VERB}\s+since\s+`
const PERSONAL_EVENT = String.raw`(?:I|we)\s+.+`
const PERSONAL_SINCE_QUERY = new RegExp(String.raw`^${PERSONAL_INTERVAL_SINCE}(?<first>${PERSONAL_EVENT}?)\s+when\s+(?<second>${PERSONAL_EVENT})$`, 'iu')
const WHEN_PERSONAL_SINCE_QUERY = new RegExp(String.raw`^when\s+(?<second>${PERSONAL_EVENT}?)\s*,\s*${PERSONAL_INTERVAL_SINCE}(?<first>${PERSONAL_EVENT})$`, 'iu')
const PERSONAL_WEEKS_BETWEEN_QUERY = new RegExp(String.raw`^how many (?<unit>weeks)(?:\s+${PERSONAL_INTERVAL_VERB})?\s+between\s+the (?:day|date)\s+(?<first>${PERSONAL_EVENT}?)\s+and\s+the (?:day|date)\s+(?<second>${PERSONAL_EVENT})$`, 'iu')

/** A fully named comparison has two independently searchable events. */
export function calendarComparison(query) {
  const text = String(query ?? '').normalize('NFKC').trim().replace(/[。.!?！？]+$/u, '')
  const order = eventOrderComparison(text)
  if (order) return order
  const sinceWhen = PERSONAL_SINCE_QUERY.exec(text)?.groups ?? WHEN_PERSONAL_SINCE_QUERY.exec(text)?.groups
  const betweenWeeks = sinceWhen ? null : PERSONAL_WEEKS_BETWEEN_QUERY.exec(text)?.groups
  const personalInterval = sinceWhen ?? betweenWeeks
  if (personalInterval) {
    const events = [personalInterval.first, personalInterval.second].map(label => 'the day ' + eventName(label, true))
    if (events[0] === events[1] || events.some(event => /[?？]|\b(?:when|or)\b/iu.test(event))) return null
    return { events, ordered: Boolean(sinceWhen), requiresBothDates: true, personalSince: true,
      ...(personalInterval.unit.toLowerCase() === 'weeks' ? { unit: 'weeks' } : {}) }
  }
  const elapsed = /^how many days\s+did it take\s+(?:for\s+(?:me|us|you|them)\s+)?to\s+(.+?)\s+after\s+(.+)$/iu.exec(text)
  const beforeAfter = /^how many days\s+(before|after)\s+(.+?)\s+did\s+(.+)$/iu.exec(text) ??
    /^how many days\s+(before|after)\s+(.+?)\s+(?:was|were)\s+(.+)$/iu.exec(text)
  const earlierLater = /^how many days\s+(earlier|later)\s+(?:was|were|did)\s+(.+?)\s+than\s+(.+)$/iu.exec(text)
  const fromTo = /^从\s*(.+?)\s*(?:到|至)\s*(.+?)[,，]?\s*(?:之间)?(?:中间)?(?:一共)?(?:相隔|相差|间隔|过了|隔(?:了)?)\s*(?:几|多少)[天日]$/u.exec(text)
  const compared = /^(.+?)\s*比\s*(.+?)\s*(早|晚|提前|推迟)(?:了)?\s*(?:几|多少)[天日]$/u.exec(text)
  const between = /^how many days\s+(?:(?:elapsed|(?:had |have )?passed|are there|were there)\s+)?between\s+(.+?)\s+and\s+(.+)$/iu.exec(text) ??
    /^(.+?)\s*(?:和|与)\s*(.+?)[,，]?\s*(?:之间)?(?:中间)?(?:相隔|相差|间隔|隔(?:了)?)\s*(?:几|多少)[天日]$/u.exec(text)
  let pair
  if (elapsed) pair = [elapsed[2], elapsed[1]]
  else if (beforeAfter) pair = beforeAfter[1].toLowerCase() === 'before' ? [beforeAfter[3], beforeAfter[2]] : [beforeAfter[2], beforeAfter[3]]
  else if (earlierLater) pair = earlierLater[1].toLowerCase() === 'earlier' ? earlierLater.slice(2) : earlierLater.slice(2).reverse()
  else if (fromTo) pair = fromTo.slice(1)
  else if (compared) pair = /早|提前/u.test(compared[3]) ? compared.slice(1, 3) : compared.slice(1, 3).reverse()
  else pair = between?.slice(1)
  const events = pair?.map(event => eventName(event, Boolean(elapsed)))
  if (!events || events[0] === events[1] || events.some(name => !name || calendarEventTerms(name).length === 0)) return null
  return { events, ordered: Boolean(elapsed || beforeAfter || earlierLater || fromTo || compared),
    ...(events.some(event => PERSONAL_DAY_LABEL.test(event)) ? { requiresBothDates: true } : {}) }
}

export function calendarParticipant(label) {
  if (!calendarEventTerms(label).includes('work')) return null
  return /\bwith\s+(\p{Lu}[\p{L}'’-]+(?:\s+\p{Lu}[\p{L}'’-]+)?)$/u.exec(label)?.[1] ?? null
}

function mentionsAnotherParticipant(text, name) {
  const expected = name.toLowerCase()
  return [...text.matchAll(PERSON_MENTION)].some(mention => {
    const value = mention[1].toLowerCase()
    return value !== expected && !expected.split(' ').includes(value)
  })
}

/** Only a unique earlier asserted working relationship can ground a pronoun. */
export function calendarParticipantAnchor(previous, name) {
  const names = new Map()
  for (const hit of previous) for (const quote of sourceSentences(hit.record.content)) {
    if (/[?？]/u.test(quote) || UNCERTAIN_DATE.test(quote)) continue
    if (mentionsAnotherParticipant(quote, name)) return null
    const match = WORK_WITH_NAME.exec(quote)
    if (!match) continue
    const remainder = quote.slice(match[0].length)
    if (/^\s*,?\s*(?:\band\b|\bor\b|&)\s+\p{Lu}|^\s*,\s*(?!(?:I|We|He|She|They)\b)\p{Lu}/u.test(remainder)) return null
    const key = match.groups.name.toLowerCase()
    if (!names.has(key)) names.set(key, { hit, quote })
  }
  const anchor = names.size === 1 ? names.get(name.toLowerCase()) : null
  return anchor?.hit.record.remembered ? anchor : null
}

function dayNumber(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    ? date.getTime() / DAY : null
}

export function sourceCalendarDay(ref) {
  if (sourceEventTime(ref.eventTime) === undefined || typeof ref.timeZone !== 'string') return null
  try {
    const local = new Intl.DateTimeFormat('en-CA', {
      timeZone: ref.timeZone, calendar: 'gregory', numberingSystem: 'latn',
      year: 'numeric', month: 'numeric', day: 'numeric',
    }).formatToParts(ref.eventTime)
    const part = name => Number(local.find(item => item.type === name)?.value)
    return dayNumber(part('year'), part('month'), part('day'))
  } catch { return null }
}

function sourceYear(ref) {
  const localDay = sourceCalendarDay(ref)
  if (localDay !== null) return new Date(localDay * DAY).getUTCFullYear()
  const time = sourceEventTime(ref.eventTime) ?? sourceEventTime(ref.at)
  if (time === undefined) return null
  // Without a zone, the year is usable only if all supported offsets agree.
  const guard = 14 * 60 * 60 * 1000
  const early = new Date(time - guard).getUTCFullYear(), late = new Date(time + guard).getUTCFullYear()
  return early === late ? early : null
}

function unanimous(values) {
  return values.length > 0 && values[0] !== null && values.every(value => value === values[0]) ? values[0] : null
}

const WEEKEND_COUNT = String.raw`(?:[1-9]\d?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)`
const WEEKEND_AGO = new RegExp(String.raw`^(${WEEKEND_COUNT}) weekends? ago$`, 'u')
const EVENT_PERIOD = String.raw`(?:\b(?:today|yesterday|last\s+(?:weekend|week|month|year)|${WEEKEND_COUNT}\s+weekends?\s+ago|(?:a|an|one|\d{1,2})\s+(?:days?|weeks?|months?|years?)\s+ago)\b|前天|昨天|今天|上周末|上周|上个月|去年|\d{1,2}(?:天|周)前)`
const ENGLISH_EVENT_WINDOW = new RegExp(String.raw`^(?:which|what)\s+(.{2,80}?)\s+did\s+(?:I|we)\s+(?:(?:finally|actually|successfully)\s+)?([a-z]+)(?:\s+(?:in|on|to|at|with))?\s+(${EVENT_PERIOD})$`, 'iu')
const CHINESE_EVENT_WINDOW = new RegExp(String.raw`^我(?:们)?(?:在)?(${EVENT_PERIOD})([\p{Script=Han}]{2,12}?)(?:了|过)(?:哪[本个项双台架辆件家道]|什么)\s*(.{1,45})$`, 'u')
const EVENT_CLAUSE_BREAK = new RegExp(String.raw`[;；]|(?:,?\s+(?:and|but)\s+|,\s*)(?=(?:${EVENT_PERIOD}(?:[,，]\s*|\s+))?(?:I|we|he|she|they)\b)|[，,]\s*(?=(?:而|但是|另外|接着)?(?:我|我们|同事|他|她))`, 'iu')
const EVENT_DATE_HINT = new RegExp(EVENT_PERIOD, 'giu')
const OCCURRENCE_VERBS = new Map(Object.entries({ buy: 'bought', take: 'took taken', do: 'did done', get: 'got gotten',
  beat: 'beat beaten', go: 'went gone', see: 'saw seen', eat: 'ate eaten', read: 'read', make: 'made', find: 'found', meet: 'met',
  run: 'ran run', write: 'wrote written', have: 'had', leave: 'left', bring: 'brought', send: 'sent' }))

function periodBounds(phrase, today) {
  if (today === null) return null
  const text = phrase.toLowerCase().replace(/\s+/gu, ' ')
  const offset = { today: 0, 今天: 0, yesterday: 1, 昨天: 1, 前天: 2 }[text]
  if (offset !== undefined) return { from: today - offset, to: today - offset + 1 }
  const day = new Date(today * DAY)
  const weekend = /^(?:last weekend|上周末)$/u.test(text) ? 1 : readDayCount(WEEKEND_AGO.exec(text)?.[1] ?? '')
  if (Number.isSafeInteger(weekend) && weekend > 0) {
    // Anchor to the most recent completed Saturday and Sunday in the client's calendar.
    const weekday = day.getUTCDay()
    const monday = today - (weekday + 6) % 7
    const to = monday - (weekend - 1) * 7
    return { from: to - 2, to }
  }
  if (/^(?:last week|上周)$/u.test(text)) {
    const monday = today - (day.getUTCDay() + 6) % 7
    return { from: monday - 7, to: monday }
  }
  const year = day.getUTCFullYear(), month = day.getUTCMonth()
  if (/^(?:last month|上个月)$/u.test(text)) return { from: Date.UTC(year, month - 1, 1) / DAY, to: Date.UTC(year, month, 1) / DAY }
  if (/^(?:last year|去年)$/u.test(text)) return { from: Date.UTC(year - 1, 0, 1) / DAY, to: Date.UTC(year, 0, 1) / DAY }
  const relative = /^(a|an|one|\d+)\s*(day|week|month|year)s? ago$/u.exec(text) ?? /^(\d+)(天|周)前$/u.exec(text)
  if (!relative) return null
  const count = /\d/u.test(relative[1]) ? Number(relative[1]) : 1
  const unit = relative[2]
  let from
  if (unit === 'month' || unit === 'year') {
    const target = month - count * (unit === 'year' ? 12 : 1)
    const lastDay = new Date(Date.UTC(year, target + 1, 0)).getUTCDate()
    from = Date.UTC(year, target, Math.min(day.getUTCDate(), lastDay)) / DAY
  } else from = today - count * (unit === 'week' || unit === '周' ? 7 : 1)
  return { from, to: from + 1 }
}

/** An occurrence is distinct from a property that was effective at a time. */
export function calendarEventWindow(query, reference) {
  const text = String(query).normalize('NFKC').trim().replace(/[?？。]+$/u, '')
  const english = ENGLISH_EVENT_WINDOW.exec(text)
  const chinese = english ? null : CHINESE_EVENT_WINDOW.exec(text)
  if (!english && !chinese) return null
  const [, object, verb, period] = english ?? [null, chinese[3], chinese[2], chinese[1]]
  const action = verb.toLowerCase()
  const ending = action.at(-1)
  const past = OCCURRENCE_VERBS.get(action)?.split(' ') ?? [ending === 'e' ? action + 'd' : action + 'ed',
    action + ending + 'ed', ...(ending === 'y' ? [action.slice(0, -1) + 'ied'] : [])]
  const progressive = (ending === 'e' ? action.slice(0, -1) : action) + 'ing'
  const referenceDay = sourceCalendarDay(reference)
  return { bounds: periodBounds(period, referenceDay), referenceDay, language: english ? 'en' : 'zh',
    object: calendarEventTerms(object).filter(term => !['pair', 'kind', 'type'].includes(term)),
    action: english ? new RegExp(String.raw`\b(?:I|we)(?:['’](?:ve|d))?\s+(?:(?:have|had|just|already|finally|also|recently|actually|successfully)\s+){0,5}(?:(?:${past.join('|')})\b|(?:finished|completed|got around to)\s+${progressive}\b)`, 'iu')
      : new RegExp(`我(?:们)?(?:在)?(?:${EVENT_PERIOD})?(?:刚刚|刚|已经|也)?${action}(?:了|过)`, 'u'),
    search: `${object} ${action} ${english ? [...past, progressive].join(' ') + ' ' : ''}${period}` }
}

export function calendarWindowPrompt(window) {
  if (!window?.bounds) return null
  const days = calendarOrderPeriod(window.bounds)
  return window.language === 'zh'
    ? `按问题所指的 ${days} 回答。有已换算日期的陈述时优先使用，引文只作证据。只答所问对象，列日期时用显示的日历日期。`
    : `Use the dated evidence for the period in the question (${days}). Answer from the date-resolved statement when provided. The unchanged original quote is evidence only. Use the displayed calendar dates.`
}

const WINDOW_ANSWER_DENIAL = /\b(?:no (?:mention|record|evidence|information)|not (?:recorded|mentioned))\b|(?:没有|无)(?:记录|证据|依据)|没有提到/u
const OTHER_WEEKEND = /\b(?:this|next|following) weekend\b|这个周末|本周末|下周末/iu
const WINDOW_DATE_END = /^(?:\s*[-–—]\s*|\s+(?:to|through|and)\s+)(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+([12]\d{3}))?(?![\d:-])/iu

export function calendarWindowAnswerMatches(answer, { bounds, referenceDay }) {
  if (!bounds || !Number.isSafeInteger(referenceDay)) return false
  const inside = range => range && range.from >= bounds.from && range.to <= bounds.to
  const referenceTime = referenceDay * DAY
  const years = [...new Set([bounds.from, bounds.to - 1].map(day => new Date(day * DAY).getUTCFullYear()))]
  for (const sentence of sourceSentences(String(answer ?? '').normalize('NFKC'))) {
    const periods = [...sentence.matchAll(EVENT_DATE_HINT)]
    const dates = [...sentence.matchAll(DATE)]
    if (OTHER_WEEKEND.test(sentence) || (periods.length || dates.length) && WINDOW_ANSWER_DENIAL.test(sentence.toLowerCase())) return false
    if (periods.some(match => !inside(periodBounds(match[0], referenceDay)))) return false
    for (const match of dates) {
      if (periods.some(period => period.index === match.index)) continue
      const group = match.groups
      const end = group.englishMonth && WINDOW_DATE_END.exec(sentence.slice(match.index + match[0].length))
      const valid = years.some(year => {
        const time = group.relative ? referenceTime : Date.UTC(year, 11, 31)
        const record = { sourceRefs: [{ sourceId:'answer', role:'user', sourceKind:'user',
          at:time, eventTime:time, timeZone:'UTC', from:0, to:sentence.length, excerpt:sentence }] }
        const day = dateNumber(match, record, sentence)
        if (!Number.isSafeInteger(day) || !inside({ from:day, to:day + 1 })) return false
        if (!end) return true
        const date = new Date(day * DAY)
        const through = dayNumber(Number(end[2] ?? date.getUTCFullYear()), date.getUTCMonth() + 1, Number(end[1]))
        return Number.isSafeInteger(through) && through >= day && inside({ from: day, to: through + 1 })
      })
      if (!valid) return false
    }
  }
  return true
}

export function calendarWindowEvidence(record, window) {
  if (!window.bounds) return null
  const clauses = sourceSentences(String(record?.content ?? '')).flatMap(sentence => sentence.split(EVENT_CLAUSE_BREAK))
  for (const fragment of clauses) {
    const quote = fragment.trim()
    if (/[?？]/u.test(quote) || UNCERTAIN_DATE.test(quote) ||
        /(?:计划|打算|准备|将要|想要|\b(?:planned?\s+to|planning\s+to|want(?:ed)?\s+to|would|going\s+to)\b)/iu.test(quote) || !window.action.test(quote)) continue
    const originals = originalDateRefs(record, quote)
    const at = unanimous(originals.map(sourceCalendarDay))
    const periods = [...quote.matchAll(EVENT_DATE_HINT)]
    const bounds = periods.map(period => DATE_LIMIT.test(quote.slice(0, period.index)) ? null : periodBounds(period[0], at))
    for (const match of quote.matchAll(DATE)) {
      if (periods.some(period => period.index === match.index)) continue
      if (DATE_LIMIT.test(quote.slice(0, match.index))) { bounds.push(null); continue }
      const day = dateNumber(match, record, quote)
      bounds.push(Number.isSafeInteger(day) ? { from: day, to: day + 1 } : null)
    }
    if (!bounds.length || bounds.some(bound => !bound || bound.from !== bounds[0]?.from || bound.to !== bounds[0]?.to)) continue
    const [bound] = bounds
    if (bound.from < window.bounds.from || bound.to > window.bounds.to) continue
    const terms = new Set(calendarEventTerms(quote))
    const namesObject = window.object.every(term => /^[a-z]/u.test(term) ? terms.has(term) : quote.includes(term))
    const days = [...new Set([bound.from, bound.to - 1])].map(day => new Date(day * DAY).toISOString().slice(0, 10))
    const period = days.join('–')
    const referenceDiffers = periods.some(match => {
      const fromQuestion = periodBounds(match[0], window.referenceDay)
      return fromQuestion?.from !== bound.from || fromQuestion?.to !== bound.to
    })
    const resolved = referenceDiffers
      ? quote.replace(new RegExp(String.raw`(?:\b(?:on|in|during)\s+|在)?${EVENT_PERIOD}`, 'giu'),
        () => window.language === 'zh' ? `在 ${period} ` : (days.length === 1 ? 'on ' : 'during ') + period)
      : null
    return { quote, namesObject, period, resolved }
  }
  return null
}

function dateNumber(match, record, quote) {
  const fields = match.groups
  const startingYear = fields.isoYear || fields.hanYear || fields.englishYear
  const month = fields.englishMonth
    ? MONTHS.indexOf(fields.englishMonth.slice(0, 3).toLowerCase()) + 1 : Number(fields.isoMonth || fields.hanMonth)
  const day = Number(fields.isoDay || fields.hanDay || fields.englishDay)
  if (startingYear) return dayNumber(Number(startingYear), month, day)
  const refs = record.sourceRefs ?? []
  const matched = refs.filter(ref => ref.excerpt?.includes(quote))
  if (fields.relative) {
    const current = unanimous(originalDateRefs(record, quote).map(sourceCalendarDay))
    const shift = { 前天: -2, 昨天: -1, 今天: 0, 明天: 1, 后天: 2, yesterday: -1, today: 0, tomorrow: 1 }
    return current === null ? null : current + shift[fields.relative.toLowerCase()]
  }
  const timed = (matched.length ? matched : refs).filter(ref => Number.isFinite(ref.at))
  const year = unanimous((timed.length ? timed : [{ at: record.observedAt }]).map(sourceYear))
  if (year === null) return null
  if (fields.shortA) {
    const possibilities = [...new Set([
      dayNumber(year, Number(fields.shortA), Number(fields.shortB)),
      dayNumber(year, Number(fields.shortB), Number(fields.shortA)),
    ].filter(Number.isSafeInteger))]
    return possibilities.length === 1 ? possibilities[0] : possibilities
  }
  return dayNumber(year, month, day)
}

function namesEvent(text, terms) {
  const normalized = text.normalize('NFKC').toLowerCase()
  const words = new Set((normalized.match(/[a-z][a-z0-9_-]*/gu) ?? []).map(word => EVENT_WORDS.get(word) ?? word))
  return terms.length > 0 && terms.every(term => /^[a-z]/u.test(term) ? words.has(term) : normalized.includes(term))
}

const ORDER_PERIOD = new RegExp(String.raw`(?<estimate>\b(?:about|around|roughly|approximately)\s+|大约|大概|约)?(?:(?<![\p{L}\p{N}])(?<count>a|an|[a-z]+(?:-[a-z]+)?|\d{1,3})\s+(?<unit>days?|weeks?|months?|years?)\s+ago\b|(?<period>${EVENT_PERIOD}))`, 'giu')
const CHINESE_DAY_OFFSET = /(?<estimate>大约|大概|约)?(?<hanCount>[一二两三四五六七八九十]+)(?:个)?(?<hanUnit>天|周|星期|礼拜)前/gu
const PERSONAL_ACTION = String.raw`\b(?:I|we)(?:['’]ve)?\s+(?:(?:have|had|just|recently|actually|already|finally|also)\s+){0,4}`
const PERSONAL_DAY_ACTION = new RegExp(String.raw`^\s*${PERSONAL_ACTION}(?:first\s+)?([a-z]+)\b`, 'iu')
const ANOTHER_PAST_ACTION = /\b(?:and|but)\s+(?:(?:I|we|he|she|they|then)\s+){0,2}(?:[a-z]+ed|began|did|went|got|gave|bought|found|took|made|saw|used)\b/iu
const NAMED_GIFT_RECIPIENT = /\b(?:my|our)\s+[a-z][a-z-]*(?:\s+[a-z][a-z-]*)?,\s+(?:(?:Mr|Mrs|Ms|Dr|Prof)\.?|Miss)\s+\p{Lu}[\p{L}'’-]*(?:\s+\p{Lu}[\p{L}'’-]*){0,2},(?=\s+(?:a|an|the|some|several)\s+\p{Ll})/gu

function personalDayAction(text) {
  const verb = PERSONAL_DAY_ACTION.exec(text)?.[1].toLowerCase()
  return EVENT_WORDS.get(verb) ?? verb
}

function personalEventObject(text) {
  return text.replace(PERSONAL_DAY_LABEL, '').replace(PERSONAL_DAY_ACTION, '').trim().replace(/\b(?:a|an|the)\s+/giu, '')
}
const ORDER_ACTIONS = {
  use: new RegExp(String.raw`${PERSONAL_ACTION}(?:used|took|rode|went by|got back from)\s+|我(?:们)?(?:在)?(?:${EVENT_PERIOD})?(?:刚刚|刚|已经|也)?(?:乘坐|坐|使用|用)(?:了|过)`, 'iu'),
  purchase: new RegExp(String.raw`${PERSONAL_ACTION}(?:bought|purchased|ordered|got)\s+|我(?:们)?(?:在)?(?:${EVENT_PERIOD})?(?:刚刚|刚|已经|也)?(?:购买|买|购入|下单)(?:了|过)`, 'iu'),
  occur: /\b(?:happened|occurred|took place|started|finished|was held|was completed)\b|发生了|举行了|已(?:完成|举行)|(?:举行|完成|举办)(?:了|。|$)/iu,
}
const NON_OCCURRENCE = /(?:计划|打算|准备|将要|想要|举例|假设|\b(?:plan(?:s|ned|ning)?|wanted?|would|could|going\s+to|thinking of|supposed to|for example|hypothetically|imagine|scheduled to)\b)/iu
const ORDER_CLAUSE_BREAK = new RegExp(String.raw`${EVENT_CLAUSE_BREAK.source}|,\s+(?:so|although|even though)\s+(?=(?:I|we|he|she|they)\b)`, 'iu')
const OBJECT_BOUNDARY = /\s+(?:to|toward|while|because|instead of|rather than|following|after|before|when|which)\s+/iu
const TRANSPORT_ACCESSORY = /\b(?:ticket|station|stop|schedule|timetable)\b/iu
const REFERRED_PURCHASE = /^(?:(?:them|the same ones)(?=\s|$)|a\s+(?:set|box|pair|pack)\s+of\s+\d+\s+for\s+[$€£]\d)/iu
const OWN_USAGE = new RegExp(String.raw`${PERSONAL_ACTION}(?:used|been using|am using|are using)\b`, 'iu')
const NAMED_PET = /\b(?:my|our|a)\s+(?:dog|puppy|cat|kitten|pet)(?:\s+(?:named|called)|,)?\s+(\p{Lu}[\p{L}'’-]+)/gu
const EN_TRIP_ACTION = new RegExp(PERSONAL_ACTION + String.raw`(?:(?:went|travell?ed)(?:\s+(?<party>solo|alone|by myself))?\s+to|(?:went on|took|made)\s+(?:an?|the|my|our)\s+(?<modifiers>(?:[a-z\d'-]+\s+){0,5}?)(?:trip|journey|vacation|holiday|visit)\s+to|visited)\s+`, 'iu')
const ZH_TRIP_ACTION = /我(?:们)?(?<party>独自|一个人|单独|(?:(?:和|跟|带)(?:(?:我|我们)的?)?(?:家人|爸妈|父母|父亲|母亲|孩子|兄弟|姐妹))(?:一起)?)?(?:已经|刚刚|刚|也)?(?:去过|去了|到过|到了)/u
const EN_TRIP_BOUNDARY = /^(?:$|[,.!?]|\s+(?:with|on|in|for|this|last|today|yesterday|alone|solo|by myself|(?:\d+|a|an|one)\s+(?:days?|weeks?|months?|years?))\b)/iu
const ZH_TRIP_BOUNDARY = /^(?:$|[。！，,；;!?]|旅游|旅行|度假|探亲|出差|玩|那天|独自|一个人)/u
const EN_TRIP_END = /[,;]|\b(?:and|but|because|while|who)\b/giu
const EN_EVENT_END = /[,;]|\b(?:and|but|because|while|who|when|where|which|before|after)\b/giu
const REPORTED_EVENT = /\b(?:said|told|thought|claimed|pretended|imagined|heard)\b|假想|转述|听说/iu
const EVENT_AS_SUBJECT = /^\s+(?:happened|occurred|took place|was (?:held|celebrated|completed|on)|started|finished)\b/iu
const ATTENDED_NAMED_EVENT = new RegExp(PERSONAL_ACTION +
  String.raw`(?:(?<returned>returned from|came back from|got back from)|attended|visited|joined|went to|was at|participated in|walked down the aisle(?: as an? [\p{L}-]+)? at)\s+(?:(?:a|an|the)\s+)?(?:annual\s+)?$`, 'iu')
const COMPLETED_EVENT_ACTION = String.raw`(?:did|finished|completed|attended|joined|went to|took part in|participated in|volunteered at|ran in|walked in)\s+(?:(?:a|an|the)\s+)?$`
const COMPLETED_QUOTED_EVENT = new RegExp(PERSONAL_ACTION + COMPLETED_EVENT_ACTION, 'iu')
const ANSWER_QUOTED_EVENT = new RegExp(PERSONAL_ACTION.replace('(?:I|we)', '(?:I|we|you)') + COMPLETED_EVENT_ACTION, 'iu')
const EVENT_DESCRIPTION = /^\s+(?:(?:\d+(?:\.\d+)?\s*(?:k|km|mi))\s+)?(?:event|walk|run|ride|race|marathon|fundraiser|fundraising drive|gala|cleanup|drive)\b/iu
const EVENT_NAME_END = /^(?:$|[.!?,;:"'’)]|\s+(?:on|at|in|today|yesterday|last|this|with|during|was|is|happened|occurred|took place|came|before|after|first|earlier|later)\b)/iu
const EXACT_EVENT_DAY_CLAIM = /^(?:\s+|(?:\s+(?:at|in|near|on)\s+[^\n,;.!?]{1,80})?\s*,\s*which\s+)(?:happened|occurred|took place|was(?: held| celebrated)?)(?:\s+(?:first|last))?,?\s+(?:on\s+)?/iu
const BOUNDED_VISIT_REFERENCE = /\b(?:(?:your|the)\s+)?(?:earlier|first)\s+(?:event|visit|tour)\b/giu
const BOUNDED_LATER_REFERENCE = /\b(?:(?:your|the)\s+)?(?:later|second)\s+(?:event|visit|tour|exhibit)\b/giu
const DAY_FIRST_ENGLISH_DATE = /^(?:the\s+)?(?:0?[1-9]|[12]\d|3[01])(?:st|nd|rd|th)?\s+(?:of\s+)?(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/iu
const ANCHORED_EVENT_DATE = new RegExp(
  String.raw`\b(?:(?<![\d.,+-])(?<count>\d{1,3}|(?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)[- ][a-z]+|[a-z]+)\s+(?<unit>days?|weeks?)\s+(?<direction>before|after)\s+|on\s+(?=Black Friday\b))(?:(?<holiday>Black Friday)(?:(?:\s*,\s*|\s+)(?<holidayYear>[12]\d{3}))?\b|${DATE.source})`, 'giu')
const QUALIFIED_OFFSET = /\b(?:about|around|roughly|approximately|nearly|almost|over|under|at least|at most|more than|less than|up to)\s*$/iu
const PURCHASE_DATE_LABEL = /^(?:the (?:day|date) )?(?<actor>I|we)\s+(?:buy|bought|purchase|purchased|paid for)\s+(?<item>.+)$/iu
const PURCHASE_DATE_ACTION = new RegExp('^' + PERSONAL_ACTION.replace('(?:I|we)', '(?<actor>I|we)') +
  String.raw`(?<action>bought|purchased|paid for|got)\s+(?:(?:my|our|an?|the)\s+)?`, 'iu')
const ZH_TRIP_END = /[，,；;]|后来|之后|随后|接着|然后|但是|因为/u
const FAMILY_MEMBER = String.raw`(?:(?:my|our|the)\s+)?(?:(?:older|younger)\s+)?(?:family|parents?|mother|father|siblings?|brothers?|sisters?|grandparents?|children|kids|spouse|wife|husband|aunt|uncle|cousin)\b`
const FAMILY_COMPANION = new RegExp(String.raw`\bwith\s+` + FAMILY_MEMBER, 'iu')
const FAMILY_LIST_ITEM = new RegExp(String.raw`^\s+` + FAMILY_MEMBER +
  String.raw`(?=\s*(?:[,.!?]|$)|\s+(?:and|on|in|last (?:week|month|year)|today|yesterday)\b)`, 'iu')

function englishDatedRemainder(tail, separators, familyList = false) {
  const dates = [...tail.matchAll(DATE)]
  for (const boundary of tail.matchAll(separators)) {
    const before = tail.slice(0, boundary.index)
    if (boundary[0] === ',' && dates.some(date => date.index <= boundary.index && boundary.index < date.index + date[0].length)) continue
    if (familyList && boundary[0].toLowerCase() === 'and' && FAMILY_COMPANION.test(before) &&
        FAMILY_LIST_ITEM.test(tail.slice(boundary.index + boundary[0].length))) continue
    return before
  }
  return tail
}

function englishEventName(label, answer = false) {
  const words = label.replace(/^(?:an?|the)\s+/iu, '').trim().split(/\s+/u)
  const literal = word => word.replace(/[.*+?^$(){}|[\]\\]/gu, '\\$&').replace(/['’]/gu, "['’]")
  const name = words.map((word, index) => answer && index === 0 && /^(?:my|our|your)$/iu.test(word)
    ? "(?:my|our|your|the\\s+user['’]s)" : literal(word)).join('\\s+')
  return new RegExp(String.raw`(?<![\p{L}\p{N}])` + name + String.raw`(?![\p{L}\p{N}])`, 'giu')
}

function englishEventOccurrence(piece, name, direct = false) {
  for (const mention of piece.matchAll(name)) {
    const lead = piece.slice(0, mention.index)
    if (REPORTED_EVENT.test(lead)) continue
    const tail = englishDatedRemainder(piece.slice(mention.index + mention[0].length), EN_EVENT_END)
    const attendance = ATTENDED_NAMED_EVENT.exec(lead)
    const eventSubject = EVENT_AS_SUBJECT.test(tail) && (!direct || /^(?:the\s+)?$/iu.test(lead))
    if (!eventSubject && (!attendance || (direct && attendance.index !== 0) || !EVENT_NAME_END.test(tail))) continue
    return { quote: (lead + mention[0] + tail).trim(), dated: lead + 'the event' + tail,
      returned: Boolean(attendance?.groups.returned) }
  }
  return null
}

function taskOccurrence(piece, task, actor, answer = false) {
  const verbs = TASK_VERBS.get(task.verb)
  if (!verbs || typeof task.object !== 'string') return null
  const subject = PERSONAL_ACTION.replace('(?:I|we)', answer ? '(?:I|we|you)' : actor)
  const modifier = answer ? String.raw`(?:(?:first|last|then)\s+)?` : ''
  const action = new RegExp(subject + modifier + `(?:${verbs})\\s+`, 'iu').exec(piece)
  if (!action || REPORTED_EVENT.test(piece.slice(0, action.index))) return null
  const start = action.index + action[0].length
  const tail = englishDatedRemainder(piece.slice(start), EN_EVENT_END).split(/\s+for\s+(?:an?|the|my|our)\s+/iu, 1)[0]
  const object = tail.split(OBJECT_BOUNDARY)[0]
  if (!namesEvent(object, calendarEventTerms(task.object))) return null
  return (piece.slice(0, start) + tail).trim()
}

// A date belongs to the traveller's asserted destination, within this clause.
// Keep the "like when" introduction when it supplies the solo condition.
function tripEventClause(piece, trip, language) {
  const english = language === 'en'
  const action = (english ? EN_TRIP_ACTION : ZH_TRIP_ACTION).exec(piece)
  if (!action) return null
  const start = action.index + action[0].length
  const destination = trip.destination
  const target = piece.slice(start, start + destination.length).normalize('NFKC')
  const tail = piece.slice(start + destination.length)
  if (target.toLowerCase() !== destination.toLowerCase() || !(english ? EN_TRIP_BOUNDARY : ZH_TRIP_BOUNDARY).test(tail)) return null
  const remainder = english ? englishDatedRemainder(tail, EN_TRIP_END, true) : tail.split(ZH_TRIP_END, 1)[0]
  const lead = piece.slice(0, action.index)
  if (REPORTED_EVENT.test(lead)) return null
  const attributes = (action.groups.party ?? '') + ' ' + (action.groups.modifiers ?? '')
  const solo = english
    ? /\b(?:solo|alone|by myself)\b/iu.test(attributes + ' ' + remainder) || /\btravell?ing solo(?: before)?,?\s+like when\s*$/iu.test(lead)
    : /独自|一个人|单独/u.test(attributes + remainder)
  const family = english ? /\bfamily\b/iu.test(attributes) || FAMILY_COMPANION.test(remainder) : /和|跟|带/u.test(attributes)
  if (trip.party === 'family' && (!family || solo) || trip.party === 'solo' &&
      (!solo || family || english && /\bwith\b/iu.test(remainder))) return null
  return (piece.slice(0, start + destination.length) + remainder).trim()
}

function eventOrderPieces(sentence) {
  const parts = sentence.split(ORDER_CLAUSE_BREAK)
  if (parts.length < 2) return parts
  const index = sentence.indexOf(parts[1], parts[0].length)
  if (index < 0 || !/^[,，]\s*$/u.test(sentence.slice(parts[0].length, index))) return parts
  const prefix = parts[0].replace(ORDER_PERIOD, '').replace(DATE, '').trim()
  if (prefix === parts[0].trim() || !/^(?:by the way,\s*)?(?:just|on|in|back in|在|于)?$/iu.test(prefix)) return parts
  return [sentence.slice(0, index + parts[1].length), ...parts.slice(2)]
}

function originalDateRefs(record, quote) {
  return (record.sourceRefs ?? []).filter(ref => ref.sourceId && ref.role === 'user' && ref.sourceKind === 'user' &&
    ref.excerpt?.includes(quote) && Number.isSafeInteger(ref.from) && ref.from >= 0 &&
    Number.isSafeInteger(ref.to) && ref.to - ref.from === ref.excerpt.length)
}

function orderDate(record, clause, quote, uncertainPurchase, { allowFuture = false, fixedWeekOffset = false } = {}) {
  const originals = originalDateRefs(record, quote)
  if (record.kind === 'source' && !originals.length) return null
  const today = unanimous(originals.map(sourceCalendarDay))
  const zone = unanimous(originals.map(ref => ref.timeZone ?? null))
  const periods = [...clause.matchAll(ORDER_PERIOD), ...(fixedWeekOffset ? clause.matchAll(CHINESE_DAY_OFFSET) : [])]
  const bounds = periods.map(match => {
    if (DATE_LIMIT.test(clause.slice(0, match.index))) return null
    const { period, hanCount, hanUnit, estimate } = match.groups
    const count = hanCount ?? match.groups.count
    const unit = hanUnit ? hanUnit === '天' ? 'day' : 'week' : match.groups.unit
    const number = /^(?:a|an)$/u.test(count?.toLowerCase()) ? 1 : readDayCount(count ?? '')
    const phrase = period ?? (Number.isSafeInteger(number) && number > 0 ? `${number} ${unit} ago` : '')
    const window = periodBounds(phrase, today)
    return window && { ...window, approximate: Boolean(estimate || unit && !/^days?$/iu.test(unit) &&
      !(fixedWeekOffset && /^weeks?$/iu.test(unit))) }
  })
  for (const match of clause.matchAll(DATE)) {
    if (periods.some(period => match.index >= period.index && match.index < period.index + period[0].length)) continue
    if (DATE_LIMIT.test(clause.slice(0, match.index))) { bounds.push(null); continue }
    if (match.groups.shortA && !/(?:\bon\s+|^\s*)$/iu.test(clause.slice(0, match.index))) continue
    const day = dateNumber(match, record, quote)
    bounds.push(Number.isSafeInteger(day) ? { from: day, to: day + 1 } : null)
  }
  if (!bounds.length) return null
  const first = bounds[0]
  if (!allowFuture && first && today !== null && first.from > today) return null
  if (!first || bounds.some(bound => bound?.from !== first.from || bound?.to !== first.to)) {
    return { quote, from: null, to: null, zone, approximate: true }
  }
  return { ...first, quote, zone, distance: today === null ? Infinity : today - (first.to - 1),
    approximate: uncertainPurchase || bounds.some(bound => bound.approximate) }
}

/** Day and position of date wording in one independently identified event clause. */
export function sourceEventDate(record, quote, { dated = quote, allowZonelessAbsolute = false } = {}) {
  const marked = quote.replace(ORDER_PERIOD, '\u0000').replace(CHINESE_DAY_OFFSET, '\u0000').replace(DATE, '\u0000')
  const proof = orderDate(record, dated, quote, false, { fixedWeekOffset: true })
  let exactDate = Boolean(proof?.zone)
  if (proof && !exactDate && allowZonelessAbsolute) {
    const dates = [...dated.matchAll(DATE)]
    const explicit = dates.length === 1 && dates[0].groups
    const observed = originalDateRefs(record, quote).map(ref => sourceEventTime(ref.eventTime) ?? sourceEventTime(ref.at))
    // A written year supplies the calendar label without using the client's
    // clock. The date still cannot be in the future in any supported offset.
    exactDate = Boolean(explicit && (explicit.isoYear || explicit.englishYear || explicit.hanYear) &&
      observed.length && observed.every(at => at !== undefined && proof.from <= Math.floor((at - 14 * 3600_000) / DAY)))
  }
  return { marked, day: proof?.to - proof?.from === 1 && !proof.approximate && exactDate ? proof.from : null,
    zone: proof?.zone ?? null }
}

/** Date identity for comparisons tied to exact user statements. */
export function originalCalendarPeriod(record, quote) {
  const proof = orderDate(record, quote, quote, false)
  return proof?.zone && !proof.approximate ? calendarOrderDateKey(proof) : null
}

export function calendarOccurrenceBounds(record, quote, { dated = quote, returned = false } = {}) {
  const originals = originalDateRefs(record, quote)
  if (originals.length === 0) return null
  const day = unanimous(originals.map(sourceCalendarDay))
  const bound = orderDate(record, dated, quote, false, { allowFuture: true })
  if (day !== null && Number.isSafeInteger(bound?.from) && bound.from > day) return null
  if (bound && !bound.approximate && !returned) return bound
  const to = !bound?.approximate && Number.isSafeInteger(bound?.to) ? bound.to : day === null ? null : day + 1
  return { from: null, to, zone: unanimous(originals.map(ref => ref.timeZone ?? null)), quote }
}

export function calendarLookbackStart(reference, count, unit) {
  const day = periodBounds(count + ' ' + unit + ' ago', sourceCalendarDay(reference))?.from
  return Number.isSafeInteger(day) ? day : null
}

export function attendanceWindow(reference, window) {
  const today = sourceCalendarDay(reference)
  if (!window) return { from: null, to: today === null ? null : today + 1, zone: reference.timeZone }
  if (today === null) return null
  if (window.previous) {
    const bounds = periodBounds(window.previous, today)
    return bounds && { ...bounds, zone: reference.timeZone }
  }
  const from = calendarLookbackStart(reference, window.count, window.unit)
  return from === null ? null : { from, to: today + 1, zone: reference.timeZone }
}

export function calendarOrderClauses(text) {
  return sourceSentences(text).flatMap(eventOrderPieces)
}

export function calendarPrecedes(earlier, later) {
  const margin = earlier.zone && earlier.zone === later.zone ? 0 : 2
  return Number.isSafeInteger(earlier.to) && Number.isSafeInteger(later.from) && earlier.to + margin <= later.from
}

function localDayBoundary(day, timeZone) {
  const nominal = day * DAY
  if (timeZone === 'UTC') return nominal
  try {
    const formatter = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
    const offset = at => {
      const name = formatter.formatToParts(at).find(part => part.type === 'timeZoneName')?.value
      if (name === 'GMT') return 0
      const match = /^GMT([+-])(\d{2}):(\d{2})(?::(\d{2}))?$/u.exec(name ?? '')
      return match ? (match[1] === '-' ? -1 : 1) * (+match[2] * 3600 + +match[3] * 60 + +(match[4] ?? 0)) * 1000 : null
    }
    const offsets = [...new Set([nominal - DAY, nominal, nominal + DAY].map(offset))]
    const candidates = offsets.filter(value => value !== null && offset(nominal - value) === value)
    return candidates.length === 1 ? nominal - candidates[0] : null
  } catch { return null }
}

export function calendarPrecedesAtLocalBoundary(earlier, later) {
  if (calendarPrecedes(earlier, later)) return true
  if (!earlier.zone || !later.zone || earlier.zone === later.zone ||
      !Number.isSafeInteger(earlier.to) || !Number.isSafeInteger(later.from) || earlier.to >= later.from + 2) return false
  const end = localDayBoundary(earlier.to, earlier.zone)
  const start = localDayBoundary(later.from, later.zone)
  return end !== null && start !== null && end <= start
}

export function matchesTimelineDate(text, { from, to }, required) {
  const dates = [...text.matchAll(DATE)]
  if (!dates.length) return !required && text.search(ORDER_PERIOD) < 0
  if (to - from !== 1) return false
  const eventTime = from * DAY
  const record = { sourceRefs: [{ at: eventTime, eventTime, timeZone: 'UTC', excerpt: text }] }
  return dates.every(date => !date.groups.relative && dateNumber(date, record, text) === from)
}

export function calendarOrderEvidence(record, comparison, label, terms = calendarEventTerms(label)) {
  const text = String(record?.recallQuote ?? record?.content ?? '')
  const other = comparison.events.find(event => event !== label)
  if (!other || !terms.length || ['tool', 'assistant'].includes(record?.evidenceRole)) return null
  const otherTerms = calendarEventTerms(other)
  const trip = comparison.trips?.[comparison.events.indexOf(label)]
  const task = comparison.tasks?.[comparison.events.indexOf(label)]
  const namedEvent = comparison.action === 'occur' && comparison.language === 'en' ? englishEventName(label) : null
  const proofs = new Map(), previous = []
  let offset = 0
  for (const sentence of sourceSentences(text)) {
    const start = text.indexOf(sentence, offset)
    offset = start + sentence.length
    const pieces = trip || namedEvent || task ? eventOrderPieces(sentence) : sentence.split(ORDER_CLAUSE_BREAK)
    if (!/[?？]/u.test(sentence)) for (const [index, piece] of pieces.entries()) {
      const occurrence = namedEvent ? englishEventOccurrence(piece, namedEvent) : null
      const clause = namedEvent ? occurrence?.quote : trip ? tripEventClause(piece, trip, comparison.language)
        : task ? taskOccurrence(piece, task, comparison.actor) : piece.trim()
      if (!clause || UNCERTAIN_DATE.test(clause) || NON_OCCURRENCE.test(clause)) continue
      let quote = clause
      let uncertainPurchase = false
      if (!trip && !namedEvent && !task) {
        const action = ORDER_ACTIONS[comparison.action].exec(clause)
        if (!action) continue
        const object = clause.slice(action.index + action[0].length)
        const target = comparison.action === 'occur' ? clause : object.split(OBJECT_BOUNDARY)[0]
        if (namesEvent(target, otherTerms)) continue
        if (comparison.action === 'use' && TRANSPORT_ACCESSORY.test(target)) continue
        const linked = !namesEvent(target, terms)
        if (linked) {
          if (comparison.action !== 'purchase' || index !== 0 || !REFERRED_PURCHASE.test(object)) continue
          const referent = previous.at(-1)
          const [item, companion] = label.split(/\s+for\s+/iu)
          if (!referent || !OWN_USAGE.test(referent.text) || !namesEvent(referent.text, calendarEventTerms(item)) ||
              /[?？]/u.test(referent.text) || UNCERTAIN_DATE.test(referent.text) || NON_OCCURRENCE.test(referent.text)) continue
          const context = namesEvent(referent.text, terms) ? referent : previous.at(-2)
          if (!context) continue
          if (context !== referent && (!companion || [...context.text.matchAll(NAMED_PET)].filter(match =>
            match[1].toLowerCase() === companion.toLowerCase()).length !== 1)) continue
          quote = text.slice(context.start, start + piece.length).trim()
          if (!namesEvent(quote, terms) || namesEvent(quote, otherTerms)) continue
        }
        uncertainPurchase = linked || comparison.action === 'purchase' && /\bgot\s*$/iu.test(action[0]) &&
          !/\bfor\s+[$€£]\d/iu.test(object)
      }
      const proof = orderDate(record, occurrence?.dated ?? clause, quote, uncertainPurchase)
      if (!proof) continue
      // Returning is later than the event, even when the event day is unknown.
      if (occurrence?.returned && Number.isSafeInteger(proof.to)) proof.from = null
      const key = calendarOrderDateKey(proof)
      const previousProof = proofs.get(key)
      if (!previousProof || preferCalendarOrderEvidence(proof, previousProof)) proofs.set(key, proof)
    }
    previous.push({ start, text: sentence })
  }
  if (proofs.size === 1) return proofs.values().next().value
  // Two distinct dates in an original are evidence of uncertainty.
  return proofs.size > 1 && originalDateRefs(record, text).length
    ? { quote: text, from: null, to: null, zone: null, approximate: true } : null
}

export function calendarOrderDateKey({ from, to, zone, approximate }) {
  return JSON.stringify([from, to, zone, approximate])
}

export function preferCalendarOrderEvidence(left, right) {
  const gap = proof => proof.distance ?? Infinity
  return gap(left) < gap(right) || gap(left) === gap(right) && left.quote.length < right.quote.length
}

function dayLabel(day) {
  return new Date(day * DAY).toISOString().slice(0, 10)
}

export function calendarOrderPeriod(proof) {
  if (!proof || proof.approximate) return undefined
  if (proof.from === null) return Number.isSafeInteger(proof.to) ? '≤ ' + dayLabel(proof.to - 1) : undefined
  return proof.to - proof.from === 1 ? dayLabel(proof.from) : dayLabel(proof.from) + '–' + dayLabel(proof.to - 1)
}

function visitEvidence(record, { owner, place, alias }) {
  const name = englishEventName(place)
  const actor = PERSONAL_ACTION.replace('(?:I|we)', owner === 'my' ? 'I' : 'we')
  const action = new RegExp('^' + actor + '(?:visited|went to)\\s+(?:the\\s+)?$', 'iu')
  const returned = new RegExp('^' + actor +
    '(?:returned from|came back from|got back from)\\s+(?:(?:a|an|the)\\s+)?(?:visit to|(?:guided\\s+)?tour (?:of|at))\\s+(?:the\\s+)?$', 'iu')
  const possessive = new RegExp('^' + owner + '\\s+visit\\s+to\\s+(?:the\\s+)?$', 'iu')
  const optionalAlias = alias && new RegExp('^\\s+\\(' + alias + '\\)', 'iu')
  const text = String(record?.recallQuote ?? record?.content ?? '')
  const proofs = new Map()
  for (const sentence of sourceSentences(text)) {
    if (/[?？]/u.test(sentence)) continue
    for (const piece of eventOrderPieces(sentence)) {
      for (const mention of piece.matchAll(name)) {
        const rawTail = piece.slice(mention.index + mention[0].length)
        const suffix = optionalAlias?.exec(rawTail)?.[0] ?? ''
        const tail = englishDatedRemainder(rawTail.slice(suffix.length), EN_EVENT_END)
        const lead = piece.slice(0, mention.index).trimStart()
        const isReturn = returned.test(lead)
        const nominal = possessive.test(lead) && /^\s+(?:was|happened|occurred|took place)\s+on\b/iu.test(tail)
        if (!isReturn && !nominal && !action.test(lead) ||
            !/^(?:$|[.!?;,]|\s+(?:on|today|yesterday|last|this|focused on|with|was|happened|occurred|took place)\b)/iu.test(tail)) continue
        const quote = (lead + mention[0] + suffix + tail).trim()
        if (UNCERTAIN_DATE.test(quote) || NON_OCCURRENCE.test(quote) || /n['’]t\b|\bnever\b/iu.test(quote)) continue
        const dated = lead + 'the place' + tail
        const range = isReturn ? calendarOccurrenceBounds(record, quote, { dated, returned: true })
          : orderDate(record, dated, quote, false)
        if (range?.approximate) continue
        const relative = [...dated.matchAll(DATE)].some(date => date.groups.relative)
        const proof = isReturn && range?.zone && Number.isSafeInteger(range.to)
          ? { latestDay: range.to - 1, zone: range.zone, quote }
          : !isReturn && range?.to - range?.from === 1
            ? { days: [range.from], day: range.from, zone: range.zone, quote, ...(relative ? { relative } : {}) } : null
        if (proof) proofs.set(calendarDateKey(proof), proof)
      }
    }
  }
  return proofs.size === 1 ? proofs.values().next().value : null
}

export function agreedCalendarDate(proofs) {
  const available = proofs.filter(Boolean)
  const day = available[0]?.day
  return Number.isSafeInteger(day) && available.every(proof => proof.day === day) ? dayLabel(day) : null
}

export function calendarDateKey(proof) {
  if (proof.anchor) return JSON.stringify([proof.anchor, proof.zone])
  return proof.days ? proof.days.join(',') : 'latest:' + proof.latestDay + ':' + proof.zone
}

function anchoredEventDates(record, label, text) {
  const proofs = new Map()
  if (text.search(ANCHORED_EVENT_DATE) < 0) return proofs
  const purchase = PURCHASE_DATE_LABEL.exec(label)?.groups
  const name = englishEventName(purchase?.item ?? (quotedEventTitle(label) ?? label))
  for (const sentence of sourceSentences(text)) {
    if (/[?？]/u.test(sentence)) continue
    let position = 0
    for (const clause of eventOrderPieces(sentence)) {
      position = sentence.indexOf(clause, position) + clause.length
      const assertion = sentence.slice(0, position)
      if (UNCERTAIN_DATE.test(assertion) || NON_OCCURRENCE.test(assertion) ||
          REPORTED_EVENT.test(assertion) || /n['’]t\b|\bnever\b/iu.test(assertion)) continue
      for (const match of clause.matchAll(ANCHORED_EVENT_DATE)) {
        const head = clause.slice(0, match.index).trim()
        const end = match.index + match[0].length
        if (QUALIFIED_OFFSET.test(head) || !/^(?:\s*$|[.,;!?]|\s+(?:and|but|so|where|which)\b)/iu.test(clause.slice(end))) continue
        const statement = head.replace(/^(?:by the way|speaking of which|also),\s+/iu, '')
        if (purchase) {
          const action = PURCHASE_DATE_ACTION.exec(statement)
          if (!action || action.groups.actor.toLowerCase() !== purchase.actor.toLowerCase()) continue
          const object = statement.slice(action[0].length)
          const item = [...object.matchAll(name)].find(mention => /^(?:new\s+)?$/iu.test(object.slice(0, mention.index)))
          if (!item) continue
          const tail = object.slice(item.index + item[0].length)
          if (!/^(?:\s*$|\s+(?:at|from|for)\b)/iu.test(tail) || ANOTHER_PAST_ACTION.test(tail)) continue
          if (/^(?:got|paid for)$/iu.test(action.groups.action) && /\b(?:as a gift|rental|leased|on loan|borrowed)\b/iu.test(tail)) continue
          if (/^got$/iu.test(action.groups.action) &&
              !/\bat\s+(?:(?:a|the)\s+)?(?:discounted|reduced|sale)\s+price of\s+\p{Sc}\s*[1-9]\d*/iu.test(tail)) continue
        } else {
          const occurrence = englishEventOccurrence(statement, name, true)
          if (!occurrence || occurrence.returned || occurrence.quote !== statement) continue
        }
        const quote = clause.slice(0, end).trim()
        const refs = originalDateRefs(record, quote)
        const observed = unanimous(refs.map(sourceCalendarDay))
        if (observed === null) continue
        const { count, unit, direction, holiday, holidayYear } = match.groups
        const offset = !count ? 0 : /^(?:a|an)$/iu.test(count) ? 1 : readDayCount(count)
        if (!Number.isSafeInteger(offset) || offset < 0) continue
        const days = offset * (/^week/iu.test(unit ?? '') ? 7 : 1) * (direction?.toLowerCase() === 'before' ? -1 : 1)
        const zone = unanimous(refs.map(ref => ref.timeZone))
        const sourceDate = new Date(observed * DAY)
        let anchor
        if (holiday) {
          if (!holidayYear && (sourceDate.getUTCMonth() !== 11 || !zone ||
              /\b(?:last|previous|next)\s+year\b|\byears?\s+ago\b|\b(?:in|of)\s+[12]\d{3}\b/iu.test(head))) continue
          const year = Number(holidayYear ?? sourceDate.getUTCFullYear())
          if (year < 1942) continue
          // Black Friday is the day after U.S. Thanksgiving (the fourth Thursday in November).
          const first = dayNumber(year, 11, 1)
          anchor = first + (4 - new Date(first * DAY).getUTCDay() + 7) % 7 + 22
        } else anchor = dateNumber(match, record, quote)
        const day = anchor + days
        if (!Number.isSafeInteger(anchor) || !Number.isSafeInteger(day) || day > observed) continue
        const proof = holiday && !holidayYear
          ? { anchor: { name: 'Black Friday', year: sourceDate.getUTCFullYear(), offset: days }, zone, quote }
          : { day, days: [day], quote, ...(zone ? { zone } : {}), relative: true, anchored: true }
        proofs.set(calendarDateKey(proof), proof)
      }
    }
  }
  return proofs
}

function namedDateEvidence(record, title, attendance = COMPLETED_QUOTED_EVENT, proofs = new Map()) {
  const name = englishEventName(title)
  const text = String(record?.recallQuote ?? record?.content ?? '')
  for (const sentence of sourceSentences(text)) {
    if (/[?？]/u.test(sentence)) continue
    for (const piece of eventOrderPieces(sentence)) {
      for (const mention of piece.matchAll(name)) {
        const lead = piece.slice(0, mention.index)
        const following = piece.slice(mention.index + mention[0].length)
        const openQuote = /["'“‘]$/u.test(lead)
        const closeQuote = /^["'”’]/u.test(following)
        if (openQuote !== closeQuote || REPORTED_EVENT.test(lead)) continue
        const prefix = openQuote ? lead.slice(0, -1) : lead
        const tail = englishDatedRemainder(following, EN_EVENT_END)
        const afterName = closeQuote ? tail.slice(1) : tail
        const datePart = afterName.replace(EVENT_DESCRIPTION, '')
        const subject = /^\s*(?:the\s+)?$/iu.test(prefix) && EVENT_AS_SUBJECT.test(datePart)
        if (!(subject || attendance.test(prefix)) || !EVENT_NAME_END.test(datePart)) continue
        const quote = (lead + mention[0] + tail).trim()
        if (UNCERTAIN_DATE.test(quote) || NON_OCCURRENCE.test(quote) || /n['’]t\b|\bnever\b/iu.test(quote)) continue
        const dated = prefix + 'the event' + datePart
        const span = orderDate(record, dated, quote, false)
        if (span?.approximate || span?.to - span?.from !== 1) continue
        const relative = [...dated.matchAll(DATE)].some(date => date.groups.relative)
        const proof = { day: span.from, days: [span.from], zone: span.zone, quote, ...(relative ? { relative } : {}) }
        const key = calendarDateKey(proof)
        const prior = proofs.get(key)
        if (!prior || quote.length < prior.quote.length) proofs.set(key, proof)
      }
    }
  }
  return proofs.size === 1 ? proofs.values().next().value : null
}

function isDatedOccurrence(quote, label) {
  // The second event must have happened. A planned date cannot anchor a lower bound.
  if (visitPlace(label) || quotedEventTitle(label)) return true
  if (UNCERTAIN_DATE.test(quote) || NON_OCCURRENCE.test(quote) || /\b(?:never|will|shall)\b|n['’]t\b/iu.test(quote)) return false
  const stripQuotes = value => value.replace(/["“”'‘’]/gu, '')
  const occurrence = englishEventOccurrence(stripQuotes(quote), englishEventName(stripQuotes(label)))
  return Boolean(occurrence && !occurrence.returned)
}

/** Return the exact clause tying one event to one unambiguous calendar date. */
export function calendarEventEvidence(record, label, terms = calendarEventTerms(label), { participant, allowReturnBounds, personalSince } = {}) {
  const visit = allowReturnBounds && visitPlace(label)
  if (visit) return visitEvidence(record, visit)
  const text = String(record?.recallQuote ?? record?.content ?? '')
  const proofs = allowReturnBounds && !participant && !personalSince ? anchoredEventDates(record, label, text) : new Map()
  const namedEvent = allowReturnBounds && quotedEventTitle(label)
  if (namedEvent) return namedDateEvidence(record, namedEvent, COMPLETED_QUOTED_EVENT, proofs)
  const dates = [...text.matchAll(DATE)]
  if (dates.length === 0 || (participant ? mentionsAnotherParticipant(text, participant) : !namesEvent(text, terms))) {
    return proofs.size === 1 ? proofs.values().next().value : null
  }
  const personalAction = PERSONAL_DAY_LABEL.test(label) ? personalDayAction(label.replace(PERSONAL_DAY_LABEL, '')) : null
  const requestedYear = label.normalize('NFKC').match(YEAR)?.[1]
  // A name set off by commas is part of the recipient in "I gave my neighbor, Ms. Lee, a book".
  const recipientCommas = personalAction === 'gave'
    ? new Set([...text.matchAll(NAMED_GIFT_RECIPIENT)].flatMap(match =>
      [match.index + match[0].indexOf(','), match.index + match[0].length - 1]))
    : new Set()
  const boundaries = [...sourceSentenceBreaks(text), ...text.matchAll(/[，,；;]/gu)]
    .filter(boundary => !recipientCommas.has(boundary.index) &&
      !dates.some(date => boundary.index >= date.index && boundary.index < date.index + date[0].length))
    .sort((left, right) => left.index - right.index)
  const clauses = []
  let start = 0, sentenceStart = 0
  for (const end of [...boundaries.map(value => value.index), text.length]) {
    clauses.push({ start, end, text: text.slice(start, end) })
    if (/[?？]/u.test(text[end] ?? '')) {
      for (const clause of clauses.slice(sentenceStart)) clause.question = true
    }
    if (!/[,，]/u.test(text[end] ?? '')) sentenceStart = clauses.length
    start = end + 1
  }
  for (let index = 0; index < clauses.length; index += 1) {
    const clause = clauses[index]
    const references = participant ? [...clause.text.matchAll(WORK_WITH_PRONOUN)] : []
    if (participant && references.length !== 1) continue
    const matchingText = participant ? clause.text.replace(WORK_WITH_PRONOUN, match => match.replace(/\b(?:him|her)$/iu, participant)) : clause.text
    if (clause.question || !namesEvent(matchingText, terms) || !personalSince && UNCERTAIN_DATE.test(clause.text)) continue
    let applicable = dates.filter(date => date.index >= clause.start && date.index < clause.end &&
      !DATE_LIMIT.test(text.slice(clause.start, date.index)))
    let quote = clause.text.trim(), quoteStart = clause.start, quoteEnd = clause.end
    if (personalAction) {
      const firstDate = applicable[0]
      const leading = firstDate && /^\s*(?:on\s+)?$/iu.test(text.slice(clause.start, firstDate.index)) ? firstDate : null
      const firstAction = leading ? leading.index + leading[0].length : clause.start
      let assertion = text.slice(firstAction, clause.end)
      if (personalSince) {
        const context = [...assertion.matchAll(/\bnow that\s+(?=(?:I|we)\s+)/giu)].at(-1)
        const actionStart = context ? firstAction + context.index + context[0].length : firstAction
        assertion = englishDatedRemainder(text.slice(actionStart, clause.end), EN_EVENT_END)
        const labelAssertion = label.replace(PERSONAL_DAY_LABEL, '')
        const actor = labelAssertion.match(/^(?:I|we)\b/iu)?.[0].toLowerCase()
        const assertedActor = assertion.trim().match(/^(?:I|we)\b/iu)?.[0].toLowerCase()
        const requested = personalEventObject(labelAssertion)
        const object = personalEventObject(assertion)
        const named = requested ? englishEventName(requested).exec(object) : null
        if (record.kind !== 'source' || actor !== assertedActor || UNCERTAIN_DATE.test(assertion) || NON_OCCURRENCE.test(assertion) ||
            requested && (named?.index !== 0 || !EVENT_NAME_END.test(object.slice(named[0].length)))) continue
        quoteStart = context ? actionStart : clause.start
        quoteEnd = actionStart + assertion.length
        quote = text.slice(quoteStart, quoteEnd).trim()
        applicable = applicable.filter(date => date.index >= quoteStart && date.index + date[0].length <= quoteEnd)
      }
      if (personalDayAction(assertion) !== personalAction) continue
    }
    if (allowReturnBounds && index > 0 && /[,，]/u.test(text[clauses[index - 1].end])) {
      // Keep the first-person attendance assertion without its dependent lead-in.
      quote = quote.replace(/^which\s+is\s+why\s+(?=(?:I|we)\s+attended\b)/iu, '')
    }
    const prior = clauses[index - 1]
    if (applicable.length === 0 && quoteStart === clause.start && prior && /[,，]/u.test(text[prior.end])) {
      const leading = dates.find(date => date.index >= prior.start && date.index < prior.end)
      if (leading && /^(?:on|于|在)?\s*$/iu.test(prior.text.replace(leading[0], '').trim())) {
        applicable = [leading]
        quoteStart = prior.start
        quote = text.slice(prior.start, quoteEnd).trim()
      }
    }
    for (const date of applicable) {
      if (date.groups.shortA && (!/(?:\bon\s+|^\s*)$/iu.test(text.slice(quoteStart, date.index)) ||
          /^\s*of\b/iu.test(text.slice(date.index + date[0].length)))) continue
      if (personalAction && date.groups.relative && ANOTHER_PAST_ACTION.test(text.slice(clause.start, date.index))) continue
      const statedAt = personalSince ? unanimous(originalDateRefs(record, quote).map(sourceCalendarDay)) : null
      const days = [...new Set([dateNumber(date, record, quote)].flat().filter(day => Number.isSafeInteger(day) &&
        (statedAt === null || day <= statedAt) &&
        (!requestedYear || new Date(day * DAY).getUTCFullYear() === Number(requestedYear))))].sort((a, b) => a - b)
      if (!days.length) continue
      const key = days.join(',')
      if (!proofs.has(key) || quote.length < proofs.get(key).quote.length) {
        const zone = unanimous(originalDateRefs(record, quote).map(ref => sourceCalendarDay(ref) === null ? null : ref.timeZone))
        proofs.set(key, { day: days.length === 1 ? days[0] : null, days, quote, ...(zone ? { zone } : {}),
          ...(date.groups.relative ? { relative: true } : {}) })
      }
    }
  }
  return proofs.size === 1 ? proofs.values().next().value : null
}

/** Use both sets of delivered and verified evidence. */
export function calendarInterval(comparison, groups) {
  return comparison ? calendarIntervalFromProofs(comparison, groups.map((records, index) =>
    records.map(record => comparison.order ? calendarOrderEvidence(record, comparison, comparison.events[index])
      : calendarEventEvidence(record, comparison.events[index], undefined,
        { allowReturnBounds: true, personalSince: comparison.personalSince })))) : null
}

export function calendarIntervalFromProofs(comparison, groups) {
  if (groups.length !== 2) return null
  if (comparison.order) {
    const dates = groups.map(proofs => [...new Map(proofs.filter(Boolean).map(proof => [calendarOrderDateKey(proof), proof])).values()])
    if (dates.some(values => values.length !== 1 || values[0].approximate)) return null
    const [[first], [second]] = dates
    const earliest = calendarPrecedes(first, second) ? 0 : calendarPrecedes(second, first) ? 1 : null
    return earliest === null ? null : { order: comparison.order, events: comparison.events, language: comparison.language,
      ...(comparison.action === 'occur' && comparison.language === 'en'
        ? { action: 'occur', boundedDates: [first.from === null, second.from === null] } : {}),
      ...(comparison.trips ? { tripDestinations: comparison.trips.map(trip => trip.destination) } : {}),
      ...(comparison.tasks ? { tasks: comparison.tasks } : {}),
      winner: comparison.order === 'first' ? earliest : 1 - earliest }
  }
  const distinct = groups.map(proofs => new Map(proofs.filter(Boolean).map(proof => [calendarDateKey(proof), proof])))
  if (distinct.some(group => group.size !== 1)) return null
  const agreed = distinct.map(group => group.values().next().value)
  if (agreed.some(proof => proof.anchor)) {
    const [before, after] = agreed
    if (!before.anchor || !after.anchor || before.anchor.name !== after.anchor.name ||
        before.anchor.year !== after.anchor.year || before.zone !== after.zone) return null
    const difference = after.anchor.offset - before.anchor.offset
    if (comparison.ordered && difference < 0) return null
    return { events: difference < 0 ? [comparison.events[1], comparison.events[0]] : comparison.events,
      days: Math.abs(difference), anchor: { name: before.anchor.name, year: before.anchor.year } }
  }
  const bounded = agreed.findIndex(proof => Number.isSafeInteger(proof.latestDay))
  if (bounded !== -1) {
    if (comparison.ordered && bounded !== 0) return null
    const earlier = agreed[bounded], later = agreed[1 - bounded]
    const laterEvent = comparison.events[1 - bounded]
    if (later.days?.length !== 1 || !earlier.zone || earlier.zone !== later.zone || later.day <= earlier.latestDay ||
        !isDatedOccurrence(later.quote, laterEvent)) return null
    return { events: [comparison.events[bounded], laterEvent],
      latestEarlierDate: dayLabel(earlier.latestDay), laterDate: dayLabel(later.day), minimumDays: later.day - earlier.latestDay }
  }
  const choices = agreed.map(proof => proof.days)
  const possible = choices[0].flatMap(from => choices[1].filter(to => !comparison.ordered || to >= from).map(to => [from, to]))
  if (possible.length !== 1) return null
  const days = possible[0]
  const difference = days[1] - days[0]
  const order = difference < 0 ? [1, 0] : [0, 1]
  return { events: order.map(index => comparison.events[index]), dates: order.map(index => dayLabel(days[index])),
    days: Math.abs(difference), ...(comparison.unit ? { unit: comparison.unit } : {}),
    ...(comparison.personalSince ? { personalSince: true } : {}),
    ...(agreed.some(proof => proof.anchored) ? { anchored: true } : {}) }
}

export function formatCalendarInterval(value) {
  if (value.order && value.language === 'en') {
    if (value.action === 'occur') {
      const first = value.order === 'first' ? value.winner : 1 - value.winner
      const [earliest, latest] = [value.events[first], value.events[1 - first]]
      const requested = value.order === 'first' ? 'First event' : 'Most recent event'
      return `- [Verified event order] ${earliest} happened before ${latest}. ${requested}: ${value.events[value.winner]}.`
    }
    return `- [Verified event order] ${value.order === 'first' ? 'First' : 'Most recent'}: ${value.events[value.winner]}.`
  }
  if (value.order && value.tripDestinations) {
    const first = value.order === 'first' ? value.winner : 1 - value.winner
    return '- [先后核对] 先' + value.events[first] + '，后' + value.events[1 - first] + '。'
  }
  if (value.order) return `- [先后核对] ${value.order === 'first' ? '最早' : '最近'}：${value.events[value.winner]}。`
  if (value.minimumDays) return `- [Verified date range] At least ${value.minimumDays} days elapsed. The exact number is unknown. The earlier event was on or before ${value.latestEarlierDate}. The later event was on ${value.laterDate}.`
  if (value.anchor) {
    const [earlier, later] = value.events.map(event => {
      const item = PURCHASE_DATE_LABEL.exec(event)?.groups.item
      return item ? 'the purchase of ' + item : event
    })
    const interval = value.days === 0 ? `${earlier} and ${later} happened on the same day.`
      : `${earlier} was ${value.days} days before ${later}.`
    return `- [Verified date interval] Both originals refer to ${value.anchor.name} in ${value.anchor.year}. ${interval}`
  }
  if (value.unit === 'weeks') {
    const weeks = Math.floor(value.days / 7)
    const remainder = value.days % 7
    const duration = weeks + (weeks === 1 ? ' week' : ' weeks') +
      (remainder ? ' and ' + remainder + (remainder === 1 ? ' day' : ' days') : '')
    return `- [Verified date interval] ${value.dates[1]} minus ${value.dates[0]} equals ${duration} (${value.days} days).`
  }
  const dates = `- [日期差核对] ${value.dates[1]} − ${value.dates[0]} = ${value.days} 天。`
  return value.anchored && value.days > 0
    ? dates + ` Earlier event: ${value.events[0]}. Later event: ${value.events[1]}.` : dates
}

const ENGLISH_NUMBERS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
  'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen']
const ENGLISH_TENS = ['twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety']
const HAN_UNITS = '零一二三四五六七八九'
const DAY_COUNT = /(?<![\p{L}\p{N}.])(\d+|(?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)[- ][a-z]+|[a-z]+)\s+days?\b|(?<![\d.])(\d+|[零一二两三四五六七八九十]+)\s*[天日]/giu
const ENGLISH_COUNT = '(?:\\d+(?:\\.\\d+)?|a|' + ENGLISH_NUMBERS.join('|') + '|(?:' + ENGLISH_TENS.join('|') +
  ')(?:[- ](?:' + ENGLISH_NUMBERS.slice(1, 10).join('|') + '))?)'
const WEEK_COUNT = new RegExp('(?<![\\p{L}\\p{N}.])(' + ENGLISH_COUNT + ')\\s+weeks?\\b' +
  '(?:\\s+and\\s+(' + ENGLISH_COUNT + '|a few|a couple of|few|some|several)\\s+days?\\b)?', 'giu')
const WEEK_RANGE = new RegExp('(?<![\\p{L}\\p{N}.])(?:between\\s+' + ENGLISH_COUNT + '\\s+and\\s+|' +
  ENGLISH_COUNT + '\\s*(?:(?:or|to)\\b|[-–—])\\s*)' + ENGLISH_COUNT + '\\s+weeks?\\b', 'iu')

const DAYS_PER_WEEK = new RegExp(String.raw`(?<![\p{L}\p{N}.])(?:(?:exactly|about|around|roughly|approximately)\s+)?(?<count>${ENGLISH_COUNT})\s+days?\s+(?:in\s+(?:a|one|each)\s+week|per\s+week)\b`, 'giu')

export function readDayCount(text) {
  if (/^\d+$/u.test(text)) return Number(text)
  if (/^[零一二两三四五六七八九十]+$/u.test(text)) {
    const [tens, units] = text.replaceAll('两', '二').split('十')
    return units === undefined ? HAN_UNITS.indexOf(tens)
      : (tens ? HAN_UNITS.indexOf(tens) : 1) * 10 + (units ? HAN_UNITS.indexOf(units) : 0)
  }
  const [tens, units] = text.toLowerCase().split(/[- ]/u)
  const simple = ENGLISH_NUMBERS.indexOf(tens)
  if (simple >= 0 && units === undefined) return simple
  const ten = ENGLISH_TENS.indexOf(tens), one = units === undefined ? 0 : ENGLISH_NUMBERS.indexOf(units)
  return ten < 0 || one < 0 || one > 9 ? NaN : (ten + 2) * 10 + one
}

function statedCalendarDays(answer) {
  const text = String(answer ?? '').normalize('NFKC'), dates = [...text.matchAll(DATE)]
  const values = [...text.matchAll(DAY_COUNT)]
    .filter(match => !dates.some(date => match.index >= date.index && match.index < date.index + date[0].length))
    .map(match => readDayCount(match[1] ?? match[2]))
  if (/同一天|\b(?:on\s+)?the same day\b/iu.test(text)) values.push(0)
  return [...new Set(values.filter(value => Number.isSafeInteger(value) && value >= 0))]
}

function statedWeekIntervalDays(answer) {
  const text = String(answer ?? '').normalize('NFKC')
  if (WEEK_RANGE.test(text)) return []
  let incomplete = false
  const count = unit => unit.toLowerCase() === 'a' ? 1 : unit.includes('.') ? Number(unit) : readDayCount(unit)
  const translated = text.replace(WEEK_COUNT, (quote, weeks, remainder) => {
    const whole = count(weeks)
    if (Number.isNaN(whole)) return quote
    const days = whole * 7 + (remainder === undefined ? 0 : count(remainder))
    if (!Number.isSafeInteger(days)) {
      incomplete = true
      return quote
    }
    return days + ' days'
  })
  return incomplete ? [] : statedCalendarDays(translated)
}

function namesTripAnswer(text, trip, sameDestination) {
  if (!namesEvent(text, calendarEventTerms(trip.destination))) return false
  const solo = /\b(?:alone|solo|by myself|by yourself)\b|独自|单独|一个人/iu.test(text)
  const family = /\bfamily\b|和家人|跟家人|带家人|和爸妈|跟爸妈/iu.test(text) || FAMILY_COMPANION.test(text)
  if (!solo && !family) return !sameDestination
  return solo !== family && (!trip.party || (solo ? 'solo' : 'family') === trip.party)
}

function personalSinceAnswerDatesAgree(answer, dates, appearance) {
  const expected = dates.map(date => Date.parse(date + 'T00:00:00Z'))
  for (const sentence of sourceSentences(answer)) {
    const mentions = [...sentence.matchAll(DATE)].filter(date => !date.groups.relative)
    let start = 0
    for (const [index, date] of mentions.entries()) {
      const end = date.index + date[0].length
      const preceding = sentence.slice(start, date.index)
      const text = /^\s*(?:on\s+)?$/iu.test(preceding)
        ? sentence.slice(end, mentions[index + 1]?.index) : preceding
      const named = [0, 1].filter(event => appearance[event](text))
      const possible = named.length === 1 ? named : [0, 1]
      if (!possible.some(event => [dateNumber(date, { observedAt: expected[event] }, date[0])].flat()
        .includes(expected[event] / DAY))) return false
      start = end
    }
  }
  return true
}

function claimsExactNamedEventDay(sentence, eventName) {
  for (const mention of sentence.matchAll(eventName)) {
    const tail = sentence.slice(mention.index + mention[0].length)
    const claim = EXACT_EVENT_DAY_CLAIM.exec(tail)
    if (!claim) continue
    const date = tail.slice(claim[0].length)
    if (DAY_FIRST_ENGLISH_DATE.test(date) || [...date.matchAll(DATE)].some(match => match.index === 0)) return true
  }
  return false
}

function statedCalendarEventEvidence(content, label, observedAt, terms) {
  const title = quotedEventTitle(label)
  const record = { content, observedAt }
  return (title ? namedDateEvidence(record, title, ANSWER_QUOTED_EVENT) : null) ??
    calendarEventEvidence(record, label, terms)
}

export function matchesCalendarDateAnswer(answer, event, date) {
  const text = String(answer ?? '').normalize('NFKC')
  const observedAt = Date.parse(date + 'T00:00:00Z')
  if (!Number.isFinite(observedAt) || statedCalendarDays(text).length || /同一天|\bthe same day\b/iu.test(text)) return false
  const terms = calendarEventTerms(calendarDateSearchLabel(event) ?? event)
  const claimed = sourceSentences(text).map(content => statedCalendarEventEvidence(content, event, observedAt, terms)).filter(Boolean)
  return agreedCalendarDate(claimed) === date
}

export function matchesCalendarAnswer(answer, calendar) {
  if (Number.isSafeInteger(calendar?.minimumDays)) {
    const text = String(answer ?? '').normalize('NFKC')
    const dates = [...text.matchAll(DATE)]
    const claims = [...text.matchAll(DAY_COUNT)].filter(match =>
      readDayCount(match[1] ?? match[2]) >= 0 &&
      !dates.some(date => match.index >= date.index && match.index < date.index + date[0].length))
    if (!claims.length || /同一天|\bthe same day\b/iu.test(text) || claims.some(match =>
      readDayCount(match[1] ?? match[2]) !== calendar.minimumDays ||
      !/(?:至少|最少|不少于|\b(?:at least|no fewer than|a minimum of)\s*)$/iu.test(text.slice(0, match.index)))) return false
    const claimClauses = text.split(/[.!?;,，；\n]|\b(?:but|although|however|and)\b/iu)
    if (claimClauses.some(clause => statedCalendarDays(clause).length &&
      /\b(?:not|never|may|might|could|maybe)\b|n['’]t\b|可能|并非|不能确定/u.test(clause.toLowerCase()))) return false
    const sentences = sourceSentences(text)
    if (sentences.some(sentence => claimsExactNamedEventDay(sentence, BOUNDED_VISIT_REFERENCE))) return false
    const content = text.replace(/\byou (?:visited|went to)\b/giu, 'I visited').replace(/\byour visit\b/giu, 'my visit')
    if (calendarEventEvidence({ content, observedAt: Date.parse(calendar.latestEarlierDate + 'T12:00:00Z') },
      calendar.events[0], undefined, { allowReturnBounds: true })) return false
    const later = calendar.events[1], observedAt = Date.parse(calendar.laterDate + 'T00:00:00Z')
    return sentences.every(sentence => {
      const statement = sentence.replace(BOUNDED_LATER_REFERENCE, () => later)
      const stated = statedCalendarEventEvidence(statement, later, observedAt)
      return !stated || stated.days.includes(observedAt / DAY)
    })
  }
  if (calendar?.order) {
    const destinations = calendar.tripDestinations
    const distinctDestinations = destinations && destinations[0].toLowerCase() !== destinations[1].toLowerCase()
    const terms = (distinctDestinations ? destinations : calendar.events).map(calendarEventTerms)
    const trips = destinations ? calendar.events.map(event => tripChoice(event, calendar.language)) : null
    const eventNames = calendar.action === 'occur' ? calendar.events.map(event => englishEventName(event, true)) : null
    const refersTo = (text, index) => {
      if (trips?.[index]) return namesTripAnswer(text, trips[index], !distinctDestinations)
      if (eventNames) return [...text.matchAll(eventNames[index])].some(match => EVENT_NAME_END.test(text.slice(match.index + match[0].length)))
      if (calendar.tasks?.[index]) return Boolean(taskOccurrence(text, calendar.tasks[index], undefined, true)) ||
        [...text.matchAll(englishEventName(calendar.events[index], true))].some(match => EVENT_NAME_END.test(text.slice(match.index + match[0].length)))
      return namesEvent(text, terms[index])
    }
    const winner = calendar.winner, loser = 1 - winner
    const cues = /先于|早于|晚于|比.{1,80}?(?:更早|更晚)|\b(?:before|after|earlier than|later than|more recently than|(?<followed>followed by))\b/giu
    const latest = /(?:最近(?:一次)?|最后|更晚|后发生|\b(?:last|latest|more recently|most recent(?:ly)?|later)\b)/iu
    const earliest = /(?:最早|更早|先发生|先买|先坐|先(?:(?:独自|一个人|跟家人|和家人|带家人))?(?:去|到)|\b(?:first|earliest|earlier)\b)/iu
    const claims = new Set()
    const before = calendar.order === 'first'
    const sentences = sourceSentences(answer)
    for (const [position, sentence] of sentences.entries()) {
      if (/[?？]/u.test(sentence) || UNCERTAIN_DATE.test(sentence) ||
          destinations && (NON_OCCURRENCE.test(sentence) || /n['’]t\b|\bnever\b/iu.test(sentence))) continue
      if (eventNames && calendar.boundedDates?.some((bounded, index) =>
        bounded && claimsExactNamedEventDay(sentence, eventNames[index]))) return false
      if (position === 0) {
        const reply = calendarEventTerms(sentence).join(' ')
        for (const index of [0, 1]) if (reply === terms[index].join(' ')) claims.add(index)
      }
      const clauses = sentence.split(EVENT_CLAUSE_BREAK)
      for (const clause of destinations ? clauses.flatMap(part => part.split(/[，,]\s*(?=之后|后来|随后|然后|才)/u)) : clauses) {
        for (const cue of clause.matchAll(cues)) {
          const left = clause.slice(0, cue.index)
          const followed = cue.groups.followed !== undefined
          if (followed && (!eventNames || !/\b(?:happened|occurred|came|took place|was held)\s+first\s*,?\s*$/iu.test(left))) continue
          const right = cue[0].startsWith('比') ? cue[0].slice(1, -2) : clause.slice(cue.index + cue[0].length)
          const earlier = followed || /^(?:先于|早于|before|earlier than)/iu.test(cue[0]) || cue[0].endsWith('更早')
          const previous = sentences[position - 1]
          // A clear reference to the preceding event can contradict an
          // explicit answer even when it would not prove the order by itself.
          if (eventNames && previous && claims.has(winner) && earlier !== before &&
              /^(?:this(?: event| occasion)?|it)\s+(?:happened|occurred|took place|came|was(?: held)?)\s*$/iu.test(left.trim()) &&
              refersTo(previous, winner) && !refersTo(previous, loser) && refersTo(right, loser)) return false
          for (const index of [0, 1]) {
            if (refersTo(left, index) && refersTo(right, 1 - index)) claims.add(earlier === before ? index : 1 - index)
          }
        }
        for (const index of [0, 1]) {
          const orderText = destinations ? clause.replace(ORDER_PERIOD, '') : clause
          if (refersTo(clause, index) && !refersTo(clause, 1 - index) &&
              (before ? earliest : latest).test(orderText) && !(before ? latest : earliest).test(orderText)) claims.add(index)
        }
      }
    }
    return claims.has(winner) && !claims.has(loser)
  }
  if (!calendar || !Number.isSafeInteger(calendar.days) || calendar.events?.length !== 2 ||
      (!calendar.anchor && calendar.dates?.length !== 2)) return false
  let durationAnswer = answer
  if (calendar.personalSince) {
    if (calendar.unit === 'weeks') {
      const normalized = String(answer).normalize('NFKC')
      const conversions = [...normalized.matchAll(DAYS_PER_WEEK)]
      if (conversions.some(({ groups: { count } }) => (count.includes('.') ? Number(count) : readDayCount(count)) !== 7)) return false
      durationAnswer = normalized.replace(DAYS_PER_WEEK, ' ')
    }
    const text = String(durationAnswer).normalize('NFKC').replace(/[*_]/gu, '')
    const durations = [...text.matchAll(DAY_COUNT), ...text.matchAll(WEEK_COUNT)]
    if (durations.some(match => QUALIFIED_OFFSET.test(text.slice(0, match.index)))) return false
  }
  const claims = calendar.unit === 'weeks' ? statedWeekIntervalDays(durationAnswer) : statedCalendarDays(durationAnswer)
  if (claims.length !== 1 || claims[0] !== calendar.days) return false
  const objects = calendar.personalSince
    ? calendar.events.map(label => personalEventObject(label).replace(/^(?:at|for|from|in|on|to|with)\s+/iu, '')
      .replace(/^(?:my|our)\s+/iu, ''))
    : []
  const objectNames = objects.length === 2 && objects.every(Boolean) ? objects.map(label => englishEventName(label, true)) : []
  const distinctObjects = objectNames.length === 2 && objects[0].search(objectNames[1]) < 0 && objects[1].search(objectNames[0]) < 0
  const appearance = calendar.events.map((label, index) => {
    const item = (calendar.anchor || calendar.anchored) && PURCHASE_DATE_LABEL.exec(label)?.groups.item
    if (item) {
      const name = englishEventName(item)
      return text => text.search(name) >= 0
    }
    const terms = calendarEventTerms(quotedEventTitle(label) ?? label)
    return text => namesEvent(text, terms) || (distinctObjects && text.search(objectNames[index]) >= 0)
  })
  if (calendar.personalSince && !personalSinceAnswerDatesAgree(answer, calendar.dates, appearance)) return false
  if (calendar.anchor && [...String(answer).matchAll(DATE)].length) return false
  for (const [index, label] of calendar.anchor ? [] : calendar.events.entries()) {
    const observedAt = Date.UTC(Number(calendar.dates[index].slice(0, 4)), 6, 1)
    const expected = Date.parse(calendar.dates[index] + 'T00:00:00Z') / DAY
    for (const content of quotedEventTitle(label) ? sourceSentences(answer) : [answer]) {
      const stated = statedCalendarEventEvidence(content, label, observedAt)
      if (stated && !stated.days.includes(expected)) return false
    }
  }
  if (calendar.days === 0) return true
  const sentences = calendar.personalSince ? sourceSentences(answer).flatMap(sentence => sentence.split(/[;；]/u))
    : answer.split(/[。！？!?;；\n]+/u)
  for (const sentence of sentences) {
    if (calendar.personalSince) {
      const fromTo = /\bfrom\b(.+?)\bto\b(.+)/iu.exec(sentence)
      if (fromTo && appearance[1](fromTo[1]) && appearance[0](fromTo[2])) return false
      const phases = /\b(since|when)\b(.+?)\b(since|when)\b(.+)/iu.exec(sentence)
      if (phases && phases[1].toLowerCase() !== phases[3].toLowerCase()) {
        const sinceFirst = phases[1].toLowerCase() === 'since'
        if (appearance[1](phases[sinceFirst ? 2 : 4]) && appearance[0](phases[sinceFirst ? 4 : 2])) return false
      }
    }
    for (const cue of sentence.matchAll(/\b(before|after|earlier\s+than|later\s+than)\b/giu)) {
      const left = sentence.slice(0, cue.index), right = sentence.slice(cue.index + cue[0].length)
      const after = /^(?:after|later)/iu.test(cue[0])
      if (appearance[after ? 0 : 1](left) && appearance[after ? 1 : 0](right)) return false
    }
    const chinese = /^(.+?)比(.+?)(早|晚|提前|推迟)(?:了)?\s*(?:\d+|[零一二两三四五六七八九十]+)\s*[天日]/u.exec(sentence)
    if (chinese) {
      const after = /晚|推迟/u.test(chinese[3])
      if (appearance[after ? 0 : 1](chinese[1]) && appearance[after ? 1 : 0](chinese[2])) return false
    }
  }
  return true
}
