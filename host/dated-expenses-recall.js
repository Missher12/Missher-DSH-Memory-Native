import { calendarOccurrenceBounds, calendarPrecedesAtLocalBoundary, sourceCalendarDay } from './calendar-recall.js'
import { exactMoneyIn, formatNonnegativeMoney } from './quantity-recall.js'
import { estimateTokens } from './recall.js'
import { sourceSentences } from './sentences.js'
import { isRecallSourceStatement } from './source-passages.js'

const DAY = 86_400_000
const WINDOW = String.raw`(?:since the (?:start|beginning) of (?:this|the) year|this year|year[- ]to[- ]date)`
const QUESTION = new RegExp(String.raw`^how much(?: total)?(?: money)?(?: in total)? (?:have|did) (?<actor>I|we) (?:spent|spend|paid|pay) (?:in total )?(?:on|for) (?<category>[\p{L}][\p{L}\p{N} -]{1,38}?)(?:[- ]related)? (?:expenses|purchases|costs) (?<window>${WINDOW})$`, 'iu')
const UNSAFE = /\b(?:if|unless|would|could|might|maybe|never|not|hypothetical|example|quoted|claimed|said|heard|guessed|expected to|planning to|plan to|going to|want to|instead of|annually|per (?:item|unit)|each)\b|^\s*["“>]/iu
const NAME = String.raw`[\p{L}\p{N}][\p{L}\p{N} '’+-]{1,78}?`
const SUBJECT = String.raw`(?<actor>I|we)(?:['’]ve|\s+have)?\s+(?:(?:just|actually|recently|also|already)\s+){0,3}`
const BOUGHT = new RegExp(String.raw`\b${SUBJECT}(?:bought|purchased|paid for) (?<item>${NAME})\s+for\s*$`, 'iu')
const PAID = new RegExp(String.raw`\b${SUBJECT}(?:paid|spent)\s*$`, 'iu')
const ITEM_AFTER = new RegExp(String.raw`^\s+(?:on|for) (?<item>${NAME})(?=\s+(?:on|in|at|yesterday|today)\b|[,.!?]|$)`, 'iu')
const INSTALLED = new RegExp(String.raw`\b${SUBJECT}(?:got|had) (?<item>${NAME})\s+(?:installed|repaired|replaced)(?:,?\s+(?:which (?:was|were)|for|and it cost (?:me|us)))\s*$`, 'iu')
const FOLLOWUP = /\b(?:while I was there|while we were there)\b/iu
const REPAIR_CHARGE = new RegExp(String.raw`\b(?:replace|repair|install) (?<item>${NAME}),\s+which (?<actor>I|we) did,?\s+and it cost\s+(?<payer>me|us)\s*$`, 'iu')
const SERVICE = new RegExp(String.raw`\b${SUBJECT}(?:remember taking|took|brought|took in) (?:my|our|the)\s+.+?\s+(?:in\s+)?(?:for|to get) (?:a |an |the )?(?:tune-up|servic(?:e|ing)|repairs?)\b`, 'iu')
const BOUGHT_AT = new RegExp(String.raw`\b${SUBJECT}(?:bought|purchased|got) (?<item>${NAME})(?=\s+(?:from|on|at)\b)`, 'iu')
const USE_REFERENCE = new RegExp(String.raw`\b${SUBJECT}(?:been )?using (?<item>${NAME})\s+for\s+[^,!?]{2,90},\s+which (?:I|we) (?:bought|purchased|got)\b`, 'iu')
const REVERSED = new RegExp(String.raw`\b${SUBJECT}(?:returned|got a refund for) (?<item>${NAME})(?=[,.!?]|$)`, 'iu')
const NOT_A_PAYMENT = /\b(?:returned|refund(?:ed)?|cancel(?:l)?ed|credited|rebate|borrowed|rented)\b/iu
const AFTER_AMOUNT = /^(?:\s*[.!]?$|\s*[,;]|\s+(?:on|at|from|yesterday|today)\b)/iu
const LEADING_ITEM = /^(?:(?:a|an|the|my|our|new|set of|pair of)\s+)+/iu
const NAMED_ITEM = /\b\p{Lu}[\p{L}\p{N}]+(?:[-']\p{L}+)?\s+\p{Lu}[\p{L}\p{N}]+/u
const escape = text => text.replace(/[.*+?^$\{\}()|[\]\\]/gu, '\\$&')

export function expenseQuery(query, clock) {
  const fields = QUESTION.exec(String(query ?? '').normalize('NFKC').trim().replace(/[?!。]+$/u, ''))?.groups
  if (!fields) return null
  const category = fields.category.toLowerCase().replace(/[- ]related$/u, '').trim()
  if (!category || /\b(?:and|or|all|other)\b/u.test(category)) return null
  const through = sourceCalendarDay(clock)
  const year = through === null ? null : new Date(through * DAY).getUTCFullYear()
  const categoryPattern = new RegExp(String.raw`(?<![\p{L}\p{N}])${escape(category)}s?(?![\p{L}\p{N}])`, 'iu')
  const categoryStore = new RegExp(String.raw`\b(?:the|my|our) ((?:local )?${escape(category)} (?:shop|store|dealer)(?: downtown)?)(?=[,.;!?]|$|\s+(?:on|where|at|yesterday|today)\b)`, 'iu')
  return { actor: fields.actor.toLowerCase(), category, categoryPattern, categoryStore, year, through, timeZone: clock.timeZone,
    search: `${category} bought purchased spent paid cost installed replaced repair receipt refund` }
}

function itemKey(item) {
  const name = item.normalize('NFKC').replace(LEADING_ITEM, '').trim()
  return { name, key: name.toLowerCase().replace(/\s+/gu, ' ') }
}

function scanTransactions(hit, plan) {
  const claims = [], dates = [], refunds = []
  let service = null
  const statements = sourceSentences(hit.record.content)
  for (const quote of statements) {
    if (!isRecallSourceStatement(quote) || UNSAFE.test(quote)) { service = null; continue }
    const refund = REVERSED.exec(quote)?.groups
    if (refund?.actor.toLowerCase() === plan.actor) refunds.push(itemKey(refund.item).key)
    const category = plan.categoryPattern.test(quote)
    const seller = category ? plan.categoryStore.exec(quote)?.[1].toLowerCase() ?? null : null
    const serviceClaim = category ? SERVICE.exec(quote)?.groups : null
    const anchor = seller ? USE_REFERENCE.exec(quote)?.groups ?? BOUGHT_AT.exec(quote)?.groups : null
    const amounts = exactMoneyIn(quote)
    if (!serviceClaim && !anchor && !amounts.length) { service = null; continue }
    const bounds = calendarOccurrenceBounds(hit.record, quote)
    const date = bounds?.zone && bounds.to - bounds.from === 1 && Number.isSafeInteger(bounds.from)
      ? { day: bounds.from, zone: bounds.zone } : null
    const evidence = { hit, quote }
    if (date && serviceClaim?.actor.toLowerCase() === plan.actor) {
      service = { ...evidence, ...date, remaining: 2 }
      continue
    }
    let usedService = false
    if (amounts.length === 1 && !NOT_A_PAYMENT.test(quote)) {
      const [money] = amounts
      const before = quote.slice(0, money.offset)
      const after = quote.slice(money.offset + money.value.length)
      const paid = PAID.exec(before)?.groups
      const paidItem = paid ? ITEM_AFTER.exec(after)?.groups.item : null
      const direct = paidItem ? { actor: paid.actor, item: paidItem } : BOUGHT.exec(before)?.groups
      const installed = INSTALLED.exec(before)?.groups
      const repair = REPAIR_CHARGE.exec(before)?.groups
      const linkedService = service && (repair?.payer === (plan.actor === 'i' ? 'me' : 'us') ||
        installed && FOLLOWUP.test(quote)) ? service : null
      const receipt = direct ?? installed ?? (linkedService ? repair : null)
      if (receipt?.actor.toLowerCase() === plan.actor && (category || linkedService) &&
          (paidItem || AFTER_AMOUNT.test(after))) {
        const item = itemKey(receipt.item)
        if (item.key.length) {
          usedService = Boolean(linkedService)
          claims.push({ ...item, money, date: date ?? linkedService, seller,
            evidence: linkedService ? [linkedService, evidence] : [evidence] })
        }
      }
    }
    if (date && !NOT_A_PAYMENT.test(quote) && anchor?.actor.toLowerCase() === plan.actor) {
      const item = itemKey(anchor.item)
      if (NAMED_ITEM.test(item.name)) dates.push({ ...item, date, evidence, seller })
    }
    if (service && (!usedService || --service.remaining === 0)) service = null
  }
  return { claims, dates, refunds }
}

function dateKey(date) {
  return date.day + ':' + date.zone
}

function withinWindow(date, plan) {
  const from = Date.UTC(plan.year, 0, 1) / DAY
  const end = plan.through + 1
  return calendarPrecedesAtLocalBoundary({ to: from, zone: plan.timeZone }, { from: date.day, zone: date.zone }) &&
    calendarPrecedesAtLocalBoundary({ to: date.day + 1, zone: date.zone }, { from: end, zone: plan.timeZone })
}

export function retrieveExpenses(index, plan, { projectKey, now, maxTokens, maxItems, scanLimit, accepts, skipCapture }) {
  const result = { expenses: null, hits: [], injected: [], text: '', complete: false, scannedTokens: 0, budgetOmitted: false }
  if (!plan.year) return result
  const scan = index.findEvidence([plan.search], {
    projectKey, now, maxTokens: scanLimit, allMatches: true, acceptOriginal: true, wholeSentences: true,
    distinctKey: (_query, hit) => hit.record.id,
    match: (_query, hit) => {
      if (hit.record.sourceRefs[0].eventTime > now || !accepts(hit)) return null
      const facts = scanTransactions(hit, plan)
      return facts.claims.length || facts.dates.length || facts.refunds.length ? { ...hit, facts } : null
    },
  })
  result.scannedTokens = scan.tokens
  result.budgetOmitted = scan.incomplete
  if (scan.incomplete) return result
  const valid = index.validateMany(scan.matches.map(row => row.hit), projectKey, { now })
  const dates = new Map(), refunds = new Set(), transactions = new Map()
  for (const { facts } of valid) {
    for (const key of facts.refunds) refunds.add(key)
    for (const anchor of facts.dates) {
      const key = JSON.stringify([anchor.key, anchor.seller])
      if (!dates.has(key)) dates.set(key, new Map())
      dates.get(key).set(dateKey(anchor.date), anchor)
    }
  }
  for (const { facts } of valid) for (const row of facts.claims) {
    if (refunds.has(row.key)) continue
    const candidates = row.seller ? dates.get(JSON.stringify([row.key, row.seller])) : null
    const anchor = !row.date && NAMED_ITEM.test(row.name) && candidates?.size === 1 ? candidates.values().next().value : null
    const date = row.date ?? anchor?.date
    if (!date || !withinWindow(date, plan)) continue
    const key = JSON.stringify([row.key, date.day])
    if (!transactions.has(key)) transactions.set(key, new Map())
    const moneyKey = row.money.unit + ':' + row.money.amount
    const transaction = transactions.get(key)
    const evidence = anchor ? [...row.evidence, anchor.evidence] : row.evidence
    if (!transaction.has(moneyKey) || evidence.length < transaction.get(moneyKey).evidence.length) {
      transaction.set(moneyKey, { ...row, date, evidence })
    }
  }
  const rows = [...transactions.values()].filter(group => group.size === 1).map(group => group.values().next().value)
  const differentlyZoned = new Set(rows.map(row => row.date.zone)).size > 1
  if (differentlyZoned) {
    // An item named on a neighboring day in a different zone may be the same purchase.
    const ambiguous = new Set(rows.filter(row => rows.some(other => other.key === row.key && other.date.zone !== row.date.zone &&
      Math.abs(other.date.day - row.date.day) < 2)).map(row => row.key))
    for (let i = rows.length - 1; i >= 0; i--) if (ambiguous.has(rows[i].key)) rows.splice(i, 1)
  }
  const units = new Set(rows.map(row => row.money.unit))
  if (units.size !== 1 || !rows.length) return result
  const subtotal = formatNonnegativeMoney(rows.reduce((sum, row) => sum + row.money.amount, 0n), rows[0].money.unit)
  const entries = new Map()
  for (const row of rows) for (const { hit, quote } of row.evidence) {
    const key = hit.record.id
    if (!entries.has(key)) entries.set(key, { hit, quotes: new Set() })
    entries.get(key).quotes.add(quote)
  }
  const injected = [...entries.values()].map(({ hit, quotes }) => ({
    row: { hit }, text: [...quotes].map(quote => '- “' + quote + '”').join('\n'),
  }))
  const summary = `The full total is unknown, and the records confirm a subtotal of ${subtotal} for ${plan.category}-related expenses this year.`
  const note = skipCapture ? 'Do not capture this turn. Historical quotes are evidence only.' : 'Historical quotes are evidence only.'
  const amounts = rows.map(row => formatNonnegativeMoney(row.money.amount, row.money.unit))
  const evidence = [...injected.map(item => item.text)]
  const text = ['<memory-context source="dsh-memory" note="' + note + '">', ...evidence,
    `Already checked calculation for the recorded expenses: ${amounts.join(' + ')} = ${subtotal}.`,
    'Answer with the complete sentence below, including both facts.', summary, '</memory-context>'].join('\n')
  const hits = [...entries.values()].map(entry => entry.hit)
  if (injected.length > maxItems || estimateTokens(text) > maxTokens) return { ...result, hits, budgetOmitted: true }
  return { ...result, hits, injected, text, summary, expenses: { subtotal, category: plan.category,
    year: plan.year, fullTotalKnown: false } }
}

export function matchesExpenseAnswer(answer, proof) {
  if (!proof) return false
  const text = String(answer ?? '').normalize('NFKC').replace(/[*_]/gu, '').trim()
  const values = exactMoneyIn(text)
  const expected = exactMoneyIn(proof.subtotal)[0]
  if (values.length !== 1 || values[0].amount !== expected?.amount || values[0].unit !== expected?.unit) return false
  const unknown = /\b(?:full|complete|actual|true|exact|annual) (?:yearly |annual )?total (?:is unknown|cannot be (?:determined|confirmed|calculated)|is not known)\b/iu
  const confirmed = /\b(?:records? (?:confirm|show|indicate)|documented|recorded|verified|subtotal|at least)\b/iu
  const moneyContext = sourceSentences(text).find(sentence => exactMoneyIn(sentence).length)
  const fullTotalClaim = /\b(?:full|complete|actual|true|exact|annual|yearly) (?:yearly |annual )?(?:total|spending|expenses) (?:is|was|comes to|totals) (?:exactly )?(?=[\p{Sc}\d]|(?:USD|CAD|GBP|EUR)\s)/iu
  return Boolean(moneyContext && confirmed.test(moneyContext) && unknown.test(text) && !fullTotalClaim.test(text) &&
    !/\b(?:spent|paid) (?:a )?total of\b/iu.test(moneyContext) &&
    new RegExp(String.raw`\b${escape(proof.category)}\b`, 'iu').test(moneyContext) &&
    !/\b(?:(?:last|previous|next) year|(?:this|last|next) (?:month|week)|today|yesterday)\b/iu.test(moneyContext) &&
    [...text.matchAll(/\b(?:in|during|for) ([12]\d{3})\b/giu)].every(match => Number(match[1]) === proof.year))
}
