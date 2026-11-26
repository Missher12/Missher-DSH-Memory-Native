const SHORTENED_WORD = /(?:^|[^a-z])(?:Mr|Mrs|Ms|Dr|Prof|St|Jr|Sr|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept?|Oct|Nov|Dec)$/iu
const INITIAL = /(?:^|[^a-zA-Z])[A-Z]$/u
const EVIDENCE_PREFACE = /^(?:based on|according to)\s+(?:(?:the\s+)?(?:(?:available|recorded)\s+)?(?:information|memory|evidence|records)|your\s+(?:memory|records)|(?:the\s+)?original\s+quotes?)(?:\s+provided)?(?:\s+in\s+(?:your|the)\s+memory(?:\s+context)?)?,\s*/iu

export function withoutEvidencePreface(text) {
  return text.replace(EVIDENCE_PREFACE, '')
}

/** Offsets keep each result an exact substring of the user message. */
export function sourceSentenceBreaks(text) {
  return [...text.matchAll(/[。！？!?\n]|\.(?=\s|$)/gu)].filter(boundary => {
    if (boundary[0] !== '.') return true
    const left = text.slice(Math.max(0, boundary.index - 6), boundary.index)
    return !SHORTENED_WORD.test(left) && !INITIAL.test(left)
  })
}

export function sourceSentences(text) {
  const sentences = []
  let start = 0
  for (const end of [...sourceSentenceBreaks(text).map(boundary => boundary.index + 1), text.length]) {
    const sentence = text.slice(start, end).trim()
    if (sentence) sentences.push(sentence)
    start = end
  }
  return sentences
}
