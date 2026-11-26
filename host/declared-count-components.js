import { readDayCount } from './calendar-recall.js'
import { sourceSentences } from './sentences.js'
import { tokenize } from './tokenize.js'

const NOT_ASSERTED = /^(?:[>"'“‘「『]|quoted?[:：]|引用[:：])|\b(?:if|unless|not|never|might|maybe|about|around|roughly|approximately|estimated?|pretend|hypothetical|for example|said|says|told|quoted|claimed|heard|thought|guessed)\b/iu
const PAGE_POSITION = /\b(?<actor>I|we)(?:['’](?:m|re)|\s+(?:am|are|was|were))\s+(?:(?:currently|now|still)\s+)?(?:on|at)\s+page\s+(?<page>\d{1,7})\s+(?:of|in)\s+(?<title>.+)$/iu
const PAGE_TOTAL = /^(?<title>[^.!?;,\n]{1,90}?)\s+(?:has|contains|is)\s+(?<pages>\d{1,7})\s+pages?(?:\s+long)?\s*[.!]?$/iu
const NAMED_READING = /\b(?:I|we)(?:['’]ve)?\s+(?:just\s+)?(?:got back to|returned to|started|resumed|have been|am|are)\s+reading\s+(?<reading>.+)$/iu
const READING_LENGTH = /\b(?:it is|it['’]s)\s+(?:[^.!?]{1,48}?\s+with\s+)?(?<pages>\d{1,7})\s+pages?\b/iu
const EDITION = /\b(?:abridged|unabridged|edition|volume|paperback|hardcover|large print|workbook)\b/iu
const STUDY_RANGE = /(?=(?<quote>\b(?<actor>I|we)\s+(?:(?:actually|then|also)\s+)?(?:attended|studied at|went to|was enrolled at|were enrolled at)\s+(?<school>[^.!?;,\n]{1,70}?)\s+from\s+(?<from>[12]\d{3})\s+(?:to|through)\s+(?<to>[12]\d{3})\b))/giu
const GRADUATION = /\b(?<actor>I|we)\s+(?:(?:actually|then|also)\s+)?(?:graduated with|completed|earned|finished)\s+(?<degree>[^.!?;,\n]{1,92}?)\s+in\s+(?<year>[12]\d{3})\b/iu
const DEGREE_TIME = /^(?:,\s*which\s+|\s+and it\s+)took\s+(?:me|us)\s+(?<years>\d+|[a-z]+(?:[- ][a-z]+)?)\s+years?\s+to\s+complete\b/iu
const EDUCATION = /\b(?:school|college|university|educat\w+|degree)\b/iu

export function bookTitle(text) {
  const value = text.trim().replace(/^(?:the|a|an)\s+/iu, '')
  const quoted = /^[“‘"'](?<name>.+?)[”’"'](?=$|[,.!?\s])/u.exec(value)
  const name = quoted?.groups.name ?? value.split(/[,.;!?]|\s+(?:by|which|and)\s+/iu, 1)[0]
  return tokenize(name.replace(/^(?:the|a|an)\s+/iu, '')).join(' ')
}

function readingComponents(plan, sentence) {
  const position = PAGE_POSITION.exec(sentence)
  if (position && (!plan.actor || position.groups.actor.toLowerCase() === plan.actor) &&
      bookTitle(position.groups.title) === plan.title && !EDITION.test(sentence)) {
    return [{ role: 'position', amount: Number(position.groups.page), quote: position[0] }]
  }
  if (EDITION.test(sentence)) return []
  const total = PAGE_TOTAL.exec(sentence)
  if (total && bookTitle(total.groups.title) === plan.title) {
    return [{ role: 'length', amount: Number(total.groups.pages), quote: sentence }]
  }
  const reading = NAMED_READING.exec(sentence)
  const length = reading && READING_LENGTH.exec(reading.groups.reading)
  if (length) {
    const lead = reading.groups.reading.slice(0, length.index)
    const names = [...lead.matchAll(/["“]([^"“”]+)["”]/gu)]
    if (lead.length <= 150 && !/\b(?:another|different)\b/iu.test(lead) &&
        names.length <= 1 && bookTitle(lead) === plan.title) {
      return [{ role: 'length', amount: Number(length.groups.pages), quote: sentence }]
    }
  }
  return []
}

function containsTerms(text, terms) {
  const words = tokenize(text.replace(/([\p{L}])['’]s\b/gu, '$1'))
  return terms.length > 0 && words.some((_, index) => terms.every((term, offset) => words[index + offset] === term))
}

function studyComponents(plan, sentence) {
  const results = []
  for (const match of sentence.matchAll(STUDY_RANGE)) {
    const { actor, school, quote, from, to } = match.groups
    if (actor.toLowerCase() !== plan.actor || !EDUCATION.test(school) || /\b(?:before|after|and)\b/iu.test(school) || +from >= +to) continue
    const role = containsTerms(school, plan.boundaries[0]) ? 'start' : 'period'
    results.push({ role, from: +from, to: +to, label: school, quote })
  }
  const graduate = GRADUATION.exec(sentence)
  if (graduate && graduate.groups.actor.toLowerCase() === plan.actor) {
    const boundary = plan.boundaries[1].filter(word => !['completion', 'of', 'degree'].includes(word))
    const { degree, year } = graduate.groups
    const duration = DEGREE_TIME.exec(sentence.slice(graduate.index + graduate[0].length))
    const count = duration ? readDayCount(duration.groups.years.toLowerCase()) : null
    if (containsTerms(degree, boundary) && Number.isSafeInteger(count) && count > 0 && count <= +year) {
      results.push({ role: 'end', from: +year - count, to: +year, label: degree,
        quote: sentence.slice(graduate.index, graduate.index + graduate[0].length + duration[0].length) })
    }
  }
  return results
}

export function countComponents(plan, content) {
  if (!plan.title && !plan.educationYears) return []
  const recognize = plan.title ? readingComponents : studyComponents
  return sourceSentences(content).flatMap(sentence => NOT_ASSERTED.test(sentence) || /[?？]/u.test(sentence)
    ? [] : recognize(plan, sentence))
}

function oneAmount(rows) {
  return rows.length && new Set(rows.map(row => row.fact.amount)).size === 1
    ? rows.reduce((best, row) => row.fact.quote.length < best.fact.quote.length ? row : best) : null
}

function oneRange(rows) {
  return rows.length && new Set(rows.map(row => row.fact.from + ':' + row.fact.to)).size === 1
    ? rows.reduce((best, row) => row.fact.quote.length < best.fact.quote.length ? row : best) : null
}

export function composeCount(plan, rows) {
  if (plan.title) {
    const lengths = rows.filter(row => row.fact.role === 'length')
    const positions = rows.filter(row => row.fact.role === 'position')
    const known = positions.every(row => Number.isSafeInteger(row.time))
    const newest = known ? Math.max(...positions.map(row => row.time)) : null
    const length = oneAmount(lengths)
    const position = oneAmount(known ? positions.filter(row => row.time === newest) : positions)
    if (!length || !position || position.fact.amount < 1 || position.fact.amount > length.fact.amount) return null
    const value = length.fact.amount - position.fact.amount
    return { rows: [length, position], value: String(value), time: newest,
      explanation: length.fact.amount + ' − ' + position.fact.amount + ' = ' + value + ' pages after the open page.' }
  }
  if (!plan.educationYears) return null
  const start = oneRange(rows.filter(row => row.fact.role === 'start'))
  const end = oneRange(rows.filter(row => row.fact.role === 'end'))
  if (!start || !end || start.fact.to > end.fact.from) return null
  const periods = [start]
  let next = start.fact.to
  while (next < end.fact.from && periods.length < 6) {
    const joined = oneRange(rows.filter(row => row.fact.role === 'period' && row.fact.from === next && row.fact.to <= end.fact.from))
    if (!joined) break
    periods.push(joined)
    next = joined.fact.to
  }
  if (next !== end.fact.from) return {
    rows: [start, end], value: null,
    explanation: 'The recorded start and graduation stages do not establish the total time spent. State which attendance period is missing.',
  }
  periods.push(end)
  const parts = periods.map(row => row.fact.to - row.fact.from)
  const value = parts.reduce((sum, part) => sum + part, 0)
  const educationPeriods = periods.map(({ fact: { role, from, to, label } }) => ({ role, from, to, label }))
  return { rows: periods, value: String(value), educationPeriods,
    explanation: parts.join(' + ') + ' = ' + value + ' years in the recorded attendance periods.' }
}
