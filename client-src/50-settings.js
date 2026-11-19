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
      return h('div',null,
        h('p',{className:'dsh-memory-muted',role:'status'},status?.at?t('obsidian.syncStatus',{time:new Date(status.at).toLocaleTimeString(),sent:status.exported,received:status.imported,conflicts:status.conflicts.length})+' · '+t('obsidian.mode.'+(status.mode==='full'?'full':'incremental')):t('obsidian.notYet')),
        status?.pendingFiles?h('p',{className:'dsh-memory-muted'},t('obsidian.pending',{count:status.pendingFiles})):null,
        status?.fullScanPending?h('p',{className:'dsh-memory-muted'},t('obsidian.fullPending')):null,
        h('button',{type:'button',className:'dsh-memory-button',disabled:disabled||busy||!call,onClick:()=>action('obsidianSync',{fullScan:true})},t('obsidian.fullScan')),
        statusError?h('p',{className:'dsh-memory-error-text',role:'alert'},statusError):null,
        actionError?h('p',{className:'dsh-memory-error-text',role:'alert'},actionError):null,
        (status?.errors??[]).map((e,i)=>h('p',{key:i,className:'dsh-memory-error-text'},e.file+': '+e.message)),
        (status?.conflicts??[]).map(c=>h('details',{key:c.key,className:'dsh-memory-card'},
          h('summary',null,c.file+' · '+c.reason),
          h('p',{className:'dsh-memory-muted',style:{overflowWrap:'anywhere'}},c.copies.join('\n')),
          h('strong',null,'Memory'),h('pre',{style:{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}},c.memoryText??t('obsidian.deleted')),
          h('strong',null,'Obsidian'),h('pre',{style:{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}},c.vaultText??t('obsidian.deleted')),
          h('div',{className:'dsh-memory-settings-buttons'},['memory','vault'].map(side=>h('button',{key:side,type:'button',className:'dsh-memory-button',disabled:disabled||busy,onClick:()=>action('obsidianResolve',{key:c.key,token:c.token,side})},t(side==='memory'?'obsidian.keepMemory':'obsidian.keepVault')))))))
    }

    function SettingsCard(props) {
      const { stats, call, t, onSaved, group = 'capture' } = props
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
        if (call === null || busy || !dirty || !canSave) return
        setBusy(true)
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

      const switchRow = (label, checked, onChange) => h('div', { className: 'dsh-memory-settings-row' },
        h('span', { className: 'dsh-memory-settings-label' }, label),
        h('button', {
          type: 'button',
          className: 'dsh-memory-switch',
          role: 'switch',
          'aria-checked': checked ? 'true' : 'false',
          'aria-label': label,
          onClick: () => onChange(!checked),
        }, h('span', { className: 'dsh-memory-switch-knob' })))
      const fieldError = message => message ? h('p', { className: 'dsh-memory-field-error', role: 'alert' }, message) : null
      const numberRow = (label, value, unit, min, max, step, error, onChange) => h(React.Fragment, null,
        h('div', { className: 'dsh-memory-settings-row' },
          h('span', { className: 'dsh-memory-settings-label' }, label),
          h('span', { className: 'dsh-memory-number' },
            h('input', { type: 'number', min, max, step, value, 'aria-label': label, 'aria-invalid': error ? 'true' : undefined, onChange }),
            h('em', null, unit))),
        fieldError(error))
      const textRow = (label, value, placeholder, error, maxLength, onChange) => h(React.Fragment, null,
        h('div', { className: 'dsh-memory-settings-row' },
          h('span', { className: 'dsh-memory-settings-label' }, label),
          h('input', {
            className: 'dsh-memory-settings-input',
            type: 'text',
            value,
            placeholder,
            maxLength,
            'aria-label': label,
            'aria-invalid': error ? 'true' : undefined,
            onChange,
          })),
        fieldError(error))
      const groupSection = (title, content) => h('div', { className: 'dsh-memory-settings-group' },
        h('h2', { className: 'dsh-memory-settings-group-title' }, t('settings.group.' + title)), content)
      const button = (label, onClick) => h('button', {
        type: 'button',
        className: 'dsh-memory-button',
        onClick,
        disabled: busy,
      }, label)

      const budgetError = !budgetValid && (dirtyFields.includes('budget') || repairing) ? t('settings.invalid.budget') : ''
      const retentionError = !retentionValid && (dirtyFields.includes('retention') || repairing) ? t('settings.invalid.retention') : ''
      const behavior = h(React.Fragment, null,
        groupSection('capture', h(React.Fragment, null,
          switchRow(t('settings.capture'), capture, value => updateDraft('capture', value, setCapture)),
          switchRow(t('settings.inject'), inject, value => updateDraft('inject', value, setInject)),
          numberRow(t('settings.budget'), budget, 'token', '100', '8000', '1', budgetError,
            event => updateDraft('budget', event.target.value, setBudget)),
          h('p', { className: 'dsh-memory-muted' }, t('settings.budgetHint')))),
        groupSection('retention', h(React.Fragment, null,
          numberRow(t('settings.retention'), retention, t('settings.days'), '0', '36500', '1', retentionError,
            event => updateDraft('retention', event.target.value, setRetention)),
          h('p', { className: 'dsh-memory-muted' }, t('settings.retentionHint')),
          switchRow(t('settings.maintenance'), maintenance, value => updateDraft('maintenance', value, setMaintenance)))))
      const dataSettings = h(React.Fragment, null,
        groupSection('records', h('div', { className: 'dsh-memory-settings-row' },
          h('span', { className: 'dsh-memory-settings-label' }, t('settings.data.records')),
          h('div', { className: 'dsh-memory-settings-buttons' },
            button(t('data.export'), exportAll),
            button(t('data.import'), () => fileRef.current?.click()),
            h('input', { ref: fileRef, type: 'file', accept: 'application/json', className: 'dsh-memory-file-input', onChange: importAll })))),
        groupSection('backup', h(React.Fragment, null,
          h('div', { className: 'dsh-memory-settings-row' },
            h('span', { className: 'dsh-memory-settings-label' }, t('data.backup')),
            h('div', { className: 'dsh-memory-settings-buttons' }, button(t('data.backupAction'), backupNow))),
          h('p', { className: 'dsh-memory-muted' }, t('data.backupHint')))),
        groupSection('sharing', h(React.Fragment, null,
          h('div', { className: 'dsh-memory-settings-row' },
            h('span', { className: 'dsh-memory-settings-label' }, t('data.localSharing')),
            h('div', { className: 'dsh-memory-settings-buttons' },
              button(t('data.openSharing'), openLocalSharing), button(t('data.stopSharing'), stopLocalSharing))),
          sharingUrl ? h('div', { className: 'dsh-memory-settings-row' },
            h('span', { className: 'dsh-memory-settings-label' }, ''),
            h('a', { href: sharingUrl, target: '_blank', rel: 'noopener noreferrer' }, t('data.sharingLink'))) : null)))
      const obsidianSettings = groupSection('obsidian', h(React.Fragment, null,
        switchRow(t('obsidian.auto'), obsidianAuto, value => updateDraft('obsidianAuto', value, setObsidianAuto)),
        h('p', { className: 'dsh-memory-muted' }, t('obsidian.autoHint')),
        textRow(t('obsidian.vault'), obsidianVault, '/Users/me/Vault', fieldErrors.obsidianVaultPath, 1024,
          event => updateDraft('obsidianVault', event.target.value, setObsidianVault)),
        textRow(t('obsidian.folder'), obsidianFolder, 'DSH Memory', fieldErrors.obsidianFolder, 64,
          event => updateDraft('obsidianFolder', event.target.value, setObsidianFolder)),
        h(ObsidianSyncStatus, { call, t, disabled: busy || dirty }),
        h('details', { className: 'dsh-memory-manual-sync' },
          h('summary', null, t('sync.manual')),
          ['memories', 'notes'].map(kind => h('div', { key: kind, className: 'dsh-memory-settings-row' },
            h('span', { className: 'dsh-memory-settings-label' }, t('sync.' + kind)),
            h('div', { className: 'dsh-memory-settings-buttons' },
              ['export', 'import'].map(direction => h('button', {
                key: direction, type: 'button', className: 'dsh-memory-button',
                'aria-label': t('data.' + direction) + ' · ' + t('sync.' + kind),
                disabled: !call || busy || dirty || !baselineRef.current?.obsidianVault,
                onClick: () => transfer(kind, direction),
              }, t('data.' + direction)))))))))
      const content = group === 'capture' ? behavior : group === 'data' ? dataSettings : obsidianSettings
      return h('section', { className: 'dsh-memory-settings', 'aria-label': t('view.' + group) },
        stats?.settingsIssue ? h('p', { className: 'dsh-memory-error', role: 'alert' }, stats.settingsIssue.message) : null,
        baseline === null ? h('p', { className: 'dsh-memory-muted', role: 'status' }, t('settings.loading')) : null,
        baseline !== null && repairing && !numbersValid ? h('p', { className: 'dsh-memory-error', role: 'alert' }, t('settings.repair.numbersInvalid')) : null,
        baseline !== null && stats?.maintenance?.backupError && group === 'capture'
          ? h('p', { className: 'dsh-memory-error', role: 'alert' }, stats.maintenance.backupError.message) : null,
        baseline === null ? null : content,
        baseline === null || notice === '' ? null : h('p', { className: 'dsh-memory-settings-notice', role: 'status' }, notice),
        baseline === null || group === 'data' ? null : h('div', { className: 'dsh-memory-settings-foot' },
          dirty ? h('span', { className: 'dsh-memory-settings-state' }, t('settings.state.dirty')) : null,
          h('button', {
            type: 'button', className: 'dsh-memory-button dsh-memory-button-primary', onClick: save,
            disabled: busy || !dirty || !canSave,
          }, busy ? t('settings.saving') : t('settings.save'))))
    }
