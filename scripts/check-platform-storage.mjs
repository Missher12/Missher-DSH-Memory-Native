/** Native filesystem probe; only synthetic files under the OS temporary directory. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir, release } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { atomicWritePrivate } from '../host/persistence.js'

const root = mkdtempSync(join(tmpdir(), 'memory-platform-'))
const directory = join(root, '中文目录 with spaces')
mkdirSync(directory)
const value = JSON.stringify({ content: '原文完整保留：07:26，43天。', revision: 1 })
const report = { platform: process.platform, arch: process.arch, osRelease: release(), node: process.version }
function probe(write, name) {
  const file = join(directory, name)
  try {
    write(file, value)
    assert.equal(readFileSync(file, 'utf8'), value)
    write(file, value.replace('43天', '44天'))
    assert.equal(readFileSync(file, 'utf8'), value.replace('43天', '44天'))
    return { ok: true, completeReadback: true, replacement: true }
  } catch (error) {
    let fileWritten = false
    try { fileWritten = readFileSync(file, 'utf8').includes('原文完整保留') } catch {}
    return { ok: false, code: error.code ?? error.name, syscall: error.syscall ?? null, fileWritten }
  }
}
try {
  const baseline = process.argv.indexOf('--baseline')
  if (baseline >= 0) {
    const revision = process.argv[baseline + 1]
    assert.match(revision ?? '', /^[a-f0-9]{40}$/u)
    const file = join(root, 'baseline.mjs')
    writeFileSync(file, execFileSync('git', ['show', revision + ':host/persistence.js']))
    const prior = await import(pathToFileURL(file).href)
    report.baseline = { revision, ...probe(prior.atomicWritePrivate, 'baseline.json') }
  }
  report.current = probe(atomicWritePrivate, 'current.json')
  console.log(JSON.stringify(report, null, 2))
  assert.equal(report.current.ok, true, 'Atomic storage failed on this operating system')
} finally {
  rmSync(root, { recursive: true, force: true })
}
