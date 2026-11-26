/** Cache-only layout. One read supplies aligned typed-array views to the index
 * instead of V8 deserializing and allocating a second copy of each posting. */
import { serialize, deserialize } from 'node:v8'

const types = [Uint8Array, Uint16Array, Uint32Array, Int32Array, Buffer, Float64Array]

function narrowUnsigned(values) {
  if (!(values instanceof Uint16Array) && !(values instanceof Uint32Array)) return values
  let max = 0
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i]
    if (value > 0xffff) return values
    if (value > max) max = value
  }
  if (max <= 0xff) return new Uint8Array(values)
  return values instanceof Uint16Array ? values : new Uint16Array(values)
}

export function packCache(data) {
  const blocks = []
  let offset = 0
  const part = value => {
    const type = types.indexOf(value.constructor)
    if (type === -1) throw new Error('unsupported cache array')
    const bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength)
    const descriptor = [type, offset, bytes.length]
    blocks.push(bytes)
    offset += bytes.length
    const pad = (8 - offset % 8) % 8
    if (pad) { blocks.push(Buffer.alloc(pad)); offset += pad }
    return descriptor
  }
  const rec = data.records, idx = data.index
  const { termIds: _termIds, ...index } = idx
  const packColumn = ({ values, refs }) => {
    const references = part(refs)
    if (values instanceof Float64Array) return { numbers: part(values), refs: references }
    if (values.length >= 16 && values.every(value => typeof value === 'number')) {
      return { numbers: part(Float64Array.from(values)), refs: references }
    }
    return { values, refs: references }
  }
  const mapParts = obj => Object.fromEntries(Object.entries(obj).map(([k,v]) => [k,part(v)]))
  const docs = { ...idx.docs, freqs: narrowUnsigned(idx.docs.freqs) }
  const postings = { ...idx.postings, slots: narrowUnsigned(idx.postings.slots), freqs: narrowUnsigned(idx.postings.freqs) }
  const meta = { scopes: data.scopes, graph: {...data.graph, records:part(data.graph.records)},
    profile:{...data.profile,bytes:part(data.profile.bytes)},
    records:{...mapParts({raw:rec.raw,starts:rec.starts,lengths:rec.lengths,blockIds:rec.blockIds,blockOffsets:rec.blockOffsets}),
      columns:rec.columns.map(packColumn)},
    index:{...index,docs:mapParts(docs),postings:mapParts(postings),slots:part(idx.slots),
      slotById:part(Uint32Array.from(idx.slotById.values())),
      lengths:part(Uint32Array.from(idx.lengths)),df:part(Uint32Array.from(idx.df))} }
  const encoded = serialize(meta)
  const head = Buffer.alloc(Math.ceil((4 + encoded.length) / 8) * 8)
  head.writeUInt32LE(encoded.length);encoded.copy(head,4)
  return Buffer.concat([head,...blocks],head.length + offset)
}

export function unpackCache(body) {
  const size=body.readUInt32LE(0), start=Math.ceil((size+4)/8)*8
  if(start>body.length) throw new Error('cache metadata extends outside file')
  const meta=deserialize(body.subarray(4,4+size))
  const view = ([type, offset, length]) => {
    const ctor=types[type]
    if(!ctor || !Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset<0 ||
      offset%8 || length<0 || start+offset+length>body.length || length%ctor.BYTES_PER_ELEMENT) throw new Error('invalid cache section')
    const pos=body.byteOffset+start+offset
    return ctor===Buffer ? Buffer.from(body.buffer,pos,length) : new ctor(body.buffer,pos,length/ctor.BYTES_PER_ELEMENT)
  }
  const mapViews = obj => Object.fromEntries(Object.entries(obj).map(([k,v])=>[k,view(v)]))
  const r=meta.records,{columns,...data}=r, i=meta.index
  const recordColumns = columns.map(column => ({
    values: column.numbers === undefined ? column.values : view(column.numbers),
    refs: view(column.refs),
  }))
  const slots = view(i.slots), mappedSlots = view(i.slotById)
  if (!(slots instanceof Int32Array) || !(mappedSlots instanceof Uint32Array) || !Array.isArray(i.termNames)) {
    throw new Error('invalid cache index lookups')
  }
  const ids = recordColumns[0], slotById = new Map(), termIds = new Map()
  // The stored lookup contains only the slots owned by its original map.
  // Other slots can still hold an earlier occurrence of a legacy duplicate ID.
  for (let j = 0; j < mappedSlots.length; j++) {
    const slot = mappedSlots[j]
    const id = ids.values[ids.refs[slots[slot]] - 1]
    if (typeof id !== 'string' || slotById.has(id)) throw new Error('invalid cache slot lookup')
    slotById.set(id, slot)
  }
  for (let j = 0; j < i.termNames.length; j++) termIds.set(i.termNames[j], j)
  return { ...meta, graph:{...meta.graph,records:view(meta.graph.records)}, profile:{...meta.profile,bytes:view(meta.profile.bytes)},
    records:{...mapViews(data),columns:recordColumns},
    index:{...i, slots, slotById, termIds, lengths:Array.from(view(i.lengths)), df:Array.from(view(i.df)),
      docs:mapViews(i.docs), postings:mapViews(i.postings)} }
}
