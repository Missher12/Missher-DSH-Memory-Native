import assert from 'node:assert/strict'
import test from 'node:test'
import { buildRecord } from '../host/records.js'
import { advanceProfileView, deriveProfile, prepareProfileView, profileViewResult } from '../host/profile.js'

const now = 1_750_000_000_000

test('cached profile preserves clustering, evidence and time-dependent ordering', () => {
  const records = []
  for (let i = 0; i < 180; i++) {
    const source = { scope: i % 3 ? 'global' : 'project', projectKey: 'test', kind: i % 7 ? 'preference' : 'fact',
      content: i % 8 === 0 ? '用户偏好简洁直接的中文回答' : `用户偏好第 ${i % 87} 个具体项目结果`,
      topic: i % 2 ? null : '沟通', confidence: 0.55 + (i % 40) / 100 }
    const built = buildRecord(source, { id: `mem_${i}`, now: now - i * 20_000 })
    assert.equal(built.ok, true)
    const item = { ...built.record }
    if (i % 19 === 0) { item.updatedAt = null; item.observedAt = null }
    if (i % 23 === 0) item.updatedAt = now + 100_000
    records.push(item)
  }
  const view = prepareProfileView(records, now)
  for (const at of [now - 100_000, now, now + 100_000, now + 100 * 86_400_000]) {
    for (const limit of [2, 12, 50]) {
      assert.deepEqual(profileViewResult(view, { now: at, limit }), deriveProfile(records, { now: at, limit }))
      assert.deepEqual(profileViewResult(advanceProfileView(view, at), { now: at, limit }), deriveProfile(records, { now: at, limit }))
    }
  }
})
