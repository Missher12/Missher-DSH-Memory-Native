import { originalCalendarPeriod } from './calendar-recall.js'
import { exactMoneyIn } from './quantity-recall.js'
import { sourceSentences } from './sentences.js'
import { DEEP_RECALL_TOKEN_LIMIT, isRecallSourceStatement } from './source-passages.js'
import { tokenize } from './tokenize.js'

const ENGLISH_DISCOUNT = /^(?:what\s+(?:percentage|percent)\s+(?:discount|off)\s+did\s+(?:i|we)\s+(?:get|receive)\s+(?:on|for)\s+|what\s+was\s+the\s+discount\s+percentage\s+(?:on|for)\s+)(.+)$/iu
const CHINESE_DISCOUNT = /^(.+?)(?:的(?:折扣|降价)百分比是多少|(?:[，,]\s*)?(?:便宜了|降价了?|折扣(?:是|为)?)百分之(?:几|多少))$/u
const ORDER_NUMBER = /(?:\b(?:receipt|order|invoice|transaction)(?:\s+(?:id|number))?|订单(?:号)?|收据(?:号)?|小票(?:号)?)\s*[#:：]?\s*([a-z\d][a-z\d-]{2,25})\b/giu
const AUTHOR_LABEL = /\s+(?:from|by)\s+(?:my|our)\s+favou?rite\s+author$/iu
const FAVOURITE_AUTHOR = /\b(?:my|our)\s+favou?rite\s+author\b/iu
const BOOK_RELEASE = /\b(?:book|edition|novel|new release)\b/iu
const WORD_FILLERS = new Set(['a', 'an', 'the', 'my', 'our', 'of', 'on', 'for'])
const ORIGINAL_PRICE = /(?:\b(?:originally priced(?: at)?|originally (?:cost|was)|(?:original|regular|list) price\b[^,，;；:!?]{0,110}?\b(?:was|is|of|at)|(?:original|regular|list) price\s*[:=]?)|(?:原价|标价)\s*(?:是|为|[:：=])?)\s*$/iu
const PAID_PRICE = /(?:\b(?:(?:actually\s+)?paid(?:\s+for\s+[^,，;；!?]{1,65})?|spent|was charged)\s*[:=]?|\b(?:i|we)(?:['’]ve)?\s+(?:(?:just|recently|actually|already)\s+){0,3}(?:bought|purchased|got)\s+[^,，;；!?]{1,110}\s+for|(?:实付|实际付(?:了)?|实际支付(?:了)?|支付了|花了|到手价)\s*(?:是|为|[:：=])?)\s*$/iu
const ORIGINAL_SUBJECT = /\b(?:original|regular|list) price\s+(?:of|for)\s+([^,;:!?]{1,100}?)\s+(?:was|is|at)\s*$/iu
const PURCHASE_SUBJECT = /\b(?:(?:bought|purchased|got)\s+([^,;!?]{1,110})\s+for|paid\s+for\s+([^,;!?]{1,65}))\s*$/iu
const PAID_FOR = /^\s+(?:for|on)\s+(.{1,90}?)(?=\s+(?:on|by|after|from|at|when|and|for)\b|[,，;；.!?]|$)/iu
const NON_PURCHASE = /[?？]|(?:大概|可能|预计|计划|假设|示例|退款|运费|税费|另一[本件笔]|并非|不是|\b(?:if|would|could pay|will pay|may pay|might|plan(?:ned)? to|hoping to|expect(?:ed)? to|not|never|instead of|another item|different (?:item|book)|refund(?:ed)?|shipping|tax|fees|quote for)\b)/iu
const BOUNDARY = /[;；]|,\s+(?=(?:whereas|while|but)\b)|,\s+(?:and|but)\s+(?=(?:i|we|he|she|they)\b)|[，,]\s*(?=而另一|另一件|另一本|而其他)/iu
const REFERENTIAL = /^(?:it(?:['’]s|\s+(?:is|was|cost))|its\b|这(?:件|本|一单)|那(?:件|本|一单)|它)/iu
const PURCHASE_CONTEXT = /\b(?:bought|purchase[ds]?|impulse buy|couldn['’]t resist (?:the|that) sale|paid)\b|买了|购入|这次购买|这笔订单/u
const SINGLE_PURCHASE = /\b(?:my|our)\s+only\s+(?:purchase|order)\b|\b(?:the|my|our)\s+only\s+[^,;.!?]{1,70}\b(?:i|we)\s+(?:bought|purchased)\b|唯一(?:的一笔|一件|一本|购买|订单)|只买了(?:一件|一本|一份)/iu
const MERCHANT = /\b(?:at|from)\s+(my favou?rite (?:book\s?store|book\s?shop|store|shop|market))\b|\b(?:at|from)\s+((?:[\p{Lu}][\p{L}\d'’-]*\s+){0,4}(?:Bookstore|Bookshop|Book Shop|Books|Outfitters|Market|Store|Shop|Retail|Market Hall))\b|(?:在|从)([\p{Script=Han}\p{L}\p{N}]{2,26}(?:书店|门店|商城|超市|商店))/gu
const GENERIC_ITEMS = new Set(['book', 'item', 'product', 'thing', 'purchase', 'order'])
const PRICE_FIELDS = ['list', 'paid']

function receiptNumbers(text) {
  return [...new Set([...text.matchAll(ORDER_NUMBER)].map(match => match[1]).filter(id => /\d/u.test(id)))]
}

export function discountRecallPlan(query) {
  const text = String(query ?? '').normalize('NFKC').trim().replace(/[。.!?！？]+$/u, '')
  if (text.length > 270) return null
  const chinese = CHINESE_DISCOUNT.exec(text), english = ENGLISH_DISCOUNT.exec(text)
  if (!chinese && !english) return null
  const raw = (chinese ?? english)[1].trim().replace(/^(?:the|my|a)\s+|^(?:我买的|我购入的)/iu, '')
  const numbers = receiptNumbers(raw)
  if (numbers.length > 1 || /[<>\n]/u.test(raw)) return null
  const order = [...raw.matchAll(ORDER_NUMBER)].find(match => match[1] === numbers[0])
  const subject = (order ? raw.slice(0, order.index).replace(/\b(?:on|from|in|for)\s*(?:the)?\s*$/iu, '').replace(/在\s*$/u, '') : raw)
    .trim().replace(/^["“「『]+|["”」』]+$/gu, '')
  const base = subject.replace(AUTHOR_LABEL, '')
  if (!base || base.length > 96 || tokenize(base).length === 0) return null
  return { subject, base, receipt: numbers[0] ?? null, author: AUTHOR_LABEL.test(subject), language: chinese ? 'zh' : 'en' }
}

function itemTerms(text) {
  return tokenize(text).filter(word => !WORD_FILLERS.has(word))
}

function namesItem(text, item) {
  if (/\p{Script=Han}/u.test(item)) return text.includes(item)
  const terms = itemTerms(item)
  const actual = itemTerms(text)
  return terms.length > 0 && actual.some((_, from) => terms.every((term, i) => actual[from + i] === term))
}

function namesSubject(text, query) {
  if (!query.author) return namesItem(text, query.base)
  return FAVOURITE_AUTHOR.test(text) && (namesItem(text, query.base) || query.base.toLowerCase() === 'book' && BOOK_RELEASE.test(text))
}

function claimsIn(quote, field) {
  const text = quote.normalize('NFKC')
  const cue = field === 'list' ? ORIGINAL_PRICE : PAID_PRICE
  return exactMoneyIn(text).flatMap(value => {
    const prefix = text.slice(0, value.offset)
    if (!cue.test(prefix)) return []
    if (field === 'list') return [{ ...value, item: ORIGINAL_SUBJECT.exec(prefix)?.[1] }]
    const match = PURCHASE_SUBJECT.exec(prefix)
    const explicit = PAID_FOR.exec(text.slice(value.offset + value.value.length))?.[1]
    const item = match?.[1] ?? match?.[2] ?? (explicit && !/^(?:receipt|order|invoice|transaction)\b/iu.test(explicit) ? explicit : undefined)
    return [{ ...value, item }]
  })
}

function purchaseContext(hit, quote, now) {
  const source = hit.record.sourceRefs?.[0]
  if (source?.eventTime > now || !isRecallSourceStatement(quote) || NON_PURCHASE.test(quote)) return null
  const numbers = receiptNumbers(quote)
  if (numbers.length > 1) return null
  const merchants = new Set([...quote.matchAll(MERCHANT)].map(match => (match[1] ?? match[2] ?? match[3]).toLowerCase()))
  const period = merchants.size === 1 ? originalCalendarPeriod(hit.record, quote) : null
  return { receipt: numbers[0] ?? null, event: period ? JSON.stringify([[...merchants][0], period]) : null,
    single: SINGLE_PURCHASE.test(quote) }
}

function supportingContext(previous, hit, quote, query, now, priorQuote) {
  if (!REFERENTIAL.test(quote)) return null
  // Only the nearest original can supply an antecedent. Earlier matching
  // prices can refer to an item the user has already moved on from.
  const nearby = priorQuote ? [hit] : previous(hit)
  const related = new Map()
  for (const anchor of nearby) {
    const candidates = priorQuote ? [priorQuote] : sourceSentences(anchor.record.content)
    for (const sentence of candidates) {
      if (!PURCHASE_CONTEXT.test(sentence) ||
          (!namesItem(sentence, query.base) && !(query.author && namesSubject(quote, query)))) continue
      const reference = purchaseContext(anchor, sentence, now)
      if (reference && (reference.receipt || reference.event)) related.set(sentence, { hit: anchor, quote: sentence, ...reference })
    }
  }
  return related.size === 1 ? related.values().next().value : null
}

function factsFrom(hit, query, previous, now) {
  const facts = []
  const quotes = sourceSentences(hit.record.content).flatMap(sentence => sentence.split(BOUNDARY).map(part => part.trim()))
  for (const [position, quote] of quotes.entries()) {
    const context = purchaseContext(hit, quote, now)
    if (!context) continue
    const prices = PRICE_FIELDS.map(field => [field, claimsIn(quote, field)]).filter(([, values]) => values.length)
    if (!prices.length) continue
    const subject = namesSubject(quote, query)
    const base = namesItem(quote, query.base)
    const link = (!context.receipt && !context.event || !base && !subject)
      ? supportingContext(previous, hit, quote, query, now, quotes[position - 1]) : null
    if ((!base && !subject && !link) || (query.author && !subject && !context.receipt && !context.event)) continue
    const { receipt, event, single } = context.receipt || context.event ? context : link ?? context
    if (query.receipt && receipt !== query.receipt) continue
    for (const [field, values] of prices) for (const value of values) {
      if (value.item && !namesItem(value.item, query.base) && !namesSubject(value.item, query) &&
          !(link && /^(?:it|this one|the same item)$/iu.test(value.item))) continue
      facts.push({ field, value, hit, quote, link, named: subject || !query.author && Boolean(link),
        receipt, event, single })
    }
  }
  return facts
}

function transactionFor(list, paid, query) {
  if (list.receipt && paid.receipt && list.receipt !== paid.receipt || !list.named && !paid.named) return null
  const explicitItem = itemTerms(query.base).some(term => !GENERIC_ITEMS.has(term))
  const singleStatement = list.hit.record.id === paid.hit.record.id && list.quote === paid.quote && list.named && paid.named
  if (list.receipt && list.receipt === paid.receipt &&
      (singleStatement || explicitItem && list.named && paid.named || list.single && paid.single)) {
    return 'receipt:' + list.receipt
  }
  if (list.event && list.event === paid.event && list.single && paid.single) return 'event:' + list.event
  return singleStatement ? 'statement:' + list.hit.record.sourceRefs[0].sourceId + ':' + list.quote : null
}

function moneyKey({ unit, amount }) { return unit + ':' + amount }

/** Rank prices locally, then require a shared transaction proof for arithmetic. */
export function findDiscountEvidence(index, query, question, projectKey, now) {
  const options = { projectKey, now, limit: 40 }
  const searches = [question, query.subject + ' original price originally priced 原价 标价', query.base + ' bought paid discount 实付 支付']
  const hits = new Map(), primary = new Map(), expanded = new Map()
  let inspected = 0, incomplete = false
  function complete(hit) {
    if (primary.has(hit.record.id)) return primary.get(hit.record.id)
    const full = index.completeSentences(hit, projectKey)
    if (!full) { primary.set(hit.record.id, null); return null }
    if (!expanded.has(full.record.id)) {
      // The token estimator never exceeds a source's UTF-16 length.
      const cost = full.record.content.length
      if (inspected + cost > DEEP_RECALL_TOKEN_LIMIT) {
        incomplete = true
        primary.set(hit.record.id, null)
        return null
      }
      inspected += cost
      expanded.set(full.record.id, full)
    }
    primary.set(hit.record.id, expanded.get(full.record.id))
    return primary.get(hit.record.id)
  }
  function add(hit) {
    const full = complete(hit)
    if (full && !hits.has(full.record.id)) hits.set(full.record.id, full)
  }
  for (const search of searches) for (const hit of index.search(search, options)) {
    add(hit)
  }
  // A price mentioned as "it" can be found from the closest named purchase,
  // even when the price sentence has none of the question's search words.
  const followed = new Set()
  for (const hit of [...hits.values()]) {
    const sourceId = hit.record.sourceRefs[0].sourceId
    if (followed.has(sourceId)) continue
    if (!namesItem(hit.record.content, query.base) || !PURCHASE_CONTEXT.test(hit.record.content)) continue
    followed.add(sourceId)
    for (const next of index.followingMessages(hit, projectKey, { now })) {
      if (REFERENTIAL.test(next.record.content)) add(next)
    }
  }
  const neighbors = new Map()
  function previous(hit) {
    const sourceId = hit.record.sourceRefs[0].sourceId
    if (neighbors.has(sourceId)) return neighbors.get(sourceId)
    const earlier = index.previousMessages(hit, projectKey, { now })
    const nearest = earlier[0]?.record.sourceRefs[0].sourceId
    const found = earlier.filter(candidate => candidate.record.sourceRefs[0].sourceId === nearest).map(complete).filter(Boolean)
    neighbors.set(sourceId, found)
    return found
  }
  const facts = [...hits.values()].flatMap(hit => factsFrom(hit, query, previous, now))
  const sides = PRICE_FIELDS.map(field => facts.filter(fact => fact.field === field))
  const pairs = new Map()
  let possible = null
  for (const list of sides[0]) for (const paid of sides[1]) {
    const key = transactionFor(list, paid, query)
    if (key && !pairs.has(key)) pairs.set(key, [list, paid])
    if (!possible && list.event && list.event === paid.event && (list.named || paid.named)) possible = [list, paid]
  }
  const stable = sides.every(side => new Set(side.map(fact => moneyKey(fact.value))).size === 1)
  let checked = pairs.size === 1 && stable && !incomplete ? pairs.values().next().value : null
  if (checked) {
    const reference = checked.find(fact => fact.receipt)?.receipt
    const event = checked.find(fact => fact.event)?.event
    if (facts.some(fact => fact.named && (reference && fact.receipt && reference !== fact.receipt ||
        !reference && event && fact.event && event !== fact.event))) checked = null
  }
  const candidates = checked ?? possible ?? sides.map(side => side.find(value => value.named) ?? (!query.author ? side[0] : undefined))
  return { checked: Boolean(checked), candidates }
}

export function discountEvidenceRows(fact) {
  return !fact ? [] : [fact, ...(fact.link ? [fact.link] : [])]
}

export function deliveredDiscountFact(fact, delivered) {
  return fact && discountEvidenceRows(fact).every(row => delivered.has(row.hit.record.id)) ? fact : null
}

export function describeDiscount(query, evidence, ids) {
  const delivered = new Set(ids)
  const facts = evidence.candidates.map(fact => deliveredDiscountFact(fact, delivered))
  if (!facts.some(Boolean)) return null
  const [list, paid] = facts.map(fact => fact?.value)
  const chinese = query.language === 'zh'
  let result = null, rounded = false
  if (evidence.checked && list && paid && list.unit === paid.unit && list.amount > 0n && paid.amount <= list.amount) {
    const denominator = list.amount, numerator = (list.amount - paid.amount) * 10_000n
    const hundredths = (numerator + denominator / 2n) / denominator
    const fraction = String(hundredths % 100n).padStart(2, '0').replace(/0+$/u, '')
    result = String(hundredths / 100n) + (fraction ? '.' + fraction : '')
    rounded = numerator % denominator !== 0n
  }
  const heading = chinese ? (result === null ? '折扣待核对' : '折扣核对')
    : (result === null ? 'Discount unconfirmed' : 'Verified discount')
  const label = chinese ? ['原价', '实付'] : ['Original price', 'Paid']
  const known = facts.flatMap((fact, index) => fact ? [label[index] + ' ' + fact.value.value] : [])
  const conclusion = result === null
    ? (chinese ? '折扣百分比未知，缺少同一交易、同币种的完整金额。回答未知，勿用以下单独的金额计算。'
      : 'The discount percentage is unknown. The amounts below lack a verified same-purchase pair in one currency. State that the discount is unknown without calculating from them.')
    : (chinese ? '折扣 ' : 'Discount ') + (rounded ? '≈' : '') + result + '%'
  const summary = result === null ? [conclusion, ...known] : [...known, conclusion]
  return { result, unit: '%', measure: null, text: '- [' + heading + '] ' + summary.join(' · ') }
}

export function discountPriceAnswer(field, answer, expectedText) {
  const expected = exactMoneyIn(expectedText ?? '')
  if (expected.length !== 1) return null
  const candidates = sourceSentences(String(answer ?? '')).flatMap(sentence => sentence.split(/[,，;；](?=\s*(?:and\b|i\b|it\b|the\b|原价|实付))/iu))
    .filter(quote => !NON_PURCHASE.test(quote))
  const verified = candidates.flatMap(quote => {
    const turn = quote.replace(/\b(?:the user|you)\s+(?=(?:(?:just|recently|actually|already)\s+){0,3}(?:bought|purchased|got)\b)/iu, 'I ')
    return claimsIn(turn, field).map(value => ({ value, quote }))
  })
  const claims = new Set(verified.map(item => moneyKey(item.value)))
  return claims.size === 1 && claims.has(moneyKey(expected[0])) ? verified[0].quote.trim() : null
}
