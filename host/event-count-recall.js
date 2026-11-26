import { attendanceWindow, calendarLookbackStart, calendarOccurrenceBounds, calendarOrderClauses, calendarOrderPeriod, calendarPrecedes, calendarPrecedesAtLocalBoundary, readDayCount, sourceCalendarDay, sourceEventDate } from './calendar-recall.js'
import { estimateTokens } from './recall.js'
import { sourceSentences } from './sentences.js'
import { isRecallSourceStatement } from './source-passages.js'

const EN_ACTION = String.raw`attend(?:ed)?|participat(?:e|ed) in|join(?:ed)?|(?:go|went|been) to|(?:take|took|taken) part in`
const ZH_RANGE = String.raw`(?:上(?:一)?(?:周|个月|年)|去年|今年|本(?:周|月|年)|这(?:周|个月)|(?:[12]\d{3}年)?(?:1[0-2]|[1-9])月|(?:过去|最近|近)\s*[一二两三四五六七八九十\d]+\s*(?:天|周|个?月|年))`
const ZH_QUERY = new RegExp(String.raw`^(?<before>${ZH_RANGE})?\s*我(?:们)?\s*(?<after>${ZH_RANGE})?\s*(?:一共|总共|总计)?(?:参加|出席|参与|列席)(?:了|过)?(?:几|多少)(?:次|场|个)(?<topic>[\p{L}\p{N} ·_-]{2,48})$`, 'u')
const NUMBER = String.raw`(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|(?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:[- ](?:one|two|three|four|five|six|seven|eight|nine))?)`
const LOOKBACK_PHRASE = String.raw`(?:in|over|during) the (?:past|last)\s+(?:(?<count>${NUMBER})\s+)?(?<unit>days?|weeks?|months?|years?)`
const LOOKBACK = new RegExp(String.raw`^${LOOKBACK_PHRASE}$`, 'iu')
const EN_QUERY = new RegExp(String.raw`^(?:(?<before>${LOOKBACK_PHRASE})(?:\s*,\s*|\s+))?how many (?<topic>[\p{L}\p{N} '-]{2,72}?) (?:did|have|had) (?:I|we) (?:${EN_ACTION})(?<when>.*)$`, 'iu')
const ZH_LOOKBACK = /^(?:过去|最近|近)\s*([一二两三四五六七八九十\d]+)\s*(天|周|个?月|年)$/u
const PREVIOUS_PERIOD = { 上周: 'last week', 上一周: 'last week', 上个月: 'last month', 上一个月: 'last month', 去年: 'last year', 上年: 'last year', 上一年: 'last year' }
const MONTH_NAMES = 'jan feb mar apr may jun jul aug sep oct nov dec'.split(' ')
const MONTH_PATTERN = String.raw`jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?`
const NAMED_MONTH = new RegExp(String.raw`^(?:in|during) (${MONTH_PATTERN})(?:\s+([12]\d{3}))?$`, 'iu')
const STATED_COUNT_WINDOW = new RegExp(String.raw`\b${LOOKBACK_PHRASE}\b|\b(?:in|during) (?:${MONTH_PATTERN})(?:\s+[12]\d{3})?\b|\b(?:this|last) (?:week|month|year)\b|(?<!\d)${ZH_RANGE}(?!\s*\d{1,2}[日号])`, 'giu')
const ZH_NAMED_MONTH = /^(?:([12]\d{3})年)?(1[0-2]|[1-9])月$/u
const CURRENT_PERIOD = /^(?:(?:in|during) )?this (week|month|year)$/iu
const ZH_CURRENT_PERIOD = { 本周: 'week', 这周: 'week', 本月: 'month', 这个月: 'month', 本年: 'year', 今年: 'year' }
const DAY = 86_400_000
const LEAD = String.raw`(?:(?:and\s+)?(?:by the way|actually|for context)\s*[,，]\s*)?`
const DATE_LEAD = String.raw`(?:(?:on\s+[^,;!?]{2,34}|today|yesterday|last\s+(?:week|month|year))\s*,\s*)?`
const PERSONAL = String.raw`(?:I|we)(?:['’]ve)?\s+(?:(?:have|had|just|also|already|recently|actually)\s+){0,4}`
const APPOINTMENT_TOPIC = /^(?:doctor(?:'s)?|medical)\s+(?:appointments?|visits?)$/iu
const MEDICAL_PROVIDER = String.raw`(?:primary care (?:physician|doctor|provider)|family (?:physician|doctor)|(?:orthopedic|general) surgeon|doctor|physician|specialist|cardiologist|dermatologist|gastroenterologist|neurologist|pediatrician|orthopedist)`
const COMPLETED_APPOINTMENT = new RegExp(String.raw`^${LEAD}${DATE_LEAD}${PERSONAL}(?:finally\s+)?(?:had\s+(?:an?|my|our|the)\s+(?:(?:follow[- ]?up|routine|in-person)\s+)?appointment\s+with|went\s+to\s+see)\s+(?:(?:my|our|the|an?)\s+)?(?<provider>${MEDICAL_PROVIDER})\b(?:[,]?\s+(?<name>Dr\.?\s+[\p{L}'’-]+))?`, 'iu')
const APPOINTMENT_CANCELED = /\b(?:cancel(?:l)?ed|rescheduled|missed|did not go|didn['’]t go|never went|never happened|didn['’]t happen|no[- ]show)\b/iu
const APPOINTMENT_FOLLOWUP = /(?:,?\s+)(?:and|but|so) (?=I\b|we\b|he\b|she\b|they\b|it\b|my\b|the\b)|,\s+(?=(?:I|we|he|she|they)\b)/iu
const EN_ASSERTION = new RegExp(String.raw`^${LEAD}${DATE_LEAD}${PERSONAL}(?<action>attended|participated in|joined|went to|been to|took part in|taken part in|got back from|returned from)\s+`, 'iu')
const EN_NEGATION = new RegExp(String.raw`^${LEAD}${DATE_LEAD}${PERSONAL}(?:did not|didn['’]t|never)\s+(?:${EN_ACTION})\s+`, 'iu')
const ZH_PERSONAL = String.raw`我(?:们)?(?:(?:在|于)?(?:[12]\d{3}[-/]\d{1,2}[-/]\d{1,2}|(?:[12]\d{3}年)?\d{1,2}月\d{1,2}[日号]|前天|昨天|今天|上周|上个月|去年)[，,]?\s*)?`
const ZH_ASSERTION = new RegExp(String.raw`^${ZH_PERSONAL}(?:已经|也|实际|刚刚|刚)?(?:参加|出席|参与|列席)(?:了|过)\s*`, 'u')
const ZH_NEGATION = new RegExp(String.raw`^(?:其实[，,]?\s*)?${ZH_PERSONAL}(?:并)?(?:没(?:有)?|未(?:曾)?)(?:参加|出席|参与|列席)(?:过)?\s*`, 'u')
const NON_OCCURRENCE = /(?:没有|未曾|并非|没去|未参加|取消|打算|计划|假设|例如|听说|转述|线上|虚拟)|\b(?:if|never|not|planning|would|will|might|maybe|supposed|cancelled|canceled|online|virtual|imagined|for example)\b/iu
const CUT_CLAUSE = /[,，]\s*(?:where|which|when|and also at|and then|but|so)\b|\s+(?:before|after|because|while|instead of|rather than)\s+|[，,](?:而|然后|之后|此前|之前|但是|所以|因为|随后|另外)/iu
const EN_OBJECT_END = /\s+(?:on|at|in|with|for|from|since)\s+|\s+(?:today|yesterday|last\s+(?:week|month|year)|\d+\s+(?:days?|weeks?|months?|years?)\s+ago)\b|[,.;!?]/iu
const ZH_OBJECT_END = /(?:[，,。；;！？]|\s+(?:于|在)|今天|昨天|上周|上个月|去年|[12]\d{3}[-/]|\d{1,2}月\d{1,2}[日号])/u
const REFERENCE = /\b(?:like|including) the ones? (?:I|we) (?:had|attended|joined) at\s+/iu
const DINNER_PARTIES = /^dinner part(?:y|ies)$/iu
const HOST_VENUE = /\bat\s+(?<host>\p{Lu}[\p{L}'’-]+(?:\s+\p{Lu}[\p{L}'’-]+){0,2})['’]s\s+(?:place|home|house)\b/gu
const MEAL_EXAMPLE_LEAD = new RegExp(String.raw`^${LEAD}${PERSONAL}had\s+(?:(?:an?|some)\s+[\p{L} -]{1,36}\s+)?experience with\s+(?<subject>.+?)\b(?:like|including) the ones? (?:I|we) (?:had|attended|joined)\s*$`, 'iu')
const DINNER_CONTEXT = new RegExp(String.raw`^${LEAD}speaking of dinner part(?:y|ies)\s*,\s*${PERSONAL}had\s+(?:an?\s+[\p{L} -]{1,36}\s+)?experience\s*$`, 'iu')
const BBQ_EVENT = /\b(?:barbecue|bbq)\b/iu
const GAME_DETAIL = /\bwatched\s+(?:an?|the)\s+([a-z-]+)\s+(?:game|match)\b/iu
const FEAST_TYPE = /\b([a-z-]+)\s+feast\b/iu
const WEEK_OFFSET = new RegExp(String.raw`^(?:a|an|${NUMBER})\s+weeks?\s+ago$`, 'iu')
const EVENT_IDENTIFIER = /(?<![\w#])#(?=[a-z0-9_-]*\d)([a-z][a-z0-9_-]{2,40})(?![\w-])/giu
const ZERO_OCCURRENCES = /^(?:(?:no|zero|0)(?=\s|$)|[零0]\s*(?:次|场|个))/iu
const TYPE_LIST = /\b(?:and|or|several|some|multiple)\b|分别|以及|若干|好几|多场/u
const UNKNOWN_ANSWER = /\b(?:at least|unknown|cannot|can't|no (?:evidence|information)|uncertain|probably|maybe|not|unclear)\b|至少|无法|不能|不确定|未知|不是|不足/iu
const ZH_UNITS = { 天:'days', 周:'weeks', 月:'months', 个月:'months', 年:'years' }
const BIRTH_RELATION = String.raw`friends?|family(?: members)?|relatives?|aunt|uncle|cousin|sister-in-law|brother-in-law|sister|brother|niece|nephew|daughter|son`
const BIRTH_GROUP = String.raw`friends|family(?: members)?|relatives`
const BIRTH_QUERY = new RegExp(String.raw`^how many (?<topic>babies|children|newborns) were born to (?:my |our )?(?<group>${BIRTH_GROUP})(?: (?:and|or) (?:my |our )?(?<second>${BIRTH_GROUP}))?(?<when> .+)$`, 'iu')
const BIRTH_CONTACT = new RegExp(String.raw`\b(?:my|our)\s+(?<relation>${BIRTH_RELATION})\b`, 'giu')
const RECENT_MONTHS = /^(?:in|over|during) the (?:past|last) few months$/iu
const BIRTH_NOUN = String.raw`baby(?:\s+(?:boy|girl))?|child|twins|son|daughter|newborn`
const BIRTH_ACTIVE = new RegExp(String.raw`^(?<parent>[^.!?]{0,72}?)\s+(?:(?:just|recently)\s+)?(?:had|welcomed|gave birth to)\s+(?:(?:their|her|his)\s+(?:first|second|third)\s+|(?:a|an)\s+)?(?<noun>${BIRTH_NOUN})(?:,\s+a\s+(?:boy|girl))?\s+(?:named|called)\s+`, 'iu')
const BIRTH_POSSESSIVE = new RegExp(String.raw`^(?<parent>[^.!?]{0,55}?)['’]s\s+(?<noun>${BIRTH_NOUN})(?:,\s*|\s+)`, 'iu')
const NAME = String.raw`\p{Lu}[\p{L}'’-]+(?:\s+\p{Lu}[\p{L}'’-]+)?`
const BIRTH_NAMES = new RegExp(String.raw`^(?<first>${NAME})(?:\s+(?:and|&)\s+(?<second>${NAME}))?(?=$|[\s,.;!?])`, 'u')
const IMPLAUSIBLE_BIRTH = /(?:\b(?:if|might|maybe|imagine|thought|wish(?:ed)?|pretend|had not|not born|could have|was expecting|is expecting)\b|\b(?:hadn['’]t|would['’]ve|didn['’]t)\b)/iu
const BORN_CLAUSE = /^,?\s*(?:who\s+)?(?:was|were)\s+born\b/iu
const BIRTH_TIMING_END = /,(?!\s+[12]\d{3}\b)|[;!?]|\.(?!\s*\d)|\s+(?:[–—-]\s|and\s+(?:I|we|he|she|they)\b|but\s+)/iu
const singular = word => word.replace(/ies$/u, 'y').replace(/(ch|sh|x|ss|zz)es$/u, '$1').replace(/(?<!s)s$/u, '')
const words = text => (text.normalize('NFKC').toLowerCase().match(/[a-z][a-z0-9_-]*/gu) ?? []).map(singular)

function queryWindow(text, english) {
  if (!text) return undefined
  const previous = english && /^last (?:week|month|year)$/iu.test(text) ? text.toLowerCase() : PREVIOUS_PERIOD[text]
  if (previous) return { previous }
  const current = english ? CURRENT_PERIOD.exec(text)?.[1].toLowerCase() : ZH_CURRENT_PERIOD[text]
  if (current) return { current }
  const month = (english ? NAMED_MONTH : ZH_NAMED_MONTH).exec(text)
  if (month) return english ? { month: MONTH_NAMES.indexOf(month[1].slice(0, 3).toLowerCase()), year: month[2] }
    : { month: Number(month[2]) - 1, year: month[1] }
  const match = (english ? LOOKBACK : ZH_LOOKBACK).exec(text)
  if (!match) return null
  const count = english ? readDayCount(match.groups.count ?? 'one') : readDayCount(match[1])
  const unit = english ? match.groups.unit.toLowerCase() : ZH_UNITS[match[2]]
  return Number.isSafeInteger(count) && count > 0 ? { count, unit } : null
}

function eventCountWindow(reference, window) {
  if (!window?.current && window?.month === undefined) return attendanceWindow(reference, window)
  const today = sourceCalendarDay(reference)
  if (today === null) return null
  const date = new Date(today * DAY)
  const year = date.getUTCFullYear()
  const month = date.getUTCMonth()
  if (window.current) {
    const from = window.current === 'week' ? today - (date.getUTCDay() + 6) % 7
      : Date.UTC(year, window.current === 'month' ? month : 0, 1) / DAY
    return { from, to: today + 1, zone: reference.timeZone }
  }
  // An unspecified year denotes the most recent occurrence of the month.
  const selectedYear = window.year ? Number(window.year) : year - Number(window.month > month)
  const from = Date.UTC(selectedYear, window.month, 1) / DAY
  if (from > today) return null
  const to = Math.min(Date.UTC(selectedYear, window.month + 1, 1) / DAY, today + 1)
  return { from, to, zone: reference.timeZone }
}

export function eventCountQuery(query, reference) {
  const value = query.normalize('NFKC').replace(/[’]/gu, "'").trim().replace(/[?？。！!]+$/u, '')
  if (value.length > 240) return null
  const birth = BIRTH_QUERY.exec(value)?.groups
  if (birth) {
    const phrase = birth.when.trim()
    const approximateWindow = RECENT_MONTHS.test(phrase)
    const window = approximateWindow ? { count: 3, unit: 'months' } : queryWindow(phrase, true)
    if (window) {
      const groups = [birth.group, birth.second].filter(Boolean).map(group => /^friends$/iu.test(group) ? 'friend' : 'family')
      return { births: true, topic: birth.topic.toLowerCase(), language: 'en', groups, approximateWindow,
        range: eventCountWindow(reference, window), clock: reference,
        search: 'born baby babies newborn welcomed birth twins baby boy girl son daughter' }
    }
  }
  const english = EN_QUERY.exec(value)
  const match = english ?? ZH_QUERY.exec(value)
  if (!match || match.groups.before && (match.groups.after || match.groups.when?.trim())) return null
  const topic = match.groups.topic.trim()
  if (TYPE_LIST.test(topic) || /和|与|及|或/u.test(topic)) return null
  const requested = match.groups.when?.trim() || match.groups.before || match.groups.after
  const window = queryWindow(requested?.trim(), Boolean(english))
  if (window === null) return null
  const range = eventCountWindow(reference, window)
  const terms = english ? words(topic) : topic
  if (terms.length === 0) return null
  const medical = Boolean(english && APPOINTMENT_TOPIC.test(topic))
  const dinnerParty = Boolean(english && DINNER_PARTIES.test(topic))
  const search = medical ? 'doctor physician surgeon appointments primary care specialist'
    : dinnerParty ? 'dinner party parties feast barbecue BBQ' : english ? topic + ' ' + terms.join(' ') : topic
  return { topic, terms, language: english ? 'en' : 'zh', range, clock: { eventTime: reference.eventTime, timeZone: reference.timeZone },
    search, ...(english?.groups.before ? { leadingWindow: true } : {}), ...(medical ? { medical } : {}), ...(dinnerParty ? { dinnerParty } : {}) }
}

function namesTopic(text, plan) {
  if (plan.language === 'zh') return text.includes(plan.topic)
  const tokens = words(text)
  return tokens.some((_, offset) => plan.terms.every((term, index) => tokens[offset + index] === term))
}

function eventDetails(statement, plan) {
  const english = plan.language === 'en'
  const denial = (english ? EN_NEGATION : ZH_NEGATION).exec(statement)
  const head = denial ?? (english ? EN_ASSERTION : ZH_ASSERTION).exec(statement)
  if (head) {
    const object = statement.slice(head[0].length).split(english ? EN_OBJECT_END : ZH_OBJECT_END, 1)[0].trim()
    if (!namesTopic(object, plan) || ZERO_OCCURRENCES.test(object)) return null
    const ids = [...new Set([...object.matchAll(EVENT_IDENTIFIER)].map(match => match[1].toLowerCase()))]
    return { object, id: ids.length === 1 ? ids[0] : null, negated: Boolean(denial), prefixLength: head[0].length,
      returned: /back from|returned from/u.test(head.groups?.action?.toLowerCase() ?? ''),
      multiple: ids.length > 1 || TYPE_LIST.test(object) || /^(?:\d+|two|three|four|five)\s/iu.test(object) }
  }
  if (!english) return null
  const reference = REFERENCE.exec(statement)
  if (!reference) return null
  const lead = statement.slice(0, reference.index)
  if (!new RegExp(String.raw`^${LEAD}${PERSONAL}had experience with\s+`, 'iu').test(lead) || !namesTopic(lead, plan)) return null
  const place = statement.slice(reference.index + reference[0].length).split(EN_OBJECT_END, 1)[0].trim()
  return place ? { object: plan.topic + ' at ' + place, returned: false, multiple: false } : null
}

function venueHost(match) {
  return match?.groups.host.normalize('NFKC').toLowerCase() ?? null
}

function attendanceObservation(record, plan, period, event) {
  const range = plan.range
  const precedes = plan.dinnerParty ? calendarPrecedesAtLocalBoundary : calendarPrecedes
  if (!period || (range?.from != null && precedes(period, { from: range.from, zone: range.zone })) ||
      (range?.to != null && precedes({ to: range.to, zone: range.zone }, period))) return null
  const inside = Boolean(range && period.from !== null &&
    (range.from === null || precedes({ to: range.from, zone: range.zone }, period)) &&
    (range.to === null || precedes(period, { from: range.to, zone: range.zone })))
  const dayKey = Number.isSafeInteger(period.from) && period.to - period.from === 1 && period.zone
    ? JSON.stringify([period.zone, period.from]) : null
  const key = event.venue ? plan.topic.toLowerCase() + ' at ' + event.venue
    : event.object.normalize('NFKC').toLowerCase().replace(/^(?:a|an|the)\s+/u, '').replace(/\s+/gu, ' ')
  return { ...period, key, dayKey, inside, id: event.id ?? null, negated: event.negated ?? false,
    venue: event.venue, anotherVenue: event.anotherVenue, uncertainIdentity: event.multiple,
    statedAt: record.sourceRefs[0].eventTime }
}

function eventObservations(record, plan) {
  const observations = []
  const clauses = plan.medical ? sourceSentences(record.content) : calendarOrderClauses(record.content)
  for (const original of clauses) {
    const appointment = plan.medical ? COMPLETED_APPOINTMENT.exec(original) : null
    const end = appointment?.[0].length ?? 0
    const first = appointment ? original.slice(0, end) + original.slice(end).split(APPOINTMENT_FOLLOWUP, 1)[0] : original
    const quote = first.split(CUT_CLAUSE, 1)[0].trim()
    if (!isRecallSourceStatement(quote) || plan.medical && APPOINTMENT_CANCELED.test(original)) continue
    const visit = appointment?.groups
    const event = visit ? { object: visit.name ?? visit.provider } : eventDetails(quote, plan)
    const assertion = plan.medical ? quote : original
    if (!event || NON_OCCURRENCE.test(event.negated ? assertion.trimStart().slice(event.prefixLength) : assertion)) continue
    const dated = quote.replace(/"[^"\n]+"|“[^”\n]+”/gu, 'the event')
    const period = calendarOccurrenceBounds(record, quote, { dated, returned: event.returned })
    // A second location in a referenced list need not share the first event's date.
    const additional = /\band also at\b/iu.exec(original.slice(quote.length))
    const named = plan.dinnerParty ? [...quote.matchAll(HOST_VENUE)] : []
    const related = plan.dinnerParty && additional && !event.multiple
      ? [...additional.input.slice(additional.index).matchAll(HOST_VENUE)] : []
    const observation = attendanceObservation(record, plan, period, { ...event,
      venue: named.length === 1 ? venueHost(named[0]) : null,
      anotherVenue: related.length === 1 ? venueHost(related[0]) : null,
      multiple: event.multiple || Boolean(additional) })
    if (observation) observations.push(observation)
  }
  return observations
}

function mealDescription(text) {
  if (BBQ_EVENT.test(text)) {
    const game = GAME_DETAIL.exec(text)?.[1].toLowerCase()
    return game ? 'barbecue:' + game : null
  }
  const cuisine = FEAST_TYPE.exec(text)?.[1].toLowerCase()
  return cuisine && cuisine !== 'the' ? 'feast:' + cuisine : null
}

function hostedMealPeriod(record, quote, dated) {
  const period = calendarOccurrenceBounds(record, quote, { dated })
  const reportedWeek = dated.trim()
  if (!period || period.from !== null || !WEEK_OFFSET.test(reportedWeek)) return period
  const { day, zone } = sourceEventDate(record, quote, { dated })
  if (day === null || !zone || period.to === null) return period
  // A week-level observation can be within a range without supplying an exact day.
  return { ...period, from: day - 6, to: Math.min(day + 7, period.to), zone, reportedWeek }
}

/** Bind an alias only when first-person statements name the same host and meal. */
function dinnerStatements(record) {
  const result = []
  for (const sentence of sourceSentences(record.content)) {
    if (!isRecallSourceStatement(sentence) || NON_OCCURRENCE.test(sentence)) continue
    const places = [...sentence.matchAll(HOST_VENUE)]
    if (!places.length) continue
    const leading = sentence.slice(0, places[0].index)
    const example = MEAL_EXAMPLE_LEAD.exec(leading)
    const category = /^(?:(?:the|some|a)\s+)?dinner part(?:y|ies)\b/iu.test(example?.groups.subject ?? '')
    const context = DINNER_CONTEXT.test(leading)
    if (!example && !context && !EN_ASSERTION.test(leading)) continue
    if (!category && places.length !== 1) continue
    for (const [position, place] of places.entries()) {
      if (position > 0 && (!category || !/\band also\s*$/iu.test(sentence.slice(0, place.index)))) continue
      if (position === 0 && category) continue // Direct attendance already uses the main event path.
      const following = sentence.slice(place.index + place[0].length, places[position + 1]?.index)
      if (position > 0 && !/\bwhere\s+(?:I|we)\s+had\b/iu.test(following)) continue
      const description = mealDescription(position === 0 ? leading + following : following)
      if (!description) continue
      const venue = venueHost(place)
      const dated = following.split(/[,;.!?]|\s+(?:and|where|while|before|after)\b/iu, 1)[0]
      const period = hostedMealPeriod(record, sentence, dated)
      if (period) result.push({ venue, description, period, category: category || context, quote: sentence })
    }
  }
  return result
}

function linkDinnerAttendance(hits, plan) {
  const statements = hits.flatMap(hit => {
    const ref = hit.record.sourceRefs[0]
    return typeof ref.sessionId === 'string' && ref.sessionId ? hit.dinner.map(item => ({ ...item, hit })) : []
  })
  const sameEvent = item => JSON.stringify([item.hit.record.sourceRefs[0].sessionId, item.venue, item.description])
  const dates = new Map(), resolved = new Set(), linked = []
  for (const row of statements) {
    if (row.category || row.period.from === null) continue
    const key = sameEvent(row)
    const alternatives = dates.get(key) ?? new Map()
    alternatives.set(JSON.stringify([row.period.from, row.period.to, row.period.zone]), row)
    dates.set(key, alternatives)
  }
  for (const witness of statements.filter(item => item.category)) {
    const alternatives = [...(dates.get(sameEvent(witness))?.values() ?? [])].filter(row =>
      !calendarPrecedesAtLocalBoundary(witness.period, row.period))
    const dated = witness.period.from !== null ? witness : alternatives.length === 1 ? alternatives[0] : null
    const primary = dated ?? witness
    const row = attendanceObservation(primary.hit.record, plan, primary.period, {
      venue: primary.venue, multiple: !dated,
    })
    if (dated) resolved.add(JSON.stringify([witness.hit.record.sourceRefs[0].sourceId, witness.venue]))
    if (!row) continue
    const other = primary !== witness ? { hit: witness.hit, quote: witness.quote } : null
    linked.push({ ...row, hit: primary.hit, ...(other ? { witness: other } : {}) })
  }
  for (const hit of hits) {
    hit.observations = hit.observations.map(row => row.anotherVenue && resolved.has(
      JSON.stringify([hit.record.sourceRefs[0].sourceId, row.anotherVenue])) ? { ...row, uncertainIdentity: false } : row)
  }
  return linked
}

function separateDates(a, b) {
  return calendarPrecedes(a, b) || calendarPrecedes(b, a)
}

function occurrenceRows(hits, linked) {
  const candidates = [...hits.flatMap(hit => hit.observations.map(row => ({ ...row, hit }))), ...linked]
    .sort((a, b) => (a.to ?? Infinity) - (b.to ?? Infinity) || (b.from ?? -Infinity) - (a.from ?? -Infinity))
  const dated = [], uncertain = new Set(), exact = new Set(), quotes = new Set(), denials = new Map()
  const identity = row => row.id ? `id:${row.id}` : `title:${row.key}`
  for (const row of candidates) {
    if (!row.negated) continue
    const key = identity(row)
    if (!denials.has(key)) denials.set(key, [])
    denials.get(key).push(row)
  }
  let incomplete = false
  for (const row of candidates) {
    if (row.negated) continue
    const corrections = (denials.get(identity(row)) ?? []).filter(denial => !separateDates(denial, row) &&
      !(Number.isSafeInteger(denial.statedAt) && Number.isSafeInteger(row.statedAt) && denial.statedAt < row.statedAt))
    if (corrections.some(denial => !denial.uncertainIdentity &&
        (row.id || row.dayKey && row.dayKey === denial.dayKey) && denial.statedAt > row.statedAt)) continue
    if (corrections.length) {
      uncertain.add(row)
      for (const denial of corrections) uncertain.add(denial)
      continue
    }
    if (row.uncertainIdentity) incomplete = true
    const key = row.dayKey ? JSON.stringify([row.dayKey, identity(row)]) : null
    const value = JSON.stringify([row.hit.record.sourceRefs[0].sourceId, row.quote])
    if ((key && exact.has(key)) || quotes.has(value)) continue
    if (key) exact.add(key)
    quotes.add(value)
    if (row.inside && dated.every(previous => row.id && previous.id ? row.id !== previous.id
      : (row.venue && previous.venue && row.venue !== previous.venue) || separateDates(previous, row))) dated.push(row)
    else uncertain.add(row)
  }
  return { dated, uncertain: [...uncertain], incomplete }
}

function render(plan, dated, uncertain, complete) {
  const count = dated.length
  const en = plan.language === 'en'
  const topic = plan.medical ? 'appointment' : 'attendance'
  const unit = plan.dinnerParty ? (count === 1 ? 'dinner party' : 'dinner parties') : (count === 1 ? topic : topic + 's')
  const lead = en ? complete ? `The memory records confirm ${count} recorded ${unit}.`
    : count ? `The memory records confirm at least ${count} recorded ${unit}. The total is unknown.`
      : `The total is unknown. The available statements do not establish a dated ${topic} in this interval.`
    : complete ? `现有记忆确认记录了 ${count} 次参加经历。`
      : count ? `现有记忆至少确认 ${count} 次参加经历。总次数未知。` : '总次数未知。现有原话尚未证实有哪次参加经历属于这段时间。'
  const entry = (row, uncertainDate) => {
    const period = uncertainDate ? (en ? `date or distinct ${topic} unconfirmed` : '日期或是否重复待确认')
      : row.reportedWeek ?? calendarOrderPeriod(row)
    return { row, period, text: `- ${period} · “${row.quote}”` }
  }
  const injected = [...dated.map(row => entry(row, false)), ...uncertain.map(row => entry(row, true))]
  const grouped = injected.some(item => item.row.witness)
  const evidence = [], lines = []
  for (const primary of injected) {
    const witness = primary.row.witness
    evidence.push(primary)
    if (!witness) { lines.push(primary.text); continue }
    const period = en ? 'same gathering evidence' : '同一活动佐证'
    const quote = `${period} · “${witness.quote}”`
    evidence.push({ row: witness, period, text: quote })
    lines.push(`${primary.text} (${quote})`)
  }
  const qualification = complete ? [] : [en
    ? count ? `In your answer, say “at least ${count}” and explain that the exact total is unknown.`
      : 'In your answer, say that the available statements cannot establish the total.'
    : count ? `回答时写明「至少 ${count} 次」，并说明总次数未知。` : '回答时说明现有原话不足以确定总次数。']
  const grouping = grouped ? [en
    ? 'Each bullet covers one gathering and its supporting quotes.'
    : '每个列表项是一场活动，括号内为同一场的佐证。'] : []
  const useCount = grouped && complete ? [`Answer with ${count} recorded ${unit}.`] : []
  return { text: [lead, ...grouping, ...lines, ...qualification, ...useCount].join('\n'), injected: evidence }
}

function fitDinnerEvidence(plan, dated, uncertain, fits) {
  const cost = row => estimateTokens(row.quote) + (row.witness ? estimateTokens(row.witness.quote) : 0)
  const byCost = rows => rows.map(row => ({ row, tokens: cost(row) })).sort((a, b) => a.tokens - b.tokens)
  const confirmed = [], candidates = []
  for (const { row } of byCost(dated)) {
    if (fits(render(plan, [...confirmed, row], [], false))) confirmed.push(row)
  }
  for (const { row } of byCost(uncertain)) {
    if (fits(render(plan, confirmed, [...candidates, row], false))) candidates.push(row)
  }
  return [...dated.filter(row => confirmed.includes(row)), ...uncertain.filter(row => candidates.includes(row))]
}

function birthReports(record, plan) {
  const reports = []
  const ref = record.sourceRefs[0]
  let previous = null
  for (const sentence of sourceSentences(record.content)) {
    let current = null
    for (const contact of sentence.matchAll(BIRTH_CONTACT)) {
      const group = /^friends?$/iu.test(contact.groups.relation) ? 'friend' : 'family'
      if (!plan.groups.includes(group) || /[?？]/u.test(sentence) || IMPLAUSIBLE_BIRTH.test(sentence.slice(0, contact.index))) continue
      const subject = sentence.slice(contact.index + contact[0].length)
      const active = BIRTH_ACTIVE.exec(subject)
      const predicate = active ?? BIRTH_POSSESSIVE.exec(subject)
      if (!predicate || IMPLAUSIBLE_BIRTH.test(predicate[0])) continue
      const parent = predicate.groups.parent.trim().replace(/^from (?:college|school|work)\b[\s,]*/iu, '').replace(/,$/u, '').trim()
      const parents = parent ? BIRTH_NAMES.exec(parent) : null
      if (parent && parents?.[0] !== parent) continue
      const names = BIRTH_NAMES.exec(subject.slice(predicate[0].length))
      if (!names) continue
      const twins = /^twins$/iu.test(predicate.groups.noun)
      if (twins !== Boolean(names.groups.second)) continue
      const ending = subject.slice(predicate[0].length + names[0].length)
      const occurred = active ? '' : BORN_CLAUSE.exec(ending)?.[0]
      if (occurred === undefined) continue
      const timing = ending.slice(occurred.length)
      const dated = timing.replace(/^\s*,\s*/u, '').trim().split(BIRTH_TIMING_END, 1)[0].trim()
      if (IMPLAUSIBLE_BIRTH.test(dated)) continue
      let quote = sentence.slice(0, contact.index + contact[0].length + predicate[0].length + names[0].length +
        occurred.length + timing.indexOf(dated) + dated.length).trim()
      const absoluteMonth = NAMED_MONTH.test(dated) ? queryWindow(dated, true) : null
      let period = absoluteMonth ? eventCountWindow(ref, absoluteMonth) : calendarOccurrenceBounds(record, quote, { dated })
      if (/^a few weeks ago$/iu.test(dated)) {
        const start = calendarLookbackStart(ref, 2, 'months')
        const day = sourceCalendarDay(ref)
        if (start !== null && day !== null) period = { from: start, to: day + 1, zone: ref.timeZone, approximate: true }
      } else if (/^around the same time$/iu.test(dated) && previous?.period?.from != null && !previous.period.approximate) {
        const head = record.content.indexOf(previous.quote)
        const tail = record.content.indexOf(quote, head + previous.quote.length)
        if (head !== -1 && tail !== -1) {
          quote = record.content.slice(head, tail + quote.length)
          period = { ...previous.period, approximate: true }
        }
      }
      if (!period) continue
      const displayNames = [names.groups.first, names.groups.second].filter(Boolean)
      const children = displayNames.map(name => name.normalize('NFKC').toLowerCase())
      if (new Set(children).size !== children.length) continue
      current = { quote, period }
      const { range } = plan
      const outside = calendarPrecedes(period, { from: range.from, zone: range.zone }) ||
        calendarPrecedes({ to: range.to, zone: range.zone }, period)
      const inside = period.from != null && calendarPrecedes({ to: range.from, zone: range.zone }, period) &&
        calendarPrecedes(period, { from: range.to, zone: range.zone })
      const parentNames = parents ? [parents.groups.first, parents.groups.second].filter(Boolean).map(name => name.toLowerCase()) : []
      reports.push({ children, displayNames, quote, period, inside, outside, parentNames })
    }
    previous = current
  }
  return reports
}

function conflictingBirthReports(rows) {
  const reported = new Map()
  const conflicts = new Set()
  for (const row of rows) {
    for (const child of row.children) {
      const previous = reported.get(child) ?? []
      for (const peer of previous) {
        if (peer.outside && row.outside) continue
        const differentContacts = peer.parentNames.length && row.parentNames.length &&
          !peer.parentNames.some(name => row.parentNames.includes(name))
        const conflictingDates = !row.period.approximate && !peer.period.approximate && row.period.from != null &&
          peer.period.from != null && separateDates(row.period, peer.period)
        if (differentContacts || conflictingDates) conflicts.add(child)
      }
      previous.push(row)
      reported.set(child, previous)
    }
  }
  return conflicts
}

function retrieveBirthCount(index, plan, { projectKey, now, maxItems, maxTokens, scanLimit, skipCapture }, unavailable) {
  const scan = index.findEvidence([plan.search], {
    projectKey, now, maxTokens: scanLimit, allMatches: true, wholeSentences: true, acceptOriginal: true,
    distinctKey: (_, hit) => hit.record.id,
    match: (_, hit) => {
      if (hit.record.sourceRefs[0].eventTime > now) return null
      const reports = birthReports(hit.record, plan)
      return reports.length ? { ...hit, reports } : null
    },
  })
  const hits = index.validateMany(scan.matches.map(row => row.hit), projectKey, { now })
  const allRows = hits.flatMap(hit => hit.reports.map(report => ({ ...report, hit })))
  const conflicts = conflictingBirthReports(allRows)
  const rows = allRows.filter(row => !row.outside || row.children.some(child => conflicts.has(child)))
    .sort((a, b) => Number(Boolean(b.inside)) - Number(Boolean(a.inside)) ||
      Number(Boolean(a.period.approximate)) - Number(Boolean(b.period.approximate)) || a.quote.length - b.quote.length)
  const known = new Set()
  const supporting = []
  for (const row of rows) {
    if (row.children.every(child => known.has(child))) {
      if (row.children.some(child => conflicts.has(child)) && !supporting.some(other =>
        other.quote === row.quote && other.hit.record.id === row.hit.record.id)) supporting.push(row)
      continue
    }
    supporting.push(row)
    for (const child of row.children) known.add(child)
  }
  const selected = supporting.slice(0, maxItems)
  while (selected.length) {
    const dated = new Set(selected.filter(row => row.inside && !row.period.approximate)
      .flatMap(row => row.children).filter(child => !conflicts.has(child)))
    const plausiblyDated = new Set(selected.filter(row => row.inside)
      .flatMap(row => row.children).filter(child => !conflicts.has(child)))
    const names = new Map()
    for (const row of selected.filter(row => row.inside)) {
      for (const [index, child] of row.children.entries()) if (plausiblyDated.has(child)) names.set(child, row.displayNames[index])
    }
    const everyReportedBirthDated = supporting.every(row => row.children.every(child => dated.has(child)))
    const complete = Boolean(dated.size && everyReportedBirthDated && !scan.incomplete && !plan.approximateWindow)
    const lead = complete ? `The memory records confirm ${dated.size} recorded births in the requested period.`
      : plan.approximateWindow && plausiblyDated.size
        ? `Using roughly three months for the requested period, the records name ${plausiblyDated.size} babies: ${[...names.values()].join(', ')}. Some dates are approximate. Report these names once each.`
        : dated.size ? `The originals confirm at least ${dated.size} recorded births in the requested period. The exact total is unknown.`
          : 'The available originals cannot establish the number of births in the requested period.'
    const injected = selected.map(row => {
      const timing = row.children.some(child => conflicts.has(child)) ? 'separate identity or date unconfirmed'
        : row.inside ? row.period.approximate ? 'approximate timing' : calendarOrderPeriod(row.period) : 'exact timing not established'
      const period = row.displayNames.join(' and ') + ' · ' + timing
      return { row, period, text: `- ${period} · “${row.quote}”` }
    })
    const text = [skipCapture ? '本轮不提炼。' : '', lead, ...injected.map(row => row.text)].filter(Boolean).join('\n')
    if (estimateTokens(text) <= maxTokens) {
      return { text, hits, injected, complete, scannedTokens: scan.tokens, budgetOmitted: scan.incomplete || selected.length < supporting.length,
        count: { topic: plan.topic, births: true, confirmed: dated.size, complete, range: plan.range, clock: plan.clock } }
    }
    selected.pop()
  }
  return { ...unavailable, hits, scannedTokens: scan.tokens, budgetOmitted: scan.incomplete || Boolean(supporting.length) }
}

export function retrieveEventCount(index, plan, { projectKey, now, maxTokens, maxItems, scanLimit, skipCapture }) {
  const unavailable = { text: '', hits: [], injected: [], complete: false, scannedTokens: 0, budgetOmitted: false,
    count: { topic: plan.topic, confirmed: 0, complete: false } }
  if (!plan.range) return unavailable
  if (plan.births) return retrieveBirthCount(index, plan, { projectKey, now, maxTokens, maxItems, scanLimit, skipCapture }, unavailable)
  const scan = index.findEvidence([plan.search], {
    projectKey, now, maxTokens: scanLimit, allMatches: true, wholeSentences: true, acceptOriginal: true,
    distinctKey: (_query, hit) => hit.record.id,
    match: (_query, hit) => {
      if (hit.record.sourceRefs[0].eventTime > now) return null
      const observations = eventObservations(hit.record, plan)
      const dinner = plan.dinnerParty ? dinnerStatements(hit.record) : []
      return observations.length || dinner.length ? { ...hit, observations, dinner } : null
    },
  })
  const available = index.validateMany(scan.matches.map(row => row.hit), projectKey, { now })
  const linked = plan.dinnerParty ? linkDinnerAttendance(available, plan) : []
  const { dated, uncertain, incomplete } = occurrenceRows(available, linked)
  const linkedSources = new Set(linked.flatMap(row => [row.hit.record.id, row.witness?.hit.record.id]))
  const hits = available.filter(hit => hit.observations.length || linkedSources.has(hit.record.id))
  let selected = [...dated, ...uncertain].slice(0, maxItems)
  const noSave = skipCapture ? '本轮不提炼。\n' : ''
  const fits = ({ text, injected }) => injected.length <= maxItems && estimateTokens(noSave + text) <= maxTokens
  let rankedWithinBudget = false
  while (selected.length > 0) {
    const confirmed = selected.filter(row => dated.includes(row)).length
    const complete = confirmed > 0 && !scan.incomplete && !incomplete && !uncertain.length && confirmed === dated.length
    const rendered = render(plan, selected.slice(0, confirmed), selected.slice(confirmed), complete)
    if (fits(rendered)) {
      const { text, injected } = rendered
      return { text: noSave + text, hits, injected, complete, scannedTokens: scan.tokens,
        budgetOmitted: scan.incomplete || selected.length < dated.length + uncertain.length,
        count: { topic: plan.topic, confirmed, complete, range: plan.range, clock: plan.clock } }
    }
    if (plan.dinnerParty && !rankedWithinBudget) {
      selected = fitDinnerEvidence(plan, dated, uncertain, fits)
      rankedWithinBudget = true
    } else selected.pop()
  }
  return { ...unavailable, hits, scannedTokens: scan.tokens, budgetOmitted: scan.incomplete || dated.length + uncertain.length > 0 }
}

export function matchesEventCountAnswer(answer, count) {
  if (!count?.complete) return false
  const text = String(answer ?? '').normalize('NFKC').replace(/[*_]+/gu, '').trim()
  if (UNKNOWN_ANSWER.test(text)) return false
  if (count.range && count.clock) {
    for (const [phrase] of text.matchAll(STATED_COUNT_WINDOW)) {
      const window = queryWindow(phrase, !/[\p{Script=Han}]/u.test(phrase))
      const range = window && eventCountWindow(count.clock, window)
      if (!range || range.from !== count.range.from || range.to !== count.range.to) return false
    }
  }
  const direct = readDayCount(text.replace(/[.。!！]+$/u, '').trim())
  if (Number.isSafeInteger(direct)) return direct === count.confirmed
  const terms = words(count.topic)
  const head = terms.at(-1)
  const pattern = new RegExp(String.raw`(?<![\w.-])(?<amount>${NUMBER})\s+(?:(?:recorded|confirmed|documented|of the)\s+){0,2}(?=(?<label>[a-z-]+(?:\s+[a-z-]+){0,5}))|(?<han>[一二两三四五六七八九十\d]+)\s*(?:次|场|个)`, 'giu')
  const values = new Set([...text.matchAll(pattern)].flatMap(match => {
    if (match.groups.han) return text.includes(count.topic) || /^(?:[一二两三四五六七八九十\d]+)\s*(?:次|场|个)[.。!！]*$/u.test(text)
      ? [readDayCount(match.groups.han)] : []
    const label = words(match.groups.label)
    return label[0] === 'attendance' || count.births && label[0] === 'birth' || head && label.includes(head)
      ? [readDayCount(match.groups.amount)] : []
  }))
  return values.size === 1 && values.has(count.confirmed)
}
