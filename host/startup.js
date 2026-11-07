/** Disposable startup cache for the JSONL authority and its search/profile views. */
import { randomUUID } from 'node:crypto'
import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { deserialize, serialize } from 'node:v8'
import { crc32 } from 'node:zlib'
import { packCache, unpackCache } from './cache-binary.js'
import { CACHE_FILE, hotRecord, packRecords, unpackRecords } from './cache-records.js'
import { advanceProfileView, prepareProfileView, profileViewResult } from './profile.js'
import { MemoryIndex } from './search.js'
import { fileStamp, MemoryStore } from './store.js'

const CACHE_VERSION = 2

function authorityStamp(store) {
  const root = store.root
  return [['global', fileStamp(join(root, 'global', 'memories.jsonl'))],
    ...store.listProjects().map((key) => [`project:${key}`, fileStamp(join(root, 'projects', key, 'memories.jsonl'))])]
}

function same(left, right) { return JSON.stringify(left) === JSON.stringify(right) }

function graphView(records) {
  return { total: records.length, records: records.slice().sort((a, b) => (hotRecord(b).updatedAt ?? 0) - (hotRecord(a).updatedAt ?? 0)).slice(0, 1000) }
}

/** Open fully searchable data; cache failures always fall back to the authority. */
export function openMemoryRuntime({ root, clock = () => Date.now() }) {
  const started = performance.now()
  const store = new MemoryStore({ root, clock }).open()
  const index = new MemoryIndex()
  const cacheFile = join(root, CACHE_FILE)
  const metrics = { cacheHit: false, loadMs: 0, indexMs: 0, profileMs: 0, cacheWriteMs: 0 }
  let stamp = authorityStamp(store), profile, graph, timer = null, profileTimer = null

  const loadCache = () => {
    try {
      const bytes = readFileSync(cacheFile)
      const headerLength = bytes.readUInt32BE(0)
      if (headerLength < 2 || headerLength > 65536 || headerLength + 4 >= bytes.length) return false
      const header = JSON.parse(bytes.subarray(4, 4 + headerLength).toString('utf8'))
      if (header.version !== CACHE_VERSION || header.format !== 10 || header.v8 !== process.versions.v8 || !same(header.stamp, stamp)) return false
      const body = bytes.subarray(Math.ceil((4 + headerLength) / 8) * 8)
      if (crc32(body) !== header.checksum) return false
      const data = unpackCache(body)
      if (!same(stamp, authorityStamp(store)) || !Buffer.isBuffer(data?.profile?.bytes) || typeof data.profile.nextFutureAt !== 'number' ||
        !data.graph || typeof data.graph.total !== 'number') return false
      const restored = unpackRecords(data)
      store.restore(restored.scopes)
      index.restore(restored.index)
      profile = data.profile
      graph = restored.graph
      return true
    } catch {
      store.reset()
      return false
    }
  }

  const rebuild = (keep = null) => {
    store.reset(keep)
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const before = authorityStamp(store)
      const startLoad = performance.now()
      const records = store.listAll()
      metrics.loadMs = performance.now() - startLoad
      const startIndex = performance.now()
      index.rebuild(records)
      metrics.indexMs = performance.now() - startIndex
      const startProfile = performance.now()
      profile = prepareProfileView(records, clock())
      graph = graphView(records)
      metrics.profileMs = performance.now() - startProfile
      const after = authorityStamp(store)
      if (same(before, after)) { stamp = after; return }
      store.reset()
    }
    throw new Error('memory authority changed repeatedly during startup')
  }

  const saveCache = () => {
    const start = performance.now()
    let temp
    try {
      if (!same(stamp, authorityStamp(store))) return false
      const packed = packRecords(store.snapshot(), index.snapshot(), graph)
      const packedProfile = profile.bytes ? profile : { bytes: serialize(profile), nextFutureAt: profile.nextFutureAt }
      const body = packCache({ ...packed, profile: packedProfile })
      const header = Buffer.from(JSON.stringify({ version: CACHE_VERSION, format: 10, v8: process.versions.v8, stamp,
        checksum: crc32(body) }))
      const size = Buffer.allocUnsafe(4)
      size.writeUInt32BE(header.length)
      temp = `${cacheFile}.${process.pid}.${randomUUID()}.tmp`
      writeFileSync(temp, Buffer.concat([size, header, Buffer.alloc((8 - (4 + header.length) % 8) % 8), body]), { mode: 0o600, flag: 'wx' })
      if (!same(stamp, authorityStamp(store))) return false
      renameSync(temp, cacheFile)
      temp = null
      return true
    } catch {
      return false
    } finally {
      if (temp !== undefined && temp !== null) try { unlinkSync(temp) } catch {}
      metrics.cacheWriteMs = performance.now() - start
    }
  }

  const scheduleCache = () => {
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      try {
        synchronize()
        // synchronize() may have scheduled the same refresh after a rebuild.
        if (timer !== null) { clearTimeout(timer); timer = null }
        saveCache()
      } catch {
        // A later access/restart will retry from the authority.
      }
    }, 250)
    timer.unref?.()
  }

  function currentProfile() {
    if (profile.bytes) {
      try {
        const view = deserialize(profile.bytes)
        if (!Array.isArray(view.dated) || !Array.isArray(view.undated) || !Array.isArray(view.future) ||
            !(view.best instanceof Int32Array)) throw new Error('invalid cached profile')
        profile = view
      } catch {
        profile = prepareProfileView(store.listAll(), clock())
        scheduleCache()
      }
    }
    return profile
  }

  const armProfile = () => {
    if (profileTimer !== null) clearTimeout(profileTimer)
    if (!Number.isFinite(profile.nextFutureAt)) return
    const delay = Math.max(1, Math.min(profile.nextFutureAt - clock(), 2_147_483_647))
    profileTimer = setTimeout(() => {
      profile = advanceProfileView(currentProfile(), clock())
      armProfile()
      scheduleCache()
    }, delay)
    profileTimer.unref?.()
  }

  const synchronize = () => {
    const current = authorityStamp(store)
    if (same(stamp, current)) return false
    rebuild()
    armProfile()
    scheduleCache()
    return true
  }

  const loadStarted = performance.now()
  if (loadCache()) {
    metrics.cacheHit = true
    metrics.loadMs = performance.now() - loadStarted

  } else {
    rebuild()
    saveCache()
  }
  armProfile()

  store.setLifecycle({
    beforeWrite: synchronize,
    onChange(event) {
      if (event.type === 'refresh') {
        rebuild(event.state)
        armProfile()
        scheduleCache()
        return
      }
      const current = authorityStamp(store)
      const other = (entries) => entries.filter(([key]) => key !== event.state.key)
      const actual = current.find(([key]) => key === event.state.key)?.[1] ?? null
      if (!same(other(stamp), other(current)) || actual !== event.state.stamp) {
        rebuild()
        armProfile()
      } else {
        stamp = current
        if (event.type === 'remove') index.remove(event.id)
        for (const record of event.type === 'upsert' ? event.records : []) {
          if (record?.status === 'deleted') index.remove(record.id)
          else if (record) index.upsert(record)
        }
        const records = store.listAll()
        if (event.type === 'rewrite' && event.changed) index.rebuild(records)
        graph = graphView(records)
        if (event.type === 'rewrite' || [...(event.records ?? []), ...(event.previous ?? [])].some((record) => record?.kind === 'preference')) {
          profile = prepareProfileView(records, clock())
          armProfile()
        }
      }
      scheduleCache()
    },
  })

  metrics.readyMs = performance.now() - started
  return { store, index, metrics, synchronize,
    profile(limit, now = clock()) {
      const advanced = advanceProfileView(currentProfile(), now)
      if (advanced !== profile) { profile = advanced; armProfile(); scheduleCache() }
      return profileViewResult(profile, { limit, now })
    },
    graph: () => graph,
    dispose() { if (timer !== null) clearTimeout(timer); if (profileTimer !== null) clearTimeout(profileTimer); store.setLifecycle() },
  }
}
