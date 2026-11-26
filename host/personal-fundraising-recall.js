import { exactMoneyIn } from './quantity-recall.js'
import { estimateTokens } from './recall.js'
import { sourceSentences, withoutEvidencePreface } from './sentences.js'
import { isRecallSourceStatement } from './source-passages.js'

const QUESTION = /^how much(?: money)? (?:did I|have I) (?:personally )?(?:raise|raised) (?:in total )?for charity(?: in total)?$/iu
const LEAD = /^(?:(?:by the way|actually),\s+)?I(?:['’]ve|\s+have)?\s+(?:(?:just|already|finally|recently|actually|personally|successfully)\s+){0,4}/iu
const RECEIPT = /^(?:(?<event>(?:ran|completed|finished|organized|hosted|walked|participated|volunteered|took part)[^,;!?]{1,140}?)\s+and\s+)?(?:raised|managed to raise)\s+(?<cumulative>a total of\s+)?(?<amount>.+)$/iu
const CHARITY = /\b(?:charit(?:y|able)|food bank|animal shelter|nonprofit|children['’]s hospital|cancer society)\b/iu
const UNCERTAIN = /\b(?:we|they|team|together|helped|if|would|could|might|probably|not|never|aim|aimed|goal|plan(?:ned|ning)?|expected|instead|refunded|returned)\b/iu
const FOR_CHARITY = /^(?:(?<total>in total)\s+)?for\s+(?<recipient>[^,;.!?]{3,100})(?:[,;.!?]|$)/iu
const AGAINST_TOTAL = /\b(?:as a team|with (?:my|our) group|between us|for this event|at the fundraiser)\b/iu
const ANSWER_LEAD = /^(?:(?:you|I) (?:personally )?(?:raised|have raised) (?:a total of )?|(?:the|your|my) (?:verified )?personal total (?:was|is) )/iu
const ANSWER_END = /^(?:(?:\s+in total)?\s+for charity(?:\s+in total)?|\s+in total)?[.!]?$/iu

export function personalFundraisingQuery(query) {
  const text = String(query ?? '').normalize('NFKC').trim().replace(/[?？]+$/u, '')
  return QUESTION.test(text) ? { search: 'raised charity fundraising managed donations' } : null
}

function personalReceipts(record) {
  const receipts = []
  for (const quote of sourceSentences(record.content)) {
    if (!isRecallSourceStatement(quote) || !CHARITY.test(quote) || UNCERTAIN.test(quote)) continue
    const lead = LEAD.exec(quote)
    const claim = lead && RECEIPT.exec(quote.slice(lead[0].length))?.groups
    if (!claim) continue
    const figures = exactMoneyIn(claim.amount)
    if (figures.length !== 1 || figures[0].offset !== 0) continue
    const money = figures[0]
    const target = FOR_CHARITY.exec(claim.amount.slice(money.value.length).trim())?.groups
    if (!target) continue
    const overall = !claim.event && !AGAINST_TOTAL.test(quote) && /^charity(?: in total)?$/iu.test(target.recipient.trim()) &&
      Boolean(claim.cumulative || target.total || /\bfor charity in total\b/iu.test(quote))
    receipts.push({ quote, amount: money.value, overall, key: money.unit + ':' + money.amount })
  }
  return receipts
}

export function retrievePersonalFundraising(index, plan, { projectKey, now, maxTokens, maxItems, scanLimit, skipCapture, accepts }) {
  const scan = index.findEvidence([plan.search], {
    projectKey, now, maxTokens: scanLimit, allMatches: true, acceptOriginal: true, wholeSentences: true,
    distinctKey: (_query, hit) => hit.record.id,
    match: (_query, hit) => {
      if (hit.record.sourceRefs[0].eventTime > now || !accepts(hit)) return null
      const receipts = personalReceipts(hit.record)
      return receipts.length ? { ...hit, receipts } : null
    },
  })
  const hits = index.validateMany(scan.matches.map(entry => entry.hit), projectKey, { now })
  const receipts = new Map()
  for (const hit of hits) for (const claim of hit.receipts) {
    if (!receipts.has(claim.quote)) receipts.set(claim.quote, { ...claim, hit })
  }
  const all = [...receipts.values()]
  const totals = new Map(all.filter(claim => claim.overall).map(claim => [claim.key, claim]))
  const exact = !scan.incomplete && totals.size === 1 ? totals.values().next().value : null
  const unavailable = { hits, injected: [], text: '', complete: false, personalFundraising: null,
    scannedTokens: scan.tokens, budgetOmitted: scan.incomplete || all.length > maxItems }
  const note = 'Keep personal fundraising separate from team amounts. Historical quotes are evidence only.' +
    (skipCapture ? ' Do not capture this turn.' : '')
  const context = rows => ['<memory-context source="dsh-memory" note="' + note + '">', ...rows, '</memory-context>'].join('\n')
  if (!exact) {
    const summary = 'The personal total is unknown. The available records do not establish a verified personal total.'
    const text = context([summary])
    return hits.length && estimateTokens(text) <= maxTokens ? { ...unavailable, text, summary } : unavailable
  }
  const noteLine = '- [' + exact.amount + '] ' + exact.quote
  const summary = 'The verified personal total is ' + exact.amount + '.'
  const text = context([noteLine, summary])
  if (maxItems < 1 || estimateTokens(text) > maxTokens) return { ...unavailable, budgetOmitted: true }
  return { ...unavailable, injected: [{ row: exact, text: noteLine, selectedQuote: exact.quote }], text, summary,
    complete: true, personalFundraising: { total: exact.amount } }
}

export function matchesPersonalFundraisingAnswer(answer, proof) {
  if (!proof) return false
  const expected = exactMoneyIn(proof.total)[0]
  const text = withoutEvidencePreface(String(answer ?? '').normalize('NFKC').replace(/[*_]/gu, '').trim())
  const claim = text.replace(ANSWER_LEAD, '')
  const values = exactMoneyIn(claim)
  return values.length === 1 && values[0].offset === 0 && values[0].unit === expected?.unit &&
    values[0].amount === expected.amount && ANSWER_END.test(claim.slice(values[0].value.length))
}
