/**
 * Recall evaluation: a small labelled corpus + hit@5 / precision@5 / MRR.
 *
 * Run with the bundled Node:
 *   <node> scripts/eval-recall.mjs
 *
 * Exit code is 1 when hit@5 drops below BASELINE_HIT_RATE, so this can gate
 * changes to ranking, tokenization or the merge policy.
 */

import { buildRecord } from '../host/records.js'
import { MemoryIndex } from '../host/search.js'
import { rankHits } from '../host/recall.js'

const NOW = 1_764_000_000_000
const PROJECT = 'DSH-Eval-001'
const BASELINE_HIT_RATE = 0.8

const RECORDS = [
  { id: 'mem_ev_01', kind: 'fact', scope: 'project', content: '该仓库使用 pnpm 管理依赖，并要求 Node 22 以上', tags: ['pnpm', 'node'] },
  { id: 'mem_ev_02', kind: 'decision', scope: 'project', content: '记忆采用 JSONL 作为权威存储，索引在进程内重建', tags: ['存储', 'jsonl'] },
  { id: 'mem_ev_03', kind: 'decision', scope: 'project', content: '检索使用 BM25 加 CJK bigram 分词，不引入向量库', tags: ['检索', 'bm25'] },
  { id: 'mem_ev_04', kind: 'fact', scope: 'project', content: '上下文注入走 agent/pre-step，每步幂等替换旧块，预算 600 token', tags: ['注入'] },
  { id: 'mem_ev_05', kind: 'preference', scope: 'global', content: '用户偏好简洁直接的中文回答，少客套', tags: ['沟通'] },
  { id: 'mem_ev_06', kind: 'preference', scope: 'global', content: '用户偏好紧凑单行布局，能一行排下就不要折行', tags: ['布局'] },
  { id: 'mem_ev_07', kind: 'preference', scope: 'global', content: '用户要求界面设计先用可交互的 HTML demo 预览，再落到真实面板', tags: ['流程'] },
  { id: 'mem_ev_08', kind: 'fact', scope: 'project', content: '插件用普通 JavaScript 实现，不引入 TypeScript 构建', tags: ['实现'] },
  { id: 'mem_ev_09', kind: 'episode', scope: 'project', content: 'Typert 端点不能与命名空间服务同名的 remove，冲突会导致整个挂载失败', tags: ['typert'] },
  { id: 'mem_ev_10', kind: 'episode', scope: 'project', content: '面板 RPC 失败时先看 panel-calls.jsonl 是否出现浏览器来源调用', tags: ['调试'] },
  { id: 'mem_ev_11', kind: 'fact', scope: 'project', content: '用户画像只聚合 active 且置信度不低于 0.55 的偏好，并带证据条数', tags: ['画像'] },
  { id: 'mem_ev_12', kind: 'fact', scope: 'project', content: '抽取结果会生成 topic 主题标签并参与检索', tags: ['主题'] },
  { id: 'mem_ev_13', kind: 'decision', scope: 'project', content: '时间衰减：偏好 60 天半衰期，其它类型 90 天，只降权不删除', tags: ['衰减'] },
  { id: 'mem_ev_14', kind: 'decision', scope: 'project', content: '近重复语句 Jaccard 不低于 0.9 时合并并提升置信度', tags: ['去重'] },
  { id: 'mem_ev_15', kind: 'fact', scope: 'project', content: '回合内缓冲超过 20000 字符会立即增量抽取，每回合最多两次', tags: ['长对话'] },
  { id: 'mem_ev_16', kind: 'fact', scope: 'project', content: '自动捕获默认每天最多 50 次 LLM 调用，显式记住会绕过预算', tags: ['预算'] },
  { id: 'mem_ev_17', kind: 'preference', scope: 'global', content: '用户希望所有回复使用中文', tags: ['语言'] },
  { id: 'mem_ev_18', kind: 'preference', scope: 'global', content: '用户要求交付前测试全绿并给出验证证据', tags: ['质量'] },
  { id: 'mem_ev_19', kind: 'decision', scope: 'project', content: '刻意不做向量检索与知识图谱，保持零依赖与可重建', tags: ['边界'] },
  { id: 'mem_ev_20', kind: 'fact', scope: 'project', content: '面板指标区采用 C 方案：主指标卡与洞察卡并排', tags: ['面板'] },
  { id: 'mem_ev_21', kind: 'preference', scope: 'global', content: '用户要求先更新设计需求文档，再改界面代码', tags: ['流程'] },
  { id: 'mem_ev_22', kind: 'fact', scope: 'project', content: 'Typert 描述符是手写的，不需要 codegen', tags: ['typert'] },
  { id: 'mem_ev_23', kind: 'fact', scope: 'project', content: '面板会显示用户画像卡，最多三行，带证据数与置信度', tags: ['画像'] },
  { id: 'mem_ev_24', kind: 'decision', scope: 'project', content: '支持导出、导入与备份，导入按 revision 去重合并', tags: ['备份'] },
  { id: 'mem_ev_25', kind: 'fact', scope: 'project', content: '写入使用进程锁与 fsync，压缩前在锁内重新读取', tags: ['可靠性'] },
  { id: 'mem_ev_26', kind: 'fact', scope: 'project', content: '召回评分融合 BM25、recency、importance、confidence 与类型权重', tags: ['召回'] },
]

const CASES = [
  { query: 'pnpm Node 版本要求', expected: ['mem_ev_01'] },
  { query: '仓库用什么包管理器', expected: ['mem_ev_01'] },
  { query: 'JSONL 权威存储', expected: ['mem_ev_02'] },
  { query: '索引怎么重建', expected: ['mem_ev_02'] },
  { query: 'BM25 中文分词', expected: ['mem_ev_03'] },
  { query: '为什么不用向量检索', expected: ['mem_ev_03', 'mem_ev_19'] },
  { query: '注入预算是多少', expected: ['mem_ev_04'] },
  { query: 'pre-step 注入', expected: ['mem_ev_04'] },
  { query: '用户喜欢什么风格的回答', expected: ['mem_ev_05'] },
  { query: '布局要紧凑单行', expected: ['mem_ev_06'] },
  { query: '界面先看 HTML demo', expected: ['mem_ev_07'] },
  { query: '插件用 TypeScript 吗', expected: ['mem_ev_08'] },
  { query: 'Typert remove 冲突', expected: ['mem_ev_09'] },
  { query: '面板调用怎么调试', expected: ['mem_ev_10'] },
  { query: '画像置信度阈值', expected: ['mem_ev_11'] },
  { query: '主题标签参与检索', expected: ['mem_ev_12'] },
  { query: '半衰期多久', expected: ['mem_ev_13'] },
  { query: '重复语句怎么合并', expected: ['mem_ev_14'] },
  { query: '长对话怎么抽取', expected: ['mem_ev_15'] },
  { query: '每天最多几次 LLM 调用', expected: ['mem_ev_16'] },
  { query: '回复语言要求', expected: ['mem_ev_17'] },
  { query: '交付前要测试全绿', expected: ['mem_ev_18'] },
  { query: '为什么不做知识图谱', expected: ['mem_ev_19'] },
  { query: '面板指标区是哪个方案', expected: ['mem_ev_20'] },
  { query: '先文档还是先代码', expected: ['mem_ev_21'] },
  { query: '描述符需要 codegen 吗', expected: ['mem_ev_22'] },
  { query: '画像卡显示什么', expected: ['mem_ev_23'] },
  { query: '导入去重规则', expected: ['mem_ev_24'] },
  { query: '写入怎么保证不丢', expected: ['mem_ev_25'] },
  { query: '召回评分包含哪些因素', expected: ['mem_ev_26'] },
]

const records = RECORDS.map((record) => {
  const built = buildRecord({ ...record, projectKey: record.scope === 'global' ? null : PROJECT }, { now: NOW, id: record.id })
  if (built.ok !== true) throw new Error(`fixture record ${record.id} is invalid: ${built.reason}`)
  return built.record
})

const index = new MemoryIndex().rebuild(records)
let hitsAt5 = 0
let precisionSum = 0
let reciprocalRankSum = 0
const failures = []

for (const item of CASES) {
  const expected = new Set(item.expected)
  const candidates = index.search(item.query, {
    statuses: ['active', 'candidate'],
    scopes: ['project', 'global'],
    projectKey: PROJECT,
    now: NOW,
    limit: 20,
  })
  const ranked = rankHits(candidates, { now: NOW, maxItems: 5, minScore: 0 })
  const top = ranked.slice(0, 5)
  const matched = top.filter((hit) => expected.has(hit.record.id))
  if (matched.length > 0) hitsAt5 += 1
  precisionSum += top.length === 0 ? 0 : matched.length / top.length
  const firstIndex = top.findIndex((hit) => expected.has(hit.record.id))
  reciprocalRankSum += firstIndex === -1 ? 0 : 1 / (firstIndex + 1)
  if (matched.length === 0) {
    failures.push({ query: item.query, expected: item.expected, got: top.map((hit) => `${hit.record.id}:${hit.record.content.slice(0, 24)}`) })
  }
}

const hitRate = hitsAt5 / CASES.length
const result = {
  cases: CASES.length,
  hitAt5: Number(hitRate.toFixed(3)),
  precisionAt5: Number((precisionSum / CASES.length).toFixed(3)),
  mrr: Number((reciprocalRankSum / CASES.length).toFixed(3)),
  baseline: BASELINE_HIT_RATE,
  failures,
}
console.log(JSON.stringify(result, null, 2))
if (hitRate < BASELINE_HIT_RATE) process.exitCode = 1
