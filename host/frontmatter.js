import { parse } from 'yaml'

/** Read the YAML map produced by Obsidian's property editor. */
export function parseFrontmatter(text) {
  const source = String(text ?? '')
  const match = source.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u)
  if (match === null) return null
  const data = parse(match[1], { stringKeys: true }) ?? {}
  if (typeof data !== 'object' || Array.isArray(data)) throw new Error('note properties must be a YAML map')
  return { data, body: source.slice(match[0].length) }
}
