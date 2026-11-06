/** Shared full-size corpus and original 200-query workload. */
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildRecord } from '../host/records.js'

export const QUERIES = ['中文 检索', 'SQLite', '项目 偏好', '记忆 注入', 'pnpm', '上下文 预算', '设计 方案', '用户 中文', '索引 数据库', '经验 教训']

export function writeCorpus(root, projectKey, count, now = Date.now()) {
  const folder = join(root, 'projects', projectKey)
  mkdirSync(folder, { recursive: true })
  const words = '记忆 存储 检索 项目 偏好 决策 经验 上下文 注入 索引 数据库 接口 面板 用户 中文 测试 版本 仓库 方案 设计'.split(' ')
  const lines = []
  for (let i = 0; i < count; i++) {
    const result = buildRecord({ kind: ['preference', 'fact', 'decision', 'episode'][i % 4], scope: 'project', projectKey,
      content: `第 ${i} 条记忆：${words[i % words.length]} 与 ${words[(i * 7) % words.length]} 以及 ${words[(i * 13) % words.length]} 相关，用于容量测试`,
      confidence: .8, importance: .6 }, { now: now - i * 1000, id: `mem_${i}` })
    assert.ok(result.ok)
    lines.push(JSON.stringify(result.record))
  }
  writeFileSync(join(folder, 'memories.jsonl'), `${lines.join('\n')}\n`, { mode: 0o600 })
}
