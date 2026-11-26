import { calendarLookbackStart, calendarOccurrenceBounds, calendarOrderClauses, calendarOrderDateKey,
  calendarOrderPeriod, calendarPrecedes, matchesTimelineDate, readDayCount } from './calendar-recall.js'
import { estimateTokens } from './recall.js'
import { isRecallSourceStatement } from './source-passages.js'

const EN_ORDER = /^(?:what (?:is|was) the order of|list) (?:the )?(?:(?<count>\d+|[a-z]+) )?(?<topic>trips?|journeys?|museums?) (?:I|we) (?<verb>visited|went to|took|made|went on)(?: in the (?:past|last) (?<span>\d+|[a-z]+) (?<unit>days?|weeks?|months?|years?))?(?:(?:\s*,\s*|\s+)(?:from )?(?<order>earliest to latest|latest to earliest|in chronological order))?$/iu
const ZH_ORDER = /^(?:请|帮我)?按(?:时间|先后)(?:顺序)?(?:列出|排一下)(?:我(?:们)?)?(?:最近(?<span>[一二两三四五六七八九十\d]+)(?<unit>天|周|个月|年))?(?:(?:去过|参观过)的)?(?:(?<count>[一二两三四五六七八九十\d]+|几)(?:个|次))?(?<topic>博物馆|旅行|旅程)$/u
const TIMELINE_SEARCH = {
  museum: 'museum museums 博物馆 参观 visited attended touring exhibition',
  trip: 'trip trips journey travel hike hiking vacation camping road 旅行 旅游 徒步 露营',
}
const VISIT_VERB = /^(?:visited|went to)$/iu
const PERSONAL = String.raw`(?<![\p{L}\p{N}])(?:I|we)(?:['’]ve)?\s+(?:(?:have|had|just|recently|actually|already|also)\s+){0,4}`
const RETURN = 'got back from|came back from|returned from'
const EN_MUSEUM = new RegExp(PERSONAL + String.raw`(?<action>${RETURN}|visited|went to|toured|saw|attended|joined|participated in|took)\s+`, 'iu')
const EN_TRIP = new RegExp(PERSONAL + String.raw`(?<action>${RETURN}|took|made|went on|went for|started|began|finished|completed)\s+(?:(?:a|an|the|my|our)\s+)?(?<type>(?:[a-z'-]+\s+){0,5}(?:trip|journey|vacation|holiday|hike|outing))(?:\s+with\s+(?<companions>[a-z' ]{1,30}?))?\s+to\s+`, 'iu')
const WORD = String.raw`[\p{Lu}][\p{L}\p{M}\p{N}'’-]*`
const TITLE = String.raw`${WORD}(?:(?:\s+(?:and|of|the|de|la))?\s+${WORD}){0,8}`
const MUSEUM_NAME = new RegExp(String.raw`(?<![\p{L}\p{N}])(?<name>(?:${WORD}\s+){0,6}Museum(?:\s+of\s+${TITLE})?)\b`, 'gu')
const TRIP_PLACE = new RegExp(String.raw`^(?:the\s+)?(?<name>${TITLE})`, 'u')
const ZH_MUSEUM = /我(?:们)?[^，。！？；]{0,18}?(?:参观了|去过|去了|游览了)(?<name>[\p{Script=Han}A-Za-z\d·]{1,27}博物馆)/u
const ZH_TRIP = /我(?:们)?[^，。！？；]{0,18}?(?:去|到)(?<name>[\p{Script=Han}A-Za-z\d·]{1,27}?)(?<type>旅行|旅游|度假|露营|徒步|自驾)/u
const UNSUPPORTED = /(?:没有|没去|没参观|未去|不曾|打算|提议|假设|听说|转述|线上|虚拟|\b(?:if|never|not|said|told|wrote|imagined|planning|would|will|might|online|virtual|virtually)\b)/iu
const TOUR_OR_VISIT = /\b(?:lectures?|presentations?|exhibit(?:ion)?s?|tours?|visits?|trips?|receptions?|events?)(?:\s+series)?\s+(?:at|in|of|to)\s+(?:the\s+)?$/iu
const TRIP_COMPANIONS = /^(?:my |our |some |the )?(?:family|friends|colleagues|partner|parents)\b/iu
const QUOTED_LEAD = /["“「『]|^\s*['‘]/u

export function openTimelineQuery(query, reference) {
  const text = query.normalize('NFKC').trim().replace(/[?？。！!]+$/u, '')
  if (text.length > 260) return null
  const english = EN_ORDER.exec(text)
  const match = english ?? ZH_ORDER.exec(text)
  if (!match) return null
  const { count, topic, verb, span, unit, order } = match.groups
  const museum = /museum|博物馆/iu.test(topic)
  if (english && museum !== VISIT_VERB.test(verb)) return null
  const requested = readDayCount(count ?? '')
  const amount = readDayCount(span ?? '')
  if (span && (!Number.isSafeInteger(amount) || amount < 1)) return null
  const periodUnit = english ? unit : { 天:'days', 周:'weeks', 个月:'months', 年:'years' }[unit]
  const from = span ? calendarLookbackStart(reference, amount, periodUnit.toLowerCase()) : null
  const kind = museum ? 'museum' : 'trip'
  return { kind, language:english ? 'en' : 'zh', count:requested > 0 ? requested : null, from, zone:reference.timeZone,
    windowUnknown:Boolean(span && from === null), reverse:order?.toLowerCase() === 'latest to earliest', search:TIMELINE_SEARCH[kind] }
}

function museumsIn(text) {
  return [...text.matchAll(MUSEUM_NAME)].flatMap(match => {
    const title = match.groups.name.replace(/['’]s$/u, '')
    const name = title.replace(/^The\s+/u, '')
    return name === 'Museum' ? [] : [{ name, at:match.index, end:match.index + title.length }]
  })
}

function ownsStatement(quote, start) {
  const lead = quote.slice(0, start)
  return !UNSUPPORTED.test(lead) && !QUOTED_LEAD.test(lead)
}

function museumOccurrence(quote, record) {
  const match = EN_MUSEUM.exec(quote)
  if (!match || !ownsStatement(quote, match.index) || /\b(?:online|virtual|virtually)\b/iu.test(quote)) return null
  const body = quote.slice(match.index + match[0].length)
  const named = museumsIn(body)
  const action = match.groups.action.toLowerCase()
  let venue
  if (named.length === 1) {
    const beforeVenue = body.slice(0, named[0].at)
    const direct = /^(?:the\s+)?$/iu.test(beforeVenue)
    const attached = /\b(?:at|in)\s+(?:the\s+)?$/iu.test(beforeVenue)
    const possessive = /^['’]s\s/u.test(body.slice(named[0].end))
    if (action === 'took' ? /\bto\s+(?:the\s+)?$/iu.test(beforeVenue)
      : action === 'saw' ? attached && /\bin person\b/iu.test(beforeVenue)
      : action === 'visited' || action === 'went to' || action === 'toured' ? direct || attached
      : TOUR_OR_VISIT.test(beforeVenue) || direct && (possessive || /(?:back|returned) from/u.test(action))) venue = named[0].name
  } else if (named.length === 0 && /^(?:their|its)\s+(?:guided\s+)?tour\b/iu.test(body)) {
    const [ref] = record.sourceRefs
    if (ref.from !== 0 || ref.to !== record.sourceLength) return null
    const earlier = new Set(museumsIn(record.content.slice(0, record.content.indexOf(quote))).map(item => item.name))
    if (earlier.size === 1 && /^(?:attended|joined|participated in)$/u.test(action)) venue = earlier.values().next().value
  }
  return venue ? { name:venue, returned:/back from|returned from/iu.test(match.groups.action) } : null
}

function tripOccurrence(quote) {
  const match = EN_TRIP.exec(quote)
  if (!match || !ownsStatement(quote, match.index) || /\b(?:online|virtual|virtually)\b/iu.test(quote)) return null
  const rest = quote.slice(match.index + match[0].length)
  const place = TRIP_PLACE.exec(rest)
  if (!place) return null
  const afterPlace = /^\s+(?:(?:today|yesterday)\s+)?with\s+(.+)$/iu.exec(rest.slice(place[0].length))?.[1]
  const companions = TRIP_COMPANIONS.exec(match.groups.companions ?? afterPlace ?? '')?.[0]
  return { name:place.groups.name, type:match.groups.type.toLowerCase(), companions,
    returned:/back from|returned from|finished|completed/iu.test(match.groups.action) }
}

function occurrenceFor(quote, record, kind) {
  const english = kind === 'museum' ? museumOccurrence(quote, record) : tripOccurrence(quote)
  if (english) return english
  if (UNSUPPORTED.test(quote)) return null
  const match = (kind === 'museum' ? ZH_MUSEUM : ZH_TRIP).exec(quote)
  return match && ownsStatement(quote, match.index) ? { ...match.groups, returned:false } : null
}

function observations(record, plan) {
  const rows = []
  for (const quote of calendarOrderClauses(record.content)) {
    const statement = quote.trim()
    if (!isRecallSourceStatement(statement)) continue
    const occurrence = occurrenceFor(statement, record, plan.kind)
    if (!occurrence) continue
    const dated = statement.replace(/"[^"\n]+"|“[^”\n]+”/gu, 'the exhibition')
    const bound = calendarOccurrenceBounds(record, statement, { dated, returned:occurrence.returned })
    if (!bound || plan.from !== null && calendarPrecedes(bound, { from: plan.from, zone: plan.zone })) continue
    const inside = plan.from === null || calendarPrecedes({ to: plan.from, zone: plan.zone }, bound)
    rows.push({ ...bound, ...occurrence, inside })
  }
  return rows
}

const venueKey = row => row.name.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim()

function timelineRows(findings, plan) {
  const dated = new Map(), unknown = new Map()
  for (const hit of findings) for (const observation of hit.observations) {
    const row = { ...observation, hit }
    const key = plan.kind === 'museum' ? venueKey(row) : JSON.stringify([venueKey(row), row.type, row.companions])
    if (!Number.isSafeInteger(row.from) || !row.inside) {
      const previous = unknown.get(key)
      if (!previous || Number.isSafeInteger(row.to) && (!Number.isSafeInteger(previous.to) || row.to < previous.to)) unknown.set(key, row)
      continue
    }
    const distinct = plan.kind === 'museum' ? key : key + ':' + calendarOrderDateKey(row)
    const previous = dated.get(distinct)
    if (!previous || row.from < previous.from) dated.set(distinct, row)
  }
  const byDay = [...dated.values()].sort((a,b) => a.from-b.from || a.name.localeCompare(b.name))
  const uncertain = [...unknown].flatMap(([key, row]) => {
    const fixed = plan.kind === 'museum' ? dated.get(key) : null
    return !fixed || calendarPrecedes(row, fixed) ? [row] : []
  }).sort((a,b) => (a.to ?? Infinity)-(b.to ?? Infinity) || a.name.localeCompare(b.name))
  return { dated:byDay, uncertain }
}

function eventLines(rows, plan) {
  return rows.map(row => {
    const label = plan.kind === 'trip' && row.type && plan.language === 'en'
      ? row.type + ' to ' + row.name + (row.companions ? ' with ' + row.companions : '') : row.name
    const period = calendarOrderPeriod(row)
    const confirmed = row.from !== null && row.inside
    const observation = confirmed ? period : row.from === null
      ? (plan.language === 'en' ? 'date unknown' : '日期未确认')
      : (plan.language === 'en' ? 'within requested period unconfirmed' : '是否在指定时间内待确认')
    return { row, period, text:'- ' + label + (observation ? ' (' + observation + ')' : '') }
  })
}

function formatTimeline(dated, uncertain, plan, complete) {
  const subject = plan.kind === 'museum' ? 'museum visits' : 'trips'
  const en = plan.language === 'en'
  const direction = plan.reverse ? 'latest to earliest' : 'earliest to latest'
  const lines = complete ? [en ? 'Verified order of recorded ' + subject + ' (' + direction + ').'
    : '已核对的时间顺序。'] : [en ? 'The evidence does not establish the full order.' : '现有证据不足以确定完整先后。']
  if (!complete && plan.count && dated.length < plan.count) lines.push(en
    ? 'Confirmed dates are available for only ' + dated.length + ' of the ' + plan.count + ' requested ' + subject + '.'
    : '这 ' + plan.count + ' 项中，有 ' + dated.length + ' 项日期已确认。')
  if (!complete && dated.length) lines.push(en ? 'Confirmed dates.' : '已确认的日期。')
  lines.push(...dated.map(item => item.text))
  if (uncertain.length) lines.push(en ? 'Records whose position in the order is unknown.' : '尚不能确定顺序的记录。',
    ...uncertain.map(item => item.text))
  if (!complete) lines.push(en ? 'Answer with the confirmed dates and say the full order is unknown. Leave undated events unranked.'
    : '回答已核对的日期，说明完整顺序未知。未确认日期的记录不参与排序。')
  return lines.join('\n')
}

export function retrieveTimeline(index, plan, { projectKey, now, maxTokens, maxItems, scanLimit, skipCapture }) {
  const scan = index.findEvidence([plan.search], {
    projectKey, now, maxTokens:scanLimit, allMatches:true, wholeSentences:true, acceptOriginal:true,
    distinctKey: (_query, hit) => hit.record.id,
    match: (_query, hit) => {
      if (hit.record.sourceRefs[0].eventTime > now) return null
      const extracted = observations(hit.record, plan)
      return extracted.length ? { ...hit, observations:extracted } : null
    },
  })
  const findings = index.validateMany(scan.matches.map(row => row.hit), projectKey, { now })
  const rows = timelineRows(findings, plan)
  const ordered = plan.reverse ? rows.dated.slice().reverse() : rows.dated
  const full = !scan.incomplete && !plan.windowUnknown && rows.uncertain.length === 0 && rows.dated.length >= 2 &&
    (plan.count === null || plan.count === rows.dated.length) &&
    rows.dated.every((row, index) => index === 0 || calendarPrecedes(rows.dated[index-1], row))
  const dated = eventLines(ordered, plan), uncertain = eventLines(rows.uncertain, plan)
  const selected = [...dated, ...uncertain].slice(0, maxItems)
  let text, complete
  do {
    complete = full && selected.length === dated.length
    text = (skipCapture ? '本轮不提炼。\n' : '') + formatTimeline(selected.filter(item => item.row.from !== null && item.row.inside),
      selected.filter(item => item.row.from === null || !item.row.inside), plan, complete)
    if (estimateTokens(text) <= maxTokens) break
  } while (selected.pop())
  if (estimateTokens(text) > maxTokens) text = ''
  return { text, complete, hits:findings, injected:selected, scannedTokens:scan.tokens,
    budgetOmitted: scan.incomplete || selected.length < dated.length + uncertain.length,
    order:complete ? selected.map(({ row }) => ({ name: row.name, from: row.from, to: row.to })) : [] }
}

export function matchesTimelineAnswer(answer, timeline) {
  if (!timeline?.complete || !Array.isArray(timeline.order) || timeline.order.length < 2) return false
  const text = answer.normalize('NFKC').replace(/[*_]+/gu, '').replace(/[ \t]+/gu, ' ').toLowerCase()
  if (/cannot (?:determine|confirm)|not enough|insufficient|\b(?:before|after|earlier than|later than)\b|无法(?:确定|确认)|证据不足|早于|晚于/iu.test(text)) return false
  const expected = timeline.order.map(event => venueKey(event))
  const names = [...new Set(expected)].sort((left, right) => right.length - left.length)
  const pattern = new RegExp(names.map(name => {
    const literal = name.replace(/[.*+?^$(){}|[\]\\]/gu, '\\$&')
    return /^[a-z]/u.test(name) ? '(?<![\\p{L}\\p{N}])' + literal + '(?![\\p{L}\\p{N}])' : literal
  }).join('|'), 'gu')
  const mentions = [...text.matchAll(pattern)]
  if (mentions.length !== expected.length || !matchesTimelineDate(text.slice(0, mentions[0].index), timeline.order[0], false)) return false
  return mentions.every((match, index) => {
    const next = mentions[index + 1]
    const suffix = text.slice(match.index + match[0].length, next?.index)
    return expected[index] === match[0] && (!next || /[,，、;；\n→]|(?:followed by|then)|随后|接着|然后/u.test(suffix)) &&
      matchesTimelineDate(suffix, timeline.order[index], expected.filter(name => name === match[0]).length > 1)
  })
}
