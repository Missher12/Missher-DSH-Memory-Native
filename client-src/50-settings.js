    function ObsidianSyncStatus({call,t,disabled}) {
      const [status,setStatus]=React.useState(null), [statusError,setStatusError]=React.useState(''), [actionError,setActionError]=React.useState(''), [busy,setBusy]=React.useState(false)
      React.useEffect(()=>{
        if(!call)return undefined
        let stopped=false
        const read=()=>call('obsidianStatus',{}).then(v=>{if(!stopped){setStatus(v.automatic);setStatusError('')}}).catch(e=>{if(!stopped)setStatusError(messageOf(e))})
        void read();const timer=setInterval(read,5000)
        return()=>{stopped=true;clearInterval(timer)}
      },[call])
      const action=async(method,input={})=>{
        setBusy(true)
        setActionError('')
        try{await call(method,input);const current=await call('obsidianStatus',{});setStatus(current.automatic);setStatusError('')}
        catch(e){setActionError(messageOf(e))}finally{setBusy(false)}
      }
      const summary = status?.at
        ? t('obsidian.syncStatus', {
          time: new Date(status.at).toLocaleTimeString(), sent: status.exported,
          received: status.imported, conflicts: status.conflicts.length,
        }) + ' · ' + t('obsidian.mode.' + (status.mode === 'full' ? 'full' : 'incremental'))
        : t('obsidian.notYet')
      return h(React.Fragment, null,
        h(SettingRow, { label: t('obsidian.status'), hint: h('span', { role: 'status' }, summary) },
          h('button', { type: 'button', className: 'dsh-memory-button', disabled: disabled || busy || !call,
            onClick: () => action('obsidianSync', { fullScan: true }) }, t(busy ? 'obsidian.syncing' : 'obsidian.fullScan'))),
        status?.pendingFiles ? h('p', { className: 'dsh-memory-help' }, t('obsidian.pending', { count: status.pendingFiles })) : null,
        status?.fullScanPending ? h('p', { className: 'dsh-memory-help' }, t('obsidian.fullPending')) : null,
        statusError?h('p',{className:'dsh-memory-error-text',role:'alert'},statusError):null,
        actionError?h('p',{className:'dsh-memory-error-text',role:'alert'},actionError):null,
        (status?.errors??[]).map((e,i)=>h('p',{key:i,className:'dsh-memory-error-text'},e.file+': '+e.message)),
        (status?.conflicts??[]).map(c=>h('details',{key:c.key,className:'dsh-memory-sync-conflict'},
          h('summary',null,c.file+' · '+c.reason),
          h('p',{className:'dsh-memory-muted'},c.copies.join('\n')),
          h('strong',null,'Memory'),h('pre',null,c.memoryText??t('obsidian.deleted')),
          h('strong',null,'Obsidian'),h('pre',null,c.vaultText??t('obsidian.deleted')),
          h('div',{className:'dsh-memory-settings-buttons'},['memory','vault'].map(side=>h('button',{key:side,type:'button',className:'dsh-memory-button',disabled:disabled||busy,onClick:()=>action('obsidianResolve',{key:c.key,token:c.token,side})},t(side==='memory'?'obsidian.keepMemory':'obsidian.keepVault')))))))
    }

    function SettingsCard(props) {
      const { stats, call, t, onSaved, onRebuild, rebuilding, actionBusy, group = 'capture' } = props
      const [capture, setCapture] = React.useState(true)
      const [inject, setInject] = React.useState(true)
      const [budget, setBudget] = React.useState('360')
      const [retention, setRetention] = React.useState('90')
      const [maintenance, setMaintenance] = React.useState(true)
      const [obsidianVault, setObsidianVault] = React.useState('')
      const [obsidianAuto, setObsidianAuto] = React.useState(false)
      const [obsidianFolder, setObsidianFolder] = React.useState('DSH Memory')
      const [baseline, setBaseline] = React.useState(null)
      const baselineRef = React.useRef(null)
      const draftRef = React.useRef(null)
      const [busy, setBusy] = React.useState(false)
      const [notice, setNotice] = React.useState('')
      const [noticeArea, setNoticeArea] = React.useState('')
      const [fieldErrors, setFieldErrors] = React.useState({})
      const [sharingUrl, setSharingUrl] = React.useState('')
      const fileRef = React.useRef(null)

      React.useEffect(() => {
        if (stats === null || typeof stats !== 'object' ||
            typeof stats.captureEnabled !== 'boolean' || typeof stats.injectEnabled !== 'boolean' ||
            !Number.isInteger(stats.injectMaxTokens) || stats.injectMaxTokens < 100 || stats.injectMaxTokens > 8000 ||
            !Number.isInteger(stats.retentionEpisodeDays) || stats.retentionEpisodeDays < 0 || stats.retentionEpisodeDays > 36500 ||
            typeof stats.maintenanceEnabled !== 'boolean' || typeof stats.obsidianAutoSync !== 'boolean' ||
            (stats.obsidianVaultPath !== null && typeof stats.obsidianVaultPath !== 'string') || typeof stats.obsidianFolder !== 'string') return
        const next = {
          capture: stats.captureEnabled,
          inject: stats.injectEnabled,
          budget: String(stats.injectMaxTokens),
          retention: String(stats.retentionEpisodeDays),
          maintenance: stats.maintenanceEnabled,
          obsidianAuto: stats.obsidianAutoSync,
          obsidianVault: stats.obsidianVaultPath ?? '',
          obsidianFolder: stats.obsidianFolder,
        }
        const previous = baselineRef.current
        const currentDraft = draftRef.current
        if (previous === null || currentDraft === null) {
          baselineRef.current = next
          draftRef.current = next
          setBaseline(next)
          setCapture(next.capture)
          setInject(next.inject)
          setBudget(next.budget)
          setRetention(next.retention)
          setMaintenance(next.maintenance)
          setObsidianAuto(next.obsidianAuto)
          setObsidianVault(next.obsidianVault)
          setObsidianFolder(next.obsidianFolder)
          return
        }
        const nextBaseline = { ...previous }
        const nextDraft = { ...currentDraft }
        for (const key of Object.keys(next)) {
          if (fieldEqual(key, currentDraft[key], previous[key])) {
            nextBaseline[key] = next[key]
            nextDraft[key] = next[key]
          }
        }
        baselineRef.current = nextBaseline
        draftRef.current = nextDraft
        setBaseline(nextBaseline)
        setCapture(nextDraft.capture)
        setInject(nextDraft.inject)
        setBudget(nextDraft.budget)
        setRetention(nextDraft.retention)
        setMaintenance(nextDraft.maintenance)
        setObsidianAuto(nextDraft.obsidianAuto)
        setObsidianVault(nextDraft.obsidianVault)
        setObsidianFolder(nextDraft.obsidianFolder)
      }, [stats])

      const fieldEqual = (key, left, right) => {
        if ((key === 'budget' || key === 'retention') && left !== '' && right !== '') {
          const a = Number(left), b = Number(right)
          if (Number.isInteger(a) && Number.isInteger(b)) return a === b
        }
        return left === right
      }
      const updateDraft = (key, value, setter) => {
        const current = draftRef.current ?? baselineRef.current ?? {}
        draftRef.current = { ...current, [key]: value }
        setter(value)
        const field = key === 'obsidianVault' ? 'obsidianVaultPath' : key === 'obsidianFolder' ? 'obsidianFolder' : null
        if (field) setFieldErrors(previous => ({ ...previous, [field]: '' }))
      }
      const currentDraft = draftRef.current ?? { capture, inject, budget, retention, maintenance, obsidianAuto, obsidianVault, obsidianFolder }
      const repairing = stats?.settingsIssue?.code === 'settings-invalid'
      const pageKeys = group === 'obsidian'
        ? ['obsidianAuto', 'obsidianVault', 'obsidianFolder']
        : group === 'capture' ? Object.keys(currentDraft) : []
      const dirtyFields = baseline === null ? [] : pageKeys.filter(key => !fieldEqual(key, currentDraft[key], baseline[key]))
      const dirty = dirtyFields.length > 0 || repairing
      const snapshot = () => ({ ...(draftRef.current ?? currentDraft) })
      const budgetValue = budget.trim() === '' ? NaN : Number(budget)
      const retentionValue = retention.trim() === '' ? NaN : Number(retention)
      const budgetValid = Number.isInteger(budgetValue) && budgetValue >= 100 && budgetValue <= 8000
      const retentionValid = Number.isInteger(retentionValue) && retentionValue >= 0 && retentionValue <= 36500
      const numbersValid = budgetValid && retentionValid
      const canSave = repairing ? numbersValid : group !== 'capture' || numbersValid
      const save = async () => {
        if (call === null || busy || actionBusy || !dirty || !canSave) return
        setBusy(true)
        setNoticeArea(group)
        setNotice('')
        setFieldErrors({})
        try {
          const submitted = snapshot()
          const fields = {
            capture: 'captureEnabled', inject: 'injectEnabled', budget: 'injectMaxTokens', retention: 'retentionEpisodeDays',
            maintenance: 'maintenanceEnabled', obsidianAuto: 'obsidianAutoSync', obsidianVault: 'obsidianVaultPath', obsidianFolder: 'obsidianFolder',
          }
          const normalize = (key, value) => key === 'budget' ? Number(value) : key === 'retention' ? Number(value)
            : key === 'obsidianVault' ? value.trim() : key === 'obsidianFolder' ? value.trim().slice(0, 64) : value
          const patch = {}, expected = {}
          const fieldsToSave = repairing ? Object.keys(fields) : dirtyFields
          for (const key of Object.keys(fields)) {
            if (!fieldsToSave.includes(key)) continue
            patch[fields[key]] = normalize(key, submitted[key])
            if (!repairing) expected[fields[key]] = normalize(key, baseline[key])
          }
          const result = await call('updateSettings', { changes: patch, expected })
          if (result?.conflict) {
            const keyForField = Object.fromEntries(Object.entries(fields).map(([key, field]) => [field, key]))
            const nextBaseline = { ...baselineRef.current }
            for (const conflict of result.conflicts ?? []) {
              const key = keyForField[conflict.field]
              if (key && Object.hasOwn(result.currentValues ?? {}, conflict.field)) {
                nextBaseline[key] = key === 'budget' || key === 'retention' ? String(result.currentValues[conflict.field])
                  : key === 'obsidianVault' ? result.currentValues[conflict.field] ?? '' : result.currentValues[conflict.field]
              }
            }
            baselineRef.current = nextBaseline
            setBaseline(nextBaseline)
            setNotice(t('settings.conflict'))
            onSaved()
            return
          }
          const nextBaseline = { ...(baselineRef.current ?? baseline) }
          const nextDraft = { ...(draftRef.current ?? submitted) }
          for (const key of Object.keys(fields)) {
            if (!Object.hasOwn(patch, fields[key])) continue
            const value = key === 'budget' || key === 'retention' ? String(patch[fields[key]]) : patch[fields[key]]
            nextBaseline[key] = value
            if (fieldEqual(key, nextDraft[key], submitted[key])) nextDraft[key] = value
          }
          baselineRef.current = nextBaseline
          draftRef.current = nextDraft
          setBaseline(nextBaseline)
          setCapture(nextDraft.capture)
          setInject(nextDraft.inject)
          setBudget(nextDraft.budget)
          setRetention(nextDraft.retention)
          setMaintenance(nextDraft.maintenance)
          setObsidianAuto(nextDraft.obsidianAuto)
          setObsidianVault(nextDraft.obsidianVault)
          setObsidianFolder(nextDraft.obsidianFolder)
          setNotice(t('settings.saved'))
          onSaved()
        } catch (failure) {
          const reason = messageOf(failure)
          const match = /^(obsidianVaultPath|obsidianFolder):\s*(.*)$/u.exec(reason)
          if (match) {
            const field = match[1]
            setFieldErrors(previous => ({ ...previous, [field]: t(field === 'obsidianVaultPath' ? 'settings.obsidian.pathInvalid' : 'settings.obsidian.folderInvalid') }))
            setNotice(t('settings.failed', { reason: t(field === 'obsidianVaultPath' ? 'settings.obsidian.pathInvalid' : 'settings.obsidian.folderInvalid') }))
          } else setNotice(t('settings.failed', { reason }))
        } finally {
          setBusy(false)
        }
      }
      const exportAll = async () => {
        if (call === null || busy) return
        setBusy(true)
        setNoticeArea('records')
        setNotice('')
        try {
          const data = await call('exportData', {})
          const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
          const url = URL.createObjectURL(blob)
          const anchor = document.createElement('a')
          anchor.href = url
          anchor.download = 'dsh-memory-' + new Date().toISOString().slice(0, 10) + '.json'
          document.body.appendChild(anchor)
          anchor.click()
          anchor.remove()
          URL.revokeObjectURL(url)
          setNotice(t('data.exported'))
        } catch (failure) {
          setNotice(t('data.failed', { reason: messageOf(failure) }))
        } finally {
          setBusy(false)
        }
      }
      const importAll = async (event) => {
        const file = event.target.files !== null && event.target.files.length > 0 ? event.target.files[0] : null
        if (file === null) return
        setBusy(true)
        setNoticeArea('records')
        setNotice('')
        try {
          const payload = JSON.parse(await file.text())
          const preview = await call('importData', { payload, dryRun: true })
          const counts = { imported: String(preview.imported ?? 0), skipped: String(preview.skipped ?? 0) }
          if (!window.confirm(t('data.importConfirm', counts))) {
            setNotice(t('data.importCanceled'))
            return
          }
          const result = await call('importData', { payload })
          setNotice(t('data.imported', { imported: String(result.imported ?? 0), skipped: String(result.skipped ?? 0) }) +
            (result.protectedDeleted > 0 ? ' ' + t('data.protectedDeleted', { count: String(result.protectedDeleted) }) : ''))
          onSaved()
        } catch (failure) {
          setNotice(t('data.failed', { reason: messageOf(failure) }))
        } finally {
          setBusy(false)
          if (event.target !== null) event.target.value = ''
        }
      }
      const backupNow = async () => {
        if (call === null || busy) return
        setBusy(true)
        setNoticeArea('backup')
        setNotice('')
        try {
          const result = await call('backup', {})
          setNotice(t('data.backupDone', { path: String(result.path ?? '') }))
        } catch (failure) {
          setNotice(t('data.failed', { reason: messageOf(failure) }))
        } finally {
          setBusy(false)
        }
      }

      const openLocalSharing = async () => {
        if (call === null || busy) return
        let popup = null
        try { popup = window.open('about:blank', '_blank'); if (popup) popup.opener = null } catch {}
        setBusy(true)
        setNoticeArea('sharing')
        setNotice('')
        try {
          const result = await call('localSharing', { action: 'start' })
          setSharingUrl(result.url)
          if (popup) popup.location.replace(result.url)
          setNotice(t('data.sharingReady'))
        } catch (failure) {
          try { popup?.close() } catch {}
          setNotice(t('data.failed', { reason: messageOf(failure) }))
        } finally { setBusy(false) }
      }

      const stopLocalSharing = async () => {
        if (call === null || busy) return
        setBusy(true)
        setNoticeArea('sharing')
        setNotice('')
        try {
          await call('localSharing', { action: 'stop' })
          setSharingUrl('')
          setNotice(t('data.sharingStopped'))
        } catch (failure) { setNotice(t('data.failed', { reason: messageOf(failure) })) }
        finally { setBusy(false) }
      }

      const transfer = async (kind, direction) => {
        if (!call || busy || dirty) return
        setBusy(true)
        setNoticeArea('sync')
        setNotice('')
        try {
          const result = kind === 'notes'
            ? await call('knowledgeSync', { direction })
            : await call(direction === 'export' ? 'obsidianExport' : 'obsidianImport', {
              vaultPath: baselineRef.current?.obsidianVault, folder: baselineRef.current?.obsidianFolder, ...(direction === 'import' ? { dryRun: false } : {}),
            })
          setNotice(direction === 'export'
            ? t('library.exportResult', { written: String(result?.written ?? 0), skipped: String(result?.skipped ?? 0) })
            : t('library.importResult', { imported: String(result?.imported ?? 0), conflicts: String(result?.conflicts?.length ?? result?.conflicts ?? 0), skipped: String(result?.skipped ?? 0) }))
          onSaved()
        } catch (failure) { setNotice(t('obsidian.failed', { reason: messageOf(failure) })) }
        finally { setBusy(false) }
      }

      const switchRow = (label, checked, onChange, hint) => h(SettingRow, { label, hint },
        description => h('button', {
          type: 'button',
          className: 'dsh-memory-switch',
          role: 'switch',
          'aria-checked': checked,
          'aria-label': label,
          'aria-describedby': description,
          onClick: () => onChange(!checked),
        }, h('span', { className: 'dsh-memory-switch-knob' })))
      const numberRow = (label, value, unit, min, max, hint, error, onChange) => h(SettingRow, { label, hint, error },
        description => h('span', { className: 'dsh-memory-number' },
          h('input', { type: 'number', min, max, step: 1, value, 'aria-label': label,
            'aria-describedby': description, 'aria-invalid': Boolean(error), onChange }),
          h('span', { 'aria-hidden': true }, unit)))
      const textRow = (label, value, placeholder, error, maxLength, onChange) => h(SettingRow, { label, error },
        description => h('input', {
          className: 'dsh-memory-settings-input',
          type: 'text',
          value,
          title: value || undefined,
          placeholder,
          maxLength,
          'aria-label': label,
          'aria-describedby': description,
          'aria-invalid': Boolean(error),
          onChange,
        }))
      const groupSection = (title, ...content) => h('section', { className: 'dsh-memory-settings-group' },
        h('h3', { className: 'dsh-memory-settings-group-title' }, t('settings.group.' + title)), ...content)
      const button = (label, onClick) => h('button', {
        type: 'button',
        className: 'dsh-memory-button',
        onClick,
        disabled: busy,
      }, label)
      const feedbackAt = area => notice !== '' && noticeArea === area
        ? h('p', { className: 'dsh-memory-settings-notice', role: 'status' }, notice) : null

      const budgetError = !budgetValid && (dirtyFields.includes('budget') || repairing) ? t('settings.invalid.budget') : ''
      const retentionError = !retentionValid && (dirtyFields.includes('retention') || repairing) ? t('settings.invalid.retention') : ''
      const behavior = h(React.Fragment, null,
        groupSection('capture',
          switchRow(t('settings.capture'), capture, value => updateDraft('capture', value, setCapture)),
          switchRow(t('settings.inject'), inject, value => updateDraft('inject', value, setInject)),
          numberRow(t('settings.budget'), budget, 'Token', 100, 8000, t('settings.budgetHint'), budgetError,
            event => updateDraft('budget', event.target.value, setBudget))),
        groupSection('retention',
          numberRow(t('settings.retention'), retention, t('settings.days'), 0, 36500, t('settings.retentionHint'), retentionError,
            event => updateDraft('retention', event.target.value, setRetention)),
          switchRow(t('settings.maintenance'), maintenance, value => updateDraft('maintenance', value, setMaintenance)),
          h(SettingRow, { label: t('settings.index') },
            h('button', { type: 'button', className: 'dsh-memory-button', onClick: onRebuild, disabled: busy || actionBusy },
              t(rebuilding ? 'actions.rebuilding' : 'actions.rebuild')))))
      const dataSettings = h(React.Fragment, null,
        groupSection('records',
          h(SettingRow, { label: t('settings.data.records') },
            button(t('data.export'), exportAll),
            button(t('data.import'), () => fileRef.current?.click()),
            h('input', { ref: fileRef, type: 'file', accept: 'application/json', className: 'dsh-memory-file-input', onChange: importAll })),
          feedbackAt('records'),
          h(SettingRow, { label: t('data.backup'), hint: t('data.backupHint') },
            button(t('data.backupAction'), backupNow)),
          feedbackAt('backup')),
        groupSection('sharing',
          h(SettingRow, { label: t('data.localSharing'), hint: sharingUrl
            ? h('a', { href: sharingUrl, target: '_blank', rel: 'noopener noreferrer' }, t('data.sharingLink')) : null },
            button(t('data.openSharing'), openLocalSharing), button(t('data.stopSharing'), stopLocalSharing)),
          feedbackAt('sharing')))
      const obsidianSettings = h(React.Fragment, null,
        groupSection('obsidian',
          textRow(t('obsidian.vault'), obsidianVault, t('obsidian.vaultPlaceholder'), fieldErrors.obsidianVaultPath, 1024,
            event => updateDraft('obsidianVault', event.target.value, setObsidianVault)),
          textRow(t('obsidian.folder'), obsidianFolder, 'DSH Memory', fieldErrors.obsidianFolder, 64,
            event => updateDraft('obsidianFolder', event.target.value, setObsidianFolder)),
          switchRow(t('obsidian.auto'), obsidianAuto, value => updateDraft('obsidianAuto', value, setObsidianAuto), t('obsidian.autoHint'))),
        groupSection('sync',
          h(ObsidianSyncStatus, { call, t, disabled: busy || dirty }),
          h('details', { className: 'dsh-memory-manual-sync dsh-memory-disclosure' },
            h('summary', { className: 'dsh-memory-disclosure-head' }, t('sync.manual')),
            ['memories', 'notes'].map(kind => h(SettingRow, { key: kind, label: t('sync.' + kind) },
              ['export', 'import'].map(direction => h('button', {
                key: direction, type: 'button', className: 'dsh-memory-button',
                'aria-label': t('data.' + direction) + ' · ' + t('sync.' + kind),
                disabled: !call || busy || dirty || !baselineRef.current?.obsidianVault,
                onClick: () => transfer(kind, direction),
              }, t('data.' + direction)))))),
          feedbackAt('sync')))
      const content = group === 'capture' ? behavior : group === 'data' ? dataSettings : obsidianSettings
      return h('section', { className: 'dsh-memory-settings', 'aria-label': t('view.' + group) },
        stats?.settingsIssue ? h('p', { className: 'dsh-memory-error', role: 'alert' }, stats.settingsIssue.message) : null,
        baseline === null ? h('p', { className: 'dsh-memory-muted', role: 'status' }, t('settings.loading')) : null,
        baseline !== null && repairing && !numbersValid ? h('p', { className: 'dsh-memory-error', role: 'alert' }, t('settings.repair.numbersInvalid')) : null,
        baseline !== null && stats?.maintenance?.backupError && group === 'capture'
          ? h('p', { className: 'dsh-memory-error', role: 'alert' }, stats.maintenance.backupError.message) : null,
        baseline === null ? null : content,
        baseline === null || group === 'data' ? null : h('div', { className: 'dsh-memory-settings-foot' },
          feedbackAt(group) ?? (dirty ? h('span', { className: 'dsh-memory-settings-state' }, t('settings.state.dirty')) : null),
          h('button', {
            type: 'button', className: 'dsh-memory-button dsh-memory-button-primary', onClick: save,
            disabled: busy || actionBusy || !dirty || !canSave,
          }, busy ? t('settings.saving') : t('settings.save'))))
    }
