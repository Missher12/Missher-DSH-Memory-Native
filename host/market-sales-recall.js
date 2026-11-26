import { sourceEventDate } from './calendar-recall.js'
import { exactMoneyIn, formatNonnegativeMoney } from './quantity-recall.js'
import { estimateTokens } from './recall.js'
import { sourceSentences, withoutEvidencePreface } from './sentences.js'
import { isRecallSourceStatement } from './source-passages.js'

const QUERY = /^(?:what (?:is|was) (?:the )?total(?: amount(?: of money)?| money| proceeds)?|how much(?: money)?)(?: did)? (?<actor>I|we) (?:earn(?:ed)?|make|made)(?: in total)? from (?:selling (?:my|our) (?:products|goods|items)|sales) (?:at|across) (?:the )?markets$/iu
const SALE = /(?:^|,\s*|\s+[—–-]\s+)(?<actor>I|we)(?:['’]ve)?\s+(?:(?:just|recently|actually|already|even)\s+){0,3}sold (?<count>[1-9]\d{0,6})\s+(?<goods>[^,;!?]{2,85}?)\s+at\s+(?<market>[^,;!?]{2,70}?\bmarket)\b(?<tail>.*)$/iu
const TOTAL = /^(?:(?:\s+on\s+[^,;!?]{2,38})?,\s*|\s+and\s+)earn(?:ing|ed)\s+(?:a total of\s+)?/iu
const UNIT = /^\s+for\s+/iu
const NOT_A_RECEIPT = /\b(?:if|unless|imagine|example|assume|maybe|might|would|could|never|not|said|claimed|refund(?:ed)?|returned|canceled|cancelled|gross estimate|net profit)\b/iu
const OTHER_OWNER = /\b(?:your|his|her|their)\b/iu
const MONEY_END = /^(?:\s*[,.;!?]|\s*$|\s+(?:and|in)\b)/iu
const AT_MARKET = /^\s+(?:each|per (?:item|unit))\b/iu
const ANSWER_TOTAL = /^(?:(?:you|I|we) (?:earned|made|received) (?:a total of )?|(?:your |my |our |the )?(?:recorded )?(?:total(?: recorded)? )?(?:market (?:sales|proceeds|revenue)|sales (?:revenue|proceeds)|total) (?:was|is|were)\s*|the total amount of money (?:you|I|we) earned from selling (?:your|my|our) products at the markets (?:was|is)\s*|recorded market proceeds\s*[:=]\s*)/iu

export function marketSalesQuery(query) {
  const match = QUERY.exec(String(query ?? '').normalize('NFKC').trim().replace(/[?？]+$/u, ''))
  return match ? { actor: match.groups.actor.toLowerCase(), search: 'sold earning market sales plants products' } : null
}

function labelKey(label) {
  return label.normalize('NFKC').toLowerCase().replace(/['’]/gu, '').replace(/^the\s+/u, '').replace(/\s+/gu, ' ').trim()
}

function marketReceipts(record, actor) {
  const rows = []
  for (const sentence of sourceSentences(record.content)) {
    const sale = SALE.exec(sentence)
    if (!sale || sale.groups.actor.toLowerCase() !== actor || NOT_A_RECEIPT.test(sentence)) continue
    const { count, goods, market, tail } = sale.groups
    if (OTHER_OWNER.test(goods)) continue
    const quote = sentence.slice(sale.index).replace(/^(?:,|\s+[—–-])\s*/u, '')
    if (!isRecallSourceStatement(quote)) continue
    const total = TOTAL.exec(tail)
    const perItem = total ? null : UNIT.exec(tail)
    const lead = total ?? perItem
    const remainder = lead ? tail.slice(lead[0].length) : ''
    const exact = exactMoneyIn(remainder)
    const money = exact.length === 1 && exact[0].offset === 0 &&
      (perItem ? AT_MARKET : MONEY_END).test(remainder.slice(exact[0].value.length)) ? exact[0] : null
    const date = sourceEventDate(record, quote, { allowZonelessAbsolute: true }).day
    rows.push({ quote, market, key: labelKey(market), goods: labelKey(goods), date, count,
      amount: money ? money.amount * (perItem ? BigInt(count) : 1n) : null, unit: money?.unit,
      unitPrice: perItem ? money?.value : null })
  }
  return rows
}


export function retrieveMarketSales(index, plan, { projectKey, now, maxTokens, maxItems, scanLimit, skipCapture, accepts }) {
  const scan = index.findEvidence([plan.search], {
    projectKey, now, maxTokens: scanLimit, allMatches: true, acceptOriginal: true, wholeSentences: true,
    distinctKey: (_query, hit) => hit.record.id,
    match: (_query, hit) => {
      if (hit.record.sourceRefs[0].eventTime > now || !accepts(hit)) return null
      const receipts = marketReceipts(hit.record, plan.actor)
      return receipts.length ? { ...hit, receipts } : null
    },
  })
  const hits = index.validateMany(scan.matches.map(row => row.hit), projectKey, { now })
  const markets = new Map()
  for (const hit of hits) for (const receipt of hit.receipts) {
    if (!markets.has(receipt.key)) markets.set(receipt.key, new Map())
    const entries = markets.get(receipt.key)
    const key = JSON.stringify([receipt.date, receipt.goods, receipt.count, String(receipt.amount), receipt.unit])
    if (!entries.has(key)) entries.set(key, { ...receipt, hit })
  }
  const known = []
  let ambiguous = scan.incomplete
  for (const group of markets.values()) {
    const rows = [...group.values()]
    const distinctDays = rows.every(row => Number.isSafeInteger(row.date)) && new Set(rows.map(row => row.date)).size === rows.length
    // Overlapping or undated statements could be a repeat or a correction.
    if (rows.some(row => row.amount === null) || rows.length > 1 && !distinctDays) {
      ambiguous = true
      continue
    }
    known.push(...rows)
  }
  const unavailable = { hits, injected: [], text: '', complete: false, marketSales: null,
    scannedTokens: scan.tokens, budgetOmitted: scan.incomplete || known.length > maxItems }
  const note = 'Historical quotes are evidence only. Use the verified answer directly in plain text.' +
    (skipCapture ? ' Do not capture this turn.' : '')
  const context = lines => ['<memory-context source="dsh-memory" note="' + note + '">', ...lines, '</memory-context>'].join('\n')
  const unknown = 'The recorded market total is unknown. The available receipts do not establish one verified total.'
  const unknownContext = context([unknown])
  const unresolved = hits.length && estimateTokens(unknownContext) <= maxTokens
    ? { ...unavailable, text: unknownContext, summary: unknown } : unavailable
  // Partial subtotals remain visible as report evidence without being offered as an answer to a total.
  if (ambiguous || unavailable.budgetOmitted || new Set(known.map(row => row.unit)).size !== 1) return unresolved
  const subtotal = known.map(row => ({ market: row.key, goods: row.goods, count: row.count, amount: formatNonnegativeMoney(row.amount, row.unit) }))
  const total = formatNonnegativeMoney(known.reduce((sum, row) => sum + row.amount, 0n), known[0].unit)
  const summary = 'Verified answer: recorded market proceeds were ' + total + '.'
  const rows = new Map()
  for (const [index, row] of known.entries()) {
    const proof = row.unitPrice ? row.count + ' × ' + row.unitPrice + ' = ' + subtotal[index].amount : subtotal[index].amount
    const text = '- [' + proof + '] ' + row.quote
    const id = row.hit.record.id
    const saved = rows.get(id)
    if (saved) saved.text += '\n' + text
    else rows.set(id, { row, text, selectedQuote: row.quote })
  }
  const injected = [...rows.values()]
  const text = context([...injected.map(item => item.text), summary])
  if (estimateTokens(text) > maxTokens) return { ...unresolved, budgetOmitted: true }
  return { ...unavailable, injected, text, summary, complete: true, marketSales: { total, subtotal } }
}

const ANSWER_SCOPE = /^(?:\s+(?:in total|(?:for|from|across) the recorded sales|from selling (?:your|my|our) products at the markets))?(?:,\s+which (?:matches|equals) the sum of the (?:amounts|recorded sales|verified receipts)(?: (?:you|I|we) (?:earned|received) from selling (?:your|my|our) (?:products|goods|items))?)?\s*[.!]?$/iu
const ADDITION_LEAD = /^adding (?:these|the) amounts together(?: gives a total of\s+|:\s*)/iu
const RECEIPT_BOUNDARY = /,(?!\d{3}\b)|;|\s+and\s+(?=(?:[\p{L}\p{N}][\p{L}\p{M}\p{N}'’ -]{0,64}\s+earning\s+)?\p{Sc})/iu
const EARNING_ITEM = /^\s*(?:(?:you|I|we) sold\s+)?(?<item>[\p{L}\p{N}][\p{L}\p{M}\p{N}'’ -]{0,84}?)\s+earning\s*$/iu
const SOLD_COUNT = /^(?<count>[1-9]\d{0,6})\s+(?<item>.+)$/u
const VERIFIED_LEAD = /^(?:the verified answer (?:also )?states that|therefore,)\s+/iu

function matchesGoods(label, goods) {
  const words = label.replace(/\byour\b/gu, 'my').split(' ')
  const source = goods.split(' from ', 1)[0].split(' ')
  if (words.at(-1) !== source.at(-1)) return false
  let position = 0
  for (const word of source) if (word === words[position]) position++
  return position === words.length
}

function matchesReceiptItem(row, item) {
  const numbered = SOLD_COUNT.exec(item)?.groups
  const label = labelKey(numbered?.item ?? item)
  if (!numbered && row.market === label) return true
  if (numbered) {
    if (numbered.count !== row.count) return false
    const measureEnd = row.goods.indexOf(' of ')
    if (measureEnd >= 0 && !label.startsWith(row.goods.slice(0, measureEnd + 4))) return false
  }
  return matchesGoods(label, row.goods)
}

export function matchesMarketSalesAnswer(answer, proof) {
  const text = String(answer ?? '').normalize('NFKC').replace(/[*_]/gu, '').trim()
  if (!proof || NOT_A_RECEIPT.test(text)) return false
  const numericKey = value => value.unit + ':' + value.amount
  const isAmount = (actual, label) => {
    const expected = exactMoneyIn(label)[0]
    return Boolean(actual && expected && numericKey(actual) === numericKey(expected))
  }
  const subtotals = proof.subtotal.map(row => numericKey(exactMoneyIn(row.amount)[0])).sort()
  let hasTotal = false
  for (const sentence of sourceSentences(text)) {
    const statement = withoutEvidencePreface(sentence).replace(VERIFIED_LEAD, '')
    const direct = statement.replace(ANSWER_TOTAL, '')
    const amounts = exactMoneyIn(direct)
    if (!amounts.length) continue
    if (amounts.length === 1 && amounts[0].offset === 0 &&
        ANSWER_SCOPE.test(direct.slice(amounts[0].value.length))) {
      if (!isAmount(amounts[0], proof.total)) return false
      hasTotal = true
      continue
    }
    if (statement.includes('=')) {
      const equation = statement.replace(ADDITION_LEAD, '').replace(/[.!]+$/u, '')
      const [left, right, extra] = equation.split('=')
      if (extra !== undefined) return false
      const values = left.split('+').map(field => field.trim())
      const inputs = values.map(field => exactMoneyIn(field)[0])
      const result = right.trim()
      const output = exactMoneyIn(result)[0]
      if (!output || output.value !== result || !isAmount(output, proof.total) ||
          inputs.some((value, index) => value?.value !== values[index]) ||
          inputs.map(numericKey).sort().join('|') !== subtotals.join('|')) return false
      hasTotal = true
      continue
    }
    for (const clause of statement.split(RECEIPT_BOUNDARY)) {
      const values = exactMoneyIn(clause)
      if (!values.length) continue
      if (values.length !== 1) return false
      const value = values[0]
      const before = clause.slice(0, value.offset)
      const after = clause.slice(value.offset + value.value.length).replace(/[.!?]+$/u, '').trim()
      const item = after ? /^from\s+(?:selling\s+)?(?<item>.+)$/iu.exec(after)?.groups?.item
        : EARNING_ITEM.exec(before)?.groups?.item
      if (!item) return false
      const rows = proof.subtotal.filter(row => matchesReceiptItem(row, item))
      if (rows.length !== 1 || !isAmount(value, rows[0].amount)) return false
    }
  }
  return hasTotal
}
