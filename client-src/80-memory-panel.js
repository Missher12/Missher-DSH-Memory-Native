    function MemoryPanel(props) {
      const { t, store, sessionSource } = props
      const locale = props.locale
      const transport = React.useSyncExternalStore(store.subscribe, store.getState, store.getState)
      const call = transport.status === 'ready' ? transport.call : null
      const session = React.useSyncExternalStore(sessionSource.subscribe, sessionSource.getSnapshot, sessionSource.getSnapshot)
      const sessionId = typeof session?.key === 'string' ? session.key : undefined

      const [scope, setScope] = React.useState('project')
      const [projectSelection, setProjectSelection] = React.useState({ sessionId: null, key: null })
      const [status, setStatus] = React.useState('')
      const [kind, setKind] = React.useState('')
      const [topic, setTopic] = React.useState('')
      const [queryInput, setQueryInput] = React.useState('')
      const [query, setQuery] = React.useState('')
      const [page, setPage] = React.useState(0)
      const [pageSize, setPageSize] = React.useState(10)
      const [view, setView] = React.useState('activity')
      const [library, setLibrary] = React.useState(null)
      const [libraryLoading, setLibraryLoading] = React.useState(false)
      const [libraryError, setLibraryError] = React.useState('')
      const [libraryRefresh, setLibraryRefresh] = React.useState(0)
      const [dataState, setData] = React.useState(null)
      const [sessionPanel, setSessionPanel] = React.useState(null)
      const [loading, setLoading] = React.useState(true)
      const [error, setError] = React.useState('')
      const [notice, setNotice] = React.useState('')
      const [busy, setBusy] = React.useState('')
      const [editing, setEditing] = React.useState(null)
      const [editError, setEditError] = React.useState('')
      const [confirmingId, setConfirmingId] = React.useState('')
      const [purgingId, setPurgingId] = React.useState('')
      const [selected, setSelected] = React.useState([])
      const [historyRecord, setHistoryRecord] = React.useState(null)
      const [historyData, setHistoryData] = React.useState(null)
      const [historyError, setHistoryError] = React.useState('')
      const [historyBusy, setHistoryBusy] = React.useState(false)
      const [topicSuggestOpen, setTopicSuggestOpen] = React.useState(false)
      const [topicSuggestions, setTopicSuggestions] = React.useState(null)
      const [topicSuggestBusy, setTopicSuggestBusy] = React.useState(false)
      const [bulkTagOpen, setBulkTagOpen] = React.useState(false)
      const [bulkTagValue, setBulkTagValue] = React.useState('')
      const [toolbarNarrow, setToolbarNarrow] = React.useState(false)
      const toolbarObserver = React.useRef(null)
      const loadGeneration = React.useRef(0)
      const sessionRequestGeneration = React.useRef(0)
      const projectViewGeneration = React.useRef(0)
      const projectSelectionRef = React.useRef(projectSelection)
      projectSelectionRef.current = projectSelection
      const activeSessionId = React.useRef(sessionId)
      activeSessionId.current = sessionId
      const data = dataState !== null && dataState.scope === scope && dataState.sessionId === sessionId ? dataState : null
      const setToolbarNode = React.useCallback((node) => {
        if (toolbarObserver.current !== null) {
          toolbarObserver.current.disconnect()
          toolbarObserver.current = null
        }
        if (node === null || typeof ResizeObserver !== 'function') return
        const observer = new ResizeObserver((entries) => {
          const width = entries[0]?.contentRect?.width ?? 0
          setToolbarNarrow(width < 560)
        })
        observer.observe(node)
        toolbarObserver.current = observer
      }, [])

      React.useEffect(() => {
        const timer = setTimeout(() => {
          setQuery(queryInput.trim())
          setPage(0)
        }, 300)
        return () => clearTimeout(timer)
      }, [queryInput])

      React.useEffect(() => {
        if (notice === '') return
        const timer = setTimeout(() => setNotice(''), 4000)
        return () => clearTimeout(timer)
      }, [notice])

      const load = React.useCallback(async () => {
        if (call === null) return
        const requestedSelection = projectSelection
        if (projectSelectionRef.current !== requestedSelection) return
        const request = ++loadGeneration.current
        const requestedSessionId = activeSessionId.current
        const requestedProjectView = projectViewGeneration.current
        const isCurrent = () => request === loadGeneration.current && requestedSessionId === activeSessionId.current &&
          requestedSelection === projectSelectionRef.current && requestedProjectView === projectViewGeneration.current
        setLoading(true)
        setError('')
        try {
          const stats = await call('stats', { scope, sessionId: requestedSessionId })
          if (!isCurrent()) return
          if (stats?.health?.status === 'unavailable') {
            setData({ scope, sessionId: requestedSessionId, projectKey: null, stats, list: null, activity: null, profile: null })
            return
          }
          const selectedProjectKey = scope === 'project'
            ? (requestedSelection.sessionId === requestedSessionId ? requestedSelection.key : null) ??
              stats?.currentProjectKey ?? stats?.browseableProjectKeys?.[0]
            : undefined
          const activity = await call('activity', { scope, projectKey: selectedProjectKey, days: 371 })
          if (!isCurrent()) return
          const profile = await call('profile', { limit: 10 })
          if (!isCurrent()) return
          const listed = await call('list', {
            scope,
            projectKey: selectedProjectKey,
            status: status === '' ? undefined : status,
            kind: kind === '' ? undefined : kind,
            topic: topic === '' ? undefined : topic,
            query: query === '' ? undefined : query,
            limit: pageSize,
            offset: page * pageSize,
          })
          if (isCurrent()) setData({ scope, sessionId: requestedSessionId,
            projectKey: listed?.projectKey ?? selectedProjectKey ?? null, stats, activity, profile, list: listed })
        } catch (failure) {
          if (isCurrent()) setError(messageOf(failure))
        } finally {
          if (request === loadGeneration.current) setLoading(false)
        }
      }, [call, scope, status, kind, topic, query, page, pageSize, sessionId, projectSelection])

      React.useEffect(() => {
        void load()
      }, [load])

      const refreshSessionPanel = React.useCallback(async () => {
        if (!call) return
        const request = ++sessionRequestGeneration.current
        const requestedSessionId = sessionId
        try {
          const stats = await call('stats', { scope, sessionId: requestedSessionId })
          if (request !== sessionRequestGeneration.current) return
          setSessionPanel({ sessionId: requestedSessionId, usage: stats?.contextUsage,
            report: stats?.lastRecall ?? null, injectEnabled: stats?.injectEnabled })
        } catch (failure) {
          if (request === sessionRequestGeneration.current) setError(messageOf(failure))
        }
      }, [call, scope, sessionId])

      React.useEffect(() => {
        if (view !== 'activity' || !call) return undefined
        void refreshSessionPanel()
        const timer = setInterval(() => { void refreshSessionPanel() }, 5000)
        return () => { sessionRequestGeneration.current++; clearInterval(timer) }
      }, [view, call, refreshSessionPanel])

      const reloadAfterRecallChange = React.useCallback(async () => {
        await Promise.all([load(), refreshSessionPanel()])
      }, [load, refreshSessionPanel])

      React.useEffect(() => {
        if (view !== 'library' || call === null) return undefined
        let cancelled = false
        setLibraryLoading(true)
        setLibraryError('')
        call('knowledgeList', {})
          .then((next) => { if (!cancelled) setLibrary(next) })
          .catch((failure) => { if (!cancelled) setLibraryError(messageOf(failure)) })
          .finally(() => { if (!cancelled) setLibraryLoading(false) })
        return () => { cancelled = true }
      }, [view, call, libraryRefresh])



      React.useEffect(() => {
        const listed = data === null ? null : data.list
        if (listed === null || typeof listed.total !== 'number' || listed.total === 0) return
        if (page > 0 && page * pageSize >= listed.total) {
          setPage(Math.max(0, Math.ceil(listed.total / pageSize) - 1))
        }
      }, [data, page, pageSize])

      const runAction = async (key, action, successKey) => {
        if (call === null || busy !== '') return
        const projectView = projectViewGeneration.current
        setBusy(key)
        setError('')
        try {
          await action(call)
          if (projectView !== projectViewGeneration.current) return
          if (typeof successKey === 'string' && successKey !== '') setNotice(t(successKey))
          await load()
        } catch (failure) {
          if (projectView === projectViewGeneration.current) setError(messageOf(failure))
        } finally {
          setBusy('')
        }
      }

      const targetOf = (record) => ({
        id: record.id,
        scope: record.scope,
        projectKey: record.projectKey === null ? undefined : record.projectKey,
      })

      const approve = (record) => runAction('approve:' + record.id, (invoke) => invoke('update', {
        ...targetOf(record),
        patch: { status: 'active' },
      }), 'notice.approved')

      const archive = (record) => runAction('archive:' + record.id, (invoke) => invoke('update', {
        ...targetOf(record),
        patch: { status: 'archived' },
      }), 'notice.archived')

      const remove = (record) => {
        const projectView = projectViewGeneration.current
        return runAction('delete:' + record.id, (invoke) => invoke('removeMemory', targetOf(record)), 'notice.deleted')
          .then(() => { if (projectView === projectViewGeneration.current) setConfirmingId('') })
      }

      const restore = (record) => runAction('restore:' + record.id, (invoke) => invoke('restoreMemory', targetOf(record)), 'notice.restored')

      const purge = (record) => {
        if (purgingId !== record.id) {
          setPurgingId(record.id)
          return
        }
        setPurgingId('')
        void runAction('purge:' + record.id, (invoke) => invoke('purgeMemory', targetOf(record)), 'notice.purged')
      }

      const openHistory = async (record) => {
        if (call === null) return
        const projectView = projectViewGeneration.current
        setHistoryRecord(record)
        setHistoryData(null)
        setHistoryError('')
        setHistoryBusy(true)
        try {
          const history = await call('history', targetOf(record))
          if (projectView === projectViewGeneration.current) setHistoryData(history)
        } catch (failure) {
          if (projectView === projectViewGeneration.current) setHistoryError(messageOf(failure))
        } finally {
          if (projectView === projectViewGeneration.current) setHistoryBusy(false)
        }
      }

      const restoreRevision = (revision) => {
        if (historyRecord === null) return
        const projectView = projectViewGeneration.current
        void runAction('revision:' + revision, (invoke) => invoke('restoreRevision', {
          ...targetOf(historyRecord),
          revision,
        }), 'notice.restored').then(() => {
          if (projectView === projectViewGeneration.current) setHistoryRecord(null)
        })
      }

      const toggleSelected = (id) => {
        setSelected((previous) => previous.includes(id)
          ? previous.filter((value) => value !== id)
          : [...previous, id])
      }

      const bulk = async (action, extra) => {
        if (call === null || selected.length === 0 || busy !== '') return
        const projectView = projectViewGeneration.current
        const projectKey = scope === 'project' && typeof currentProjectKey === 'string' ? currentProjectKey : undefined
        setBusy('bulk:' + action)
        setError('')
        try {
          const result = await call('bulkAction', {
            action,
            scope,
            projectKey,
            ids: selected,
            ...(extra === undefined ? {} : extra),
          })
          if (projectView !== projectViewGeneration.current) return
          if (result.rolledBack === true) {
            setNotice(t('notice.bulkRolledBack', { failed: String(result.failedCount) }))
          } else if (result.failedCount > 0) {
            setNotice(t('notice.bulkPartial', { updated: String(result.updatedCount), failed: String(result.failedCount) }))
          } else {
            setNotice(t('notice.bulkDone', { count: String(result.updatedCount) }))
          }
          setSelected([])
          setBulkTagOpen(false)
          setBulkTagValue('')
          await load()
        } catch (failure) {
          if (projectView === projectViewGeneration.current) setError(messageOf(failure))
        } finally {
          setBusy('')
        }
      }

      const openTopicSuggestions = async () => {
        if (call === null) return
        const projectView = projectViewGeneration.current
        const projectKey = scope === 'project' && typeof currentProjectKey === 'string' ? currentProjectKey : undefined
        setTopicSuggestOpen(true)
        setTopicSuggestions(null)
        setTopicSuggestBusy(true)
        try {
          const suggestions = await call('topicSuggestions', { scope, projectKey })
          if (projectView === projectViewGeneration.current) setTopicSuggestions(suggestions)
        } catch (failure) {
          if (projectView === projectViewGeneration.current) {
            setError(messageOf(failure))
            setTopicSuggestOpen(false)
          }
        } finally {
          if (projectView === projectViewGeneration.current) setTopicSuggestBusy(false)
        }
      }

      const mergeTopic = async (item) => {
        if (call === null || busy !== '') return
        const projectView = projectViewGeneration.current
        const projectKey = scope === 'project' && typeof currentProjectKey === 'string' ? currentProjectKey : undefined
        setBusy('topic:merge')
        setError('')
        try {
          const result = await call('mergeTopics', { scope, projectKey, from: item.from, to: item.to })
          if (projectView !== projectViewGeneration.current) return
          setNotice(t('topic.merged', { count: String(result.merged ?? 0) }))
          setTopicSuggestOpen(false)
          await load()
        } catch (failure) {
          if (projectView === projectViewGeneration.current) setError(messageOf(failure))
        } finally {
          setBusy('')
        }
      }

      const submitBulkTag = () => {
        const tags = bulkTagValue.split(',').map((tag) => tag.trim()).filter((tag) => tag !== '')
        if (tags.length === 0) return
        void bulk('tag', { tags })
      }

      const rebuild = () => runAction('rebuild', (invoke) => invoke('rebuildIndex', {}), 'notice.rebuilt')

      const saveEdit = async (patch) => {
        if (editing === null || call === null || busy !== '') return
        setBusy('save')
        setEditError('')
        try {
          await call('update', { ...targetOf(editing), patch })
          setEditing(null)
          setNotice(t('notice.saved'))
          await load()
        } catch (failure) {
          setEditError(messageOf(failure))
        } finally {
          setBusy('')
        }
      }

      const heading = h('h2', { className: 'dsh-memory-heading' }, t('panel.title'))
      const header = h('header', { className: 'dsh-memory-header' }, heading)

      if (transport.status === 'loading') {

      return h('div', { className: 'dsh-memory-root' },
          header,
          h('p', { className: 'dsh-memory-muted', role: 'status' }, t('list.loading')))
      }

      if (transport.status === 'unavailable') {
        return h('div', { className: 'dsh-memory-root' },
          header,
          h('div', { className: 'dsh-memory-error-card', role: 'alert' },
            h('h3', { className: 'dsh-memory-error-title' }, t('list.unavailable.title')),
            h('p', { className: 'dsh-memory-error-text' }, t('list.unavailable.body')),
            transport.error === '' ? null : h('code', { className: 'dsh-memory-detail' }, transport.error)))
      }

      const stats = data === null ? null : data.stats
      const activeSessionPanel = sessionPanel?.sessionId === sessionId ? sessionPanel : null
      const listed = data === null ? null : data.list
      const items = listed === null ? [] : listed.items
      const total = listed === null ? 0 : listed.total
      const kindCounts = listed !== null && listed.kindCounts !== undefined && listed.kindCounts !== null ? listed.kindCounts : {}
      const kindCountsTotal = Object.values(kindCounts).reduce((sum, value) => sum + (Number(value) || 0), 0)
      const topicCounts = listed !== null && listed.topicCounts !== undefined && listed.topicCounts !== null ? listed.topicCounts : {}
      const pageCount = Math.max(1, Math.ceil(total / pageSize))
      const projectOverride = projectSelection.sessionId === sessionId ? projectSelection.key : null
      const currentProjectKey = scope === 'project'
        ? (data?.scope === 'project' ? data.projectKey : projectOverride ?? stats?.currentProjectKey ?? stats?.browseableProjectKeys?.[0] ?? null)
        : null
      const projectOptions = [...new Set([...(stats?.projectKeys ?? []), ...(stats?.browseableProjectKeys ?? []),
        ...(typeof currentProjectKey === 'string' ? [currentProjectKey] : [])])]
      const selectProject = key => {
        if (scope !== 'project' || key === currentProjectKey) return
        projectViewGeneration.current += 1
        loadGeneration.current += 1
        setProjectSelection({ sessionId, key })
        setData(null)
        setPage(0)
        setStatus('')
        setKind('')
        setTopic('')
        setQueryInput('')
        setQuery('')
        setSelected([])
        setEditing(null)
        setEditError('')
        setConfirmingId('')
        setPurgingId('')
        setHistoryRecord(null)
        setHistoryData(null)
        setHistoryError('')
        setHistoryBusy(false)
        setTopicSuggestOpen(false)
        setTopicSuggestions(null)
        setTopicSuggestBusy(false)
        setBulkTagOpen(false)
        setBulkTagValue('')
        setError('')
        setNotice('')
      }
      const filtering = query !== '' || status !== '' || kind !== '' || topic !== ''
      const showMissingProject = !filtering && scope === 'project' && currentProjectKey === null &&
        stats !== null && stats.total > 0

      const sections = [
        { key: 'activity', views: ['activity'] },
        { key: 'memory', views: ['memory', 'library', 'profile'] },
        { key: 'brief', views: ['brief'] },
        { key: 'settings', views: ['capture', 'retention', 'data', 'obsidian'] },
      ]
      const section = sections.find(item => item.views.includes(view)) ?? sections[0]
      const navButtons = (items, label, secondary = false) => h('nav', {
        className: secondary ? 'dsh-memory-subnav' : 'dsh-memory-view-tabs', 'aria-label': label,
      }, items.map(item => h('button', {
        key: item.value, type: 'button', className: 'dsh-memory-view-tab',
        'aria-current': item.active ? 'page' : undefined,
        'data-active': item.active ? 'true' : 'false',
        onClick: () => setView(item.value),
      }, item.label)))
      const viewTabs = h('div', { className: 'dsh-memory-navigation' },
        navButtons(sections.map(item => ({ value: item.views[0], label: t('section.' + item.key), active: item.key === section.key })), t('nav.sections')),
        section.views.length > 1 ? navButtons(section.views.map(value => ({ value, label: t('view.' + value), active: view === value })), t('section.' + section.key), true) : null)
      const repairHealth = action => {
        if (action === 'capture') setView('capture')
        else if (action === 'obsidian') setView('obsidian')
        else if (action === 'model' && call) {
          setView('activity')
          call('semanticModel', { action: 'prepare' }).then(() => load()).catch(value => setError(messageOf(value)))
        }
      }

      if (stats?.health?.status === 'unavailable') return h('div', { className: 'dsh-memory-root' }, header, h(HealthStatus, { health: stats.health, t, onRepair: repairHealth }))

      if (view === 'brief') {
        return h('div', { className: 'dsh-memory-root' }, header, viewTabs,
          error ? h('p', { className: 'dsh-memory-error-text', role: 'alert' }, error) : null,
          h(ProjectBrief, { call, t, locale, initialProject: stats?.currentProjectKey, projectKeys: stats?.projectKeys ?? [] }))
      }

      if (view === 'activity') {
        return h('div', { className: 'dsh-memory-root dsh-memory-activity-view' }, header, viewTabs,
          error ? h('p', { className: 'dsh-memory-error-text', role: 'alert' }, error) : null,
          stats ? h(React.Fragment, null,
            h(ContextUsage, { sessionId,
              sample: activeSessionPanel === null ? null : { sessionId: activeSessionPanel.sessionId, usage: activeSessionPanel.usage },
              enabled: activeSessionPanel?.injectEnabled ?? stats.injectEnabled, t, locale }),
            h(MemoryTotals, { stats, t, locale }),
            h(ExtractionStatus, { stats, call, t, locale, onSaved: load }),
            h(RecallReport, { report: activeSessionPanel?.report ?? null, t, locale, call, onSaved: reloadAfterRecallChange }),
            h(HealthStatus, { health: stats.health, capture: stats.capture, t, onRepair: repairHealth }),
            stats.semantic ? h(SemanticModelControls, { call, initial: stats.semantic, t }) : null,
            h(ActivityTrends, { stats, activity: data?.activity, t, locale })) : null)
      }

      if (view === 'profile') {
        return h('div', { className: 'dsh-memory-root' },
          header,
          viewTabs,
          notice === '' ? null : h('p', { className: 'dsh-memory-notice', role: 'status' }, notice),
          error === '' ? null : h('p', { className: 'dsh-memory-error-text', role: 'alert' }, error),
          h(ProfileView, { profile: data === null ? null : data.profile, t }))
      }

      if (view === 'library') {
        return h('div', { className: 'dsh-memory-root' },
          header,
          viewTabs,
          notice === '' ? null : h('p', { className: 'dsh-memory-notice', role: 'status' }, notice),
          error === '' ? null : h('p', { className: 'dsh-memory-error-text', role: 'alert' }, error),
          h(KnowledgeLibrary, {
            data: library,
            loading: libraryLoading,
            error: libraryError,
            t,
            call,
            projectKeys: stats?.projectKeys ?? (stats?.currentProjectKey ? [stats.currentProjectKey] : []),
            onChanged: () => {
              setLibraryRefresh((value) => value + 1)
            },
          }))
      }

      if (view === 'capture' || view === 'retention' || view === 'data' || view === 'obsidian') {
        return h('div', { className: 'dsh-memory-root' },
          header,
          viewTabs,
          notice === '' ? null : h('p', { className: 'dsh-memory-notice', role: 'status' }, notice),
          error === '' ? null : h('p', { className: 'dsh-memory-error-text', role: 'alert' }, error),
          h(SettingsCard, { stats, call, t, onSaved: load, group: view }))
      }

      const suggestionItems = topicSuggestions !== null && Array.isArray(topicSuggestions.suggestions) ? topicSuggestions.suggestions : []
      const suggestionRows = suggestionItems.map((item) => {
        return h('li', { key: item.from + '>' + item.to, className: 'dsh-memory-history-item' },
          h('div', { className: 'dsh-memory-history-foot' },
            h('span', { className: 'dsh-memory-history-content' }, t('topic.mergeLine', {
              from: item.from,
              fromCount: String(item.fromCount),
              to: item.to,
              toCount: String(item.toCount),
            })),
            h('button', {
              type: 'button',
              className: 'dsh-memory-button',
              onClick: () => mergeTopic(item),
              disabled: busy !== '',
            }, t('topic.mergeAction'))))
      })
      const suggestionNode = suggestionRows.length === 0
        ? h('p', { className: 'dsh-memory-muted' }, t('topic.none'))
        : h('ul', { className: 'dsh-memory-history' }, suggestionRows)

      const revisionRows = (historyData !== null && Array.isArray(historyData.revisions) ? historyData.revisions : []).map((revision, index, revisions) => {
        const diff = revisionDiff(index + 1 < revisions.length ? revisions[index + 1] : null, revision)
        const diffNode = diff === null
          ? null
          : h('div', { className: 'dsh-memory-diff' },
            diff.removed === '' ? null : h('span', { className: 'dsh-memory-diff-del' }, t('history.diffRemoved', { text: diff.removed })),
            diff.added === '' ? null : h('span', { className: 'dsh-memory-diff-add' }, t('history.diffAdded', { text: diff.added })))
        const isCurrent = revision.revision === (historyData.revisions[0] === undefined ? -1 : historyData.revisions[0].revision)
        return h('li', { key: revision.revision, className: 'dsh-memory-history-item' },
          h('div', { className: 'dsh-memory-history-head' },
            h('strong', null, 'r' + revision.revision),
            h('span', { className: 'dsh-memory-status-pill', 'data-status': revision.status }, t('status.' + revision.status)),
            isCurrent ? h('span', { className: 'dsh-memory-row-meta' }, t('history.current')) : null),
          h('p', { className: 'dsh-memory-history-content' }, revision.content),
          diffNode,
          h('div', { className: 'dsh-memory-history-foot' },
            h('span', { className: 'dsh-memory-row-meta' }, t('history.time', { time: formatTime(revision.updatedAt, locale) })),
            h('button', { type: 'button', className: 'dsh-memory-button', onClick: () => restoreRevision(revision.revision) }, t('history.restore'))))
      })
      const historyModal = historyRecord === null ? null : h('div', { className: 'dsh-memory-modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'dsh-memory-history-title' },
        h('h3', { className: 'dsh-memory-modal-title', id: 'dsh-memory-history-title' }, t('history.title')),
        historyBusy
          ? h('p', { className: 'dsh-memory-muted', role: 'status' }, t('history.loading'))
          : historyError !== ''
            ? h('p', { className: 'dsh-memory-error-text', role: 'alert' }, historyError)
            : h('ul', { className: 'dsh-memory-history' }, revisionRows),
        h('div', { className: 'dsh-memory-modal-actions' },
          h('button', { type: 'button', className: 'dsh-memory-button', onClick: () => setHistoryRecord(null) }, t('actions.close'))))
      const bulkTagModal = bulkTagOpen ? h('div', { className: 'dsh-memory-modal', role: 'dialog', 'aria-modal': 'true' },
        h('h3', { className: 'dsh-memory-modal-title' }, t('bulk.tagTitle')),
        h('input', {
          className: 'dsh-memory-input',
          value: bulkTagValue,
          placeholder: t('bulk.tagPlaceholder'),
          onChange: (event) => setBulkTagValue(event.target.value),
        }),
        h('div', { className: 'dsh-memory-modal-actions' },
          h('button', { type: 'button', className: 'dsh-memory-button', onClick: () => { setBulkTagOpen(false); setBulkTagValue('') } }, t('actions.cancel')),
          h('button', { type: 'button', className: 'dsh-memory-button dsh-memory-button-primary', disabled: bulkTagValue.trim() === '' || busy !== '', onClick: submitBulkTag }, t('bulk.tagApply')))) : null
      const topicModal = topicSuggestOpen ? h('div', { className: 'dsh-memory-modal', role: 'dialog', 'aria-modal': 'true' },
        h('h3', { className: 'dsh-memory-modal-title' }, t('topic.mergeTitle')),
        topicSuggestBusy ? h('p', { className: 'dsh-memory-muted', role: 'status' }, t('history.loading')) : suggestionNode,
        h('div', { className: 'dsh-memory-modal-actions' },
          h('button', { type: 'button', className: 'dsh-memory-button', onClick: () => setTopicSuggestOpen(false) }, t('actions.close')))) : null

      return h('div', { className: 'dsh-memory-root' },
        header,
        viewTabs,
        h('div', { className: 'dsh-memory-toolbar', ref: setToolbarNode, 'data-narrow': toolbarNarrow ? 'true' : 'false' },
          h(Field, { label: t('filter.scope') },
            h(Select, {
              className: 'dsh-memory-select',
              value: scope,
              onChange: (event) => {
                projectViewGeneration.current += 1
                loadGeneration.current += 1
                setScope(event.target.value)
                setData(null)
                setPage(0)
                setStatus('')
                setKind('')
                setTopic('')
                setQueryInput('')
                setQuery('')
                setSelected([])
                setEditing(null)
                setConfirmingId('')
                setPurgingId('')
                setHistoryRecord(null)
                setHistoryData(null)
                setTopicSuggestOpen(false)
                setTopicSuggestions(null)
              },
              'aria-label': t('filter.scope'),
            },
            h('option', { value: 'project' }, t('filter.scope.project')),
            h('option', { value: 'global' }, t('filter.scope.global')))),
          scope === 'project' && projectOptions.length > 1 ? h(Field, { label: t('filter.project') },
            h(Select, {
              className: 'dsh-memory-select dsh-memory-project-select',
              value: currentProjectKey ?? '',
              onChange: event => selectProject(event.target.value),
              'aria-label': t('filter.project'),
              title: currentProjectKey ?? '',
            }, projectOptions.map(key => h('option', { key, value: key, title: key }, key)))) : null,
          h(Field, { label: t('filter.status') },
            h(Select, {
              className: 'dsh-memory-select',
              value: status,
              onChange: (event) => {
                setStatus(event.target.value)
                setPage(0)
              },
              'aria-label': t('filter.status'),
            },
            h('option', { value: '' }, t('filter.status.all')),
            STATUSES.map((value) => h('option', { key: value, value }, t('status.' + value))))),
          h(Field, { label: t('filter.search'), grow: true },
            h('input', {
              className: 'dsh-memory-input',
              type: 'search',
              value: queryInput,
              placeholder: t('filter.searchPlaceholder'),
              onChange: (event) => setQueryInput(event.target.value),
              'aria-label': t('filter.search'),
            })),
          h('div', { className: 'dsh-memory-toolbar-actions' },
            h('button', {
              type: 'button',
              className: 'dsh-memory-button',
              onClick: () => runAction('refresh', async () => {}, null),
              disabled: loading || busy !== '',
            }, t('actions.refresh')),
            h('button', {
              type: 'button',
              className: 'dsh-memory-button dsh-memory-button-primary',
              onClick: rebuild,
              disabled: busy !== '',
            }, busy === 'rebuild' ? t('actions.rebuilding') : t('actions.rebuild')))),
        notice === '' ? null : h('p', { className: 'dsh-memory-notice', role: 'status' }, notice),
        error === '' ? null : h('div', { className: 'dsh-memory-error-card', role: 'alert' },
          h('h3', { className: 'dsh-memory-error-title' }, t('list.error.title')),
          h('p', { className: 'dsh-memory-error-text' }, error),
          h('div', null, h('button', {
            type: 'button',
            className: 'dsh-memory-button',
            onClick: () => load(),
          }, t('list.error.retry')))),
        data === null ? null : h('div', { className: 'dsh-memory-list-head' },
          h('div', { className: 'dsh-memory-kind-tabs', role: 'tablist', 'aria-label': t('filter.kind') },
            h('button', {
              type: 'button',
              role: 'tab',
              'aria-selected': kind === '',
              'data-active': kind === '' ? 'true' : 'false',
              className: 'dsh-memory-kind-tab',
              onClick: () => {
                setKind('')
                setPage(0)
              },
            }, t('filter.kind.all'), h('span', { className: 'dsh-memory-kind-count' }, String(kindCountsTotal))),
            KINDS.map((value) => h('button', {
              key: value,
              type: 'button',
              role: 'tab',
              'aria-selected': kind === value,
              'data-active': kind === value ? 'true' : 'false',
              className: 'dsh-memory-kind-tab',
              onClick: () => {
                setKind(value)
                setPage(0)
              },
            }, t('kind.' + value), h('span', { className: 'dsh-memory-kind-count' }, String(kindCounts[value] ?? 0))))),
          h('div', { className: 'dsh-memory-list-tools' },
            h(Select, {
              className: 'dsh-memory-select dsh-memory-topic-select',
              value: topic,
              onChange: (event) => {
                setTopic(event.target.value)
                setPage(0)
              },
              'aria-label': t('filter.topic'),
            },
            h('option', { value: '' }, t('filter.topic.all')),
            h('option', { value: '__none__' }, t('filter.topic.none')),
            Object.keys(topicCounts).filter((key) => key !== '__none__').sort().map((key) =>
              h('option', { key, value: key }, key + ' (' + String(topicCounts[key]) + ')'))),
            Object.keys(topicCounts).filter((key) => key !== '__none__').length > 1
              ? h('button', {
                type: 'button',
                className: 'dsh-memory-button',
                onClick: openTopicSuggestions,
              }, t('topic.suggest'))
              : null,
            h('span', { className: 'dsh-memory-list-total' }, t('pager.total', { total: String(total) })))),
        loading && data === null ? h('p', { className: 'dsh-memory-muted', role: 'status' }, t('list.loading')) : null,
        error !== '' ? null : items.length === 0
          ? h('div', { className: 'dsh-memory-empty' },
            h('p', { className: 'dsh-memory-empty-title' }, filtering ? t('list.noMatch') : t('list.empty.title')),
            filtering || showMissingProject
              ? null
              : h('p', { className: 'dsh-memory-empty-body' }, t('list.empty.body')),
            showMissingProject ? h('p', { className: 'dsh-memory-empty-body' }, t('error.missingProject')) : null)
          : [
            selected.length === 0 ? null : h('div', { key: 'bulk', className: 'dsh-memory-bulk' },
              h('span', null, t('bulk.selected', { count: String(selected.length) })),
              h('div', { className: 'dsh-memory-bulk-actions' },
                h('button', {
                  type: 'button',
                  className: 'dsh-memory-button',
                  onClick: () => setSelected(selected.length === items.length ? [] : items.map((record) => record.id)),
                }, t('bulk.selectAll')),
                status === 'deleted'
                  ? h('button', { type: 'button', className: 'dsh-memory-button', onClick: () => bulk('restore') }, t('bulk.restore'))
                  : h('button', { type: 'button', className: 'dsh-memory-button', onClick: () => bulk('archive') }, t('bulk.archive')),
                status === 'deleted'
                  ? null
                  : h('button', { type: 'button', className: 'dsh-memory-button', onClick: () => setBulkTagOpen(true) }, t('bulk.tag')),
                h('button', { type: 'button', className: 'dsh-memory-button', onClick: () => setSelected([]) }, t('bulk.clear')),
                status === 'deleted'
                  ? null
                  : h('div', { className: 'dsh-memory-danger-actions' }, h('button', { type: 'button', className: 'dsh-memory-button', 'data-danger': 'true', onClick: () => bulk('delete') }, t('bulk.delete'))))),
            h('ul', { key: 'list', className: 'dsh-memory-list' },
            items.map((record) => {
              const isConfirming = confirmingId === record.id
              const actionBusy = busy !== ''
              return h('li', { key: record.id, className: 'dsh-memory-row', 'data-kind': record.kind, 'data-selected': selected.includes(record.id) },
                h('div', { className: 'dsh-memory-row-head' },
                  h('label', { className: 'dsh-memory-row-select' }, h('input', {
                    type: 'checkbox',
                    className: 'dsh-memory-select-box',
                    checked: selected.includes(record.id),
                    onChange: () => toggleSelected(record.id),
                    'aria-label': t('bulk.selectRow') + ' · ' + record.content.slice(0, 44),
                  })),
                  h('span', { className: 'dsh-memory-kind', 'data-kind': record.kind }, t('kind.' + record.kind)),
                  h('span', { className: 'dsh-memory-status-pill', 'data-status': record.status }, t('status.' + record.status)),
                  record.pinned === true ? h('span', { className: 'dsh-memory-pin' }, t('row.pinned')) : null,
                  h('span', { className: 'dsh-memory-row-meta' },
                    h('span', null, t('row.confidence', { value: Number(record.confidence).toFixed(2) })),
                    h('span', null, t('row.updated', { value: formatTime(record.updatedAt, locale) })))),
                h('p', { className: 'dsh-memory-content' }, record.content),
                h('div', { className: 'dsh-memory-row-foot' },
                  Array.isArray(record.tags) && record.tags.length > 0
                    ? h('ul', { className: 'dsh-memory-tags' }, record.tags.map((tag, index) => h('li', { key: tag + ':' + index, className: 'dsh-memory-tag' }, tag)))
                    : null,
                h('div', { className: 'dsh-memory-row-actions' },
                  record.status === 'deleted'
                    ? [
                      h('button', {
                        key: 'restore',
                        type: 'button',
                        className: 'dsh-memory-button',
                        onClick: () => restore(record),
                        disabled: actionBusy,
                      }, t('actions.restore')),
                      h('button', {
                        key: 'history',
                        type: 'button',
                        className: 'dsh-memory-button',
                        onClick: () => openHistory(record),
                        disabled: actionBusy,
                      }, t('actions.history')),
                      h('button', {
                        key: 'purge',
                        type: 'button',
                        className: 'dsh-memory-button',
                        'data-danger': 'true',
                        'data-confirming': purgingId === record.id,
                        onClick: () => purge(record),
                        disabled: actionBusy,
                      }, purgingId === record.id ? t('actions.purgeConfirm') : t('actions.purge')),
                    ]
                    : [
                      h('button', {
                        key: 'edit',
                        type: 'button',
                        className: 'dsh-memory-button',
                        onClick: () => {
                          setEditError('')
                          setEditing(record)
                        },
                        disabled: actionBusy,
                      }, t('actions.edit')),
                      record.status === 'candidate'
                        ? h('button', {
                          key: 'approve',
                          type: 'button',
                          className: 'dsh-memory-button dsh-memory-button-primary',
                          onClick: () => approve(record),
                          disabled: actionBusy,
                        }, t('actions.approve'))
                        : null,
                      record.status !== 'archived' && record.status !== 'superseded'
                        ? h('button', {
                          key: 'archive',
                          type: 'button',
                          className: 'dsh-memory-button',
                          onClick: () => archive(record),
                          disabled: actionBusy,
                        }, t('actions.archive'))
                        : null,
                      h('button', {
                        key: 'history',
                        type: 'button',
                        className: 'dsh-memory-button',
                        onClick: () => openHistory(record),
                        disabled: actionBusy,
                      }, t('actions.history')),
                      h('button', {
                        key: 'delete',
                        type: 'button',
                        className: 'dsh-memory-button',
                        'data-danger': 'true',
                        'data-confirming': isConfirming,
                        onClick: () => {
                          if (!isConfirming) {
                            setConfirmingId(record.id)
                            return
                          }
                          setConfirmingId('')
                          void remove(record)
                        },
                        disabled: actionBusy,
                      }, isConfirming ? t('actions.deleteConfirm') : t('actions.delete')),
                    ])))
            }))],
        data === null || total === 0 ? null : h('div', { className: 'dsh-memory-pager' },
          h('span', null, t('pager.summary', { page: String(page + 1), pages: String(pageCount), total: String(total) })),
          h('div', { className: 'dsh-memory-pager-actions' },
            h('label', { className: 'dsh-memory-page-size' },
              h('span', null, t('pager.perPageLabel')),
              h(Select, {
                className: 'dsh-memory-select dsh-memory-page-select',
                value: String(pageSize),
                onChange: (event) => {
                  setPageSize(Number(event.target.value))
                  setPage(0)
                },
                'aria-label': t('pager.perPageLabel'),
              }, [10, 20, 50].map((size) => h('option', { key: size, value: String(size) }, String(size))))),
            h('button', {
              type: 'button',
              className: 'dsh-memory-button',
              onClick: () => setPage(Math.max(0, page - 1)),
              disabled: loading || page <= 0,
            }, t('pager.prev')),
            h('button', {
              type: 'button',
              className: 'dsh-memory-button',
              onClick: () => setPage(page + 1),
              disabled: loading || page + 1 >= pageCount,
            }, t('pager.next')))),
        editing === null ? null : h(MemoryEditor, {
          t,
          record: editing,
          busy: busy === 'save',
          error: editError,
          onCancel: () => setEditing(null),
          onSave: saveEdit,
        }),
        historyModal,
        bulkTagModal,
        topicModal)
    }
