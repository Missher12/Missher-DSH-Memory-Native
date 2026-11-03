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

export const MAX_MEMORIES_PER_PASS = 4
export const MAX_TRANSCRIPT_MESSAGE_CHARS = 2400
export const MAX_TRANSCRIPT_CHARS = 16000
export const MAX_EXISTING = 6
export const MAX_EXISTING_CONTENT_CHARS = 80

const RULES = `你是记忆抽取器。从对话中提取跨会话仍有价值的信息，只输出 JSON。

类型：preference（用户稳定偏好/习惯）、fact（项目/技术事实、约束、环境）、decision（已做出的选择及理由）、episode（任务中可复用的教训）。
不保存：一次性细节、未确认猜测、助手建议、敏感信息（密钥/密码/证件）、与已有记忆完全重复的内容。

操作：ADD 新增；UPDATE 补充或修正（targetId=旧 id）；SUPERSEDE 旧事实失效（targetId=旧 id）；NOOP 无可存内容（memories 为空数组）。

要求：
- content 一句完整、可独立理解，保持原文语言，不超过 120 字。
- scope 只能是 global（跨项目偏好）或 project（当前项目）。
- confidence 与 importance 取 0..1，不确定的给低 confidence。
- topic 是 2–8 字主题标签，没有就留空字符串。
- 最多输出 4 条，宁少勿多；只输出 JSON，不要解释，不要 markdown 代码块。

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
    : existing.slice(0, MAX_EXISTING).map((record) => {
      const content = String(record.content ?? '').replace(/\s+/gu, ' ').trim()
      const clipped = content.length > MAX_EXISTING_CONTENT_CHARS
        ? `${content.slice(0, MAX_EXISTING_CONTENT_CHARS - 1)}…`
        : content
      return `- [${record.id}] (${record.kind}/${record.status}) ${clipped}`
    }).join('\n')
  const transcript = String(input.transcript ?? '').slice(0, MAX_TRANSCRIPT_CHARS)
  return [
    RULES,
    '',
    '## 已有相关记忆',
    existingText,
    '',
    '## 本次对话',
    transcript,
  ].join('\n')
}

/**
 * Recover complete items from a truncated `memories` array.
 *
 * With a 400-token output cap a long JSON payload can be cut mid-object; the
 * leading, fully written objects are still usable. Returns `null` when no
 * complete object can be recovered.
 * @param {string} raw
 */
function salvageMemories(raw) {
  const text = String(raw ?? '')
  const key = text.indexOf('"memories"')
  if (key < 0) return null
  const open = text.indexOf('[', key)
  if (open < 0) return null
  const items = []
  let depth = 0
  let objectStart = -1
  let inString = false
  let escaped = false
  for (let index = open + 1; index < text.length; index += 1) {
    const char = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
    } else if (char === '{') {
      if (depth === 0) objectStart = index
      depth += 1
    } else if (char === '}') {
      if (depth === 0) continue
      depth -= 1
      if (depth === 0 && objectStart >= 0) {
        try {
          const item = JSON.parse(text.slice(objectStart, index + 1))
          if (item !== null && typeof item === 'object' && !Array.isArray(item)) items.push(item)
        } catch {
          // One corrupt item does not invalidate its neighbours.
        }
        objectStart = -1
      }
    } else if (char === ']' && depth === 0) {
      break
    }
    if (items.length >= MAX_MEMORIES_PER_PASS) break
  }
  return items.length === 0 ? null : items
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
    const salvaged = salvageMemories(text)
    if (salvaged === null) throw new Error('extraction response is not valid JSON')
    parsed = { memories: salvaged }
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
