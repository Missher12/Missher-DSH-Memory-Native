import { recallTaskLookup, readRecallSource } from './capture-journal.js'
import { matchesRecallAttribute, recallSubjectTerms } from './recall.js'
import { looksSensitive } from './records.js'
import { analyzeUserMessageControls } from './user-controls.js'
import { sourceAvailableAt, sourceTimeReference } from './source-time.js'
import { sourceSentences, withoutEvidencePreface } from './sentences.js'
import { tokenize } from './tokenize.js'

const STUDY_LEVELS = [
  String.raw`(?:bachelor(?:['’]s)?|undergrad(?:uate)?)`,
  String.raw`master(?:['’]s)?`,
  String.raw`(?:doctorate|doctoral|ph\.?d\.?)`,
]
const STUDY_QUESTION = new RegExp(String.raw`^where did (?:i|we) (?:complete|finish|earn|get) (?:(?:my|our|a|an|the) )?(?<level>${STUDY_LEVELS.join('|')})(?: degree)? in (?<field>[a-z][a-z -]{1,64})$`, 'iu')
const GIFT_QUESTION = /^what(?: gift| present)? did (?:i|we) (?:buy|get|purchase) for (?:my|our) (?<person>[\p{L} -]{1,34})['’]s (?<occasion>birthday|graduation|wedding|anniversary)(?: gift| present)?$/iu
const GIFT_OCCASION = String.raw`birthday|graduation|wedding|anniversary`
const GIFT_DONOR = String.raw`(?<giver>[\p{L}][\p{L} -]{0,33}?)`
const RECEIVED_GIFT_QUESTIONS = [
  new RegExp(String.raw`^what(?: gift| present)? did (?<owner>my|our) ${GIFT_DONOR} (?:give|gave|send|sent) (?<receiver>me|us) (?:as (?:a|an) (?<occasion>${GIFT_OCCASION}) (?:gift|present)|(?:for|on) (?<occasionOwner>my|our) (?<day>${GIFT_OCCASION}))$`, 'iu'),
  new RegExp(String.raw`^what (?<occasion>${GIFT_OCCASION}) (?:gift|present) did (?<actor>I|we) (?:get|receive) from (?<owner>my|our) ${GIFT_DONOR}$`, 'iu'),
  new RegExp(String.raw`^what(?: gift| present)? did (?<actor>I|we) (?:get|receive) from (?<owner>my|our) ${GIFT_DONOR} (?:for|on) (?<occasionOwner>my|our) (?<day>${GIFT_OCCASION})$`, 'iu'),
]
const GIFT_RELATION_NAMES = [['dad', 'father', 'daddy'], ['mom', 'mother', 'mum'], ['grandmother', 'grandma'], ['grandfather', 'grandpa']]
const GIFT_ALTERNATIVES = /\b(?:and|or|versus)\b/iu
const MISTAKEN_QUESTION = /^what(?: [a-z][a-z -]{0,35})? did (?:i|we) (?:(?:first|initially|originally) )?think was (?:(?:just|only|merely) )?(?<description>[\p{L} \d'-]{2,60})$/iu
const FIRST_PERSON = String.raw`\b(?:i|we)(?:['’]ve)?\s+(?:(?:just|recently|actually|already|also|finally|successfully)\s+){0,4}`
const PURCHASE_ACTION = new RegExp(FIRST_PERSON + String.raw`(?:bought|purchased|got)\s+`, 'iu')
const NONFACTUAL_CLAIM = /^\s*[>"“”‘]|\b(?:if|unless|suppose|imagine|might|maybe|would|could|wish(?:ed)?|planned?|planning|hypothetical|for example|in (?:a|my|the) (?:story|novel)|not|never)\b|n['’]t\b/iu
const GENERIC_PRESENT = /\b(?:gifts?|presents?|items?|things?|something)[.!]?$/iu
const escapePattern = text => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
const ADVICE_REQUEST = /(?:^|[.!;,:]\s*)(?:(?:any|do you have any)\s+(?:recommendations?|suggestions?|advice|tips?)\b|(?:can|could|would)\s+you\s+(?:please\s+)?(?:recommend|suggest|give (?:me|us) (?:some )?(?:advice|tips?))\b)/iu
const ADVICE_TARGET = /\b(?:for|on|about)\s+(?:my|our)\s+(?<topic>[\p{L}\p{N} -]{2,56})[.!]?\s*$/iu
const OWNED_TOPIC = /^(?:my|our)\s+(?<topic>[a-z][a-z'-]*(?:\s+[a-z][a-z'-]*){0,4}?)(?=['’]s\b|\s+(?:is|are|has|have|needs?|became|becomes?)\b)/iu
const ADVICE_FORMAT = new Set(['recipe', 'recipes', 'option', 'options', 'ideas', 'things', 'thing', 'again', 'soon', 'today', 'this', 'weekend'])
const ADVICE_BEHAVIOR = /(?:^|,\s*(?:and|so)\s+)(?:I|we)\s+(?:(?:also|usually|regularly|currently|always|only)\s+)*(?:use|have|own|make|prefer|like|avoid|keep|choose|need)\b|(?:^|,\s*(?:and|so)\s+)(?:I|we)(?:['’]ve|\s+have)\s+(?:been|started)\s+(?:using|making|keeping|choosing|avoiding)\b/iu
const ASKING_FOR_HELP = /^\s+(?:(?:some|your|a little|a bit of)\s+)?(?:help|advice|tips|recommendations|suggestions)\b/iu
const ADVICE_ACTIVE_STATE = /^(?:I|we)(?:['’](?:m|re)|\s+(?:am|are))\s+(?:(?:also|currently|still)\s+)?(?:using|having|experiencing|making|keeping|(?:looking|shopping|searching)\s+for)\b/iu
const VISIT_CONTEXT = /^(?:During|On)\s+(?:my|our)\s+(?:(?:previous|recent|last)\s+)?(?:visit|trip|stay)\s+(?:to|in)\s+(?<place>[^,;.!?]{1,80})[,;]/iu
const PERSONAL_IPHONE = /\b(?:on|with|for|using)\s+(?:my|our)\s+iPhone\b/iu
const UNRELATED_OWNER_OR_HISTORY = /\b(?:someone else|no longer|used to|last year|sold|gave away|borrowed|my (?:friend|partner|neighbor|colleague))\b|\b(?:you must|ignore prior|as an example)\b/iu
const ORGANIZATION_ADVICE = /\b(?:organi[sz](?:e|es|ed|ing|ation)|tid(?:y|ies|ied|ying)|(?:de)?clutter(?:ed|ing)?|mess(?:y)?|keep(?:ing)?\b[^.!?]{0,48}\bclean)\b/iu
const ORGANIZING_PURCHASE = /^(?<actor>I|we)\s+(?:(?:just|recently|already)\s+)?(?:bought|purchased)\s+(?:a|an|the)\s+(?:new\s+)?(?<item>[a-z][a-z-]{2,}(?:\s+[a-z][a-z-]{2,}){1,4})\s+to\s+(?<purpose>[^.!?]{3,100})[.!]?$/iu

export function adviceSourceQuestion(query) {
  const text = String(query).normalize('NFKC').trim().replace(/[?？]+$/u, '')
  if (/[?？\n]/u.test(text)) return null
  const chinese = /^(?<topic>我(?:想|正|最近|打算|的)[^。！？]{3,96})[，,。]\s*(?:有什么建议|有推荐吗|能推荐一下吗|给点建议)$/u.exec(text)?.groups.topic
  if (chinese) {
    const terms = recallSubjectTerms(chinese).slice(-2)
    return terms.length ? { adviceTopic: terms, searchQuery: terms.join(' '), language: 'zh' } : null
  }
  const request = ADVICE_REQUEST.exec(text)
  if (!request) return null
  const prefix = text.slice(0, request.index).trim()
  const target = ADVICE_TARGET.exec(text.slice(request.index))?.groups.topic ?? OWNED_TOPIC.exec(prefix)?.groups.topic
  if (!target && !/^(?:I|we)\b/iu.test(prefix)) return null
  if (target && /\b(?:and|or)\b/iu.test(target)) return null
  const terms = recallSubjectTerms(target ?? prefix).filter(term => !ADVICE_FORMAT.has(term))
  const adviceTopic = target ? terms : terms.slice(-1)
  if (!adviceTopic.length || adviceTopic.length > 5 || adviceTopic.at(-1).length < 4) return null
  const phone = adviceTopic.length === 1 && adviceTopic[0] === 'phone'
  return { adviceTopic, searchQuery: [...adviceTopic, ...(phone ? ['iphone'] : [])].join(' '), ...(phone ? { phone } : {}), language: 'en' }
}

function adviceEvidence(plan, text) {
  if (!isFactualStatement(text) || UNRELATED_OWNER_OR_HISTORY.test(text)) return false
  const matchesTopic = value => matchesAdviceTopic(plan, value)
  if (plan.language === 'zh') return matchesTopic(text) && /^我(?:平时|通常|一直|只|现在|已经|最近)?(?:用|喜欢|偏好|有|习惯|会用|做)/u.test(text)
  if (plan.phone && /^(?:I|we)\b/iu.test(text) && PERSONAL_IPHONE.test(text)) return true
  const owned = OWNED_TOPIC.exec(text)
  if (owned && matchesTopic(owned.groups.topic)) return true
  const visit = VISIT_CONTEXT.exec(text)
  if (visit && matchesTopic(visit.groups.place) &&
      /\b(?:I|we)\s+(?:enjoyed|liked|loved|prefer|love|had a great time|found)\b/iu.test(text.slice(visit[0].length))) return true
  const behavior = ADVICE_BEHAVIOR.exec(text) ?? ADVICE_ACTIVE_STATE.exec(text)
  if (!behavior) return false
  const claim = text.slice(behavior.index + behavior[0].length)
    .split(/[;；]|,\s*(?:(?:and|but|so)\s+)?(?:he|she|they|my|our)\b/iu, 1)[0]
  if (/\b(?:need|for)$/iu.test(behavior[0]) && ASKING_FOR_HELP.test(claim)) return false
  return matchesTopic(claim)
}

function matchesAdviceTopic(plan, text) {
  const words = tokenize(text)
  return words.some((_, index) => plan.adviceTopic.every((term, position) => words[index + position] === term))
}

export function receivedGiftQuestion(query) {
  const text = String(query).normalize('NFKC').trim().replace(/[?？]+$/u, '')
  for (const matcher of RECEIVED_GIFT_QUESTIONS) {
    const fields = matcher.exec(text)?.groups
    if (!fields || GIFT_ALTERNATIVES.test(fields.giver)) continue
    const owner = fields.owner.toLowerCase()
    const actor = owner === 'my' ? 'i' : 'we'
    const receiver = owner === 'my' ? 'me' : 'us'
    if ((fields.actor && fields.actor.toLowerCase() !== actor) || (fields.receiver && fields.receiver.toLowerCase() !== receiver) ||
        (fields.occasionOwner && fields.occasionOwner.toLowerCase() !== owner)) return null
    const giver = fields.giver.toLowerCase()
    const occasion = (fields.occasion ?? fields.day).toLowerCase()
    const names = GIFT_RELATION_NAMES.find(aliases => aliases.includes(giver)) ?? [giver]
    return { receivedGift: { names, occasion, owner, actor, receiver },
      searchQuery: [...names, occasion, 'gift present gave got received'].join(' ') }
  }
  return null
}

function receivedGiftBody(plan, text, answer = false) {
  if (!isFactualStatement(text)) return null
  const value = text.normalize('NFKC').replace(/[.!]+$/u, '').trim()
  const { names, occasion, owner, actor, receiver } = plan.receivedGift
  const possessive = answer ? 'your' : owner
  const donor = String.raw`${possessive}\s+(?:${names.map(escapePattern).join('|')})`
  const who = answer ? 'you' : actor
  const recipient = answer ? 'you' : receiver
  const article = String.raw`(?:(?:a|an)\s+)?`
  const context = String.raw`(?:as\s+${article}${occasion}\s+(?:gift|present)|(?:for|on)\s+${possessive}\s+${occasion})`
  const amount = String.raw`(?<item>[^,;!?]{2,90}?)`
  const opening = String.raw`^(?:(?:actually|by the way),\s*)?`
  const sent = String.raw`${donor}\s+(?:gave|sent)\s+${recipient}\s+${amount}`
  const received = String.raw`${who}(?:['’]ve|\s+have)?\s+(?:(?:actually|recently|just)\s+)*(?:got|received)\s+${amount}`
  const tail = answer ? '' : String.raw`(?:\s+(?:today|yesterday|last (?:weekend|week|month|year)))?(?:,\s+(?:and\s+(?:it|I|we|that)|which)\b[^;!?]{1,100})?`
  const variants = [
    String.raw`${sent}\s+${context}`,
    String.raw`${context},\s*${sent}`,
    received + String.raw`\s+as\s+${article}${occasion}\s+(?:gift|present)\s+from\s+${donor}`,
    received + String.raw`\s+from\s+${donor}\s+${context}`,
  ]
  if (answer) variants.push(sent, received + String.raw`\s+from\s+${donor}`)
  for (const variant of variants) {
    const item = new RegExp(opening + variant + tail + '$', 'iu').exec(value)?.groups.item
    if (!item || GENERIC_PRESENT.test(item) || GIFT_ALTERNATIVES.test(item) || /\b(?:from|for|on|gave|gift|present)\b/iu.test(item)) continue
    return item
  }
  return null
}

export function receivedGiftItem(plan, quote) {
  return plan.receivedGift ? receivedGiftBody(plan, quote) : null
}

function giftItemKey(text) {
  return String(text ?? '').normalize('NFKC').trim().toLowerCase().replace(/[.!]+$/u, '')
    .replace(/^(?:a|an|the|my|our|your)\s+/u, '').replace(/[-\s]+/gu, ' ')
}

export function receivedGiftAnswer(plan, answer, quotes) {
  const items = new Set(quotes.map(quote => giftItemKey(receivedGiftItem(plan, quote))).filter(Boolean))
  if (items.size !== 1) return false
  const text = withoutEvidencePreface(String(answer ?? '').normalize('NFKC').replace(/[*_]/gu, '').trim())
  if (!isFactualStatement(text)) return false
  return items.has(giftItemKey(receivedGiftBody(plan, text, true) ?? text))
}

export function personalSourceQuestion(query) {
  const normalized = String(query).normalize('NFKC').trim().replace(/[?？]+$/u, '')
  const received = receivedGiftQuestion(normalized)
  if (received) return received
  const study = STUDY_QUESTION.exec(normalized)?.groups
  if (study) {
    const level = STUDY_LEVELS.find(pattern => new RegExp('^' + pattern + '$', 'iu').test(study.level))
    const words = [...study.field.matchAll(/[a-z]+/giu)].map(match => match[0])
    const field = [escapePattern(study.field), ...(words.length >= 2 && words.length <= 5 ? [words.map(word => word[0]).join('')] : [])]
    const wordsForDegree = String.raw`${level}(?:\s+degree)?\s+in\s+(?:${field.join('|')})\b`
    const institution = String.raw`[\p{L}\p{N}][^,;.!?]{0,64}?`
    const studyClaim = possessives => {
      const degree = String.raw`(?:(?:${possessives}|a|an|the)\s+)?${wordsForDegree}`
      return String.raw`(?:(?:completed|finished|earned)\s+${degree}\s+(?:at|from)\s+(?<place>${institution})(?=[,;.!?]|$)|graduated\s+from\s+(?<school>${institution})\s+with\s+${degree})`
    }
    return {
      claim: new RegExp(FIRST_PERSON + studyClaim('my|our'), 'iu'),
      studyAnswer: new RegExp(String.raw`\byou(?:['’]ve)?\s+(?:also\s+)?` + studyClaim('your'), 'iu'),
    }
  }
  const gift = GIFT_QUESTION.exec(normalized)?.groups
  if (gift) {
    return { occasion: new RegExp(String.raw`\bfor\s+(?:my|our)\s+${escapePattern(gift.person)}['’]s\s+${gift.occasion}\b`, 'iu') }
  }
  const mistaken = MISTAKEN_QUESTION.exec(normalized)?.groups
  if (mistaken) {
    return { claim: new RegExp(FIRST_PERSON + String.raw`(?:had|experienced|noticed|saw|bought|received|used)\s+[^,;.!?]{2,88}?,?\s+(?:(?:which|that)\s+)?(?:i|we)\s+(?:(?:first|initially|originally)\s+)?thought\s+was\s+(?:(?:just|only|merely)\s+)?${escapePattern(mistaken.description)}(?=\s*(?:[,.!?;]|$|but\b|before\b))`, 'iu') }
  }
  return null
}

function isFactualStatement(text) {
  return sourceSentences(text).length === 1 && !NONFACTUAL_CLAIM.test(text) && !/[?？]/u.test(text)
}

export function originalStudyInstitution(plan, text) {
  if (!plan.studyAnswer || !isFactualStatement(text)) return null
  const match = plan.claim.exec(text)
  const institution = match?.groups.place ?? match?.groups.school
  return institution && /^\p{Lu}/u.test(institution) ? institution : null
}

export function personalSourceEvidence(plan, text) {
  if (plan.adviceTopic) return adviceEvidence(plan, text)
  if (plan.receivedGift) return receivedGiftItem(plan, text) !== null
  if (plan.studyAnswer) return originalStudyInstitution(plan, text) !== null
  if (!isFactualStatement(text)) return false
  if (plan.claim) return plan.claim.test(text)
  const action = PURCHASE_ACTION.exec(text), context = plan.occasion.exec(text)
  if (!action || !context) return false
  const before = context.index < action.index
  if (before && !/^[,，\s]*(?:(?:i|we)\s+also\s*)?$/iu.test(text.slice(context.index + context[0].length, action.index))) return false
  const item = text.slice(action.index + action[0].length, before ? undefined : context.index)
    .replace(/^(?:her|him|them)\s+/iu, '').trim()
  return item.length > 2 && !GENERIC_PRESENT.test(item) && !/\bfor\b/iu.test(item)
}

export function sourceQuoteStartsAtSentence(ref, quote) {
  const start = ref.excerpt?.indexOf(quote) ?? -1
  return start >= 0 && (start === 0 ? ref.from === 0 : /[.。!！?？\n]\s*$/u.test(ref.excerpt.slice(0, start)))
}

/** A purchase can inherit its topic from a question about the same item in the same message. */
export function adjacentAdviceEvidence(plan, query, ref, quote) {
  if (!plan.adviceTopic || plan.language !== 'en' || !ORGANIZATION_ADVICE.test(query)) return false
  const purchase = ORGANIZING_PURCHASE.exec(quote)?.groups
  if (!purchase || !isFactualStatement(quote) || UNRELATED_OWNER_OR_HISTORY.test(quote) ||
      !ORGANIZATION_ADVICE.test(purchase.purpose) || /\b(?:his|her|their)\b/iu.test(purchase.purpose)) return false
  const sentences = sourceSentences(ref.excerpt)
  const question = sentences[sentences.indexOf(quote) - 1]
  const request = question && ADVICE_REQUEST.exec(question)
  if (!request || !question.endsWith('?') || !sourceQuoteStartsAtSentence(ref, question)) return false
  const context = question.slice(0, request.index)
  const actor = purchase.actor.toLowerCase()
  if (tokenize(context)[0] !== actor || NONFACTUAL_CLAIM.test(context) || UNRELATED_OWNER_OR_HISTORY.test(context) ||
      !ORGANIZATION_ADVICE.test(context) || !matchesAdviceTopic(plan, context)) return false
  const owner = actor === 'i' ? 'my' : 'our'
  const item = escapePattern(purchase.item).replace(/\s+/gu, '\\s+')
  return new RegExp('\\b' + owner + '\\s+' + item + '\\b', 'iu').test(question)
}

// Re-read only the exact range originally authorized by successful capture.
// This is turn-local evidence, never a new persisted fact or a model request.
export function sourceResolver(root, store, projectKey, now) {
  const lookup = recallTaskLookup(root), sources = new Map()
  const scopes = [{ scope: 'project', projectKey }]
  let remaining = 4
  return (item, candidates) => {
    const matches = new Map()
    for (const hit of candidates.slice(0, 6)) {
      const record = store.find(hit.record.id, scopes)
      if (!record || record.scope !== 'project' || record.projectKey !== projectKey ||
          record.status !== 'active' || record.revision !== hit.record.revision ||
          record.validFrom > now || (record.validTo != null && record.validTo <= now) ||
          record.evidenceRole !== 'user' || record.quoted || !record.captureTaskId ||
          !record.captureKey?.startsWith(record.captureTaskId + ':')) continue
      for (const ref of record.sourceRefs ?? []) {
        if (ref.role !== 'user' || ref.sourceKind !== 'user' ||
            !Number.isSafeInteger(ref.from) || ref.from < 0 || !Number.isSafeInteger(ref.to) ||
            ref.to <= ref.from || ref.to - ref.from > 240 || !ref.excerpt || looksSensitive(ref.excerpt)) continue
        const key = record.captureTaskId + '/' + ref.sourceId
        if (!sources.has(key)) {
          if (remaining <= 0) continue
          remaining--
          sources.set(key, readRecallSource(root, ref.sourceId, record.captureTaskId, projectKey, lookup))
        }
        const verified = sources.get(key)
        if (!verified) continue
        const {source, task} = verified
        if (!task.sourceGrants?.some(g => g.id === record.id && g.revision === record.revision &&
            g.hash === record.contentHash && g.sourceId === ref.sourceId && g.from === ref.from && g.to === ref.to)) continue
        if (source.sessionId !== ref.sessionId || (source.messageId ?? null) !== (ref.messageId ?? null) ||
            source.text.slice(ref.from,ref.to) !== ref.excerpt || analyzeUserMessageControls(source.text).noSaveDirective ||
            !task.segment?.entries?.some(e => e.sourceId === ref.sourceId && e.from <= ref.from && e.to >= ref.to)) continue
        const timing = sourceTimeReference(source)
        if (!sourceAvailableAt(timing, now)) continue
        const full = { ...record, content: ref.excerpt, sourceRefs: [{ ...ref, ...timing }] }
        const answersQuestion = item.personalQuestion
          ? /[.。!！?？\n]\s*$|^$/u.test(source.text.slice(0, ref.from)) && personalSourceEvidence(item.personalQuestion, ref.excerpt)
          : matchesRecallAttribute({record:full}, item.query, item.detail, item.entityTerms, item.quantity)
        if (answersQuestion) {
          matches.set(full.content, {...hit, record:full, sourceId:ref.sourceId})
        }
      }
    }
    return matches.size === 1 ? [...matches.values()][0] : null
  }
}
