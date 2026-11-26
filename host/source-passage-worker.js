import { parentPort, workerData } from 'node:worker_threads'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { canReadSource, CAPTURE_DIR, SOURCE_DIR } from './capture-journal.js'
import { readAuthorityIntent } from './authority-intent.js'
import { readGrantedSource } from './source-passages.js'

const { root, projectKey } = workerData
const sourceDirectory = join(root, CAPTURE_DIR, SOURCE_DIR)

function sourceAuthority() {
  try {
    const stat = statSync(sourceDirectory, { bigint: true, throwIfNoEntry: false })
    return { directory: stat ? [stat.dev, stat.ino, stat.mtimeNs, stat.ctimeNs].join(':') : null,
      intent: readAuthorityIntent(root) }
  } catch { return null }
}

function readBatch(ids) {
  const results = []
  for (const id of ids) {
    const source = readGrantedSource(root, id, projectKey)
    if (source) results.push(source)
  }
  return results
}

parentPort.on('message', ids => {
  const before = sourceAuthority()
  const batch = readBatch(ids)
  const after = sourceAuthority()
  const stable = before && after && before.directory === after.directory && before.intent === after.intent
  // Recheck the batch when a writer changes recall authority during the read.
  parentPort.postMessage(stable ? batch : readBatch(ids).filter(source => canReadSource(root, source.id)))
})
