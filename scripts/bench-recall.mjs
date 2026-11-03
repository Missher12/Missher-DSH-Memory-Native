/**
 * Recall benchmark: build a synthetic 5,000-record index and time queries.
 *
 * Run with the bundled Node that ships with DeepSeek Harness:
 *   <node> scripts/bench-recall.mjs
 *
 * Not part of `node --test` (wall-clock thresholds make CI flaky); the numbers
 * below were measured on the authoring machine (M-series macOS, Node 24):
 *   build 114ms, median query 4.69ms, p95 8.91ms, max 64.62ms (first query
 *   includes JIT warm-up). Typical recall stays well under the 50ms budget.
 */

import { buildRecord } from '../host/records.js'
import { MemoryIndex } from '../host/search.js'

const KINDS = ['preference', 'fact', 'decision', 'episode']
const WORDS = '记忆 存储 检索 项目 偏好 决策 经验 上下文 注入 索引 数据库 接口 面板 用户 中文 测试 版本 仓库 方案 设计'.split(' ')
const now = Date.now()

const RECORD_COUNT = Number(process.env.BENCH_RECORDS) > 0 ? Number(process.env.BENCH_RECORDS) : 5000
const records = []
for (let i = 0; i < RECORD_COUNT; i += 1) {
  const content = `第 ${i} 条记忆：${WORDS[i % WORDS.length]} 与 ${WORDS[(i * 7) % WORDS.length]} 以及 ${WORDS[(i * 13) % WORDS.length]} 相关，用于容量测试`
  const built = buildRecord({
    kind: KINDS[i % 4],
    scope: i % 5 === 0 ? 'global' : 'project',
    projectKey: 'perf-project',
    content,
    confidence: 0.8,
    importance: 0.6,
  }, { now: now - i * 1000, id: `mem_${i}` })
  if (built.ok) records.push(built.record)
}

const buildStart = performance.now()
const index = new MemoryIndex().rebuild(records)
const buildMs = performance.now() - buildStart

const queries = ['中文 检索', 'SQLite', '项目 偏好', '记忆 注入', 'pnpm', '上下文 预算', '设计 方案', '用户 中文', '索引 数据库', '经验 教训']
const times = []
for (let round = 0; round < 20; round += 1) {
  for (const query of queries) {
    const start = performance.now()
    index.search(query, { now, projectKey: 'perf-project', limit: 40 })
    times.push(performance.now() - start)
  }
}
times.sort((a, b) => a - b)

console.log(JSON.stringify({
  records: records.length,
  buildMs: Math.round(buildMs),
  queries: times.length,
  medianMs: Number(times[Math.floor(times.length / 2)].toFixed(2)),
  p95Ms: Number(times[Math.floor(times.length * 0.95)].toFixed(2)),
  maxMs: Number(times[times.length - 1].toFixed(2)),
  heapMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
}, null, 2))
