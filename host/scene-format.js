/**
 * JavaScript adaptation of TencentDB-Agent-Memory v2.0.3's Scene Block format.
 * The format stays a projection over DSH JSONL records; DSH remains authority.
 * Source: MemoryCore/src/core/scene/scene-format.ts
 */

const META_START = '-----META-START-----'
const META_END = '-----META-END-----'

export function parseSceneBlock(raw, filename) {
  const startIndex = raw.indexOf(META_START)
  const endIndex = raw.indexOf(META_END)
  if (startIndex === -1 || endIndex === -1) {
    return { filename, meta: { created: '', updated: '', summary: '', heat: 0 }, content: raw.trim() }
  }
  const metaBlock = raw.slice(startIndex + META_START.length, endIndex).trim()
  const content = raw.slice(endIndex + META_END.length).trim()
  const meta = {
    created: extractMetaField(metaBlock, 'created'),
    updated: extractMetaField(metaBlock, 'updated'),
    summary: extractMetaField(metaBlock, 'summary'),
    heat: Number.parseInt(extractMetaField(metaBlock, 'heat'), 10) || 0,
  }
  return { filename, meta, content }
}

export function formatSceneBlock(meta, content) {
  return `${formatMeta(meta)}\n\n${content}`
}

export function formatMeta(meta) {
  return [META_START, `created: ${meta.created}`, `updated: ${meta.updated}`,
    `summary: ${meta.summary}`, `heat: ${meta.heat}`, META_END].join('\n')
}

function extractMetaField(metaBlock, field) {
  const match = metaBlock.match(new RegExp(`^${field}:\\s*(.*)$`, 'm'))
  return match ? match[1].trim() : ''
}
