/** Physical size of the committed original files, independent from recall authority. */
import { lstatSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

function directoryVersion(directory) {
  const info = lstatSync(directory, { bigint: true, throwIfNoEntry: false })
  if (info === undefined) return null
  if (!info.isDirectory()) throw new Error('capture sources is not a directory')
  return [info.dev, info.ino, info.mtimeNs, info.ctimeNs].join(':')
}

async function fileSize(file) {
  try { return (await stat(file)).size }
  catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

export class CaptureSourceFootprint {
  #directory
  #verified = null
  #scan = null
  #failed = null
  #disposed = false

  constructor(directory) { this.#directory = directory }

  read() {
    if (this.#disposed) return { state: 'unavailable', sources: null }
    let version
    try { version = directoryVersion(this.#directory) }
    catch { return { state: 'unavailable', sources: null } }
    if (version === null) return { state: 'ready', sources: { count: 0, bytes: 0 } }
    if (this.#verified?.version === version) return { state: 'ready', sources: this.#verified.sources }
    if (this.#failed?.version === version && this.#failed.retryAt > Date.now()) {
      return { state: 'unavailable', sources: null }
    }
    this.#scan ??= this.#measure(version).finally(() => { this.#scan = null })
    return { state: 'checking', sources: null }
  }

  async #measure(version) {
    try {
      const names = (await readdir(this.#directory)).filter(name => name.endsWith('.json'))
      const sources = { count: 0, bytes: 0 }
      for (let i = 0; i < names.length; i += 32) {
        if (this.#disposed) return
        const sizes = await Promise.all(names.slice(i, i + 32).map(async name => {
          const file = join(this.#directory, name)
          const [header, compressed] = await Promise.all([fileSize(file), fileSize(file + '.gz')])
          return header === null ? null : header + (compressed ?? 0)
        }))
        for (const bytes of sizes) {
          if (bytes === null) continue
          sources.count++
          sources.bytes += bytes
        }
      }
      if (!this.#disposed && directoryVersion(this.#directory) === version) {
        this.#verified = { version, sources }
        this.#failed = null
      }
    } catch {
      if (!this.#disposed) this.#failed = { version, retryAt: Date.now() + 5000 }
    }
  }

  dispose() { this.#disposed = true }
}
