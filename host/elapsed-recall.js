import { readDayCount, sourceCalendarDay, sourceEventDate } from './calendar-recall.js'
import { estimateTokens } from './recall.js'
import { sourceSentences, withoutEvidencePreface } from './sentences.js'
import { DEEP_RECALL_TOKEN_LIMIT, isRecallSourceStatement } from './source-passages.js'
import { explicitRememberText } from './user-controls.js'
import { raceDurationSeconds, raceKey } from './time-measure-recall.js'

const DAY = 86_400_000
const WAIT = /^how\s+(?:many\s+(?<unit>days|weeks)|long)\s+did it take for (?:(?<recipient>me|us) to receive (?<received>.+?)|(?<delivered>.+?) to arrive) after (?<actor>I|we) (?<purchase>ordered|bought|purchased) (?<reference>.+)$/iu
const BETWEEN = /^how many (?<unit>days|weeks) (?:elapsed|passed) between (?:the (?:day|time) )?(?<actor>I|we) (?<purchase>ordered|bought|purchased) (?<subject>.+?) and (?:the (?:day|time) )?(?:(?<receiver>I|we) received (?<received>.+)|(?<delivered>.+?) arrived)$/iu
const READ = /^how\s+(?:many\s+(?<unit>days|weeks)|long)\s+did it take (?:for )?(?<recipient>me|us) to finish(?: reading)? (?<subject>[“"'‘].+)$/iu
const RACE_IMPROVEMENT = /^how much faster did (?<actor>I|we) (?:finish|complete|run) (?<race>[^,;!?]{2,90}?) (?:compared (?:to|with)|than) (?:(?<owner>my|our)\s+)?(?:previous|last) year['’]s (?:finish(?:ing)? )?time$/iu
const DRIVE_TOTAL = /^how many (?:hours|minutes)(?: in total)? did (?<actor>I|we) spend driving to (?<owner>my|our) (?<count>two|three|four|five|six|seven|eight|[2-8]) road[ -]trip destinations(?: combined| in total)?$/iu
const DRIVE_EXPERIENCE = /^(?<actor>I|we)(?:['’]ve|\s+have) had (?:[^,.;!?]{0,75}\s)?experiences? with [^,.;!?]{1,94},\s*like\s+/iu
const DIRECT_DRIVE = /^(?:when )?(?<actor>I|we) (?:(?:just|recently) )?drove (?:for |a total of )?(?<duration>[^,.;!?]{2,40}?) to (?<place>.+)$/iu
const NO_DRIVE = /^(?<actor>I|we) (?:(?:did not|didn['’]t) drive|never drove) to (?<place>.+)$/iu
const PAST_DRIVE_TRIP = /^(?:on )?(?<owner>my|our) (?:(?:recent|last|previous) )?(?:road[ -])?trip to (?<place>[^,;!?]{2,70}?)\s+[-–—]\s+(?<statement>.+)$/iu
const DRIVE_DURATION_THERE = /^(?:(?<actor>I|we) drove (?:for )?(?<driving>[^,.;!?]{2,42}?) to get there|it (?:only )?took (?<recipient>me|us) (?<taking>[^,.;!?]{2,42}?) to drive there)\b/iu
const DRIVE_DISPUTE = /\b(?:round[ -]trip|return trip|back from|there and back|each way|again|estimate|instead|not|never|over|under|nearly|about|roughly|around|approximately|between|maybe|might|would|could|at least|at most|or)\b/iu
const DIRECT_ROAD_TRIP = /\s+(?:on|during|for) (?<owner>my|our) (?:(?:previous|last|recent) )?road[ -]trip\b/iu
const FOLLOWUP_ROUTE = /\b(?:route|road|driving)\b[^?!]{0,90}\b(?<owner>my|our) next (?:road[ -])?trip\b/iu
const DRIVE_TIME_UNITS = /\b(?:hours?|minutes?|seconds?)\b/iu
const DRIVE_ANSWER_TAIL = /\s+(?:in total|total|(?:(?:of )?(?:one-way )?driving(?: to (?:the|your|my|our) (?:(?:two|three|four|five|six|seven|eight|[2-8]) )?(?:road[ -]trip )?destinations)?))$/iu
const CN_WAIT = /^我(?:们)?(?:从)?(?<purchase>下单|购买|买了?)(?<subject>[^，,。！？]{2,50}?)(?:后|以后|之后)[，,]?(?:一共)?(?:等了|过了|用了|隔了)(?:几|多少)(?<unit>天|周)(?:才)?(?:收到|拿到|送到|到货)(?:货|它)?$/u
const INTRO = /^(?:(?:oh,?\s+)?(?:and\s+)?(?:by the way|actually|for context)[,，]\s*|(?:顺便说一下|补充一下|实际上)[，,]\s*)/iu
const NOT_ASSERTED = /^(?:[“‘"'「『>]|(?:if|unless|imagine|suppose|when)\b)|\b(?:maybe|might|probably|planning|expected|would|should|had hoped|said|heard|claimed|never|not|canceled|cancelled|refunded|returned)\b|假如|假设|计划|预计|可能|据说|听说|转述|没有|没买|没收到|取消|退货|退款/iu
const BOUNDARY = /\s+[—–-]\s+(?=\S)(?!it(?:['’]s|\s+(?:has|is|feels|looks))\b)|[;；]|,\s*(?=(?:after|before|so)\b|(?:and|but)\s+(?:I|we|it|will|have)\b)|\s+(?=(?:and|but)\s+(?:I|we|it|will|have)\b)|[，,](?=(?:后来|但是|所以|然后|而且))/giu
const AFTER_NAME = /\s+(?=(?:from|on|at|online|today|yesterday|last|again)\b)|[,.!?;，。！？；]|(?:于|在)?(?=\d{1,4}(?:月|[/-]\d)|昨天|今天|前天)/iu
const NAME_END = /\s+(?=(?:has|have|is|are|feels?|looks?|seems?|and)\b)|[.!?;,]/iu
const VAGUE = /^(?:it|them|one|one of them|another|the same|the first|the other|它|这个|那个|一件)$/iu
const PERSONAL = String.raw`(?<actor>I|we)(?:['’]ve)?\s+(?:(?:have|had|just|also|already|actually|recently)\s+){0,4}`
const RACE_PERIOD = String.raw`last year|this year|today|yesterday|in [12]\d{3}`
const RACE_ACTIVITY = String.raw`(?<lead>${PERSONAL}(?:(?:got back into running|started running again)\s+and\s+(?:(?:just|recently)\s+)?)?)(?:finished|completed|ran|did|done)\s+(?<race>[^,;!?]{2,94}?)`
const RACE_TIMED = new RegExp(String.raw`^${RACE_ACTIVITY}(?:\s+(?<before>${RACE_PERIOD}))?\s+in\s+(?<duration>[^;!?]{1,70}?)(?:\s+(?<after>${RACE_PERIOD}))?$`, 'iu')
const RACE_TOOK = new RegExp(String.raw`^${RACE_ACTIVITY}\s+(?<before>${RACE_PERIOD})\s*[,;]\s*(?:(?:and|but)\s+)?it took\s+(?<recipient>me|us)\s+(?<duration>[^;!?]{1,66}?)\s+to\s+(?:finish|complete)(?:\s+it)?$`, 'iu')
const RACE_ANSWER_PERIOD = String.raw`this year|(?:last|previous) year|in [12]\d{3}`
const RACE_ANSWER_SPLIT = new RegExp(String.raw`(?<=\S\s)(${RACE_ANSWER_PERIOD})(?:[,;]\s*(?:and\s+)?|\s+(?:and|while)\s+)`, 'giu')
const RACE_ANSWER_PREFIX_PERIOD = new RegExp(String.raw`^(?<period>${RACE_ANSWER_PERIOD})\b,?\s+(?<body>.+)$`, 'iu')
const RACE_ANSWER_SUFFIX_PERIOD = new RegExp(String.raw`^(?<body>.+?)\s+(?<period>${RACE_ANSWER_PERIOD})$`, 'iu')
const RACE_ANSWER_LEAD = /^(?:(?:i|we|you)\s+(?:finished|completed|ran|took|was|were)|(?:it|my time|our time|your time)\s+(?:was|is))(?:\s+(?<race>.+))?$/iu
const RACE_ANSWER_DELTA = /^(?<body>.+?)\s+(?<direction>faster|slower)(?<thisYear>\s+this year)?(?:\s+(?:than|compared (?:to|with))\s+(?:(?:my|our|your|the)\s+)?(?:last|previous) year(?:['’]s (?:finishing )?time)?)?$/iu
const RACE_ANSWER_TIE = /^(?:the same (?:finishing )?time|tied|(?:i|we|you) tied (?:(?:my|our|your|the)\s+)?(?:last|previous) year['’]s (?:finishing )?time)$/iu
const RACE_ANSWER_EQUATION = /^(?<prior>.+?)\s*[-–−]\s*(?<recent>.+?)\s*=\s*(?<result>.+)$/u
const PURCHASED = new RegExp(String.raw`^${PERSONAL}(?<verb>bought|purchased|ordered|placed an order for)\s+(?<object>.+)$`, 'iu')
const CANCELLATION = new RegExp(String.raw`^${PERSONAL}cancel(?:l)?ed\s+(?:(?:my|our|the)\s+)?order\s+(?:for|of)\s+(?<object>.+)$`, 'iu')
const RECEIVED = new RegExp(String.raw`^${PERSONAL}received\s+(?<object>.+)$`, 'iu')
const GOT_AND_ARRIVED = new RegExp(String.raw`^${PERSONAL}got\s+(?<object>.+?)\s+(?:that|which)\s+arrived\b(?<date>.*)$`, 'iu')
const ARRIVED = /^(?:(?<owner>my|our)\s+(?<object>.+?)|(?<reference>it|they))\s+(?:arrived|was delivered|were delivered)\b(?<date>.*)$/iu
const READING = new RegExp(String.raw`^${PERSONAL}(?<verb>started|began|finished|completed)(?:\s+reading)?\s+(?<object>.+)$`, 'iu')
const USES = new RegExp(String.raw`^${PERSONAL}(?:started using|use|am using|are using|have|own)\s+(?<object>.+)$`, 'iu')
const KEEPS_REFERENCE = /^(?:(?:I|we)(?:['’]ve|\s+have)\s+been\s+using\s+it\b|it(?:['’]s|\s+(?:feels|looks|has|is))\b)/iu
const CN_DAY = String.raw`(?:\d{4}年)?\d{1,2}月\d{1,2}[日号]|今天|昨天|前天`
const CN_BOUGHT = new RegExp(String.raw`^我(?<plural>们)?(?:在?(?<date>${CN_DAY}))?(?:已经|刚刚|刚|也)?(?<verb>下单了?|购买了?|买了?)(?<object>.+)$`, 'u')
const CN_RECEIVED = new RegExp(String.raw`^我(?<plural>们)?(?:在?(?<date>${CN_DAY}))?(?:已经|刚刚|刚|也)?(?:收到了?|拿到了?|签收了?)(?<object>.+)$`, 'u')
const BOOK = /^(?:an?\s+[^,;!?]{1,45}\b(?:book|novel),\s*)?[“"'‘](?<title>[^“”"'‘’]{1,88})[”"'’](?:\s+by\s+(?<author>[^,!?;]+?))?(?=\s+(?:on|today|yesterday|last)\b|[,!?.;]|$)/iu
const REPEAT = /\b(?:again|a second time|another|replacement)\b|重新(?:买|订|下单|购买)|第二次|又买/iu
const ORDER_NUMBER = /\border\s*(?:#|number\s+|no\.?\s+)(?<code>[a-z0-9-]{3,36})\b/iu
const OTHER_EVENT = /\b(?:that|which|because|when|before|after)\b|之前|以后|因为/iu
const VALUE = String.raw`\d+(?:\.\d+)?|(?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)[ -][a-z]+|[a-z]+|[零一二两三四五六七八九十]+`
const ANSWER_DURATION = new RegExp(String.raw`(?<![\p{Script=Latin}\p{N}.零一二两三四五六七八九十])(?<value>${VALUE})\s*(?<unit>weeks?\b|days?\b|[周天])`, 'giu')
const EXCESS_PRECISION = /\b(?:about|approximately|roughly|around|at least|at most)\s+(?:\d|[a-z])|\bbetween\s+\d+\s+and\b|大约|大概|左右|至少|至多/iu
const DATE_LIKE = /[12]\d{3}[-/]\d{1,2}[-/]\d{1,2}|(?<![\w/])\d{1,2}\/\d{1,2}(?![\w/])|\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+[12]\d{3})?|(?:[12]\d{3}年)?\d{1,2}月\d{1,2}[日号]/giu

function normalized(text) {
  return text.normalize('NFKC').trim().toLowerCase().replace(/\s+/gu, ' ')
}

function itemName(text) {
  return normalized(text).replace(/^(?:(?:a|an|the|my|our|new|brand-new|another)\s+|(?:我的|我们的|这个|那个|新的?|一件|一台|一个))+/iu, '')
}

function bookReference(text) {
  const match = BOOK.exec(text)
  return match ? { subject: normalized(match.groups.title), author: normalized(match.groups.author ?? '') } : null
}

export function elapsedQuery(query) {
  const text = String(query ?? '').normalize('NFKC').trim().replace(/[?？。]+$/u, '')
  if (text.length > 255 || /[<>\n;；]/u.test(text)) return null
  const race = RACE_IMPROVEMENT.exec(text)?.groups
  if (race) {
    const subject = raceKey(race.race), actor = race.actor.toLowerCase()
    return subject && (!race.owner || (race.owner.toLowerCase() === 'my') === (actor === 'i'))
      ? { subject, actor, kind: 'race-improvement', language: 'en' } : null
  }
  const driving = DRIVE_TOTAL.exec(text)?.groups
  if (driving) {
    const actor = driving.actor.toLowerCase()
    return (actor === 'i') === (driving.owner.toLowerCase() === 'my')
      ? { kind: 'driving-total', actor, count: readDayCount(driving.count), subject: 'drove drive hours road trip' }
      : null
  }
  const reading = READ.exec(text)?.groups
  if (reading) {
    const book = bookReference(reading.subject)
    return book ? { ...book, unit: reading.unit?.toLowerCase() ?? 'days', kind: 'reading', actor: reading.recipient.toLowerCase() === 'me' ? 'i' : 'we', language: 'en' } : null
  }
  const wait = WAIT.exec(text)?.groups
  const between = BETWEEN.exec(text)?.groups
  const chinese = CN_WAIT.exec(text)?.groups
  const parts = wait ?? between ?? chinese
  if (!parts) return null
  const subject = itemName(parts.subject ?? parts.received ?? parts.delivered)
  if (subject.length < 2 || subject.length > 84 || VAGUE.test(subject) ||
      /\b(?:and|or|another|instead)\b|[&,，、]|(?:以及|或者)/iu.test(subject)) return null
  const actor = parts.actor?.toLowerCase() ?? (text.startsWith('我们') ? 'we' : 'i')
  if (wait?.recipient && (wait.recipient.toLowerCase() === 'me') !== (actor === 'i') ||
      between?.receiver && between.receiver.toLowerCase() !== actor) return null
  const reference = wait?.reference ?? (between ? between.received ?? between.delivered : '它')
  if (!/^(?:it|它)$/iu.test(reference) && itemName(reference) !== subject) return null
  return { subject, actor, kind: 'delivery', language: chinese ? 'zh' : 'en', unit: /^(?:周|weeks)$/iu.test(parts.unit ?? '') ? 'weeks' : 'days',
    purchase: /^(?:ordered|下单)$/iu.test(parts.purchase) ? 'order' : 'purchase' }
}

function phaseStatement(text, plan) {
  if (plan.kind === 'reading') {
    const read = READING.exec(text)?.groups
    if (!read || read.actor.toLowerCase() !== plan.actor) return null
    const book = bookReference(read.object)
    if (!book || book.subject !== plan.subject || plan.author && book.author !== plan.author) return null
    return { phase: /^(?:started|began)$/iu.test(read.verb) ? 0 : 1, object: plan.subject }
  }
  const bought = PURCHASED.exec(text)?.groups ?? CN_BOUGHT.exec(text)?.groups
  if (bought) {
    const actor = bought.actor?.toLowerCase() ?? (bought.plural ? 'we' : 'i')
    const ordered = /^(?:ordered|placed an order for|下单)/iu.test(bought.verb)
    return actor !== plan.actor || ordered !== (plan.purchase === 'order') || OTHER_EVENT.test(bought.object) ? null
      : { phase: 0, object: itemName(bought.object.split(AFTER_NAME, 1)[0]) }
  }
  const received = RECEIVED.exec(text)?.groups ?? GOT_AND_ARRIVED.exec(text)?.groups
    ?? CN_RECEIVED.exec(text)?.groups ?? ARRIVED.exec(text)?.groups
  if (!received) return null
  const actor = received.actor?.toLowerCase() ?? (received.plural || /^our$/iu.test(received.owner ?? '') ? 'we' : 'i')
  if (actor !== plan.actor && !received.reference || OTHER_EVENT.test(received.object ?? '')) return null
  return { phase: 1, object: received.reference?.toLowerCase() ?? itemName(received.object.split(AFTER_NAME, 1)[0]),
    ...(received.date ? { dated: received.date } : {}) }
}

function identifiesOwnedItem(text, plan) {
  const owned = USES.exec(text)?.groups
  if (owned) return owned.actor.toLowerCase() === plan.actor && itemName(owned.object.split(NAME_END, 1)[0]) === plan.subject
  const mention = /^(?<owner>my|our)\s+(?<object>[^!?;]+)$/iu.exec(text)?.groups
  if (!mention || (/^my$/iu.test(mention.owner) ? 'i' : 'we') !== plan.actor) return false
  const noun = itemName(mention.object.split(NAME_END, 1)[0])
  if (noun === plan.subject) return true
  // An owned object can be described by its purpose in the same statement.
  const [purpose, head, rest] = plan.subject.split(' ')
  return rest === undefined && head === noun &&
    [...text.matchAll(/\b(?:has|have|got|with)\s+(?:(?:plenty of|enough|some)\s+)?(?:room|space|capacity)\s+for\s+(?:(?:my|our|an?)\s+)?([a-z]+)(?=$|[,.!?;]|\s+and\b)/giu)]
      .some(match => normalized(match[1]) === purpose)
}

function observations(record, plan) {
  const results = []
  let anchor = null, offset = 0
  for (const sentence of sourceSentences(record.content)) {
    const start = record.content.indexOf(sentence, offset)
    offset = start + sentence.length
    if (!isRecallSourceStatement(sentence)) { anchor = null; continue }
    const clauses = [...sentence.matchAll(BOUNDARY)]
    let from = 0
    for (const separator of [...clauses, { index: sentence.length, 0: '' }]) {
      const quote = sentence.slice(from, separator.index).trim()
      const at = start + from
      from = separator.index + separator[0].length
      if (!quote) continue
      const value = (explicitRememberText(quote) ?? quote).replace(INTRO, '').replace(/^(?:and|but)\s+/iu, '')
      const cancelled = plan.kind === 'delivery' ? CANCELLATION.exec(value)?.groups : null
      if (cancelled?.actor.toLowerCase() === plan.actor && itemName(cancelled.object.split(AFTER_NAME, 1)[0]) === plan.subject) {
        results.push({ repeated: true })
      }
      if (NOT_ASSERTED.test(value)) { anchor = null; break }
      const parsed = phaseStatement(value, plan)
      const refers = Boolean(parsed && /^(?:it|它)$/iu.test(parsed.object))
      const boundToItem = parsed?.object === plan.subject || refers && anchor !== null && at - anchor <= 250
      if (boundToItem && !EXCESS_PRECISION.test(parsed.dated ?? value)) {
        const proof = sourceEventDate(record, quote, { dated: parsed.dated ?? quote, allowZonelessAbsolute: true })
        const original = refers ? record.content.slice(anchor, start + separator.index).trim() : quote
        if (proof.day !== null) results.push({ phase: parsed.phase, day: proof.day, quote: original, repeated: REPEAT.test(value),
          orderNumber: ORDER_NUMBER.exec(value)?.groups.code.toLowerCase() })
      }
      if (plan.kind === 'delivery' && (parsed?.object === plan.subject || identifiesOwnedItem(value, plan))) anchor = at
      else if (anchor === null || !KEEPS_REFERENCE.test(value)) anchor = null
    }
  }
  return results
}

function durationLabel(days, plan) {
  const zh = plan.language === 'zh'
  const duration = days + (zh ? ' 天' : days === 1 ? ' day' : ' days')
  if (plan.unit !== 'weeks' || days % 7 !== 0) return duration
  const weeks = days / 7
  return duration + ' = ' + weeks + (zh ? ' 周' : weeks === 1 ? ' week' : ' weeks')
}

function raceObservations(record, plan, now, queryTimeZone) {
  const facts = []
  for (const quote of sourceSentences(record.content)) {
    if (!isRecallSourceStatement(quote) || NOT_ASSERTED.test(quote)) continue
    const text = quote.normalize('NFKC').replace(INTRO, '').replace(/[.!]+$/u, '')
    const fact = (RACE_TIMED.exec(text) ?? RACE_TOOK.exec(text))?.groups
    if (!fact || fact.actor.toLowerCase() !== plan.actor || raceKey(fact.race) !== plan.subject ||
        fact.recipient && (fact.recipient.toLowerCase() === 'me') !== (plan.actor === 'i') ||
        fact.before && fact.after) continue
    const seconds = raceDurationSeconds(fact.duration)
    if (seconds === null) continue
    const period = (fact.before ?? fact.after)?.toLowerCase()
    if (!period && !/\b(?:recently|just)\b/iu.test(fact.lead)) continue
    const clocks = (record.sourceRefs ?? []).filter(ref =>
      ref.sourceId && ref.role === 'user' && ref.sourceKind === 'user' && ref.excerpt?.includes(quote))
    const yearAt = day => new Date(day * DAY).getUTCFullYear()
    const years = new Map()
    for (const ref of clocks) {
      const originalDay = sourceCalendarDay(ref)
      const questionDay = sourceCalendarDay({ eventTime: now, timeZone: queryTimeZone ?? ref.timeZone })
      if (originalDay === null || questionDay === null || ref.eventTime > now) continue
      const originalYear = yearAt(originalDay), questionYear = yearAt(questionDay)
      // An undated recent result supplies a time, but its message date does not date the race.
      const eventYear = !period ? null : period === 'last year' ? originalYear - 1
        : period === 'yesterday' ? yearAt(originalDay - 1)
          : period.startsWith('in ') ? Number(period.slice(3)) : originalYear
      if (eventYear === null ? originalYear !== questionYear : eventYear > originalYear) continue
      years.set(eventYear + ':' + questionYear, { eventYear, questionYear })
    }
    if (years.size !== 1) continue
    const { eventYear, questionYear } = years.values().next().value
    if (eventYear !== null && eventYear !== questionYear - 1 && eventYear !== questionYear) continue
    facts.push({ phase: eventYear === questionYear - 1 ? 0 : 1, year: eventYear, questionYear, seconds, quote })
  }
  return facts
}

function drivingDestinationKey(place) {
  return place.toLowerCase().trim().replace(/^the\s+/u, '').replace(/[.]/gu, '')
}

function driveObservations(record, plan) {
  const found = []
  for (const original of sourceSentences(record.content)) {
    const narrative = original.replace(INTRO, '').replace(/^(?:oh,? and )?by the way,\s+/iu, '')
    const quote = narrative.split(/,\s+but\s+(?=(?:I['’]m not sure|we['’]re not sure)\b)/iu, 1)[0]
    if (!isRecallSourceStatement(quote)) continue
    const experience = DRIVE_EXPERIENCE.exec(quote)
    if (experience && experience.groups.actor.toLowerCase() !== plan.actor) continue
    const text = quote.slice(experience?.[0].length ?? 0)
    const direct = DIRECT_DRIVE.exec(text)?.groups
    if (!experience && /^when\s+/iu.test(text)) continue
    const denial = NO_DRIVE.exec(text)?.groups
    const trip = direct || denial ? null : PAST_DRIVE_TRIP.exec(text)?.groups
    const there = trip && DRIVE_DURATION_THERE.exec(trip.statement)?.groups
    if (!direct && !denial && (!there || (trip.owner.toLowerCase() === 'my') !== (plan.actor === 'i'))) continue
    const actor = direct?.actor ?? denial?.actor ?? there.actor ?? (there.recipient.toLowerCase() === 'me' ? 'I' : 'we')
    if (actor.toLowerCase() !== plan.actor) continue
    const rawPlace = direct?.place ?? denial?.place ?? trip.place
    const duration = direct?.duration ?? there?.driving ?? there?.taking ?? ''
    const explicitTrip = direct && DIRECT_ROAD_TRIP.exec(rawPlace)
    const followedByRoute = direct && experience && FOLLOWUP_ROUTE.exec(narrative.slice(quote.length))
    const frame = explicitTrip || followedByRoute
    if (direct && (!frame || (frame.groups.owner.toLowerCase() === 'my') !== (plan.actor === 'i'))) continue
    const destination = explicitTrip ? rawPlace.slice(0, explicitTrip.index) : rawPlace
    const place = destination.split(/,|\s+(?:recently|today|yesterday|last|from|and then|because|for)\b/iu, 1)[0]
      .trim().replace(/(?<!\b[A-Z])\.$/u, '')
    if (!/(?:^|\s)\p{Lu}[\p{L}\p{N}.'’-]*$/u.test(place) ||
        !/^[\p{L}][\p{L}\p{N} .'’()-]{1,60}$/u.test(place) || /\b(?:and|or)\b/iu.test(place) ||
        DRIVE_DISPUTE.test(duration + ' ' + rawPlace) || trip && DRIVE_DISPUTE.test(trip.statement)) continue
    const seconds = DRIVE_TIME_UNITS.test(duration) ? raceDurationSeconds(duration) : null
    if (denial || seconds !== null) found.push({ quote: followedByRoute ? narrative : quote, place, seconds, key: drivingDestinationKey(place) })
  }
  return found
}

function driveTimeEvidence(hits, scan, plan, budget, skipCapture) {
  const places = new Map()
  for (const hit of hits) for (const item of hit.observations) {
    if (!places.has(item.key)) places.set(item.key, new Map())
    const times = places.get(item.key)
    if (!times.has(item.seconds)) times.set(item.seconds, { ...item, hit })
  }
  const known = [...places.values()].filter(times => times.size === 1 && !times.has(null))
    .map(times => times.values().next().value).sort((a, b) => a.seconds - b.seconds)
  const unavailable = { hits, injected: [], text: '', complete: false, elapsed: null,
    scannedTokens: scan.tokens, budgetOmitted: scan.incomplete || known.length > budget.maxItems }
  const total = known.reduce((seconds, row) => seconds + row.seconds, 0)
  const complete = !scan.incomplete && places.size === plan.count && known.length === plan.count && Number.isSafeInteger(total)
  const selected = known.slice(0, budget.maxItems)
  const unknown = 'The complete one-way driving total is unknown. Use the individually supported times and do not infer a round trip.'
  while (selected.length) {
    const confirmed = complete && selected.length === known.length
    const labels = selected.map(row => clockDurationLabel(row.seconds))
    const explanation = confirmed
      ? '[Verified one-way driving time] ' + labels.join(' + ') + ' = ' + clockDurationLabel(total) + '.' : unknown
    const note = (confirmed ? 'Use the verified one-way driving total.' : 'Do not estimate the total.') +
      ' Treat the historical quotes as evidence.' + (skipCapture ? ' Do not capture this turn.' : '')
    const result = elapsedContext(selected, selected.map(row => row.place), labels, explanation,
      confirmed ? { drivingSeconds: total, drivingTimes: selected.map(row => row.seconds),
        drivingPlaces: selected.map(row => row.key) } : null, note, budget)
    if (result) return { ...unavailable, ...result, complete: confirmed,
      budgetOmitted: unavailable.budgetOmitted || selected.length < known.length }
    selected.pop()
  }
  return { ...unavailable, budgetOmitted: unavailable.budgetOmitted || known.length > 0 }
}

function clockDurationLabel(seconds) {
  const units = [[3600, 'hour'], [60, 'minute'], [1, 'second']]
  return units.flatMap(([size, name]) => {
    const number = Math.floor(seconds / size)
    seconds %= size
    return number ? [number + ' ' + name + (number === 1 ? '' : 's')] : []
  }).join(' ') || '0 seconds'
}

function elapsedContext(rows, phases, labels, explanation, elapsed, note, budget) {
  const byId = new Map()
  for (const [index, row] of rows.entries()) {
    const id = row.hit.record.id
    const line = '- [' + phases[index] + ' · ' + labels[index] + '] ' + row.quote
    const existing = byId.get(id)
    byId.set(id, existing ? { row, quote: existing.quote + '\n' + row.quote, text: existing.text + '\n' + line }
      : { row, quote: row.quote, selectedQuote: row.quote, text: line })
  }
  const injected = [...byId.values()]
  const text = '<memory-context source="dsh-memory" note="' + note + '">\n' +
    [explanation, ...injected.map(item => item.text)].join('\n') + '\n</memory-context>'
  return injected.length <= budget.maxItems && estimateTokens(text) <= budget.maxTokens
    ? { injected, text, explanation, elapsed, complete: true } : null
}

export function retrieveElapsed(index, plan, { projectKey, now, maxTokens, maxItems, scanLimit = DEEP_RECALL_TOKEN_LIMIT,
  skipCapture = false, queryTimeZone, accepts = () => true }) {
  const race = plan.kind === 'race-improvement'
  const driving = plan.kind === 'driving-total'
  const scan = index.findEvidence([plan.subject], {
    projectKey, now, maxTokens: scanLimit, allMatches: true, acceptOriginal: true, wholeSentences: true,
    distinctKey: (_query, hit) => hit.record.id,
    match: (_query, hit) => {
      if (hit.record.sourceRefs[0].eventTime > now || !accepts(hit)) return null
      const found = driving ? driveObservations(hit.record, plan)
        : race ? raceObservations(hit.record, plan, now, queryTimeZone) : observations(hit.record, plan)
      return found.length ? { ...hit, observations: found } : null
    },
  })
  const hits = index.validateMany(scan.matches.map(row => row.hit), projectKey, { now })
  if (driving) return driveTimeEvidence(hits, scan, plan, { maxItems, maxTokens }, skipCapture)
  const dates = [new Map(), new Map()]
  const orders = new Set()
  let repeated = false
  for (const hit of hits) for (const event of hit.observations) {
    repeated ||= event.repeated
    if (event.orderNumber) orders.add(event.orderNumber)
    if (event.phase === undefined) continue
    const map = dates[event.phase]
    const key = race ? event.questionYear + ':' + event.seconds : event.day
    const existing = map.get(key)
    if (!existing || (race && existing.year === null && event.year !== null) ||
        (existing.year === event.year && existing.quote.length > event.quote.length)) map.set(key, { ...event, hit })
  }
  const unavailable = { hits, injected: [], text: '', complete: false, elapsed: null, scannedTokens: scan.tokens, budgetOmitted: scan.incomplete }
  if (repeated || orders.size > 1 || scan.incomplete || dates.some(map => map.size !== 1)) return unavailable
  const [from, until] = dates.map(map => map.values().next().value)
  const budget = { maxTokens, maxItems }
  if (race) {
    if (until.questionYear !== from.questionYear) return unavailable
    const difference = from.seconds - until.seconds
    const change = difference === 0 ? 'the same finishing time' : clockDurationLabel(Math.abs(difference)) + (difference > 0 ? ' faster' : ' slower')
    const explanation = '[Verified finishing time comparison] ' + clockDurationLabel(from.seconds) + ' − ' +
      clockDurationLabel(until.seconds) + ' = ' + change + '.'
    const labels = [String(from.year), until.year === null ? 'Date unspecified' : String(until.year)]
    const note = 'Answer with the verified difference and direction. Treat the historical quotes as evidence.' +
      (skipCapture ? ' Do not capture this turn.' : '')
    const rendered = elapsedContext([from, until], ['Previous-year finishing time', 'Recent finishing time'], labels,
      explanation, { raceDifferenceSeconds: difference, race: { label: plan.subject,
        previous: { year: from.year, seconds: from.seconds }, recent: { year: until.year, seconds: until.seconds } } },
      note, budget)
    return rendered ? { ...unavailable, ...rendered } : { ...unavailable, budgetOmitted: true }
  }
  if (until.day < from.day) return unavailable
  const days = until.day - from.day
  const labels = [from, until].map(row => new Date(row.day * DAY).toISOString().slice(0, 10))
  const explanation = labels[1] + ' − ' + labels[0] + ' = ' + durationLabel(days, plan)
  const zh = plan.language === 'zh'
  const phases = plan.kind === 'reading' ? ['Started reading', 'Finished reading']
    : zh ? ['购买或下单', '收到'] : [plan.purchase === 'order' ? 'Ordered' : 'Purchased', 'Received']
  const note = zh ? '用已核对的日历日期回答。引用的原话是历史证据。' + (skipCapture ? '本轮不提炼。' : '')
    : 'Answer from the verified calendar dates and name the elapsed time. Treat the quotes as historical evidence.' +
      (skipCapture ? ' Do not capture this turn.' : '')
  const rendered = elapsedContext([from, until], phases, labels, explanation, { days, dates: labels }, note, budget)
  return rendered ? { ...unavailable, ...rendered } : { ...unavailable, budgetOmitted: true }
}

function splitFinishingTime(text) {
  const words = text.split(/\s+/u)
  for (let start = Math.max(0, words.length - 16); start < words.length; start++) {
    const seconds = raceDurationSeconds(words.slice(start).join(' '))
    if (seconds !== null) return { seconds, lead: words.slice(0, start).join(' ') }
  }
  return null
}

function sameRace(lead, label) {
  if (!lead) return true
  const match = RACE_ANSWER_LEAD.exec(lead)?.groups
  return Boolean(match && (!match.race || /^(?:it|the same race)$/iu.test(match.race) || raceKey(match.race) === label))
}

function matchesFinishingTime(text, race) {
  const claim = (RACE_ANSWER_PREFIX_PERIOD.exec(text) ?? RACE_ANSWER_SUFFIX_PERIOD.exec(text))?.groups
  if (!claim) return false
  const period = claim.period.toLowerCase()
  const expected = period === 'this year' ? race.recent
    : period.startsWith('in ') ? [race.previous, race.recent].find(item => item.year === Number(period.slice(3)))
      : race.previous
  if (expected?.year == null) return false
  const value = splitFinishingTime(claim.body)
  return value?.seconds === expected.seconds && sameRace(value.lead.replace(/(?:^|\s)in$/iu, ''), race.label)
}

function raceDifferenceIn(text, race) {
  if (RACE_ANSWER_TIE.test(text)) return 0
  const simple = raceDurationSeconds(text)
  if (simple !== null) return simple
  const claim = RACE_ANSWER_DELTA.exec(text)?.groups
  if (!claim || (claim.thisYear && race.recent.year === null)) return null
  const value = splitFinishingTime(claim.body)
  return value && sameRace(value.lead, race.label)
    ? value.seconds * (claim.direction.toLowerCase() === 'slower' ? -1 : 1) : null
}

function matchesRaceDifference(text, { race, raceDifferenceSeconds }) {
  if (!race || /\b(?:not|never|might|maybe|could|if)\b|n['’]t\b/iu.test(text)) return false
  let verifiedDifference = false
  const sentences = sourceSentences(text.normalize('NFKC').replace(/\*\*([^*\r\n]+)\*\*/gu, '$1'))
  for (const sentence of sentences) {
    const statement = withoutEvidencePreface(sentence.trim().replace(/[.!]+$/u, ''))
    const equation = RACE_ANSWER_EQUATION.exec(statement)?.groups
    if (equation && (raceDurationSeconds(equation.prior) !== race.previous.seconds ||
        raceDurationSeconds(equation.recent) !== race.recent.seconds)) return false
    const clauses = equation ? [equation.result] : statement.replace(RACE_ANSWER_SPLIT, '$1\n').split('\n')
    for (const clause of clauses) {
      const difference = raceDifferenceIn(clause, race)
      if (difference === null) {
        if (!matchesFinishingTime(clause, race)) return false
      } else {
        if (difference !== raceDifferenceSeconds) return false
        verifiedDifference = true
      }
    }
  }
  return verifiedDifference
}

function matchesDrivingAnswer(answer, { drivingSeconds, drivingTimes, drivingPlaces }) {
  const text = withoutEvidencePreface(answer.normalize('NFKC').replace(/[*_]+/gu, '').trim())
  if (DRIVE_DISPUTE.test(text)) return false
  const [first, breakdown, ...unverified] = sourceSentences(text)
  if (!first || unverified.length) return false
  const line = first.replace(/[.!]+$/u, '')
  const [left, right, ...extra] = line.split(/\s*=\s*/u)
  if (extra.length) return false
  if (right) {
    const claimed = left.split(/\s*\+\s*/u).map(raceDurationSeconds).sort((a, b) => a - b)
    return !breakdown && raceDurationSeconds(right) === drivingSeconds && claimed.length === drivingTimes.length &&
      claimed.every((seconds, index) => seconds === drivingTimes[index])
  }
  const duration = line.replace(/^(?:(?:you|I|we) spent (?:a total of )?|(?:the )?total(?: (?:one-way )?driving time)? (?:was|is) )/iu, '')
    .replace(DRIVE_ANSWER_TAIL, '').trim()
  if (!DRIVE_TIME_UNITS.test(duration) || raceDurationSeconds(duration) !== drivingSeconds) return false
  if (!breakdown) return true
  const details = /^(?:(?:this is |it was )?calculated by adding (?:the )?(?:hours|times) for each destination|(?:the )?(?:breakdown|list of driving times)(?: is)?)\s*:\s*(.+)$/iu.exec(breakdown)?.[1]
  if (!details || !drivingPlaces) return false
  const claimed = new Map()
  for (const item of details.split(/,\s*(?:and\s+)?|\s+and\s+/iu)) {
    const pair = /^(?<time>[^,:;]{2,37}?)\s+(?:for|(?:driving )?to)\s+(?<place>[^,;!?]{2,65})$/iu.exec(item)?.groups
    if (!pair) return false
    const key = drivingDestinationKey(pair.place)
    if (claimed.has(key)) return false
    claimed.set(key, raceDurationSeconds(pair.time))
  }
  return drivingPlaces.length === claimed.size && drivingPlaces.every((key, index) => claimed.get(key) === drivingTimes[index])
}

export function matchesElapsedAnswer(answer, elapsed) {
  if (!elapsed || EXCESS_PRECISION.test(answer) || /\b(?:cannot|unable|unknown|could not|not enough|uncertain)\b|不能|无法|不确定|未知/iu.test(answer)) return false
  if (Number.isSafeInteger(elapsed.drivingSeconds)) return matchesDrivingAnswer(answer, elapsed)
  if (Number.isSafeInteger(elapsed.raceDifferenceSeconds)) return matchesRaceDifference(answer, elapsed)
  const values = [...answer.normalize('NFKC').matchAll(ANSWER_DURATION)].map(({ groups }) => {
    const count = /^\d/u.test(groups.value) ? Number(groups.value) : /^an?$/iu.test(groups.value) ? 1 : readDayCount(groups.value)
    return count * (/^(?:w|周)/iu.test(groups.unit) ? 7 : 1)
  }).filter(Number.isFinite)
  if (/\b(?:the same day|same-day)\b|同一天|当日送达/iu.test(answer)) values.push(0)
  if (values.length === 0 || values.some(value => value !== elapsed.days)) return false
  const stated = [...answer.matchAll(DATE_LIKE)]
  if (stated.length === 0) return true
  const expected = elapsed.dates.map(value => Date.parse(value + 'T00:00:00Z') / DAY)
  const parse = (text, date) => {
    const at = Date.parse(date.slice(0, 4) + '-12-31T12:00:00Z')
    return sourceEventDate({ sourceRefs: [{ sourceId: 'answer', role: 'user', sourceKind: 'user',
      excerpt: text, from: 0, to: text.length, at, eventTime: at, timeZone: 'UTC' }] }, text).day
  }
  const positions = stated.map(({ 0: text }) => elapsed.dates.map(date => parse(text, date)))
  return positions.every(row => row.some((day, index) => day === expected[index])) &&
    (!/\bfrom\b.+\bto\b|从.+到/iu.test(answer) || positions.length !== 2 ||
      positions[0][0] === expected[0] && positions[1][1] === expected[1])
}
