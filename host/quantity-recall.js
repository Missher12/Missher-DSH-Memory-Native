/** Named operands stay separate until the underlying quantities are supplied. */
import { sourceSentences, withoutEvidencePreface } from './sentences.js'
import { tokenize } from './tokenize.js'
import { contradictsReportedCounter, namesCounterSubtotal } from './counter-recall.js'

const ENGLISH_TOTAL = /^(?:what\s+(?:was|is)\s+(?:the\s+)?total\s+(?:number|count)\s+of|how\s+many)\s+([a-z][a-z -]{1,42}?)\s+(?:(?:(?:i|we)\s+(?:got|received)|reached|recorded|received|made|completed|served|reported|produced)\s+)?(?:from|by|for|across|in)\s+(.+)$/iu
const REPORTED_REACH = /^what\s+(?:was|is)\s+the\s+sum\s+of\s+(?:the\s+)?(?:reported|per-channel|per-campaign)\s+reach\s+counts\s+(?:from|for|across)\s+(.+)$/iu
const CHINESE_TOTAL = /^(.{3,140}?)(?:一共|合计|总共|加起来|合起来)[\p{Script=Han}]{0,5}?(?:多少|几)\s*([\p{Script=Han}]{1,15})$/u
const MONEY_DIFFERENCE = /^how\s+much\s+(?:more|less)\s+(?:was|were|is|are)\s+(.+?)\s+than\s+(.+)$/iu
const FARE_SAVINGS = /^how much (?:will|would) (?:i|we) save by (?:taking|using|riding) (.+?) instead of (?:(?:taking|using|riding) )?(.+)$/iu
const FARE_DIFFERENCE = /^(?:for (?<context>[^,]{2,65}),\s*)?how much (?<direction>more|less) expensive (?:was|is) (?<left>.+?) (?:compared to|than) (?<right>.+)$/iu
const TRIP_QUOTE_DIFFERENCE = /^how much more (?:did (?:i|we) have to pay|was the price) for (?:(?:the|my|our) )?(?<trip>[^,?!<>]{0,61}\btrip) (?:after|compared to) the (?:initial|original) quote$/iu
const FUNDRAISING_QUESTION = /^how much (?:more )?(?:money )?did (?<actor>i|we) (?:raise than|exceed) (?<owner>my|our) (?:initial|original) (?:fundraising )?(?:goal|target) (?:in|at|for) (?<event>[^,.;!?<>\n]{4,90})$/iu
const FUNDRAISING_PARTICIPATION = /^(?<actor>i|we)(?:['’]ve)?\s+(?:(?:recently|just|already) )?(?:participated in|took part in|joined|completed) (?<event>[^,;.!?]{4,90}?) (?:where|and) (?<claim>.+)$/iu
const FUNDRAISING_CONTEXT = /^(?:in|at|for) (?<event>[^,;.!?]{4,90}),\s*(?<claim>.+)$/iu
const FUNDRAISING_GOAL = /^(?<owner>my|our|your) (?:initial|original) (?:fundraising )?(?:goal|target)(?: (?:for|in|at) (?<event>[^,;.!?]{4,90}?))? (?:was|is)(?: to raise)?$/iu
const FUNDRAISING_RAISED = /^(?:(?<actor>i|we|you)(?:['’]ve)? )?(?:(?:actually|finally|ultimately|successfully) )?(?:raised|ended up raising)$/iu
const FUNDRAISING_AIMED = /^(?:(?<actor>i|we|you) )?(?:initially|originally) (?:aimed|planned|set out) to raise$/iu
const FUNDRAISING_EVENT_AFTER_AMOUNT = /^\s*(?<relation>for|in|at) (?<event>[^,;.!?]{4,90})(?:[,;.!?]|$)/iu
const CONTRIBUTION_UNIT = /^\s*in (?:donations|sponsorships)\b/iu
const FUNDRAISING_DELTA_TAIL = /^\s*(?:more|less|extra|above|below)\b/iu
const FUNDRAISING_EXAMPLE = /^(?:[-*]\s*)?(?:for example|example|hypothetical|sample|test case|fictional(?: scenario)?)\s*[:：]$/iu
const TRAVEL_MODE = String.raw`(?:taxi|cab|train|bus|subway|shuttle|ferry)`
const FARE_SUBJECT = new RegExp(String.raw`^(?:(?:the|a|an|my|our) )?(?<mode>${TRAVEL_MODE})(?: (?:ride|fare|ticket|trip))?(?: (?<route>from .{1,45}? to .{1,45}))?$`, 'iu')
const FARE_MENTION = new RegExp(String.raw`\b${TRAVEL_MODE}\b`, 'giu')
const TRIP_SUPPLIER = /\b(?:with|from|by)\s+((?:[A-Z][A-Za-z.'’-]*\s+){1,5}(?:Travel Agency|Travel|Tours|Expeditions))\b/gu
const TRIP_BOOKING = /\b(?:booking (?:ref(?:erence)?|number)|reservation (?:id|number)|trip reference)[: ]+([a-z][a-z0-9]{0,11}-[a-z0-9]{2,12})\b/giu
const INITIAL_QUOTE = /(?:\b(?:initially|originally) quoted (?:me|us)|\b(?:initial|original) (?:quote|price)(?: for [^;,.]{1,70})? (?:was|is))\s*$/iu
const REVISED_QUOTE = /\b(?:corrected|revised|updated|final) (?:price|quote|cost)(?: for [^;,.]{1,70})? (?:was|is)\s*$/iu
const PERSONAL_FARE = /\b(?:i|we|my|our|me|us)\b/iu
const PERSONAL_FARE_CHARGE = new RegExp(String.raw`\b(?:(?:i|we)\s+(?:paid|spent|took|rode|used|booked)|cost\s+(?:me|us)|(?:my|our)\s+(?:(?:daily|regular)\s+)?${TRAVEL_MODE}\s+fare)\b`, 'iu')
const FARE_AMOUNT = /(?:\b(?:costs?|fare (?:is|was)|paid|spent|told (?:me|us) (?:it['’]s|it was)))(?:\s+(?:me|us|actually|only|around|about|approximately|roughly))*\s*$/iu
const UNRELATED_FARE_AMOUNT = /\b(?:separate|airport|booking|luggage) fees?\b|\b(?:tips?|surcharges?)\b/iu
const CONDITIONAL_COST = /\b(?:if|unless|might|maybe|guess(?:ed)?|hypothetical|never|not)\b/iu
const INEXACT_BOUND = /(?:\b(?:at least|at most|more than|less than|up to|over|under|between)\s+(?:\p{Sc}|\d)|(?:no more than|no less than)\b)/iu
const APPROXIMATE_PREFIX = /^(?:about|around|roughly|approximately|约|大约|≈|~)\s*/iu
const SAVINGS_ANSWER = /\b(?:save|(?<estimate>estimated )?(?:savings|difference)(?:\s+(?:would be|are|is|was))?)\s*[:=]?\s*/iu
const CHINESE_DIFFERENCE = /^(.{2,70}?)比(.{2,70}?)(?:多|少|高|低)(?:了)?(?:多少钱|多少元)$/u
const ITEM_TOTAL = /^what\s+(?:was|is)\s+the\s+(?:total|combined)\s+(?:cost|price)\s+(?:of|for)\s+(.+)$/iu
const ITEM_SPENDING = [
  /^what\s+(?:was|is)\s+the\s+(?:total|combined)\s+(?:amount|money)\s+(?<spender>i|we)\s+(?:actually\s+)?(?:spent|paid)\s+(?:on|for)\s+(?<items>.+)$/iu,
  /^how\s+much(?:\s+money)?(?:\s+in total)?\s+did\s+(?<spender>i|we)\s+(?:actually\s+)?(?:spend|pay)(?:\s+in total)?\s+(?:on|for)\s+(?<items>.+)$/iu,
]
const ITEM_PRICE_DIFFERENCE = /^what\s+(?:was|is)\s+the\s+(?:difference in (?:price|cost)|(?:price|cost) difference)\s+between\s+(.+)$/iu
const CHINESE_ITEM_TOTAL = /^(.+?)(?:一共|总共|合计|加起来)(?:花费了?|花了|花|是|要)?多少钱$/u
const CHINESE_ITEM_SPENDING = /^(?<spender>我(?:们)?)(?:买|采购|购入|购买|购置)了?\s*(?<items>.+?)\s*(?:一共|总共|合计|加起来)(?:花费了?|花了|花)多少钱$/u
const PURCHASED_ITEMS = /\s+(?:that\s+)?(?:i|we)\s+(?:bought|purchased|got)\s*$/iu
const ITEM_SEPARATOR = /\s+and\s+|\s*以及\s*|和|与/iu
const UNSPECIFIED_ITEM = /^(?:(?:the|a|my|our|other|another|similar|same|new)\s+)*(?:one|pair|item|kind|thing)(?:\s+(?:found|bought|at|from|in|by)\b|$)/iu
const UNSPLIT_ITEMS = /\b(?:both|together|as a bundle|as a set|combined)\b|打包|合计|一共|组合价/u
const UNRELATED_COST = /\b(?:shipping|postage|tax|delivery charge|deposit|refund|financing payment)\b|运费|税费|押金|退款/u
const ITEM_REPORT = /\b(?:said|quoted|heard|claimed|guessed|estimated)\b|转述|估计|据说/iu
const PERSONAL_PURCHASE = /\b(?<buyer>i|we)(?:['’]ve)?\s+(?:(?:just|recently|actually|already|also)\s+){0,3}(?:bought|purchased|got|picked up|remember (?:buying|purchasing|picking up))\s+(?<item>[^;；!?]{1,115})|(?<buyerZh>我(?:们)?)(?:刚|已经|实际)?(?:买了|购入了?|购买了?)\s*(?<itemZh>.{1,85})/iu
const PERSONAL_PAYMENT = /(?:\b(?<payer>i|we)(?:['’]ve)?\s+(?:(?:just|recently|actually|already|also)\s+){0,3}(?:paid|spent)\b(?:\s+for\s+[^，,;；!?]{1,80})?|\bcost\s+(?<charged>me|us)|(?:(?<payerZh>我(?:们)?)\s*)?(?:实付|实际支付|实际付了|花了))\s*$/iu
const EXACT_PRICE_LEAD = /\bfor\s+(?:a pretty penny|quite a bit)\s*[-–—:]\s*$/iu
const EXACT_PRICE_TAIL = /^\s*,?\s*to be exact\b/iu
const RECORDED_EXPENSES = /\b(?<spender>i|we)(?:['’]ve)?\s+(?:(?:have been|been)\s+spending|spent)\s+[^;.!?]{1,120}?\b(?:like|including|such as)\s+/iu
const COST_OF_LISTED_ITEM = /^(?:a|an|the)\s+(?<item>[^;.!?]{1,110}?)\s+(?:that|which)\s+cost\s*$/iu
const ITEM_PRICE = /(?:\b(?:costs?|priced at|sold for)|\b(?:price|cost|fee)(?:\s+(?:of|for)\s+[^，,;；!?]{1,85})?\s+(?:was|is)|(?:价格|售价|费用|成本)(?:是|为|[:：=])?)\s*$/iu
const ITEM_REFERENCE = /^(?:(?:i|we) remember(?: that)?\s+)?(?:it\s+(?:cost|was priced at)|(?:它|这件|这个)(?:花了|实付|售价|价格))/iu
const PRICE_SUBJECT = /\b(?:cost|price)\s+of\s+([^;；!?？]{1,100})(?:[?？])?$/iu
const EXAMPLE_PURCHASE = /\b(?:like|including|such as)\s+the one\s*$/iu
const PRICE_ITEM_FOLLOWERS = new Set(['from', 'at', 'on', 'in', 'for', 'last', 'today', 'yesterday', 'recently',
  'cost', 'costs', 'price', 'fee', 'was', 'is', 'priced', 'sold', 'that', 'which', 'like', 'including', 'such'])
const MONEY_TOPIC = /价格|价款|开销|费用|预算|成本|金额|\b(?:budget|cost|price|fee|bill|payment|spend)\b/iu
const SUBJECT_FILLER = new Set(['the', 'my', 'our', 'of', 'in', 'for', 'on', 'by', 'at', 'to'])
const NUMBER = String.raw`(?:\d{1,3}(?:,\d{3})+|\d+|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|one|two|three|four|five|six|seven|eight|nine|ten)`
const MONEY = /(?:\p{Sc}|\b(?:USD|EUR|GBP|CNY|RMB)\b)\s*(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|\d+(?:\.\d+)?\s*(?:(?:美元|港元|人民币|元|欧元|英镑)(?![\p{L}\p{N}])|(?:dollars?|euros?|pounds?)\b)/giu
const FARE_DELTA_ANSWER = new RegExp(String.raw`^(?<left>[^$;:.]{1,130}?)\b(?:was|is|costs?)\s+(?<amount>${MONEY.source})\s+(?<direction>more|less)(?: expensive)?\s+(?:than|compared to)\s+(?<right>.+)$`, 'iu')
const TRIP_DELTA_ANSWER = new RegExp(String.raw`\b(?:pay|paid|cost)\s+(?<amount>${MONEY.source})\s+(?:more|extra)\b[^.!?;]{0,125}\b(?:initial|original) quote\b`, 'iu')
const SAVINGS_ALTERNATIVES = /\bby (?:taking|using|riding) (.+?) instead of (?:(?:taking|using|riding) )?(.+)/iu
const FUNDRAISING_DELTA_ANSWER = new RegExp(String.raw`^(?<actor>you|i|we) (?:(?:actually|successfully|ultimately) )?raised (?<amount>${MONEY.source}) (?<direction>more|less) than (?<owner>your|my|our) (?:initial|original) (?:fundraising )?(?:goal|target)(?: (?:for|in|at) (?<event>[^,;.!?]{4,90}))?$`, 'iu')
const FUNDRAISING_EXCEEDED_ANSWER = new RegExp(String.raw`^(?<actor>you|i|we) (?<direction>exceeded|surpassed|fell short of) (?<owner>your|my|our) (?:initial|original) (?:fundraising )?(?:goal|target) by (?<amount>${MONEY.source})(?: (?:for|in|at) (?<event>[^,;.!?]{4,90}))?$`, 'iu')
const FUNDRAISING_ANSWER_CLAUSE = /[;；]|(?:\s+and\s+|,\s*|\s+(?:against|with)\s+)(?=(?:you|i|we|your|my|our)\s)/iu
const FUNDRAISING_ANSWER_GOAL = /^((?:your|my|our) (?:initial|original) (?:fundraising )?(?:goal|target)) of (?=\p{Sc}|\d)/iu
const EQUATION_AMOUNT = String.raw`(?:\p{Sc}\s*)?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:\s*[\p{L}]{1,20})?`
const QUANTITY_EQUATION = new RegExp(String.raw`(?<![\p{L}\p{N}.])(?<operands>${EQUATION_AMOUNT}(?:\s*[+-]\s*${EQUATION_AMOUNT}){1,3})\s*[=≈]\s*(?<result>-?${EQUATION_AMOUNT})`, 'gu')
const FUNDRAISING_DIFFERENCE_LABEL = /\b(?:difference|amount (?:over|above|below) (?:the )?(?:initial|original) (?:goal|target))(?:\s+(?:is|was|equals))?\s*[:=]?\s*/iu
const PRICE_SCOPES = new Set(['item-price', 'fare-comparison', 'trip-quote'])
const CHINESE_NUMBER = /[\d零一二两三四五六七八九十百千]+/u
const NONFACT = /[?？]|(?:计划|预计|暂定|假设|可能|并非|不是|\b(?:not|never|would|planned\s+to|plan\s+to|maybe|about\s+to|will)\b)/iu
const QUALIFIED_NUMBER = /(?:大约|大概|至少|至多|上限|下限|不超过|左右|[约近]\s*\d|\b(?:approximately|about|around|at least|at most|up to|roughly|nearly|over|under|less than|more than)\s+(?:\p{Sc}|\d|one|two|three|four|five|six|seven|eight|nine|ten))/iu
const LOAN_SCOPE = /\b(?:mortgage\s+)?(?:pre[-\s]?approval(?:\s+(?:amount|limit|ceiling))?|borrowing\s+(?:limit|ceiling))\b|(?:住房)?贷款预批(?:额度|上限|金额)|(?:获批|核准)借款上限|最高可贷(?:金额|额度)?/iu
const SALE_SCOPE = /\b(?:(?:final|actual)\s+(?:sale|purchase)\s+price|closing\s+price)\b|(?:最终|实际)?(?:成交|过户)价(?:格|款)?/iu
const REACH_QUERY = /\b(?:people|persons|users|individuals)\s+reached\b|触达(?:的)?(?:人数|多少人|人次)/iu
const CAMPAIGN = /\b(?:campaign|ads?)\b|广告(?:活动|投放)?/iu
const COLLABORATION = /\b(?:influencers?|creators?|collaborat(?:ed|ion)|promotion|partnership)\b|达人|博主|联动|合作|推广/iu
const GENERIC_ACTIVITY = /\b(?:ad|ads|advertising|campaign|influencer|creator|collaboration|promotion|partnership|marketing|channel)\b|广告(?:活动|投放)?|达人|博主|合作|推广|渠道/giu
const APPROVAL_ASSERTED = /\b(?:pre[-\s]?approved|(?:received|got|have|had|secured)\s+(?:a\s+)?(?:mortgage\s+)?pre[-\s]?approval)\b|(?:已经|已|通过了|拿到|获批|获得)(?:住房)?贷款预批|贷款(?:已预批|获批)/iu
const LIMIT_AMOUNT = /\b(?:can|could|may)\s+(?:borrow|finance)(?:\s+up\s+to|\s+at\s+most|\s+a\s+maximum\s+of)?\s*$|\b(?:borrow(?:ing)?\s+(?:up\s+to|limit)|up\s+to|maximum\s+(?:of|loan)|(?:borrowing|mortgage)\s+ceiling)\s*$|(?:最多|最高)(?:能|可)?(?:贷|借)(?:到)?\s*$/iu
const APPROVAL_AMOUNT = new RegExp(String.raw`(?:${LOAN_SCOPE.source})[^;；!?]{0,68}(?:\b(?:is|was|of|at)\b|是|为|[:：=])\s*$`, 'iu')
const CLOSING_AMOUNT = new RegExp(String.raw`(?:${SALE_SCOPE.source})[^;；!?]{0,58}(?:\b(?:is|was|of|at)\b|是|为|[:：=])\s*$`, 'iu')
const APPROXIMATE = /(?:~|≈|约|大约|大概|\b(?:approximately|about|around|roughly|nearly)\b)\s*$/iu
const WRONG_MONEY_ROLE = /\b(?:asking price|list price|down payment|deposit|interest|fee|monthly payment|borrowed|spent)\b|首付|押金|利息|月供|报价|挂牌价|实际借了/iu
const SPECULATIVE = /(?:希望|打算|正在申请|拟申请|预计|假如|例如|虚构|\b(?:planning|hope|hoped|hoping|expect(?:ed|ing)?|thought|imagine|for example|if|proposal|simulated)\b)/iu
const ATTRIBUTABLE_SALE = /^(?:by the way,\s*)?(?:(?:the|our|its)\s+)?(?:(?:final|actual)\s+(?:sale|purchase)\s+price|closing\s+price)\s*(?:was|is|of|:|=)|^(?:这套|这笔|最终|实际)?(?:成交|过户)价(?:格|款)?\s*(?:是|为|[:：=])/iu
const REACH_AMOUNT = /(?:\b(?:reached|actual reach(?:\s+(?:was|of|is))?)\s*|实际触达(?:了|约有)?\s*|触达(?:了)?\s*)$/iu
const REACH_UNIT = /^\s*(?:\b(?:people|persons?|users?|individuals?)\b|人次?)/iu
const RELATED_UNIT = /^\s*(\b(?:followers|impressions|views)\b|名粉丝|个粉丝|粉丝|次曝光|次浏览)/iu
const REFERS_TO_CAMPAIGN = /\b(?:my|our|the)\s+(?:previous|prior|last|same)\s+(?:ad\s+)?campaign\b|\b(?:that campaign|this campaign)\b|上一次(?:广告|推广)|这次(?:广告|推广)/iu
const REFERS_TO_COLLABORATION = /\b(?:my|our|the)\s+(?:previous|prior|last|same)\s+(?:influencer|creator)?\s*(?:campaign|collaboration|promotion)\b|\b(?:that|this)\s+(?:collaboration|promotion)\b|这次合作/u
const COMPLETED_PURCHASE = /\b(?:bought|purchased|completed the purchase|closed on)\b|买下了|已买|买了|成交了/iu
const NAMED_AMOUNT_OWNER = new RegExp('(?:' + LOAN_SCOPE.source + '|' + SALE_SCOPE.source + ')' +
  '\\s+(?:for|of|on)\\s+([^,;；!?]{1,68}?)\\s+(?:was|is)(?:\\s+up\\s+to)?\\s*$', 'iu')
const NAMED_MONEY_ROLE = new RegExp(LOAN_SCOPE.source + '|' + SALE_SCOPE.source, 'giu')
const SCOPED_SPLIT = /[；;]|\s+(?:but|whereas)\s+|,\s+and\s+|[，,]\s*(?=(?:but\s+)?(?:I|we|they|he|she)\b)|[，,]\s*(?=(?:另一|而其他))/iu
const ENGLISH_DELTA = new RegExp(String.raw`^(.*?)(?:\bwas|\bis|\bwere)\s+(${MONEY.source})\s+(more|higher|less|lower)\s+than\s+(.+)`, 'iu')
const CHINESE_DELTA = new RegExp(String.raw`^(.+?)比(.+?)(高|多|低|少)(?:了)?\s*(${MONEY.source})`, 'iu')
const TOTAL_OR_DELTA = /(?:\b(?:total|sum|difference)\b[^\d\p{Sc}=;:。]{0,110}?(?:\b(?:is|was|equals?)\b|=|:|(?=\s*[\p{Sc}\d]))|(?:合计|总计|共计|差额|相差)\s*(?:为|是|=|[:：])?)/iu
const ITEM_PRICE_RESULT = /(?:总价|总费用|总成本|总金额|差价|(?:一共|总共|加起来|合起来)(?=\s*(?:为|是|等于|花|\d|[=:：])))(?:的?(?:金额|费用|价格))?\s*(?:为|是|等于|花(?:了|费了?)?|=|[:：])?/u
const SPENDING_RESULT = new RegExp(String.raw`\b(?:i|we|you)\s+(?:spent|paid)\s+(?<total>a total of\s+)?(?<amount>${MONEY.source})`, 'giu')
const AFTER_SPENDING_AMOUNT = /^\s+(?:on|for)\s+([^.!?;]+)/iu
const CARDINAL = 'zero one two three four five six seven eight nine ten'.split(' ')
const ORDINAL = 'zero first second third fourth fifth sixth seventh eighth ninth tenth'.split(' ')

const singular = term => term === 'people' ? 'person'
  : term.replace(/ies$/u, 'y').replace(/(ch|sh|x|ss|zz)es$/u, '$1').replace(/(?<!s)s$/u, '')
const canonicalSubject = term => singular(term).replace(/(?:ions?|ed|ing|al)$/u, ending => term.length - ending.length >= 5 ? '' : ending)
const moneyUnit = label => ({
  rmb: 'cny', yuan: 'cny', 'chinese yuan': 'cny', renminbi: 'cny', 人民币: 'cny', 元: 'cny',
  美元: 'usd', 港元: 'hkd', 欧元: 'eur', 英镑: 'gbp',
})[label] ?? label
export function quantityValueKey(value) {
  const normalized = String(value ?? '').normalize('NFKC').replace(/[\s,]/gu, '').toLowerCase()
  const word = Math.max(CARDINAL.indexOf(normalized), ORDINAL.indexOf(normalized))
  return word >= 0 ? String(word) : normalized
}

function subjectTerms(value) {
  return tokenize(value).filter(term => !SUBJECT_FILLER.has(term)).map(canonicalSubject)
}

function moneyScope(subject) {
  const cue = LOAN_SCOPE.test(subject) ? LOAN_SCOPE : SALE_SCOPE.test(subject) ? SALE_SCOPE : null
  if (!cue) return null
  const name = subject.replace(cue, '').replace(/^(?:\s*(?:of|for|on|my|our|the)\b)+\s*/iu, '').trim()
  const entity = /^(?:house|home|property|loan|mortgage|房屋|房子|房产)?$/iu.test(name) ? '' : name
  return { role: cue === LOAN_SCOPE ? 'loan-ceiling' : 'sale-price', entity }
}

function reachScope(subject) {
  return { role: 'reach', entity: subject.replace(GENERIC_ACTIVITY, ' ').replace(/\s+/gu, ' ').trim(),
    activity: CAMPAIGN.test(subject) ? 'campaign' : COLLABORATION.test(subject) ? 'collaboration' : null }
}

function scopedLookup(subject, scope) {
  const words = scope.role === 'loan-ceiling' ? 'pre approval preapproved approved borrow lender mortgage 贷款 预批 最高 额度'
    : scope.role === 'sale-price' ? 'bought final sale purchase closing price 成交 价格 成交价'
      : scope.role === 'item-price' ? 'cost price paid spent bought 实付 价格'
      : 'reached actual reach people followers audience 触达 粉丝 曝光'
  return subject + ' ' + words
}

function namedPrices(text) {
  const englishSpend = ITEM_SPENDING.map(pattern => pattern.exec(text)).find(Boolean)?.groups
  const chineseSpend = CHINESE_ITEM_SPENDING.exec(text)?.groups
  const spending = englishSpend ?? chineseSpend
  const total = ITEM_TOTAL.exec(text), difference = ITEM_PRICE_DIFFERENCE.exec(text), chineseTotal = CHINESE_ITEM_TOTAL.exec(text)
  if (!spending && !total && !difference && !chineseTotal) return null
  const chinese = Boolean(chineseSpend || chineseTotal)
  const listing = spending?.items.replace(/\s+(?:in total|altogether)$/iu, '') ?? (total ?? difference ?? chineseTotal)[1]
  const paid = Boolean(spending) || PURCHASED_ITEMS.test(listing) || (chinese && /(?:花费了?|花了|花)多少钱$/u.test(text))
  const body = listing.replace(PURCHASED_ITEMS, '').replace(/^(?:我买的|我购买的|我购入的)/u, '')
  // Keep an explicit list separator authoritative, since a named product can contain "and".
  const entries = body.split(/[,，、]/u).map(part => part.trim())
  const last = entries.pop()
  const lastIsCoordinated = /^(?:and\s+|以及\s*)/iu.test(last)
  const tail = lastIsCoordinated ? [last.replace(/^(?:and\s+|以及\s*)/iu, '')] : last.split(ITEM_SEPARATOR)
  if (tail.length > 2) return null
  const subjects = [...entries, ...tail].map(part => part.replace(/^(?:(?:the|a|an|my|our)\s+)+/iu, '').trim())
  const lastWord = tokenize(subjects[0]).at(-1)
  const onePurchase = englishSpend && subjects.length === 1 && /^(?:a|an|the|my|our)\s+/iu.test(body) &&
    lastWord && singular(lastWord) === lastWord
  if ((!onePurchase && subjects.length < 2) || subjects.length > (difference ? 2 : 4) ||
      subjects.some(part => !part || part.length > 88 || UNSPECIFIED_ITEM.test(part) ||
        /[<>\n?!？]|\b(?:i|we)\s+(?:got|bought|purchased)\b/iu.test(part) ||
        subjectTerms(part).length === 0) || new Set(subjects.map(part => subjectTerms(part).join(' '))).size !== subjects.length) return null
  return subjects.map(subject => {
    const scope = { role: 'item-price', entity: subject, paid, ...(spending ? { spender: spending.spender.toLowerCase() } : {}) }
    return {
      query: chinese ? `${subject}价格是多少` : `Price for ${subject}`,
      role: 'subquestion', detail: 'money-operand', entityTerms: [],
      searchQuery: scopedLookup(subject, scope),
      quantity: { subject, measure: null, operation: difference ? 'absolute-difference' : 'sum', language: chinese ? 'zh' : 'en',
        scope, otherSubjects: subjects.filter(other => other !== subject) },
    }
  })
}

const fareMode = name => /^cab$/iu.test(name) ? 'taxi' : name.toLowerCase()

function fundraisingEventKey(event) {
  return event?.normalize('NFKC').trim().toLowerCase().replace(/^(?:the|an?|my|our|your)\s+/iu, '')
    .replace(/[’‘]/gu, "'").replace(/\s+/gu, ' ')
}

function fundraisingComparison(text) {
  const request = FUNDRAISING_QUESTION.exec(text)?.groups
  if (!request) return null
  const actor = request.actor.toLowerCase()
  if (request.owner.toLowerCase() !== (actor === 'i' ? 'my' : 'our')) return null
  const entity = fundraisingEventKey(request.event)
  return ['raised', 'initial'].map(stage => {
    const subject = (stage === 'raised' ? 'Actual amount raised' : 'Initial fundraising goal') + ' for ' + entity
    return { query: subject, role: 'subquestion', detail: 'money-operand', entityTerms: [],
      searchQuery: subject + (stage === 'raised' ? ' participated donations fundraised' : ' initially originally aimed target donations'),
      quantity: { subject, measure: null, operation: 'difference', language: 'en',
        scope: { role: 'fundraising-comparison', entity, actor, stage }, otherSubjects: [] } }
  })
}

function comparedPrices(text) {
  const estimate = FARE_SAVINGS.exec(text)
  const actual = estimate ? null : FARE_DIFFERENCE.exec(text)?.groups
  let scopes
  if (estimate || actual) {
    const [left, right] = estimate ? [estimate[2], estimate[1]]
      : actual.direction.toLowerCase() === 'less' ? [actual.right, actual.left] : [actual.left, actual.right]
    const a = FARE_SUBJECT.exec(left.trim())?.groups
    const b = FARE_SUBJECT.exec(right.trim())?.groups
    if (!a || !b || fareMode(a.mode) === fareMode(b.mode) ||
        a.route && b.route && a.route.toLowerCase() !== b.route.toLowerCase()) return null
    const route = a.route ?? b.route, context = actual?.context
    if (!(route || context)) return null
    scopes = [a, b].map(item => ({ role: 'fare-comparison', entity: fareMode(item.mode), route, context, estimated: Boolean(estimate) }))
  } else {
    const trip = TRIP_QUOTE_DIFFERENCE.exec(text)?.groups.trip.trim()
    if (!trip) return null
    const entity = trip.toLowerCase() === 'trip' ? '' : trip
    scopes = ['revised', 'initial'].map(stage => ({ role: 'trip-quote', entity, stage }))
  }
  return scopes.map(scope => {
    const subject = scope.role === 'fare-comparison' ? scope.entity + ' fare'
      : (scope.stage === 'initial' ? 'Initial quote' : 'Corrected price') + ' for ' + (scope.entity || 'the trip')
    return { query: subject, role: 'subquestion', detail: 'money-operand', entityTerms: [],
      searchQuery: [subject, scope.route, scope.context, scope.entity === 'taxi' ? 'cab' : null, 'cost price paid quoted']
        .filter(Boolean).join(' '),
      quantity: { subject, measure: null, operation: 'difference', language: 'en', scope, otherSubjects: [] } }
  })
}

/** A number of the stated measure is required for each explicitly named subject. */
export function quantityRecallPlan(query, { itemPrices = true } = {}) {
  const text = String(query).normalize('NFKC').trim().replace(/[?？。]+$/u, '')
  const prices = fundraisingComparison(text) ?? (itemPrices ? namedPrices(text) ?? comparedPrices(text) : null)
  if (prices) return prices
  const english = ENGLISH_TOTAL.exec(text), chinese = CHINESE_TOTAL.exec(text), reported = REPORTED_REACH.exec(text)
  const chineseDifference = CHINESE_DIFFERENCE.exec(text)
  const difference = english || chinese || reported ? null : (MONEY_DIFFERENCE.exec(text) ?? chineseDifference)
  if (!english && !chinese && !reported && (!difference || !MONEY_TOPIC.test(difference[1] + ' ' + difference[2]) &&
      !SALE_SCOPE.test(difference[1] + ' ' + difference[2]))) return null
  const reach = Boolean(reported || (english || chinese) && REACH_QUERY.test(text))
  const measure = english?.[1] ?? chinese?.[2] ?? (reported ? 'people' : null)
  const operation = difference ? (/\bless\b|(?:少|低)(?:了)?(?:多少钱|多少元)$/iu.test(text) ? 'reverse-difference' : 'difference')
    : /去重|不同的|独立人数|\b(?:unique|distinct|unduplicated)\b/iu.test(text) || (reach && !reported && measure !== '人次') ? null : 'sum'
  const subjects = (difference ? difference.slice(1) : (reported?.[1] ?? english?.[2] ?? chinese[1]).split(/\s+and\s+|、|,|以及|和|与/iu))
    .map(value => value.trim().replace(/^(?:the|my|our)\s+/iu, ''))
  if (subjects.length < 2 || subjects.length > 4 || new Set(subjects.map(value => value.toLowerCase())).size !== subjects.length ||
      subjects.some(subject => !subject || subject.length > 90 || /[<>\n]/u.test(subject) || !subjectTerms(subject).length)) return null
  const roles = difference ? subjects.map(moneyScope) : []
  const scopedMoney = roles.every(Boolean) && roles.some(role => role.role === 'loan-ceiling') && roles.some(role => role.role === 'sale-price')
  if (scopedMoney && roles.filter(role => role.entity).length === 1) {
    roles.find(role => !role.entity).entity = roles.find(role => role.entity).entity
  }
  return subjects.map((subject, index) => {
    const scope = reach ? reachScope(subject) : scopedMoney ? roles[index] : null
    return {
    query: difference ? (chineseDifference ? `${subject}金额是多少` : `Amount for ${subject}`)
      : chinese ? `${subject}有多少${measure}` : `How many ${measure} for ${subject}`,
    role: 'subquestion', detail: difference ? 'money-operand' : 'count-operand', entityTerms: [],
    ...(scope ? { searchQuery: scopedLookup(subject, scope) } : {}),
    quantity: { subject, measure, operation, language: chinese || chineseDifference ? 'zh' : 'en', ...(scope ? { scope } : {}),
      otherSubjects: subjects.filter((_, otherIndex) => index !== otherIndex) },
    }
  })
}

function mealPeriod(words) {
  return words.length === 2 && words[1] === 'meal' && ['breakfast', 'lunch', 'dinner'].includes(words[0]) ? words[0] : null
}

function countValues(clause, measure) {
  if (/\p{Script=Han}/u.test(measure)) {
    return [...clause.matchAll(new RegExp(`(${CHINESE_NUMBER.source})\\s*${measure}`, 'gu'))].map(match => match[1])
  }
  const words = tokenize(measure).map(singular)
  const mealtime = mealPeriod(words)
  if (mealtime && QUALIFIED_NUMBER.test(clause)) return []
  const quantities = [...clause.matchAll(new RegExp(String.raw`(?<![\p{L}\p{N}.,-])(${NUMBER})\s+`, 'giu'))]
  const values = quantities.filter(value => {
    const tail = tokenize(clause.slice(value.index + value[0].length)).map(singular)
    return words.every((word, index) => tail[index] === word) || (mealtime && tail[0] === mealtime)
  }).map(value => value[1])
  if (mealtime) {
    const stated = new RegExp(String.raw`\b(?:number|count) of ${mealtime}(?: meals?|s|es)\s+(?:[^,;.!?]{1,94}?\s+)?(?:is|was)\s+(${NUMBER})[.!]?$`, 'iu').exec(clause)
    if (stated) values.push(stated[1])
  }
  return values
}

function containsEntity(text, entity) {
  if (!entity) return true
  if (/\p{Script=Han}/u.test(entity)) return text.includes(entity)
  const names = subjectTerms(entity)
  const words = subjectTerms(text)
  return names.length > 0 && words.some((_, from) => names.every((word, index) => words[from + index] === word))
}

function namesPricedItem(text, entity) {
  const outsideName = text.toLowerCase().replace(entity.toLowerCase(), '')
  if (ITEM_SEPARATOR.test(outsideName) || /\bplus\s+|[、&]/iu.test(outsideName)) return false
  if (/\p{Script=Han}/u.test(entity)) {
    const at = text.indexOf(entity)
    return at >= 0 && /^(?:$|[，,。！\s；;]|价格|售价|成本|费用|实付|花了|是|为|从|在)/u.test(text.slice(at + entity.length))
  }
  const name = tokenize(entity).map(canonicalSubject)
  const tokens = tokenize(text)
  const words = tokens.map(canonicalSubject)
  return words.some((_, at) => {
    const next = tokens[at + name.length]
    return name.every((word, offset) => words[at + offset] === word) &&
      (next === undefined || PRICE_ITEM_FOLLOWERS.has(next))
  })
}

function priceSubjectContext(text) {
  const named = PRICE_SUBJECT.exec(text)
  return named && !NONFACT.test(named[1]) && !SPECULATIVE.test(named[1])
    ? { subject: named[1], quote: named[0].replace(/[?？]$/u, '') } : null
}

function namedExpenseCost(before, spender, entity) {
  const expenses = RECORDED_EXPENSES.exec(before)
  if (expenses?.groups.spender.toLowerCase() !== spender) return false
  const named = before.slice(expenses.index + expenses[0].length).split(/\s+(?:and|plus)\s+|,\s*/iu).at(-1)
  const item = COST_OF_LISTED_ITEM.exec(named)?.groups.item
  return item !== undefined && namesPricedItem(item, entity)
}

function itemPriceProof(quantity, quote, previous) {
  const { entity, paid, spender } = quantity.scope
  const irrelevantCharge = text => UNRELATED_COST.test(text) && !UNRELATED_COST.test(entity)
  const competingItem = text => quantity.otherSubjects.some(other => containsEntity(text, other))
  if (irrelevantCharge(quote) || competingItem(quote) || ITEM_REPORT.test(quote) || /^["“]/u.test(quote) ||
      UNSPLIT_ITEMS.test(quote.replace(entity, ''))) return []
  const normalized = quote.normalize('NFKC')
  const amounts = exactMoneyIn(normalized)
  if (amounts.length !== 1) return []
  const amount = amounts[0]
  const before = normalized.slice(0, amount.offset)
  const after = normalized.slice(amount.offset + amount.value.length)
  if (spender && namedExpenseCost(before, spender, entity)) return [{ value: amount.value, qualifier: 'exact', quote }]
  const purchase = PERSONAL_PURCHASE.exec(before)
  const payment = PERSONAL_PAYMENT.exec(before)?.groups
  const purchasedFor = Boolean(purchase && (/\bfor\s*$/iu.test(before) ||
    EXACT_PRICE_LEAD.test(before) && EXACT_PRICE_TAIL.test(after)))
  const personal = purchasedFor || payment !== undefined
  if (!(personal || !paid && ITEM_PRICE.test(before))) return []
  const charged = payment?.charged?.toLowerCase()
  const payer = payment?.payer?.toLowerCase() ?? payment?.payerZh ?? (charged === 'me' ? 'i' : charged === 'us' ? 'we' : undefined)
  const attributedTo = payer ?? purchase?.groups.buyer?.toLowerCase() ?? purchase?.groups.buyerZh
  const reference = /^\s+(?:for|on)\s+([^,，;；.!?]{1,90})/iu.exec(after)?.[1]
  const purchaseContext = purchasedFor ? before.slice(0, purchase.index) : ''
  if ((!spender || attributedTo === spender) && (namesPricedItem(purchase?.groups.item ?? purchase?.groups.itemZh ?? before, entity) ||
      personal && reference && namesPricedItem(reference, entity) ||
      EXAMPLE_PURCHASE.test(purchaseContext) && namesPricedItem(purchaseContext, entity))) {
    return [{ value: amount.value, qualifier: 'exact', quote }]
  }
  if (!previous || !ITEM_REFERENCE.test(before) || competingItem(previous) || irrelevantCharge(previous)) return []
  const antecedent = PERSONAL_PURCHASE.exec(previous)
  if (spender && (payer ?? antecedent?.groups.buyer?.toLowerCase() ?? antecedent?.groups.buyerZh) !== spender) return []
  const priceSubject = personal ? priceSubjectContext(previous) : null
  const subject = antecedent?.groups.item ?? antecedent?.groups.itemZh ?? priceSubject?.subject
  if (!subject || !namesPricedItem(subject, entity) || UNSPLIT_ITEMS.test(previous)) return []
  const context = antecedent ? previous : priceSubject.quote
  return [{ value: amount.value, qualifier: 'exact', quote: context + '；' + quote, amountQuote: quote }]
}

function scopedMoneyProof(scope, quote, prior) {
  if (WRONG_MONEY_ROLE.test(quote) || /\b(?:difference|delta)\s+between\b|差额|相差/iu.test(quote) ||
      ENGLISH_DELTA.test(quote) || CHINESE_DELTA.test(quote)) return []
  const ceiling = scope.role === 'loan-ceiling'
  const fallback = ceiling ? APPROVAL_ASSERTED : COMPLETED_PURCHASE
  const previous = prior.at(-1)
  const anchor = previous && fallback.test(previous) && !NONFACT.test(previous) &&
    !SPECULATIVE.test(previous) && containsEntity(previous, scope.entity) ? previous : null
  const normalized = quote.normalize('NFKC')
  return [...normalized.matchAll(MONEY)].flatMap(amount => {
    const prefix = normalized.slice(0, amount.index)
    const approximate = APPROXIMATE.test(prefix)
    const cue = prefix.replace(APPROXIMATE, '')
    const lastRole = [...cue.matchAll(NAMED_MONEY_ROLE)].at(-1)
    if (lastRole && moneyScope(lastRole[0]).role !== scope.role) return []
    const owner = NAMED_AMOUNT_OWNER.exec(cue)?.[1]
    if (owner && scope.entity && !containsEntity(owner, scope.entity)) return []
    const named = containsEntity(owner ?? cue, scope.entity)
    const cueOwnsValue = ceiling ? APPROVAL_AMOUNT.test(cue.replace(/\s+(?:up\s+to|at\s+most)\s*$/iu, ' ')) : CLOSING_AMOUNT.test(cue)
    const anchoredLimit = ceiling && LIMIT_AMOUNT.test(cue) && (APPROVAL_ASSERTED.test(quote) || anchor)
    if (!cueOwnsValue && !anchoredLimit) return []
    if (!named && !(anchor && (ceiling ? anchoredLimit : ATTRIBUTABLE_SALE.test(cue)))) return []
    // A borrowing figure from another sentence has to retain its approval.
    const context = !named || (anchoredLimit && !APPROVAL_ASSERTED.test(quote)) ? anchor : null
    if (context === null && !named) return []
    return [{ value: amount[0], qualifier: approximate ? 'approximate' : ceiling ? 'ceiling' : 'exact',
      quote: context ? context + '；' + quote : quote, amountQuote: quote,
      ...(owner && !/^(?:the )?(?:house|home|property|mortgage)$/iu.test(owner) ? { owner } : {}) }]
  })
}

function reachProof(scope, otherSubjects, quote, prior, includeRelated) {
  const activity = scope.activity === 'campaign' ? CAMPAIGN : scope.activity === 'collaboration' ? COLLABORATION : null
  const refers = scope.activity === 'campaign' ? REFERS_TO_CAMPAIGN : REFERS_TO_COLLABORATION
  const others = otherSubjects.map(reachScope).map(item => item.entity).filter(entity => entity && entity !== scope.entity)
  const conflicts = text => others.some(entity => containsEntity(text, entity))
  if (conflicts(quote)) return []
  const anchor = [...prior].reverse().find(text => containsEntity(text, scope.entity) && !conflicts(text))
  const normalized = quote.normalize('NFKC')
  const values = [...normalized.matchAll(new RegExp(String.raw`(?<![\p{L}\p{N}.,-])(${NUMBER})(?![\d.,])`, 'giu'))]
  return values.flatMap(number => {
    const prefix = normalized.slice(0, number.index)
    const tail = normalized.slice(number.index + number[0].length)
    const named = containsEntity(prefix, scope.entity) && (!activity || activity.test(prefix))
    const approximate = APPROXIMATE.test(prefix)
    const measured = REACH_UNIT.test(tail) && REACH_AMOUNT.test(prefix.replace(APPROXIMATE, ''))
    const related = !measured && includeRelated ? RELATED_UNIT.exec(tail)?.[1] : undefined
    if (!measured && !related) return []
    if (!named && (!anchor || !activity || !activity.test(prefix) || measured && (!activity.test(anchor) || !refers.test(prefix)))) return []
    return [{ value: number[0], qualifier: approximate ? 'approximate' : 'exact', related,
      quote: !named && anchor ? anchor + '；' + quote : quote, amountQuote: quote }]
  })
}

function comparisonAmount(text) {
  if (/[?？]/u.test(text) || CONDITIONAL_COST.test(text) || INEXACT_BOUND.test(text) ||
      UNRELATED_COST.test(text) || UNSPLIT_ITEMS.test(text) || /^\s*["“>]/u.test(text)) return null
  const values = [...text.matchAll(MONEY)]
  if (values.length !== 1) return null
  const [value] = values[0]
  const before = text.slice(0, values[0].index)
  const after = text.slice(values[0].index + value.length)
  if (/-\s*$/u.test(before) || /^[.,]\d|^[a-z\d]|^\s*(?:[-–—]|to)\s*\d/iu.test(after)) return null
  return { value, before, after }
}

function fundraisingProof(scope, content, answer = false) {
  const exact = new Map()
  let previous = ''
  for (const quote of sourceSentences(String(content ?? ''))) {
    const example = FUNDRAISING_EXAMPLE.test(previous)
    previous = quote
    if (example || NONFACT.test(quote) || QUALIFIED_NUMBER.test(quote)) continue
    const text = answer ? withoutEvidencePreface(quote) : quote
    const amount = comparisonAmount(text.normalize('NFKC'))
    if (!amount || FUNDRAISING_DELTA_TAIL.test(amount.after)) continue
    const before = amount.before.trim()
    const participated = FUNDRAISING_PARTICIPATION.exec(before)?.groups
    const context = participated ?? FUNDRAISING_CONTEXT.exec(before)?.groups
    const claim = context?.claim ?? before
    const goal = scope.stage === 'initial' ? FUNDRAISING_GOAL.exec(claim)?.groups : null
    const action = (scope.stage === 'raised' ? FUNDRAISING_RAISED : FUNDRAISING_AIMED).exec(claim)?.groups
    const trailing = FUNDRAISING_EVENT_AFTER_AMOUNT.exec(amount.after.replace(CONTRIBUTION_UNIT, ''))?.groups
    const stated = context?.event ?? goal?.event
    const event = stated ?? trailing?.event
    if (((event || !answer) && fundraisingEventKey(event) !== scope.entity) ||
        (goal?.event && fundraisingEventKey(goal.event) !== scope.entity) ||
        (stated && trailing && trailing.relation.toLowerCase() !== 'for' && fundraisingEventKey(trailing.event) !== scope.entity) ||
        (participated && participated.actor.toLowerCase() !== scope.actor)) continue
    const actor = goal ? ({ my: 'i', our: 'we', your: 'you' })[goal.owner.toLowerCase()]
      : action && (action.actor ?? participated?.actor)?.toLowerCase()
    if (actor !== scope.actor && !(answer && actor === 'you')) continue
    exact.set(quantityValueKey(amount.value), { value: amount.value, quote, qualifier: 'exact' })
  }
  return exact.size === 1 ? exact.values().next().value : null
}

function fareComparisonProof(scope, pieces) {
  const { route, context, entity, estimated } = scope
  const entailsContext = text => route ? /\bfrom\b[^;.!?]{1,85}\bto\b/iu.test(text) && containsEntity(text, route)
    : containsEntity(text, context)
  const results = new Map()
  for (const [index, text] of pieces.entries()) {
    const amount = comparisonAmount(text)
    if (!amount || !PERSONAL_FARE.test(text) || UNRELATED_FARE_AMOUNT.test(text)) continue
    if (!estimated && (!PERSONAL_FARE_CHARGE.test(text) || NONFACT.test(text) || SPECULATIVE.test(text) || ITEM_REPORT.test(text) ||
        QUALIFIED_NUMBER.test(text))) continue
    const { before, after, value } = amount
    const nearest = [...before.matchAll(FARE_MENTION)].at(-1)
    const paidFor = /\b(?:i|we)\s+(?:paid|spent)\s*$/iu.test(before)
      ? /^\s+(?:for|on)\s+(?:(?:a|the|my|our) )?/iu.exec(after) : null
    const namedAfter = paidFor && new RegExp(String.raw`^${TRAVEL_MODE}\b`, 'iu').exec(after.slice(paidFor[0].length))
    if (namedAfter ? fareMode(namedAfter[0]) !== entity
      : !nearest || fareMode(nearest[0]) !== entity || !FARE_AMOUNT.test(before)) continue
    // An explicit corridor stays with its own fare. A daily fare is a named
    // recurring commute expense only when the user states it as their own.
    const personalDailyFare = !route && /^(?:my|our) daily\b/iu.test(text) &&
      /\bfare\b/iu.test(text) && containsEntity(context, 'daily commute')
    const previous = pieces[index - 1]
    const linked = !route && previous && entailsContext(previous) && PERSONAL_FARE.test(previous) &&
      !/[?？]/u.test(previous) && !/\bfrom\b[^.!?]+\bto\b/iu.test(text)
    if (!entailsContext(text) && !personalDailyFare && !linked) continue
    const quote = !entailsContext(text) && !personalDailyFare && linked ? previous + '；' + text : text
    results.set(quantityValueKey(value), { value, quote, amountQuote: text, qualifier: estimated ? 'approximate' : 'exact' })
  }
  return results.size === 1 ? results.values().next().value : null
}

function tripQuoteProof(scope, pieces) {
  const named = pieces.flatMap(text => !/[?？]/u.test(text) && PERSONAL_FARE.test(text)
    ? [...text.matchAll(TRIP_SUPPLIER)].map(match => ({ text, name: match[1] })) : [])
  const suppliers = new Set(named.map(item => item.name.toLowerCase()))
  if (suppliers.size !== 1) return null
  const anchor = named.find(item => scope.entity ? containsEntity(item.text, scope.entity)
    : /\b(?:trip|(?:flight|travel) tickets?|travel arrangements)\b/iu.test(item.text))
  if (!anchor) return null
  const bookingKeys = new Set(pieces.flatMap(text => [...text.matchAll(TRIP_BOOKING)].map(match => match[1].toLowerCase())))
  if (bookingKeys.size > 1) return null
  const cue = scope.stage === 'initial' ? INITIAL_QUOTE : REVISED_QUOTE
  const proofs = new Map()
  for (const text of pieces) {
    const amount = comparisonAmount(text)
    if (!amount || NONFACT.test(text) || SPECULATIVE.test(text) || QUALIFIED_NUMBER.test(text) ||
        !cue.test(amount.before) || !/\btrip\b/iu.test(text)) continue
    const quote = anchor.text === text ? text : anchor.text + '；' + text
    const bookingKey = [...quote.matchAll(TRIP_BOOKING)][0]?.[1]?.toLowerCase()
    proofs.set(quantityValueKey(amount.value), { value: amount.value, quote, amountQuote: text,
      owner: anchor.name, tripKey: bookingKey ?? (scope.entity ? scope.entity.toLowerCase() : null), qualifier: 'exact' })
  }
  return proofs.size === 1 ? proofs.values().next().value : null
}

function scopedQuantityEvidence(quantity, content, includeRelated) {
  if (quantity.scope.role === 'fundraising-comparison') return fundraisingProof(quantity.scope, content)
  const pieces = sourceSentences(String(content ?? '')).flatMap(sentence => sentence.split(SCOPED_SPLIT))
    .map(piece => piece.trim()).filter(Boolean)
  if (quantity.scope.role === 'fare-comparison') return fareComparisonProof(quantity.scope, pieces)
  if (quantity.scope.role === 'trip-quote') return tripQuoteProof(quantity.scope, pieces)
  const exact = new Map(), related = new Map(), prior = []
  let previous = null
  for (const quote of pieces) {
    if (NONFACT.test(quote) || SPECULATIVE.test(quote)) {
      previous = quantity.scope.role === 'item-price' && priceSubjectContext(quote) ? quote : null
      continue
    }
    const proofs = quantity.scope.role === 'reach'
      ? reachProof(quantity.scope, quantity.otherSubjects, quote, prior, includeRelated)
      : quantity.scope.role === 'item-price' ? itemPriceProof(quantity, quote, previous)
        : scopedMoneyProof(quantity.scope, quote, prior)
    for (const proof of proofs) {
      const group = proof.related ? related : exact
      const key = quantityProofKey(proof, { includeOwner: !quantity.scope.entity })
      if (!group.has(key)) group.set(key, proof)
    }
    // Questions do not establish an identity. A nearby statement may.
    prior.push(quote)
    if (prior.length > 3) prior.shift()
    previous = quote
  }
  if (exact.size) return exact.size === 1 ? exact.values().next().value : null
  return related.size === 1 ? related.values().next().value : null
}

export function quantityProofKey(proof, { includeOwner = false } = {}) {
  if (!proof?.value) return null
  const value = quantityValueKey(proof.value)
  if (!proof.qualifier) return value
  return [proof.qualifier, value, proof.related ?? '', ...(includeOwner ? [proof.owner ? subjectTerms(proof.owner).join(' ') : ''] : []),
    ...(Object.hasOwn(proof, 'tripKey') ? [proof.tripKey ?? ''] : [])].join(':')
}

export function quantityEvidence(plan, content, { includeRelated = false } = {}) {
  if (!plan?.quantity) return null
  if (plan.quantity.scope) return scopedQuantityEvidence(plan.quantity, content, includeRelated)
  const { subject, measure, otherSubjects } = plan.quantity
  const primary = subjectTerms(subject), others = otherSubjects.map(subjectTerms)
  const clauses = sourceSentences(String(content ?? '')).flatMap(sentence =>
    sentence.split(/[；;，]|,(?!\d)|\s+(?:and|but)\s+|(?:而且|但是)/iu))
  let proof = null
  for (const original of clauses) {
    const quote = original.trim()
    if (!quote || NONFACT.test(quote)) continue
    const terms = new Set(subjectTerms(quote))
    const has = query => query.every(term => terms.has(term))
    if (!has(primary) || others.some(has)) continue
    const normalized = quote.normalize('NFKC')
    const values = measure ? countValues(normalized, measure) : [...normalized.matchAll(MONEY)].map(match => match[0])
    for (const value of values) {
      if (proof && quantityValueKey(proof.value) !== quantityValueKey(value)) return null
      proof ??= { quote, value }
    }
  }
  return proof
}

function exactQuantity(proof, measure, estimate = false) {
  if (typeof proof?.value !== 'string' || proof.related) return null
  if (!(estimate && proof.qualifier === 'approximate') &&
      (proof.qualifier === 'approximate' || proof.qualifier !== 'ceiling' && QUALIFIED_NUMBER.test(proof.amountQuote ?? proof.quote))) return null
  let value = quantityValueKey(proof.value)
  let unit = measure
  if (!measure) {
    const money = /^(\D*)(\d{1,13}(?:\.\d{1,6})?)(\D*)$/u.exec(value)
    if (!money || (!money[1] && !money[3]) || (money[1] && money[3])) return null
    value = money[2]
    const currency = money[1] || money[3]
    const currencies = new Set([...(proof.amountQuote ?? proof.quote).matchAll(/\b(?:usd|cad|aud|nzd|hkd|jpy|cny|rmb|eur|gbp|sgd)\b/giu)]
      .map(match => match[0].toLowerCase()))
    if (currencies.size > 1) return null
    const nearby = [...currencies][0]
    // A nearby declared currency makes a bare currency sign unambiguous.
    unit = moneyUnit(currency === '$' || currency === '¥' ? nearby ?? currency : currency)
  }
  if (!/^\d{1,13}(?:\.\d{1,6})?$/u.test(value)) return null
  const [integer, fraction = ''] = value.split('.')
  return { amount: BigInt(integer + fraction.padEnd(6, '0')), display: value, unit }
}

export function formatNonnegativeMoney(amount, unit) {
  const digits = String(amount).padStart(7, '0')
  const decimals = digits.slice(-6).replace(/0+$/u, '')
  const value = digits.slice(0, -6) + (decimals ? '.' + decimals : '')
  return /^\p{Sc}$/u.test(unit) ? unit + value : unit.toUpperCase() + ' ' + value
}

export function exactMoneyIn(quote) {
  return [...quote.matchAll(MONEY)].flatMap(match => {
    const value = match[0]
    if (/^[.,]\d|^[a-z\d]/iu.test(quote.slice(match.index + value.length))) return []
    const exact = exactQuantity({ quote, value }, null)
    return exact ? [{ ...exact, value, offset: match.index }] : []
  })
}

/** A reply may restate a scoped amount without repeating its original booking or route. */
export function scopedMoneyAnswerQuote(question, answer) {
  const scope = question.quantity?.scope
  if (!['fare-comparison', 'trip-quote', 'fundraising-comparison'].includes(scope?.role)) return null
  const amounts = new Set(question.injected.filter(hit => hit.verified === true).flatMap(hit => {
    const proof = quantityEvidence(question, String(hit.text).replace(/^\s*-\s*\[[^\]]+\]\s*/u, ''))
    const value = exactQuantity(proof, null, scope.estimated)
    return value ? [String(value.amount) + ':' + value.unit] : []
  }))
  if (amounts.size !== 1) return null
  if (scope.role === 'fundraising-comparison') {
    const proof = fundraisingProof(scope, answer, true)
    const value = exactQuantity(proof, null)
    return value && amounts.has(String(value.amount) + ':' + value.unit) ? proof.quote : null
  }
  const parts = sourceSentences(String(answer ?? '')).flatMap(sentence => sentence.split(/(?:,(?!\d)|[;；])\s*(?:(?:while|whereas|and)\s+)?/iu))
  const claims = new Map()
  for (const clause of parts) {
    const amount = comparisonAmount(clause)
    if (!amount || scope.estimated && !APPROXIMATE.test(amount.before) ||
        !scope.estimated && QUALIFIED_NUMBER.test(clause)) continue
    const prefix = amount.before.replace(APPROXIMATE, '')
    const modes = scope.role === 'fare-comparison' ? fareModes(prefix) : []
    const own = scope.role === 'fare-comparison'
      ? FARE_AMOUNT.test(prefix) && modes.length === 1 && modes[0] === scope.entity
      : (scope.stage === 'initial' ? INITIAL_QUOTE : REVISED_QUOTE).test(prefix)
    if (!own) continue
    const value = exactQuantity({ value: amount.value, quote: clause,
      ...(scope.estimated ? { qualifier: 'approximate' } : {}) }, null, scope.estimated)
    if (value) claims.set(String(value.amount) + ':' + value.unit, clause.trim())
  }
  return claims.size === 1 ? claims.get(amounts.values().next().value) ?? null : null
}

const fareModes = text => [...new Set([...String(text).matchAll(FARE_MENTION)].map(match => fareMode(match[0])))]

/** The calculation is a turn-local read-back of the delivered operands. */
export function describeQuantities(plans, proofs) {
  if (!proofs.some(Boolean)) return null
  const { measure, operation, language, scope } = plans[0].quantity
  const mealtime = measure && mealPeriod(tokenize(measure).map(singular))
  const estimated = scope?.role === 'fare-comparison' && scope.estimated
  const values = proofs.map(proof => exactQuantity(proof, measure, estimated))
  const namedOwners = !measure && scope && (scope.role === 'trip-quote' || plans.every(plan => !plan.quantity.scope?.entity))
    ? new Set(proofs.map(proof => proof?.owner && subjectTerms(proof.owner).join(' ')).filter(Boolean))
    : null
  const sameTrip = scope?.role !== 'trip-quote' ||
    Boolean(proofs[0]?.tripKey && namedOwners?.size === 1 && proofs.every(proof => proof?.tripKey === proofs[0].tripKey))
  const complete = operation && values.every(Boolean) && values.every(value => value.unit === values[0].unit) &&
    !(namedOwners?.size > 1) && sameTrip
  const operands = plans.map((plan, index) => {
    const proof = proofs[index]
    const number = values[index]
    const role = plan.quantity.scope?.role
    const ceiling = role === 'loan-ceiling'
    const indicative = proof?.qualifier === 'approximate' ? (language === 'zh' ? '约 ' : 'about ') + proof.value + (measure ? ' ' + measure : '') : null
    const known = proof?.related ? (language === 'zh' ? '实际触达未知，另有其他口径记录' : 'actual reach unknown; a different measure was recorded')
      : indicative ?? (number ? (measure ? `${number.display} ${measure}` : proof.value)
      : proof?.ambiguous ? (language === 'zh' ? '原话有冲突' : 'conflicting evidence')
        : proof ? (language === 'zh' ? '见原话中的条件' : 'see the original qualifier')
          : (mealtime ? 'exact count unknown' : language === 'zh' ? '无依据' : 'no evidence'))
    const field = ceiling ? (language === 'zh' ? '获批借款上限' : 'Borrowing ceiling') : plan.quantity.subject
    const entity = ceiling && plan.quantity.scope.entity ? ' (' + plan.quantity.scope.entity + ')' : ''
    return `${field}${entity} = ${known}`
  })
  let result = null, unit = null, expression = null, equation = null
  if (complete) {
    const ordered = operation === 'reverse-difference' || operation === 'absolute-difference' && values[0].amount < values[1].amount
      ? values.slice().reverse() : values
    const amounts = ordered.map(value => value.amount)
    const total = amounts.slice(1).reduce((acc, amount) => operation === 'sum' ? acc + amount : acc - amount, amounts[0])
    const sign = total < 0n ? '-' : ''
    const digits = String(total < 0n ? -total : total).padStart(7, '0')
    const fraction = digits.slice(-6).replace(/0+$/u, '')
    result = sign + digits.slice(0, -6) + (fraction ? '.' + fraction : '')
    unit = values[0].unit
    const formatted = language === 'zh' && unit === 'cny' ? result + '元'
      : /^\p{Sc}$/u.test(unit) ? unit + result : result + ' ' + unit
    equation = { operands: ordered.map(value => value.display), operator: operation === 'sum' ? '+' : '-' }
    expression = equation.operands.join(operation === 'sum' ? ' + ' : ' − ') + (estimated ? ' ≈ ' : ' = ') + formatted
  }
  const label = scope?.role === 'reach'
    ? operation ? (language === 'zh' ? '按渠道相加' : 'Per-channel sum') : (language === 'zh' ? '合并触达人数' : 'Combined reach')
    : measure || operation === 'sum' ? (language === 'zh' ? '合计' : 'Total')
    : (language === 'zh' ? '差额' : 'Difference')
  const unavailable = scope?.role === 'reach' && !operation && values.every(Boolean)
    ? (language === 'zh' ? '缺少重叠人数' : 'audience overlap unknown')
    : language === 'zh' ? '无依据' : 'insufficient evidence'
  const heading = language === 'zh' ? '原话数值核对' : 'Verified quantities'
  const text = scope?.spender && result === null
    ? (language === 'zh' ? '总金额无法确定。以下只是单项已知金额。' : 'The total cannot be determined. These are individual item amounts only.') + ' ' + operands.join(' · ')
    : scope?.role === 'reach' && result === null
    ? (language === 'zh' ? '合并触达人数未知。分开报告已知数据。' : 'Combined reach is unknown. Report each measure separately.') + ' ' + operands.join(' · ')
    : mealtime && result === null
    ? `The combined number of ${measure} cannot be determined. Report the verified individual counts and say which count is unknown. ` + operands.join(' · ')
    : operands.join(' · ') + ' · ' + (estimated ? 'Estimated difference' : label) + ' = ' + (expression ?? unavailable)
  const priceScope = PRICE_SCOPES.has(scope?.role)
  const fundraising = scope?.role === 'fundraising-comparison'
  const amountRoles = !measure && scope && !priceScope && !fundraising ? plans.map(plan => plan.quantity.scope.role) : null
  if (operation === 'reverse-difference') amountRoles?.reverse()
  return { result, unit, measure, ...(equation ? { equation } : {}), ...(amountRoles ? { amountRoles } : {}), ...(estimated ? { estimated: true } : {}),
    ...(scope?.role === 'fare-comparison' ? { fareModes: plans.map(plan => plan.quantity.scope.entity) } : {}),
    ...(estimated && result === null ? { missingFares: plans.filter((_, index) => !values[index]).map(plan => plan.quantity.subject) } : {}),
    ...(priceScope || fundraising || scope?.role === 'reach' ? { scopeRole: scope.role } : {}),
    ...(fundraising ? { fundraisingEvent: scope.entity, fundraisingActor: scope.actor,
      ...(complete ? { fundraisingAmounts: values.map(value => value.display) } : {}) } : {}),
    ...(scope?.spender ? { spending: true, spendingSubjects: plans.map(plan => plan.quantity.subject) } : {}),
    text: `- [${heading}] ${text}` }
}

function fundraisingAnswerClaim(sentence) {
  const text = withoutEvidencePreface(sentence.trim()).replace(/[.!。]+$/u, '')
  return (FUNDRAISING_DELTA_ANSWER.exec(text) ?? FUNDRAISING_EXCEEDED_ANSWER.exec(text))?.groups
}

function contradictsFundraisingAmounts(check, text, number) {
  if (!check.fundraisingAmounts) return false
  const scope = { entity: check.fundraisingEvent, actor: check.fundraisingActor }
  const clauses = sourceSentences(text).flatMap(sentence => sentence.split(FUNDRAISING_ANSWER_CLAUSE))
  return ['raised', 'initial'].some((stage, index) => clauses.some(clause => {
    const statement = clause.trim().replace(FUNDRAISING_ANSWER_GOAL, '$1 was ')
    const proof = fundraisingProof({ ...scope, stage }, statement, true)
    return proof && number(proof.value) !== number(check.fundraisingAmounts[index])
  }))
}

function contradictsQuantityEquation(check, text, number) {
  const expected = check.equation
  if (!expected) return false
  return [...text.matchAll(QUANTITY_EQUATION)].some(({ groups }) => {
    const operands = groups.operands.split(/[+-]/u).map(number)
    if (operands.length !== expected.operands.length || number(groups.result) !== check.result) return false
    const operators = groups.operands.match(/[+-]/gu)
    if (operators.some(operator => operator !== expected.operator)) return true
    const stated = expected.operator === '+' ? operands.slice().sort() : operands
    const verified = expected.operands.map(number)
    if (expected.operator === '+') verified.sort()
    return stated.some((value, index) => value !== verified[index])
  })
}

function spendingClaims(check, sentence) {
  const subjects = check.spendingSubjects
  if (!subjects?.length) return []
  return [...sentence.matchAll(SPENDING_RESULT)].flatMap(match => {
    const after = sentence.slice(match.index + match[0].length)
    const named = AFTER_SPENDING_AMOUNT.exec(after)?.[1].split(/\b(?:but|whereas|while|except)\b/iu, 1)[0].trim()
    const agrees = Boolean(named && !named.match(MONEY) && subjects.every(subject => containsEntity(named, subject)))
    const overall = match.groups.total || /^\s*(?:in total|altogether)\b/iu.test(after) ||
      named && /\b(?:in total|altogether)\s*$/iu.test(named)
    if (!overall && !agrees) return []
    return [{ amount: match.groups.amount, agrees: !named || agrees }]
  })
}

export function unsupportedQuantityResult(check, answer) {
  if (check.scopeRole === 'reported-counter' && check.result === null) {
    return sourceSentences(String(answer ?? '').normalize('NFKC')).some(sentence => {
      if (NONFACT.test(sentence)) return false
      const cue = TOTAL_OR_DELTA.exec(sentence)
      if (!cue) return false
      const end = cue.index + cue[0].length
      return /^\s*\d/u.test(sentence.slice(end)) && !namesCounterSubtotal(sentence.slice(0, end), check.counters)
    })
  }
  if (check.scopeRole === 'fundraising-comparison' && check.result === null) {
    const text = String(answer ?? '').normalize('NFKC').trim()
    return sourceSentences(text).some(sentence => {
      if (NONFACT.test(sentence)) return false
      if (fundraisingAnswerClaim(sentence)) return true
      const cue = FUNDRAISING_DIFFERENCE_LABEL.exec(sentence)
      const tail = cue ? sentence.slice(cue.index + cue[0].length) : sentence === text ? sentence : ''
      return exactMoneyIn(tail.trimStart()).some(amount => amount.offset === 0)
    })
  }
  if (PRICE_SCOPES.has(check.scopeRole) && check.result === null) {
    const text = String(answer ?? '').normalize('NFKC').trim()
    return sourceSentences(text).some(sentence => {
      if (check.estimated ? CONDITIONAL_COST.test(sentence) : NONFACT.test(sentence)) return false
      if ((check.spending && spendingClaims(check, sentence).length > 0) ||
          (check.fareModes && FARE_DELTA_ANSWER.test(sentence)) ||
          (check.scopeRole === 'trip-quote' && TRIP_DELTA_ANSWER.test(sentence))) return true
      const cue = TOTAL_OR_DELTA.exec(sentence) ?? ITEM_PRICE_RESULT.exec(sentence) ?? (check.estimated ? SAVINGS_ANSWER.exec(sentence) : null)
      const tail = cue ? sentence.slice(cue.index + cue[0].length) : sentence === text ? sentence : ''
      const amount = tail.slice(tail.lastIndexOf('=') + 1).trimStart().replace(APPROXIMATE_PREFIX, '')
      return exactMoneyIn(amount).some(match => match.offset === 0) ||
        /^\d+(?:\.\d+)?\s*(?:(?:chinese\s+)?yuan|renminbi)\b/iu.test(amount)
    })
  }
  if (check.scopeRole !== 'reach' || check.result !== null) return false
  return sourceSentences(String(answer ?? '').normalize('NFKC')).some(sentence => {
    const cue = /(?:\b(?:total|combined(?: actual)? reach|overall reach)\b[^.!?;]{0,115}?\b(?:is|was|equals|comes to)\s*|(?:合并触达(?:人数)?|总触达(?:人数)?|一共触达|合计触达)\s*(?:为|是|有|[:：=])?\s*)/iu.exec(sentence)
    return cue && /^(?:约|大约|about\s+|around\s+|~\s*)?\d/iu.test(sentence.slice(cue.index + cue[0].length))
  })
}

/** A bare response can answer an explicit total or difference. An item on
 * its own can never stand in for that result in a multi-line response. */
export function quantityResultCovered(check, answer) {
  if (typeof check?.result !== 'string') return false
  const text = String(answer ?? '').normalize('NFKC').replace(/−/gu, '-')
  if (check.scopeRole === 'reported-counter' && check.counters?.some(counter => contradictsReportedCounter(text, counter, check.counters))) return false
  if (check.unit === '%') {
    const rate = /(\d+(?:\.\d+)?)\s*(?:%|\bpercent\b)|百分之\s*(\d+(?:\.\d+)?)/giu
    const sentences = sourceSentences(text)
    if (sentences.some(sentence => /(?:无依据|不能|无法|不确定|\b(?:not|unknown|uncertain|if|unless|might|maybe)\b)/iu.test(sentence))) return false
    const bare = /^\s*(?:≈|~)?\s*\d+(?:\.\d+)?\s*(?:%|percent)[.。!！\s]*$/iu.test(text)
    const claims = new Set(sentences.flatMap(sentence => [...sentence.matchAll(rate)]
      .filter(match => bare || /折扣|便宜|降价|\b(?:discount(?:ed)?|percent off)\b|%\s*off\b/iu.test(sentence))
      .map(match => Number(match[1] ?? match[2]))))
    return claims.size === 1 && claims.has(Number(check.result))
  }
  const number = value => {
    const match = /^(\p{Sc})?\s*(-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)\s*([^\d]*?)\s*$/u.exec(value.trim().replace(/[.。!！]+$/u, ''))
    if (!match) return null
    const [, symbol, digits, suffix] = match
    const unit = suffix.trim().toLowerCase()
    const expected = check.unit?.toLowerCase()
    if (symbol && (check.measure || symbol !== expected)) return null
    if (unit && moneyUnit(unit) !== expected && !(check.measure && tokenize(unit).map(singular).join(' ') === tokenize(expected).map(singular).join(' ')) &&
        !(expected === '$' && /^dollars?$/u.test(unit))) return null
    return digits.replace(/,/gu, '').replace(/(\.\d*?[1-9])0+$/u, '$1').replace(/\.0+$/u, '')
  }
  if (contradictsQuantityEquation(check, text, number) || contradictsFundraisingAmounts(check, text, number)) return false
  if (check.estimated) {
    const bare = text.trim()
    if (APPROXIMATE_PREFIX.test(bare)) return number(bare.replace(APPROXIMATE_PREFIX, '')) === check.result
    const claims = new Set()
    for (const sentence of sourceSentences(text)) {
      const cue = SAVINGS_ANSWER.exec(sentence)
      if (!cue || CONDITIONAL_COST.test(sentence)) continue
      const tail = sentence.slice(cue.index + cue[0].length)
      const unqualified = tail.replace(APPROXIMATE_PREFIX, '')
      const [amount] = exactMoneyIn(unqualified)
      const claim = number(amount?.offset === 0 ? amount.value : unqualified)
      if (amount?.offset === 0 && (claim === null || !cue.groups.estimate && tail === unqualified)) return false
      const route = SAVINGS_ALTERNATIVES.exec(unqualified)
      if (claim !== null && route && (fareModes(route[1]).join() !== check.fareModes?.[1] ||
          fareModes(route[2]).join() !== check.fareModes?.[0])) return false
      if (claim !== null) claims.add(claim)
    }
    return claims.size === 1 && claims.has(check.result)
  }
  const direct = number(text)
  if (direct !== null) return direct === check.result
  const claims = new Set()
  for (const sentence of sourceSentences(text)) {
    if (NONFACT.test(sentence)) continue
    const spending = check.spending ? spendingClaims(check, sentence) : []
    if (spending.length) {
      for (const claim of spending) {
        const figure = number(claim.amount)
        if (!claim.agrees || figure === null) return false
        claims.add(figure)
      }
      continue
    }
    const delta = check.fareModes ? FARE_DELTA_ANSWER.exec(sentence)?.groups : null
    if (delta) {
      const [a, b] = check.fareModes
      const left = fareModes(delta.left).join(), right = fareModes(delta.right).join()
      const forward = left === a && right === b
      const reverse = left === b && right === a
      const figure = number(delta.amount)
      if (!(forward || reverse) || figure === null) return false
      claims.add(forward === /^more$/iu.test(delta.direction) || figure === '0' ? figure : '-' + figure)
      continue
    }
    if (check.scopeRole === 'fundraising-comparison') {
      const claim = fundraisingAnswerClaim(sentence)
      if (claim) {
        const actor = claim.actor.toLowerCase()
        const owner = actor === 'you' ? 'your' : actor === 'i' ? 'my' : 'our'
        const figure = number(claim.amount)
        if (figure === null || claim.owner.toLowerCase() !== owner ||
            actor !== 'you' && actor !== check.fundraisingActor ||
            claim.event && fundraisingEventKey(claim.event) !== check.fundraisingEvent) return false
        claims.add(/^(?:less|fell short of)$/iu.test(claim.direction) && figure !== '0' ? '-' + figure : figure)
        continue
      }
      const context = FUNDRAISING_CONTEXT.exec(withoutEvidencePreface(sentence))?.groups
      const statement = context?.claim ?? sentence
      const cue = FUNDRAISING_DIFFERENCE_LABEL.exec(statement)
      if (!cue) continue
      if (context && fundraisingEventKey(context.event) !== check.fundraisingEvent) return false
      const tail = statement.slice(cue.index + cue[0].length)
      const figure = number(tail.slice(tail.lastIndexOf('=') + 1))
      if (figure !== null) claims.add(figure)
      continue
    }
    const trip = check.scopeRole === 'trip-quote' ? TRIP_DELTA_ANSWER.exec(sentence)?.groups : null
    if (trip) {
      const figure = number(trip.amount)
      if (figure === null) return false
      claims.add(figure)
      continue
    }
    if (check.amountRoles) {
      const english = ENGLISH_DELTA.exec(sentence)
      const chinese = english ? null : CHINESE_DELTA.exec(sentence)
      if (english || chinese) {
        const [left, right, direction, amount] = english
          ? [english[1], english[4], english[3], english[2]] : chinese.slice(1)
        const roles = [moneyScope(left)?.role, moneyScope(right)?.role]
        const forward = roles.every((role, index) => role === check.amountRoles[index])
        const reverse = roles.every((role, index) => role === check.amountRoles[1 - index])
        const figure = number(amount)
        if ((forward || reverse) && figure !== null) {
          const larger = /^(?:more|higher|高|多)$/iu.test(direction)
          claims.add(forward === larger || figure === '0' ? figure : '-' + figure)
        }
      }
    }
    const cue = TOTAL_OR_DELTA.exec(sentence) ?? (PRICE_SCOPES.has(check.scopeRole) ? ITEM_PRICE_RESULT.exec(sentence) : null)
    if (!cue) continue
    const end = cue.index + cue[0].length
    if (check.scopeRole === 'reported-counter' && namesCounterSubtotal(sentence.slice(0, end), check.counters)) continue
    const tail = sentence.slice(end)
    const value = number(tail.slice(tail.lastIndexOf('=') + 1))
    if (value !== null) claims.add(value)
  }
  return claims.size === 1 && claims.has(check.result)
}
