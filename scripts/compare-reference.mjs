/** Compare cached profile, graph and stats with the read-only 0.2.18 package. */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { buildRecord } from '../host/records.js'
import { openMemoryRuntime } from '../host/startup.js'
import { deriveProfile, prepareProfileView, profileViewResult } from '../host/profile.js'
import { computeStats, knowledgeGraph } from '../host/remote-contract.js'

const savedReference = fileURLToPath(new URL('../docs/tasks/codex-terra-50k-20261105/reference-0.2.18/', import.meta.url))
const reference = resolve(process.env.DSH_MEMORY_REFERENCE || (existsSync(join(savedReference, 'package.json'))
  ? savedReference : '/Users/missher/.dsh/profiles/desktop/node_modules/@missher/dsh-memory'))
assert.equal(JSON.parse(readFileSync(join(reference, 'package.json'), 'utf8')).version, '0.2.18-native.20261105')
const oldProfile = await import(pathToFileURL(join(reference, 'host/profile.js')).href)
const oldPanel = await import(pathToFileURL(join(reference, 'host/remote-contract.js')).href)
const now = 1_750_000_000_000
Date.now = () => now
const root = mkdtempSync(join(tmpdir(), 'dsh-memory-reference-'))
try {
  const lines = new Map()
  const examples = [
    '用户喜欢深色主题', '用户喜欢浅色主题', '用户不喜欢深色主题', '用户偏好简洁直接的中文回答',
    '用户偏好简洁、直接的中文回复', '项目要求版本 12 和 20', '项目要求版本 20 和 12', '项目要求版本 12 和 21',
  ]
  for (let i = 0; i < 1200; i++) {
    const scope = i % 3 === 0 ? 'global' : 'project', projectKey = scope === 'global' ? null : `project-${i % 2}`
    const kind = i % 4 === 0 ? 'preference' : 'fact'
    const content = kind === 'preference' ? (i % 7 === 0 ? examples[(i / 4) % examples.length | 0] : `用户偏好第 ${i} 项具体选择`) : `项目第 ${i} 项记录，中文内容完整`
    const built = buildRecord({ scope, projectKey, kind, content, topic: i % 5 === 0 ? '沟通' : null,
      tags: i % 6 === 0 ? ['中文', '测试'] : [], confidence: 0.55 + (i % 40) / 100 }, { id: `ref_${i}`, now: now - i * 50_000 })
    assert.ok(built.ok)
    const record = { ...built.record }
    if (i % 83 === 0) { record.updatedAt = null; record.observedAt = null }
    if (i % 89 === 0) record.updatedAt = now + 50_000
    if (i % 67 === 0) record.status = 'archived'
    const dir = scope === 'global' ? join(root, 'global') : join(root, 'projects', projectKey)
    if (!lines.has(dir)) lines.set(dir, [])
    lines.get(dir).push(JSON.stringify(record))
  }
  for (const [dir, content] of lines) {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'memories.jsonl'), `${content.join('\n')}\n`)
  }
  const first = openMemoryRuntime({ root, clock: () => now })
  first.dispose()
  const runtime = openMemoryRuntime({ root, clock: () => now })
  assert.equal(runtime.metrics.cacheHit, true)
  const records = runtime.store.listAll()
  const view = prepareProfileView(records, now)
  for (const at of [now - 1000, now, now + 50_000, now + 60 * 86_400_000]) {
    for (const limit of [2, 12, 50]) {
      const expected = oldProfile.deriveProfile(records, { now: at, limit })
      assert.deepEqual(deriveProfile(records, { now: at, limit }), expected)
      assert.deepEqual(profileViewResult(view, { now: at, limit }), expected)
    }
  }
  const config = { capture: { enabled: false }, inject: { enabled: true }, obsidian: { vaultPath: null } }
  const plain = { store: runtime.store, index: runtime.index, root, config }
  const cached = { ...plain, getProfile: runtime.profile, getGraphRecords: runtime.graph }
  assert.deepEqual(computeStats(cached, {}), oldPanel.computeStats(plain, {}))
  assert.deepEqual(knowledgeGraph(cached, { scope: 'all' }), oldPanel.knowledgeGraph(plain, { scope: 'all' }))
  runtime.dispose()
  console.log(JSON.stringify({ version: '0.2.18-native.20261105', records: records.length,
    profileInstants: 4, profileLimits: [2, 12, 50], statsMatched: true, fullScopeGraphMatched: true, noRealProfileData: true }, null, 2))
} finally {
  rmSync(root, { recursive: true, force: true })
}
