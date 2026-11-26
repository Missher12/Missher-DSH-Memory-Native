import { sourceSentences, withoutEvidencePreface } from './sentences.js'
import { zhAllocationCadence, zhStatedTimeMeasures, zhTimeMeasureFacts, zhTimeMeasureIntent } from './time-measure-zh.js'
import { tokenize } from './tokenize.js'

const ACTION = String.raw`had|owned|used|been\s+[a-z]+ing`
const APPOINTMENT = String.raw`see|visit|meet(?: with)?`
const DURATION_QUERY = new RegExp(String.raw`^how long have (?<actor>I|we) (?<action>${ACTION}) (?<object>[^?;]{1,120})$`, 'iu')
const FREQUENCY_QUERY = new RegExp(String.raw`^how often do (?<actor>I|we) (?<action>${APPOINTMENT}) (?<object>[^?;]{1,120})$`, 'iu')
const STAY_QUERY = /^how long (?:(?:was (?<singular>I)|were (?<plural>we)) (?:in|at)|did (?<past>I|we) (?:stay|spend time) (?:in|at)) (?<object>[^?;,]{1,80}?)(?: for)?$/iu
const COMMUTE_QUERY = /^how long (?:is|does) (?:my|our) (?:daily\s+)?commute(?: to work)?(?: take)?$/iu
const TASK_QUERY = /^how long did it take(?: (?<actor>me|us))? to (?<action>[a-z]{2,24}) (?<object>[^?;,]{1,100})$/iu
const CUMULATIVE_QUERY = /^how (?:much time|long|many (?:seconds|minutes|hours|days|weeks)) have (?<actor>I|we) (?:spent|put in|logged)(?: in total)? (?:on|into) (?<object>[^?,;]{2,110})$/iu
const ROUTINE_ACTION = String.raw`play|practi[cs]e`
const ROUTINE_QUERY = new RegExp(String.raw`^how often (?:do|did) (?<actor>I|we) (?:use to )?(?<action>${ROUTINE_ACTION}) (?<object>[^?;,]{1,120})$`, 'iu')
const PERIOD_SUFFIX = /\s+(previously|formerly|before|back then|now|currently|these days)$/iu
const TITLED_NAME = /\b(?:Dr|Mr|Mrs|Ms|Prof)\.?\s+[A-Z][A-Za-z'-]*(?:\s+[A-Z][A-Za-z'-]*)*$/u
const APPOSITIVE_NAME = /[,，]\s*([A-Z][A-Za-z0-9_.-]*(?:\s+[A-Z][A-Za-z0-9_.-]*)*)\s*[,，]?$/u
const NUMBERS = 'zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen'.split(' ')
const TENS = 'twenty thirty forty fifty sixty seventy eighty ninety'.split(' ')
const NUMBER_WORD = `${NUMBERS.join('|')}|(?:${TENS.join('|')})(?:[- ](?:${NUMBERS.slice(1, 10).join('|')}))?`
const AMOUNT = String.raw`\d+(?:\.\d+)?|half an?|an?|${NUMBER_WORD}`
const ENGLISH_VALUE = String.raw`(?<amount>${AMOUNT})(?:\s+|-)(?<unit>seconds?|minutes?|hours?|days?|weeks?|months?|years?)\b`
const DURATION_VALUE = new RegExp(String.raw`(?<![\w.-])${ENGLISH_VALUE}`, 'giu')
const CADENCE_UNIT = String.raw`days?|weeks?|months?|years?`
const REPEATS = String.raw`once|twice|(?:${AMOUNT})\s+times`
const CADENCE = String.raw`(?:(?<adverb>daily|weekly|monthly|yearly|annually)|(?:(?<everyRepeats>${REPEATS})\s+)?(?:every|each)\s+(?:(?<interval>${AMOUNT}|other)\s+)?(?<everyUnit>${CADENCE_UNIT}|(?:mon|tues|wednes|thurs|fri|satur|sun)days?)|(?<repeats>${REPEATS})\s+(?:a|per)\s+(?<repeatUnit>${CADENCE_UNIT}))\b`
const FREQUENCY_VALUE = new RegExp(String.raw`(?<![\w.-])${CADENCE}`, 'giu')
const LEAD = String.raw`(?:(?:and\s+)?(?:by the way|actually|for context)\s*[,，]\s*)?(?:speaking of [^,，;!?]{1,70}[,，]\s*)?(?:(?:I|we)\s+(?:just|recently)\s+realized(?:\s+that)?\s+)?`
const OBJECT = String.raw`(?<object>[^;!?\n]{1,120}?)`
const DURATION_STATEMENT = new RegExp(String.raw`^${LEAD}(?<claim>(?<actor>I|we)(?:['’]ve|\s+have)\s+(?<action>${ACTION})\s+${OBJECT}\s+for\s+(?<measure>(?:(?:about|roughly|approximately|around)\s+)?${ENGLISH_VALUE})(?:\s+now\b)?)`, 'iu')
const FREQUENCY_STATEMENT = new RegExp(String.raw`^${LEAD}(?<claim>(?<actor>I|we)\s+(?<action>${APPOINTMENT})\s+${OBJECT}\s+(?<measure>${CADENCE})(?:\s+now\b)?)`, 'iu')
const DIFFERENT_CONTEXT = /\b(?:previously|used to|until|if|whereas|but|so far as|assuming|hypothetically)\b|\b(?:the|an?)\s+other\b/iu
const CONTINUED_AMOUNT = new RegExp(String.raw`^\s*(?:and|or|to|[-–])\s*(?:${AMOUNT})\b`, 'iu')
const QUALIFIED_DURATION = String.raw`(?<measure>(?:(?:about|roughly|approximately|around)\s+)?${ENGLISH_VALUE})`
const CUMULATIVE_AMOUNT = String.raw`(?<measure>(?:(?:about|roughly|approximately|around)\s+)?(?:(?<lower>${AMOUNT})\s*(?:[-–—]|to)\s*|between\s+(?<betweenLower>${AMOUNT})\s+and\s+)?${ENGLISH_VALUE})`
const CUMULATIVE_VALUE = new RegExp(String.raw`(?<![\w.-])${CUMULATIVE_AMOUNT}`, 'giu')
const CUMULATIVE_CLAIM = String.raw`(?<actor>I|we|you)(?:(?<perfect>['’]ve|\s+have))?\s+(?:(?:already|just|now)\s+){0,2}(?:spent|logged|put in)\s+(?<total>a total of\s+)?${CUMULATIVE_AMOUNT}`
const CUMULATIVE_OBJECT = String.raw`(?<object>[^,;.!?\n]{2,113}?)`
const CUMULATIVE_END = String.raw`(?=$|[,.;!?]|\s+and\s+(?:I|we|you|it)\b)`
const CUMULATIVE_DIRECT = new RegExp(String.raw`^${LEAD}${CUMULATIVE_CLAIM}\s+(?:on|into|working on)\s+${CUMULATIVE_OBJECT}${CUMULATIVE_END}`, 'iu')
const CUMULATIVE_LINKED = new RegExp(String.raw`^${LEAD}(?<topicActor>I|we|you)(?:['’]ve been|\s+have been|['’]m|['’]re|\s+am|\s+are)\s+(?:working|spending (?:a lot of )?time) on\s+${CUMULATIVE_OBJECT}(?:\s+[-–—]\s+|,\s*(?:and\s+)?)${CUMULATIVE_CLAIM}(?:\s+(?:on|into)\s+(?:it|this|that))?(?:\s+(?:so far|in total))?${CUMULATIVE_END}`, 'iu')
const CUMULATIVE_BARE = new RegExp(String.raw`^${CUMULATIVE_AMOUNT}(?:\s+(?:so far|in total))?[.!]?$`, 'iu')
const CUMULATIVE_UNNAMED = new RegExp(String.raw`^${CUMULATIVE_CLAIM}(?:\s+(?:on|into)\s+it)?(?:\s+(?:so far|in total))?[.!]?$`, 'iu')
const CUMULATIVE_SUBTOTAL = /\b(?:per|each|every|excluding|except for|not counting|since|during)\b|\b(?:daily|weekly|monthly|today|yesterday|last night|this (?:morning|afternoon|evening|day|week|month|year)|last (?:day|week|month|year)|one session|one sitting|previously|used to)\b/iu
const CUMULATIVE_SCOPE = /\b(?:and|or|before|after|as of|with|from|until)\b/iu
const STAY = new RegExp(String.raw`^${LEAD}(?<actor>I|we)\s+(?:was|were|stayed|lived)\s+(?:in|at)\s+${OBJECT}\s+for\s+${QUALIFIED_DURATION}`, 'iu')
const TRAVEL_PLACE = String.raw`(?<object>[^.,;!?\n]{1,90}?)(?=$|[.,;!?]|\s+(?:and|but|which|where)\b)`
const TRAVELLED = new RegExp(String.raw`^${LEAD}(?<actor>I|we)\s+(?:just\s+)?spent\s+${QUALIFIED_DURATION}\s+(?:travell?ing|staying|living|backpacking)(?:\s+(?:alone|solo|with friends|with family))?\s+(?:in|around|across)\s+${TRAVEL_PLACE}`, 'iu')
const RETURNED = new RegExp(String.raw`^${LEAD}(?<actor>I|we)\s+(?:just\s+)?(?:got back|returned)\s+from\s+(?:a|an|my|our)\s+${QUALIFIED_DURATION}\s+(?:trip|stay|vacation)\s+(?:to|in)\s+${TRAVEL_PLACE}`, 'iu')
const STAY_ANCHOR = /\b(?<actor>I|we)\s+(?:was|were|stayed|travelled|traveled|went)\s+(?:in|to)\s+(?<object>[^.,;!?\n]{1,100})/giu
const STAY_ANAPHOR = /^(?:there|the country|the city|that country|that city)$/iu
const COMMUTE = new RegExp(String.raw`\b(?:my|our|the user['’]s)\s+(?:daily\s+)?commute(?:\s+to work)?(?:,\s*which)?\s+(?:takes|lasts|is)\s+${QUALIFIED_DURATION}`, 'iu')
const COMMUTE_TO_WORK = new RegExp(String.raw`^${LEAD}it\s+takes\s+(?:me|us)\s+${QUALIFIED_DURATION}(?<direction>\s+(?:each way|one way|round trip))?\s+to\s+(?:drive|walk|cycle|commute|travel|go|get)\s+to\s+work\b`, 'iu')
const DIRECTION = /^\s*(?:(?:each way|one[- ]way|per direction|round[- ]trip|total)\b|往返|来回|单程)/iu
const TASK_OBJECT = String.raw`(?<object>[^,;!?\n.]{1,110}?)(?=$|[,.;!?]|\s+(?:and|but|which|before|after|because)\b)`
const TASK_LEAD = String.raw`(?:also\s*,\s*)?${LEAD}`
const TASK_TOOK = new RegExp(String.raw`^${TASK_LEAD}it\s+took\s+(?<actor>me|us)(?:\s+and\s+(?:my|our)\s+[a-z]+)?\s+${QUALIFIED_DURATION}\s+to\s+(?<action>[a-z]+)\s+${TASK_OBJECT}`, 'iu')
const TASK_DONE = new RegExp(String.raw`^${TASK_LEAD}(?<actor>I|we)\s+(?:just\s+|recently\s+)?(?<action>[a-z]+)\s+${OBJECT}(?:,\s*|\s+)and\s+it\s+took\s+(?:me|us)\s+${QUALIFIED_DURATION}`, 'iu')
const ACTUAL_ONLY = /\b(?:if|assuming|would|could|might|maybe|not|never|hope|planning|planned|imagined|hypothetically|expected)\b/iu
const ROUTINE_PAST = /\b(?:previously|formerly|earlier|before|back then|used to)\b/iu
const ROUTINE_NOW = /\b(?:now|currently|these days|at present)\b/iu
const CADENCE_TRANSITION = /(?:[,;，；]\s*(?:(?:and|but)\s+)?|\s+(?:and|but)\s+)(?=(?:now|currently|previously|formerly|earlier|back then|these days|(?:the\s+)?current\s+frequency)\b)|[,;，；]\s*(?:但|不过|而|可)?(?=(?:现在|如今|目前|以前|先前|原来|从前|过去))/iu
const ROUTINE_LEAD = String.raw`(?:oh[,]?\s*)?${LEAD}`
const ROUTINE_VERB = String.raw`play(?:ed)?|practi[cs](?:e|ed)`
const ROUTINE_DIRECT = new RegExp(String.raw`^${ROUTINE_LEAD}(?:(?<when>previously|formerly|earlier|back then|now|currently|these days)[,]?\s+)?(?<actor>I|we)\s+(?<used>used to\s+)?(?:(?:usually|normally|regularly)\s+)?(?<action>${ROUTINE_VERB})\s+${OBJECT}\s+(?<measure>${CADENCE})(?:\s+(?<end>now|previously|back then))?`, 'iu')
const ROUTINE_CONFIRMED = new RegExp(String.raw`^${ROUTINE_LEAD}(?<actor>I|we)(?:['’](?:m|re)|\s+(?:am|are))\s+(?:planning to|going to)\s+(?<action>${ROUTINE_ACTION})\s+${OBJECT}\s+(?:this|next)\s+[a-z]+,\s*(?:as|like)\s+(?:I|we)\s+(?:usually\s+)?do\s+(?<measure>${CADENCE})`, 'iu')
const ROUTINE_NOUN = new RegExp(String.raw`\b(?:reminds? me of|I (?:attend|have|enjoy)|during)\s+my\s+(?:own\s+)?(?<measure>${CADENCE})\s+(?<activity>[^,.;!?\n]{1,50}?)\s+(?:sessions|games|practice)(?<qualifiers>[^,.;!?\n]{0,80})`, 'iu')
const ALLOCATION_CADENCE = String.raw`(?<cadence>(?:daily|weekly|monthly|(?:every|each|per|a)\s+(?:day|week|month))\b)`
const ALLOCATION_ACTIVITY = String.raw`(?<activity>[^,.;!?“”"\n]{2,100}?)`
const ALLOCATION_CONNECTOR = String.raw`(?:(?:on|to|for)\s+)?`
const ALLOCATION_QUERY = new RegExp(String.raw`^how (?:much time|long|many (?:hours|minutes)) do (?<actor>I|we) (?:spend|dedicate)\s+${ALLOCATION_CONNECTOR}${ALLOCATION_ACTIVITY}\s+${ALLOCATION_CADENCE}$`, 'iu')
const ALLOCATION_ACTOR = String.raw`^${LEAD}(?<actor>I|we)(?:['’]ve been|\s+have been)?\s+`
const ALLOCATION_GIVE = String.raw`(?:spend(?:ing)?|dedicat(?:e|ing))\s+`
const ALLOCATION_END = String.raw`(?=$|[.;!?]|,?\s+(?:and\s+(?:I|we|it)\b|because\b|which\b))`
const ALLOCATION_STATEMENTS = [
  String.raw`${ALLOCATION_GIVE}${QUALIFIED_DURATION}\s+${ALLOCATION_CADENCE}\s+${ALLOCATION_CONNECTOR}${ALLOCATION_ACTIVITY}${ALLOCATION_END}`,
  String.raw`${ALLOCATION_GIVE}${QUALIFIED_DURATION}\s+${ALLOCATION_CONNECTOR}${ALLOCATION_ACTIVITY}\s+${ALLOCATION_CADENCE}${ALLOCATION_END}`,
  String.raw`${ALLOCATION_ACTIVITY}\s+for\s+${QUALIFIED_DURATION}\s+${ALLOCATION_CADENCE}${ALLOCATION_END}`,
].map(pattern => new RegExp(ALLOCATION_ACTOR + pattern, 'iu'))
const ALLOCATION_NONFACT = /\b(?:unless|will|won['’]t|no longer|used to|want to|aim to|try to|trying to|intend to|setting aside|for example|pretend|at least|at most|more than|less than)\b/iu
const OTHER_ALLOCATION_PERIOD = /\b(?:each|every|per|a)\s+(?:other\s+(?:day|week|month)|session|lesson|class|time|weekday|weekend)\b|每(?:次|场|节|堂|个工作日|个周末)|隔(?:天|周|月)/iu
const APPROXIMATE_ALLOCATION = new RegExp(String.raw`\b(?:about|roughly|approximately|around)\s+(?:${AMOUNT})\b|(?:大约|大概|大致|约|差不多)\s*(?:\d|[零〇一二两三四五六七八九十百千半])`, 'iu')

const RACE_BEST_QUERY = /^what (?:was|is) my personal best(?: time)? (?:in|at|for) (?<race>[^,;!?]{2,90})$/iu
const RACE_DISTANCE = /\b(?:\d{1,3}(?:\.\d+)?\s*(?:k(?:m)?|miles?)|(?:half )?marathon)\b/giu
const RACE_LABEL = /^(?:[\p{L}\p{N}'’ -]{1,72}\s+)?(?:\d{1,3}(?:\.\d+)?\s*(?:k(?:m)?|miles?)|(?:half )?marathon)(?: (?:run|race))?$/iu
const RACE_ALTERNATIVE = /\b(?:and|or|versus|another race|a different race)\b/iu
const RACE_NONFACT = /^(?:["“‘'>])|\b(?:if|suppose|imagined?|hypothetic(?:al|ally)|pretend|example|scenario|said|told me|fiction|guess)\b/iu
const RACE_EXAMPLE = /\b(?:example|script|transcript|demo|hypothetical|quote)\s*[:：]$/iu
const RACE_SET_BEST = /(?:^|[,;]\s*(?:and\s+)?)(?:I(?:['’]m| am) (?:happy|glad|excited) to (?:say|share|report) that )?I\s+(?:(?:just|recently)\s+)?(?:set|recorded) (?:a|my|another) personal best(?: time)? (?:in|at|for) (?<race>[^,;!?]{2,90}?) with (?:a|the) time of (?<time>[^;!?]{1,76})$/iu
const RACE_REPORTED_BEST = /^(?:by the way,\s*)?my personal best(?: time)? (?:in|at|for) (?<race>[^,;!?]{2,90}?) (?:was|is) (?<time>[^;!?]{1,76})$/iu
const RACE_PREPARATION = /^(?:by the way,\s*)?I(?:['’]m| am) (?:training|preparing|getting ready) for (?<race>[^,;!?]{2,90}?)(?: coming up)?(?:,? and I (?:was wondering|wanted to ask)\b[^;!?]{1,180})?[.!?]?$/iu
const RACE_TO_BEAT = /^(?:by the way,\s*)?I(?:['’]m| am) (?:hoping|trying|aiming) to beat my personal best(?: time)? of (?<time>[^;!?]{1,76}?)(?: this time around)?$/iu
const RACE_BEST_ANSWER = /^(?:my|your) personal best(?: time)?(?: (?:in|at|for) (?<race>[^,;!?]{2,90}?))? (?:was|is) (?<time>[^;!?]{1,76})$/iu

function countOf(raw) {
  const value = raw.toLowerCase()
  let count = Number(value)
  if (!Number.isFinite(count)) {
    if (/^an?$/u.test(value)) count = 1
    else if (value.startsWith('half ')) count = 0.5
    else if (NUMBERS.includes(value)) count = NUMBERS.indexOf(value)
    else {
      const [tens, ones] = value.split(/[- ]/u)
      const tensIndex = TENS.indexOf(tens)
      if (tensIndex === -1) return null
      count = (tensIndex + 2) * 10 + (ones ? NUMBERS.indexOf(ones) : 0)
    }
  }
  return count
}

function canonicalDuration({ amount, unit }) {
  const count = countOf(amount)
  return count === null ? null : `${count} ${unit.toLowerCase().replace(/s$/u, '')}`
}

export function raceKey(label) {
  const name = label.trim().replace(/\s+/gu, ' ').replace(/^(?:the|a|an|another)\s+/iu, '')
  if (!RACE_LABEL.test(name) || RACE_ALTERNATIVE.test(name) || [...name.matchAll(RACE_DISTANCE)].length !== 1) return null
  return name.toLowerCase().replace(/(\d)\s*k(?:m)?\b/gu, '$1k').replace(/ (?:run|race)$/u, '')
}

function raceSeconds(text) {
  const time = text.trim()
  const clock = /^(\d{1,3}):([0-5]\d)(?::([0-5]\d))?$/u.exec(time)
  if (clock) return clock[3] === undefined ? +clock[1] * 60 + +clock[2] : +clock[1] * 3600 + +clock[2] * 60 + +clock[3]
  let seconds = 0, previousUnit = Infinity, end = 0
  for (const match of time.matchAll(DURATION_VALUE)) {
    const separator = time.slice(end, match.index)
    const unit = { hour: 3600, minute: 60, second: 1 }[match.groups.unit.toLowerCase().replace(/s$/u, '')]
    const amount = countOf(match.groups.amount)
    if (!unit || !Number.isSafeInteger(amount) || unit >= previousUnit ||
        (end ? !/^(?:,?\s+(?:and\s+)?|,\s*)$/iu.test(separator) || amount >= 60 : separator)) return null
    seconds += amount * unit
    previousUnit = unit
    end = match.index + match[0].length
  }
  return end === time.length && Number.isSafeInteger(seconds) ? seconds : null
}

export function raceDurationSeconds(text) {
  const parts = /^(?<main>[^()]+?)(?:\s*\((?<echo>[^()]+)\))?$/u.exec(text)?.groups
  if (!parts) return null
  const seconds = raceSeconds(parts.main)
  return seconds > 0 && (!parts.echo || raceSeconds(parts.echo) === seconds) ? seconds : null
}

function raceDuration(text) {
  const seconds = raceDurationSeconds(text)
  return seconds === null ? null : seconds + ' second'
}

function racePersonalBestFacts(plan, text) {
  const facts = []
  let previous = null, end = 0
  for (const quote of sourceSentences(text)) {
    const from = text.indexOf(quote, end)
    end = from + quote.length
    const sentence = quote.normalize('NFKC')
    const outsideExample = !RACE_EXAMPLE.test(previous?.text ?? '')
    if (outsideExample && !RACE_NONFACT.test(sentence)) {
      const statement = sentence.replace(/[.!]+$/u, '')
      const direct = (RACE_SET_BEST.exec(statement) ?? RACE_REPORTED_BEST.exec(statement))?.groups
      const reference = previous?.race === plan.activity && RACE_TO_BEAT.exec(statement)?.groups
      const measure = direct && raceKey(direct.race) === plan.activity ? direct.time : reference?.time
      const value = measure && raceDuration(measure)
      if (value) facts.push({ quote: direct ? quote : text.slice(previous.from, end), value, measure })
    }
    // A goal to beat a best names a prior result only when the preceding sentence establishes a single matching race.
    const training = outsideExample && [...sentence.matchAll(RACE_DISTANCE)].length === 1 && RACE_PREPARATION.exec(sentence)?.groups
    previous = { from, text: sentence, race: training ? raceKey(training.race) : null }
  }
  return facts
}

export function racePersonalBestAnswer(plan, answer) {
  const text = withoutEvidencePreface(String(answer ?? '').normalize('NFKC').trim()).replace(/[.!]+$/u, '')
  const claim = RACE_BEST_ANSWER.exec(text)?.groups
  if (claim?.race && raceKey(claim.race) !== plan.activity) return null
  return raceDuration(claim?.time ?? text)
}

export function usesLatestTimeEvidence(plan) {
  return plan?.mode === 'cumulative' || plan?.mode === 'race-best'
}

function cumulativeDuration(groups) {
  const upper = canonicalDuration(groups)
  const lowerRaw = groups.lower ?? groups.betweenLower
  if (upper === null || !lowerRaw) return upper
  const lower = countOf(lowerRaw)
  return lower !== null && lower < countOf(groups.amount) ? `${lower}–${upper}` : null
}

function canonicalFrequency({ adverb, repeats, everyRepeats, interval, repeatUnit, everyUnit }) {
  if (adverb) {
    const unit = { daily: 'day', weekly: 'week', monthly: 'month', yearly: 'year', annually: 'year' }[adverb.toLowerCase()]
    return `1/1 ${unit}`
  }
  const value = (repeats ?? everyRepeats)?.toLowerCase()
  const count = value === undefined || value === 'once' ? 1 : value === 'twice' ? 2 : countOf(value.replace(/\s+times$/u, ''))
  const span = interval === undefined ? 1 : /^other$/iu.test(interval) ? 2 : countOf(interval)
  const unit = (repeatUnit ?? everyUnit).toLowerCase().replace(/s$/u, '')
  const weekday = /^(?:mon|tues|wednes|thurs|fri|satur|sun)day$/u.test(unit)
  return count > 0 && span > 0 ? `${count}/${span} ${weekday ? 'week' : unit}` : null
}

function actionFamily(action) {
  const normalized = action.toLowerCase().replace(/\s+/gu, ' ')
  if (normalized === 'used' || normalized === 'been using') return 'use'
  if (normalized === 'had' || normalized === 'owned' || normalized === 'been keeping') return 'possession'
  return normalized
}

function subjectTerms(value) {
  const object = value.trim().replace(/^(?:my|our|the|an?)\s+/iu, '')
  const named = APPOSITIVE_NAME.exec(object)
  return tokenize(named?.[1] ?? object).filter(term => !['a', 'an', 'the', 'my', 'our', 'this', 'current'].includes(term))
}

function hasSubject(terms, value) {
  const subject = subjectTerms(value)
  return terms.length > 0 && subject.some((_, index) => terms.every((term, offset) => subject[index + offset] === term))
}

function ongoingActivityTerms(object, keepInstructor) {
  const topic = object.replace(/^(?:weekly|daily|monthly|regular)\s+/iu, '')
  return subjectTerms(keepInstructor ? topic : topic.replace(
    /\s+with\s+(?:an?|my|our|the)\s+(?:new\s+)?(?:instructor|tutor|teacher|coach)(?:,\s*[\p{L}'’-]+)?,?$/iu, ''))
}

function cumulativeSubject(value) {
  return subjectTerms(value.replace(/^your\s+/iu, '').replace(/(?:\s+(?:at home|recently|lately|so far|in total))+$/iu, '')).join(' ')
}

function routineScope(value) {
  const [body, ...fields] = value.split(/\s+(with|at|in)\s+/iu)
  const scope = { activity: subjectTerms(body).join(' ') }
  for (let index = 0; index < fields.length; index += 2) {
    const key = /^with$/iu.test(fields[index]) ? 'participants' : 'venue'
    if (key in scope) return null
    scope[key] = subjectTerms(fields[index + 1]).join(' ')
  }
  return scope.activity ? scope : null
}

function allocationCadence(value) {
  const text = value.toLowerCase()
  if (text === 'daily' || text.endsWith('day')) return 'day'
  if (text === 'weekly' || text.endsWith('week')) return 'week'
  return 'month'
}

function allocationActivity(value) {
  if (/\b(?:and|or|if|before|after|as of|per|every|each)\b/iu.test(value)) return null
  return value.trim().toLowerCase().replace(/\s+/gu, ' ')
    .replace(/^practi[cs](?:e|ing)\b/u, 'practice')
}

export function timeMeasureIntent(query) {
  const text = String(query ?? '').normalize('NFKC').trim().replace(/[?？]+$/u, '')
  const chinese = zhTimeMeasureIntent(text)
  if (chinese) return chinese
  const race = RACE_BEST_QUERY.exec(text)?.groups.race
  const raceActivity = race && raceKey(race)
  if (raceActivity) return { detail: 'duration', mode: 'race-best', activity: raceActivity,
    subject: raceActivity, actor: 'i', entityTerms: tokenize(raceActivity), searchQuery: raceActivity + ' personal best' }
  const allocation = ALLOCATION_QUERY.exec(text)
  if (allocation) {
    const { actor, activity, cadence } = allocation.groups
    const subject = allocationActivity(activity)
    if (subject) return { detail: 'duration', mode: 'allocation', actor: actor.toLowerCase(), activity: subject,
      subject: activity.trim(), entityTerms: tokenize(subject), cadence: allocationCadence(cadence) }
  }
  const cumulative = CUMULATIVE_QUERY.exec(text)
  if (cumulative && !CUMULATIVE_SCOPE.test(cumulative.groups.object) && !CUMULATIVE_SUBTOTAL.test(cumulative.groups.object)) {
    const { actor, object } = cumulative.groups
    const activity = cumulativeSubject(object)
    if (activity) return { detail: 'duration', mode: 'cumulative', activity, subject: activity,
      actor: actor.toLowerCase(), entityTerms: activity.split(' ') }
  }
  const body = text.replace(PERIOD_SUFFIX, '')
  const period = /\buse to\b/iu.test(body) || ROUTINE_PAST.test(text.slice(body.length)) ? 'previous'
    : ROUTINE_NOW.test(text.slice(body.length)) ? 'current' : undefined
  const routine = ROUTINE_QUERY.exec(body)
  if (routine && !/\b(?:and|or|if|as of|before|after)\b/iu.test(routine.groups.object)) {
    const scope = routineScope(routine.groups.object)
    if (scope) return { detail: 'frequency', actor: routine.groups.actor.toLowerCase(), action: routine.groups.action.toLowerCase(),
      mode: 'routine', period, scope, entityTerms: tokenize(scope.activity), subject: routine.groups.object }
  }
  const stay = STAY_QUERY.exec(text), task = TASK_QUERY.exec(text)
  if (COMMUTE_QUERY.test(text)) {
    return { detail: 'duration', mode: 'commute', entityTerms: ['commute'], subject: 'commute to work',
      searchQuery: 'commute travel drive walk ride cycle work' }
  }
  const event = stay ?? task
  if (event && !/\b(?:and|or|as of|before|after)\b/iu.test(event.groups.object)) {
    const { object, singular, plural, past, actor, action } = event.groups
    return { detail: 'duration', mode: stay ? 'stay' : 'task', subject: object,
      actor: (singular ?? plural ?? past ?? (actor?.toLowerCase() === 'us' ? 'we' : 'I')).toLowerCase(),
      action: action?.toLowerCase(), entityTerms: subjectTerms(task ? object.replace(/^(?:to|into|onto)\s+/iu, '') : object),
      ...(task && !actor ? { groupAllowed: true } : {}) }
  }
  const duration = DURATION_QUERY.exec(text)
  const match = duration ?? FREQUENCY_QUERY.exec(body)
  if (!match || /\b(?:and|or|as of|before|after)\b/iu.test(match.groups.object)) return null
  const object = match.groups.object
  const parts = object.split(',').map(part => part.trim())
  if (parts.length > 1) {
    const apposition = duration ? APPOSITIVE_NAME.test(object) : TITLED_NAME.exec(parts[1])?.[0] === parts[1]
    if (parts.length !== 2 || !apposition) return null
  }
  const detail = duration ? 'duration' : 'frequency'
  const entityTerms = duration ? subjectTerms(object) : tokenize(TITLED_NAME.exec(object)?.[0] ?? '')
  if (entityTerms.length === 0) return null
  const subject = object.replace(/^(?:my|our)\s+/iu, '').replace(/[,<>\[\]]/gu, ' ').replace(/\s+/gu, ' ').trim()
  return { detail, actor: match.groups.actor.toLowerCase(), action: actionFamily(match.groups.action), entityTerms, subject,
    ...(detail === 'frequency' && period ? { period } : {}) }
}

export function timeMeasureComparison(query) {
  const parts = String(query ?? '').trim().split(/[?？]\s*(?:and\s+)?|(?:[,;，；]|\s+and)\s*(?=(?:how often|what about|now|previously)\b|(?:那)?(?:现在|如今|目前|以前|之前))/iu)
    .map(part => part.trim()).filter(Boolean)
  if (parts.length !== 2) return null
  const first = timeMeasureIntent(parts[0])
  if (first?.detail !== 'frequency' || !first.period) return null
  let second = timeMeasureIntent(parts[1])
  if (!second) {
    if (first.language === 'zh') {
      second = followUpChineseTimeMeasure(parts[1], first)
    } else {
      const next = /^(?:how often do (?<actor>I|we) (?<action>[a-z]+(?: with)?)\s+|what about\s+)?(?<when>now|previously|before|currently)$/iu.exec(parts[1])
      if (!next || (next.groups.actor && next.groups.actor.toLowerCase() !== first.actor) ||
          (next.groups.action && actionFamily(next.groups.action) !== first.action)) return null
      second = { ...first, period: ROUTINE_NOW.test(next.groups.when) ? 'current' : 'previous' }
    }
  }
  if (second?.detail !== 'frequency' || !second.period || first.period === second.period || first.actor !== second.actor ||
      first.action !== second.action || first.entityTerms.join(' ') !== second.entityTerms.join(' ') ||
      first.scope?.participants !== second.scope?.participants || first.scope?.venue !== second.scope?.venue) return null
  return parts.map((part, index) => ({ query: part + (first.language === 'zh' ? '？' : '?'), timeMeasure: index ? second : first }))
}

export function followUpChineseTimeMeasure(query, previous) {
  if (previous?.language !== 'zh' || previous.detail !== 'frequency') return null
  const period = /^(?:那)?(?<when>现在|如今|目前|以前|之前)(?:呢|怎么样|如何)?[？?。]*$/u.exec(String(query ?? '').trim())
  return period ? { ...previous, period: /现在|如今|目前/u.test(period.groups.when) ? 'current' : 'previous' } : null
}

export function chineseTimeMeasureParts(query) {
  const parts = String(query ?? '').split(/[?？，,；;]+/u).map(part => part.trim()).filter(Boolean)
  if (parts.length < 2) return null
  const measured = parts.map(part => ({ query: part + '？', timeMeasure: zhTimeMeasureIntent(part) }))
  return measured.every(part => part.timeMeasure) ? measured : null
}

function directionValue(text) {
  const value = DIRECTION.exec(text)?.[0].trim().toLowerCase()
  return value ? (/^(?:round|total|往返|来回)/u.test(value) ? 'round trip' : 'each way') : ''
}

function durationFact(match, quote, directionText = '') {
  const base = canonicalDuration(match.groups)
  const direction = directionValue(directionText)
  const end = match.index + match[0].length + (match.groups.direction ? 0 : directionText.length)
  if (base === null || CONTINUED_AMOUNT.test(quote.slice(end))) return null
  return { quote: quote.slice(match.index, end), value: direction ? base + ' ' + direction : base,
    measure: directionText ? match.groups.measure + directionText : match.groups.measure }
}

function stayFact(plan, sentence, previous, content) {
  const match = STAY.exec(sentence) ?? TRAVELLED.exec(sentence) ?? RETURNED.exec(sentence)
  if (!match || ACTUAL_ONLY.test(sentence) || match.groups.actor.toLowerCase() !== plan.actor ||
      /\b(?:and|or)\b/iu.test(match.groups.object) ||
      /^\s*(?:and\s+(?!(?:I|we|it|they|he|she|that)\b)|,\s*\p{Lu})/u.test(sentence.slice(match[0].length))) return null
  if (hasSubject(plan.entityTerms, match.groups.object)) return durationFact(match, sentence)
  if (!STAY_ANAPHOR.test(match.groups.object.trim()) || !previous || ACTUAL_ONLY.test(previous) ||
      /\b(?:before|after|then|or)\b/iu.test(previous)) return null
  const anchors = [...previous.matchAll(STAY_ANCHOR)].filter(anchor => anchor.groups.actor.toLowerCase() === plan.actor)
  if (anchors.length !== 1 || /\b(?:and|or)\b/iu.test(anchors[0].groups.object) ||
      !hasSubject(plan.entityTerms, anchors[0].groups.object)) return null
  const offset = content.indexOf(previous)
  const next = content.indexOf(sentence, offset + previous.length)
  if (next < 0 || !/^\s{1,8}$/u.test(content.slice(offset + previous.length, next))) return null
  const proof = durationFact(match, sentence)
  return proof && { ...proof, quote: content.slice(offset, next + proof.quote.length) }
}

function taskFact(plan, sentence) {
  const match = TASK_TOOK.exec(sentence) ?? TASK_DONE.exec(sentence)
  if (!match || ACTUAL_ONLY.test(match[0])) return null
  const actor = /^(?:i|me)$/iu.test(match.groups.actor) ? 'i' : 'we'
  const action = match.groups.action.toLowerCase()
  const simplePast = plan.action.endsWith('e') ? plan.action + 'd'
    : plan.action.endsWith('y') ? plan.action.slice(0, -1) + 'ied' : plan.action + 'ed'
  if ((!plan.groupAllowed && actor !== plan.actor) || (action !== plan.action && action !== simplePast) ||
      /\b(?:and|or|before|after|while)\b/iu.test(match.groups.object) || !hasSubject(plan.entityTerms, match.groups.object)) return null
  return durationFact(match, sentence)
}

function routineFact(plan, sentence) {
  const direct = ROUTINE_DIRECT.exec(sentence)
  const match = direct ?? ROUTINE_NOUN.exec(sentence) ?? ROUTINE_CONFIRMED.exec(sentence)
  if (!match || (direct ? ACTUAL_ONLY.test(direct[0]) : /\b(?:if|would|not|might|maybe|hypothetically)\b/iu.test(sentence))) return null
  const { actor, action, object, activity, qualifiers, when, used, end, measure } = match.groups
  const who = actor?.toLowerCase() ?? 'i'
  const verb = action?.toLowerCase().replace(/ed$/u, '') ?? 'play'
  if (who !== plan.actor || (verb !== plan.action && verb + 'e' !== plan.action)) return null
  const scope = routineScope(object ?? activity + qualifiers)
  if (!scope || scope.activity !== plan.scope.activity ||
      (plan.scope.participants && scope.participants !== plan.scope.participants) ||
      (plan.scope.venue && scope.venue && scope.venue !== plan.scope.venue)) return null
  const remainder = sentence.slice(match.index + match[0].length)
  if (CONTINUED_AMOUNT.test(remainder) || /^\s*[,，]?\s*(?:but|whereas|actually|instead)\b/iu.test(remainder)) return null
  const previous = Boolean(used || ROUTINE_PAST.test(when ?? '') || ROUTINE_PAST.test(end ?? '') || /ed$/iu.test(action ?? ''))
  if (previous && (ROUTINE_NOW.test(when ?? '') || ROUTINE_NOW.test(end ?? ''))) return null
  const value = canonicalFrequency(match.groups)
  return value === null ? null : { quote: match[0], value, measure, period: previous ? 'previous' : 'current',
    unconfirmedVenue: Boolean(plan.scope.venue && !scope.venue) }
}

function cumulativeFact(plan, sentence, answer = false) {
  if (ACTUAL_ONLY.test(sentence) || ALLOCATION_NONFACT.test(sentence) || CUMULATIVE_SUBTOTAL.test(sentence) || /[?？]/u.test(sentence)) return null
  const match = CUMULATIVE_DIRECT.exec(sentence) ?? CUMULATIVE_LINKED.exec(sentence) ??
    (answer ? CUMULATIVE_UNNAMED.exec(sentence) ?? CUMULATIVE_BARE.exec(sentence) : null)
  if (!match || /^\s*,?\s*(?:but|whereas|instead|or)\b/iu.test(sentence.slice(match[0].length))) return null
  const { actor, topicActor, perfect, total, object, measure } = match.groups
  if (actor && actor.toLowerCase() !== plan.actor && !(answer && actor.toLowerCase() === 'you')) return null
  if (topicActor && topicActor.toLowerCase() !== actor.toLowerCase()) return null
  if (object && (CUMULATIVE_SCOPE.test(object) || cumulativeSubject(object) !== plan.activity)) return null
  if (!answer && !perfect && !total && !/\b(?:so far|in total)\b/iu.test(match[0])) return null
  const value = cumulativeDuration(match.groups)
  return value === null ? null : { quote: match[0], value, measure }
}

function allocationFact(plan, sentence) {
  if (ACTUAL_ONLY.test(sentence) || ALLOCATION_NONFACT.test(sentence) || OTHER_ALLOCATION_PERIOD.test(sentence) || /[?？]/u.test(sentence)) return null
  for (const pattern of ALLOCATION_STATEMENTS) {
    const match = pattern.exec(sentence)
    if (!match) continue
    const { actor, activity, cadence, measure } = match.groups
    if (actor.toLowerCase() !== plan.actor || allocationActivity(activity) !== plan.activity ||
        allocationCadence(cadence) !== plan.cadence || !/^(?:seconds?|minutes?|hours?)$/iu.test(match.groups.unit)) continue
    const value = canonicalDuration(match.groups)
    if (value !== null) return { quote: match[0], value, measure: `${measure} ${cadence}` }
  }
  return null
}

export function timeMeasureClauses(text) {
  return sourceSentences(text).flatMap(sentence => sentence.split(CADENCE_TRANSITION))
}

export function timeMeasureFacts(plan, content, { forPastEvent = false } = {}) {
  if (!plan) return []
  const text = String(content ?? '')
  if (plan.mode === 'race-best') return racePersonalBestFacts(plan, text)
  if (plan.language === 'zh') {
    const localized = zhTimeMeasureFacts(plan, text, plan.mode === 'routine' ? timeMeasureClauses(text) : undefined)
    if (localized.length || plan.mode !== 'use' || /\p{Script=Han}/u.test(text)) return localized
    // The original can be in English when the same named object appears in both languages.
    plan = { ...plan, mode: undefined }
  }
  const sentences = plan.mode === 'routine' ? timeMeasureClauses(text) : sourceSentences(text)
  const duration = plan.detail === 'duration'
  const keepInstructor = forPastEvent && /\bwith\b/iu.test(plan.subject)
  const facts = []
  for (const [index, quote] of sentences.entries()) {
    if (plan.mode) {
      let proof
      if (plan.mode === 'stay') proof = stayFact(plan, quote, sentences[index - 1], text)
      else if (plan.mode === 'task') proof = taskFact(plan, quote)
      else if (plan.mode === 'routine') proof = routineFact(plan, quote)
      else if (plan.mode === 'allocation') proof = allocationFact(plan, quote)
      else if (plan.mode === 'cumulative') proof = cumulativeFact(plan, quote)
      else if (plan.mode === 'commute' && !ACTUAL_ONLY.test(quote)) {
        const match = COMMUTE.exec(quote) ?? COMMUTE_TO_WORK.exec(quote)
        if (match) {
          const direction = match.groups.direction ?? DIRECTION.exec(quote.slice(match.index + match[0].length))?.[0]
          proof = durationFact(match, quote, direction)
        }
      }
      if (proof) facts.push(proof)
      continue
    }
    const match = (duration ? DURATION_STATEMENT : FREQUENCY_STATEMENT).exec(quote)
    if (!match || DIFFERENT_CONTEXT.test(match[0])) continue
    const tail = quote.slice(match[0].length)
    if (CONTINUED_AMOUNT.test(tail) || /^\s*[,，]?\s*(?:but|until|whereas|previously)\b/iu.test(tail)) continue
    const { actor, action, object } = match.groups
    if (actor.toLowerCase() !== plan.actor || (duration && actionFamily(action) !== plan.action) ||
        /\b(?:and|or)\b/iu.test(object)) continue
    const subject = forPastEvent ? ongoingActivityTerms(object, keepInstructor)
      : duration ? subjectTerms(object) : tokenize(TITLED_NAME.exec(object)?.[0] ?? '')
    if (forPastEvent && (subject.join(' ') !== ongoingActivityTerms(plan.subject, keepInstructor).join(' ') ||
        ACTUAL_ONLY.test(quote) || /\b(?:about|roughly|approximately|around)\b/iu.test(match.groups.measure) ||
        /\b(?:on and off|in total|off and on|break|paused|resumed|stopped|restarted|before)\b/iu.test(tail))) continue
    if (!duration && subject.length !== plan.entityTerms.length) continue
    if (!forPastEvent && !subject.some((_, index) => plan.entityTerms.every((term, offset) => subject[index + offset] === term))) continue
    const value = duration ? canonicalDuration(match.groups) : canonicalFrequency(match.groups)
    if (value === null) continue
    // The match contains the subject and its stated duration as a contiguous quote.
    facts.push({ quote: match.groups.claim, value, measure: match.groups.measure })
  }
  return facts
}

export function timeMeasureEvidence(plan, content) {
  return timeMeasureFacts(plan, content).find(proof => !proof.unconfirmedVenue &&
    (plan.period === 'previous' ? proof.period === 'previous' : proof.period !== 'previous')) ?? null
}

/** Preserve the timeframe and any stated approximation in the reported answer. */
export function matchesRecordedTimeAnswer(plan, text, excerpts) {
  if (plan?.mode === 'cumulative') {
    if (!cumulativeFact(plan, withoutEvidencePreface(text), true)) return false
    return !excerpts.length || !excerpts.every(excerpt => APPROXIMATE_ALLOCATION.test(excerpt)) ||
      APPROXIMATE_ALLOCATION.test(text) && !/\b(?:exactly|precisely)\b/iu.test(text)
  }
  if (plan?.mode !== 'allocation') return true
  if (OTHER_ALLOCATION_PERIOD.test(text)) return false
  const cadences = [...text.matchAll(new RegExp(ALLOCATION_CADENCE, 'giu'))].map(match => allocationCadence(match.groups.cadence))
  cadences.push(...zhAllocationCadence(text))
  if (cadences.some(cadence => cadence !== plan.cadence)) return false
  return !excerpts.length || !excerpts.every(excerpt => APPROXIMATE_ALLOCATION.test(excerpt)) ||
    APPROXIMATE_ALLOCATION.test(text) && !/\b(?:exactly|precisely)\b|精确|整整/iu.test(text)
}

export function statedTimeMeasures(detail, text, { direction = false, cumulative = false } = {}) {
  const duration = detail === 'duration'
  const value = String(text ?? '').normalize('NFKC')
  if (cumulative) return [...value.matchAll(CUMULATIVE_VALUE)].map(match => cumulativeDuration(match.groups)).filter(Boolean)
  const english = [...value.matchAll(duration ? DURATION_VALUE : FREQUENCY_VALUE)].flatMap(match => {
    const normalized = (duration ? canonicalDuration : canonicalFrequency)(match.groups)
    if (normalized === null) return []
    const suffix = duration && direction ? directionValue(value.slice(match.index + match[0].length)) : ''
    return [suffix ? normalized + ' ' + suffix : normalized]
  })
  return [...english, ...zhStatedTimeMeasures(detail, value, direction)]
}

export function timeMeasureValueKey(value) {
  const fixed = /^(\d+(?:\.\d+)?)(?:–(\d+(?:\.\d+)?))? (second|minute|hour)(?: (each way|round trip))?$/u.exec(value)
  if (!fixed) return value
  const units = { second: 1, minute: 60, hour: 3600 }
  const first = Number(fixed[1]) * units[fixed[3]]
  const upper = fixed[2] ? '–' + Number(fixed[2]) * units[fixed[3]] : ''
  return `${first}${upper} second${fixed[4] ? ' ' + fixed[4] : ''}`
}

export function timeMeasureAnswerPeriod(text) {
  const before = ROUTINE_PAST.test(text) || /\bprevious\s+(?:frequency|cadence)\b|以前|先前|从前|原来|过去/u.test(text)
  const now = ROUTINE_NOW.test(text) || /\bcurrent\b(?=\s*(?::|frequency\b|cadence\b))|现在|目前|如今/iu.test(text)
  return before === now ? null : before ? 'previous' : 'current'
}
