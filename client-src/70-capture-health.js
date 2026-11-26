    function revisionDiff(older, newer) {
      if (older === null || newer === null) return null
      const before = String(older.content ?? '')
      const after = String(newer.content ?? '')
      if (before === after) return null
      let start = 0
      while (start < before.length && start < after.length && before[start] === after[start]) start += 1
      let endBefore = before.length - 1
      let endAfter = after.length - 1
      while (endBefore >= start && endAfter >= start && before[endBefore] === after[endAfter]) {
        endBefore -= 1
        endAfter -= 1
      }
      return { removed: before.slice(start, endBefore + 1), added: after.slice(start, endAfter + 1) }
    }

    function ExtractionStatus({ stats, call, t, locale, onSaved }) {
      const [retrying, setRetrying] = React.useState(false)
      const [notice, setNotice] = React.useState('')
      const counts = stats.capture ?? {}
      const states = ['pending', 'running', 'partial', 'failed', 'unknown']
      const queued = states.filter(state => counts[state] > 0)
      const canRetry = queued.some(state => state !== 'running')
      const warning = queued.some(state => ['partial', 'failed', 'unknown'].includes(state))
      const value = [...(stats.captureEnabled ? [] : [t('activity.off')]),
        ...queued.map(state => t('activity.queue.' + state, { count: counts[state] }))].join(' · ') || t('activity.idle')
      const budget = stats.captureBudget
      const retryCapture = async () => {
        if (call === null || retrying) return
        setRetrying(true)
        setNotice('')
        try {
          const status = await call('captureStatus', {})
          const tasks = (Array.isArray(status?.tasks) ? status.tasks : []).filter(entry => !entry.continuationTaskIds?.length)
          const task = ['partial', 'failed', 'pending', 'unknown'].map(state => tasks.find(entry => entry.status === state)).find(Boolean)
          if (task === undefined) {
            setNotice(t('settings.captureNothing'))
            return
          }
          if (task.status === 'unknown' && !window.confirm(t('settings.captureUnknownConfirm'))) return
          await call('captureRetry', { taskId: task.id, confirmUnknown: task.status === 'unknown' })
          setNotice(t('settings.captureRetried'))
          onSaved()
        } catch (failure) {
          setNotice(t('settings.captureRetryFailed', { reason: messageOf(failure) }))
        } finally {
          setRetrying(false)
        }
      }

      return h('section', { className: 'dsh-memory-extraction-status' },
        h('div', { className: 'dsh-memory-activity-line' },
          h(ActivityHeading, { title: t('activity.extraction'), value, warning }),
          canRetry ? h('button', { type: 'button', className: 'dsh-memory-button', onClick: retryCapture, disabled: retrying || !call },
            t('settings.captureRetry')) : null),
        budget?.waiting > 0 ? h('p', { className: 'dsh-memory-muted', role: 'status' },
          t(budget.resumeAt ? 'settings.captureResume' : 'settings.capturePaused', {
            count: budget.waiting, time: formatTime(budget.resumeAt, locale),
          })) : null,
        notice ? h('p', { className: 'dsh-memory-settings-notice', role: 'status' }, notice) : null)
    }

    function ActivityTrends({ stats, activity, locale, t }) {
      const storage = stats.captureStorage
      const storageNotice = stats.captureStorageState === 'checking' ? 'settings.captureStorageChecking'
        : stats.captureStorageState === 'unavailable' ? 'settings.captureStorageUnavailable' : null
      const [open, setOpen] = React.useState(true)
      return h('details', { className: 'dsh-memory-trends-section dsh-memory-disclosure', open, onToggle: event => setOpen(event.currentTarget.open) },
        h('summary', { className: 'dsh-memory-disclosure-head dsh-memory-section-title' }, t('activity.trends')),
        open ? h('div', { className: 'dsh-memory-trends-body' },
          h(ActivityHeatmap, { activity, t, locale }),
          h(TokenTrend, { usage: stats.usage, t }),
          stats.captureBudget || storage || storageNotice ? h('div', { className: 'dsh-memory-trend-facts' },
            stats.captureBudget ? h('span', null, t('settings.captureAllowance', stats.captureBudget)) : null,
            storage ? h('span', null, t('settings.captureStorage', {
              sources: String(storage.sources?.count ?? 0),
              size: ((storage.bytes ?? 0) / 1024 / 1024).toFixed(1) + ' MB',
              tasks: String(storage.tasks ?? 0),
            })) : storageNotice ? h('span', { role: 'status' }, t(storageNotice)) : null) : null) : null)
    }

    function HealthStatus({ health, capture, t, onRepair }) {
      if (!health) return null
      const download = () => {
        const blob = new Blob([JSON.stringify(health, null, 2)], { type: 'application/json' })
        const url = URL.createObjectURL(blob), anchor = document.createElement('a')
        anchor.href = url; anchor.download = 'dsh-memory-diagnostics.json'; anchor.click()
        setTimeout(() => URL.revokeObjectURL(url), 1000)
      }
      const queueNeedsRecovery = capture?.failed > 0 || capture?.partial > 0 || capture?.unknown > 0
      const issues = health.issues.filter(code => code !== 'capture-incomplete' || !queueNeedsRecovery)
      return h('section', null,
        h(ActivityDisclosure, { title: t('health.title'), value: t('health.' + health.status), warning: health.status !== 'ok' },
          health.isolation === 'unavailable' ? null : h('p', { className: 'dsh-memory-muted' }, t('health.' + health.isolation)),
          health.status === 'unavailable' ? null : h('p', { className: 'dsh-memory-muted' }, t('health.memories', health.counts)),
          h('div', { className: 'dsh-memory-settings-group' }, Object.entries(health.components ?? {}).map(([key, component]) => {
            const repair = component.action !== 'none' && component.state !== 'disabled' && onRepair
            const state = t('health.state.' + component.state)
            return h(SettingRow, { key, label: t('health.component.' + key), hint: repair ? state : null },
              repair ? h('button', { type: 'button', className: 'dsh-memory-button', onClick: () => onRepair(component.action) }, t('health.action.' + component.action))
                : h('span', { className: 'dsh-memory-muted' }, state))
          })),
          h('div', { className: 'dsh-memory-detail-actions' },
            h('p', { className: 'dsh-memory-help' }, t('health.hint')),
            h('button', { type: 'button', className: 'dsh-memory-button', onClick: download }, t('health.download')))),
        issues.length ? h('ul', { className: 'dsh-memory-activity-issues', role: 'status' },
          issues.map(code => h('li', { key: code }, t('health.' + code),
            code === 'corrupt-lines' && health.counts?.corruptLines ? ' ' + t('health.corrupt', { count: health.counts.corruptLines }) : null))) : null)
    }

    function SemanticModelControls({ call, initial, t }) {
      const [status, setStatus] = React.useState(initial)
      const [folder, setFolder] = React.useState('')
      const [busy, setBusy] = React.useState('')
      const [error, setError] = React.useState('')
      const operationVersion = React.useRef(0), statusVersion = React.useRef(0)
      const active = ['preparing', 'downloading', 'importing', 'loading', 'indexing'].includes(status?.state)
      React.useEffect(() => {
        if (!busy && !active) setStatus(initial)
      }, [initial])
      React.useEffect(() => {
        if (!call || (!busy && !active)) return undefined
        let stopped = false
        const read = () => {
          const version = ++statusVersion.current
          return call('semanticModel', { action: 'status' }).then(value => {
            if (!stopped && version === statusVersion.current) { setStatus(value); setError('') }
          }).catch(value => { if (!stopped && version === statusVersion.current) setError(messageOf(value)) })
        }
        void read()
        const timer = setInterval(read, 1200)
        return () => { stopped = true; clearInterval(timer) }
      }, [call, busy, active])
      const run = async (action) => {
        const version = ++operationVersion.current
        statusVersion.current++
        setBusy(action);setError('')
        try {
          const result = await call('semanticModel', { action, ...(action === 'import' ? { sourceDir: folder } : {}) })
          if (version === operationVersion.current) setStatus(result)
        } catch (value) { if (version === operationVersion.current) setError(messageOf(value)) }
        finally { if (version === operationVersion.current) setBusy('') }
      }
      const title = t('recall.semantic')
      const value = t('recall.semantic.' + (status?.state ?? 'idle'))
      if (!call || status?.state === 'disabled') return h(ActivityDisclosure, { title, value })
      const progress = status?.progress
      return h(ActivityDisclosure, { title, value, warning: !!status?.error || status?.state === 'failed' },
        progress?.total ? h('p', { className: 'dsh-memory-muted', role: 'status' },
          t('recall.model.progress', { file: progress.asset ?? '', done: String(progress.downloaded ?? 0), total: String(progress.total) })) : null,
        progress?.total ? h('progress', { max: progress.total, value: Math.min(progress.total, progress.downloaded ?? 0), 'aria-label': t('recall.semantic') }) : null,
        status?.total ? h('p', { className: 'dsh-memory-muted' },
          t('recall.semanticProgress', { indexed: String(status.indexed), total: String(status.total) })) : null,
        h(SettingRow, { label: t('recall.model.folder'), hint: t('recall.model.folderHint') },
          description => h('input', { className: 'dsh-memory-settings-input', type: 'text', value: folder,
            title: folder || undefined, onChange: event => setFolder(event.target.value), 'aria-label': t('recall.model.folder'), 'aria-describedby': description })),
        h('div', { className: 'dsh-memory-settings-buttons' },
          active
            ? h('button', { type: 'button', className: 'dsh-memory-button', disabled: !!busy, onClick: () => run('cancel') }, t('recall.model.cancel'))
            : h('button', { type: 'button', className: 'dsh-memory-button', disabled: !!busy, onClick: () => run(status?.state === 'failed' ? 'retry' : 'prepare') },
              t(status?.state === 'failed' ? 'recall.model.retry' : 'recall.model.prepare')),
          h('button', { type: 'button', className: 'dsh-memory-button', disabled: !!busy || !folder.trim(), onClick: () => run('import') }, t('recall.model.import'))),
        error ? h('p', { className: 'dsh-memory-error-text', role: 'alert' }, error) : null)
    }

    const EMPTY_SESSION_SOURCE = { subscribe: () => () => {}, getSnapshot: () => null }
