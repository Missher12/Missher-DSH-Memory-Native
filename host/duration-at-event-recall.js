import { sourceCalendarDay, sourceEventDate } from './calendar-recall.js'
import { estimateTokens } from './recall.js'
import { sourceSentences } from './sentences.js'
import { isRecallSourceStatement } from './source-passages.js'
import { statedTimeMeasures, timeMeasureFacts, timeMeasureIntent } from './time-measure-recall.js'
import { tokenize } from './tokenize.js'

const VERBS = { bought: 'purchase', purchased: 'purchase', got: 'acquisition', received: 'acquisition',
  'picked up': 'acquisition', finished: 'completion', completed: 'completion', submitted: 'submitted',
  started: 'start', began: 'start', installed: 'installed', joined: 'joined', moved: 'moved', launched: 'launched' }
const ZH_VERBS = { 买下: 'purchase', 购买: 'purchase', 买: 'purchase', 拿到: 'acquisition', 收到: 'acquisition',
  做完: 'completion', 完成: 'completion', 提交: 'submitted', 开始: 'start', 安装: 'installed', 加入: 'joined', 上线: 'launched' }
const EVENT = String.raw`(?<eventActor>I|we)\s+(?:(?:just|finally|already|actually)\s+)?(?<verb>${Object.keys(VERBS).join('|')})\s+`
const PERSONAL_EVENT = new RegExp(String.raw`\b${EVENT}`, 'iu')
const EVENT_QUERY = new RegExp(String.raw`^${EVENT}(?<object>[^,;!?]{1,95})$`, 'iu')
const EVENT_STATEMENT = new RegExp(String.raw`^(?:(?:on\s+)?\u0000[\s,]+)?${EVENT}(?<object>[^\u0000,;!?]{1,130}?)(?:\s+(?:on\s+)?\u0000)?[.]?$`, 'iu')
const ACTIVITY = String.raw`how (?:long|many (?:days|weeks)) had (?<actor>I|we) (?<activity>[^,;!?]{1,128}?)`
const ACTIVITY_FIRST = new RegExp(String.raw`^${ACTIVITY}\s+(?:when|by the time)\s+(?<event>.+)$`, 'iu')
const EVENT_FIRST = new RegExp(String.raw`^(?:when|by the time)\s+(?<event>.+?),\s*${ACTIVITY}$`, 'iu')
const ZH_QUERY = /^(?<event>(?:我们|我)[^，,。；;!?]{1,76}?)(?:的时候|那天|时)[，,](?<activity>[^，,。；;!?]{1,96})$/u
const ZH_EVENT = String.raw`(?<eventActor>我们|我)(?:(?:在|于)?\u0000)?(?:刚刚|刚|已经)?(?<verb>${Object.keys(ZH_VERBS).join('|')})(?:了)?(?<object>[^\u0000，,。;!?]{1,64}?)(?:了)?`
const ZH_EVENT_QUERY = new RegExp(String.raw`^${ZH_EVENT}$`, 'u')
const ZH_EVENT_STATEMENT = new RegExp(String.raw`^(?:(?:在|于)?\u0000[，,]?)?${ZH_EVENT}(?:(?:在|于)?\u0000)?[。！!]?$`, 'u')
const ZH_PERSONAL_EVENT = /我(?:们)?/u
const DOUBT = /\b(?:not|never|maybe|might|possibly|assume|hypothetical|would|could|wanted?|planned|since|before|after|or)\b/iu
const ZH_DOUBT = /计划|打算|假设|想要|如果|可能|并非|不是|没有|还没|原定|预计|早于|晚于|之前|之后|或是|或者/u
const ANSWER_DOUBT = /\b(?:unknown|uncertain|no(?:t enough)? evidence|not (?:sure|enough)|cannot|can't|unable to)\b|无法确定|无法判断|未知|没有(?:依据|记录)/iu
const ANSWER_PURCHASE_DATE = /\b(?:when|by the time|the day)\s+(?:I|we|you)\s+(?:bought|purchased|paid for)\b|(?:买下|购买|买)[^，,。]{0,48}(?:时|那天)/iu

function namedObject(text) {
  return tokenize(text.replace(/^(?:the|an?|my|our)\s+/iu, ''))
}

function chineseName(text) {
  return text.trim().replace(/^(?:这台|那台|这个|那个|这把|那把|这份|那份)/u, '').toLowerCase()
}

function chineseDurationAtEvent(text) {
  const match = ZH_QUERY.exec(text.replace(/\s+/gu, ''))
  if (!match) return null
  const named = ZH_EVENT_QUERY.exec(match.groups.event)
  if (!named || ZH_DOUBT.test(named.groups.object)) return null
  const { eventActor, verb, object } = named.groups
  const activity = match.groups.activity
  const plan = timeMeasureIntent(activity.startsWith('我') ? activity : eventActor + activity)
  const name = chineseName(object)
  if (!name || plan?.mode !== 'use') return null
  return { activity: plan, eventPhrase: verb + object,
    event: { actor: eventActor, action: ZH_VERBS[verb], name: [name], language: 'zh' },
    search: [plan.searchQuery, name] }
}

export function durationAtEventQuery(query) {
  const text = String(query ?? '').normalize('NFKC').trim().replace(/[?？]+$/u, '')
  const parts = ACTIVITY_FIRST.exec(text) ?? EVENT_FIRST.exec(text)
  if (!parts) return chineseDurationAtEvent(text)
  const { actor, activity, event } = parts.groups
  const plan = timeMeasureIntent('How long have ' + actor + ' ' + activity)
  const named = EVENT_QUERY.exec(event)
  if (!plan || plan.detail !== 'duration' || !named || /\b(?:and|or|before|after|where|which)\b/iu.test(named.groups.object)) return null
  const { eventActor, verb, object } = named.groups
  const name = namedObject(object)
  if (!name.length || /\b(?:it|them|something)\b/iu.test(object)) return null
  return { activity: plan, activityPhrase: activity, eventPhrase: verb + ' ' + object,
    event: { actor: eventActor.toLowerCase(), action: VERBS[verb.toLowerCase()], name },
    search: [plan.entityTerms.join(' '), name.join(' ')] }
}

function durationDays(value) {
  const match = /^(\d+) (day|week)$/u.exec(value)
  if (!match) return null
  const days = Number(match[1]) * (match[2] === 'week' ? 7 : 1)
  return Number.isSafeInteger(days) ? days : null
}

function activityEvidence(record, plan) {
  const facts = timeMeasureFacts(plan, record.content, { forPastEvent: true }).filter(fact => isRecallSourceStatement(fact.quote))
  if (!facts.length) return []
  const ref = record.sourceRefs[0]
  const through = sourceCalendarDay(ref)
  return facts.map(({ quote, value, measure }) => {
    const ongoing = plan.language !== 'zh' || /^(?:我|我们)(?:已经|一直|持续|已)|了[。！!]?$/u.test(quote)
    const days = ongoing && !/^(?:大约|大概|大致|约|差不多)/u.test(measure) ? durationDays(value) : null
    return { quote, zone: ref.timeZone, through, start: through !== null && days > 0 ? through - days : null }
  })
}

function eventEvidence(record, event) {
  const proofs = []
  const sentences = sourceSentences(record.content)
  const zh = event.language === 'zh'
  for (const [index, sentence] of sentences.entries()) {
    if (!isRecallSourceStatement(sentence)) continue
    for (const piece of sentence.split(zh ? /[；;]|[，,](?=并且|然后|后来|但是|而后)/u
      : /[;]|(?:,\s*|\s+)(?:and|but)\s+(?=(?:I|we|he|she|they)\b)/iu)) {
      const clause = piece.trim()
      if (zh ? !ZH_PERSONAL_EVENT.test(clause) || ZH_DOUBT.test(clause) : !PERSONAL_EVENT.test(clause) || DOUBT.test(clause)) continue
      const { marked, day, zone } = sourceEventDate(record, clause)
      const match = zh ? ZH_EVENT_STATEMENT.exec(marked.replace(/\s+/gu, '')) : EVENT_STATEMENT.exec(marked)
      if (!match || match.groups.eventActor.toLowerCase() !== event.actor) continue
      const action = zh ? ZH_VERBS[match.groups.verb] : VERBS[match.groups.verb.toLowerCase()]
      const acquisitionOnly = event.action === 'purchase' && action === 'acquisition'
      if (action !== event.action && !acquisitionOnly) continue
      const name = zh ? [chineseName(match.groups.object)] : namedObject(match.groups.object)
      const exact = event.name.join(' ') === name.join(' ')
      let quote = clause
      if (!exact) {
        if (zh) continue
        // An omitted modifier can be suggested by the adjacent sentence. It
        // remains a conditional link and both pieces must be shown together.
        const modifier = event.name.find((_, i) => event.name.filter((_, j) => i !== j).join(' ') === name.join(' '))
        const previous = sentences[index - 1]
        if (!modifier || modifier === event.name.at(-1) || !previous || !isRecallSourceStatement(previous) ||
            !tokenize(previous).includes(modifier)) continue
        const from = record.content.indexOf(previous)
        const position = record.content.indexOf(clause, from + previous.length)
        if (position < 0 || !/^\s+$/u.test(record.content.slice(from + previous.length, position))) continue
        quote = record.content.slice(from, position + clause.length)
      }
      const observedEvent = zh ? match.groups.verb + match.groups.object
        : match.groups.verb.toLowerCase() + ' the ' + match.groups.object.replace(/^(?:the|an?|my|our)\s+/iu, '')
      const acquisitionObject = acquisitionOnly ? name.join(' ') : null
      proofs.push({ quote, day, zone, conditional: !exact || acquisitionOnly, acquisitionObject, observedEvent })
    }
  }
  return proofs
}

function resolveDuration(activities, events) {
  const observed = activities.flatMap(hit => hit.observations.map(proof => ({ hit, proof })))
  const dated = events.flatMap(hit => hit.observations.map(proof => ({ hit, proof })))
  const days = new Set(dated.map(({ proof }) => JSON.stringify([proof.day, proof.zone])))
  const starts = new Set(observed.map(({ proof }) => JSON.stringify([proof.start, proof.zone])))
  if (days.size !== 1 || starts.size !== 1) return null
  const event = dated.find(row => !row.proof.conditional) ?? dated[0]
  const { proof: { day, zone, conditional } } = event
  const eventReported = event.hit.record.sourceRefs[0].eventTime
  const activity = observed.find(row => day !== null && row.proof.start !== null && row.proof.zone === zone &&
    day > row.proof.start && (day < row.proof.through ||
      day === row.proof.through && eventReported <= row.hit.record.sourceRefs[0].eventTime))
  return activity ? { days: day - activity.proof.start, conditional, activity, event } : null
}

function durationText(days, zh) {
  const [count, unit] = days % 7 === 0 ? [days / 7, 'week'] : [days, 'day']
  if (zh) return count + (unit === 'week' ? ' 周' : ' 天')
  return count + ' ' + unit + (count === 1 ? '' : 's')
}

export function retrieveDurationAtEvent(index, plan, { projectKey, now, maxTokens, maxItems, scanLimit, skipCapture }) {
  const scan = index.findEvidence(['activity', 'event'], {
    projectKey, now, maxTokens: scanLimit, allMatches: true, wholeSentences: true, acceptOriginal: true,
    lookupQuery: lane => plan.search[lane === 'activity' ? 0 : 1],
    distinctKey: (_lane, hit) => hit.record.id,
    match: (lane, hit) => {
      const observations = lane === 'activity' ? activityEvidence(hit.record, plan.activity) : eventEvidence(hit.record, plan.event)
      return observations.length ? { ...hit, observations } : null
    },
  })
  const matches = lane => index.validateMany(scan.matches.filter(row => row.query === lane).map(row => row.hit), projectKey, { now })
  const activities = matches('activity'), events = matches('event')
  const found = scan.incomplete ? null : resolveDuration(activities, events)
  const zh = plan.activity.language === 'zh'
  const note = zh ? '按已核算的结果简短回答，保留限定。' + (skipCapture ? '本轮不提炼。' : '')
    : 'Answer from the verified result below, retaining any condition.' +
      (skipCapture ? ' Do not capture this turn.' : '')
  const header = '<memory-context source="dsh-memory" note="' + note + '">'
  const footer = '</memory-context>'
  if (found && maxItems >= 2) {
    const { days, conditional } = found
    const duration = durationText(days, zh)
    const { observedEvent: observed, acquisitionObject } = found.event.proof
    let result
    if (zh) {
      const atEvent = conditional ? '如果指的是' + observed + '那天，' : plan.eventPhrase + '时，'
      result = atEvent + '已经使用' + plan.activity.subject + ' ' + duration + '。'
    } else {
      const elapsed = 'had ' + plan.activityPhrase + ' for ' + duration
      const answer = conditional ? 'If you mean when you ' + observed + ', you ' + elapsed + ' at that time.'
        : 'You ' + elapsed + ' when you ' + plan.eventPhrase + '.'
      result = 'Answer to the question: ' + answer
    }
    // These are the two inputs to one derived sentence. Keep their exact
    // authorized spans in the report without asking the model to redo the math.
    const injected = [found.activity, found.event].map(row => ({ row, text: result, selectedQuote: row.proof.quote }))
    const text = [header, result, footer].join('\n')
    if (estimateTokens(text) <= maxTokens) return {
      text, hits: [found.activity.hit, found.event.hit], injected, complete: true,
      duration: { days, conditional, projected: true, ...(acquisitionObject ? { acquisitionObject } : {}) },
      scannedTokens: scan.tokens, budgetOmitted: false,
    }
  }
  const hits = [...activities.slice(0, 2), ...events.slice(0, 2)]
  const unknown = [header, zh ? '现有记忆不足以确定这段时长。'
    : 'Answer to the question: The available memories do not establish the duration at that event.', footer].join('\n')
  return { text: hits.length && estimateTokens(unknown) <= maxTokens ? unknown : '', hits, injected: [], complete: false,
    duration: { days: null, conditional: false }, scannedTokens: scan.tokens, budgetOmitted: scan.incomplete || Boolean(found) }
}

function matchesAcquiredItem(answer, object) {
  const clauses = answer.normalize('NFKC').replace(/\*+|\u0060+/gu, '').split(/[，,；;。！？!?\n]+/u)
  const escaped = object.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  if (/\p{Script=Han}/u.test(object)) {
    const acquisition = new RegExp('(?:拿到|收到)(?:了)?(?:[这那][台个份套把件本只]|该|我的|我们的|你的)?' +
      escaped + '(?=$|那天|当天|之时|时|的时候|后)', 'u')
    return clauses.some(clause => acquisition.test(clause.replace(/\s+/gu, '').trim()))
  }
  const acquired = String.raw`\b(?:i|we|you)\s+(?:got|received|picked\s+up|acquired)\b`
  const name = escaped.replace(/\s+/gu, String.raw`[\s-]+`)
  const directObject = new RegExp(acquired + String.raw`\s+(?:(?:the|a|an|your|my|our)\s+)?` + name +
    String.raw`(?=[.:]?$|\s+(?:at|from|for|on|in|then|that\s+day|when|after|before)\b)`, 'iu')
  const relativeObject = new RegExp(String.raw`\b` + name + String.raw`\s+(?:(?:that|which)\s+)?` + acquired +
    String.raw`(?=[.:]?$|\s+(?:is|was|at|from|on|then|that\s+day)\b)`, 'iu')
  return clauses.some(clause => directObject.test(clause.trim()) || relativeObject.test(clause.trim()))
}

export function matchesDurationAtEventAnswer(answer, { days, conditional, acquisitionObject }) {
  if (days === null || ANSWER_DOUBT.test(answer)) return false
  if (acquisitionObject && (ANSWER_PURCHASE_DATE.test(answer) || !matchesAcquiredItem(answer, acquisitionObject))) return false
  if (conditional && !/\b(?:if|assuming|provided that|(?:when|at the time) (?:I|you|we) (?:got|received|picked up))\b|如果|假如|拿到.*时/iu.test(answer)) return false
  const stated = statedTimeMeasures('duration', answer.replace(/[*_]/gu, '')).map(durationDays)
  return stated.length > 0 && stated.every(value => value === days) &&
    !/\bnot\s+(?:\w+\s+){0,2}(?:days?|weeks?)\b|不是|并非/iu.test(answer)
}
