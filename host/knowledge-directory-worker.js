import { parentPort, workerData } from 'node:worker_threads'
import { readDirectoryEntry, readDirectoryRoutes } from './knowledge-directory-cache.js'

const { root, files } = workerData
const routes = readDirectoryRoutes(root)
let offset = 0

function sendBatch() {
  const batch = files.slice(offset, offset + 256)
  offset += batch.length
  const done = offset === files.length
  const entries = batch.map(file => [file, readDirectoryEntry(root, file, routes)])
  parentPort.postMessage({ entries, done, cachedRoutes: done ? routes?.size ?? 0 : 0 })
  if (done) parentPort.close()
}

parentPort.on('message', sendBatch)
sendBatch()
