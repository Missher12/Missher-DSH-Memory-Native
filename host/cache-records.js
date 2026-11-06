/** Store complete records in compressed blocks; parse individual records on use. */
import { createHash } from 'node:crypto'
import { deflateRawSync, inflateRawSync } from 'node:zlib'

export const CACHE_FILE = 'derived-index-v1.bin'
const META_FIELDS = ['id', 'kind', 'status', 'scope', 'projectKey', 'validTo', 'updatedAt', 'observedAt', 'confidence', 'importance', 'topic', 'revision']
const BLOCK_SIZE = 128 * 1024
const lazy = new WeakMap()
const authority = new WeakMap()
const DEFERRED = Symbol('unloaded record field')
const digest = (text) => `\0${createHash('sha256').update(text).digest('base64')}`

// The normal record shape is created in its authority order so filling it in
// does not change enumeration order or turn the search metadata into a slow
// dictionary object. Unusual or older shapes take the general path below.
function recordTarget() {
  return { id: undefined, kind: undefined, scope: undefined, projectKey: undefined, content: DEFERRED,
    topic: undefined, tags: DEFERRED, sourceRefs: DEFERRED, observedAt: undefined, validFrom: DEFERRED,
    validTo: undefined, confidence: undefined, importance: undefined, status: undefined, revision: undefined,
    supersedesId: DEFERRED, evidenceRole: DEFERRED, captureKey: DEFERRED, captureTaskId: DEFERRED,
    quoted: DEFERRED, contentHash: DEFERRED, recallCount: DEFERRED, lastRecalledAt: DEFERRED,
    pinned: DEFERRED, createdAt: DEFERRED, updatedAt: undefined }
}
const RECORD_KEYS = Object.keys(recordTarget())

/** Metadata reads do not need to pass through the lazy-record proxy. */
export function hotRecord(record) { return lazy.get(record)?.target ?? record }

/** Remember the exact committed JSON when a record is read or written. */
export function rememberAuthority(record, json) {
  const info = lazy.get(record)
  if (info) {
    const previous = info.persisted ?? bytesOf(info).toString('utf8')
    const changed = info.dirty || previous !== json
    if (previous !== json) info.persisted = json
    info.dirty = false
    return changed
  } else {
    const previous = authority.get(record)
    const changed = previous === undefined || (previous.startsWith('\0')
      ? digest(json) !== previous
      : json !== previous && json !== JSON.stringify(JSON.parse(previous)))
    authority.set(record, json)
    return changed
  }
}

function blockOf(data, id) {
  let block = data.cache.get(id)
  if (block !== undefined) return block
  block = inflateRawSync(data.raw.subarray(data.blockOffsets[id], data.blockOffsets[id + 1]))
  if (data.cache.size >= 64) data.cache.delete(data.cache.keys().next().value)
  data.cache.set(id, block)
  return block
}

function bytesOf(state) {
  return state.persisted === undefined ? blockOf(state.data, state.block).subarray(state.start, state.end) : Buffer.from(state.persisted)
}

function materialize(target) {
  const state = lazy.get(target)
  if (state.loaded) return
  const object = JSON.parse(bytesOf(state).toString('utf8'))
  const keys = Object.keys(object)
  if (keys.length !== RECORD_KEYS.length || keys.some((key, i) => key !== RECORD_KEYS[i])) {
    for (const key of Reflect.ownKeys(target)) Reflect.deleteProperty(target, key)
  }
  Object.defineProperties(target, Object.getOwnPropertyDescriptors(object))
  state.loaded = true
}

function hasUnloadedField(target, key) {
  if (!Object.hasOwn(target, key) || target[key] === DEFERRED) return true
  if (target[key] !== undefined) return false
  const index = META_FIELDS.indexOf(key)
  return index >= 0 && (lazy.get(target).present & (1 << index)) === 0
}

const handler = {
  get(target, key, receiver) {
    if (!lazy.get(target).loaded && hasUnloadedField(target, key)) materialize(target)
    return Reflect.get(target, key, receiver)
  },
  has(target, key) {
    if (!lazy.get(target).loaded && hasUnloadedField(target, key)) materialize(target)
    return Reflect.has(target, key)
  },
  ownKeys(target) { materialize(target); return Reflect.ownKeys(target) },
  getOwnPropertyDescriptor(target, key) { materialize(target); return Reflect.getOwnPropertyDescriptor(target, key) },
  set(target, key, value) { materialize(target); lazy.get(target).dirty = true; return Reflect.set(target, key, value) },
  deleteProperty(target, key) { materialize(target); lazy.get(target).dirty = true; return Reflect.deleteProperty(target, key) },
  defineProperty(target, key, descriptor) { materialize(target); lazy.get(target).dirty = true; return Reflect.defineProperty(target, key, descriptor) },
  preventExtensions(target) { materialize(target); return Reflect.preventExtensions(target) },
  setPrototypeOf(target, prototype) { materialize(target); lazy.get(target).dirty = true; return Reflect.setPrototypeOf(target, prototype) },
}

/** Pack every current authority revision; index/graph use ordinal references. */
export function packRecords(scopes, index, graph) {
  const all = [], packedScopes = [], ordinals = new Map()
  for (const [key, state] of scopes) {
    const start = all.length
    for (const record of state.records.values()) { ordinals.set(record, all.length); all.push(record) }
    const { records, ...scope } = state
    packedScopes.push([key, { ...scope, start, count: all.length - start }])
  }
  const columns = META_FIELDS.map(() => ({ values: [], refs: new Uint32Array(all.length), ids: new Map() }))
  const blockIds = new Uint32Array(all.length), starts = new Uint32Array(all.length), lengths = new Uint32Array(all.length)
  const compressed = [], blockOffsets = [0]
  let chunks = [], bytesInBlock = 0
  const flush = () => {
    if (chunks.length === 0) return
    const block = deflateRawSync(Buffer.concat(chunks, bytesInBlock), { level: 1 })
    compressed.push(block)
    blockOffsets.push(blockOffsets.at(-1) + block.length)
    chunks = []
    bytesInBlock = 0
  }
  for (let i = 0; i < all.length; i += 1) {
    const record = all[i], info = lazy.get(record), object = info?.target ?? record
    // Direct object edits are not committed revisions. Never persist them in a
    // derived snapshot that would then disagree with the unchanged JSONL.
    if (info?.dirty) throw new Error('record changed without an authority revision')
    for (let j = 0; j < META_FIELDS.length; j += 1) {
      const field = META_FIELDS[j]
      if (info && !info.loaded && (info.present & (1 << j)) === 0) continue
      if (!Object.hasOwn(object, field)) continue
      const column = columns[j], value = object[field]
      let id = column.ids.get(value)
      if (id === undefined) { id = column.values.length + 1; column.ids.set(value, id); column.values.push(value) }
      column.refs[i] = id
    }
    let bytes
    if (info) {
      bytes = bytesOf(info)
      if (info.loaded) {
        const json = JSON.stringify(record), original = bytes.toString('utf8')
        if (json !== original && json !== JSON.stringify(JSON.parse(original))) {
          throw new Error('record changed without an authority revision')
        }
      }
    } else {
      const json = JSON.stringify(record), original = authority.get(record)
      const matches = original !== undefined && (original.startsWith('\0')
        ? digest(json) === original
        : json === original || json === JSON.stringify(JSON.parse(original)))
      if (!matches) {
        throw new Error('record changed without an authority revision')
      }
      if (!original.startsWith('\0')) authority.set(record, digest(json))
      bytes = Buffer.from(json)
    }
    if (bytesInBlock > 0 && bytesInBlock + bytes.length > BLOCK_SIZE) flush()
    blockIds[i] = compressed.length
    starts[i] = bytesInBlock
    lengths[i] = bytes.length
    chunks.push(bytes)
    bytesInBlock += bytes.length
  }
  flush()
  const references = (records, source) => Int32Array.from(records, (record) => {
    if (record === null) return -1
    const ordinal = ordinals.get(record)
    if (ordinal === undefined) throw new Error(`${source} does not match authority record ${record.id}`)
    return ordinal
  })
  return { scopes: packedScopes,
    records: { columns: columns.map(({ values, refs }) => ({ values, refs })), blockIds, starts, lengths,
      blockOffsets: Uint32Array.from(blockOffsets), raw: Buffer.concat(compressed) },
    index: { ...index, slots: references(index.slots, 'index') }, graph: { ...graph, records: references(graph.records, 'graph') } }
}

// Keep the id lookup eager, but build a shared record view only when a reader
// requests it. The store, index and graph must all return that same object.
class CachedScopeMap extends Map {
  constructor(resolve) { super(); this.resolve = resolve }
  get(id) { const value = super.get(id); return typeof value === 'number' ? this.resolve(value) : value }
  *values() { for (const id of this.keys()) yield this.get(id) }
  *entries() { for (const id of this.keys()) yield [id, this.get(id)] }
  [Symbol.iterator]() { return this.entries() }
  forEach(callback, receiver) {
    for (const [id, record] of this) callback.call(receiver, record, id, this)
  }
}

/** Restore lightweight records; opening a search hit parses only that record. */
export function unpackRecords(data) {
  const { columns, blockIds, starts, lengths, blockOffsets, raw } = data.records ?? {}
  if (!Array.isArray(columns) || columns.length !== META_FIELDS.length || !(blockIds instanceof Uint32Array) ||
      !(starts instanceof Uint32Array) || !(lengths instanceof Uint32Array) || !(blockOffsets instanceof Uint32Array) ||
      !Buffer.isBuffer(raw) || starts.length !== blockIds.length || lengths.length !== blockIds.length ||
      blockOffsets.length < 1 || blockOffsets[0] !== 0 || blockOffsets.at(-1) !== raw.length ||
      !Array.isArray(data.scopes) || !(data.index?.slots instanceof Int32Array) || !(data.graph?.records instanceof Int32Array) ||
      columns.some((column) => !Array.isArray(column.values) || !(column.refs instanceof Uint32Array) || column.refs.length !== blockIds.length)) {
    throw new Error('invalid packed memory records')
  }
  const storage = { raw, blockOffsets, cache: new Map() }, records = new Array(blockIds.length), targets = new Array(blockIds.length)
  // Validate ordinals and column references once; no allocation per record.
  for (let i = 0; i < records.length; i++) {
    if (blockIds[i] + 1 >= blockOffsets.length || blockOffsets[blockIds[i]] > blockOffsets[blockIds[i] + 1] ||
        typeof columns[0].values[columns[0].refs[i] - 1] !== 'string') throw new Error('invalid cached record')
  }
  for (const column of columns) {
    for (const ref of column.refs) if (ref > column.values.length) throw new Error('invalid cached metadata')
  }
  function hotAt(i) {
    if (targets[i]) return targets[i]
    const target = recordTarget()
    for (let j = 0; j < columns.length; j++) {
      const ref = columns[j].refs[i]
      if (ref) target[META_FIELDS[j]] = columns[j].values[ref - 1]
    }
    return targets[i] = target
  }
  function recordAt(i) {
    if (records[i]) return records[i]
    const target = hotAt(i)
    let present = 0
    for (let j = 0; j < columns.length; j++) if (columns[j].refs[i]) present |= 1 << j
    const state = { target, data: storage, block: blockIds[i], start: starts[i], end: starts[i] + lengths[i], present, loaded: false, dirty: false }
    const proxy = new Proxy(target, handler)
    lazy.set(target, state)
    lazy.set(proxy, state)
    return records[i] = proxy
  }
  const scopes = new Map()
  let cursor = 0
  for (const [key, packed] of data.scopes) {
    if (!packed || packed.start !== cursor || !Number.isInteger(packed.count) || packed.count < 0 || cursor + packed.count > records.length) {
      throw new Error('invalid packed memory scope')
    }
    const { start, count, ...state } = packed
    state.records = new CachedScopeMap(recordAt)
    for (let i = start; i < start + count; i += 1) state.records.set(columns[0].values[columns[0].refs[i] - 1], i)
    scopes.set(key, state)
    cursor += count
  }
  if (cursor !== records.length) throw new Error('missing packed memory scope')
  const dereference = (ordinals, resolve) => Array.from(ordinals, (ordinal) => {
    if (ordinal === -1) return null
    if (ordinal < 0 || ordinal >= records.length) throw new Error('invalid packed memory reference')
    return resolve(ordinal)
  })
  return { scopes, index: { ...data.index, slots: dereference(data.index.slots, i => i), recordAt, hotAt },
    graph: { ...data.graph, records: dereference(data.graph.records, recordAt) } }
}
