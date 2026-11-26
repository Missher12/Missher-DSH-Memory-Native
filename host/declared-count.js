import { readDayCount } from './calendar-recall.js'
import { estimateTokens } from './recall.js'
import { sourceSentences, withoutEvidencePreface } from './sentences.js'
import { DEEP_RECALL_TOKEN_LIMIT, isRecallSourceStatement } from './source-passages.js'
import { explicitRememberText } from './user-controls.js'
import { tokenize } from './tokenize.js'
import { bookTitle, composeCount, countComponents } from './declared-count-components.js'

const POSSESSION = /^how many (?<measure>[\p{L}\p{N}'’ -]{1,62}?) do (?<actor>I|we) (?:currently |now )?(?<action>have|own|hold|keep|need|require)\b(?<scope>.*)$/iu
const REDEMPTION = /^how many (?<measure>[\p{L}\p{N}'’ -]{1,62}?) can (?<actor>I|we) redeem\b(?<scope>.*)$/iu
const INVENTORY = /^how many (?<measure>[\p{L}\p{N}'’ -]{1,62}?) are (?:currently )?(?<scope>(?:on|in)\s+(?:my|our)\s+.+)$/iu
const STOCK_QUESTION = /^how many (?<measure>[\p{L}\p{N}'’ -]{1,62}?) do (?<actor>I|we) (?:currently |now )?have (?:stocked(?: up)?|stored|kept) (?<location>.+)$/iu
const STOCK_LOCATION = /^(?<direction>in|on|at)\s+(?<owner>my|our|the|your)\s+(?<name>[\p{L}\p{N}'’ -]{2,72})$/iu
const STOCK_PLACEMENT = /\s+(?:(?:stocked(?: up)?|stored|kept)\s+)?(?<location>(?:in|on|at)\s+(?:my|our|the|your)\s+[\p{L}\p{N}'’ -]{2,78})$/iu
const STOCK_TIME = /\s+(?:right now|at the moment|currently|now|today)$/iu
const STOCK_CLAUSE = /(?:^|[;,–—]|(?<=\s)-(?=\s))\s*(?:(?:and\s+)?by the way,\s*)?(?=(?<actor>I|we)\b)/giu
const STOCK_BREAK = /\s+[-–—]\s+/u
const COUNT_HYPOTHETICAL = /\b(?:example|suppose|imagine|hypothetical(?:ly)?|if|assuming|pretend|script|scenario)\b/iu
const STOCK_OBJECT = /\b(?:some|most|all) of (?<owner>my|our) (?:fresh\s+)?(?<object>[\p{L}][\p{L}\p{N}'’ -]+?)(?:\s+from (?:my|our|the) [\p{L}\p{N}'’ -]+)?$/iu
const STOCK_PACKAGING = new Set(['dozen', 'pair', 'bag', 'box', 'pack', 'crate', 'carton', 'case', 'bundle'])
const STOCK_ANSWER = /^(?:(?:currently|now),?\s*)?(?<actor>you|I|we)(?:(?:['’]ve|\s+have)\s+got|\s+(?:(?:currently|now|still)\s+)*(?:have|keep|hold|own|got))\s*$/iu
const CHINESE = /^(?<actor>我们|我)(?:在(?<place>[^，。！？,;]{1,38}?))?(?:现在|目前|当前)?(?<action>拥有|存有|持有|需要|有)(?:多少|几)(?:个|块|台|条|张|本|件|名|份)?(?<measure>[\p{L}\p{N}·-]{1,38})$/u
const REMAINING = /^how many (?<measure>[\p{L}\p{N}'’ -]{1,48}?) (?:(?:do (?<actor>I|we) (?:still )?have|are(?: still)?) (?:left|remaining)|remain)(?: to (?<action>[a-z]+))?(?<scope>\s+(?:in|of|on|for|from) .{1,86})?$/iu
const PROGRESS_QUESTION = /^how many (?<measure>[\p{L}\p{N}'’ -]{1,55}?) have (?<actor>I|we) (?<action>completed|finished|written|added)(?: to (?<owner>my|our) collection)? since (?<activity>[^,;.!?]{4,86})$/iu
const SERIES_QUESTION = /^how many (?<measure>videos?|episodes?|lessons?|modules?|chapters?) (?:of|from|in) (?<name>[^,;.!?]{5,115}?) have (?<actor>I|we) (?:completed|finished)(?: so far)?$/iu
const SERIES_NAME = /^(?<author>[\p{L}][\p{L}'’.-]*(?:\s+[\p{L}][\p{L}'’.-]*){0,3})['’]s\s+(?:(?<topic>[\p{L}\p{N}'’+# -]{1,74}?)\s+)?(?<kind>series|serie|course|playlist)(?:\s+on\s+[\p{L}\p{N} -]{1,38})?$/iu
const SERIES_STUDY = /^(?<actor>I|we)(?:['’](?:ve|m|re)|\s+(?:have|am|are))\s+(?:been\s+)?(?:(?:brushing up|preparing)[^,;!?]{1,80}\bby\s+)?(?:watching|following|working through|taking)\s+(?<name>[^,;!?]{5,142})[.!]?$/iu
const SERIES_COUNT_SCOPE = /\s+(?:of|from|for|in|on)\s+/iu
const PROGRESS_START = /^(?:(?<actor>i|we|you)\s+)?(?<action>starting|beginning|joining|started|began|joined)\s+(?<activity>.+)$/iu
const PROGRESS_CLAIM = /^(?<actor>i|we|you)(?:['’]ve|\s+have)?\s+(?:(?:already|just|recently|now)\s+){0,2}(?<action>completed|finished|written|wrote|added)\s+(?<amount>.+)$/iu
const COLLECTION_REALIZED = /^(?<actor>i|we|you)(?: just)? realized (?:that )?(?=\k<actor>(?:['’]ve|\s+have)\s+added\b)/iu
const COLLECTION_OWNER = /\s+to\s+(?<owner>my|our|your)\s+collection$/iu
const PROGRESS_GAP = /\b(?:skip(?:ped|ping)?|(?:still (?:have|need) to|(?:haven|hadn|didn)['’]t)\s+(?:start|finish|complete)|(?:finished|completed)\s+(?:none|only (?:some|part))\s+of)\s+(?:(?:the|my|our|your)\s+)?(?:first|earlier|previous|preceding)\b/iu
const CHINESE_REMAINING = /^(?:我(?:们)?(?:在)?)?《(?<title>[^《》\n]{1,60})》(还剩|还有|剩下)(?:多少|几)(?<measure>页|章|节)(?:没读|未读|要读)?$/u
const AGE_AT_EVENT = /^how old (?:(?<past>was|were) (?<person>I|we|[\p{L}][\p{L}'’-]*(?: [\p{L}][\p{L}'’-]*){0,2})|will (?<futurePerson>I|we|[\p{L}][\p{L}'’-]*(?: [\p{L}][\p{L}'’-]*){0,2}) be) when (?<event>[^\n,;]{6,122})$/iu
const ELAPSED_SPAN = /^how many (?<measure>seconds|minutes|hours|days|weeks|months|years) in total did (?<actor>I|we) spend(?<activity>[^\n,;]{0,80}?) from (?<start>[^\n,;]{2,80}?) (?:to|through) (?<end>[^\n,;]{2,85})$/iu
const SPAN_BOUNDS = /\bfrom (?<start>[^,;!?\n]{2,90}?) (?:to|through) (?<end>[^,;!?\n]{2,100})$/iu
const SPENT_TOTAL = /\b(?:I|we) (?:(?:actually|already) )?(?:spent|have spent) (?:a total of |exactly )?$/iu
const REMAINING_PREFIX = /\b(?:there (?:are|is)|I['’]ve (?:still )?got|we['’]ve (?:still )?got)(?: exactly)?\s*$/iu
const REMAINING_TAIL = /^(?:left|remaining|remain|to go)\b/iu
const REMAINING_CONTEXT = /^(?:(?:left|remaining|remain|to go)\s*)?(?:to (?<action>[a-z]+)\s*)?(?:(?:in|of|on|for|from) (?<scope>.+))?$/iu
const PAST_PROGRESS = /\b(?:already (?:read|finished|completed|processed)|read so far|total (?:length|pages)|per (?:day|week)|each (?:day|week))\b|已经(?:读|看|完成)|共(?:有|计)|总共/iu
const PARTIAL_SPAN = /\b(?:excluding|except for|not including|a portion of|only the last|only the first)\b/iu
const ANSWER_SUBJECT = /^(?:(?:he|she|they|someone|my (?:friend|sister|brother))\s+(?:was|were|is|are|turned)\b)/iu
const NON_SCALAR = /\b(?:both|all|combined|in total|total for|altogether|each|before|after|previously|used to|last|until|since|between|across|have left|extra|more|fewer|already spent|times?|seconds?|minutes?|hours?|days?|weeks?|months?|years?|ago)\b|一共|合计|之前|去年|上周|以前|还剩|还需|每|和|或者/iu
const FILLER = new Set(['at', 'any', 'in', 'on', 'for', 'the', 'a', 'an', 'my', 'our', 'with', 'currently', 'now', 'right', 'so', 'far'])
const GROUP_LIMIT = /\b(?:not|never|no longer|plan(?:ned|ning)?|want(?:ed)?|consider(?:ing)?|would|could|will|should|if|might|may|maybe|possibly|approximately|almost|around|about|more than|less than|at least|at most|previously|used to|before|after|example)\b|计划|准备|预计|打算|也许|大约|至少|至多|左右|不到|不超过|可能|假如|并非|不是|没有|以前|已经不|不再|虚构/u
const INDIRECT_REPORT = /^(?:["“'>]|["‘])|\b(?:said|quoted|claimed|heard|thought|guessed|think)\b|转述|听说|我想可能/iu
const UNIT_CONTINUATION = new Set(['at', 'by', 'for', 'from', 'in', 'on', 'to', 'of', 'with', 'remaining', 'available', 'while', 'and', 'so', 'as', 'currently', 'now', 'a', 'an'])
const NUMBER = String.raw`\d{1,3}(?:,\d{3})+|\d+|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|(?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:[- ](?:one|two|three|four|five|six|seven|eight|nine))?|single`
const EXACT_COUNT = new RegExp(String.raw`^(?:${NUMBER}|[零一二两三四五六七八九十]+)$`, 'iu')
const WRITING_UNITS = /^(?:story|novel|essay|poem|article|draft|script|chapter|scene|post|page)$/u
const WRITING_STATUS = new RegExp(String.raw`^(?:(?:also|by the way),\s*)?(?<actor>I|we)(?:['’]ve|\s+have)\s+been\s+writing regularly\s+for\s+(?:${NUMBER})\s+(?:days|weeks|months|years)(?:\s+now)?(?:,\s+and (?:it['’]s|it has) been\s+(?:(?:really|very|quite|so)\s+)?[\p{L}-]{2,22})?\s+[-–—]\s+(?<claim>.+)$`, 'iu')
const WRITING_START_REFERENCE = /\s+since\s+(?<actor>I|we)\s+started[.!]*$/iu
const WRITING_MANAGED = /^(?<actor>I|we|you)(?:['’]ve|\s+have)\s+(?:even\s+)?managed to (?:complete|finish|write)\s+/iu
const WRITING_GOAL_TOPIC = /^(?:(?:speaking of which|by the way),\s*)?(?:I was wondering,\s*)?(?:do you think (?:it['’]s|it is) a good idea to|should I|could I|can I) (?:set|have|choose) a goal for (?:a certain number of|how many) (?<object>[^?,;.!\n]{2,73}?)\s+per (?:day|week|month|year)\?$/iu
const WRITING_BARE_TOTAL = new RegExp(String.raw`^(?<actor>I|we)(?:['’]ve|\s+have)\s+written\s+(?<amount>${NUMBER})\s+so far\s+since (?<activity>[^,;.!?]+)[.!]*$`, 'iu')
const SPECIES_QUESTION = /^how many (?:(?:different|distinct) )?species of birds have (?<actor>I|we) (?:seen|spotted|observed) (?<place>(?:in|at) [^,;!?]{2,80}?)(?: so far)?$/iu
const BIRD_LIST_TOPIC = /^(?:birds?|bird identification|birding|bird[- ]?watching)$/iu
const BIRD_SUBGROUP_TOPIC = /^(?:woodpeckers?|waterbirds?|shorebirds?|warblers?|sparrows?|nuthatches?)$/iu
const SPECIES_TOPIC = /^(?:by the way,\s*)?speaking of (?<topic>[^,;!?]{2,60}),\s*/iu
const SPECIES_TRACK = /^(?<actor>I|we)(?:['’]ve been|\s+have been)\s+(?:tracking|recording|keeping track of) (?<all>all )?(?:the )?species(?: of (?<topic>[\p{L} -]{2,35}?))? (?<observer>I|we)(?:['’]ve|\s+have)? (?:seen|spotted|observed) (?<place>(?:in|at) [^,;!?]{2,80})(?=,|$)/iu
const SPECIES_OBSERVED = /^(?<actor>I|we|you)(?:(?:['’]ve|\s+have)\s+(?:already\s+)?|\s+)(?:managed to spot|seen|saw|spotted|observed|recorded) (?<count>.+?)(?: (?<place>(?:in|at) [^,;!?]{2,80}?))?(?: so far)?$/iu
const SPECIES_AMOUNT = new RegExp(String.raw`^(?<amount>${NUMBER})\s+(?:(?:different|distinct|total)\s+)?(?:(?<prefix>[\p{L}-]{2,26})\s+species|species(?: of (?<group>[\p{L} -]{2,45}?))?)(?:\s+so far)?$`, 'iu')
const SPECIES_UPDATE = new RegExp(String.raw`^(?<actor>I|we) (?:just |recently )?(?:saw|spotted|observed) (?:a |an |the )?[^,;!?]{2,70}? (?<place>(?:in|at) (?:my|our|the) [^,;!?]{2,72}?)(?: (?:last (?:weekend|week)|yesterday|earlier today|this morning))?, which (?:brings|takes) (?<owner>my|our) total (?<unit>bird species|species of birds|species) count to (?<amount>${NUMBER})$`, 'iu')

const MEASURED_COUNT = new RegExp(String.raw`^(?<value>${NUMBER})\s+(?<units>.+)$`, 'iu')
const PROGRESS_MILESTONE = /^(?<owner>my|our|your)\s+(?<value>[1-9]\d{0,5}(?:st|nd|rd|th)|(?:(?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)[ -])?(?:first|second|third|[a-z]+th))\s+(?<units>.+)$/iu
const EN_COUNT = new RegExp(String.raw`(?<![\p{L}\p{N}.,$£€-])(?<number>${NUMBER})\s+(?=[a-z])`, 'giu')
const EQUATION_TERM = new RegExp(String.raw`(?:^|[:：]|\b(?:is|are|equals))\s*(?<number>${NUMBER})$`, 'iu')
const AGE_NUMBER = String.raw`(?<number>${NUMBER})(?![\w.-])`
const CARDINALS = { first: 'one', second: 'two', third: 'three', fifth: 'five', eighth: 'eight', ninth: 'nine', twelfth: 'twelve' }
const HAN_COUNT = /(?<![\d一二两三四五六七八九十零百千.])(?<number>\d+|[零一二两三四五六七八九十]+)\s*(?:个|块|台|条|张|本|件|名|份)?/gu
const OWN = /\b(?:I|we)(?:['’]ve(?:\s+(?:already|currently|now|just|still|recently))?\s+(?:got|reached|collected)|(?:\s+(?:already|currently|now|still|actually|just|recently)){0,3}\s+(?:have|own|hold|keep|got))(?:\s+(?:got|now|currently|in total|exactly|a total of))*\s*$/iu
const NEED = /\b(?:(?:I|we)\s+(?:(?:actually|now|currently|still|just)\s+)*(?:need|require)|(?:requires?|needs?|required))\s+(?:exactly\s+|a total of\s+)?$/iu
const REDEEM = /\b(?:I|we)(?:['’]ve|\s+have)?\s+(?:(?:currently|already|now|actually)\s+)*(?:can redeem|qualif(?:y|ied)\s+for|(?:accumulated|earned|have)\s+enough\s+(?:reward\s+)?points\s+for)\s+(?:a\s+)?$/iu
const LOCATION = /\b(?:has|have|contains?|holds?|includes?)\s+(?:exactly\s+)?$/iu
const INVENTORY_OWNER = /^(?:(?:oh|actually),?\s*|by the way,\s*)?(?:my|our)\s/iu
const OWN_CN = /^(?:我们|我)(?:(?:在[^，。！？]{1,38}?)|现在|当前|目前|一共|共有)*(?:存有|持有|拥有|有)\s*$/u
const NEED_CN = /^(?:我们|我)(?:(?:在[^，。！？]{1,38}?)|现在|当前|目前|一共)*(?:需要|需)\s*$/u
const ANSWER_LIMIT = /\b(?:unknown|no (?:evidence|record|information)|not enough|cannot|can't|not|uncertain|maybe)\b|不清楚|不确定|不知道|无依据|未知|没(?:有|找到)|不是|不能|无法/iu
const ANSWER_OWNS = /\b(?:have|hold|earned|balance)\b|余额|已(?:经)?有|持有|拥有|(?:你|您)(?:现在|目前)?有/iu
const ANSWER_NEEDS = /\b(?:need|required?|requirement)\b|需要|必须/iu
const ANSWER_REDEEMS = /\bredeem\b|兑换|换取/iu
const CLAIMED_RANGE = /\bfrom\b.+\b(?:to|through)\b/iu
const EDUCATION_PERIOD = /\bfrom\s+(?<from>[12]\d{3})\s+(?:to|through)\s+(?<to>[12]\d{3})\b/iu
const EDUCATION_FINISH = /\b(?:completed|finished|graduated with|earned)\b.+?\bin\s+(?<year>[12]\d{3})\b/iu
const TOTAL_COUNT_CLAIM = /\b(?:total(?:s|led)?|altogether|add(?:s|ing)? up to|sum)\b|总共|一共|合计/iu
const QUALIFIED_COUNT_PREFIX = /\b(?:about|almost|around|approximately|roughly|over|under|more than|less than|fewer than|at most)\s*$|(?:大约|约|差不多|不到|高于|多于|低于|少于|至多|不超过)\s*$/iu
const PARTIAL_COUNT_PREFIX = /\b(?:hundred|thousand|million|billion|trillion)(?:\s+and)?\s*$/iu
const RANGE_COUNT_PREFIX = /\b(?:between\s+(?:[\w,.-]+\s+){1,5}and|\d[\d,.]*\s+(?:to|or))\s*$|[\d一二两三四五六七八九十](?:到|至|或)\s*$/iu
const MINIMUM_COUNT_PREFIX = /\bat least\s*$|至少\s*$/iu
const QUALIFIED_COUNT_SUFFIX_ZH = /^\s*(?:左右|上下|出头|以上|以下|或更多|或更少)/u
const ANSWER_COUNT_UNIT_TRANSLATIONS = new Map([
  ['page', ['页']],
  ['year', ['年']],
  ['guest pass', ['嘉宾通行证', '来宾通行证', '宾客通行证', '客座通行证', '访客通行证', '来访者通行证', '客人通行证']],
])
const TOPIC = /^(?:(?:and\s+)?by the way,\s*)?speaking of (?:my|our|the)\s+(?<subject>[^,;!?]{1,62}),\s*/iu
const CORRECTION = /^(?:actually|correction|to correct myself|I meant|I misspoke)[,:\s]+/iu
const NEGATED_AMOUNT = /,\s*(?:not|rather than)\s+(?:\d{1,3}(?:,\d{3})+|\d+)[.!\s]*$/iu
const AUDIENCE_MEASURE = /^(?<name>[\p{L}\p{N}'’ -]{1,48})\s+(?<unit>followers|subscribers)$/iu
const TRIED_QUESTION = /^how many (?<collection>of\s+)?(?<measure>[\p{L}\p{N}'’ -]{2,72}?) have (?<actor>I|we) tried(?: out)?(?<venue>\s+(?:in|at|on)\s+[^,;!?]{2,70}?)?(?: so far)?$/iu
const TRIED_CLAIM = /^(?:(?:also|by the way|actually),\s*)*(?<actor>I|we|you)(?<perfect>['’]ve|\s+have)?\s+(?:already\s+)?tried(?: out)?\s+(?<count>.+)$/iu
const TRIED_SUBTOTAL = /\b(?:recently|lately|earlier|today|yesterday|during|per|each|every|excluding|except for|since|this (?:week|month|year)|last (?:week|month|year))\b/iu
const TRIED_COLLECTION = /^(?:(?:also|by the way),\s*)*(?<actor>I|we)(?:['’]ve|\s+have)\s+been (?:loving|following|browsing|using)\s+(?<objects>[^,;!?]{2,100}?)(?: on (?:her|his|their) (?:channel|website))?[.!]?$/iu
const TRIED_READER_TOPIC = /^(?:by the way,\s*)?(?:have you tried|did you try)(?: out)?\s+(?:any\s+)?(?:good\s+)?(?<objects>[^,;!?]{2,100}?)(?:\s+(?:lately|recently))?\?$/iu
const THRESHOLD_SCOPE = /^\s+(?<goal>to\s+.+?)\s+(?:on|in|at)\s+(?<name>.+)\s*$/iu
const THRESHOLD_INTENT = /^(?<actor>I|we)(?:['’](?:m|re)|\s+(?:am|are))\s+(?:(?:actually|currently)\s+)?(?:trying|aiming|working)\s+(?<purpose>to .+)$/iu
const THRESHOLD_UNITS = /^which\s+(?:I|we)\s+know\s+requires?\s+a certain number of\s+(?<units>[\p{L}\p{N}'’ -]{1,62})$/iu
const THRESHOLD_QUESTION = /^(?:can|could|would) you (?:tell|remind) (?<owner>me|us) how many (?<units>[\p{L}\p{N}'’ -]{1,62}) (?<actor>I|we) (?:need|require) (?<purpose>to [^?!,;]+)\?$/iu
const REQUIRED_UPDATE = /^(?<actor>I|we)\s+(?:(?:actually|now|currently|still|just)\s+)*(?:need|require)\s+(?:exactly\s+)?/iu
const CHECKED_SCOPE = /^(?<actor>I|we)\s+(?:(?:just|recently|now)\s+)?(?:checked|reviewed|opened|looked at)\s+(?<owner>my|our|the)\s+(?<name>[^,;!?.]{2,90})[.!]?$/iu
const CHECKED_SCOPE_ZH = /^(?<actor>我们|我)(?:刚刚|刚|已经|已)?(?:核对了|查看了|检查了|打开了)\s*(?:自己(?:的)?|我的|我们的)?(?<name>[^，,；;。！？]{2,40}?)的(?:库存|账户|数据)[。！]?$/u
const PERSONAL_AUDIENCE = /^(?<actor>I|we)(?:['’](?:m|re)|\s+(?:am|are)) trying to (?:increase|grow|build|improve) (?<owner>my|our) (?:social media presence|audience|following)[.!]?$/iu
const AUDIENCE_REQUEST = /^(?:can|could|would) you help (?<owner>me|us)\b(?<request>[^?？]{0,150})\b(?:content|posts?|promotion|campaign)\s+(?:on|for)\s+(?<name>[^,;.!?？]{2,64})[?？]$/iu
const SCOPE_ALTERNATIVES = /\b(?:and|or|versus)\b/iu
const CHECKED_OBSERVATION = /^(?:by the way,\s*)?(?:I|we)\s+(?:just|recently)\s+(?:checked|counted|confirmed)\s+and\s+/iu
const NOW_AT_COUNT = /\b(?:I|we)(?:['’](?:m|re)|\s+(?:am|are))\s+(?:now|currently)\s+at\s*$/iu
const COUNT_COMMENT = /,\s*which\s+(?:is|was)\s+(?:an?\s+)?(?:[a-z]+\s+){0,5}(?:milestone|improvement|surprise)[.!]?$/iu
const QUOTED_COUNT_FRAME = /\b(?:example|script|transcript|quotation|demo|test input)\b[^:：.!?]{0,48}[:：]$|(?:脚本|样例|示例|测试输入|引用|对白)[^：:。！？]{0,24}[：:]$/iu
const AUDIENCE_ANSWER_SCOPES = [
  /\b(?:followers?|subscribers?)\s+(?:on|in|for)\s+([^,;.!?]+)/giu,
  /^(?:on|in|for)\s+([^,;.!?]{1,72}),?\s+(?=(?:you|your|i|we)\b)/giu,
  /\b(?:your|my|our)\s+([^,;.!?]{1,72}?)\s+(?:account|channel|profile)\s+(?=(?:(?:now|currently)\s+)?(?:has|shows|reports|is)\b)/giu,
]

function unitTerms(text) {
  return tokenize(text.replace(/(\p{L})['’]s\b/gu, '$1')).map(term => term
    .replace(/ies$/u, 'y').replace(/(ch|sh|x|ss|zz)es$/u, '$1').replace(/(?<!s)s$/u, ''))
}

function normalizeScope(text) {
  return unitTerms(text).filter(term => !FILLER.has(term))
}

function stockUnits(text) {
  const units = unitTerms(text)
  if (STOCK_PACKAGING.has(units[0]) && units[1] === 'of') units.splice(1, 1)
  return units
}

function stockScope(location, actor, answer = false) {
  const match = STOCK_LOCATION.exec(location.trim())?.groups
  if (!match || SCOPE_ALTERNATIVES.test(match.name)) return null
  if (!['the', actor === 'we' ? 'our' : 'my', ...(answer ? ['your'] : [])].includes(match.owner.toLowerCase())) return null
  return [match.direction.toLowerCase(), ...normalizeScope(match.name).map(word => word === 'fridge' ? 'refrigerator' : word)]
}

function accountDescriptor(word) {
  return ['account', 'channel', 'profile'].includes(word)
}

function audienceScope(text) {
  return normalizeScope(text.replace(/^\s*(?:your|my|our|the)\s+/iu, ''))
}

function matchesAudienceScope(observed, required) {
  if (observed.join(' ') === required.join(' ')) return true
  return accountDescriptor(observed.at(-1)) && observed.slice(0, -1).join(' ') === required.join(' ')
}

function eventTerms(text) {
  return normalizeScope(text.replace(/\b(?:i|we|me|us|her|his|their|was|were|be)\b/giu, ' '))
}

function namesAgeEvent(text, plan) {
  const words = eventTerms(text)
  return plan.scope.every(term => words.includes(term)) && !/\b(?:and|or|but)\b/iu.test(text)
}

function namesSpan(text, plan, answer = false) {
  const bounds = SPAN_BOUNDS.exec(answer ? text.replace(/\byour\b/giu, 'my') : text)?.groups
  return Boolean(bounds && !PARTIAL_SPAN.test(text) &&
    plan.boundaries.every((words, index) => containsUnits(normalizeScope(index === 0 ? bounds.start : bounds.end), words)))
}

function progressScope(value, actor, answer = false) {
  const boundary = PROGRESS_START.exec(value)?.groups
  if (!boundary || SCOPE_ALTERNATIVES.test(boundary.activity) || NON_SCALAR.test(boundary.activity)) return null
  const statedActor = boundary.actor?.toLowerCase()
  const action = boundary.action.toLowerCase()
  if (Boolean(statedActor) === action.endsWith('ing') ||
      (statedActor && statedActor !== actor && !(answer && statedActor === 'you'))) return null
  const activity = normalizeScope(boundary.activity.replace(/^to write regularly$/iu, 'writing regularly'))
  return activity.length ? [action.startsWith('join') ? 'join' : 'start', ...activity] : null
}

function seriesName(text) {
  const matched = SERIES_NAME.exec(text.replace(/[.!]+$/u, '').trim())?.groups
  if (!matched || SCOPE_ALTERNATIVES.test(matched.topic ?? '')) return null
  return {
    author: tokenize(matched.author),
    topic: tokenize(matched.topic ?? ''),
    kind: matched.kind.toLowerCase().replace(/^serie$/u, 'series'),
  }
}

function scopedCountQuery(text) {
  const species = SPECIES_QUESTION.exec(text)?.groups
  if (species && !NON_SCALAR.test(species.place)) {
    const actor = species.actor.toLowerCase()
    const scope = stockScope(species.place, actor)
    if (scope?.length > 1) return { language: 'en', role: 'observed-species', actor, scope,
      measure: 'species of birds', units: ['species', 'bird'], search: ['bird species', ...scope.slice(1), 'observed tracking total'].join(' ') }
  }
  const stock = STOCK_QUESTION.exec(text)?.groups
  if (stock && !NON_SCALAR.test(stock.measure) && !NON_SCALAR.test(stock.location)) {
    const actor = stock.actor.toLowerCase(), units = stockUnits(stock.measure), scope = stockScope(stock.location, actor)
    if (scope?.length > 1 && units.length && units.length <= 8) return {
      language: 'en', role: 'stock', actor, measure: stock.measure, units, scope,
      search: [...units, ...scope.slice(1), ...(scope.includes('refrigerator') ? ['fridge'] : []), 'stocked stored'].join(' '),
    }
  }
  const seriesQuestion = SERIES_QUESTION.exec(text)?.groups
  if (seriesQuestion) {
    const series = seriesName(seriesQuestion.name)
    if (series?.author.length >= 2 && series.topic.length && !NON_SCALAR.test(seriesQuestion.name)) return {
      language: 'en', role: 'series', actor: seriesQuestion.actor.toLowerCase(),
      measure: seriesQuestion.measure, units: unitTerms(seriesQuestion.measure), series, scope: [],
      search: [seriesQuestion.measure, ...series.author, ...series.topic, series.kind, 'completed finished'].join(' '),
    }
  }
  const progress = PROGRESS_QUESTION.exec(text)?.groups
  if (progress && !NON_SCALAR.test(progress.measure)) {
    const { measure, activity } = progress
    const actor = progress.actor.toLowerCase()
    const scope = progressScope(activity, actor)
    const action = progress.action.toLowerCase()
    const writing = action === 'written'
    const collection = action === 'added'
    if (progress.owner && (!collection || progress.owner.toLowerCase() !== (actor === 'we' ? 'our' : 'my'))) return null
    if (collection && (scope?.[0] !== 'start' || scope?.[1] !== 'collecting')) return null
    const units = unitTerms(measure)
    const writingScope = scope?.join(' ') === 'start writing regularly' && WRITING_UNITS.test(units.at(-1) ?? '')
    if (scope && units.length && units.length <= 7 && (!writing || writingScope)) return {
      language: 'en', role: 'progress', actor, measure, units, scope,
      ...(writing ? { writing } : {}), ...(collection ? { collection } : {}),
      search: [measure, ...scope.slice(1), collection ? 'added collection' : writing ? 'finished completed written' : 'finished completed'].join(' '),
    }
  }
  const remaining = REMAINING.exec(text)
  if (remaining && !/\b(?:and|or|either|both|before|after|last)\b/iu.test(text)) {
    const { measure, actor, action, scope: location = '' } = remaining.groups
    const name = location.replace(/^\s+(?:in|of|on|for|from) /iu, '')
    const scope = normalizeScope(name), units = unitTerms(measure)
    const title = units.join(' ') === 'page' && (!action || /^read$/iu.test(action)) && scope.length ? bookTitle(name) : null
    return { language: 'en', role: 'remaining', measure, units, actor: actor?.toLowerCase() ?? null,
      scope, action: action?.toLowerCase(), ...(title ? { title } : {}), search: [measure, ...scope, 'left', 'remaining'].join(' ') }
  }
  const chinese = CHINESE_REMAINING.exec(text.replace(/\s+/gu, ''))
  if (chinese) {
    const { title, measure } = chinese.groups
    return { language: 'zh', role: 'remaining', measure, scope: [title], search: `${title} 还剩 ${measure}` }
  }
  const age = AGE_AT_EVENT.exec(text)
  if (age && !/\b(?:and|or|unless|if)\b/iu.test(age.groups.event)) {
    const { person, futurePerson, event } = age.groups
    const actor = (person ?? futurePerson).toLowerCase()
    const scope = eventTerms(event)
    if (scope.length) return { language: 'en', role: 'age-at-event', measure: 'years old', actor, scope,
      prospective: Boolean(futurePerson), search: [...scope, 'birthday', 'years old', actor].join(' ') }
  }
  const span = ELAPSED_SPAN.exec(text)
  if (span) {
    const { measure, actor, activity, start, end } = span.groups
    const boundaries = [normalizeScope(start), normalizeScope(end)]
    const scope = normalizeScope(activity)
    const educationYears = measure.toLowerCase() === 'years' && scope.includes('education')
    if (boundaries.every(words => words.length)) return { language: 'en', role: 'completed-span', measure,
      actor: actor.toLowerCase(), units: unitTerms(measure), scope, boundaries,
      ...(educationYears ? { educationYears: true } : {}),
      search: [measure, ...scope, ...boundaries.flat(), ...(educationYears ? ['attended studied enrolled college university'] : [])].join(' ') }
  }
  return null
}

export function declaredCountQuery(query) {
  const text = String(query ?? '').normalize('NFKC').trim().replace(/[?？。]+$/u, '')
  if (/[<>\n]/u.test(text)) return null
  const scoped = scopedCountQuery(text)
  if (scoped) return scoped
  const tried = TRIED_QUESTION.exec(text)?.groups
  if (tried?.collection || tried?.venue) {
    const { measure, venue } = tried
    const objects = (measure + (venue ?? '')).trim()
    if (!SCOPE_ALTERNATIVES.test(objects) && !TRIED_SUBTOTAL.test(objects)) {
      return { language: 'en', role: 'tried', actor: tried.actor.toLowerCase(), measure, units: unitTerms(measure),
        scope: [], objects: triedObjects(objects), search: objects + ' tried' }
    }
  }
  if (NON_SCALAR.test(text)) return null
  const ch = CHINESE.exec(text.replace(/\s+/gu, ''))
  if (ch) {
    const { actor, action, measure, place } = ch.groups
    return { language: 'zh', actor, role: action === '需要' ? 'required' : 'owned', measure,
      scope: place ? [place] : [], search: [place, measure].filter(Boolean).join(' ') }
  }
  const owned = POSSESSION.exec(text), redemption = REDEMPTION.exec(text), inventory = INVENTORY.exec(text)
  const match = owned ?? redemption ?? inventory
  if (!match) return null
  const { measure, actor, action } = match.groups
  const scope = normalizeScope(match.groups.scope.replace(/\s+with\s+(?:my|our)\s+accumulated points$/iu, ''))
  const units = unitTerms(measure)
  if (!units.length || units.length > 9 || /\b(?:and|or)\b/iu.test(measure + ' ' + match.groups.scope)) return null
  const role = redemption ? 'redeemable' : inventory ? 'inventory' : /need|require/iu.test(action) ? 'required' : 'owned'
  // A derived remaining amount needs its own balance and threshold. A
  // separate activity after the ownership verb can also change the unit.
  if (role === 'required' && /^\s+to earn\b/iu.test(match.groups.scope)) return null
  if (role === 'owned' && scope.length && !/^\s+(?:(?:now|currently)\s+)?(?:on|in|at|for|with)\b/iu.test(match.groups.scope)) return null
  const namedAudience = role === 'owned' && scope.length === 0 ? AUDIENCE_MEASURE.exec(measure)?.groups : null
  const scopedAudience = role === 'owned' && scope.length > 0 && units.length === 1 && ['follower', 'subscriber'].includes(units[0])
  const audience = namedAudience ? { scope: normalizeScope(namedAudience.name), units: unitTerms(namedAudience.unit) }
    : scopedAudience ? { scope: accountDescriptor(scope.at(-1)) ? scope.slice(0, -1) : scope, units } : null
  const threshold = role === 'required' ? THRESHOLD_SCOPE.exec(match.groups.scope)?.groups : null
  return { language: 'en', actor: actor?.toLowerCase() ?? null, role, measure, units, scope,
    ...(audience?.scope.length ? { audience } : {}),
    ...(threshold ? { threshold: { scope: normalizeScope(threshold.name), goal: normalizeScope(threshold.goal) } } : {}),
    search: [measure, ...scope].join(' ') }
}

function countKey(value) {
  const text = String(value)
  if (!EXACT_COUNT.test(text)) return null
  const canonical = text.replaceAll(',', '').toLowerCase()
  const number = canonical === 'single' ? 1 : readDayCount(canonical)
  return Number.isSafeInteger(number) && number >= 0 ? String(number) : null
}

function ordinalCount(value) {
  const pieces = value.toLowerCase().split(/[ -]/u)
  const suffix = pieces.pop()
  const cardinal = CARDINALS[suffix] ?? suffix.replace(/(?<=\d)(?:st|nd|rd|th)$/u, '')
    .replace(/ieth$/u, 'y').replace(/(?<!\d)th$/u, '')
  return countKey([...pieces, cardinal].join(' '))
}

function stockAmount(raw, plan, allowPackage) {
  const amount = MEASURED_COUNT.exec(raw)?.groups
  if (!amount) return null
  const units = stockUnits(amount.units)
  const value = countKey(amount.value)
  if (units.join(' ') === plan.units.join(' ')) return value
  return allowPackage && units.length === 1 && units[0] === plan.units[0] && plan.units.length > 1 &&
    STOCK_PACKAGING.has(units[0]) ? value : null
}

function stockFacts(plan, original) {
  const facts = []
  const sentences = sourceSentences(original)
  for (const [index, quote] of sentences.entries()) {
    if (!isRecallSourceStatement(quote) || COUNT_HYPOTHETICAL.test(quote) || INDIRECT_REPORT.test(quote) ||
        QUOTED_COUNT_FRAME.test(sentences[index - 1] ?? '')) continue
    const sentence = quote.normalize('NFKC').replace(/[*_]/gu, '').replace(/[.!]+$/u, '')
    for (const clause of sentence.matchAll(STOCK_CLAUSE)) {
      if (clause.groups.actor.toLowerCase() !== plan.actor) continue
      const from = clause.index + clause[0].length
      const [main, end, ...extra] = sentence.slice(from).split(STOCK_BREAK)
      const state = main.replace(STOCK_TIME, '')
      const place = STOCK_PLACEMENT.exec(state)
      if (extra.length || !place || stockScope(place.groups.location, plan.actor)?.join(' ') !== plan.scope.join(' ')) continue
      const claim = state.slice(0, place.index)
      if (GROUP_LIMIT.test(claim)) continue
      const previous = sentence.slice(0, from).replace(/[\s;,–—-]+$/u, '')
      const object = STOCK_OBJECT.exec(previous)?.groups
      const allowPackage = object?.owner.toLowerCase() === (plan.actor === 'we' ? 'our' : 'my') &&
        stockUnits(object.object).join(' ') === plan.units.slice(1).join(' ')
      let value = null
      if (end) {
        if (/\ba lot$/iu.test(claim) && OWN.test(claim.slice(0, -5))) value = stockAmount(end.replace(STOCK_TIME, ''), plan, allowPackage)
      } else {
        for (const amount of claim.matchAll(EN_COUNT)) {
          if (!OWN.test(claim.slice(0, amount.index))) continue
          value = stockAmount(claim.slice(amount.index), plan, allowPackage)
          if (value !== null) break
        }
      }
      if (value !== null) facts.push({ value, quote })
    }
  }
  return facts
}

function matchesSpeciesPlace(plan, place, answer = false) {
  return stockScope(place, plan.actor, answer)?.join(' ') === plan.scope.join(' ')
}

function speciesAmount(text) {
  const amount = SPECIES_AMOUNT.exec(text)?.groups
  const value = amount && countKey(amount.amount)
  if (value == null) return null
  const group = amount.group ?? amount.prefix
  return { value, group: !group ? null : /^birds?$/iu.test(group) ? 'birds' : 'other' }
}

function speciesFacts(plan, original) {
  const results = []
  let previous = ''
  for (const quote of sourceSentences(original)) {
    const example = QUOTED_COUNT_FRAME.test(previous)
    previous = quote
    if (example || !isRecallSourceStatement(quote) || GROUP_LIMIT.test(quote) ||
        COUNT_HYPOTHETICAL.test(quote) || INDIRECT_REPORT.test(quote)) continue
    const statement = quote.normalize('NFKC').replace(/[.!]+$/u, '')
    const heading = SPECIES_TOPIC.exec(statement)
    const topic = heading?.groups.topic ?? ''
    const allBirds = BIRD_LIST_TOPIC.test(topic)
    const birdTopic = allBirds || BIRD_SUBGROUP_TOPIC.test(topic)
    const body = statement.slice(heading?.[0].length ?? 0)
    const tracker = SPECIES_TRACK.exec(body)
    if (tracker && tracker.groups.actor.toLowerCase() === plan.actor && tracker.groups.observer.toLowerCase() === plan.actor &&
        matchesSpeciesPlace(plan, tracker.groups.place)) {
      const scoped = !tracker.groups.all && (tracker.groups.topic ? /^birds?$/iu.test(tracker.groups.topic) : allBirds)
      const remainder = body.slice(tracker[0].length).replace(/^,\s*(?:and\s+)?/iu, '')
      const observation = SPECIES_OBSERVED.exec(remainder)?.groups
      const amount = observation && speciesAmount(observation.count)
      const sameObserver = amount && observation.actor.toLowerCase() === plan.actor && !observation.place
      const value = sameObserver && amount.group !== 'other' ? amount.value : null
      const scopeQuote = statement.slice(0, (heading?.[0].length ?? 0) + tracker[0].length)
      if (quote.startsWith(scopeQuote)) {
        results.push({ value: scoped ? value : null, quote, ...(scoped ? { speciesScope: scopeQuote } : { competingSpeciesTracker: true }) })
        if (scoped && sameObserver && amount.group === 'other') results.push({ value: null, quote, competingSpeciesTracker: true })
      }
      continue
    }
    const update = SPECIES_UPDATE.exec(body)?.groups
    if (update && update.actor.toLowerCase() === plan.actor && update.owner.toLowerCase() === (plan.actor === 'i' ? 'my' : 'our') &&
        matchesSpeciesPlace(plan, update.place)) {
      if (update.unit.toLowerCase() === 'species' && !birdTopic) continue
      const value = countKey(update.amount)
      if (value !== null) results.push({ value, quote, assumesSpeciesScope: update.unit.toLowerCase() === 'species' })
      continue
    }
    const observed = SPECIES_OBSERVED.exec(body)?.groups
    if (!observed?.place || observed.actor.toLowerCase() !== plan.actor || !matchesSpeciesPlace(plan, observed.place)) continue
    const amount = speciesAmount(observed.count)
    if (!amount) continue
    if (amount.group === 'birds' || (amount.group === null && allBirds)) results.push({ value: amount.value, quote })
    else if (amount.group === 'other' || heading) results.push({ value: null, quote, competingSpeciesTracker: true })
  }
  return results
}

function speciesAnswerValues(plan, sentence) {
  const statement = withoutEvidencePreface(sentence).trim().replace(/[.!]+$/u, '')
  if (GROUP_LIMIT.test(statement)) return [null]
  const observed = SPECIES_OBSERVED.exec(statement)?.groups
  const amount = speciesAmount(observed?.count ?? statement)
  if (!amount) return []
  const actor = observed?.actor.toLowerCase()
  if (amount.group === 'other' || (actor && actor !== 'you' && actor !== plan.actor) ||
      (observed?.place && !matchesSpeciesPlace(plan, observed.place, actor === 'you'))) return [null]
  return [amount.value]
}

function resolveSpeciesScope(proofs, row) {
  if (!row.fact.assumesSpeciesScope) return row
  const earlier = proofs.filter(proof => Number.isSafeInteger(proof.time) && proof.time < row.time)
  const anchors = earlier.filter(proof => proof.fact.speciesScope)
  const anchor = anchors.reduce((latest, proof) => !latest || proof.time > latest.time ? proof : latest, null)
  const competing = proofs.some(proof => proof.fact.competingSpeciesTracker &&
    (!Number.isSafeInteger(proof.time) || proof.time <= row.time))
  return anchor && !competing
    ? { ...row, context: { hit: anchor.hit, fact: { quote: anchor.fact.speciesScope } } }
    : { ...row, fact: { ...row.fact, ambiguous: true } }
}

function stockAnswerValues(text, plan) {
  const statement = withoutEvidencePreface(text).trim().replace(/[.!]+$/u, '').replace(STOCK_TIME, '')
  const place = STOCK_PLACEMENT.exec(statement)
  const claim = place ? statement.slice(0, place.index) : statement
  const direct = stockAmount(claim, plan, true)
  if (direct !== null) return place && stockScope(place.groups.location, plan.actor, true)?.join(' ') !== plan.scope.join(' ')
    ? [null] : [direct]
  return [...claim.matchAll(EN_COUNT)].flatMap(amount => {
    const value = stockAmount(claim.slice(amount.index), plan, true)
    if (value === null) return []
    const actor = STOCK_ANSWER.exec(claim.slice(0, amount.index))?.groups.actor.toLowerCase()
    if ((actor !== 'you' && actor !== plan.actor) ||
        (place && stockScope(place.groups.location, plan.actor, actor === 'you')?.join(' ') !== plan.scope.join(' '))) return [null]
    return [value]
  })
}

function progressValues(text, plan, { answer = false, allowMilestone = true } = {}) {
  if (answer) text = withoutEvidencePreface(text)
  if (plan.writing) text = text.replace(WRITING_MANAGED, '$<actor> completed ')
  if (plan.collection) text = text.replace(COLLECTION_REALIZED, '')
  const [core, activity, ...extra] = text.trim().replace(/[.!]+$/u, '').split(/\s+since\s+/iu)
  if (extra.length || (!answer && !activity)) return []
  const claim = PROGRESS_CLAIM.exec(core)?.groups
  if (!answer && !claim) return []
  if (claim && Boolean(plan.collection) !== /^added$/iu.test(claim.action)) return []
  if (!plan.writing && claim && /^(?:written|wrote)$/iu.test(claim.action)) return []
  const amountText = claim?.amount ?? core
  const stated = plan.writing || plan.collection ? amountText.replace(/\s+so far$/iu, '') : amountText
  const collection = plan.collection ? COLLECTION_OWNER.exec(stated) : null
  const total = MEASURED_COUNT.exec(stated.slice(0, collection?.index))?.groups
  const milestone = allowMilestone && claim && !plan.writing && !plan.collection ? PROGRESS_MILESTONE.exec(stated)?.groups : undefined
  const amount = total ?? milestone
  if (!amount) return []
  const units = unitTerms(amount.units)
  if (units.join(' ') !== plan.units.join(' ')) return []
  const actor = claim?.actor.toLowerCase()
  const owner = (milestone?.owner ?? collection?.groups.owner)?.toLowerCase()
  const expectedOwner = actor === 'you' || (!actor && answer) ? 'your' : actor === 'we' ? 'our' : 'my'
  const scope = activity && progressScope(activity, plan.actor, answer)
  if ((actor && actor !== plan.actor && !(answer && actor === 'you')) ||
      (owner && owner !== expectedOwner) || (activity && scope?.join(' ') !== plan.scope.join(' '))) return answer ? [null] : []
  const value = total ? countKey(total.value) : ordinalCount(milestone.value)
  return value === null ? [] : [value]
}

function seriesRelation(named, plan) {
  if (!named || named.kind !== plan.series.kind) return null
  const { author, topic } = plan.series
  if (named.author.length === 1 && named.author[0] === author[0] && named.topic.length === 0) return 'author-only'
  if (named.author.join(' ') !== author.join(' ')) return null
  if (named.topic.join(' ') === topic.join(' ')) return 'exact'
  if (topic.at(-1) === 'programming' && named.topic.join(' ') === topic.slice(0, -1).join(' ')) return 'short-title'
  return null
}

function seriesCount(plan, quote, answer = false) {
  if (GROUP_LIMIT.test(quote) || INDIRECT_REPORT.test(quote) || TRIED_SUBTOTAL.test(quote)) return null
  const clean = (answer ? withoutEvidencePreface(quote) : quote).trim().replace(/^and\s+/iu, '').replace(/[.!]+$/u, '')
  const claim = PROGRESS_CLAIM.exec(clean)?.groups
  if (!claim && !answer) return null
  const actor = claim?.actor.toLowerCase()
  if (claim && ((actor !== plan.actor && !(answer && actor === 'you')) ||
      !/^(?:finished|completed)$/iu.test(claim.action))) return null
  const amount = MEASURED_COUNT.exec(claim?.amount ?? clean)?.groups
  if (!amount) return null
  const location = SERIES_COUNT_SCOPE.exec(amount.units)
  const unit = amount.units.slice(0, location?.index).replace(/\s+so far$/iu, '')
  if (unitTerms(unit).join(' ') !== plan.units.join(' ')) return null
  const value = countKey(amount.value)
  if (value === null) return null
  const scope = location ? amount.units.slice(location.index + location[0].length).replace(/\s+so far$/iu, '') : ''
  return {
    value, named: Boolean(location),
    relation: location ? seriesRelation(seriesName(scope), plan) : null,
    total: /\s+so far$/iu.test(amount.units),
  }
}

function seriesFacts(plan, original) {
  const facts = []
  const sentences = sourceSentences(original)
  for (const [index, sentence] of sentences.entries()) {
    if (COUNT_HYPOTHETICAL.test(sentence) || INDIRECT_REPORT.test(sentence) ||
      QUOTED_COUNT_FRAME.test(sentences[index - 1] ?? '')) continue
    const parts = clauses(sentence)
    let anchor = null, offset = 0
    for (const quote of parts) {
      const from = sentence.indexOf(quote, offset)
      offset = from + quote.length
      const statement = isRecallSourceStatement(quote)
      const count = statement && seriesCount(plan, quote)
      if (count?.relation === 'exact') facts.push({ value: count.value, quote })
      else if (count?.relation === 'short-title') {
        // The creator is explicit. A shortened programming title also needs
        // the user's own statement identifying the same skill.
        const terms = [plan.actor === 'we' ? 'our' : 'my', ...plan.series.topic.slice(0, -1), 'skill']
        const namedSkill = parts.some(part => part !== quote && isRecallSourceStatement(part) &&
          !GROUP_LIMIT.test(part) && !/n['’]t\b/iu.test(part) && containsUnits(unitTerms(part), terms))
        facts.push(namedSkill ? { value: count.value, quote: sentence } : { value: count.value, quote, ambiguous: true })
      } else if (count?.relation === 'author-only') {
        facts.push({ value: count.value, quote, ambiguous: true })
      } else if (count && !count.named && count.total && anchor !== null) {
        facts.push({ value: count.value, quote: sentence.slice(anchor, offset) })
      }
      const watched = statement && !GROUP_LIMIT.test(quote) ? SERIES_STUDY.exec(quote)?.groups : null
      anchor = watched?.actor.toLowerCase() === plan.actor &&
        seriesRelation(seriesName(watched.name), plan) === 'exact' ? from : null
    }
  }
  return facts
}

function writingFacts(plan, original) {
  const facts = []
  let preceding = null, offset = 0
  for (const quote of sourceSentences(original)) {
    const from = original.indexOf(quote, offset)
    offset = from + quote.length
    const text = quote.normalize('NFKC')
    const outsideExample = !COUNT_HYPOTHETICAL.test(text) && !QUOTED_COUNT_FRAME.test(preceding?.quote ?? '')
    if (outsideExample && !INDIRECT_REPORT.test(text) && isRecallSourceStatement(text)) {
      const status = WRITING_STATUS.exec(text)?.groups
      const start = status && WRITING_START_REFERENCE.exec(status.claim)?.groups.actor.toLowerCase()
      if (status?.actor.toLowerCase() === plan.actor && start === plan.actor && !GROUP_LIMIT.test(text)) {
        const claim = status.claim.replace(WRITING_START_REFERENCE, ' since starting writing regularly')
        for (const value of progressValues(claim, plan)) facts.push({ value, quote })
      }
      const topic = preceding?.topic
      const matchingGoal = topic && !SCOPE_ALTERNATIVES.test(topic) &&
        unitTerms(topic).join(' ') === plan.units.join(' ')
      for (const clause of clauses(quote)) {
        if (!isRecallSourceStatement(clause) || GROUP_LIMIT.test(clause) || INDIRECT_REPORT.test(clause)) continue
        const normalized = clause.normalize('NFKC').replace(/[*_]/gu, '')
        for (const value of progressValues(normalized, plan)) facts.push({ value, quote: clause })
        const total = matchingGoal && WRITING_BARE_TOTAL.exec(normalized)?.groups
        if (total && total.actor.toLowerCase() === plan.actor &&
            progressScope(total.activity, plan.actor)?.join(' ') === plan.scope.join(' ')) {
          const value = countKey(total.amount)
          if (value !== null) facts.push({ value, quote: original.slice(preceding.from, offset), fromRequest: true })
        }
      }
    }
    preceding = { from, quote, topic: outsideExample ? WRITING_GOAL_TOPIC.exec(text)?.groups.object : undefined }
  }
  return facts
}

function containsUnits(words, units) {
  return words.some((_, from) => units.every((unit, index) => words[from + index] === unit))
}

function triedObjects(value) {
  return unitTerms(value.trim().replace(/^(?:different\s+)?(?:of\s+)?/iu, '').replace(/\s+so far$/iu, '')).join(' ')
}

function triedCount(plan, quote, answer = false) {
  if (GROUP_LIMIT.test(quote) || TRIED_SUBTOTAL.test(quote) || INDIRECT_REPORT.test(quote)) return null
  const text = (answer ? withoutEvidencePreface(quote) : quote).replace(/[.!]+$/u, '').trim()
  const claim = TRIED_CLAIM.exec(text)?.groups
  if (!answer && !claim?.perfect) return null
  if (claim && claim.actor.toLowerCase() !== plan.actor && !(answer && /^you$/iu.test(claim.actor))) return null
  const amount = MEASURED_COUNT.exec(claim?.count ?? text)?.groups
  if (!amount) return null
  const value = countKey(amount.value)
  const objects = answer ? amount.units.replace(/\byour\b/giu, plan.actor === 'we' ? 'our' : 'my') : amount.units
  const anaphor = /^(?:different\s+ones|ones|of them)(?<total>\s+so far)?$/iu.exec(objects)
  return value === null ? null : { value, named: triedObjects(objects) === plan.objects,
    refersBack: Boolean(anaphor), cumulative: Boolean(anaphor?.groups.total) }
}

function triedCountFacts(plan, original) {
  const facts = []
  let previousSentence = null, offset = 0
  for (const sentence of sourceSentences(original)) {
    const from = original.indexOf(sentence, offset)
    offset = from + sentence.length
    if (QUOTED_COUNT_FRAME.test(previousSentence?.quote ?? '')) {
      previousSentence = null
      continue
    }
    if (COUNT_HYPOTHETICAL.test(sentence) || INDIRECT_REPORT.test(sentence)) {
      previousSentence = { quote: sentence, from }
      continue
    }
    let previous = previousSentence
    let partOffset = 0
    for (const quote of clauses(sentence)) {
      const start = sentence.indexOf(quote, partOffset)
      partOffset = start + quote.length
      const count = isRecallSourceStatement(quote) ? triedCount(plan, quote) : null
      if (count?.named) facts.push({ value: count.value, quote })
      else if (count?.refersBack && previous) {
        const named = TRIED_COLLECTION.exec(previous.quote)?.groups
        const reader = TRIED_READER_TOPIC.exec(previous.quote)?.groups
        const matchesCollection = previous.sameSentence && named?.actor.toLowerCase() === plan.actor &&
          triedObjects(named.objects) === plan.objects
        const matchesQuestion = !previous.sameSentence && reader && count.cumulative &&
          triedObjects(reader.objects) === plan.objects
        if (matchesCollection || matchesQuestion) {
          facts.push({ value: count.value, quote: original.slice(previous.from, from + partOffset),
            ...(matchesQuestion ? { fromRequest: true } : {}) })
        }
      }
      previous = { quote, from: from + start, sameSentence: true }
    }
    previousSentence = { quote: sentence, from }
  }
  return facts
}

function isQualifiedAnswerCount(prefix, role) {
  return QUALIFIED_COUNT_PREFIX.test(prefix) || PARTIAL_COUNT_PREFIX.test(prefix) || RANGE_COUNT_PREFIX.test(prefix) ||
    role !== 'required' && MINIMUM_COUNT_PREFIX.test(prefix)
}

function clauses(content) {
  const split = /[;；]|,\s*(?=(?:(?:and|but|so|whereas|although)\s+)?(?:I|we|he|she|they|it)\b)|\s+(?:but|whereas|and|so)\s+(?=(?:I|we|he|she|they)\b)/iu
  return sourceSentences(content).flatMap(sentence => {
    // An independent follow-up question commonly shares the same line.
    if (/[?？]/u.test(sentence)) sentence = sentence.split(/[,，]\s*(?=(?:have you|do you|can you|could you|would you|what do you)\b)/iu)[0]
    const lead = TOPIC.exec(sentence)?.[0] ?? CORRECTION.exec(sentence)?.[0] ?? ''
    const parts = sentence.slice(lead.length).split(split)
    parts[0] = lead + parts[0]
    return parts.map(part => part.replace(NEGATED_AMOUNT, '').trim())
  })
}

function englishCountValues(text, plan, answer = false) {
  const values = []
  const topic = TOPIC.exec(text)
  for (const match of text.matchAll(EN_COUNT)) {
    const prefix = text.slice(0, match.index), tail = unitTerms(text.slice(match.index + match[0].length))
    const units = plan.units
    const full = units.every((unit, index) => tail[index] === unit)
    const shortened = !full && answer && plan.role === 'redeemable' && units.at(-1) === 'stay' &&
      units.slice(0, -1).every((unit, index) => tail[index] === unit)
    const referenced = plan.role === 'owned' && tail[0] === 'of' && tail[1] === 'them' && topic &&
      unitTerms(topic.groups.subject).join(' ') === units.join(' ')
    if (!full && !shortened && !referenced) continue
    const next = tail[referenced ? 2 : shortened ? units.length - 1 : units.length]
    const remainder = plan.role === 'remaining' ? tail.slice(units.length).join(' ') : ''
    const remaining = plan.role === 'remaining' && REMAINING_TAIL.test(remainder)
    if (next && !UNIT_CONTINUATION.has(next) && !remaining) continue
    const context = plan.role === 'remaining' ? REMAINING_CONTEXT.exec(remainder)?.groups : undefined
    if (plan.role === 'remaining' && ((context?.action && plan.action && context.action !== plan.action) ||
        (!answer && !context) || (plan.scope.length && (!answer || context?.scope) &&
          normalizeScope(context?.scope ?? '').join(' ') !== plan.scope.join(' ')))) {
      if (answer) values.push(null)
      continue
    }
    if (answer && isQualifiedAnswerCount(prefix, plan.role)) {
      values.push(null)
      continue
    }
    if (!answer) {
      const actor = /\b(I|we)(?:['’](?:ve|m|re)|\s)/iu.exec(prefix)?.[1]?.toLowerCase()
      if (actor && plan.actor && actor !== plan.actor) continue
      const accepted = plan.role === 'remaining'
        ? remaining && (OWN.test(prefix) || REMAINING_PREFIX.test(prefix))
        : plan.role === 'completed-span' ? SPENT_TOTAL.test(prefix)
          : plan.role === 'redeemable' ? REDEEM.test(prefix) : plan.role === 'required' ? NEED.test(prefix)
            : OWN.test(prefix) || plan.role === 'owned' && NOW_AT_COUNT.test(prefix) ||
              plan.scope.length > 0 && INVENTORY_OWNER.test(prefix) && LOCATION.test(prefix)
      if (!accepted) continue
    }
    const value = countKey(match.groups.number)
    if (value !== null) values.push(value)
  }
  if (!answer && plan.role === 'inventory' && /\b(?:I|we)(?:['’]ve|\s+have)\s+got\b/iu.test(text)) {
    const current = /,\s*(?:currently|now)\s+(\d{1,3}(?:,\d{3})+|\d+)[.!]?\s*$/iu.exec(text)
    if (current && containsUnits(unitTerms(text.slice(0, current.index)), plan.units)) {
      const value = countKey(current[1])
      if (value !== null) values.push(value)
    }
  }
  return values
}

function chineseCountValues(text, plan, answer = false) {
  if (plan.role === 'remaining') {
    let quote = text.replace(/\s+/gu, '')
    const title = `《${plan.scope[0]}》`
    if (!answer) {
      const start = quote.indexOf(title)
      if (start < 0 || !/^(?:我(?:们)?(?:在)?|目前|现在)?$/u.test(quote.slice(0, start))) return []
      const statement = quote.slice(start + title.length)
      const remaining = /^(?:目前|现在)?(?:还剩|还有|剩下)/u.exec(statement)
      if (!remaining) return []
      quote = statement.slice(remaining[0].length)
    }
    return [...quote.matchAll(HAN_COUNT)].flatMap(match => {
      if (!answer && match.index !== 0) return []
      const tail = quote.slice(match.index + match[0].length)
      if (!tail.startsWith(plan.measure)) return []
      const suffix = tail.slice(plan.measure.length)
      const prefix = quote.slice(0, match.index)
      const statement = /^(?:还没读|没读|未读|要读|需要阅读|需要读)?(?:在(?<book>[^。！？!?，,；;]+?)(?:中|里|里面))?(?:[。！？!?，,；;.]|$)/u.exec(suffix)
      if (!statement || (!answer && statement.groups.book)) return []
      if (answer) {
        const before = /(?:在(?<place>[^。！？!?，,；;]+?)(?:中|里|里面)|《(?<title>[^《》]+)》)(?:现在|目前|还剩|剩余|还有|剩下)*$/u.exec(prefix)?.groups
        const namedBooks = [before?.place ?? before?.title, statement.groups.book].filter(Boolean)
        const normalizedBook = name => bookTitle(name.replace(/^《|》$/gu, '')).replace(/\s+/gu, '')
        const expected = plan.title ?? plan.scope.join(' ')
        if (isQualifiedAnswerCount(prefix, plan.role) || QUALIFIED_COUNT_SUFFIX_ZH.test(suffix) ||
            namedBooks.some(name => normalizedBook(name) !== normalizedBook(expected))) return [null]
      }
      const value = countKey(match.groups.number)
      return value === null ? [] : [value]
    })
  }
  return [...text.matchAll(HAN_COUNT)].flatMap(match => {
    const tail = text.slice(match.index + match[0].length).trimStart()
    const prefix = text.slice(0, match.index).trim()
    const suffix = tail.slice(plan.measure.length)
    const continued = answer && plan.role === 'completed-span' && /^的?时间/u.test(suffix)
    const matches = tail.startsWith(plan.measure) && (continued || /^(?:$|[。！？!?，,；;.\s]|了(?:$|[。！？!?，,；;.\s]))/u.test(suffix))
    if (!matches) return []
    if (answer && (isQualifiedAnswerCount(prefix, plan.role) || QUALIFIED_COUNT_SUFFIX_ZH.test(suffix))) return [null]
    if (!answer && (prefix.startsWith('我们') ? '我们' : '我') !== plan.actor) return []
    if (!answer && !(plan.role === 'required' ? NEED_CN : OWN_CN).test(prefix)) return []
    const value = countKey(match.groups.number)
    return value === null ? [] : [value]
  })
}

function ageValues(text, plan, answer = false) {
  const escape = value => value.replace(/[.*+?^$(){}|[\]\\]/gu, '\\$&')
  const self = plan.actor === 'i' || plan.actor === 'we'
  const owner = self ? plan.actor === 'i' ? 'my' : 'our' : escape(plan.actor) + "['’]s"
  const actor = self ? (answer ? 'I|we|you' : plan.actor) : escape(plan.actor)
  const phrase = String.raw`\b(?:${actor})\s+(?:was|were|turned)(?: (?:just|already|only))?\s+${AGE_NUMBER}(?:\s+years? old)?`
  if (answer) {
    const stated = new RegExp(phrase + String.raw`(?=[,.!?\s]*$|[,.!?]|\s+(?:when|at|on)\b)`, 'giu')
    const unowned = new RegExp(String.raw`^${AGE_NUMBER}\s+years? old[.!]?\s*$`, 'iu').exec(text)
    return [...text.matchAll(stated), ...[unowned].filter(Boolean)].map(match => countKey(match.groups.number)).filter(Boolean)
  }
  const afterAge = new RegExp(phrase + String.raw`\s+when\s+(?<event>.+)$`, 'iu').exec(text)
  const beforeAge = new RegExp(String.raw`^(?<event>.+?)\s+when\s+` + phrase + String.raw`[.!]?\s*$`, 'iu').exec(text)
  const values = [afterAge, beforeAge].filter(match => match && namesAgeEvent(match.groups.event, plan))
    .map(match => countKey(match.groups.number)).filter(Boolean)
  const birthday = new RegExp(String.raw`\b(?:at|on)\s+${owner}\s+(?<ordinal>\d{1,3}(?:st|nd|rd|th)|[a-z]+(?:[ -][a-z]+)?)\s+birthday\b`, 'giu')
  for (const match of text.matchAll(birthday)) {
    if (!namesAgeEvent(text.slice(0, match.index), plan)) continue
    const age = ordinalCount(match.groups.ordinal)
    if (age !== null) values.push(age)
  }
  return values
}

function statedScope(plan, heading) {
  if (plan.language === 'zh') {
    const checked = CHECKED_SCOPE_ZH.exec(heading)?.groups
    return checked?.actor === plan.actor ? [checked.name] : null
  }
  const checked = CHECKED_SCOPE.exec(heading)?.groups
  if (!checked || checked.actor.toLowerCase() !== plan.actor || SCOPE_ALTERNATIVES.test(checked.name)) return null
  const owner = checked.owner.toLowerCase()
  if (owner !== (plan.actor === 'i' ? 'my' : 'our') && (owner !== 'the' || !plan.threshold)) return null
  return normalizeScope(checked.name)
}

function linkedCountFacts(plan, content) {
  const facts = [], scopedStatements = new Set()
  const scope = plan.audience?.scope ?? plan.threshold?.scope ?? (plan.role === 'owned' ? plan.scope : null)
  if (!scope?.length || !['owned', 'required'].includes(plan.role)) return { facts, scopedStatements }
  const sentences = sourceSentences(content)
  const ranges = []
  let offset = 0
  for (const sentence of sentences) {
    const from = content.indexOf(sentence, offset)
    offset = from + sentence.length
    ranges.push({ sentence, from, to: offset })
  }
  const units = plan.audience?.units ?? plan.units
  const goal = plan.threshold?.goal
  for (let i = 1; i < ranges.length; i++) {
    const { sentence, to } = ranges[i]
    let heading = ranges[i - 1]
    if (i >= 2 && QUOTED_COUNT_FRAME.test(ranges[i - 2].sentence)) continue
    let observedScope = statedScope(plan, heading.sentence)
    let fromRequest = false
    if (!observedScope && plan.audience && i >= 2 && CHECKED_OBSERVATION.test(sentence)) {
      const personal = PERSONAL_AUDIENCE.exec(ranges[i - 2].sentence)?.groups
      const mentioned = AUDIENCE_REQUEST.exec(heading.sentence)?.groups
      if (personal?.actor.toLowerCase() === plan.actor && personal.owner.toLowerCase() === (plan.actor === 'i' ? 'my' : 'our') &&
          mentioned?.owner.toLowerCase() === (plan.actor === 'i' ? 'me' : 'us') &&
          !SCOPE_ALTERNATIVES.test(mentioned.name) && !/\b(?:on|another|different|and|or)\b/iu.test(mentioned.request)) {
        observedScope = audienceScope(mentioned.name)
        heading = ranges[i - 2]
        fromRequest = true
      }
    }
    if (!observedScope?.length || [heading.sentence, sentence.replace(NEGATED_AMOUNT, '')].some(text =>
      GROUP_LIMIT.test(text) || INDIRECT_REPORT.test(text) || /n['’]t\b/iu.test(text))) continue
    const linked = plan.audience ? matchesAudienceScope(observedScope, scope) : observedScope.join(' ') === scope.join(' ')
    for (const clause of clauses(sentence)) {
      if (!isRecallSourceStatement(clause)) continue
      const text = clause.normalize('NFKC').replace(COUNT_COMMENT, '').replace(/[*_]/gu, '')
      if (plan.language === 'en') {
        // A prepositional attachment after the count can name another account.
        // Only a bare measurement or the stated goal inherits its nearby subject.
        const words = normalizeScope(text)
        const ending = goal ?? units
        if (words.slice(-ending.length).join(' ') !== ending.join(' ')) continue
        if (plan.role === 'required' && !/^(?:i|we)\s+(?:(?:actually|now|currently|still|just)\s+)*(?:need|require)\b/iu.test(text.replace(CORRECTION, ''))) continue
      }
      const values = plan.language === 'zh' ? chineseCountValues(text, plan) :
        englishCountValues(text, { ...plan, scope: [], units })
      if (!values.length) continue
      scopedStatements.add(clause)
      if (linked) for (const value of new Set(values)) {
        facts.push({ value, quote: content.slice(heading.from, to), ...(fromRequest ? { fromRequest: true } : {}) })
      }
    }
  }
  return { facts, scopedStatements }
}

export function declaredCountFacts(plan, content, { includePossibleCorrection = false, linkOriginalSentences = false } = {}) {
  const original = String(content ?? '')
  if (plan.role === 'series') return seriesFacts(plan, original)
  if (plan.role === 'tried') return triedCountFacts(plan, original)
  if (plan.role === 'stock') return stockFacts(plan, original)
  if (plan.writing) return writingFacts(plan, original)
  if (plan.role === 'observed-species') return speciesFacts(plan, original)
  const disputedProgress = plan.role === 'progress' && PROGRESS_GAP.test(original)
  const { facts: results, scopedStatements } = linkOriginalSentences ? linkedCountFacts(plan, original)
    : { facts: [], scopedStatements: new Set() }
  const statements = plan.collection ? sourceSentences(original).flatMap((sentence, index, sentences) =>
    COUNT_HYPOTHETICAL.test(sentence) || GROUP_LIMIT.test(sentence) || INDIRECT_REPORT.test(sentence) ||
    QUOTED_COUNT_FRAME.test(sentences[index - 1] ?? '') ? [] : clauses(sentence))
    : clauses(original)
  const segments = statements.flatMap(quote => plan.role === 'age-at-event' && !GROUP_LIMIT.test(quote)
    ? [quote, ...quote.split(/,\s+(?:like|such as)\s+/iu).slice(1)] : [quote])
  for (const quote of segments) {
    if (!isRecallSourceStatement(quote) || GROUP_LIMIT.test(quote) || INDIRECT_REPORT.test(quote)) continue
    const zh = plan.language === 'zh'
    const text = quote.normalize('NFKC').replace(/[*_]/gu, '')
    if (plan.role === 'progress') {
      const exact = progressValues(text, plan, { allowMilestone: !disputedProgress })
      const possible = disputedProgress && !exact.length ? progressValues(text, plan) : []
      for (const value of exact) results.push({ value, quote })
      // A newer statement that disputes what was completed also prevents
      // the older count from being presented as the current total.
      for (const value of possible) results.push({ value, quote, ambiguous: true })
      continue
    }
    const words = zh ? [] : normalizeScope(text)
    const scope = plan.role === 'age-at-event' ? eventTerms(text) : words
    const scoped = plan.scope.length === 0 || (zh ? text.includes(plan.scope[0]) : plan.role === 'age-at-event'
      ? plan.scope.every(term => scope.includes(term)) : containsUnits(scope, plan.scope))
    const ambiguous = !scoped && includePossibleCorrection && plan.role === 'required' && plan.scope.length >= 4 &&
      CORRECTION.test(text) && containsUnits(words, plan.scope.slice(0, 3))
    if (!scoped && (!ambiguous || scopedStatements.has(quote))) continue
    if (plan.role === 'completed-span' && !namesSpan(text, plan)) continue
    if (plan.role === 'remaining' && PAST_PROGRESS.test(text)) continue
    const values = plan.role === 'age-at-event' ? plan.prospective ? [] : ageValues(text, plan)
      : zh ? chineseCountValues(text, plan) : englishCountValues(text, plan)
    for (const value of new Set(values)) results.push({ value, quote, ...(ambiguous ? { ambiguous: true } : {}) })
  }
  return results
}

function thresholdContext(plan, content) {
  const [first, question, ...other] = sourceSentences(content)
  if (!first || other.length || !isRecallSourceStatement(first) || GROUP_LIMIT.test(first) || INDIRECT_REPORT.test(first)) return null
  const [opening, qualification, ...extra] = first.replace(/[.!]$/u, '').split(/,\s*/u)
  if (extra.length) return null
  const intent = THRESHOLD_INTENT.exec(opening)?.groups
  const named = intent && THRESHOLD_SCOPE.exec(' ' + intent.purpose)?.groups
  if (intent?.actor.toLowerCase() !== plan.actor || !named || SCOPE_ALTERNATIVES.test(named.name) ||
      normalizeScope(named.goal).join(' ') !== plan.threshold.goal.join(' ') ||
      normalizeScope(named.name).join(' ') !== plan.threshold.scope.join(' ')) return null
  const owner = /^(my|our|the)\s+/iu.exec(named.name)?.[1].toLowerCase()
  const collective = plan.actor === 'we'
  if (owner && owner !== 'the' && owner !== (collective ? 'our' : 'my')) return null
  if (qualification && unitTerms(THRESHOLD_UNITS.exec(qualification)?.groups.units ?? '').join(' ') !== plan.units.join(' ')) return null
  if (question) {
    const ask = THRESHOLD_QUESTION.exec(question)?.groups
    if (!ask || ask.owner.toLowerCase() !== (collective ? 'us' : 'me') || ask.actor.toLowerCase() !== plan.actor ||
        unitTerms(ask.units).join(' ') !== plan.units.join(' ')) return null
    const goal = normalizeScope(ask.purpose)
    if (goal.length < 3 || !goal.every((term, index) => term === plan.threshold.goal[index])) return null
  }
  return first
}

function thresholdCorrection(plan, hit, fact) {
  if (!fact.ambiguous || !plan.threshold || hit.record.sourceRefs[0].from !== 0 ||
      fact.quote !== clauses(hit.record.content)[0]) return false
  const update = fact.quote.replace(CORRECTION, '').normalize('NFKC').replace(/[*_]/gu, '')
  const prefix = REQUIRED_UPDATE.exec(update)
  if (prefix?.groups.actor.toLowerCase() !== plan.actor) return false
  const firstCount = [...update.matchAll(EN_COUNT)][0]
  return firstCount?.index === prefix[0].length &&
    normalizeScope(update.slice(firstCount.index + firstCount[0].length)).join(' ') ===
    [...plan.units, ...plan.threshold.goal].join(' ')
}

export function retrieveDeclaredCount(index, plan, options) {
  const { query, projectKey, now, accepts, resolvePrevious } = options
  const scan = index.findEvidence([query], {
    projectKey, now, wholeSentences: true, allMatches: true, acceptOriginal: true,
    lookupQuery: () => plan.search,
    distinctKey: (_, hit) => hit.record.id,
    match: (_, hit) => {
      if (!accepts(hit)) return null
      const facts = declaredCountFacts(plan, hit.record.content, { includePossibleCorrection: true, linkOriginalSentences: true })
      const explanationText = explicitRememberText(hit.record.content) ?? hit.record.content
      const components = countComponents(plan, explanationText)
      return facts.length || components.length ? { ...hit, facts, components } : null
    },
  })
  const correctionCandidates = plan.threshold && !scan.incomplete && scan.tokens < DEEP_RECALL_TOKEN_LIMIT
    ? scan.matches.filter(({ hit }) => hit.facts.some(fact => thresholdCorrection(plan, hit, fact))).map(({ hit }) => hit) : []
  const prior = new Map(correctionCandidates.filter(hit => hit.record.previousUserSourceId).map(hit =>
    [hit.record.sourceRefs[0].sourceId, hit.record.previousUserSourceId]))
  const needsHistory = correctionCandidates.filter(hit => !prior.has(hit.record.sourceRefs[0].sourceId))
  if (resolvePrevious && needsHistory.length) {
    return resolvePrevious(needsHistory.map(hit => hit.record.sourceRefs[0])).then(resolved => {
      for (const [id, preceding] of resolved) prior.set(id, preceding)
      return selectDeclaredCount(index, plan, options, scan, correctionCandidates, prior)
    })
  }
  return selectDeclaredCount(index, plan, options, scan, correctionCandidates, prior)
}

function selectDeclaredCount(index, plan, { projectKey, now, maxTokens, maxItems, skipCapture, memoryOnly, accepts, storedHits = [], readStored },
  scan, correctionCandidates, preceding) {
  const originals = index.validateMany(scan.matches.map(item => item.hit), projectKey, { now })
  const contextual = new Map()
  let checkedTokens = scan.tokens
  for (const hit of correctionCandidates) {
    const id = hit.record.sourceRefs[0].sourceId
    const prior = preceding.get(id)
    if (!prior || contextual.has(id)) continue
    const previous = index.precedingUserMessage(hit, prior, projectKey, now)
    if (!previous || !accepts(previous)) continue
    const tokens = estimateTokens(previous.record.content)
    if (checkedTokens + tokens > DEEP_RECALL_TOKEN_LIMIT) break
    checkedTokens += tokens
    const quote = thresholdContext(plan, previous.record.content)
    contextual.set(id, quote ? { hit: previous, fact: { quote } } : null)
  }
  const observations = originals.map(hit => {
    const ref = hit.record.sourceRefs[0]
    // The local hooks used the reception time for an inline remember command.
    // Remembering an earlier message does not give it a new observation time.
    const explicitLocal = ref.from === 0 && /^(?:codex|claude-code):/u.test(ref.sessionId) &&
      explicitRememberText(hit.record.content) !== null
    const time = ref.eventTime ?? (explicitLocal ? ref.at : undefined)
    return { hit, time }
  })
  const extractedProofs = observations.flatMap(({ hit, time }) => {
    const context = contextual.get(hit.record.sourceRefs[0].sourceId)
    return hit.facts.map(fact => context && thresholdCorrection(plan, hit, fact)
      ? { hit, time, fact: { ...fact, ambiguous: false }, context }
      : { hit, time, fact })
  })
  const proofs = plan.role === 'observed-species'
    ? extractedProofs.filter(row => row.fact.value !== null).map(row => resolveSpeciesScope(extractedProofs, row))
    : extractedProofs
  const factsBySource = new Map()
  for (const { hit, fact } of proofs) {
    const sourceId = hit.record.sourceRefs[0].sourceId
    if (!factsBySource.has(sourceId)) factsBySource.set(sourceId, [])
    factsBySource.get(sourceId).push(fact)
  }
  // A copy of an original should retain its observation time. A compact
  // fact without provable lineage still needs to agree with current evidence.
  const fromOriginal = (record, fact) => record.scope === 'project' && record.projectKey === projectKey &&
    record.sourceRefs?.some(ref => ref.excerpt?.includes(fact.quote) && factsBySource.get(ref.sourceId)?.some(proof =>
      proof.value === fact.value && proof.quote.includes(fact.quote)))
  const canOrder = proofs.every(row => Number.isSafeInteger(row.time))
  const newest = canOrder ? Math.max(...proofs.map(row => row.time)) : null
  const current = [
    ...(canOrder ? proofs.filter(row => row.time === newest) : proofs),
    ...(readStored?.() ?? storedHits).flatMap(hit => declaredCountFacts(plan, hit.record.recallQuote ?? hit.record.content)
      .filter(fact => !fromOriginal(hit.record, fact) && (plan.role !== 'observed-species' ||
        fact.value !== null && !fact.assumesSpeciesScope)).map(fact => ({ hit, fact }))),
  ]
  const claimed = current.filter(row => !row.fact.ambiguous)
  // The creation time of a compact record is not the time of its original
  // observation. Competing current records therefore require agreement.
  const agreed = claimed.length > 0 && new Set(current.map(row => row.fact.value)).size === 1
  const zh = plan.language === 'zh'
  const captureNote = skipCapture ? (zh ? '本轮不提炼。' : ' Do not capture this turn.') : ''
  const note = (zh ? '给出有依据的最近记录数量和单位。' : 'Give the latest supported recorded count with its unit.') + captureNote
  const block = (line, instructions = note) => '<memory-context source="dsh-memory" note="' + instructions + '">\n' + line + '\n</memory-context>'
  const composed = composeCount(plan, observations.flatMap(({ hit, time }) =>
    hit.components.map(fact => ({ hit, time, fact }))))
  const useComposed = composed && (current.length === 0 || (composed.value !== null &&
    Number.isSafeInteger(composed.time) && current.every(row => Number.isSafeInteger(row.time) && row.time < composed.time)))
  const size = row => row.fact.quote.length + (row.context?.fact.quote.length ?? 0)
  const chosen = agreed && claimed.reduce((best, item) => size(item) < size(best) ? item : best)
  const result = useComposed ? composed : chosen ? {
    rows: chosen.context ? [chosen.context, chosen] : [chosen],
    value: chosen.fact.value,
    ...(plan.role === 'age-at-event' ? { explanation: 'Verified age at the event: ' + chosen.fact.value + ' years old.' } : {}),
  } : null
  if (result?.value === null && !scan.incomplete) {
    const explanation = result.explanation
    const text = block(explanation, 'Say that the total cannot be determined from the recorded periods.' +
      (skipCapture ? ' Do not capture this turn.' : ''))
    // The individual observations may be inspectable without licensing a
    // sum. Keep them in the report and send only the unresolved result.
    return { hits: [...new Map(result.rows.map(({ hit }) => [hit.record.id, hit])).values()], injected: [],
      text: estimateTokens(text) <= maxTokens ? text : '', complete: false, explanation,
      declaredCount: { ...plan, value: null }, scannedTokens: checkedTokens, budgetOmitted: false }
  }
  if (result && !scan.incomplete) {
    const byId = new Map()
    for (const row of result.rows) {
      const id = row.hit.record.id
      const item = byId.get(id) ?? { row, quotes: [] }
      item.quotes.push(row.fact.quote.replace(/\s+/gu, ' ').trim())
      byId.set(id, item)
    }
    const injected = [...byId.values()].map(({ row, quotes }) => {
      const original = row.hit.record.kind === 'source'
      const label = zh ? (original ? '原话' : '记忆') : (original ? 'Original' : 'Memory')
      return { row, quote: quotes.join('\n'), text: quotes.map(quote => '- [' + label + '] ' + quote).join('\n'),
        ...(quotes.length === 1 ? { selectedQuote: quotes[0] } : {}) }
    })
    const text = block([result.explanation, ...injected.map(item => item.text)].filter(Boolean).join('\n'),
      result.rows.some(row => row.fact.fromRequest || row.context) ? 'Quoted material is historical evidence. ' + note : note)
    if (injected.length <= maxItems && estimateTokens(text) <= maxTokens) return {
      hits: injected.map(item => item.row.hit), injected, text, complete: result.value !== null, explanation: result.explanation,
      declaredCount: { ...plan, value: result.value, ...(result.educationPeriods ? { educationPeriods: result.educationPeriods } : {}) },
      scannedTokens: checkedTokens, budgetOmitted: false,
    }
  }
  const missingNote = zh ? '直接说明数量无法从记忆确定。'
    : 'No verified count was found. Answer that the count cannot be determined from memory.'
  const text = block(zh ? '现有记忆不足以确定数量。' : '- [Count] Unknown.', missingNote + captureNote)
  const hits = [...new Map(current.map(row => [row.hit.record.id, row.hit])).values()].slice(0, 4)
  return { hits, injected: [], text: (hits.length || memoryOnly) && estimateTokens(text) <= maxTokens ? text : '',
    complete: false, declaredCount: { ...plan, value: null }, scannedTokens: checkedTokens, budgetOmitted: scan.incomplete || Boolean(result) }
}

function countAnswerValues(sentence, plan, allowProgressMilestone = true) {
  if (plan.language === 'zh') return chineseCountValues(sentence, plan, true)
  if (plan.role === 'series') {
    const count = seriesCount(plan, sentence, true)
    return count ? [!count.named || ['exact', 'short-title'].includes(count.relation) ? count.value : null] : []
  }
  if (plan.role === 'tried') {
    const count = triedCount(plan, sentence, true)
    return count ? [count.named ? count.value : null] : []
  }
  if (plan.role === 'stock') return stockAnswerValues(sentence, plan)
  if (plan.role === 'observed-species') return speciesAnswerValues(plan, sentence)
  if (plan.role === 'progress') return progressValues(sentence, plan, { answer: true, allowMilestone: allowProgressMilestone })
  // A localized answer can retain the original unit without inserting Latin word boundaries.
  const english = sentence.replace(/(?<=\p{Script=Han})(?=\d)|(?<=\d)(?=[a-z])/giu, ' ')
    .replace(/(?<=[a-z])\s*(?=(?:来(?:解锁|达到|进入|兑换)|用于|以便|即可|才能|就能))/giu, ' to ')
  const translated = ANSWER_COUNT_UNIT_TRANSLATIONS.get(plan.units.join(' ')) ?? []
  if (plan.audience) {
    const values = [...englishCountValues(english, plan, true), ...englishCountValues(english, { ...plan, units: plan.audience.units }, true)]
    if (!values.length) return values
    const scopes = AUDIENCE_ANSWER_SCOPES.flatMap(pattern => [...english.matchAll(pattern)].map(match => match[1]))
    return scopes.every(name => matchesAudienceScope(audienceScope(name), plan.audience.scope)) ? values : [null]
  }
  return [
    ...englishCountValues(english, plan, true),
    ...translated.flatMap(measure => chineseCountValues(sentence, { ...plan, measure }, true)),
  ]
}

function matchesEducationTotal(sentences, plan) {
  const periods = plan.educationPeriods
  const widths = periods.map(period => String(period.to - period.from)).sort()
  let total = false
  for (const sentence of sentences) {
    const equation = sentence.split('=')
    if (equation.length === 2 && equation[0].includes('+')) {
      if (CLAIMED_RANGE.test(equation[0]) && !namesSpan(equation[0], plan, true)) return false
      const quantities = equation.map(side => side.split('+').flatMap(part => {
        const plain = part.replace(/\([^()]*\)/gu, '').trim().replace(/[.!。]+$/u, '')
        const bare = countKey(EQUATION_TERM.exec(plain)?.groups.number ?? plain)
        return bare === null ? countAnswerValues(plain, plan) : [bare]
      }))
      const [left, right] = quantities
      if (left.length !== widths.length || left.sort().some((value, index) => value !== widths[index]) ||
          right.length !== 1 || right[0] !== plan.value) return false
      total = true
      continue
    }
    const values = countAnswerValues(sentence, plan)
    const fullSpan = namesSpan(sentence, plan, true)
    const range = EDUCATION_PERIOD.exec(sentence)?.groups
    const completed = EDUCATION_FINISH.exec(sentence)?.groups
    const period = periods.find(item =>
      (range ? item.from === +range.from && item.to === +range.to :
        completed && item.role === 'end' && item.to === +completed.year) &&
      containsUnits(normalizeScope(sentence), normalizeScope(item.label)))
    if (CLAIMED_RANGE.test(sentence) && !fullSpan && !period) return false
    if (!values.length) continue
    if (period && !fullSpan && !TOTAL_COUNT_CLAIM.test(sentence)) {
      if (values.some(value => value !== String(period.to - period.from))) return false
      continue
    }
    if (values.some(value => value !== plan.value)) return false
    total = true
  }
  return total
}

export function matchesDeclaredCountAnswer(answer, plan) {
  if (plan.value === null) return false
  const normalized = answer.normalize('NFKC').replace(/[*_]/gu, '').trim()
  const text = plan.role === 'required' ? sourceSentences(normalized).map(sentence => sentence.replace(NEGATED_AMOUNT, '')).join('\n') : normalized
  if (ANSWER_LIMIT.test(text)) return false
  if (plan.role === 'remaining' && PAST_PROGRESS.test(text)) return false
  if (plan.role === 'completed-span' && PARTIAL_SPAN.test(text)) return false
  if (plan.role === 'required' && (ANSWER_OWNS.test(text) || ANSWER_REDEEMS.test(text)) && !ANSWER_NEEDS.test(text)) return false
  if (plan.role === 'redeemable' && ANSWER_OWNS.test(text) && !ANSWER_REDEEMS.test(text) &&
      !/\benough\b|足够/iu.test(text)) return false
  const words = text.replace(/[.!。！]+$/u, '')
  const bare = countKey(words)
  if (bare !== null) return bare === plan.value
  const sentences = sourceSentences(text)
  if (plan.educationPeriods) return matchesEducationTotal(sentences, plan)
  if (plan.role === 'completed-span' && sentences.some(sentence => CLAIMED_RANGE.test(sentence) && !namesSpan(sentence, plan, true))) return false
  if (plan.role === 'age-at-event') {
    if (sentences.some(sentence => ANSWER_SUBJECT.test(sentence) ||
        /\bwhen\b/iu.test(sentence) && !namesAgeEvent(sentence, plan))) return false
    const translated = /(?:^|[，,。\s])(?:他|她|它)(?:当时|那时|是|为){0,2}\s*(?:\d|[零一二两三四五六七八九十])/u.test(text)
      ? [] : [...text.matchAll(HAN_COUNT)]
      .filter(match => /^(?:周)?岁/u.test(text.slice(match.index + match[0].length)))
      .map(match => countKey(match.groups.number)).filter(Boolean)
    const values = [...sentences.flatMap(sentence => ageValues(sentence, plan, true)), ...translated]
    return values.length > 0 && values.every(value => value === plan.value)
  }
  const allowProgressMilestone = plan.role !== 'progress' || !PROGRESS_GAP.test(text)
  const values = sentences.flatMap(sentence => countAnswerValues(sentence, plan, allowProgressMilestone))
  return values.length > 0 && values.every(value => value === plan.value)
}
