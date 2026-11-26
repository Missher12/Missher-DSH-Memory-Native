/** Shared parsing for factual queries and explicit user-turn controls. */

import { sourceSentenceBreaks } from './sentences.js'

const SAVE_ACTION = String.raw`(?:保存|记录|提炼|写入|记入)(?:\s*(?:或|和|并且?|、)\s*(?:保存|记录|提炼|写入|记入))*`
const TURN_SCOPE = '(?:这次|这一?轮|本次|本轮|当前|此次|这段|这条)'
const CURRENT_NO_SAVE_PATTERN = new RegExp(
  String.raw`(?:不要|不得|不必|无需|不需要|禁止|请勿|别|不)\s*(?:把|将)?\s*${SAVE_ACTION}(?:到|进|入)?${TURN_SCOPE}?(?:问答|对话|聊天|消息|内容)(?:到|进|入)?(?:长期)?(?:记忆)?|(?:不要|不得|不必|无需|不需要|禁止|请勿|别|不)\s*(?:把|将)?\s*${TURN_SCOPE}(?:问答|对话|聊天|消息|内容)(?:.{0,8})?${SAVE_ACTION}(?:到|进|入)?(?:长期)?(?:记忆)?|${TURN_SCOPE}(?:问答|对话|聊天|消息|内容)(?:.{0,8})?(?:不要|不得|不必|无需|禁止|请勿|别)${SAVE_ACTION}(?:到|进|入)?(?:长期)?(?:记忆)?`,
  'giu',
)
const GENERAL_NO_SAVE_PATTERN = /(?:不要|不得|不必|无需|禁止|不)(?:保存|记录|提炼|写入)(?:到)?(?:长期)?记忆|do not (?:save|store|remember) (?:this|these)|don['’]t (?:save|store|remember) (?:this|these)/giu
const SHORT_NO_SAVE_PATTERN = /(?:^|(?<=[，,。！？!?；;\n]))\s*(?:请\s*)?(?:不要|不得|别|请勿|禁止)\s*(?:保存|记录|提炼|记住|存下)\s*(?=$|[，,。！？!?；;\n])/gu
const ANSWER_CONTROL_PATTERN = /^(?:(?:只|仅)?根据.{0,40}(?:记忆|已有资料|现有信息)|(?:每项|每个|每条)(?:都)?(?:用|按).{0,80}(?:回答|输出)|(?:没有|若无|如果没有|缺少)依据.{0,50}(?:不记得|不知道|写|回答)|(?:请)?(?:不要|别|请勿|不必|无需)(?:调用|使用)工具|(?:只|仅)(?:输出|回答).{0,50}|(?:回答|输出)(?:格式|要求)|工具名\s*[:：])/iu
const ANSWER_PRESENTATION_PATTERN = /^(?:请)?(?:(?:(?:按照|按|用)(?:原话|原文|表格|列表|要点|分点|编号|JSON|Markdown)(?:(?:逐项|逐条|分别|简短|简洁|简要)\s*)*(?:格式)?(?:回答|作答|输出|列出))|(?:(?:只|仅)(?:给(?:出)?|输出|回答)(?:结论|摘要|要点|答案|结果|原话|原文|表格|列表)(?:即可|就行)?)|(?:(?:分点|逐项|逐条|分别)(?:回答|作答)))$/iu
const VALUE_ONLY_CONTROL_PATTERN = /^(?:请)?(?:只|仅)(?:给(?:出)?|输出|回答)(?:单位|数值|数字|名称|时间|日期|版本号|结果|答案)(?:即可|就行)?$/u
const ITEMIZED_CONTROL_PATTERN = /^(?:please\s+)?(?:list|show|give)\s+(?:each\s+(?:count|amount)|the\s+individual\s+(?:counts|amounts))\s+separately(?:\s+before\s+(?:the\s+)?(?:total|difference))?$/iu
const MEMORY_ONLY_CONTROL_PATTERN = /^(?:请\s*)?(?:只|仅)根据(?:已有|现有|当前|此前)?记忆(?:内容)?(?:来)?\s*(?:(?:逐项|逐条|分别|简短|简洁|简要)\s*){0,2}(?:回答|作答)$/u
const ENGLISH_MEMORY_ONLY = /^(?:please\s+)?(?:(?:answer|reply)\s+(?:using|from|based on)\s+memory\s+only|(?:answer|reply)\s+only\s+from\s+(?:the\s+)?(?:available\s+)?memory)$/iu
const ENGLISH_FORMAT_CONTROL = /^(?:please\s+)?(?:(?:do not|don['’]t)\s+(?:use|call)\s+(?:any\s+)?tools|(?:list|show|give)\s+each\s+(?:known\s+)?(?:count|amount)\s+and\s+(?:the\s+)?total|or\s+explain\s+which\s+(?:item|count|amount)\s+is\s+missing)$/iu
const ANSWER_LENGTH_CONTROL_PATTERN = /^(?:(?:please\s+)?(?:(?:answer|reply|respond)\s+)?in\s+(?:a(?:\s+single)?|one|two|three|\d+)\s+(?:short\s+)?sentences?(?:\s+(?:from|using|based on)\s+(?:(?:my|our|the|your)\s+)?(?:memory|notes|records))?|(?:请)?(?:用|以)(?:一|两|二|三|\d+)句(?:话)?(?:简短|简要)?(?:回答|作答))$/iu
const CONTROL_PREFIX_PATTERNS = [
  /^(?:请)?(?:只|仅)?根据(?:已有|现有|当前|此前)?(?:记忆|资料|上下文)(?:内容)?(?:来)?\s*(?:(?:逐项|逐条|分别|简短|简洁|简要)\s*){0,2}(?:回答|作答)(?:\s*[：:]?\s*|(?=[^\s：:]))/u,
  /^(?:请)?(?:只|仅)?根据(?:已有|现有|当前|此前)?(?:记忆|资料|上下文)(?:内容)?(?:内容)?(?:来)?(?:\s*[：:]\s*|\s+|$)/u,
  /^(?:请)?(?:不要|别|请勿|不必|无需|不)(?:调用|使用)工具(?:\s*[：:]\s*|\s+|$)/u,
  /^(?:请)?(?:不要|别|请勿|不必|无需|不需要|禁止)(?:把|将)?(?:保存|记录|提炼|写入|记入)(?:到|进|入)?(?:这次|本次|本轮|当前|此次|这段|这条)?(?:问答|对话|聊天|消息|内容)(?:到|进|入)?(?:长期)?(?:记忆)?(?:\s*[：:]\s*|\s+|$)/u,
  /^(?:这次|本次|本轮|当前|此次|这段|这条)(?:问答|对话|聊天|消息|内容)(?:.{0,8})?(?:不要|别|请勿|不必|无需|禁止)(?:保存|记录|提炼|写入|记入)(?:到|进|入)?(?:长期)?(?:记忆)?(?:\s*[：:]\s*|\s+|$)/u,
]
const QUESTION_SUFFIX_PATTERN = /(?:分别|各自|各)?(?:是多少|是什么|为什么|为何|多少|几(?:个|次|秒|天|年)?|哪(?:个|种)|吗|呢|呀)$/u
const DISCUSSION_PATTERN = /(?:示例|例子|举例|例如|讨论|说明|解释|规则|文档|案例|引用|提到|这句话)/u
const NEGATED_MENTION_PATTERN = /(?:不是|并非|并不是|没有说|没说|不代表|不等于|无意要求|并未要求|非要)(?:\s*(?:说|要求|指|让|要)?\s*["“「『]?)$/u
const QUOTE_PAIRS = [['“', '”'], ['「', '」'], ['『', '』'], ['"', '"'], ["'", "'"]]

function isMentionedAsExample(text, index, length) {
  const before = text.slice(Math.max(0, index - 42), index)
  const after = text.slice(index + length, index + length + 42)
  if (NEGATED_MENTION_PATTERN.test(before)) return true
  const surrounding = `${before}${after}`
  if (!DISCUSSION_PATTERN.test(surrounding)) return false
  const quoted = QUOTE_PAIRS.some(([open, close]) => {
    const start = before.lastIndexOf(open)
    return start >= 0 && after.indexOf(close) >= 0
  })
  return quoted || /(?:示例|例子|举例|例如|讨论|说明|解释|规则|文档|案例|引用|提到).{0,30}$/u.test(before)
}

function containsUnquotedDirective(text, pattern) {
  for (const match of text.matchAll(pattern)) {
    if (!isMentionedAsExample(text, match.index, match[0].length)) return true
  }
  return false
}

const noSave = text => [CURRENT_NO_SAVE_PATTERN, GENERAL_NO_SAVE_PATTERN, SHORT_NO_SAVE_PATTERN]
  .some(pattern => containsUnquotedDirective(text, pattern))

function stripLeadingControlPrefix(clause) {
  let remaining = String(clause ?? '').trim()
  while (remaining !== '') {
    const prefix = CONTROL_PREFIX_PATTERNS.find((pattern) => pattern.test(remaining))
    if (prefix === undefined) break
    const next = remaining.replace(prefix, '').trim()
    if (next === remaining) break
    remaining = next
  }
  return remaining
}

function isControlClause(clause) {
  const normalized = stripLeadingControlPrefix(clause).replace(/^[“"「『(（\s]+/u, '')
  return /^(?:请)?(?:(?:简短|简洁|简要|逐项|分别)\s*){1,2}(?:回答|作答)/u.test(normalized) || ANSWER_CONTROL_PATTERN.test(normalized) || ANSWER_PRESENTATION_PATTERN.test(normalized) || VALUE_ONLY_CONTROL_PATTERN.test(normalized) || ITEMIZED_CONTROL_PATTERN.test(normalized) ||
    ANSWER_LENGTH_CONTROL_PATTERN.test(normalized) || ENGLISH_MEMORY_ONLY.test(normalized) || ENGLISH_FORMAT_CONTROL.test(normalized) || noSave(normalized)
}

function removeQuestionEnding(clause) {
  return clause
    .trim()
    .replace(/[?？!！。…]+$/u, '')
    .replace(QUESTION_SUFFIX_PATTERN, '')
    .replace(/[?？!！。…\s]+$/u, '')
    .trim()
}

/** Extract search text while retaining control intent for other host stages. */
export function analyzeUserMessageControls(value) {
  const text = String(value ?? '')
  const boundaries = [...sourceSentenceBreaks(text), ...text.matchAll(/[，,；;]/gu)]
    .sort((left, right) => left.index - right.index)
  const clauses = []
  let start = 0
  for (const boundary of boundaries) {
    if (boundary[0] === '.' && /\d/u.test(text[boundary.index - 1] ?? '')) continue
    clauses.push(text.slice(start, boundary.index))
    start = boundary.index + 1
  }
  clauses.push(text.slice(start))
  const retrieval = clauses
    .map(stripLeadingControlPrefix)
    .filter((clause) => clause.trim() !== '' && !isControlClause(clause))
  return {
    questionText: retrieval.join('，'),
    retrievalQuery: retrieval.map(removeQuestionEnding).filter(Boolean).join('，'),
    noSaveDirective: noSave(text),
    memoryOnlyDirective: clauses.some(clause => MEMORY_ONLY_CONTROL_PATTERN.test(clause.trim()) || ENGLISH_MEMORY_ONLY.test(clause.trim())),
  }
}

const REMEMBER_COMMAND = /^(?:(?:请(?:你)?|帮我|麻烦(?:你)?)\s*)?(?:记住|记下|记一下|别忘(?:了)?)\s*|^(?:please\s+)?remember(?:\s+(?:this|that))?(?=\s|[:：,，])\s*/iu

/** A standalone command refers to the previous user input in this session. */
export function isBareRemember(value) {
  return typeof value === 'string' && /^记住[。！!]*$/u.test(value.trim())
}

/** A direct command with explicit content, rather than a mention of the command. */
export function explicitRememberText(value) {
  const text = String(value ?? '').trim()
  const command = REMEMBER_COMMAND.exec(text)
  if (!command) return null
  const rest = text.slice(command[0].length).replace(/^(?:这(?:个|些|点|件事|条))?(?=\s*[:：,，])/u, '')
  const content = rest.replace(/^[\s:：,，]+/u, '').trim()
  if (content.length < 4 || /^(?:这个功能|这个词|这句话|的|意味着|代表|好了?|刚才|上面|前面|what\b)/iu.test(content) ||
      !/[^?？!！。\s]/u.test(content) || analyzeUserMessageControls(text).noSaveDirective) return null
  return content
}
