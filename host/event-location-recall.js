import { estimateTokens } from './recall.js'
import { isRecallSourceStatement } from './source-passages.js'
import { sourceSentences } from './sentences.js'

const EN_TYPES = ['university', 'college', 'campus', 'laboratory', 'lab', 'building', 'hall', 'library', 'museum', 'research center', 'conference center', 'hospital', 'school', 'venue']
const ZH_TYPES = ['大学', '学院', '校区', '实验室', '展馆', '会场', '中心', '大楼', '图书馆', '博物馆', '医院', '学校']
const EN_QUERY = new RegExp(String.raw`^(?:(?:at|in) which (?<type>${EN_TYPES.join('|')})|where) did (?<actor>i|we) (?<verb>[a-z]+) (?<object>[^,;?<>]{2,100})$`, 'iu')
const ZH_QUERY = new RegExp(String.raw`^(?<actor>我|我们)(?:是)?在(?:哪[所个家间栋](?<type>${ZH_TYPES.join('|')})|哪里|何处)(?<verb>展示|演示|安装|测试|提交|举行|举办)(?:了)?(?<object>[^，；？?<>]{2,45}?)(?:的)?$`, 'u')
const PAST_ACTIONS = new Map(Object.entries({ present: 'presented|displayed|showcased', show: 'showed|displayed|presented',
  test: 'tested', install: 'installed|set up', submit: 'submitted|turned in', hold: 'held|hosted', host: 'hosted|held',
  demonstrate: 'demonstrated|demoed|showcased' }))
const EN_EVENT = '(?:workshop|conference|seminar|session|exhibition|demo|summit|briefing|meeting|fair)'
const EN_REFERENCE = new RegExp(String.raw`\b(?:my first (?:[a-z][a-z-]* ){1,4}${EN_EVENT}|${EN_EVENT} [a-z][a-z0-9]{1,10}-\d{2,8})\b`, 'giu')
const ZH_REFERENCE = /(?:我的首场|我的第一[场次届])[\p{Script=Han}]{2,16}?(?:研讨会|发布会|年会|会议|展览|讲座|大会|演示)|(?:会议|研讨会|展览|演示)\s*[A-Z][A-Z\d]{1,10}-\d{2,8}/gu
const NONFACT = /\b(?:if|unless|not|never|maybe|might|would|could|planned|planning|plan|supposed|tentative|imagined|heard|said|claimed|example|pretend)\b|(?:如果|假如|假设|不是|并非|计划|打算|原定|尚未|未曾|据说|转述|例如)|[<>]/iu
const MULTIPLE = /\b(?:and|or|before|after|when|why|which|where)\b|以及|并且|还是|之后|之前|另外|为什么|多少/iu
const PERSON_PREFIX = String.raw`(?:i|we)(?:['’]ve)?\s+(?:(?:have|had|actually|already|just|also|finally|recently)\s+){0,4}`
const NAME_WORD = String.raw`[\p{Lu}\p{N}][\p{L}\p{N}'’-]*`
const EN_PLACE_END = String.raw`(?=$|[.,;!?)]|\s+(?:on|over|for|during|while|when|where|in|at|and|after|before|last|this|today|yesterday)\b)`
const EN_REFERENCE_END = /^(?:$|[,.!;]|\s+(?:at|in|on|over|during|after|before|last|this|yesterday|today)\b)/iu
const EN_ATTENDANCE = new RegExp(String.raw`(?:^|,\s*)${PERSON_PREFIX}(?:attended|joined)\s+$`, 'iu')
const EN_EVENT_TRAVEL = new RegExp(String.raw`(?:^|,\s*)${PERSON_PREFIX}(?:been to|went to|traveled to|travelled to|visited)\s+(.+?)\s+to\s+(\w+)\s+$`, 'iu')
const PLACE_PATTERNS = new Map()
const normalize = text => text.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLowerCase()
const surface = phrase => normalize(phrase).replace(/^(?:the|a|an|my|our)\s+/u, '').replace(/\s+on it$/u, '')
const hanObject = phrase => normalize(phrase).replace(/[。！.!\s]+$/u, '')

export function eventLocationQuery(query) {
  const text = String(query ?? '').normalize('NFKC').trim().replace(/[？?]+$/u, '')
  const en = EN_QUERY.exec(text)
  const zh = en ? null : ZH_QUERY.exec(text)
  const match = en ?? zh
  if (!match || MULTIPLE.test(match.groups.object)) return null
  const { actor, object, type, verb } = match.groups
  const action = en ? PAST_ACTIONS.get(verb.toLowerCase()) : verb
  if (!action) return null
  return { language: en ? 'en' : 'zh', actor: actor.toLowerCase(), object: object.trim(), action,
    ...(type ? { type: type.toLowerCase() } : {}) }
}

function statements(record) {
  return sourceSentences(record.content).filter((quote, index) =>
    (index > 0 || record.sourceRefs[0].from === 0) && isRecallSourceStatement(quote) &&
    !/^["'“‘「『]/u.test(quote) && !NONFACT.test(quote))
}

function englishPlace(text, type) {
  const key = type ?? ''
  if (!PLACE_PATTERNS.has(key)) {
    const forms = (type ? [type] : EN_TYPES).map(words =>
      words.split(' ').map(word => '[' + word[0].toUpperCase() + word[0] + ']' + word.slice(1)).join(' '))
    const kind = '(?:' + forms.join('|') + ')'
    PLACE_PATTERNS.set(key, new RegExp(String.raw`^(?:[Tt]he )?(?<place>(?:${NAME_WORD}\s+){1,5}${kind}|${kind}\s+of\s+(?:${NAME_WORD}\s+){0,4}${NAME_WORD})${EN_PLACE_END}`, 'u'))
  }
  return PLACE_PATTERNS.get(key).exec(text.trim())?.groups.place ?? null
}

function chinesePlace(text, type) {
  const kind = type ?? ZH_TYPES.join('|')
  const match = new RegExp(String.raw`^[\p{L}\p{N}·]{2,24}?(?:${kind})(?!的|旁|边|门口|附属|对面)`, 'u').exec(text.trim())
  return match?.[0] ?? null
}

function namedEnglishPlaces(text, type) {
  const places = []
  let consumed = 0
  for (const token of text.matchAll(new RegExp(NAME_WORD, 'gu'))) {
    if (token.index < consumed || /^(?:At|In|The|It|Answer|You|I)$/u.test(token[0])) continue
    const place = englishPlace(text.slice(token.index), type)
    if (!place) continue
    consumed = token.index + place.length
    places.push(place)
  }
  return places
}

export function containsEventLocation(text, plan) {
  if (plan.language === 'en') return namedEnglishPlaces(text, plan.type).length > 0
  const kind = plan.type ?? ZH_TYPES.join('|')
  return new RegExp(String.raw`[\p{Script=Han}]{2,24}(?:${kind})`, 'u').test(text)
}

function actions(record, plan, pattern) {
  const found = []
  for (const quote of statements(record)) {
    if (plan.language === 'zh') {
      const match = pattern.exec(quote)
      if (!match || hanObject(match.groups.object) !== hanObject(plan.object)) continue
      const venue = match.groups.venue
      const reference = [...venue.matchAll(ZH_REFERENCE)].find(item =>
        item.index === 0 && /^(?:上|期间|时)?$/u.test(venue.slice(item[0].length)))
      const place = reference ? null : chinesePlace(venue, plan.type)
      if (reference || place === venue) found.push({ quote, reference: reference?.[0], place })
      continue
    }
    const match = pattern.exec(quote)
    if (!match || /\b(?:said|told|reported|that)\b|"/iu.test(quote.slice(0, match.index))) continue
    const objectAndPlace = quote.slice(match.index + match[0].length)
    for (const boundary of objectAndPlace.matchAll(/\s(?:at|during|in)\s+/giu)) {
      if (surface(objectAndPlace.slice(0, boundary.index)) !== surface(plan.object)) continue
      const venue = objectAndPlace.slice(boundary.index + boundary[0].length)
      const reference = [...venue.matchAll(EN_REFERENCE)].find(item =>
        item.index === 0 && EN_REFERENCE_END.test(venue.slice(item[0].length)))
      const localVenue = reference ? /^\s+(?:at|in)\s+(.+)$/iu.exec(venue.slice(reference[0].length))?.[1] : venue
      const places = localVenue && englishPlace(localVenue, plan.type) ? namedEnglishPlaces(localVenue, plan.type) : []
      if (reference || places.length) found.push({ quote, reference: reference?.[0], places })
    }
  }
  return found
}

function englishLinkedPlaces(lead, tail, type) {
  const namedVenue = /^\s+(?:(?:was|were)(?: actually)?(?: held)?|took place)\s+(?:at|in)\s+(.+)$/iu.exec(tail)
  const presentAt = /^\s+(?:at|in)\s+(.+)$/iu.exec(tail)
  const venue = lead.trim() === '' ? namedVenue?.[1] : EN_ATTENDANCE.test(lead) ? presentAt?.[1] : null
  if (venue) return englishPlace(venue, type) ? namedEnglishPlaces(venue, type) : []
  const travel = EN_EVENT_TRAVEL.exec(lead)
  if (!travel) return []
  const verb = travel[2].toLowerCase()
  const attendance = ['attend', 'join'].some(word => verb === word || verb.length === word.length + 1 &&
    [...verb].some((_, index) => verb.slice(0, index) + verb.slice(index + 1) === word))
  if (!attendance) return []
  const place = englishPlace(travel[1], type)
  return place && normalize(place) === normalize(travel[1].replace(/^the\s+/iu, '')) ? [place] : []
}

function linkedPlaces(record, plan, reference) {
  const en = plan.language === 'en', pattern = en ? EN_REFERENCE : ZH_REFERENCE
  return statements(record).flatMap(quote => {
    const facts = []
    for (const match of quote.matchAll(pattern)) {
      if (normalize(match[0]) !== normalize(reference)) continue
      const lead = quote.slice(0, match.index), tail = quote.slice(match.index + match[0].length)
      if (en) {
        for (const place of englishLinkedPlaces(lead, tail, plan.type)) facts.push({ quote, place })
      } else if (!lead.trim()) {
        const held = /^(?:在|于)(.+?)(?:召开|举办|举行)[。！.]?$/u.exec(tail)
        if (held) {
          const typed = chinesePlace(held[1], plan.type)
          if (typed === held[1]) facts.push({ quote, place: typed })
        }
      }
    }
    return facts
  })
}

export function retrieveEventLocation(index, plan, { projectKey, now, maxTokens, maxItems, scanLimit, skipCapture, accepts }) {
  if (maxItems < 2 || maxTokens < 1) return { scannedTokens: 0 }
  const en = plan.language === 'en'
  const pattern = en
    ? new RegExp(String.raw`\b${PERSON_PREFIX.replace('(?:i|we)', plan.actor)}(?:${plan.action})\s+`, 'iu')
    : new RegExp(String.raw`^${plan.actor}(?:是)?在(?<venue>.+?)(?:已经)?${plan.action}(?:了)?(?<object>.+)$`, 'u')
  const find = (search, maxTokens, match) => index.findEvidence([search], { projectKey, now, maxTokens,
    allMatches: true, distinctKey: (_query, hit) => hit.record.id, wholeSentences: true, acceptOriginal: true,
    match: (_query, hit) => {
      if (!accepts(hit)) return null
      const facts = match(hit.record)
      return facts.length ? { ...hit, facts } : null
    } })
  const rows = scan => scan.matches.flatMap(({ hit }) => hit.facts.map(fact => ({ hit, ...fact })))
  const primary = find(plan.object, scanLimit, record => actions(record, plan, pattern))
  const actionsFound = rows(primary)
  let scannedTokens = primary.tokens
  const refs = new Map(actionsFound.filter(action => action.reference).map(row => [normalize(row.reference), row]))
  if (primary.incomplete || refs.size !== 1) return { scannedTokens }
  const first = refs.values().next().value
  const secondary = find(first.reference, scanLimit - scannedTokens, record => linkedPlaces(record, plan, first.reference))
  scannedTokens += secondary.tokens
  const places = rows(secondary)
  const values = new Set([...actionsFound, ...places].flatMap(row => row.places ?? [row.place]).filter(Boolean).map(normalize))
  const second = places.find(row => row.hit.record.sourceRefs[0].sourceId !== first.hit.record.sourceRefs[0].sourceId)
  if (secondary.incomplete || values.size !== 1 || !second) return { scannedTokens }
  const valid = index.validateMany([first.hit, second.hit], projectKey, { now })
  if (valid.length !== 2) return { scannedTokens }
  const note = en ? 'Two original user statements refer to the same event. Cite the location only if both support it.'
    : '以下两处用户原话指向同一场活动。活动与地点均有依据时再回答。'
  const header = en ? 'Location supported by the two original statements: ' : '两段原话可核对的地点：'
  const injected = [first, second].map(row => ({ row, text: '- ' + row.quote, selectedQuote: row.quote }))
  const annotation = skipCapture ? (en ? ' Do not save this turn.' : '本轮不保存。') : ''
  const text = '<memory-context source="dsh-memory" note="' + note + annotation + '">\n' +
    header + second.place + '\n' + injected.map(item => item.text).join('\n') + '\n</memory-context>'
  if (estimateTokens(text) > maxTokens) return { scannedTokens }
  return { text, hits: valid, injected, complete: true, budgetOmitted: false, scannedTokens,
    eventLocation: { name: second.place, type: plan.type ?? null, language: plan.language } }
}

export function matchesEventLocationAnswer(answer, location) {
  answer = answer.normalize('NFKC')
  if (NONFACT.test(answer) || /\b(?:unknown|unclear|unverified|cannot|unsure)\b|无法|不确定|未知|缺少依据/iu.test(answer)) return false
  const expected = normalize(location.name)
  if (location.language === 'zh') {
    if (!normalize(answer).includes(expected)) return false
    const kind = location.type ?? ZH_TYPES.join('|')
    const rest = normalize(answer).replaceAll(expected, '')
    return !new RegExp(String.raw`[\p{L}\p{N}·]{2,24}(?:${kind})`, 'u').test(rest)
  }
  const values = new Set(namedEnglishPlaces(answer, location.type).map(normalize))
  return values.size === 1 && values.has(expected)
}
