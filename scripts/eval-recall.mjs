/**
 * Retrieval-only recall evaluation.
 *
 * The original fixed 30-question corpus stays as a regression set. A separate
 * hard set covers long-message first/middle/end facts, more than three segments,
 * cross-session facts, multi-fact composition, paraphrase, temporal updates and
 * no-answer negatives. These are retrieval checks; they do not claim to measure
 * end-to-end model answers.
 *
 * `precisionAtMost5` divides by returned rows; standard `precisionAt5` divides
 * by 5. Both are reported so the metric is never ambiguous.
 *
 * Run with the bundled Node:
 *   <node> scripts/eval-recall.mjs
 *
 * Exit code is 1 when the regression hit@5 drops below BASELINE_HIT_RATE.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../index.js'
import { projectIdentity } from '../host/paths.js'
import { buildRecord } from '../host/records.js'
import { MemoryIndex } from '../host/search.js'
import { MemoryStore } from '../host/store.js'
import { classifyRecallHits, compileMemoryContext, hasContentMatch, isHistoricalQuery, rankHits } from '../host/recall.js'

const NOW = 1_764_000_000_000
const PROJECT = 'DSH-Eval-001'
const BASELINE_HIT_RATE = 0.95
let grayQueries = 0

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
  { query: '索引怎么重建', expected: ['mem_ev_02', 'mem_ev_03'] },
  { query: 'BM25 中文分词', expected: ['mem_ev_03', 'mem_ev_26'] },
  { query: '为什么不用向量检索', expected: ['mem_ev_03', 'mem_ev_19'] },
  { query: '注入预算是多少', expected: ['mem_ev_04', 'mem_ev_16'] },
  { query: 'pre-step 注入', expected: ['mem_ev_04'] },
  { query: '用户喜欢什么风格的回答', expected: ['mem_ev_05', 'mem_ev_17'] },
  { query: '布局要紧凑单行', expected: ['mem_ev_06'] },
  { query: '界面先看 HTML demo', expected: ['mem_ev_07', 'mem_ev_21'] },
  { query: '插件用 TypeScript 吗', expected: ['mem_ev_08', 'mem_ev_19'] },
  { query: 'Typert remove 冲突', expected: ['mem_ev_09', 'mem_ev_22'] },
  { query: '面板调用怎么调试', expected: ['mem_ev_10'] },
  { query: '画像置信度阈值', expected: ['mem_ev_11', 'mem_ev_23'] },
  { query: '主题标签参与检索', expected: ['mem_ev_12'] },
  { query: '半衰期多久', expected: ['mem_ev_13'] },
  { query: '重复语句怎么合并', expected: ['mem_ev_14'] },
  { query: '长对话怎么抽取', expected: ['mem_ev_15', 'mem_ev_16'] },
  { query: '每天最多几次 LLM 调用', expected: ['mem_ev_16', 'mem_ev_04'] },
  { query: '回复语言要求', expected: ['mem_ev_17', 'mem_ev_05'] },
  { query: '交付前要测试全绿', expected: ['mem_ev_18'] },
  { query: '为什么不做知识图谱', expected: ['mem_ev_19', 'mem_ev_03'] },
  { query: '面板指标区是哪个方案', expected: ['mem_ev_20', 'mem_ev_23'] },
  { query: '先文档还是先代码', expected: ['mem_ev_21', 'mem_ev_07'] },
  { query: '描述符需要 codegen 吗', expected: ['mem_ev_22', 'mem_ev_09'] },
  { query: '画像卡显示什么', expected: ['mem_ev_23', 'mem_ev_11'] },
  { query: '导入去重规则', expected: ['mem_ev_24', 'mem_ev_02'] },
  { query: '写入怎么保证不丢', expected: ['mem_ev_25', 'mem_ev_02'] },
  { query: '召回评分包含哪些因素', expected: ['mem_ev_26', 'mem_ev_03'] },
]

const records = RECORDS.map((record) => {
  const built = buildRecord({ ...record, projectKey: record.scope === 'global' ? null : PROJECT }, { now: NOW, id: record.id })
  if (built.ok !== true) throw new Error(`fixture record ${record.id} is invalid: ${built.reason}`)
  return built.record
})

const index = new MemoryIndex().rebuild(records)

function percent(value, base) {
  return base === 0 ? 0 : Number((value / base).toFixed(3))
}

function evaluateSet(cases, searchIndex, { includeCandidate = false } = {}) {
  let hitsAt5 = 0
  let precisionAtMost5Sum = 0
  let precisionAt5Count = 0
  let reciprocalRankSum = 0
  let evidenceMatched = 0
  let evidenceRequired = 0
  let injected = 0
  let noAnswerInjected = 0
  let wrongRecallQueries = 0
  const failures = []
  for (const item of cases) {
    const expected = new Set(item.expected)
    const historical = item.historical === true || isHistoricalQuery(item.query)
    const raw = searchIndex.search(item.query, {
      statuses: historical ? ['active', 'superseded'] : includeCandidate ? ['active', 'candidate'] : ['active'],
      includeExpired: historical,
      scopes: ['project', 'global'],
      projectKey: PROJECT,
      now: NOW,
      limit: 20,
    })
    const candidates = raw.filter((hit) => hasContentMatch(hit.matched))
    const gate = classifyRecallHits(candidates, item.query, { indexSize: searchIndex.size, idfOf: (term) => searchIndex.idfOf(term) })
    const ranked = rankHits(gate.auto, { now: NOW, maxItems: 5, minScore: 0 })
    grayQueries += gate.gray.length > 0 && gate.auto.length === 0 ? 1 : 0
    const top = ranked.slice(0, 5)
    const matched = top.filter((hit) => expected.has(hit.record.id))
    const block = compileMemoryContext(ranked, { maxTokens: 360, maxItems: 5 })
    if (block !== null) injected += 1
    if (expected.size === 0) {
      if (top.length > 0) noAnswerInjected += 1
    } else {
      if (matched.length > 0) hitsAt5 += 1
      if (top.some((hit) => !expected.has(hit.record.id))) wrongRecallQueries += 1
      precisionAtMost5Sum += top.length === 0 ? 0 : matched.length / top.length
      precisionAt5Count += matched.length
      evidenceMatched += matched.length
      evidenceRequired += expected.size
      const firstIndex = top.findIndex((hit) => expected.has(hit.record.id))
      reciprocalRankSum += firstIndex === -1 ? 0 : 1 / (firstIndex + 1)
      if (item.all === true && matched.length < expected.size) {
        failures.push({ query: item.query, expected: item.expected, got: top.map((hit) => hit.record.id) })
      } else if (matched.length === 0) {
        failures.push({ query: item.query, expected: item.expected, got: top.map((hit) => hit.record.id) })
      }
    }
  }
  const answerable = cases.filter((item) => item.expected.length > 0).length
  return {
    cases: cases.length,
    hitAt5: percent(hitsAt5, answerable),
    necessaryEvidenceCoverage: percent(evidenceMatched, evidenceRequired),
    precisionAtMost5: percent(precisionAtMost5Sum, answerable),
    precisionAt5: percent(precisionAt5Count, answerable * 5),
    mrr: percent(reciprocalRankSum, answerable),
    injectionRate: percent(injected, cases.length),
    noAnswerCases: cases.filter((item) => item.expected.length === 0).length,
    noAnswerInjected,
    wrongRecallQueries,
    failures,
  }
}

const regression = evaluateSet(CASES, index, { includeCandidate: true })

// Hard set: deliberately independent of the fixed 30-question regression.
const HARD_RECORDS = [
  { id: 'mem_hd_long_first', content: '长消息开头：生产部署目录是 /srv/app', tags: ['部署'] },
  { id: 'mem_hd_long_mid', content: '长消息中间：发布前必须运行数据库迁移', tags: ['部署'] },
  { id: 'mem_hd_long_end', content: '长消息末尾：回滚使用上一版镜像', tags: ['部署'] },
  { id: 'mem_hd_seg_1', content: '第一段：网关超时是 30 秒', tags: ['网关'] },
  { id: 'mem_hd_seg_2', content: '第二段：失败重试次数是 3 次', tags: ['网关'] },
  { id: 'mem_hd_seg_3', content: '第三段：失败后告警到值班群', tags: ['告警'] },
  { id: 'mem_hd_seg_4', content: '第四段：日志保留 14 天', tags: ['日志'] },
  { id: 'mem_hd_cross_a', content: '会话 A 决定项目使用 pnpm 管理依赖', tags: ['pnpm'] },
  { id: 'mem_hd_cross_b', content: '会话 B 记录运行时要求 Node 22 以上', tags: ['node'] },
  { id: 'mem_hd_multi_db', content: '生产环境数据库是 PostgreSQL 16', tags: ['数据库'] },
  { id: 'mem_hd_multi_cache', content: '生产环境缓存使用 Redis 7', tags: ['缓存'] },
  { id: 'mem_hd_para', content: '依赖安装使用 pnpm，不使用 npm', tags: ['pnpm'] },
  { id: 'mem_hd_old', content: 'Node 版本要求是 22', tags: ['node'] },
  { id: 'mem_hd_new', content: 'Node 版本要求是 24', tags: ['node'] },
]
const hardRecords = HARD_RECORDS.map((record) => {
  const built = buildRecord({ ...record, kind: 'fact', scope: 'project', projectKey: PROJECT, confidence: 0.9 }, { now: NOW, id: record.id })
  if (built.ok !== true) throw new Error(`hard fixture ${record.id} invalid: ${built.reason}`)
  return built.record
})
const oldIndex = hardRecords.findIndex((record) => record.id === 'mem_hd_old')
hardRecords[oldIndex] = { ...hardRecords[oldIndex], status: 'superseded', validTo: NOW - 1000 }
const hardIndex = new MemoryIndex().rebuild(hardRecords)
const HARD_CASES = [
  { query: '长消息开头 部署目录', expected: ['mem_hd_long_first'] },
  { query: '发布前数据库迁移', expected: ['mem_hd_long_mid'] },
  { query: '回滚镜像', expected: ['mem_hd_long_end'] },
  { query: '网关超时和失败重试次数', expected: ['mem_hd_seg_1', 'mem_hd_seg_2'], all: true },
  { query: 'pnpm 依赖和 Node 版本', expected: ['mem_hd_cross_a', 'mem_hd_cross_b'], all: true },
  { query: '生产数据库和缓存分别是什么', expected: ['mem_hd_multi_db', 'mem_hd_multi_cache'], all: true },
  { query: '安装依赖用什么工具', expected: ['mem_hd_para'] },
  { query: '现在 Node 版本要求是什么', expected: ['mem_hd_new'] },
  { query: '以前 Node 版本要求是什么', expected: ['mem_hd_old'], historical: true },
  { query: '量子计算芯片价格多少', expected: [] },
  { query: '火星基地的年度预算是多少', expected: [] },
]
const hard = evaluateSet(HARD_CASES, hardIndex)

// Fixed holdout, separate from the 30-question regression and hard tuning set.
// It runs through apply() and the registered agent/pre-step handler below.
const PRESTEP_RECORDS = [
  { id: 'mem_ho_pnpm', project: 'main', content: '项目当前使用 pnpm 9.14 管理依赖', tags: ['pnpm', '依赖'] },
  { id: 'mem_ho_node', project: 'main', content: '项目当前 Node.js 版本要求为 22.19 以上', tags: ['node', '版本'] },
  { id: 'mem_ho_lockfile', project: 'main', content: 'pnpm-lock.yaml 锁定当前依赖解析结果', tags: ['pnpm', '依赖'] },
  { id: 'mem_ho_node_api', project: 'main', content: 'Node.js 运行时通过事件循环处理异步任务', tags: ['node'] },
  { id: 'mem_ho_backup_a', project: 'main', content: '发布前生成数据库快照', tags: ['发布', '数据库'] },
  { id: 'mem_ho_backup_b', project: 'main', content: '发布前先备份数据库状态', tags: ['发布', '数据库'] },
  { id: 'mem_ho_backup_related', project: 'main', content: '数据库快照保留 7 天', tags: ['数据库'] },
  { id: 'mem_ho_db', project: 'main', content: '生产数据库运行 PostgreSQL 16', tags: ['数据库'] },
  { id: 'mem_ho_cache', project: 'main', content: '生产缓存运行 Redis 7', tags: ['缓存'] },
  { id: 'mem_ho_old_node', project: 'main', content: '项目 Node.js 主版本要求为 20', tags: ['node', '版本'] },
  { id: 'mem_ho_new_node', project: 'main', content: '项目 Node.js 主版本要求为 22', tags: ['node', '版本'] },
  { id: 'mem_ho_forgotten', project: 'main', content: '已删除的部署标识是 DEL-FORGET-88', tags: ['部署'] },
  { id: 'mem_ho_beta', project: 'other', content: 'Beta 项目专用缓存实例编号为 BETA-CACHE-771', tags: ['缓存'] },
  { id: 'mem_ho_alpha', project: 'main', content: 'Alpha 项目使用 Redis 7', tags: ['redis'] },
  { id: 'mem_ho_alpha_other', project: 'other', content: 'Alpha 项目使用 Redis 9', tags: ['redis'] },
  { id: 'mem_ho_qualifier', project: 'main', content: '测试账号仅用于 staging，不允许连接 production；此限制只适用于 beta 环境', tags: ['测试账号'] },
  { id: 'mem_ho_profile', scope: 'global', kind: 'preference', content: '用户偏好简短的中文回答', tags: ['回答风格'] },
]

const PRESTEP_CASES = [
  {
    id: 'compound_pnpm_node', project: 'main', query: 'pnpm 依赖和 Node 版本',
    required: ['mem_ho_pnpm', 'mem_ho_node'], alternatives: [],
    relevant: ['mem_ho_lockfile', 'mem_ho_node_api', 'mem_ho_new_node'], forbidden: ['mem_ho_forgotten', 'mem_ho_beta'],
    forbiddenValues: ['用户偏好简短的中文回答'],
  },
  {
    id: 'acceptable_alternative', project: 'main', query: '发布前数据库备份策略',
    required: [], alternatives: [['mem_ho_backup_a', 'mem_ho_backup_b']],
    relevant: ['mem_ho_backup_related'], forbidden: [],
  },
  {
    id: 'two_required_values', project: 'main', query: '生产数据库和缓存版本分别是什么',
    required: ['mem_ho_db', 'mem_ho_cache'], alternatives: [], relevant: [], forbidden: [],
  },
  {
    id: 'current_value', project: 'main', query: '现在 Node.js 主版本要求是多少',
    required: ['mem_ho_new_node'], alternatives: [], relevant: ['mem_ho_node'], forbidden: ['mem_ho_old_node'],
  },
  {
    id: 'historical_value', project: 'main', query: '以前 Node.js 主版本要求是多少',
    required: ['mem_ho_old_node'], alternatives: [], relevant: ['mem_ho_new_node', 'mem_ho_node'], forbidden: [],
  },
  {
    id: 'forgotten_value', project: 'main', query: '已删除的部署标识是什么',
    required: [], alternatives: [], relevant: [], forbidden: ['mem_ho_forgotten'],
  },
  {
    id: 'no_answer', project: 'main', query: 'Zephyria 行星环的直径是多少',
    required: [], alternatives: [], relevant: [], forbidden: [],
  },
  {
    id: 'project_isolation', project: 'main', query: 'Beta 项目专用缓存实例编号是多少',
    required: [], alternatives: [], relevant: [], forbidden: ['mem_ho_beta'],
  },
  {
    id: 'same_name_project_isolation', project: 'main', query: 'Alpha 项目 Redis 版本是多少',
    required: ['mem_ho_alpha'], alternatives: [], relevant: [], forbidden: ['mem_ho_alpha_other'],
  },
  {
    id: 'short_follow_up', project: 'main', query: '继续',
    messages: [
      { role: 'user', content: 'pnpm 依赖和 Node 版本' },
      { role: 'user', source: { kind: 'memory', plugin: 'dsh-memory' }, content: [{ type: 'text', text: '内部注入假值 Node 99' }] },
      { role: 'assistant', content: '我整理好了。' },
      { role: 'user', content: '继续' },
      { role: 'user', source: { kind: 'model-selection', form: 'notice' }, content: '内部说明，不是当前问题' },
    ],
    required: ['mem_ho_pnpm', 'mem_ho_node'], alternatives: [], relevant: ['mem_ho_new_node', 'mem_ho_lockfile'], forbidden: [],
  },
  {
    id: 'complete_qualifier', project: 'main', query: '测试账号是否允许连接 production',
    required: ['mem_ho_qualifier'], alternatives: [], relevant: [], forbidden: [],
    requiredText: '测试账号仅用于 staging，不允许连接 production；此限制只适用于 beta 环境',
  },
  {
    id: 'single_fact_regression', project: 'main', query: 'pnpm 包管理器',
    required: ['mem_ho_pnpm'], alternatives: [], relevant: [], forbidden: [],
  },
  {
    id: 'preference_profile', project: 'main', query: '用户偏好什么回答风格',
    required: ['mem_ho_profile'], alternatives: [], relevant: [], forbidden: [],
  },
]

async function evaluateProductionPreStep({ fixtures = PRESTEP_RECORDS, cases = PRESTEP_CASES, statusUpdates = [] } = {}) {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'dsh-memory-prestep-eval-'))
  const dataDir = join(temporaryRoot, 'data')
  const mainCwd = join(temporaryRoot, 'Alpha')
  const otherCwd = join(temporaryRoot, 'Beta')
  const projectKeys = { main: projectIdentity(mainCwd).key, other: projectIdentity(otherCwd).key }
  const store = new MemoryStore({ root: dataDir, clock: () => Date.now() }).open()
  const contentById = new Map()
  for (const fixture of fixtures) {
    const scope = fixture.scope ?? 'project'
    const project = fixture.project ?? 'main'
    const written = store.write({
      ...fixture,
      kind: fixture.kind ?? 'fact', scope,
      projectKey: scope === 'global' ? null : projectKeys[project],
      confidence: fixture.confidence ?? 0.95,
    })
    if (written.ok !== true) throw new Error(`holdout fixture ${fixture.id} is invalid: ${written.reason}`)
    contentById.set(fixture.id, fixture.content)
  }
  for (const update of statusUpdates) {
    const scopes = [{ scope: 'project', projectKey: projectKeys[update.project ?? 'main'] }]
    store.update(update.id, update.patch, scopes)
  }

  const listeners = new Map()
  const effects = []
  let currentTrace = null
  const ctx = {
    get(key) {
      if (key === 'dshHomePath') return () => temporaryRoot
      return undefined
    },
    on(name, handler) { listeners.set(name, handler); return () => {} },
    effect(factory) { effects.push(factory); return () => {} },
    logger: { debug() {}, info() {}, warn() {} },
  }

  try {
    apply(ctx, { dataDir, inject: { maxTokens: 360 }, capture: { enabled: false }, maintenance: { enabled: false } }, {
      recallObserver: (event) => currentTrace?.push(event),
    })
    const preStep = listeners.get('agent/pre-step')
    if (typeof preStep !== 'function') throw new Error('production agent/pre-step handler was not registered')
    const results = []
    for (const item of cases) {
      const trace = []
      currentTrace = trace
      const cwd = item.project === 'other' ? otherCwd : mainCwd
      const messages = item.messages ?? [{ role: 'user', source: { kind: 'user' }, content: item.query }]
      const decision = { kind: 'enter', messages }
      const result = await preStep({ agent: { session: { header: { cwd } } }, messages }, async () => decision)
      const memoryMessages = result.messages.filter((message) =>
        message?.source?.kind === 'memory' && message?.source?.plugin === 'dsh-memory')
      const injectedText = memoryMessages.flatMap((message) => Array.isArray(message.content) ? message.content : [])
        .filter((block) => block?.type === 'text').map((block) => block.text).join('\n')
      const injection = trace.findLast((event) => event.phase === 'inject') ?? { status: 'unobserved', ids: [], text: null }
      const injectedIds = injection.status === 'injected' ? injection.ids : []
      if (injection.status === 'injected' && injection.text !== injectedText) throw new Error(`${item.id}: observed injection differs from actual pre-step message`)
      const requiredValues = item.requiredValues ?? (item.required ?? []).map((id) => contentById.get(id)).filter(Boolean)
      const alternativeValueGroups = item.alternativeValueGroups ?? (item.alternatives ?? []).map((group) => group.map((id) => contentById.get(id)).filter(Boolean))
      const relevantValues = item.relevantValues ?? (item.relevant ?? []).map((id) => contentById.get(id)).filter(Boolean)
      const forbiddenValues = item.forbiddenValues ?? (item.forbidden ?? []).map((id) => contentById.get(id)).filter(Boolean)
      const matchedRequiredValues = requiredValues.filter((value) => injectedText.includes(value))
      const matchedAlternativeGroups = alternativeValueGroups.filter((group) => group.some((value) => injectedText.includes(value))).length
      const requiredFound = (item.required ?? []).filter((id) => injectedIds.includes(id))
      const relevantFound = (item.relevant ?? []).filter((id) => injectedIds.includes(id))
      const forbiddenFound = (item.forbidden ?? []).filter((id) => injectedIds.includes(id))
      const relevantValueFound = relevantValues.filter((value) => injectedText.includes(value))
      const forbiddenValueFound = forbiddenValues.filter((value) => injectedText.includes(value))
      const categorizedIds = new Set([
        ...(item.required ?? []), ...(item.alternatives ?? []).flat(), ...(item.relevant ?? []), ...(item.forbidden ?? []),
        ...fixtures.filter((fixture) => [...requiredValues, ...alternativeValueGroups.flat(), ...relevantValues, ...forbiddenValues]
          .some((value) => fixture.content.includes(value))).map((fixture) => fixture.id),
      ])
      const unrelatedInjected = injectedIds.filter((id) => !categorizedIds.has(id))
      const queryTrace = trace.filter((event) => event.phase === 'search').map((event) => {
        const content = trace.find((next) => next.phase === 'content' && next.query === event.query)?.ids ?? []
        const gate = trace.find((next) => next.phase === 'gate' && next.query === event.query)
        return {
          query: event.query,
          candidates: event.ids,
          contentMatched: content,
          gate: gate === undefined ? { auto: [], gray: [], qualified: [], dropped: [] } : {
            auto: gate.autoIds, gray: gate.grayIds, qualified: gate.qualifiedIds, dropped: gate.dropIds,
          },
        }
      })
      results.push({
        id: item.id,
        required: { matched: matchedRequiredValues.length, total: requiredValues.length, values: matchedRequiredValues },
        alternatives: { matched: matchedAlternativeGroups, total: alternativeValueGroups.length },
        requiredRecordIds: { matched: requiredFound.length, total: (item.required ?? []).length, ids: requiredFound },
        relevantInjected: relevantFound,
        relevantValuesInjected: relevantValueFound,
        forbiddenInjected: forbiddenFound,
        forbiddenValuesInjected: forbiddenValueFound,
        unrelatedInjected,
        injectionStatus: injection.status,
        selectedIds: injectedIds,
        injectedText,
        trace: {
          queries: queryTrace,
          rankedIds: trace.find((event) => event.phase === 'rank')?.ids ?? [],
        },
        requiredTextPreserved: item.requiredText === undefined || injectedText.includes(item.requiredText),
      })
    }
    const answerable = results.filter((row) => row.required.total > 0 || row.alternatives.total > 0)
    const requiredTotal = results.reduce((sum, row) => sum + row.required.total, 0)
    const requiredMatched = results.reduce((sum, row) => sum + row.required.matched, 0)
    const alternativeTotal = results.reduce((sum, row) => sum + row.alternatives.total, 0)
    const alternativeMatched = results.reduce((sum, row) => sum + row.alternatives.matched, 0)
    const querySatisfied = answerable.filter((row) => row.required.matched === row.required.total && row.alternatives.matched === row.alternatives.total).length
    const noAnswer = results.filter((row) => row.required.total === 0 && row.alternatives.total === 0)
    const forbiddenCount = results.reduce((sum, row) => sum + row.forbiddenInjected.length + row.forbiddenValuesInjected.length, 0)
    return {
      kind: 'production-pre-step',
      answerPhaseEvaluated: false,
      answerPhaseNote: 'Only plugin pre-step retrieval and injected text are measured; main-session DSH answer testing is not represented.',
      cases: results.length,
      queryBudget: 4,
      injectionBudget: 360,
      requiredEvidence: { matched: requiredMatched, total: requiredTotal, coverage: percent(requiredMatched, requiredTotal) },
      alternatives: { matched: alternativeMatched, total: alternativeTotal, coverage: percent(alternativeMatched, alternativeTotal) },
      answerableQueries: { satisfied: querySatisfied, total: answerable.length, rate: percent(querySatisfied, answerable.length) },
      relevantButUnnecessaryInjected: results.reduce((sum, row) => sum + row.relevantInjected.length + row.relevantValuesInjected.length, 0),
      forbiddenInjected: forbiddenCount,
      unrelatedInjected: results.reduce((sum, row) => sum + row.unrelatedInjected.length, 0),
      noAnswerCases: noAnswer.length,
      noAnswerInjections: noAnswer.filter((row) => row.selectedIds.length > 0 || row.unrelatedInjected.length > 0).length,
      qualifierCases: cases.filter((item) => item.requiredText !== undefined).length,
      qualifierCasesPreserved: results.filter((row) => row.requiredTextPreserved && cases.find((item) => item.id === row.id)?.requiredText !== undefined).length,
      result: results,
    }
  } finally {
    currentTrace = null
    for (const factory of effects) {
      try { factory()?.() } catch {}
    }
    rmSync(temporaryRoot, { recursive: true, force: true })
  }
}

const productionPreStep = await evaluateProductionPreStep({
  statusUpdates: [
    { id: 'mem_ho_old_node', patch: { status: 'superseded', validTo: Date.now() - 86_400_000 } },
    { id: 'mem_ho_forgotten', patch: { status: 'deleted' } },
  ],
})

const originalHardCase = {
  id: 'original_hard_pnpm_node', project: 'main', query: 'pnpm 依赖和 Node 版本',
  required: [], alternatives: [], relevant: [], forbidden: [],
  requiredValues: ['pnpm 管理依赖', 'Node 22 以上'],
  relevantValues: ['Node 版本要求是 24', '依赖安装使用 pnpm'],
}
const productionOriginalHard = await evaluateProductionPreStep({
  fixtures: HARD_RECORDS,
  cases: [originalHardCase],
  statusUpdates: [{ id: 'mem_hd_old', patch: { status: 'superseded', validTo: Date.now() - 1000 } }],
})

const result = {
  kind: 'recall-evaluation',
  note: 'Legacy metrics retain their original scoring contract. The separate fixed holdout uses the actual plugin agent/pre-step handler and does not evaluate model answers.',
  cases: regression.cases,
  hitAt5: regression.hitAt5,
  necessaryEvidenceCoverage: regression.necessaryEvidenceCoverage,
  precisionAtMost5: regression.precisionAtMost5,
  precisionAt5: regression.precisionAt5,
  mrr: regression.mrr,
  injectionRate: regression.injectionRate,
  wrongRecallQueries: regression.wrongRecallQueries,
  baseline: BASELINE_HIT_RATE,
  grayQueries,
  failures: regression.failures,
  hard,
  productionPreStep,
  productionOriginalHard,
}
console.log(JSON.stringify(result, null, 2))
if (regression.hitAt5 < BASELINE_HIT_RATE || productionPreStep.requiredEvidence.coverage < 0.9 ||
  productionPreStep.answerableQueries.rate < 0.85 || productionPreStep.forbiddenInjected > 0 ||
  productionPreStep.noAnswerInjections > 0 || productionPreStep.result.some((row) => !row.requiredTextPreserved) ||
  productionOriginalHard.requiredEvidence.coverage < 1) process.exitCode = 1
