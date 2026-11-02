/**
 * Extraction prompt + response parsing.
 *
 * The prompt asks for a strict JSON payload of memory operations. `parse()`
 * accepts the model's text, tolerates a fenced code block and surrounding
 * prose, and returns the operation list. Validation of each item stays in
 * `records.buildRecord`, so a malformed item never reaches the store.
 *
 * @module dsh-memory/host/extract
 */

import { normalizeContent } from './records.js'

export const MAX_MEMORIES_PER_PASS = 8
export const MAX_TRANSCRIPT_MESSAGE_CHARS = 2400

const RULES = `你是记忆抽取器。从下面这一段对话里，找出"跨会话仍然有价值"的信息，输出 JSON。

只保存：
1) preference：用户稳定的偏好、习惯、沟通方式（例如语言、格式、工作方式）。
2) fact：项目或技术事实、约束、环境（例如仓库使用的工具、版本要求、外部系统限制）。
3) decision：已经做出的选择及其理由（例如选定某种存储方案）。
4) episode：一次任务经历中可复用的教训（失败原因、成功关键、踩过的坑）。

不保存：
- 一次性的任务细节、临时状态、尚未确认的猜测；
- 助手自己的建议、假设或客套话（除非用户明确采纳）；
- 密钥、密码、令牌、私钥、身份证号等敏感信息；
- 与已有记忆完全重复的内容。

你可以对已有记忆做四种操作：
- ADD：新增一条此前不存在的记忆。
- UPDATE：同一事实有补充或修正，targetId 指向已有记忆。
- SUPERSEDE：旧事实已失效、被新事实替代，targetId 指向旧记忆。
- NOOP：这段对话没有值得保存的信息（此时 memories 可为空数组）。

要求：
- content 用一句完整、可独立理解的陈述，保持对话原文语言（中文就中文，英文就英文），不超过 200 字。
- scope 只能是 "global"（跨项目的用户偏好）或 "project"（仅当前项目有效）。
- confidence 与 importance 取 0..1；不确定的给低 confidence。
- topic 是一个 2–8 字的主题标签（如「存储」「部署」「沟通偏好」），用于分组；没有合适主题就留空字符串。
- 最多输出 ${MAX_MEMORIES_PER_PASS} 条。
- 只输出 JSON，不要解释，不要 markdown 代码块。

输出格式：
{"memories":[{"op":"ADD","kind":"fact","scope":"project","content":"…","topic":"…","tags":["…"],"confidence":0.8,"importance":0.6,"targetId":null}],"skipReason":""}`

/**
 * Build the single user message text for one extraction pass.
 * @param {{ transcript: string, existing: object[], now: number }} input
 */
export function buildExtractionPrompt(input) {
  const existing = Array.isArray(input.existing) ? input.existing : []
  const existingText = existing.length === 0
    ? '（暂无相关旧记忆）'
    : existing.slice(0, 12).map((record) => `- [${record.id}] (${record.kind}/${record.status}) ${record.content}`).join('\n')
  const transcript = String(input.transcript ?? '').slice(0, 24000)
  return [
    RULES,
    '',
    '## 已有的相关记忆',
    existingText,
    '',
    '## 本次对话',
    transcript,
  ].join('\n')
}

/** Turn the model text into an operation list. Throws on unusable output. */
export function parseExtraction(raw) {
  const text = String(raw ?? '')
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('extraction response contains no JSON object')
  let parsed
  try {
    parsed = JSON.parse(text.slice(start, end + 1))
  } catch {
    throw new Error('extraction response is not valid JSON')
  }
  if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.memories)) {
    throw new Error('extraction response has no memories array')
  }
  const items = []
  for (const rawItem of parsed.memories.slice(0, MAX_MEMORIES_PER_PASS)) {
    if (rawItem === null || typeof rawItem !== 'object') continue
    const op = typeof rawItem.op === 'string' ? rawItem.op.toUpperCase() : 'ADD'
    if (!['ADD', 'UPDATE', 'SUPERSEDE', 'NOOP'].includes(op)) continue
    const content = normalizeContent(rawItem.content)
    if (op === 'NOOP') continue
    if (content === '') continue
    items.push({
      op,
      targetId: typeof rawItem.targetId === 'string' && rawItem.targetId !== '' ? rawItem.targetId : null,
      kind: typeof rawItem.kind === 'string' ? rawItem.kind : 'fact',
      scope: typeof rawItem.scope === 'string' ? rawItem.scope : 'project',
      content,
      topic: typeof rawItem.topic === 'string' ? rawItem.topic : null,
      tags: Array.isArray(rawItem.tags) ? rawItem.tags : [],
      confidence: typeof rawItem.confidence === 'number' ? rawItem.confidence : 0.5,
      importance: typeof rawItem.importance === 'number' ? rawItem.importance : 0.5,
      validFrom: typeof rawItem.validFrom === 'number' ? rawItem.validFrom : null,
      validTo: typeof rawItem.validTo === 'number' ? rawItem.validTo : null,
    })
  }
  return { items, skipReason: typeof parsed.skipReason === 'string' ? parsed.skipReason : '' }
}
