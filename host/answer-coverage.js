import { matchesRecallAttribute } from './recall.js'

const ANSWER_STOP_ATOMS = new Set(['每天', '每日', '执行', '运行', '保留', '开始', '结束', '采用', '选择', '使用', '计划', '项目', '记忆', '事实', '来源', '因为', '所以', '由于', '为了', '以便', '避开', '避免', '原因', '缘于', '出于', '否则', '免得', '防止', '需要'])

function normalizedAnswerText(text) {
  return String(text ?? '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
}

function stripAnswerReasonLeadIn(value) {
  const prefix = /^(?:原因(?:是|在于)?|是|因为|由于|为了|以便|为|在于|要|去|能够|可以|尽量|避开|避免|防止|免得|以免)\s*/u
  let phrase = String(value ?? '').trim()
  while (phrase !== '') {
    const next = phrase.replace(/^[\s\p{P}\p{S}]+/u, '').replace(prefix, '').trim()
    if (next === phrase) break
    phrase = next
  }
  return phrase
}

function answerEvidenceReasonPhrases(value) {
  const body = String(value ?? '').replace(/^\s*-\s*\[[^\]]+\]\s*/u, '')
  return body.split(/[。！？!?；;\n]+/u).map(text => text.trim()).filter(Boolean).map(clause => {
    const cue = /因为|由于|为了|以便|避开|避免|原因|缘于|出于|否则|免得|防止/u.exec(clause)
    return cue ? stripAnswerReasonLeadIn(clause.slice(cue.index + cue[0].length)) : ''
  }).filter(Boolean)
}

function answerEvidenceText(question, injectedText) {
  const body = String(injectedText ?? '').replace(/^\s*-\s*\[[^\]]+\]\s*/u, '')
  const clauses = body.split(/[。！？!?；;\n]+/u).map(text => text.trim()).filter(Boolean)
  if (question.detail === 'clock') {
    return [...body.matchAll(/(?:[01]?\d|2[0-3])[:：][0-5]\d|(?:凌晨|早上|上午|下午|晚上|每日|每天).{0,6}[一二三四五六七八九十\d]+点|\b(?:0?[1-9]|1[0-2])(?::[0-5]\d)?\s*(?:am|pm)\b/giu)].map(match => match[0]).join(' ')
  }
  if (question.detail === 'retention') {
    const values = []
    for (const clause of clauses) {
      if (!/(?:保留|留存|保存)/u.test(clause)) continue
      for (const match of clause.matchAll(/(?:\d+(?:\.\d+)?|[零一二两三四五六七八九十半]+)\s*(?:天|日|周|星期|个月|月|年|小时|分钟|秒)|(?:永久|长期)(?=保留)/gu)) values.push(match[0])
    }
    return values.join(' ')
  }
  if (question.detail === 'reason') return answerEvidenceReasonPhrases(body).join(' ')
  if (question.detail === 'floor') {
    return [...body.matchAll(/第?[\d零一二三四五六七八九十百]+[层楼]|[上下顶底]层|地下.{0,5}层|\bfloor\s*\d+\b/giu)].map(match => match[0]).join(' ')
  }
  return clauses.filter(clause => matchesRecallAttribute({ record: { content: clause } }, question.query, question.detail, question.entityTerms ?? [])).join(' ')
}

function answerEvidenceAtoms(question, injectedText) {
  const query = normalizedAnswerText(question.query)
  const source = answerEvidenceText(question, injectedText)
  if (question.detail === 'clock') return [...source.matchAll(/(?:[01]?\d|2[0-3])[:：][0-5]\d|(?:凌晨|早上|上午|下午|晚上|每日|每天).{0,6}[一二三四五六七八九十\d]+点|\b(?:0?[1-9]|1[0-2])(?::[0-5]\d)?\s*(?:am|pm)\b/giu)].map(match => match[0])
  if (question.detail === 'retention') return [...source.matchAll(/(?:\d+(?:\.\d+)?|[零一二两三四五六七八九十半]+)\s*(?:天|日|周|星期|个月|月|年|小时|分钟|秒)|(?:永久|长期)/gu)].map(match => match[0])
  if (question.detail === 'reason') return answerEvidenceReasonPhrases(injectedText)
  const atoms = new Set()
  for (const match of source.matchAll(/(?<!\d)\d{1,4}(?::\d{1,2})?(?:\.\d+)?(?:\s*(?:天|日|小时|分钟|秒|年|周|次|%|GB|MB|TB|版本))?/giu)) {
    const atom = normalizedAnswerText(match[0])
    if (atom.length >= 2 && !query.includes(atom)) atoms.add(atom)
  }
  for (const match of source.matchAll(/\b[A-Za-z][A-Za-z0-9_.-]{2,}\b/gu)) {
    const atom = normalizedAnswerText(match[0])
    if (!query.includes(atom)) atoms.add(atom)
  }
  for (const run of source.matchAll(/[\p{Script=Han}]{2,}/gu)) {
    const chars = [...run[0]]
    const max = Math.min(chars.length, 12)
    for (let size = 2; size <= max; size += 1) for (let start = 0; start + size <= chars.length; start += 1) {
      const atom = chars.slice(start, start + size).join('')
      if (!ANSWER_STOP_ATOMS.has(atom) && !query.includes(atom)) atoms.add(atom)
    }
  }
  return [...atoms].sort((left, right) => right.length - left.length)
}

function normalizeAnswerEvidenceValue(detail, value) {
  const text = String(value ?? '').normalize('NFKC').replace(/\s+/gu, '').toLowerCase()
  if (detail === 'clock') {
    const match = /^(\d{1,2}):(\d{2})$/u.exec(text)
    return match ? `${Number(match[1])}:${match[2]}` : normalizedAnswerText(text)
  }
  if (detail === 'retention') {
    const match = /^(\d+(?:\.\d+)?)(个月|小时|分钟|星期|天|日|周|月|年|秒)$/u.exec(text)
    if (!match) return normalizedAnswerText(text)
    const unit = ({ 日: '天', 周: '周', 星期: '周', 月: '月', 个月: '月' })[match[2]] ?? match[2]
    return `${Number(match[1])}${unit}`
  }
  return normalizedAnswerText(text)
}

export function assessAnswerCoverage(question, answer) {
  if (!Array.isArray(question.injected) || !question.injected.some(evidence => evidence.verified === true)) {
    if ((question.notInjected?.length ?? 0) > 0) return { answerCoverage: 'not-injected', answerExcerpt: null }
    if ((question.hits?.length ?? 0) === 0) return { answerCoverage: 'no-evidence', answerExcerpt: null }
    return { answerCoverage: 'unverified', answerExcerpt: null }
  }
  const sentences = String(answer ?? '').split(/(?<=[。！？!?])\s*|\n+/u).map(text => text.trim()).filter(Boolean)
  if (sentences.length === 0) return { answerCoverage: 'unverified', answerExcerpt: null }
  for (const evidence of question.injected) {
    if (evidence.verified !== true) continue
    const atoms = answerEvidenceAtoms(question, evidence.text)
    for (const sentence of sentences) {
      const sentenceAtoms = ['clock', 'retention', 'reason'].includes(question.detail) ? answerEvidenceAtoms(question, sentence) : null
      const matches = sentenceAtoms
        ? atoms.some(atom => sentenceAtoms.some(value => question.detail === 'reason'
          ? normalizedAnswerText(value).includes(normalizedAnswerText(atom))
          : normalizeAnswerEvidenceValue(question.detail, value) === normalizeAnswerEvidenceValue(question.detail, atom)))
        : atoms.some(atom => normalizedAnswerText(sentence).includes(atom))
      if (matches) return { answerCoverage: 'covered', answerExcerpt: sentence.slice(0, 240) }
    }
  }
  return { answerCoverage: 'unverified', answerExcerpt: null }
}
