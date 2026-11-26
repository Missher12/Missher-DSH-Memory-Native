import { readDayCount } from './calendar-recall.js'
import { estimateTokens } from './recall.js'
import { sourceSentences } from './sentences.js'
import { DEEP_RECALL_TOKEN_LIMIT, isRecallSourceStatement } from './source-passages.js'
import { explicitRememberText } from './user-controls.js'

const EN_TOTAL = /^(?:what (?:is|was) (?:the )?|give me (?:the )?)(?:total|combined) (?:number|count) of (?<measures>.+?) (?:on|in|for|across|from) (?<subjects>.+)$/iu
const CN_TOTAL = /^(?<subjects>.+?)(?:合计|一共|总共)(?:有)?(?:多少|几)(?<measure>条评论|个评论|次观看|次浏览|次点击|次分享|个进球|次助攻|个请求)$/u
const UNITS = new Map([
  ['comments', ['comments?', '(?:条|个)评论']], ['views', ['views?', '次(?:观看|浏览)']],
  ['likes', ['likes?', '(?:次|个)点赞']], ['clicks', ['clicks?', '次点击']], ['shares', ['shares?', '次分享']],
  ['goals', ['goals?', '个进球']], ['assists', ['assists?', '次助攻']], ['wins', ['wins?', '场胜利']],
  ['losses', ['loss(?:es)?', '场失利']], ['draws', ['draws?', '场平局']],
  ['replies', ['repl(?:y|ies)', '条回复']], ['downloads', ['downloads?', '次下载']],
  ['requests', ['requests?', '个请求']], ['incidents', ['incidents?', '次故障']],
])
const CN_UNIT = { 条评论: 'comments', 个评论: 'comments', 次观看: 'views', 次浏览: 'views', 次点击: 'clicks',
  次分享: 'shares', 个进球: 'goals', 次助攻: 'assists', 个请求: 'requests' }
const PLATFORMS = /\b(?:YouTube|TikTok|Facebook|Instagram|Twitch|Vimeo|Bilibili|Threads|LinkedIn)\b/giu
const AMOUNT = String.raw`\d{1,3}(?:,\d{3})+|\d+|(?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:[- ][a-z]+)?|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|[零一二两三四五六七八九十]+`
const NONFACT = /^(?:[“‘"'「『>]|(?:if|suppose|imagine|example|when)\b)|\b(?:will|would|might|probably|expect(?:ed)?|anticipate|hope|plan(?:ned|ning)?|not|never|said|heard)\b|预计|计划|想要|听说|转述|假设|不会|没有/iu
const NOT_OWNED = /\b(?:my|our) (?:friend|colleague|teammate|sister|brother|partner|coworker|neighbor)(?:['’]s|\s+(?:scored|got|received|has|had))|\b(?:his|her|their) most popular\b|朋友的|同事的|别人的/iu
const INEXACT = /\b(?:about|around|approximately|nearly|roughly|at least|at most|over|more than|fewer than|under|between\s+[\w, -]{1,24}\s+and|\d+\s+(?:to|or))\s*$|[\d零一二两三四五六七八九十]\s*(?:[-–—−]|到|至|或)\s*$|(?:约|大约|近|超过|不到|至少|至多)\s*$/iu
const UNRESOLVED_STATEMENT = /\b(?:wonder(?:ing|ed)?\s+(?:if|whether)|asked\s+(?:whether|if)|could get)\b|想知道是不是|不知道是否/iu
const COMBINED = /^\s*(?:(?:and|or|\/)\s+(?:(?:comments?|views?|likes?|shares?|clicks?|goals?|assists?|wins?|losses?|draws?)\b)|(?:combined|together)\b)|^(?:及|和|与)?(?:进球和助攻|观看和点赞|评论和分享|合计)/iu
const CLIPPING = /[，;；]|,\s*(?=\p{Script=Han})|\s*,\s*(?=(?:(?:and|but|while)\s+)?(?:I|we|you|he|she|they|my|our|the)\b)|\s+(?:and|but|while)\s+(?=(?:I|we|you|he|she|they|my|our)\b)/iu
const EARLIER_SCOPE = /\b(?:as of|before|after|previously|former|last year|then)\b|以前|当时|截至|曾经|去年/iu
const SOURCE_COUNT_CUE = /\b(?:got|received|has|have|had|scored|recorded|earned|counted|reached|logged|reported|with|made)\b|收到|有|得到|获得|完成|记录|达到了?|助攻|进了/iu
const PRESENT_USER = /\b(?:i|we)(?:['’](?:m|ve|re))?\b|\b(?:my|our)\b|(?:^|[，,。 ])我(?:们|的)?/iu
const PERSONAL_REQUEST = /\s+(?<actor>i|we)(?:['’]ve)?\s+(?:have|had|recorded|logged|received|got)$/iu
const PERSONAL_COUNTER = /^(?:(?:by the way|actually),?\s+)?(?<actor>i|we)(?:['’](?:ve|m|re))?\s+(?:(?:already|just|also|recently|actually)\s+)*(?:have|had|got|scored|recorded|earned|logged|made|received)\b|^(?:(?:by the way|actually),?\s+)?(?<coordinated>i|we)(?:['’](?:ve|m|re))?\s+[^,.;!?]{1,110}\band\s+(?:also\s+)?(?:have|had|got|scored|recorded|earned|logged|made|received)\b/iu
const BEST_VIDEO = /\b(?:my|our) most popular video\b/iu
const SHARED_RANK = /^(?:(?:my|our|the)\s+)?most popular videos on (?<platforms>.+)$/iu
const NEW_SCOPE = /\b(?:in|on|for|across|from|against|at|during)\s+(?!(?:total|all)\b)/iu
const ARTIFACT_TYPE = /^(?:tutorial|video|clip)$/iu
const FILLER = new Set(['about', 'on', 'of', 'the', 'a', 'an'])
const RANK_ASSERTION = /^(?:,\s*which\s+is|is|,\s*currently)\s+(?:my|our)\s+most popular video\b/iu

const normalize = text => String(text ?? '').normalize('NFKC').toLowerCase().trim()
const literal = text => text.replace(/[.*+?^$(){}|[\]\\]/gu, '\\$&')
const scopeName = text => normalize(text).replace(/^(?:(?:my|our|the)\s+)+/iu, '').trim()
const platformNames = text => [...new Set([...text.matchAll(PLATFORMS)].map(match => normalize(match[0])))]

function words(text) {
  return normalize(text).replace(/[“”"'‘’《》]/gu, '').match(/[\p{L}\p{N}][\p{L}\p{N}-]*/gu) ?? []
}

function subjectIn(text, subject) {
  if (/\p{Script=Han}/u.test(subject)) return normalize(text).includes(subject)
  const needle = words(subject)
  const haystack = words(text)
  return needle.length > 0 && haystack.some((_, offset) => needle.every((part, index) => haystack[offset + index] === part))
}

function answerNamesCounter(text, counter) {
  if (subjectIn(text, counter.subject)) return true
  if (!counter.platform || platformNames(text).length !== 1) return false
  const ranked = new RegExp(String.raw`\bmost popular videos? on ${literal(counter.platform)}\b`, 'iu')
  return ranked.test(text)
}

function videoIdentity(statement, platform) {
  const owned = new RegExp(String.raw`\b(?:my|our)\s+(?<title>[^.!?;,]{6,85}?)\s+on\s+${literal(platform)}\b`, 'giu')
  const candidates = [...statement.matchAll(owned)].flatMap(match => {
    const terms = words(match.groups.title)
    if (terms.filter(word => ARTIFACT_TYPE.test(word)).length !== 1 ||
        terms.some(word => /^(?:and|or|my|our|most|more|new)$/iu.test(word))) return []
    const names = terms.filter(word => !FILLER.has(word) && !ARTIFACT_TYPE.test(word))
    if (new Set(names).size < 2) return []
    const end = match.index + match[0].length
    const rank = RANK_ASSERTION.exec(statement.slice(end).trimStart())
    return [{ identity: names.sort().join(' '), ranked: Boolean(rank), from: match.index,
      to: rank ? statement.indexOf(rank[0], end) + rank[0].length : end }]
  })
  return candidates.length === 1 ? candidates[0] : null
}

/** Each operand carries both the measure and the subject it describes. */
export function reportedCounterQuery(value) {
  const text = String(value ?? '').normalize('NFKC').trim().replace(/[?？。]+$/u, '')
  if (text.length > 310 || /[<>\n;]/u.test(text)) return null
  const english = EN_TOTAL.exec(text)?.groups
  const chinese = CN_TOTAL.exec(text)?.groups
  const group = english ?? chinese
  if (!group || EARLIER_SCOPE.test(group.subjects)) return null
  const actor = english ? PERSONAL_REQUEST.exec(english.measures)?.groups.actor?.toLowerCase() : undefined
  const measures = chinese ? [CN_UNIT[chinese.measure]]
    : normalize(english.measures).replace(PERSONAL_REQUEST, '')
      .split(/\s*(?:,|\band\b)\s*/iu).filter(Boolean)
  const taggedPlatforms = SHARED_RANK.exec(group.subjects)?.groups.platforms
  let subjects = (taggedPlatforms ?? group.subjects).split(/\s+and\s+|[、，,]|以及|和|与/iu).map(scopeName).filter(Boolean)
  if (taggedPlatforms) {
    if (subjects.some(platform => platformNames(platform)[0] !== platform)) return null
    subjects = subjects.map(platform => 'most popular ' + platform + ' video')
  }
  if (measures.some(unit => !UNITS.has(unit)) || new Set(measures).size !== measures.length ||
      subjects.some(subject => !subject || subject.length > 90 || /\bor\b|或者|任选|任意/iu.test(subject)) ||
      new Set(subjects).size !== subjects.length || (measures.length > 1 && subjects.length !== 1)) return null
  const slots = measures.length === 1 ? subjects.map(subject => ({ subject, measure: measures[0] }))
    : measures.map(measure => ({ subject: subjects[0], measure }))
  if (slots.length < 2 || slots.length > 4) return null
  const language = chinese ? 'zh' : 'en'
  return { language, unit: measures.length === 1 ? chinese?.measure ?? measures[0] : null,
    slots: slots.map(({ subject, measure }) => {
      const [platform] = platformNames(subject)
      const refers = /^most popular .+ video$/iu.test(subject) && platform
      const displayMeasure = chinese?.measure ?? measure
      return { subject, measure, query: language === 'zh' ? subject + '的' + displayMeasure + '数量' : displayMeasure + ' on ' + subject,
        displayMeasure, own: /\b(?:my|our|i|we)\b|我的|我们的/u.test(normalize(text)), ...(refers ? { platform } : {}),
        ...(actor ? { actor } : {}) }
    }) }
}

function metricValues(text, slot) {
  const [english, chinese] = UNITS.get(slot.measure)
  const pattern = new RegExp(String.raw`(?<![\p{Script=Latin}\p{N}.,-])(?<value>${AMOUNT})\s*(?:${english}\b|${chinese})`, 'giu')
  return [...text.matchAll(pattern)].flatMap(match => {
    const before = text.slice(0, match.index), tail = text.slice(match.index + match[0].length)
    if (INEXACT.test(before) || COMBINED.test(tail)) return []
    const digits = match.groups.value.replace(/,/gu, '')
    const value = /^\d+$/u.test(digits) ? Number(digits) : readDayCount(digits)
    return Number.isSafeInteger(value) && value >= 0 ? [String(value)] : []
  })
}

function counterClaims(text, slot, { answer = false, reference = false } = {}) {
  const found = []
  for (const sentence of sourceSentences(text)) {
    if (!answer && !isRecallSourceStatement(sentence)) continue
    let previous = null, offset = 0
    for (const piece of sentence.split(CLIPPING)) {
      const quote = piece.trim()
      const from = sentence.indexOf(quote, offset)
      offset = from + quote.length
      const statement = (answer ? quote : explicitRememberText(quote) ?? quote).replace(/^(?:and|but|while)\s+/iu, '').trim()
      const eligible = statement && !NONFACT.test(statement) && (answer ||
        (!NOT_OWNED.test(statement) && (!slot.own || PRESENT_USER.test(statement))))
      const artifact = eligible && slot.platform ? videoIdentity(statement, slot.platform) : null
      const direct = eligible && ((answer ? answerNamesCounter(statement, slot) : subjectIn(statement, slot.subject)) || artifact?.ranked)
      const referenceType = eligible && reference && slot.platform
        ? artifact && !artifact.ranked ? 'rank' : BEST_VIDEO.test(statement) && !platformNames(statement).length ? 'platform' : null
        : null
      const separator = previous ? sentence.slice(previous.end, from) : ''
      const inherited = eligible && !direct && previous !== null && !NEW_SCOPE.test(statement) &&
        (/\band\b|以及|并且/iu.test(separator) || /^and\b/iu.test(quote) || previous.introduction && /^\s*,\s*$/u.test(separator))
      const who = !answer && slot.actor ? PERSONAL_COUNTER.exec(statement)?.groups : null
      const personal = !slot.actor || (who?.actor ?? who?.coordinated)?.toLowerCase() === slot.actor
      if (eligible && (answer || SOURCE_COUNT_CUE.test(statement) && personal && !UNRESOLVED_STATEMENT.test(statement)) &&
          (direct || referenceType || inherited)) {
        const evidence = inherited ? sentence.slice(previous.from, offset) : quote
        const linked = direct || inherited ? null : referenceType
        for (const value of metricValues(statement, slot)) found.push({ value, quote: evidence, linked, artifact: artifact?.identity })
      }
      const introduction = /^(?:in|on|for|at)\s+/iu.test(statement) && !SOURCE_COUNT_CUE.test(statement) &&
        subjectIn(statement, slot.subject) && !NONFACT.test(statement)
      previous = direct || introduction ? { from, end: offset, introduction } : null
    }
  }
  return found
}

function linkToRank(slot, artifact, hits) {
  const declarations = []
  for (const hit of hits) for (const quote of sourceSentences(hit.record.content)) {
    if (!isRecallSourceStatement(quote) || NONFACT.test(quote) || NOT_OWNED.test(quote)) continue
    const named = videoIdentity(quote, slot.platform)
    if (named?.ranked) declarations.push({ hit, quote: quote.slice(named.from, named.to), identity: named.identity })
  }
  if (!declarations.length) return null
  const by = clock => row => row.hit.record.sourceRefs[0][clock]
  const clock = ['eventSeq', 'eventTime'].find(field => declarations.every(row => Number.isSafeInteger(by(field)(row))))
  const latest = clock ? Math.max(...declarations.map(by(clock))) : null
  const current = clock ? declarations.filter(row => by(clock)(row) === latest) : declarations
  return current.every(row => row.identity === artifact) ? current[0] : null
}

function linkToPlatform(slot, hits) {
  // The same speaker used the same superlative in both authorized messages.
  // A second named platform in the available context makes the shorthand ambiguous.
  if (hits.some(hit => platformNames(hit.record.content).some(name => name !== slot.platform))) return null
  for (const hit of hits) {
    const original = hit.record.content
    const named = sourceSentences(original).filter(text => isRecallSourceStatement(text) && !NOT_OWNED.test(text) && !NONFACT.test(text))
    const direct = named.find(text => PRESENT_USER.test(text) && subjectIn(text, slot.subject))
    if (direct) return { hit, quote: direct }
    const channel = new RegExp(String.raw`\b(?:my|our)\s+${literal(slot.platform)}\s+channel\b`, 'iu')
    const a = named.find(text => channel.test(text)), b = named.find(text => BEST_VIDEO.test(text))
    if (a && b) {
      const from = original.indexOf(a) + channel.exec(a).index, end = original.indexOf(b)
      const firstClause = b.split(/[,;]|\bso\b/iu, 1)[0].trimEnd()
      if (from <= end && end + firstClause.length - from <= 240) {
        return { hit, quote: original.slice(from, end + firstClause.length) }
      }
    }
  }
  return null
}

export function matchesReportedCounterAnswer(answer, counter, counters) {
  const values = counterAnswerValues(answer, counter, counters)
  return values.size === 1 && values.has(counter.value)
}

function counterAnswerValues(answer, counter, counters = []) {
  const [unit] = UNITS.get(counter.measure)
  const labelled = String.raw`(?:${AMOUNT})\s*(?:${unit})\b\s+(?:on|in|for|from|at|against|during)\s+`
  const separator = new RegExp(String.raw`(?:,\s*(?:and\s+)?|\s+and\s+)(?=${labelled})`, 'giu')
  const short = counter.subject.replace(/^(?:recent|most popular)\s+/u, '')
  let text = answer.normalize('NFKC').replace(/[*_]/gu, '')
  if (short !== counter.subject && words(short).length >= 2 &&
      !counters.some(other => other.subject !== counter.subject && subjectIn(other.subject, short))) {
    // A shortened name in the same answer must refer back to an explicit subject.
    const reference = new RegExp(String.raw`(${labelled}the\s+)${literal(short)}\b(?=\s*(?:[,.;!?]|$|and\b))`, 'giu')
    text = text.replace(reference, (claim, prefix, offset, original) =>
      subjectIn(original.slice(0, offset), counter.subject) ? prefix + counter.subject : claim)
  }
  text = text.replace(separator, '; ')
  const values = new Set(counterClaims(text, counter, { answer: true }).map(row => row.value))
  const subtotal = new RegExp(String.raw`\b(?:total|combined) (?:number|count) of (?:${unit})\b[^.!?;]{0,115}?\b(?:is|was|equals)\s+(?<amount>${AMOUNT})\s*[.!?]?$`, 'iu')
  for (const sentence of sourceSentences(text)) {
    const amount = subtotal.exec(sentence)?.groups.amount
    if (!amount || NONFACT.test(sentence) || !answerNamesCounter(sentence, counter) ||
        !namesCounterSubtotal(sentence, counters.length ? counters : [counter])) continue
    for (const value of metricValues(amount + ' ' + counter.measure, counter)) values.add(value)
  }
  return values
}

export function contradictsReportedCounter(answer, counter, counters) {
  return [...counterAnswerValues(answer, counter, counters)].some(value => value !== counter.value)
}

export function namesCounterSubtotal(prefix, counters) {
  const named = (counters ?? []).filter(counter => answerNamesCounter(prefix, counter))
  if (named.length < 2) return named.length === 1 && (!named[0].platform || platformNames(prefix).length === 1)
  if (new Set(named.map(counter => counter.subject)).size !== 1) return false
  return named.filter(counter => {
    const [english, chinese] = UNITS.get(counter.measure)
    return new RegExp(String.raw`\b(?:${english})\b|(?:${chinese})`, 'iu').test(prefix)
  }).length === 1
}

export function retrieveReportedCounters(index, group, { projectKey, now, maxTokens, maxItems,
  scanLimit = DEEP_RECALL_TOKEN_LIMIT, skipCapture = false, accepts = () => true, standalone }) {
  const anchorBudget = group.slots.some(slot => slot.platform) ? Math.floor(scanLimit / 5) : 0
  const context = new Map()
  let anchorTokens = 0, anchorOmitted = false
  const nearby = (hit, later = false) => {
    const key = (later ? 'after:' : 'before:') + hit.record.sourceRefs[0].sourceId
    if (!context.has(key)) {
      const sources = (later ? index.followingMessages(hit, projectKey, { now, limit: 6 })
        : index.previousMessages(hit, projectKey, { now })).filter(accepts)
      const cost = sources.reduce((total, source) => total + estimateTokens(source.record.content), 0)
      if (anchorTokens + cost <= anchorBudget) {
        anchorTokens += cost
        context.set(key, sources)
      } else {
        anchorOmitted = true
        context.set(key, [])
      }
    }
    return context.get(key)
  }
  const plans = new Map(group.slots.map(slot => [slot.query, slot]))
  const scan = index.findEvidence([...plans.keys()], {
    projectKey, now, maxTokens: scanLimit - anchorBudget, allMatches: true, wholeSentences: true, acceptOriginal: true,
    lookupQuery: query => query,
    distinctKey: (_, hit) => hit.record.id,
    match(query, hit) {
      if (hit.record.sourceRefs[0].eventTime > now || !accepts(hit)) return null
      const slot = plans.get(query)
      const others = group.slots.filter(other => other.subject !== slot.subject)
      const platforms = platformNames(slot.subject)
      const claims = counterClaims(hit.record.content, slot, { reference: true })
        .filter(claim => !others.some(other => subjectIn(claim.quote, other.subject)) &&
          (!platforms.length || platformNames(claim.quote).every(name => platforms.includes(name))))
        .map(claim => ({ ...claim, anchor: claim.linked === 'platform' ? linkToPlatform(slot, nearby(hit))
          : claim.linked === 'rank' ? linkToRank(slot, claim.artifact, [...nearby(hit), ...nearby(hit, true)])
            : null }))
      return claims.length ? { ...hit, claims } : null
    },
  })
  const verified = index.validateMany([...new Map(scan.matches.flatMap(({ hit }) =>
    [hit, ...hit.claims.flatMap(claim => claim.anchor ? [claim.anchor.hit] : [])])
    .map(hit => [hit.record.id, hit])).values()], projectKey, { now })
  const candidates = new Map(verified.map(hit => [hit.record.id, hit]))
  const valid = new Set(candidates.keys())
  let standaloneTokens = 0, standaloneOmitted = false
  const slots = group.slots.map(slot => {
    const hits = new Set()
    const exact = new Map()
    for (const { query, hit } of scan.matches) {
      if (query !== slot.query || !valid.has(hit.record.id)) continue
      hits.add(hit.record.id)
      for (const claim of hit.claims) {
        if (claim.linked && (!claim.anchor || !valid.has(claim.anchor.hit.record.id))) continue
        const proofs = claim.anchor ? [claim.anchor, { hit, quote: claim.quote }] : [{ hit, quote: claim.quote }]
        if (claim.anchor) hits.add(claim.anchor.hit.record.id)
        const previous = exact.get(claim.value)
        const size = proofs.reduce((sum, row) => sum + row.quote.length, 0)
        if (!previous || size < previous.size) exact.set(claim.value, { value: claim.value, proofs, size })
      }
    }
    // Older standalone facts may predate original-source grants. A sourced
    // compact record cannot replace its missing or revoked original.
    if (exact.size === 0 && !scan.incomplete && !anchorOmitted && standalone) {
      for (const hit of standalone.index.search(slot.query, { projectKey, scopes: ['project'], statuses: ['active'], now, limit: 40 })) {
        if (hit.record.kind !== 'fact' || hit.record.sourceRefs?.length || !accepts(hit)) continue
        const record = standalone.store.find(hit.record.id, [{ scope: 'project', projectKey }])
        if (!record || record.revision !== hit.record.revision || record.contentHash !== hit.record.contentHash) continue
        const cost = estimateTokens(record.content)
        if (scan.tokens + anchorTokens + standaloneTokens + cost > scanLimit) { standaloneOmitted = true; break }
        standaloneTokens += cost
        for (const claim of counterClaims(record.content, slot)) {
          const current = { ...hit, record }
          hits.add(record.id)
          candidates.set(record.id, current)
          if (!exact.has(claim.value)) exact.set(claim.value, { value: claim.value, proofs: [{ hit: current, quote: claim.quote }] })
        }
      }
    }
    const choice = exact.size === 1 && !scan.incomplete && !anchorOmitted && !standaloneOmitted ? exact.values().next().value : null
    return { slot, hitIds: [...hits], choice, disputed: exact.size > 1 }
  })
  const zh = group.language === 'zh'
  const render = selected => {
    const delivered = new Map()
    selected.forEach((choice, index) => {
      for (const { hit, quote } of choice?.proofs ?? []) {
        const id = hit.record.id
        if (!delivered.has(id)) delivered.set(id, { row: { hit }, quotes: new Set(), slots: new Set() })
        const row = delivered.get(id)
        row.quotes.add(quote)
        row.slots.add(index)
      }
    })
    const complete = selected.every(Boolean)
    const header = complete
      ? zh ? '依据原话逐项给出数字。缺一项时说明无法算出合计。'
        : 'Report each verified count. If any item is missing or disputed, say the total cannot be determined.'
      : zh ? '合计无法确定。只按条目逐项回答，原话是该条目的依据。'
        : 'The total is unknown. Use only the item rows as counts. The original quotes verify those same items.'
    const note = header + (skipCapture ? zh ? '本轮不提炼。' : ' Do not capture this turn.' : '')
    const total = complete ? String(selected.reduce((sum, choice) => sum + BigInt(choice.value), 0n)) : null
    const measures = selected.map((choice, index) => {
      const { slot, disputed } = slots[index]
      const amount = choice ? (zh ? choice.value + slot.displayMeasure : choice.value + ' ' + slot.displayMeasure)
        : disputed ? (zh ? '记录有冲突' : 'conflicting records') : (zh ? '缺少依据' : 'missing evidence')
      return '- ' + slot.subject + ' · ' + amount
    })
    const unitSuffix = group.unit ? (zh ? '' : ' ') + group.unit : ''
    const explanation = complete ? selected.map(choice => choice.value).join(' + ') + ' = ' + total + unitSuffix : null
    const totalLine = complete ? (zh ? '合计 ' : 'Total ') + explanation
      : zh ? '无法确定合计，所需数字缺失或有冲突。' : 'Total cannot be determined because a required count is missing or disputed.'
    const lines = complete ? [...measures, totalLine] : [totalLine, ...measures]
    const injected = [...delivered.values()].map(({ row, quotes }) => {
      const list = [...quotes]
      const original = row.hit.record.kind === 'source'
      const label = zh ? original ? '原话' : '记忆' : original ? 'Original' : 'Memory'
      return { row, quote: list.join('\n'), ...(list.length === 1 ? { selectedQuote: list[0] } : {}),
        text: list.map(quote => '- [' + label + '] ' + quote).join('\n') }
    })
    const evidence = []
    if (complete) {
      evidence.push(...injected.map(item => item.text))
    } else {
      const bySubject = new Map()
      for (const item of injected) {
        const row = delivered.get(item.row.hit.record.id)
        const subjects = [...new Set([...row.slots].map(index => slots[index].slot.subject))].join(zh ? '、' : ', ')
        const existing = bySubject.get(subjects) ?? []
        existing.push(item.text)
        bySubject.set(subjects, existing)
      }
      for (const [subjects, quotes] of bySubject) {
        evidence.push(zh ? `上述「${subjects}」的原话依据` : `Evidence for the same item above (${subjects})`, ...quotes)
      }
    }
    const text = injected.length ? ['<memory-context source="dsh-memory" note="' + note + '">', ...lines,
      ...evidence, '</memory-context>'].join('\n') : ''
    return { text, injected, complete, summary: lines.join('\n'),
      quantityCheck: { result: total, unit: group.unit, measure: group.unit, scopeRole: 'reported-counter',
        counters: slots.map(({ slot }, index) => ({ ...slot, value: selected[index]?.value ?? null })) },
      counterSlots: slots.map(({ slot, hitIds }, index) => ({
        ...slot, value: selected[index]?.value ?? null, hitIds,
        injectedIds: [...delivered].filter(([, row]) => row.slots.has(index)).map(([id]) => id),
      })) }
  }
  const selected = slots.map(({ choice }) => choice)
  let result = render(selected), budgetOmitted = scan.incomplete || anchorOmitted || standaloneOmitted
  while (result.injected.length > maxItems || estimateTokens(result.text) > maxTokens) {
    const drop = selected.findLastIndex(Boolean)
    if (drop === -1) break
    selected[drop] = null
    budgetOmitted = true
    result = render(selected)
  }
  return { ...result, hits: [...candidates.values()], scannedTokens: scan.tokens + anchorTokens + standaloneTokens, budgetOmitted }
}

export function counterReportQuestions(slots, hits, injected) {
  return slots.map(({ hitIds, injectedIds, ...counter }) => ({
    query: counter.query, detail: 'reported-counter', entityTerms: [], counter,
    hits: hits.filter(item => hitIds.includes(item.id)),
    injected: injected.filter(item => injectedIds.includes(item.id)),
    notInjected: hits.filter(item => hitIds.includes(item.id) && !injectedIds.includes(item.id)),
    answerCoverage: 'pending', answerExcerpt: null,
  }))
}
