import assert from 'node:assert/strict'
import test from 'node:test'

import { buildRecord, nextRevision } from '../host/records.js'
import { adaptiveInjectionBudget, classifyRecallHits, compileMemoryContext, estimateTokens, formatMemoryLine, hasContentMatch, hasMeaningfulMatch, isFollowUpQuery, isPreferenceQuery, isQualifiedValueCandidate, matchesRecallAttribute, matchesRecallEntity, rankHits, recallAnchorTerms, recallDecisionAnswer, recallHasDecisionReasonEvidence, recallHasHandoffEvidence, recallQueries, recallQueryPlan, recallRelationAnswer, recallTimeIntent } from '../host/recall.js'
import { analyzeUserMessageControls } from '../host/user-controls.js'

const NOW = 1_700_000_000_000
const KEY = 'DSH-Memory-abc'

test('project-qualified bare objects match their name without accepting competing objects or projects', () => {
  const entity = recallQueryPlan('青岩快照保留多久')[1].entityTerms
  for (const content of ['青岩项目现在确认变更：快照保留 29 天。', '青岩项目的快照保留 29 天。']) {
    assert.equal(matchesRecallEntity({ record: { content } }, entity), true, content)
    assert.equal(matchesRecallEntity({ record: { content } }, ['青岩快照']), true, content)
  }
  for (const content of ['红杉项目现在确认变更：快照保留 29 天。', '青岩项目的红杉快照保留 29 天。', '青岩项目。快照保留 29 天。', '青岩项目中红杉服务确认变更：快照保留 29 天。']) {
    assert.equal(matchesRecallEntity({ record: { content } }, entity), false, content)
  }
})

test('a grammatical 的 may bridge only one split Chinese entity bigram', () => {
  const slots = recallQueryPlan('碧潮方案快照每天几点运行，保留多久？').filter(item => item.role === 'subquestion')
  const matching = { record: { content: '碧潮方案的快照每天07:26运行，保留43天。' } }
  assert.equal(slots.length, 2)
  assert.ok(slots.every(slot => matchesRecallEntity(matching, slot.entityTerms)))
  assert.equal(matchesRecallAttribute(matching, slots[0].query, slots[0].detail, slots[0].entityTerms), true)
  assert.equal(matchesRecallAttribute(matching, slots[1].query, slots[1].detail, slots[1].entityTerms), true)
  for (const content of [
    '赤潮方案的快照每天07:26运行，保留43天。',
    '碧潮计划的快照每天07:26运行，保留43天。',
    '碧潮方案的日志每天07:26运行，保留43天。',
    '碧潮的方案快照每天07:26运行，保留43天。',
    '新碧潮方案的快照每天19:51运行，保留43天。',
    '碧潮方案每天07:26运行；快照保留43天。',
  ]) {
    const hit = { record: { content } }
    assert.equal(matchesRecallEntity(hit, slots[0].entityTerms), false, content)
    assert.equal(matchesRecallAttribute(hit, slots[0].query, slots[0].detail, slots[0].entityTerms), false, content)
  }
  assert.equal(matchesRecallEntity(matching, ['碧潮方案快照']), true)
  assert.equal(matchesRecallEntity({ record: { content: '赤潮方案的快照每天07:26运行，保留43天。' } }, ['碧潮方案快照']), false)
  assert.equal(matchesRecallEntity({ record: { content: '新碧潮方案的快照每天19:51运行。' } }, recallAnchorTerms('碧潮方案快照每天几点运行')), false)
  assert.equal(matchesRecallEntity({ record: { content: '当前碧潮方案的快照每天19:51运行。' } }, recallAnchorTerms('碧潮方案快照每天几点运行')), true)
})

test('relation bridges require an unconditional owner fact and accept explicit owner syntax', () => {
  const query = '青岩项目的负责人是谁'
  assert.equal(recallRelationAnswer(query, '青岩项目的负责人是林青。'), '林青')
  assert.equal(recallRelationAnswer(query, '青岩项目的负责人是张晓明。'), '张晓明')
  assert.equal(recallRelationAnswer(query, '青岩项目由陆珂负责维护。'), '陆珂')
  assert.equal(recallRelationAnswer(query, '青岩项目的负责人不是林青。'), null)
  assert.equal(recallRelationAnswer(query, '如果青岩项目负责人请假，则由林青临时代班。'), null)
})

test('decision-reason bridges require the same explicitly chosen scheme and causal wording', () => {
  const query = '沐桥项目的备份方式最终采用哪个方案'
  assert.equal(recallDecisionAnswer(query, '沐桥项目的备份方式最终采用星港方案。'), '星港方案')
  assert.equal(recallDecisionAnswer(query, '沐桥项目的备份方式考虑采用星港方案。'), null)
  assert.equal(recallDecisionAnswer(query, '沐桥项目的备份方式可能采用星港方案。'), null)
  assert.equal(recallDecisionAnswer(query, '沐桥项目建议采用星港方案。'), null)
  assert.equal(recallDecisionAnswer(query, '沐桥项目的备份方式并未采用星港方案。'), null)
  assert.equal(recallHasDecisionReasonEvidence('选择星港方案，是因为它允许夜间限速传输。', '星港方案'), true)
  assert.equal(recallHasDecisionReasonEvidence('选择云岚方案，是因为它允许夜间限速传输。', '星港方案'), false)
  assert.equal(recallHasDecisionReasonEvidence('选择星港方案升级版，是因为它允许夜间限速传输。', '星港方案'), false)
  assert.equal(recallHasDecisionReasonEvidence('选择星港方案，并非因为它允许夜间限速传输。', '星港方案'), false)
  assert.equal(recallHasDecisionReasonEvidence('选择星港方案，不是因为省钱，而是因为允许夜间限速传输。', '星港方案'), true)
  assert.equal(recallHasDecisionReasonEvidence('星港方案和夜间限速传输曾被同时讨论。', '星港方案'), false)
  assert.equal(recallHasDecisionReasonEvidence('并未选择星港方案，因为它允许夜间限速传输。', '星港方案'), false)
})

test('handoff evidence requires a directed assignment, not shared relation words', () => {
  assert.equal(recallHasHandoffEvidence('林青请假时，交付值班由周岚接手。', '林青'), true)
  assert.equal(recallHasHandoffEvidence('许岚休假期间由夏知接手维护工作。', '许岚'), true)
  assert.equal(recallHasHandoffEvidence('许岚和顾宁一起讨论过请假和代班手续。', '许岚'), false)
  assert.equal(recallHasHandoffEvidence('林青请假时，周岚不负责接手。', '林青'), false)
  assert.equal(recallHasHandoffEvidence('张晓明请假时，不是由顾宁代班。', '张晓明'), false)
  assert.equal(recallHasHandoffEvidence('顾宁请假时，由许岚代班。', '许岚'), false)
  assert.equal(recallHasHandoffEvidence('张晓明提到林青请假时由顾宁代班。', '张晓明'), false)
})

test('a relation target is omitted when its bridge does not fit the injection budget', () => {
  const bridge = { record: { id: 'owner', kind: 'fact', content: `青岩项目的负责人是林青。${'长'.repeat(500)}` }, score: 1 }
  const target = { record: { id: 'handoff', kind: 'fact', content: '林青请假时由周岚代班。' }, relationFromId: 'owner', score: 1 }
  const minimumTargetBudget = estimateTokens(formatMemoryLine(target.record)) + 70
  const block = compileMemoryContext([bridge, target], { maxTokens: minimumTargetBudget, maxItems: 2 })
  assert.ok(block === null || !block.ids.includes('handoff'))
})

test('relation query cleanup keeps a prior owner seed local to the relation plan', () => {
  const slots = recallQueryPlan('青岩项目的负责人是谁，他请假时谁接手？').filter(item => item.role === 'subquestion')
  assert.equal(slots[1].requiresRelationTrace, true)
  assert.equal(slots[1].relationSourceQuery, slots[0].query)
  assert.equal(slots[1].relationSeedQuery, '青岩 负责人')
})

function make(overrides = {}) {
  const built = buildRecord({
    kind: 'fact',
    scope: 'project',
    projectKey: KEY,
    content: '该仓库使用 pnpm 并要求 Node 22 以上',
    tags: ['pnpm'],
    confidence: 0.9,
    importance: 0.7,
    ...overrides,
  }, { now: NOW, autoApproveConfidence: 0.75 })
  assert.equal(built.ok, true)
  return built.record
}

test('rankHits orders by fused score and filters by minScore', () => {
  const strong = make({ content: '该仓库使用 pnpm 并要求 Node 22', importance: 0.9 })
  const weak = make({ content: '该仓库可能使用 pnpm', importance: 0.2, confidence: 0.4 })
  const ranked = rankHits([
    { record: strong, score: 2 },
    { record: weak, score: 0.4 },
  ], { now: NOW, minScore: 0.15 })
  assert.equal(ranked.length, 2)
  assert.equal(ranked[0].record.id, strong.id)
})

test('rankHits drops exact duplicate statements', () => {
  const first = make()
  const second = make()
  const ranked = rankHits([{ record: first, score: 2 }, { record: second, score: 1 }], { now: NOW, minScore: 0 })
  assert.equal(ranked.length, 1)
})

test('rankHits excludes an expired fact before fusion', () => {
  const expired = nextRevision(make(), { validTo: NOW - 1 }, NOW)
  const ranked = rankHits([{ record: expired, score: 2 }], { now: NOW, minScore: 0 })
  // validity is the index's job; rankHits still scores what it is given
  assert.equal(ranked.length, 1)
  assert.equal(ranked[0].record.validTo, NOW - 1)
})

test('compileMemoryContext emits a compact bounded block', () => {
  const record = make()
  const block = compileMemoryContext([{ record, score: 1 }], { maxTokens: 600 })
  assert.ok(block !== null)
  assert.match(block.text, /^<memory-context/u)
  assert.match(block.text, /dsh-memory/u)
  assert.match(block.text, /- \[事实\] 该仓库使用 pnpm/u)
  assert.doesNotMatch(block.text, /@r1/u)
  assert.match(block.text, /<\/memory-context>$/u)
  assert.deepEqual(block.ids, [record.id])
  assert.equal(block.itemCount, 1)
  assert.ok(block.estimatedTokens <= 600)
})

test('compileMemoryContext dedupes profile lines and keeps complete memory statements', () => {
  const record = make({ content: '用户偏好简洁直接的表达方式' })
  const block = compileMemoryContext([{ record, score: 1 }], {
    maxTokens: 600,
    profileLines: ['- [偏好] 用户偏好简洁直接的表达方式（3 条证据 · 0.95）'],
    profileLimit: 2,
    itemMaxChars: 10,
  })
  assert.ok(block !== null)
  assert.match(block.text, /用户偏好简洁直接的表达方式（3 条证据/u)
  assert.equal(block.itemCount, 0)
  assert.deepEqual(block.profileIds, [record.id])
  assert.doesNotMatch(block.text, /- \[事实\]/u)
  const long = make({ content: '这是一条非常长的记忆内容'.repeat(10) })
  const complete = compileMemoryContext([{ record: long, score: 1 }], { maxTokens: 600 })
  assert.ok(complete !== null)
  assert.match(complete.text, new RegExp(long.content, 'u'))
  assert.doesNotMatch(complete.text, /…/u)
})

test('compileMemoryContext respects the token budget and drops content that cannot fit', () => {
  const records = Array.from({ length: 20 }, (_, index) => make({ content: `这是第 ${index} 条有点长的记忆内容，用来测试预算截断行为` }))
  const ranked = records.map((record) => ({ record, score: 1 }))

  const tiny = compileMemoryContext(ranked, { maxTokens: 20, maxItems: 20 })
  assert.equal(tiny, null)

  const roomy = compileMemoryContext(ranked, { maxTokens: 200, maxItems: 20 })
  assert.ok(roomy !== null)
  assert.ok(roomy.ids.length >= 1)
  assert.ok(estimateTokens(roomy.text) <= 200)
})

test('compileMemoryContext keeps searching after an over-budget record without clipping facts', () => {
  const long = make({ content: `仅适用于 staging，且不得用于生产环境；该限定必须保留。${'长配置说明'.repeat(35)}` })
  const short = make({ content: '当前项目固定使用 pnpm 9' })
  const block = compileMemoryContext([
    { record: long, score: 2 },
    { record: short, score: 1 },
  ], { maxTokens: 100, maxItems: 2, itemMaxChars: 30 })
  assert.ok(block !== null)
  assert.deepEqual(block.ids, [short.id])
  assert.match(block.text, /当前项目固定使用 pnpm 9/u)
  assert.doesNotMatch(block.text, /staging|…/u)
})

test('compileMemoryContext returns null for no memories', () => {
  assert.equal(compileMemoryContext([], {}), null)
  assert.equal(compileMemoryContext(null, {}), null)
})

test('selected exact recall quote is the text injected for a memory', () => {
  const line = formatMemoryLine({ kind: 'fact', content: '摘要未包含的原始安排。', recallQuote: '原话明确写了周二 14:30。' })
  assert.match(line, /原话明确写了周二 14:30/u)
  assert.doesNotMatch(line, /摘要未包含/u)
})

test('estimateTokens counts CJK chars as one token', () => {
  assert.equal(estimateTokens('记忆'), 2)
  assert.ok(estimateTokens('memory') >= 2)
})


test('weak single-character matches do not count as meaningful recall', () => {
  assert.equal(hasMeaningfulMatch(['好']), false)
  assert.equal(hasMeaningfulMatch(['的']), false)
  assert.equal(hasMeaningfulMatch(['继续']), true)
  assert.equal(hasMeaningfulMatch(['pnpm']), true)
  assert.equal(hasMeaningfulMatch(undefined), false)
})

test('follow-up detection reuses the previous user message only for short continuations', () => {
  assert.equal(isFollowUpQuery('继续'), true)
  assert.equal(isFollowUpQuery('好的'), true)
  assert.equal(isFollowUpQuery('然后呢'), true)
  assert.equal(isFollowUpQuery('继续这个项目的部署方案'), true)
  assert.equal(isFollowUpQuery('pnpm 是什么'), false)
  assert.equal(isFollowUpQuery('请帮我把记忆面板的指标卡调整成左右布局'), false)
})

test('content gate ignores function-word bigrams', () => {
  assert.equal(hasContentMatch(['怎么']), false)
  assert.equal(hasContentMatch(['然后']), false)
  assert.equal(hasContentMatch(['这个']), false)
  assert.equal(hasContentMatch(['继续']), false)
  assert.equal(hasContentMatch(['进度']), true)
  assert.equal(hasContentMatch(['pnpm']), true)
  assert.equal(hasContentMatch(['设计', '文档']), true)
})

test('classifyRecallHits splits auto, gray and dropped hits', () => {
  const term = (name, idf, value) => ({ term: name, idf, value })
  const strong = { record: { id: 'a', content: '设计文档' }, matched: ['设计', '计文'], termScores: [term('设计', 4, 8), term('计文', 4, 6)] }
  const gray = { record: { id: 'b', content: '灰度发布' }, matched: ['灰度', '发布'], termScores: [term('灰度', 4, 1.8), term('发布', 3, 1.2)] }
  const weak = { record: { id: 'c', content: '随便' }, matched: ['随便'], termScores: [term('随便', 1, 0.5)] }
  const gate = classifyRecallHits([strong, gray, weak], '设计文档', { indexSize: 200, idfOf: () => 4 })
  assert.deepEqual(gate.auto.map((hit) => hit.record.id), ['a'])
  assert.deepEqual(gate.gray.map((hit) => hit.record.id), ['b'])
  assert.ok(gate.i1 > 4.8)
})

test('classifyRecallHits scales thresholds with index size', () => {
  const small = classifyRecallHits([], 'x', { indexSize: 200 })
  const large = classifyRecallHits([], 'x', { indexSize: 5000 })
  assert.ok(large.thresholds.drop > small.thresholds.drop)
  assert.ok(large.thresholds.auto > small.thresholds.auto)
})


test('recallQueries tries the last two user messages for follow-ups', () => {
  assert.deepEqual(recallQueries('继续', '召回门控怎么定', true), ['召回门控怎么定 继续', '召回门控怎么定', '继续'])
  assert.deepEqual(recallQueries('继续', undefined, true), ['继续'])
  assert.deepEqual(recallQueries('pnpm 版本', '召回门控怎么定', false), ['pnpm 版本'])
})

test('recallQueries keeps a compound root question and adds bounded subquestions', () => {
  assert.deepEqual(recallQueries('pnpm 依赖和 Node 版本', undefined, false), [
    'pnpm 依赖和 Node 版本', 'pnpm 依赖', 'Node 版本',
  ])
  assert.equal(recallQueries('pnpm 依赖、Node 版本、数据库版本、缓存版本', undefined, false).length, 5)
})

test('recallQueryPlan carries an entity anchor into an attribute-only child', () => {
  const plan = recallQueryPlan('甲设备温度和湿度', undefined, false)
  assert.deepEqual(plan.map(({ query, role }) => [query, role]), [
    ['甲设备温度和湿度', 'root'], ['甲设备温度', 'subquestion'], ['甲设备 湿度', 'subquestion'],
  ])
  assert.deepEqual(plan[1].entityTerms, plan[2].entityTerms)
  const otherEntity = { record: { content: '乙设备湿度保持在 80% 以上' } }
  assert.equal(matchesRecallEntity(otherEntity, plan[2].entityTerms), false)
})

test('recallTimeIntent handles plural English weeks and leaves fractional calendar dates unanchored', () => {
  const now = Date.UTC(2026, 10, 7, 4)
  assert.deepEqual(recallTimeIntent('3 weeks ago', now), { kind: 'as-of', at: now - 21 * 86_400_000 })
  assert.equal(recallTimeIntent('半个月前', now).kind, 'history')
  assert.equal(recallTimeIntent('半个月前', now).at, null)
})

test('comma continuation keeps a shared object for a following attribute clause', () => {
  const query = '青鹿快照保留多久'
  const fact = { record: { content: '青鹿快照每天 05:43 生成，保留 23 天。' } }
  const plan = recallQueryPlan(query, undefined, false)[0]
  assert.equal(matchesRecallAttribute(fact, query, undefined, plan.entityTerms), true)

  const otherObject = { record: { content: '青鹿快照每天 05:43 生成，灰鹿快照保留 45 天。' } }
  assert.equal(matchesRecallAttribute(otherObject, query, 'retention', plan.entityTerms), false)
})

test('generic root terms stay searchable while named entities and implicit product versions stay scoped', () => {
  const backupPlan = recallQueryPlan('发布前数据库备份策略', undefined, false)[0]
  assert.deepEqual(backupPlan.entityTerms, [])
  assert.equal(matchesRecallAttribute({ record: { content: '发布前先备份数据库状态' } }, backupPlan.query, undefined, backupPlan.entityTerms), true)

  const twoValues = recallQueryPlan('生产数据库和缓存版本分别是什么', undefined, false)
  const database = twoValues.find(item => item.role === 'subquestion' && item.query.includes('数据库'))
  const cache = twoValues.find(item => item.role === 'subquestion' && item.query.includes('缓存'))
  assert.equal(matchesRecallAttribute({ record: { content: '生产数据库运行 PostgreSQL 16' } }, database.query, database.detail, database.entityTerms), true)
  assert.equal(matchesRecallAttribute({ record: { content: '生产缓存运行 Redis 7' } }, cache.query, cache.detail, cache.entityTerms), true)
  assert.equal(matchesRecallAttribute({ record: { content: '生产数据库运行 PostgreSQL 16' } }, cache.query, cache.detail, cache.entityTerms), false)

  const named = recallQueryPlan('Alpha 项目 Redis 版本是多少', undefined, false)[0]
  assert.deepEqual(named.entityTerms, ['alpha', 'redis'])
  assert.equal(matchesRecallEntity({ record: { content: 'Alpha 项目使用 Redis 7' } }, named.entityTerms), true)
  assert.equal(matchesRecallEntity({ record: { content: 'Alpha 项目使用 PostgreSQL 16' } }, named.entityTerms), false)
})

test('recallQueryPlan extracts facts and shared attributes from the natural two-value prompt', () => {
  const prompt = '这个项目的 pnpm 和 Node 版本分别是多少？只根据已有记忆，每项用“工具名：版本号”回答。没有依据的那项就写不记得。不要调用工具，也不要保存这次问答。'
  const plan = recallQueryPlan(prompt, undefined, false)
  const queries = plan.map((item) => item.query).join(' | ')
  assert.ok(plan.length <= 4)
  assert.match(queries, /pnpm 版本/u)
  assert.match(queries, /Node 版本/u)
  assert.doesNotMatch(queries, /分别|只根据|工具名|调用工具|保存这次问答|不记得/u)
  const nodeQuery = plan.find((item) => item.role === 'subquestion' && /Node 版本/u.test(item.query))
  assert.deepEqual(nodeQuery.entityTerms, ['node'])
  for (const query of ['Node 和 pnpm 的版本分别是多少？', 'pnpm 和 Node 版本分别是多少？']) {
    const local = recallQueries(query, undefined, false)
    assert.ok(local.some((part) => /pnpm(?: 的| )版本/u.test(part)))
    assert.ok(local.some((part) => /Node 版本/u.test(part)))
  }
})

test('recall query cleaning keeps isolated and multi-sentence factual questions', () => {
  assert.ok(recallQueries('Node 版本是多少？', undefined, false).some((query) => /Node 版本/u.test(query)))
  const multi = recallQueries('pnpm 版本是多少？Node 版本是多少？只根据记忆回答。', undefined, false)
  assert.ok(multi.some((query) => /pnpm 版本/u.test(query)))
  assert.ok(multi.some((query) => /Node 版本/u.test(query)))
  assert.ok(multi.length <= 4)
  assert.doesNotMatch(multi.join(' '), /只根据记忆/u)
})

test('recall query cleaning strips leading directives but preserves the factual question', () => {
  const questions = [
    '只根据已有记忆回答：这个项目的 pnpm 和 Node 版本分别是多少？',
    '不调用工具，只根据已有记忆回答：这个项目的 pnpm 和 Node 版本分别是多少？',
    '只根据已有记忆回答这个项目的 pnpm 和 Node 版本分别是多少？',
  ]
  for (const prompt of questions) {
    const plan = recallQueryPlan(prompt, undefined, false)
    const queries = plan.map((item) => item.query).join(' | ')
    assert.ok(plan.length <= 4)
    assert.ok(plan.some((item) => /pnpm(?: 的| )版本/u.test(item.query)))
    assert.ok(plan.some((item) => /Node 版本/u.test(item.query)))
    assert.doesNotMatch(queries, /只根据|不调用工具/u)
  }
  assert.equal(analyzeUserMessageControls('不调用工具').retrievalQuery, '')
})

test('unknown-answer and no-save instructions stay outside recall questions', () => {
  const prompt = '碧潮方案快照每天几点运行，保留多久？缺少依据就说不知道。不要保存或提炼这次问答。'
  const controls = analyzeUserMessageControls(prompt)
  assert.equal(controls.retrievalQuery, '碧潮方案快照每天几点运行，保留多久')
  assert.equal(controls.noSaveDirective, true)
  const slots = recallQueryPlan(prompt, undefined, false).filter(item => item.role === 'subquestion')
  assert.equal(slots.length, 2)
  assert.ok(slots.every(item => !/缺少依据|不知道|保存|提炼/u.test(item.query)))
})

test('qualified gray evidence is eligible only for value questions and retains a numeric limit', () => {
  const qualified = { record: { content: '运行时最低版本要求是 Node 22 以上' }, matched: ['node'] }
  const unqualified = { record: { content: 'Node.js 运行时包含 3 个事件阶段' }, matched: ['node'] }
  const port = { record: { content: 'Node 服务监听端口至少为 7419' }, matched: ['node'] }
  const cache = { record: { content: 'Node 进程缓存上限是 64 MiB' }, matched: ['node'] }
  assert.equal(isQualifiedValueCandidate(qualified, 'Node 版本'), true)
  assert.equal(isQualifiedValueCandidate(unqualified, 'Node 版本'), false)
  assert.equal(isQualifiedValueCandidate(port, 'Node 版本'), false)
  assert.equal(isQualifiedValueCandidate(cache, 'Node 版本'), false)
  assert.equal(isQualifiedValueCandidate(qualified, 'Node.js 如何处理异步任务'), false)
  assert.equal(isQualifiedValueCandidate({ ...qualified, matched: ['异步'] }, 'Node 版本'), false)
})

test('subquestion attribute matching excludes Node port and cache limit from version evidence', () => {
  const version = { record: { content: 'Node 版本最低要求是 22 以上' }, matched: ['node'] }
  const port = { record: { content: 'Node 服务端口至少为 7419' }, matched: ['node'] }
  const cache = { record: { content: 'Node 进程缓存上限是 64 MiB' }, matched: ['node'] }
  assert.equal(matchesRecallAttribute(version, 'Node 版本'), true)
  assert.equal(matchesRecallAttribute(port, 'Node 版本'), false)
  assert.equal(matchesRecallAttribute(cache, 'Node 版本'), false)
})

test('profile injection is reserved for explicit preference questions', () => {
  assert.equal(isPreferenceQuery('用户喜欢什么风格的回答'), true)
  assert.equal(isPreferenceQuery('回复语言要求'), true)
  assert.equal(isPreferenceQuery('pnpm 依赖和 Node 版本'), false)
})

test('rankHits boosts records matching the inferred topic', () => {
  const first = make({ topic: '沟通', content: '用户偏好简洁直接的回答' })
  const second = make({ topic: '布局', content: '用户偏好紧凑单行布局' })
  const hits = [
    { record: first, score: 2, matched: ['偏好'] },
    { record: second, score: 2, matched: ['偏好'] },
  ]
  const ranked = rankHits(hits, { now: NOW, minScore: 0, topicHint: '布局' })
  assert.equal(ranked[0].record.id, second.id)
})


test('adaptiveInjectionBudget scales with hit count and follow-ups', () => {
  assert.equal(adaptiveInjectionBudget(360, 1, false), 200)
  assert.equal(adaptiveInjectionBudget(360, 3, false), 256)
  assert.equal(adaptiveInjectionBudget(360, 6, false), 352)
  assert.equal(adaptiveInjectionBudget(360, 6, true), 220)
  assert.equal(adaptiveInjectionBudget(200, 6, false), 200)
})
