/** Shared parsing for factual queries and explicit user-turn controls. */

const CURRENT_NO_SAVE_PATTERN = /(?:不要|不得|不必|无需|不需要|禁止|请勿|别|不)\s*(?:把|将)?\s*(?:保存|记录|提炼|写入|记入)(?:到|进|入)?(?:这次|本次|本轮|当前|此次|这段|这条)?(?:问答|对话|聊天|消息|内容)(?:到|进|入)?(?:长期)?(?:记忆)?|(?:不要|不得|不必|无需|不需要|禁止|请勿|别|不)\s*(?:把|将)?\s*(?:这次|本次|本轮|当前|此次|这段|这条)(?:问答|对话|聊天|消息|内容)(?:.{0,8})?(?:保存|记录|提炼|写入|记入)(?:到|进|入)?(?:长期)?(?:记忆)?|(?:这次|本次|本轮|当前|此次|这段|这条)(?:问答|对话|聊天|消息|内容)(?:.{0,8})?(?:不要|不得|不必|无需|禁止|请勿|别)(?:保存|记录|提炼|写入|记入)(?:到|进|入)?(?:长期)?(?:记忆)?/giu
const GENERAL_NO_SAVE_PATTERN = /(?:不要|不得|不必|无需|禁止|不)(?:保存|记录|提炼|写入)(?:到)?(?:长期)?记忆|do not (?:save|store|remember) (?:this|these)|don['’]t (?:save|store|remember) (?:this|these)/giu
const ANSWER_CONTROL_PATTERN = /^(?:(?:只|仅)?根据.{0,40}(?:记忆|已有资料|现有信息)|(?:每项|每个|每条)(?:都)?(?:用|按).{0,80}(?:回答|输出)|(?:没有|若无|如果没有)依据.{0,50}(?:不记得|不知道|写|回答)|(?:请)?(?:不要|别|请勿|不必|无需)(?:调用|使用)工具|(?:只|仅)(?:输出|回答).{0,50}|(?:回答|输出)(?:格式|要求)|工具名\s*[:：])/iu
const CONTROL_PREFIX_PATTERNS = [
  /^(?:请)?(?:只|仅)?根据(?:已有|现有|当前|此前)?(?:记忆|资料|上下文)(?:内容)?(?:来)?(?:回答|作答)(?:\s*[：:]?\s*|(?=[^\s：:]))/u,
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
  return /^(?:请)?(?:(?:简短|简洁|简要|逐项|分别)\s*){1,2}(?:回答|作答)/u.test(normalized) || ANSWER_CONTROL_PATTERN.test(normalized) ||
    containsUnquotedDirective(normalized, CURRENT_NO_SAVE_PATTERN) ||
    containsUnquotedDirective(normalized, GENERAL_NO_SAVE_PATTERN)
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
  const clauses = text.split(/(?:[，,。！？!?；;\n]+|(?<!\d)\.(?=\s|$))/u)
  const retrieval = clauses
    .map(stripLeadingControlPrefix)
    .filter((clause) => clause.trim() !== '' && !isControlClause(clause))
    .map(removeQuestionEnding)
    .filter(Boolean)
  return {
    retrievalQuery: retrieval.join('，'),
    noSaveDirective: containsUnquotedDirective(text, CURRENT_NO_SAVE_PATTERN) ||
      containsUnquotedDirective(text, GENERAL_NO_SAVE_PATTERN),
  }
}
