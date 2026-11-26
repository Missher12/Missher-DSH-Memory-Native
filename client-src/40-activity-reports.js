    const HEAT_WEEKS = 53
    const PALETTE_KEY = 'dsh.memory.particle-color.v1'
    const PALETTE_PRESETS = [
      { value: '', key: 'themeColor' },
      { value: '#8b6ccf', key: 'violetColor' },
      { value: '#447fcb', key: 'blueColor' },
      { value: '#369f97', key: 'tealColor' },
      { value: '#c69749', key: 'amberColor' },
      { value: '#ca758f', key: 'roseColor' },
    ]
    const HEAT_MODES = ['daily', 'weekly', 'cumulative']

    function dateKey(date) {
      const month = String(date.getMonth() + 1).padStart(2, '0')
      const day = String(date.getDate()).padStart(2, '0')
      return date.getFullYear() + '-' + month + '-' + day
    }

    function monthShort(date, locale) {
      try {
        return new Intl.DateTimeFormat(locale || undefined, { month: 'short' }).format(date)
      } catch {
        return (date.getMonth() + 1) + '\u6708'
      }
    }

    function compactNumber(value, locale) {
      try {
        return new Intl.NumberFormat(locale || undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(value)
      } catch {
        return String(value)
      }
    }

    function readPalette() {
      try {
        const value = localStorage.getItem(PALETTE_KEY)
        return typeof value === 'string' && /^#[0-9a-f]{6}$/iu.test(value) ? value.toLowerCase() : ''
      } catch {
        return ''
      }
    }

    function writePalette(value) {
      try {
        if (value === '') localStorage.removeItem(PALETTE_KEY)
        else localStorage.setItem(PALETTE_KEY, value)
      } catch {
        // Colour is a cosmetic preference; storage may be unavailable.
      }
    }

    function colorLevel(value, maximum) {
      if (value <= 0 || maximum <= 0) return 0
      return Math.min(5, Math.max(1, Math.ceil((5 * value) / maximum)))
    }

    function logarithmicRows(value, maximum) {
      if (value <= 0 || maximum <= 0) return 0
      const ratio = Math.log1p(value) / Math.log1p(maximum)
      return Math.min(7, Math.max(1, Math.ceil(ratio * 7)))
    }

    function cumulativeRows(value, maximum) {
      if (value <= 0 || maximum <= 0) return 0
      return Math.min(7, Math.max(1, Math.ceil((value / maximum) * 7)))
    }

    function buildHeatWeeks(counts, mode, t) {
      const today = new Date()
      today.setHours(0, 0, 0, 0)
      const first = new Date(today)
      first.setDate(today.getDate() - today.getDay() - (HEAT_WEEKS - 1) * 7)
      const daily = []
      for (let week = 0; week < HEAT_WEEKS; week += 1) {
        const days = []
        for (let row = 0; row < 7; row += 1) {
          const date = new Date(first)
          date.setDate(first.getDate() + week * 7 + row)
          if (date.getTime() > today.getTime()) {
            days.push(null)
            continue
          }
          const key = dateKey(date)
          days.push({ key, count: counts.get(key) ?? 0 })
        }
        daily.push(days)
      }
      if (mode === 'daily') {
        const maximum = Math.max(0, ...daily.flat().filter((cell) => cell !== null).map((cell) => cell.count))
        return daily.map((days) => ({
          tip: null,
          cells: days.map((cell) => (cell === null ? null : { ...cell, level: colorLevel(cell.count, maximum) })),
        }))
      }
      if (mode === 'weekly') {
        const totals = daily.map((days) => days.reduce((sum, cell) => sum + (cell === null ? 0 : cell.count), 0))
        const maximum = Math.max(0, ...totals)
        return daily.map((days, index) => {
          const value = totals[index]
          const level = colorLevel(value, maximum)
          const filled = logarithmicRows(value, maximum)
          const present = days.filter((cell) => cell !== null)
          const start = present[0] === undefined ? '' : present[0].key
          const end = present[present.length - 1] === undefined ? '' : present[present.length - 1].key
          return {
            tip: value <= 0 ? null : t('activity.weeklyTooltip', { start, end, count: compactNumber(value) }),
            cells: days.map((cell, row) => (cell === null ? null : { ...cell, level: row >= present.length - filled ? level : 0 })),
          }
        })
      }
      const totals = daily.map((days) => days.reduce((sum, cell) => sum + (cell === null ? 0 : cell.count), 0))
      let running = 0
      const cumulative = totals.map((value) => {
        running += value
        return running
      })
      const maximum = Math.max(0, ...cumulative)
      return daily.map((days, index) => {
        const value = cumulative[index]
        const level = colorLevel(value, maximum)
        const filled = cumulativeRows(value, maximum)
        const present = days.filter((cell) => cell !== null)
        const end = present[present.length - 1] === undefined ? '' : present[present.length - 1].key
        return {
          tip: value <= 0 ? null : t('activity.cumulativeTooltip', { end, count: compactNumber(value) }),
          cells: days.map((cell, row) => (cell === null ? null : { ...cell, level: row >= present.length - filled ? level : 0 })),
        }
      })
    }

    function MemoryTotals({ stats, t, locale }) {
      const counts = ['total', 'active', 'candidate', 'projects']
      return h('dl', { className: 'dsh-memory-activity-totals' },
        counts.filter(key => key !== 'candidate' || stats.candidate > 0).map(key =>
          h('div', { key, 'data-metric': key },
            h('dt', null, t('stats.' + key)),
            h('dd', null, stats[key].toLocaleString(locale || undefined)))))
    }

    function ActivityHeading({ title, value, warning = false }) {
      return [
        h('span', { key: 'title', className: 'dsh-memory-activity-label' }, title),
        value ? h('span', { key: 'value', className: warning ? 'dsh-memory-activity-warning' : 'dsh-memory-muted' }, value) : null,
      ]
    }

    function ActivityDisclosure({ title, value, warning, children }) {
      const attrs = { className: 'dsh-memory-activity-disclosure dsh-memory-disclosure' }
      const heading = h(ActivityHeading, { title, value, warning })
      if (children == null) return h('div', { className: 'dsh-memory-activity-line' }, heading)
      return h('details', attrs,
        h('summary', { className: 'dsh-memory-activity-line dsh-memory-disclosure-head' }, heading),
        h('div', { className: 'dsh-memory-activity-details' }, children))
    }

    function PalettePicker(props) {
      const { color, onColor, t } = props
      const [open, setOpen] = React.useState(false)
      const rootRef = React.useRef(null)
      React.useEffect(() => {
        if (!open) return undefined
        const onPointerDown = (event) => {
          if (rootRef.current !== null && !rootRef.current.contains(event.target)) setOpen(false)
        }
        const onKeyDown = (event) => {
          if (event.key === 'Escape') setOpen(false)
        }
        document.addEventListener('mousedown', onPointerDown)
        document.addEventListener('keydown', onKeyDown)
        return () => {
          document.removeEventListener('mousedown', onPointerDown)
          document.removeEventListener('keydown', onKeyDown)
        }
      }, [open])
      return h('div', { className: 'dsh-memory-palette', ref: rootRef },
        h('button', {
          type: 'button',
          className: 'dsh-memory-palette-trigger',
          'aria-label': t('activity.colorMenu'),
          'aria-expanded': open,
          'aria-haspopup': 'listbox',
          onClick: () => setOpen((value) => !value),
          title: t('activity.colorMenu'),
        },
        h('span', { className: 'dsh-memory-palette-swatch', 'aria-hidden': true,
          style: { '--dsh-memory-swatch': color === '' ? 'var(--memory-accent)' : color } },
          h('i', null), h('i', null), h('i', null))),
        open ? h('div', { className: 'dsh-memory-palette-menu', role: 'listbox', 'aria-label': t('activity.colorMenu') },
          PALETTE_PRESETS.map((preset) => h('button', {
            key: preset.key,
            type: 'button',
            role: 'option',
            'aria-selected': preset.value === color,
            className: 'dsh-memory-palette-option',
            onClick: () => {
              onColor(preset.value)
              setOpen(false)
            },
          },
          preset.value === '' ? h('span', { className: 'dsh-memory-palette-theme' }, '\u25d1') : h('i', { className: 'dsh-memory-palette-dot', style: { background: preset.value } }),
          t('activity.' + preset.key))),
          h('label', { className: 'dsh-memory-palette-option' },
            h('input', {
              type: 'color',
              className: 'dsh-memory-color-input',
              value: color === '' ? '#2f6df6' : color,
              onChange: (event) => onColor(event.target.value),
            }),
            t('activity.customColor'))) : null)
    }

    function ActivityHeatmap(props) {
      const { activity, t, locale } = props
      const [mode, setMode] = React.useState('daily')
      const [color, setColor] = React.useState(readPalette)
      const [tooltip, setTooltip] = React.useState(null)
      const stageRef = React.useRef(null)
      const counts = new Map()
      const days = activity !== null && activity !== undefined && Array.isArray(activity.days) ? activity.days : []
      for (const day of days) {
        if (day === null || typeof day !== 'object' || typeof day.date !== 'string') continue
        const count = Number(day.count)
        if (!Number.isFinite(count) || count <= 0) continue
        counts.set(day.date, count)
      }
      const weeks = counts.size > 0 ? buildHeatWeeks(counts, mode, t) : []
      const labels = []
      let lastMonth = ''
      for (let week = 0; week < weeks.length; week += 1) {
        const firstCell = weeks[week].cells.find((cell) => cell !== null)
        if (firstCell === undefined) continue
        const month = firstCell.key.slice(0, 7)
        if (month === lastMonth) continue
        const isFirst = lastMonth === ''
        lastMonth = month
        if (isFirst) continue
        const sunday = new Date(firstCell.key + 'T00:00:00')
        labels.push({ week, text: monthShort(sunday, locale) })
      }
      const showTooltip = (event, column, cell) => {
        const stage = stageRef.current
        if (stage === null) return
        const rect = event.currentTarget.getBoundingClientRect()
        const stageRect = stage.getBoundingClientRect()
        const text = column.tip === null || column.tip === undefined
          ? t('activity.cell', { date: cell.key, count: String(cell.count) })
          : column.tip
        const maxWidth = Math.min(240, stageRect.width - 16)
        const half = maxWidth / 2
        const center = rect.left - stageRect.left + rect.width / 2
        const x = stageRect.width > maxWidth + 16
          ? Math.min(Math.max(center, 8 + half), stageRect.width - 8 - half)
          : stageRect.width / 2
        const above = rect.top - stageRect.top > 34
        const top = above ? rect.top - stageRect.top - 28 : rect.bottom - stageRect.top + 6
        setTooltip({ x, top, text })
      }
      return h('section', { className: 'dsh-memory-activity', 'aria-label': t('activity.title'), style: { '--dsh-memory-particle-color': color === '' ? 'var(--dsw-alias-state-business-primary, #2f6df6)' : color } },
        h('div', { className: 'dsh-memory-activity-head' },
          h('div', { className: 'dsh-memory-activity-title' },
            h('h3', null, t('activity.title')),
            h(PalettePicker, { color, onColor: (next) => { setColor(next); writePalette(next) }, t })),
          h('div', { className: 'dsh-memory-tabs', role: 'tablist', 'aria-label': t('activity.title') },
            HEAT_MODES.map((item) => h('button', {
              key: item,
              type: 'button',
              role: 'tab',
              'aria-selected': mode === item,
              onClick: () => setMode(item),
            }, t('activity.mode.' + item))))),
        weeks.length === 0
          ? h('p', { className: 'dsh-memory-heat-empty dsh-memory-help' }, t('activity.sparseHint'))
          : h(React.Fragment, null,
            h('div', { className: 'dsh-memory-heatmap-stage', ref: stageRef },
              h('div', { className: 'dsh-memory-heatmap' },
                weeks.map((column, week) => column.cells.map((cell, row) => (cell === null
                  ? h('span', { key: week + ':' + row, className: 'dsh-memory-heat-cell', 'data-level': '0', 'data-future': 'true' })
                  : h('span', {
                    key: week + ':' + row,
                    className: 'dsh-memory-heat-cell',
                    'data-level': String(cell.level),
                    onMouseEnter: (event) => showTooltip(event, column, cell),
                    onMouseLeave: () => setTooltip(null),
                    'aria-label': t('activity.cell', { date: cell.key, count: String(cell.count) }),
                  }))))),
              tooltip === null ? null : h('div', { className: 'dsh-memory-heat-tooltip', style: { left: tooltip.x, top: tooltip.top } }, tooltip.text)),
            h('div', { className: 'dsh-memory-heat-months' },
              labels.map((label) => h('span', { key: label.week, style: { gridColumn: String(label.week + 1) } }, label.text)))))
    }

    function ContextUsage({ sessionId, sample, enabled, t, locale }) {
      const title = t('contextUsage.title')
      const usage = sample?.sessionId === sessionId ? sample?.usage : null
      const hasUsage = enabled && Number.isInteger(usage?.tokens) && Number.isInteger(usage?.budget) && usage.budget >= 0
      const amount = hasUsage ? t('contextUsage.amount', {
        tokens: usage.tokens.toLocaleString(locale || undefined),
        budget: usage.budget.toLocaleString(locale || undefined),
      }) : null
      const value = hasUsage ? Math.min(usage.tokens, usage.budget) : 0
      const detail = hasUsage
        ? t(usage.budget === 0 ? 'contextUsage.noRoom' : usage.tokens === 0 ? 'contextUsage.detailZero' : 'contextUsage.detail', { items: String(usage.items) })
        : t(!enabled ? 'contextUsage.disabled' : !sessionId ? 'contextUsage.noSession' : 'contextUsage.empty')
      return h('section', { className: 'dsh-memory-context-usage' },
        h('div', { className: 'dsh-memory-context-usage-head' },
          h('h3', { className: 'dsh-memory-section-title' }, title),
          amount === null
            ? h('span', { className: 'dsh-memory-muted' }, detail)
            : h('span', { className: 'dsh-memory-context-usage-amount', title: formatTime(usage.at, locale) }, amount)),
        !hasUsage || usage.budget === 0 ? null : h('div', {
          className: 'dsh-memory-context-usage-track', role: 'meter', 'aria-label': title,
          'aria-valuemin': 0, 'aria-valuemax': usage.budget, 'aria-valuenow': value, 'aria-valuetext': amount,
        }, h('span', { style: { width: (100 * value / usage.budget) + '%' } })),
        hasUsage ? h('p', { className: 'dsh-memory-help' }, detail) : null)
    }

    function RecallReport({ report, t, locale, call, onSaved }) {
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')
      const forget = async evidence => {
        if (busy || !call || !window.confirm(t('recall.forgetConfirm'))) return
        setBusy(true); setError('')
        try { await call('removeMemory', { id: evidence.id, scope: 'project', projectKey: evidence.projectKey }); await onSaved?.() }
        catch (failure) { setError(messageOf(failure)) }
        finally { setBusy(false) }
      }
      const title = t('recall.title')
      if (!report) return h(ActivityDisclosure, { title, value: t('recall.empty') })
      const stateKey = { 'not-needed': 'local', completed: 'completed', failed: 'failed', unknown: 'unknown', 'budget-exhausted': 'budget' }[report.completionState] ?? 'notSent'
      const sent = ['completed', 'unknown', 'requested'].includes(report.providerState)
      const tokens = report.usage?.totalTokens
      const questions = Array.isArray(report.questions) ? report.questions : []
      const covered = questions.filter(question => question.answerCoverage === 'covered').length
      const coverage = t('recall.coverage', { covered: String(covered), total: String(report.total ?? questions.length) })
      const warning = report.outcome === 'aborted' || ['failed', 'unknown', 'budget'].includes(stateKey)
      const value = [coverage, report.outcome === 'pending' ? t('recall.answer.pending') : report.outcome === 'aborted' ? t('recall.answer.aborted') : ''].filter(Boolean).join(' · ')
      const evidenceNode = (evidence, showInjected = false) => {
        const refs = Array.isArray(evidence.sourceRefs) ? evidence.sourceRefs : []
        const source = evidence.noteTitle ?? t('recall.memorySource', {
          kind: evidence.kind ?? 'memory', scope: evidence.scope === 'global' ? t('library.scope.global') : (evidence.projectKey ?? t('library.scope.project')),
        })
        return h('div', { key: evidence.id },
          showInjected && evidence.text ? h('blockquote', null, evidence.text) : null,
          h('p', { className: 'dsh-memory-muted' }, [evidence.verified === false ? t('recall.answer.unverified') : null, source].filter(Boolean).join(' · ')),
          showInjected ? null : evidence.selectedQuote ? h('blockquote', null, evidence.selectedQuote)
            : refs.map((ref, index) => ref.excerpt ? h('blockquote', { key: index }, ref.excerpt) : null),
          evidence.kind === 'source' ? h('div', { className: 'dsh-memory-danger-actions' }, h('button', {
            type: 'button', className: 'dsh-memory-button', 'data-danger': 'true', disabled: busy,
            onClick: () => forget(evidence),
          }, t('recall.forgetSource'))) : null)
      }
      const questionRows = questions.map((question, index) => {
        const status = t('recall.answer.' + (question.answerCoverage ?? 'pending'))
        const injected = Array.isArray(question.injected) ? question.injected : []
        const injectedIds = new Set(injected.map(evidence => evidence.id))
        const notInjected = Array.isArray(question.notInjected) ? question.notInjected : []
        const hiddenIds = new Set([...injectedIds, ...notInjected.map(evidence => evidence.id)])
        const additionalHits = (question.hits ?? []).filter(evidence => !hiddenIds.has(evidence.id))
        const detailSections = []
        const projected = question.durationAtEvent?.projected === true
        if (injected.length) detailSections.push(h('div', { key: 'injected' },
          h('strong', null, t('recall.injected')),
          projected ? h('blockquote', null, injected[0].text) : null,
          projected ? h('strong', null, t('recall.sourceQuotes')) : null,
          h('ul', null, injected.map((evidence, i) => h('li', { key: evidence.id + ':' + i }, evidenceNode(evidence, !projected))))))
        detailSections.push(h('div', { key: 'answer' }, h('strong', null, t('recall.answer')),
          question.answerCoverage === 'covered' && question.answerExcerpt
            ? h('blockquote', null, question.answerExcerpt)
            : h('p', { className: 'dsh-memory-muted' }, status)))
        if (additionalHits.length) detailSections.push(h('div', { key: 'hits' },
          h('strong', null, t('recall.hits')),
          h('ul', null, additionalHits.map(evidence => h('li', { key: evidence.id }, evidenceNode(evidence))))))
        if (notInjected.length) detailSections.push(h('div', { key: 'not-injected' },
          h('strong', null, t('recall.notInjected')),
          h('ul', null, notInjected.map(evidence => h('li', { key: evidence.id }, evidenceNode(evidence))))))
        return h('li', { key: index }, h('details', { className: 'dsh-memory-brief-sources' },
          h('summary', null, question.query, ' · ', status),
          h('div', { className: 'dsh-memory-activity-details' }, detailSections)))
      })
      return h(ActivityDisclosure, { title, value, warning },
        h('p', { className: 'dsh-memory-brief-meta' },
          Number.isFinite(report.at) ? h('time', { dateTime: new Date(report.at).toISOString() }, new Date(report.at).toLocaleString(locale)) : null,
          report.projectKey ? h('span', null, report.projectKey) : null,
          warning || !coverage ? null : h('span', null, t('recall.' + stateKey)),
          sent && report.provider?.model ? h('span', null, report.provider.model) : null,
          sent ? h('span', null, Number.isFinite(tokens) ? t('recall.usage', { tokens: String(tokens) }) : t('recall.usageUnknown')) : null),
        error ? h('p', { role: 'alert', className: 'dsh-memory-error-text' }, error) : null,
        report.reason ? h('p', { className: 'dsh-memory-muted' }, report.reason) : null,
        report.localDeepRecall ? h('p', { className: 'dsh-memory-muted' }, t('recall.localDeepUsage', {
          count: String(report.localDeepRecall.queries.length),
          tokens: report.localDeepRecall.tokens.toLocaleString(locale || undefined),
          limit: report.localDeepRecall.limit.toLocaleString(locale || undefined),
        })) : null,
        questionRows.length ? h('ul', null, questionRows) : null)
    }

    function ProjectBrief({ call, projectKeys, initialProject, t, locale }) {
      const [project, setProject] = React.useState(initialProject ?? '')
      const [offset, setOffset] = React.useState(0)
      const [result, setResult] = React.useState(null)
      const [error, setError] = React.useState('')
      const [loading, setLoading] = React.useState(false)
      const [refresh, setRefresh] = React.useState(0)
      const options = [...new Set([...projectKeys, ...(initialProject ? [initialProject] : [])])]
      React.useEffect(() => {
        if (!project && initialProject) setProject(initialProject)
      }, [project, initialProject])
      React.useEffect(() => {
        if (!call || !project) return undefined
        let cancelled = false
        setLoading(true); setError(''); setResult(null)
        call('projectBrief', { projectKey: project, offset, limit: 40 })
          .then(next => { if (!cancelled) setResult(next) })
          .catch(failure => { if (!cancelled) setError(messageOf(failure)) })
          .finally(() => { if (!cancelled) setLoading(false) })
        return () => { cancelled = true }
      }, [call, project, offset, refresh])
      const sectionNodes = (result?.sections ?? []).map(section => {
        const items = section.items.map(item => {
          const statusKey = item.status !== 'active' ? 'status.' + item.status
            : Number.isFinite(item.validTo) && item.validTo <= Date.now() ? 'brief.expired'
              : Number.isFinite(item.validFrom) && item.validFrom > Date.now() ? 'brief.pending' : 'status.active'
          const sources = (item.sourceRefs ?? []).map((ref, index) => h('div', { key: index },
            ref.excerpt ? h('blockquote', null, ref.excerpt) : h('p', null, t('brief.noQuote')),
            h('p', { className: 'dsh-memory-muted' }, [ref.role === 'user' ? t('brief.user') : ref.role, ref.sessionId].filter(Boolean).join(' · '))))
          return h('li', { key: item.id, className: 'dsh-memory-history-item' },
            h('p', { className: 'dsh-memory-history-content' }, item.content),
            h('details', { className: 'dsh-memory-brief-sources dsh-memory-brief-entry' },
              h('summary', null,
                h('span', { className: 'dsh-memory-brief-meta' },
                  h('span', null, t(statusKey)),
                  Number.isFinite(item.validFrom) ? h('span', null, t('brief.since', { time: formatTime(item.validFrom, locale) })) : null,
                  Number.isFinite(item.validTo) ? h('span', null, t('brief.until', { time: formatTime(item.validTo, locale) })) : null),
                h('span', { className: 'dsh-memory-brief-toggle' }, t('brief.sources'), sources.length ? ' · ' + sources.length : '')),
              sources.length ? sources : h('p', { className: 'dsh-memory-muted' }, t('brief.noQuote'))))
        })
        return h('section', { key: section.id, className: 'dsh-memory-brief-section' },
          h('h3', { className: 'dsh-memory-section-title' }, t('brief.' + section.id)),
          h('ul', { className: 'dsh-memory-history' }, items))
      })
      return h('section', { className: 'dsh-memory-brief' },
        h('div', { className: 'dsh-memory-brief-tools' },
          h(Field, { label: t('brief.project') },
            h(Select, { className: 'dsh-memory-select', value: project, title: project, 'aria-label': t('brief.project'), onChange: event => { setProject(event.target.value); setOffset(0) } },
              !project ? h('option', { value: '' }, t('brief.choose')) : null,
              options.map(key => h('option', { key, value: key }, key)))),
          h('button', { type: 'button', className: 'dsh-memory-button', disabled: loading || !project, onClick: () => setRefresh(value => value + 1) }, t('actions.refresh'))),
        loading ? h('p', { role: 'status', className: 'dsh-memory-muted' }, t('list.loading')) : null,
        error ? h('p', { role: 'alert', className: 'dsh-memory-error-text' }, error) : null,
        !project ? h('p', { className: 'dsh-memory-muted' }, t('error.missingProject')) : null,
        result?.total === 0 ? h('p', { className: 'dsh-memory-muted' }, t('brief.empty')) : null,
        sectionNodes,
        result ? h('div', { className: 'dsh-memory-pager' },
          h('span', null, t('pager.total', { total: String(result.total) })),
          h('div', { className: 'dsh-memory-pager-actions' },
            h('button', { type: 'button', className: 'dsh-memory-button', disabled: offset === 0 || loading, onClick: () => setOffset(Math.max(0, offset - 40)) }, t('pager.prev')),
            h('button', { type: 'button', className: 'dsh-memory-button', disabled: result.nextOffset == null || loading, onClick: () => setOffset(result.nextOffset) }, t('pager.next')))) : null)
    }

    function ProfileView(props) {
      const { profile, t } = props
      const traits = profile !== null && profile !== undefined && Array.isArray(profile.traits) ? profile.traits : []
      const total = typeof profile?.total === 'number' ? profile.total : traits.length
      return h('section', { className: 'dsh-memory-profile' },
        h('div', { className: 'dsh-memory-section-head' },
          h('h3', { className: 'dsh-memory-section-title' }, t('profile.title')),
          h('span', { className: 'dsh-memory-list-total' }, t('profile.summary', { count: String(total) }))),
        traits.length === 0
          ? h('p', { className: 'dsh-memory-muted' }, t('profile.empty'))
          : h('ul', { className: 'dsh-memory-profile-list' },
            traits.map(trait => {
              const evidence = Array.isArray(trait.evidence) ? trait.evidence.slice(0, 3) : []
              const heading = h('span', { className: 'dsh-memory-profile-line' },
                h('span', { className: 'dsh-memory-profile-statement' }, trait.statement),
                h('span', { className: 'dsh-memory-profile-meta' },
                  t('profile.evidence', { count: String(trait.evidenceCount) }), ' · ',
                  t('row.confidence', { value: Number(trait.confidence).toFixed(2) })))
              return h('li', { key: trait.id, className: 'dsh-memory-profile-item' },
                evidence.length === 0 ? heading : h('details', { className: 'dsh-memory-disclosure' },
                  h('summary', { className: 'dsh-memory-disclosure-head' }, heading),
                  h('ul', { className: 'dsh-memory-profile-evidence' },
                    evidence.map(item => h('li', { key: item.id }, item.content)))))
            })))
    }

    /** Seven-day injection and extraction token usage. */
    function TokenTrend(props) {
      const { usage, t } = props
      const days = usage !== null && usage !== undefined && Array.isArray(usage.days) ? usage.days : []
      const totals = usage !== null && usage !== undefined && usage.totals !== null && typeof usage.totals === 'object' ? usage.totals : {}
      const number = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
      const tokensOf = (day, kind) => {
        if (day === null || day === undefined || day[kind] === null || day[kind] === undefined) return 0
        return number(day[kind].tokens)
      }
      const injectTokens = number(totals.injectTokens)
      const extractTokens = number(totals.extractTokens)
      const total = injectTokens + extractTokens
      const max = days.reduce((peak, day) => Math.max(peak, tokensOf(day, 'inject'), tokensOf(day, 'extract')), 0)
      const barHeight = (value) => (value <= 0 ? '0px' : Math.max(3, Math.round((value / Math.max(1, max)) * 60)) + 'px')
      const overBudget = number(totals.overBudget)
      const chart = days.length === 0 || total === 0
        ? h('p', { className: 'dsh-memory-trend-empty' }, t('usage.empty'))
        : h('div', { className: 'dsh-memory-trend-chart', role: 'img', 'aria-label': t('usage.total', { tokens: String(total) }) },
          days.map((day) => h('div', {
            key: day.date,
            className: 'dsh-memory-trend-col',
            title: t('usage.day', {
              date: String(day.date ?? ''),
              inject: String(tokensOf(day, 'inject')),
              extract: String(tokensOf(day, 'extract')),
            }),
          },
          h('div', { className: 'dsh-memory-trend-bars' },
            h('i', { className: 'dsh-memory-trend-bar', 'data-kind': 'inject', style: { height: barHeight(tokensOf(day, 'inject')) } }),
            h('i', { className: 'dsh-memory-trend-bar', 'data-kind': 'extract', style: { height: barHeight(tokensOf(day, 'extract')) } })),
          h('span', { className: 'dsh-memory-trend-date' }, String(day.date ?? '').slice(5).replace('-', '/')))))
      return h('div', { className: 'dsh-memory-trend' },
        h('div', { className: 'dsh-memory-trend-head' },
          h('h4', { className: 'dsh-memory-trend-title' }, t('usage.title')),
          h('span', { className: 'dsh-memory-trend-total' }, t('usage.total', { tokens: String(total) }))),
        chart,
        total === 0
          ? null
          : h('div', { className: 'dsh-memory-trend-legend' },
            h('span', null, h('i', { 'data-kind': 'inject' }), t('usage.inject') + ' ' + String(injectTokens)),
            h('span', null, h('i', { 'data-kind': 'extract' }), t('usage.extract') + ' ' + String(extractTokens)),
            h('span', null, t('usage.avg', {
              tokens: String(number(totals.injectCalls) === 0 ? 0 : Math.round(injectTokens / number(totals.injectCalls))),
            })),
            overBudget > 0 ? h('em', null, t('usage.overBudget', { count: String(overBudget) })) : null),
        total === 0 && number(totals.extractProviderCalls) === 0
          ? null
          : h('p', { className: 'dsh-memory-trend-note' }, number(totals.extractProviderCalls) > 0
            ? t('usage.provider', {
              calls: String(totals.extractProviderCalls),
              input: String(totals.extractProviderInputTokens ?? '—'),
              output: String(totals.extractProviderOutputTokens ?? '—'),
              total: String(totals.extractProviderTotalTokens ?? '—'),
            })
            : t('usage.providerMissing')))
    }
