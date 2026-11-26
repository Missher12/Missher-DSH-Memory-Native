import { readDayCount } from './calendar-recall.js'
import { sourceSentences } from './sentences.js'
import { tokenize } from './tokenize.js'

const COUNT = String.raw`(?:\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百千]+)`
const UNIT = String.raw`小时|分钟|秒钟|秒|天|日|星期|礼拜|周|月|年`
const DURATION = String.raw`(?<measure>(?:大约|大概|大致|约|差不多)?(?<count>${COUNT}|半)(?<middle>个?半|个)?(?<unit>${UNIT})(?<tail>半)?)`
const DURATION_ATOM = new RegExp(DURATION, 'gu')
const RATE_UNIT = String.raw`星期|礼拜|周|天|日|个月|月|年`
const PERIODIC = String.raw`(?:每(?:隔)?(?<interval>${COUNT})?(?<unit>${RATE_UNIT})|(?<alternate>隔天|隔日|隔周|隔月))(?:(?<times>${COUNT})(?:次|场))?`
const TIMES_PER_PERIOD = String.raw`(?<bareInterval>${COUNT})(?<bareUnit>${RATE_UNIT})(?<bareTimes>${COUNT})(?:次|场)`
const RATE = new RegExp(String.raw`(?<measure>${PERIODIC}|${TIMES_PER_PERIOD})`, 'gu')
const WHEN = String.raw`以前|先前|从前|原来|之前|那时|过去|现在|目前|如今`
const PAST = /以前|先前|从前|原来|之前|那时|过去/u
const ACTOR = String.raw`我们|我`
const ACTUAL = /(?:计划|打算|想要|预计|预想|如果|假设|可能|本来想|将要|没(?:有|去|住|待|花|用)|不会|并非|不是|不能|吗$|呢$|是否|是不是)/u
const SUBJECT = String.raw`[^,。;!?！？]{1,52}?`
const TENSE = String.raw`(?:上次|那次|那年|去年|前年|今年|之前|曾经|刚刚|刚|已经|一共|总共)`
const QUESTION_LENGTH = String.raw`(?:多久|多长时间|多少(?:个)?(?:小时|分钟|天|周|个月|月|年))`
const STAY_QUERY = new RegExp(String.raw`^(?<actor>${ACTOR})?(?:上次|那次)?在(?<subject>${SUBJECT})(?:待|住|停留)(?:了|过)?(?:一共|总共)?${QUESTION_LENGTH}了?$`, 'u')
const STAY = new RegExp(String.raw`^(?:${TENSE})?(?<actor>${ACTOR})(?:${TENSE})?在(?<subject>${SUBJECT})(?:待|住|停留)(?:了|过)?(?:一共|总共)?${DURATION}`, 'u')
const STAY_ANCHOR = new RegExp(String.raw`^(?:${TENSE})?(?<actor>${ACTOR})(?:${TENSE})?在(?<subject>${SUBJECT})(?:待过|住过|停留过)(?:一阵|一段时间)?了?$`, 'u')
const COMMUTE_WORDS = String.raw`(?:上班通勤|上下班通勤|通勤|上班路上|上下班路上)`
const DIRECTION = String.raw`单程|往返|来回|每趟`
const COMMUTE_QUERY = new RegExp(String.raw`^(?:${ACTOR})?(?:平时|每天|日常)?(?<leading>${DIRECTION})?${COMMUTE_WORDS}(?<leadingAfter>${DIRECTION})?(?:需要|要|花|花费)?${QUESTION_LENGTH}(?<trailing>${DIRECTION})?$`, 'u')
const COMMUTE = new RegExp(String.raw`^(?:${ACTOR})?(?:平时|每天|日常)?(?<leading>${DIRECTION})?${COMMUTE_WORDS}(?<leadingAfter>${DIRECTION})?(?:需要|要|花|花费|耗时)?${DURATION}(?<trailing>${DIRECTION})?`, 'u')
const COMMUTE_CONTINUED = new RegExp(String.raw`^,(?<leading>${DIRECTION})(?:合计|总共|需要|要|花)?${DURATION}`, 'u')
const TASK_ACTION = String.raw`组装|装配|安装|搭建|维修|修理|整理|配置|制作|编译|备份|迁移|搬运|搬|写`
const TASK_QUERY = new RegExp(String.raw`^(?<actor>${ACTOR})?(?<action>${TASK_ACTION})(?:好|完)?(?<subject>${SUBJECT})(?:花了|用了|耗时|花费了)${QUESTION_LENGTH}$`, 'u')
const TASK = new RegExp(String.raw`^(?<actor>${ACTOR})(?:${TENSE})?(?<action>${TASK_ACTION})(?:好|完|了){0,2}(?<subject>${SUBJECT})(?:花了|用了|耗时|花费了)${DURATION}`, 'u')
const TASK_BEFORE = new RegExp(String.raw`^(?<actor>${ACTOR})(?:${TENSE})?(?:花了|花费了|用了)${DURATION}(?:来)?(?<action>${TASK_ACTION})(?:好|完|了){0,2}(?<subject>${SUBJECT})了?(?=$|[,;。])`, 'u')
const USE_QUERY = new RegExp(String.raw`^(?<actor>${ACTOR})(?:一直|已经|已)?(?:在)?(?:使用|用)(?:了)?(?<subject>${SUBJECT})${QUESTION_LENGTH}了?$`, 'u')
const USE = new RegExp(String.raw`^(?<actor>${ACTOR})(?:一直|已经|已|持续)?(?:在)?(?:使用|用)(?:了)?(?<subject>${SUBJECT})(?:已经|一共|共|有)?${DURATION}(?:了)?`, 'u')
const ALLOCATION_PERIODS = { 每天: 'day', 每日: 'day', 每周: 'week', 每星期: 'week', 每月: 'month', 每个月: 'month' }
const ALLOCATION_CADENCE = `(?<cadence>${Object.keys(ALLOCATION_PERIODS).join('|')})`
const ALLOCATION_HEAD = String.raw`(?:平时|通常|现在|目前)?${ALLOCATION_CADENCE}(?:通常|都会|都|会)?`
const ALLOCATION_ASK = `(?:多少时间|${QUESTION_LENGTH})`
const ALLOCATION_SPEND = String.raw`(?:花费|花|用)`
const ALLOCATION_QUERY = [
  String.raw`${ALLOCATION_SPEND}${ALLOCATION_ASK}(?:来)?(?<activity>${SUBJECT})$`,
  String.raw`(?<activity>${SUBJECT})(?:要?${ALLOCATION_SPEND})?${ALLOCATION_ASK}$`,
].map(pattern => new RegExp(String.raw`^(?<actor>${ACTOR})?${ALLOCATION_HEAD}${pattern}`, 'u'))
const ALLOCATION_STATEMENTS = [
  String.raw`${ALLOCATION_SPEND}${DURATION}(?:来)?(?<activity>${SUBJECT})(?=$|[。,;])`,
  String.raw`(?<activity>${SUBJECT})(?:${ALLOCATION_SPEND})?${DURATION}(?=$|[。,;])`,
].map(pattern => new RegExp(String.raw`^(?:(?:顺便说(?:一下)?|对了),)?(?<actor>${ACTOR})${ALLOCATION_HEAD}${pattern}`, 'u'))
const ALLOCATION_NONFACT = /(?:过去|以前|之前|从前|曾经|原来|不再|以后|从下|下周起|下月起|才(?:能|可以|够)|至少|至多|不少于|不超过|每(?:次|场|节|堂|日|天|周|月)|["“”「」])/u
const ROUTINE_HEAD = new RegExp(String.raw`^(?<leading>${WHEN})?(?<actor>${ACTOR})?(?<following>${WHEN})?(?:通常|一般|固定|都会|都|会)?`, 'u')
const ROUTINE = new RegExp(String.raw`^(?:(?:和|跟|同)(?<participants>[^,。;在]{1,22}?)(?:一起)?)?(?:在(?<venue>[^,。;]{1,30}?))?(?<action>练习|打|练|弹)(?:(?<repeats>${COUNT})(?:次|场))?(?<activity>[^,。;!?！？]{1,24})$`, 'u')
const ROUTINE_CHANGE = /^(?:现在|目前|如今)(?:已经)?(?:改成|变成|改为|变为|调整为|调整成|是)(?<rate>.*?)(?:了)?$/u
const ROUTINE_ASK = /(?:每隔)?(?:多久|多长时间)(?:一次)?|(?:的)?频率(?:是多少|多少|怎样|如何)/u
const MIXED_SUBJECT = /和|(?:以及|或者|或是|既|同时|另外|然后|但|之前|之后|的时候|当时)|[,;、!?]/u
const UNSAFE_DURATION_TAIL = new RegExp(String.raw`^(?:到|至|[–—~-]|\+)|^(?:或|或者|和|加上)(?:${COUNT}|半)|^,?(?:但|不过)?(?:实际上|其实|更正)`, 'u')
const UNIT_KEYS = { 秒: 'second', 秒钟: 'second', 分钟: 'minute', 小时: 'hour', 天: 'day', 日: 'day',
  周: 'week', 星期: 'week', 礼拜: 'week', 月: 'month', 年: 'year' }

function compact(text) {
  return String(text ?? '').normalize('NFKC').replace(/\s+/gu, '').replace(/[。；;！!]+$/u, '')
}

function cleanSubject(text) {
  return text.replace(/^(?:这个|那个|这架|那架|这本|那本|这台|那台|这张|那张)/u, '').toLowerCase()
}

function actorOf(text) {
  return text === '我们' ? 'we' : 'i'
}

function countOf(text) {
  if (text === '半') return .5
  if (/^\d+(?:\.\d+)?$/u.test(text)) {
    const value = Number(text)
    return Number.isFinite(value) && value <= Number.MAX_SAFE_INTEGER ? value : NaN
  }
  const normalized = text.replaceAll('两', '二').replaceAll('〇', '零')
  if (/^(?:[一二三四五六七八九]?十[一二三四五六七八九]?|[零一二三四五六七八九])$/u.test(normalized)) return readDayCount(normalized)
  const large = /^(?:(?<thousands>[一二三四五六七八九])千)?(?:(?<hundreds>[一二三四五六七八九])百)?(?<rest>零[一二三四五六七八九](?:十[一二三四五六七八九]?)?|[一二三四五六七八九]?十[一二三四五六七八九]?)?$/u.exec(normalized)
  if (!large || !(large.groups.thousands || large.groups.hundreds)) return NaN
  const { thousands, hundreds, rest } = large.groups
  if (thousands && !hundreds && rest && !rest.startsWith('零')) return NaN
  return (thousands ? readDayCount(thousands) * 1000 : 0) + (hundreds ? readDayCount(hundreds) * 100 : 0) +
    (rest ? readDayCount(rest.replace(/^零/u, '')) : 0)
}

export function zhTimeDirection(word) {
  return word ? /^(?:往返|来回)$/u.test(word) ? 'round trip' : 'each way' : undefined
}

function readDuration(groups, direction) {
  const halves = Number(groups.middle?.endsWith('半') ?? false) + Number(groups.tail === '半')
  if (halves > 1 || groups.count === '半' && halves > 0) return null
  const n = countOf(groups.count) + halves / 2
  if (!Number.isFinite(n)) return null
  return n + ' ' + UNIT_KEYS[groups.unit] + (direction ? ' ' + direction : '')
}

function readCadence(groups, actionCount) {
  const span = groups.interval ?? groups.bareInterval
  const times = groups.times ?? groups.bareTimes
  const interval = groups.alternate ? 2 : span ? countOf(span) : 1
  const count = times ? countOf(times) : actionCount ? countOf(actionCount) : 1
  if (actionCount && times && count !== countOf(actionCount)) return null
  const unit = groups.alternate?.slice(-1) ?? (groups.unit ?? groups.bareUnit)?.replace(/^个/u, '')
  return interval > 0 && count > 0 && Number.isInteger(count) && UNIT_KEYS[unit] ? `${count}/${interval} ${UNIT_KEYS[unit]}` : null
}

function routineScope(text) {
  const head = ROUTINE_HEAD.exec(text)
  const match = ROUTINE.exec(text.slice(head[0].length))
  if (!match || MIXED_SUBJECT.test(match.groups.activity)) return null
  const { activity, participants, venue, action, repeats } = match.groups
  const when = head.groups.following ?? head.groups.leading
  return { explicitActor: head.groups.actor, actor: actorOf(head.groups.actor), action: action === '练习' ? '练' : action, repeats,
    period: when ? PAST.test(when) ? 'previous' : 'current' : undefined,
    scope: { activity, participants, venue } }
}

function firstDirection(groups) {
  const values = new Set([groups.leading, groups.leadingAfter, groups.trailing].filter(Boolean).map(zhTimeDirection))
  return values.size > 1 ? null : [...values][0]
}

export function zhAllocationCadence(text) {
  return [...compact(text).matchAll(new RegExp(ALLOCATION_CADENCE, 'gu'))].map(match => ALLOCATION_PERIODS[match.groups.cadence])
}

export function zhTimeMeasureIntent(query) {
  const text = compact(query).replace(/[?？]+$/u, '')
  if (!/\p{Script=Han}/u.test(text)) return null
  const commute = COMMUTE_QUERY.exec(text)
  if (commute) {
    const direction = firstDirection(commute.groups)
    if (direction === null) return null
    return { language: 'zh', detail: 'duration', mode: 'commute', subject: '通勤', direction, entityTerms: tokenize('通勤'),
      searchQuery: '通勤 上班路上 上下班 commute to work' }
  }
  for (const pattern of ALLOCATION_QUERY) {
    const match = pattern.exec(text)
    if (!match || MIXED_SUBJECT.test(match.groups.activity) || ALLOCATION_NONFACT.test(match.groups.activity)) continue
    const { actor, cadence, activity } = match.groups
    return { language: 'zh', detail: 'duration', mode: 'allocation', actor: actorOf(actor),
      cadence: ALLOCATION_PERIODS[cadence], subject: activity, entityTerms: tokenize(activity), searchQuery: activity }
  }
  for (const [mode, pattern] of [['stay', STAY_QUERY], ['task', TASK_QUERY], ['use', USE_QUERY]]) {
    const match = pattern.exec(text)
    if (!match || MIXED_SUBJECT.test(match.groups.subject)) continue
    const subject = cleanSubject(match.groups.subject)
    return { language: 'zh', detail: 'duration', mode, subject, actor: actorOf(match.groups.actor),
      action: mode === 'use' ? 'use' : match.groups.action, entityTerms: tokenize(subject), searchQuery: subject }
  }
  if (!ROUTINE_ASK.test(text)) return null
  const parsed = routineScope(text.replace(ROUTINE_ASK, ''))
  if (!parsed) return null
  const { scope, period, actor, action } = parsed
  const subject = [scope.participants && '和' + scope.participants, scope.venue && '在' + scope.venue, action + scope.activity].filter(Boolean).join('')
  return { language: 'zh', detail: 'frequency', mode: 'routine', scope, period, actor, action, subject,
    entityTerms: tokenize(scope.activity), searchQuery: scope.activity }
}

function durationProof(plan, quote, preceding) {
  const text = compact(quote)
  let evidenceQuote = quote
  let match = plan.mode === 'stay' ? STAY.exec(text)
    : plan.mode === 'task' ? TASK.exec(text) ?? TASK_BEFORE.exec(text)
    : plan.mode === 'use' ? USE.exec(text) : COMMUTE.exec(text)
  if (!match || UNSAFE_DURATION_TAIL.test(text.slice(match[0].length))) return null
  let direction = firstDirection(match.groups)
  if (plan.mode === 'commute' && direction) {
    const rest = text.slice(match[0].length)
    const other = COMMUTE_CONTINUED.exec(rest)
    if (other) {
      const otherDirection = firstDirection(other.groups)
      if (otherDirection === direction || UNSAFE_DURATION_TAIL.test(rest.slice(other[0].length))) return null
      const comma = quote.search(/[,，]/u)
      if (plan.direction === otherDirection) {
        match = other
        direction = otherDirection
        evidenceQuote = quote.slice(comma + 1).trim()
      } else {
        evidenceQuote = quote.slice(0, comma).trim()
      }
    }
  }
  const { subject, actor, action, measure } = match.groups
  if (actor && actorOf(actor) !== plan.actor && plan.mode !== 'commute') return null
  if (plan.mode === 'task' && action !== plan.action) return null
  if (direction === null || (plan.direction && direction !== plan.direction)) return null
  const value = readDuration(match.groups, direction)
  if (value === null) return null
  if (!subject || cleanSubject(subject) === plan.subject) {
    const label = direction === 'each way' ? '单程' : direction === 'round trip' ? '往返' : ''
    return { quote: evidenceQuote, value, measure: label + measure }
  }
  if (plan.mode !== 'stay' || !preceding || !/^(?:那里|当地|那个城市|那个国家)$/u.test(subject)) return null
  const anchor = STAY_ANCHOR.exec(compact(preceding.sentence))
  if (anchor && actorOf(anchor.groups.actor) === plan.actor && cleanSubject(anchor.groups.subject) === plan.subject && !ACTUAL.test(compact(preceding.sentence))) {
    return { quote: preceding.joined, value, measure }
  }
  return null
}

function allocationProof(plan, quote, text) {
  for (const pattern of ALLOCATION_STATEMENTS) {
    const match = pattern.exec(text)
    if (!match) continue
    const { actor, cadence, activity, measure, unit } = match.groups
    if (actorOf(actor) !== plan.actor || ALLOCATION_PERIODS[cadence] !== plan.cadence || activity !== plan.subject ||
        !/^(?:秒钟?|分钟|小时)$/u.test(unit) || ALLOCATION_NONFACT.test(activity + text.slice(match[0].length)) ||
        UNSAFE_DURATION_TAIL.test(text.slice(match[0].length))) continue
    const value = readDuration(match.groups)
    if (value !== null) return { quote, value, measure: cadence + measure }
  }
  return null
}

function periodProof(plan, quote, previous) {
  const text = compact(quote).replace(/[,;]$/u, '')
  const matches = [...text.matchAll(RATE)]
  if (matches.length !== 1) return null
  const measure = matches[0]
  const change = ROUTINE_CHANGE.exec(text)
  if (change && previous?.proof && previous.proof.period === 'previous' && change.groups.rate === measure[0]) {
    const value = readCadence(measure.groups)
    return value === null ? null : { quote: previous.joined, value, measure: measure.groups.measure, period: 'current',
      unconfirmedVenue: previous.proof.unconfirmedVenue }
  }
  const parsed = routineScope((text.slice(0, measure.index) + text.slice(measure.index + measure[0].length)).replace(/[,;]$/u, ''))
  if (!parsed?.explicitActor || parsed.actor !== plan.actor || parsed.action !== plan.action ||
      parsed.scope.activity !== plan.scope.activity ||
      (plan.scope.participants && parsed.scope.participants !== plan.scope.participants) ||
      (plan.scope.venue && parsed.scope.venue && parsed.scope.venue !== plan.scope.venue)) return null
  const value = readCadence(measure.groups, parsed.repeats)
  return value === null ? null : { quote, value, measure: parsed.repeats && !measure.groups.times
    ? measure.groups.measure + parsed.repeats + '次' : measure.groups.measure,
  period: parsed.period ?? 'current', unconfirmedVenue: Boolean(plan.scope.venue && !parsed.scope.venue) }
}

export function zhTimeMeasureFacts(plan, content, clauses = sourceSentences(content)) {
  const results = []
  let previous = null, offset = 0
  for (const sentence of clauses) {
    const start = content.indexOf(sentence, offset)
    if (start < 0) { previous = null; continue }
    const link = previous && /^[\s,，;；。]*(?:但|不过|而|可)?[\s,，;；。]*$/u.test(content.slice(offset, start))
      ? { ...previous, joined: content.slice(previous.start, start + sentence.length) } : null
    const text = compact(sentence)
    const proof = ACTUAL.test(text) || /[?？]/u.test(text) ? null : plan.mode === 'routine'
      ? periodProof(plan, sentence, link) : plan.mode === 'allocation'
        ? allocationProof(plan, sentence, text) : durationProof(plan, sentence, link)
    if (proof) results.push(proof)
    previous = { sentence, start, proof }
    offset = start + sentence.length
  }
  return results
}

export function zhStatedTimeMeasures(detail, text, direction) {
  const value = compact(text).replace(/\d{4}年(?:\d{1,2}月(?:\d{1,2}[日号])?)?/gu, '')
  if (detail === 'frequency') {
    const verbCount = new RegExp(String.raw`^(?:打|练习|练|去|见|弹)(?<times>${COUNT})(?:次|场)`, 'u')
    return [...value.matchAll(RATE)].map(match => readCadence(match.groups,
      verbCount.exec(value.slice(match.index + match[0].length))?.groups.times)).filter(Boolean)
  }
  return [...value.matchAll(DURATION_ATOM)].map(match => {
    const before = value.slice(0, match.index).match(/(?:单程|往返|来回|每趟)(?:为|是|要|用时)?$/u)?.[0]
    const after = value.slice(match.index + match[0].length).match(/^(?:单程|往返|来回|每趟)/u)?.[0]
    const named = direction ? zhTimeDirection(before?.match(/^(?:单程|往返|来回|每趟)/u)?.[0] ?? after) : undefined
    return readDuration(match.groups, named)
  }).filter(Boolean)
}
