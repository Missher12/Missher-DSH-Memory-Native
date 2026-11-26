import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { saveSource, readSource } from '../host/capture-journal.js'
import { expenseQuery, matchesExpenseAnswer, retrieveExpenses } from '../host/dated-expenses-recall.js'
import { SourcePassageIndex, grantSourceRecall, DEEP_RECALL_TOKEN_LIMIT } from '../host/source-passages.js'

test('dated expenses sum proven purchases and keep the full year unknown', async t => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-expense-proof-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const projectKey = 'archive-123456789012'
  const now = Date.UTC(2023, 4, 5, 18)
  const sourceAt = now - 60_000
  const statements = [
    'On April 2, 2023, I bought a camera bag for $32.',
    'On April 2, 2023, I bought a camera bag for $32.',
    'On April 8, 2023, I bought a camera bag for $32.',
    'On December 30, 2022, I bought a camera bag for $240.',
    'I plan to buy a camera bag for $350.',
    'On April 12, 2023, I bought a camera bag for $650 per package.',
    'On April 9, 2023, my brother bought a camera battery for $80.',
    'On May 1, 2023, I bought a camera screen protector for $9.',
    'On May 1, 2023, I bought a camera screen protector for $10.',
    'On May 2, 2023, I bought a camera battery for $125.',
    'I returned the camera battery.',
  ]
  const sources = statements.map((text, index) => {
    const record = saveSource(root, { sessionId: `session-${index}`, messageId: 'purchase', eventSeq: 0,
      at: sourceAt, eventTime: sourceAt, timeZone: 'UTC', role: 'user', sourceKind: 'user', projectKey, text })
    assert.ok(grantSourceRecall(root, readSource(root, record.id), projectKey, { remembered: true }))
    return record.id
  })
  const index = new SourcePassageIndex(root)
  await index.prepare(projectKey)
  const clock = { eventTime: now, timeZone: 'UTC' }
  const plan = expenseQuery('How much have I spent on camera-related expenses this year?', clock)
  const result = retrieveExpenses(index, plan, {
    projectKey, now, maxTokens: 360, maxItems: 6, scanLimit: DEEP_RECALL_TOKEN_LIMIT, accepts: () => true,
  })
  assert.equal(result.expenses.subtotal, '$64')
  assert.equal(result.expenses.fullTotalKnown, false)
  assert.deepEqual(result.injected.map(entry => entry.row.hit.record.sourceRefs[0].sourceId).filter(id => id === sources[2]), [sources[2]])
  assert.equal(result.injected.length, 2)
  assert.match(result.text, /The full total is unknown/u)
  assert.ok(matchesExpenseAnswer('The recorded subtotal for camera-related expenses this year is $64. The full total is unknown.', result.expenses))
  assert.equal(matchesExpenseAnswer('I spent a total of $64 on camera expenses this year.', result.expenses), false)
  assert.equal(matchesExpenseAnswer('The recorded subtotal for camera expenses this month is $64. The full total is unknown.', result.expenses), false)
  assert.equal(matchesExpenseAnswer('The records show the full total is $64 on camera expenses this year. The full total is unknown.', result.expenses), false)
})
