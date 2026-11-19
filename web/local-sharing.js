const $ = selector => document.querySelector(selector)
const projectSelect = $('#project')
const notice = $('#notice')
const REPORT_LIMIT = 20
const BROWSE_LIMIT = 50
let reportProject = ''
let reportOffset = 0
let projectGeneration = 0
let refreshRequest = 0
let searchRequest = 0
let reportRequest = 0
let browseRequest = 0
let browseProject = ''
let browseOffset = 0
let browseTotal = 0
const reportItems = new Map()
let token = new URLSearchParams(location.hash.slice(1)).get('token') || sessionStorage.getItem('dsh-memory-token')
if (new URLSearchParams(location.hash.slice(1)).has('token')) {
  sessionStorage.setItem('dsh-memory-token', token)
  history.replaceState(null, '', location.pathname)
}

function setNotice(message, error = false) {
  notice.textContent = message
  notice.classList.toggle('error', error)
}

function clearProjectViews() {
  reportRequest += 1
  browseRequest += 1
  reportItems.clear()
  reportProject = ''
  reportOffset = 0
  browseProject = ''
  browseOffset = 0
  browseTotal = 0
  for (const selector of ['#results', '#brief', '#scenes', '#rules', '#browse']) $(selector).replaceChildren()
  $('#browse').textContent = '展开后读取当前页。'
  $('#browse-pager').hidden = true
  renderReports()
}

async function api(path, options = {}) {
  if (!token) throw new Error('缺少本机授权，请从服务启动命令重新打开网页。')
  const response = await fetch(path, { cache: 'no-store', ...options,
    headers: { authorization: `Bearer ${token}`, ...(options.body ? { 'content-type': 'application/json' } : {}), ...options.headers } })
  const value = await response.json()
  if (!response.ok) throw new Error(value.error || `请求失败 (${response.status})`)
  return value
}

function projectKey() { return projectSelect.value }
function isCurrentProject(key, generation) { return key === projectKey() && generation === projectGeneration }
function element(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function sourceEvidence(parent, refs = []) {
  for (const ref of refs) {
    const excerpt = typeof ref.excerpt === 'string' && ref.excerpt ? ref.excerpt : null
    if (excerpt) parent.append(element('div', 'source', excerpt))
  }
}

function forgetButton(hit, key, generation, refreshView) {
  const button = element('button', 'danger', '遗忘')
  button.type = 'button'
  button.addEventListener('click', async () => {
    if (!isCurrentProject(key, generation)) return
    if (!confirm('遗忘这条内容及其来源后，它将从其他客户端的检索和相关报告中撤回。继续吗？')) return
    try {
      await api('/api/forget', { method: 'POST', body: JSON.stringify({ id: hit.id, projectKey: key }) })
      if (!isCurrentProject(key, generation)) return
      await refreshView()
      if (!isCurrentProject(key, generation)) return
      await loadReports({ reset: true })
      if (isCurrentProject(key, generation)) setNotice('已从共享记忆撤回该内容。')
    } catch (error) { if (isCurrentProject(key, generation)) setNotice(error.message, true) }
  })
  return button
}

function showSearch(result, key, generation) {
  const root = $('#results')
  root.replaceChildren()
  if (!result.hits.length) { root.append(element('p', 'muted', '没有找到相关记忆或仍获准读取的原文。')); return }
  for (const hit of result.hits) {
    const row = element('article', 'row')
    const head = element('div', 'row-head')
    const title = element('div', 'row-title', `${hit.kind === 'source' ? '原文' : hit.kind} · ${hit.id}@${hit.revision}`)
    const actions = element('div', 'row-actions')
    actions.append(forgetButton(hit, key, generation, () => searchProject(key, $('#query').value.trim())))
    head.append(title, actions)
    row.append(head, element('p', 'row-text', hit.content))
    sourceEvidence(row, hit.sourceRefs)
    root.append(row)
  }
}

async function searchProject(key, query) {
  const generation = projectGeneration
  const request = ++searchRequest
  let result
  try { result = await api(`/api/search?projectKey=${encodeURIComponent(key)}&query=${encodeURIComponent(query)}`) }
  catch (error) {
    if (request === searchRequest && isCurrentProject(key, generation)) setNotice(error.message, true)
    return null
  }
  if (request !== searchRequest || !isCurrentProject(key, generation)) return null
  showSearch(result, key, generation)
  setNotice(`${result.hits.length} 条证据 · 项目 ${key}`)
  return result
}

function renderBrowse(result, key, generation) {
  const root = $('#browse')
  root.replaceChildren()
  const items = Array.isArray(result.items) ? result.items : []
  if (items.length === 0) root.append(element('p', 'muted', '当前项目这一页没有可浏览记忆。'))
  for (const hit of items) {
    const row = element('article', 'row')
    const head = element('div', 'row-head')
    const title = element('div', 'row-title', `${hit.kind} · ${hit.status} · ${hit.id}@${hit.revision}`)
    const actions = element('div', 'row-actions')
    actions.append(forgetButton(hit, key, generation, async () => {
      const query = $('#query').value.trim()
      if (query) await searchProject(key, query)
      await loadBrowsePage({ offset: browseOffset })
    }))
    head.append(title, actions)
    row.append(head, element('p', 'row-text', hit.content))
    sourceEvidence(row, hit.sourceRefs)
    root.append(row)
  }
  const start = result.total === 0 ? 0 : browseOffset + 1
  const end = Math.min(browseOffset + items.length, result.total)
  $('#browse-page').textContent = `${start}–${end} / ${result.total}`
  $('#browse-pager').hidden = result.total <= BROWSE_LIMIT
  $('#browse-prev').disabled = browseOffset <= 0
  $('#browse-next').disabled = browseOffset + items.length >= result.total
}

async function loadBrowsePage({ offset = browseOffset } = {}) {
  const key = projectKey()
  if (!key || !$('#browse-details').open) return null
  const generation = projectGeneration
  const request = ++browseRequest
  const root = $('#browse')
  root.replaceChildren(element('p', 'muted', '正在读取当前页…'))
  try {
    const result = await api(`/api/list?projectKey=${encodeURIComponent(key)}&limit=${BROWSE_LIMIT}&offset=${offset}`)
    if (request !== browseRequest || !isCurrentProject(key, generation)) return null
    const total = Number.isFinite(result.total) ? result.total : 0
    const lastOffset = total === 0 ? 0 : Math.floor((total - 1) / BROWSE_LIMIT) * BROWSE_LIMIT
    if (offset > lastOffset) return loadBrowsePage({ offset: lastOffset })
    browseProject = key
    browseOffset = offset
    browseTotal = total
    renderBrowse(result, key, generation)
    return result
  } catch (error) {
    if (request === browseRequest && isCurrentProject(key, generation)) {
      root.replaceChildren(element('p', 'muted', error.message))
      setNotice(error.message, true)
    }
    return null
  }
}

function showBrief(brief) {
  const root = $('#brief')
  root.replaceChildren()
  if (!brief.total) { root.append(element('p', 'muted', '当前项目还没有档案条目。')); return }
  for (const section of brief.sections) {
    root.append(element('h3', 'row-title', section.title))
    for (const item of section.items) {
      const row = element('article', 'row')
      row.append(element('div', 'row-title', `${item.kind} · ${item.id}@${item.revision}`), element('p', 'row-text', item.content))
      sourceEvidence(row, item.sourceRefs)
      root.append(row)
    }
  }
}

function reportOutcome(report) {
  if (report.outcome === 'pending') return '等待回答'
  if (report.outcome === 'aborted') return '未完成'
  return '已完成'
}

function answerStatus(question, report) {
  const observed = question.answerObserved === true
  switch (question.answerCoverage) {
    case 'covered': return '有证据支持'
    case 'not-injected': return '证据未注入'
    case 'no-evidence': return '没有找到证据'
    case 'pending': return '还未观察到回答'
    case 'aborted': return observed ? '回答已观察，回合未完成' : '还未观察到回答'
    case 'unverified': return observed ? '回答未覆盖证据' : report.outcome === 'completed' ? '覆盖状态未核实' : '还未观察到回答'
    case 'observed': return '回答已观察，逐项未核实'
    default: return '未核实'
  }
}

function renderReports() {
  const root = $('#reports')
  root.replaceChildren()
  const rows = [...reportItems.values()].filter(item => item.projectKey === projectKey()).sort((a, b) => b.at - a.at)
  if (!rows.length) { root.append(element('p', 'muted', '当前项目还没有召回报告。')); return }
  for (const item of rows) {
    const row = element('details', 'row')
    row.append(element('summary', 'row-title', `${new Date(item.at).toLocaleString()} · ${reportOutcome(item.report)}`))
    for (const question of item.report.questions) {
      const status = answerStatus(question, item.report)
      row.append(element('p', 'row-text', `${question.query} · ${status}${question.answerExcerpt ? ` · ${question.answerExcerpt}` : ''}`))
      for (const hit of question.injected) {
        row.append(element('div', 'source', `${hit.id}@${hit.revision} · ${hit.text}`))
        sourceEvidence(row, hit.sourceRefs)
      }
    }
    root.append(row)
  }
}

async function loadReports({ reset = false, offset = reportOffset } = {}) {
  const key = projectKey()
  if (!key) return
  const generation = projectGeneration
  if (reset || reportProject !== key) {
    reportItems.clear()
    reportProject = key
    reportOffset = 0
    offset = 0
  }
  const request = ++reportRequest
  let reports
  try { reports = await api(`/api/reports?projectKey=${encodeURIComponent(key)}&limit=${REPORT_LIMIT}&offset=${offset}`) }
  catch (error) {
    if (request === reportRequest && isCurrentProject(key, generation)) throw error
    return
  }
  if (request !== reportRequest || !isCurrentProject(key, generation)) return
  for (const item of reports) reportItems.set(item.sessionKey, item)
  reportOffset = Math.max(reportOffset, offset + reports.length)
  $('#more-reports').hidden = reports.length < REPORT_LIMIT
  renderReports()
}

async function loadRules(key = projectKey(), generation = projectGeneration) {
  const rules = await api('/api/rules')
  if (!isCurrentProject(key, generation)) return
  const root = $('#rules')
  root.replaceChildren()
  if (!rules.length) { root.append(element('p', 'muted', '没有长期规则。')); return }
  for (const rule of rules) {
    const row = element('article', 'row')
    row.append(element('div', 'row-title', `${rule.kind} · ${rule.id}@${rule.revision}`), element('p', 'row-text', rule.content))
    sourceEvidence(row, rule.sourceRefs)
    root.append(row)
  }
}

async function refresh() {
  const request = ++refreshRequest
  try {
    setNotice('正在刷新…')
    const status = await api('/api/status')
    if (request !== refreshRequest) return
    const selected = projectKey()
    projectSelect.replaceChildren()
    for (const key of status.projects) projectSelect.append(new Option(key, key))
    if (status.projects.includes(selected)) projectSelect.value = selected
    if (projectKey() !== selected) {
      projectGeneration += 1
      clearProjectViews()
    }
    projectSelect.disabled = status.projects.length === 0
    $('#brief').replaceChildren()
    $('#scenes').replaceChildren()
    $('#rules').replaceChildren()
    if (status.projects.length) await loadReports({ reset: reportProject !== projectKey() })
    else { reportItems.clear(); reportProject = ''; reportOffset = 0; renderReports() }
    if (status.projects.length && $('#browse-details').open) {
      const offset = browseProject === projectKey() ? browseOffset : 0
      await loadBrowsePage({ offset })
    }
    if (request !== refreshRequest) return
    setNotice(status.projects.length ? `服务已连接 · ${status.projects.length} 个项目` : '服务已连接，尚无项目记忆。')
  } catch (error) { if (request === refreshRequest) setNotice(error.message, true) }
}

$('#search-form').addEventListener('submit', async event => {
  event.preventDefault()
  const key = projectKey()
  if (!key) return
  try {
    setNotice('正在查找…')
    const query = $('#query').value.trim()
    await searchProject(key, query)
  } catch { /* Search errors are reported only by the still-current request. */ }
})

$('#remember-form').addEventListener('submit', async event => {
  event.preventDefault()
  const key = projectKey()
  const generation = projectGeneration
  if (!key) return
  const originalUserMessage = $('#original-user-message').value
  if (!confirm('确认把这段完整原话保存到当前项目的 DSH 共享记忆中？')) return
  try {
    const result = await api('/api/remember', { method: 'POST', body: JSON.stringify({ projectKey: key, originalUserMessage,
      sessionId: sessionStorage.getItem('dsh-memory-web-session') || (sessionStorage.setItem('dsh-memory-web-session', crypto.randomUUID()), sessionStorage.getItem('dsh-memory-web-session')),
      messageId: crypto.randomUUID() }) })
    if (isCurrentProject(key, generation)) setNotice(`已保存 ${result.records.length} 条分段记忆，并保留完整 L0 原文。`)
  } catch (error) { if (isCurrentProject(key, generation)) setNotice(error.message, true) }
})

$('#load-brief').addEventListener('click', async () => {
  const key = projectKey()
  const generation = projectGeneration
  if (!key) return
  try {
    const brief = await api(`/api/brief?projectKey=${encodeURIComponent(key)}`)
    if (!isCurrentProject(key, generation)) return
    showBrief(brief)
    const scenes = await api(`/api/scenes?projectKey=${encodeURIComponent(key)}`)
    if (!isCurrentProject(key, generation)) return
    const root = $('#scenes')
    root.replaceChildren()
    if (!scenes.length) root.append(element('p', 'muted', '当前项目还没有场景。'))
    for (const scene of scenes) {
      const row = element('details', 'row')
      row.append(element('summary', 'row-title', `${scene.title} · ${scene.records.length} 条`), element('pre', 'row-text', scene.text))
      root.append(row)
    }
    setNotice(`已读取 ${brief.total} 条档案条目与 ${scenes.length} 个场景。`)
  } catch (error) { if (isCurrentProject(key, generation)) setNotice(error.message, true) }
})

$('#load-rules').addEventListener('click', async () => {
  const key = projectKey()
  const generation = projectGeneration
  try { await loadRules(key, generation); if (isCurrentProject(key, generation)) setNotice('已读取长期规则。') }
  catch (error) { if (isCurrentProject(key, generation)) setNotice(error.message, true) }
})

$('#more-reports').addEventListener('click', async () => {
  const key = projectKey()
  const generation = projectGeneration
  try { await loadReports({ offset: reportOffset }) }
  catch (error) { if (isCurrentProject(key, generation)) setNotice(error.message, true) }
})

$('#browse-details').addEventListener('toggle', () => {
  if ($('#browse-details').open) {
    const offset = browseProject === projectKey() ? browseOffset : 0
    void loadBrowsePage({ offset })
  } else browseRequest += 1
})
$('#browse-prev').addEventListener('click', () => {
  void loadBrowsePage({ offset: Math.max(0, browseOffset - BROWSE_LIMIT) })
})
$('#browse-next').addEventListener('click', () => {
  if (browseOffset + BROWSE_LIMIT < browseTotal) void loadBrowsePage({ offset: browseOffset + BROWSE_LIMIT })
})

$('#refresh').addEventListener('click', () => { void refresh() })
projectSelect.addEventListener('change', () => {
  projectGeneration += 1
  clearProjectViews()
  void refresh()
})
void refresh()
setInterval(() => {
  const key = projectKey()
  const generation = projectGeneration
  void loadReports({ offset: 0 }).catch(error => { if (isCurrentProject(key, generation)) setNotice(error.message, true) })
}, 15_000)
