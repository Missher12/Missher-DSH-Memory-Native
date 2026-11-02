/**
 * Pure-JS tokenizer for memory retrieval.
 *
 * Latin/digit runs are lowercased words; CJK runs are expanded to unigrams plus
 * adjacent bigrams. The bigrams are the important part: FTS5's trigram tokenizer
 * cannot match 2-character Chinese queries, and a built-in unicode61 tokenizer
 * treats a whole CJK run as one token. Emitting both gives short-query recall
 * without any native dependency or dictionary.
 *
 * @module dsh-memory/host/tokenize
 */

const CJK_PATTERN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/u
const WORD_CHAR = /[a-z0-9_]/i

/** Whether one code point belongs to a CJK block that needs bigram expansion. */
export function isCjk(ch) {
  return typeof ch === 'string' && ch.length > 0 && CJK_PATTERN.test(ch)
}

/**
 * Tokenize one text into the term list the in-memory index stores.
 * @param {unknown} text
 * @returns {string[]} tokens in source order, including duplicates (term frequency)
 */
export function tokenize(text) {
  const input = String(text ?? '').normalize('NFKC').toLowerCase()
  const tokens = []
  let word = ''
  let cjkRun = []

  const flushWord = () => {
    if (word.length > 0) {
      tokens.push(word)
      word = ''
    }
  }
  const flushCjk = () => {
    if (cjkRun.length === 0) return
    for (const ch of cjkRun) tokens.push(ch)
    for (let i = 0; i + 1 < cjkRun.length; i += 1) tokens.push(cjkRun[i] + cjkRun[i + 1])
    cjkRun = []
  }

  for (const ch of input) {
    if (isCjk(ch)) {
      flushWord()
      cjkRun.push(ch)
    } else if (WORD_CHAR.test(ch)) {
      flushCjk()
      word += ch
    } else {
      flushWord()
      flushCjk()
    }
  }
  flushWord()
  flushCjk()
  return tokens
}

/**
 * Unique query terms with a stable order; used so a repeated query word does not
 * multiply its weight the way a document's term frequency legitimately does.
 * @param {unknown} text
 * @returns {string[]}
 */
export function queryTerms(text) {
  return [...new Set(tokenize(text))]
}
