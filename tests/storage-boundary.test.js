import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { prepareStorage } from '../host/storage-boundary.js'
import { MemoryStore } from '../host/store.js'

function setup(t) {
  const home = mkdtempSync(join(tmpdir(), 'memory-profile-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const context = name => ({ get: key => key === 'profileContext' ? { name, home, dir: join(home, 'profiles', name) } : undefined })
  return { home, context }
}

test('desktop keeps legacy authority while another native profile receives a separate default root', t => {
  const { home, context } = setup(t)
  const legacy = new MemoryStore({ root: join(home, 'dsh-memory') }).open()
  legacy.write({ kind: 'fact', scope: 'global', content: '只属于 desktop 的全局记录。' })
  const desktop = prepareStorage(context('desktop'), {})
  const other = prepareStorage(context('work'), {})
  assert.equal(desktop.root, realpathSync(legacy.root))
  assert.notEqual(other.root, desktop.root)
  assert.equal(new MemoryStore({ root: desktop.root }).open().listAll().length, 1)
  assert.equal(new MemoryStore({ root: other.root }).open().listAll().length, 0)
  const owner = readFileSync(join(desktop.root, 'data-owner.json'), 'utf8')
  assert.throws(() => prepareStorage(context('work'), { dataDir: desktop.root }), error => error.code === 'storage-owner-conflict')
  assert.equal(readFileSync(join(desktop.root, 'data-owner.json'), 'utf8'), owner)
})

test('a non-desktop profile cannot claim unowned legacy desktop memory', t => {
  const { home, context } = setup(t), root = join(home, 'dsh-memory')
  mkdirSync(root)
  assert.throws(() => prepareStorage(context('work'), { dataDir: root }), error => error.code === 'storage-owner-conflict')
})

test('missing identity never opens implicit shared storage or a root bound to another profile', t => {
  const { home, context } = setup(t), absent = { get: () => undefined }
  assert.throws(() => prepareStorage(absent, {}), error => error.code === 'profile-unavailable')
  const desktop = prepareStorage(context('desktop'), {})
  assert.throws(() => prepareStorage(absent, { dataDir: desktop.root }), error => error.code === 'storage-owner-conflict')
  const explicit = prepareStorage(absent, { dataDir: join(home, 'standalone') })
  assert.equal(explicit.isolation, 'explicit')
})
