import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { PANEL_METHODS } from '../host/remote-contract.js'

const clientSource = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

test('every host PANEL_METHOD has a client descriptor entry', () => {
  const match = clientSource.match(/const METHODS = \[([\s\S]*?)\]/u)
  assert.ok(match !== null, 'client METHODS array is present')
  const clientMethods = [...match[1].matchAll(/'([^']+)'/gu)].map((item) => item[1])
  for (const method of PANEL_METHODS) {
    assert.ok(clientMethods.includes(method), `client METHODS is missing ${method}`)
  }
})

test('every client method has a result type mapping', () => {
  const methodsMatch = clientSource.match(/const METHODS = \[([\s\S]*?)\]/u)
  const methods = [...methodsMatch[1].matchAll(/'([^']+)'/gu)].map((item) => item[1])
  const typesMatch = clientSource.match(/const RESULT_TYPES = \{([\s\S]*?)\n    \}/u)
  assert.ok(typesMatch !== null, 'RESULT_TYPES object is present')
  const keys = [...typesMatch[1].matchAll(/([A-Za-z]+):/gu)].map((item) => item[1])
  for (const method of methods) assert.ok(keys.includes(method), `RESULT_TYPES is missing ${method}`)
})
