import { parentPort, workerData } from 'node:worker_threads'
import { MemoryStore } from '../host/store.js'
import { createLocalSharingService } from '../host/local-sharing.js'

const { root, profileIdentity, projectKey, sharedBuffer } = workerData
const service = createLocalSharingService({ root, profileIdentity, projectKey })

if (workerData.mode === 'writer' || workerData.mode === 'replay-writer') {
  const original = MemoryStore.prototype.appendBatch
  let paused = false
  MemoryStore.prototype.appendBatch = function (records) {
    if (!paused && this.root === root) {
      paused = true
      parentPort.postMessage({ type: 'append-paused' })
      Atomics.wait(new Int32Array(sharedBuffer), 0, 0, 5000)
    }
    return original.call(this, records)
  }
  try {
    const saved = service.remember(workerData.rememberInput ?? { client: 'codex', sessionId: 'race-session', messageId: 'race-event',
      text: '记住：珊瑚星计划每周四执行，并发遗忘后不能留下检索结果。', requestedProjectKey: projectKey })
    parentPort.postMessage({ type: 'writer-saved', id: saved.id, sourceId: saved.sourceId })
  } catch (error) { parentPort.postMessage({ type: 'writer-error', error: error.message }) }
} else if (workerData.mode === 'record-forgetter') {
  try {
    parentPort.postMessage({ type: 'forget-started' })
    const forgotten = service.forget(workerData.recordId, projectKey)
    parentPort.postMessage({ type: 'record-forgotten', forgotten })
    const gate = new Int32Array(sharedBuffer)
    Atomics.wait(gate, 1, 0, 5000)
    const final = service.search('珊瑚星计划 每周四 并发遗忘', projectKey, 50)
    parentPort.postMessage({ type: 'final-search', ids: final.hits.map(hit => hit.id) })
  } catch (error) { parentPort.postMessage({ type: 'reader-error', error: error.message }) }
} else {
  try {
    const result = service.search('珊瑚星计划 每周四 并发遗忘', projectKey, 50)
    const source = result.hits.find(hit => hit.kind === 'source')
    parentPort.postMessage({ type: 'source-found', id: source?.id ?? null })
    if (!source) throw new Error('writer source passage was not visible before append')
    parentPort.postMessage({ type: 'forget-started' })
    const forgotten = service.forget(source.id, projectKey)
    parentPort.postMessage({ type: 'forgot', forgotten })
    const final = service.search('珊瑚星计划 每周四 并发遗忘', projectKey, 50)
    parentPort.postMessage({ type: 'final-search', ids: final.hits.map(hit => hit.id) })
  } catch (error) { parentPort.postMessage({ type: 'reader-error', error: error.message }) }
}

setTimeout(() => service.close(), 10_000).unref()
