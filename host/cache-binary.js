/** Cache-only layout. One read supplies aligned typed-array views to the index
 * instead of V8 deserializing and allocating a second copy of each posting. */
import { serialize, deserialize } from 'node:v8'

const types = [Uint8Array, Uint16Array, Uint32Array, Int32Array, Buffer]
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
  const mapParts = obj => Object.fromEntries(Object.entries(obj).map(([k,v]) => [k,part(v)]))
  const meta = { scopes: data.scopes, graph: {...data.graph, records:part(data.graph.records)},
    profile:{...data.profile,bytes:part(data.profile.bytes)},
    records:{...mapParts({raw:rec.raw,starts:rec.starts,lengths:rec.lengths,blockIds:rec.blockIds,blockOffsets:rec.blockOffsets}),
      columns:rec.columns.map(c=>({values:c.values,refs:part(c.refs)}))},
    index:{...idx,docs:mapParts(idx.docs),postings:mapParts(idx.postings),slots:part(idx.slots),
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
  return { ...meta, graph:{...meta.graph,records:view(meta.graph.records)}, profile:{...meta.profile,bytes:view(meta.profile.bytes)},
    records:{...mapViews(data),columns:columns.map(c=>({values:c.values,refs:view(c.refs)}))},
    index:{...i, slots:view(i.slots), lengths:Array.from(view(i.lengths)), df:Array.from(view(i.df)),
      docs:mapViews(i.docs), postings:mapViews(i.postings)} }
}
