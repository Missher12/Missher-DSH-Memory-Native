    function ObsidianSyncStatus({call,t,disabled}) {
      const [status,setStatus]=React.useState(null), [error,setError]=React.useState(''), [busy,setBusy]=React.useState(false)
      React.useEffect(()=>{
        if(!call)return undefined
        let stopped=false
        const read=()=>call('obsidianStatus',{}).then(v=>{if(!stopped){setStatus(v.automatic);setError('')}}).catch(e=>{if(!stopped)setError(messageOf(e))})
        void read();const timer=setInterval(read,5000)
        return()=>{stopped=true;clearInterval(timer)}
      },[call])
      const action=async(method,input={})=>{
        setBusy(true)
        try{await call(method,input);const current=await call('obsidianStatus',{});setStatus(current.automatic);setError('')}
        catch(e){setError(messageOf(e))}finally{setBusy(false)}
      }
      return h('div',null,
        h('p',{className:'dsh-memory-muted',role:'status'},status?.at?t('obsidian.syncStatus',{time:new Date(status.at).toLocaleTimeString(),sent:status.exported,received:status.imported,conflicts:status.conflicts.length})+' · '+t('obsidian.mode.'+(status.mode==='full'?'full':'incremental')):t('obsidian.notYet')),
        status?.pendingFiles?h('p',{className:'dsh-memory-muted'},t('obsidian.pending',{count:status.pendingFiles})):null,
        status?.fullScanPending?h('p',{className:'dsh-memory-muted'},t('obsidian.fullPending')):null,
        h('button',{type:'button',className:'dsh-memory-button',disabled:disabled||busy||!call,onClick:()=>action('obsidianSync',{fullScan:true})},t('obsidian.fullScan')),
        error?h('p',{className:'dsh-memory-error-text',role:'alert'},error):null,
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
      const [busy, setBusy] = React.useState(false)
      const [notice, setNotice] = React.useState('')
      const [sharingUrl, setSharingUrl] = React.useState('')
      const fileRef = React.useRef(null)

      React.useEffect(() => {
        if (stats === null) return
        const next = {
          capture: stats.captureEnabled === true,
          inject: stats.injectEnabled === true,
          budget: String(stats.injectMaxTokens ?? 360),
          retention: String(stats.retentionEpisodeDays ?? 90),
          maintenance: stats.maintenanceEnabled !== false,
          obsidianAuto: stats.obsidianAutoSync === true,
          obsidianVault: typeof stats.obsidianVaultPath === 'string' ? stats.obsidianVaultPath : '',
          obsidianFolder: typeof stats.obsidianFolder === 'string' ? stats.obsidianFolder : 'DSH Memory',
        }
        setCapture(next.capture)
        setInject(next.inject)
        setBudget(next.budget)
        setRetention(next.retention)
        setMaintenance(next.maintenance)
        setObsidianAuto(next.obsidianAuto)
        setObsidianVault(next.obsidianVault)
        setObsidianFolder(next.obsidianFolder)
        setBaseline(next)
      }, [stats])

      const dirty = baseline !== null && (
        stats?.settingsIssue?.code === 'settings-invalid' ||
        capture !== baseline.capture ||
        inject !== baseline.inject ||
        budget !== baseline.budget ||
        retention !== baseline.retention ||
        maintenance !== baseline.maintenance ||
        obsidianAuto !== baseline.obsidianAuto ||
        obsidianVault !== baseline.obsidianVault ||
        obsidianFolder !== baseline.obsidianFolder
      )
      const snapshot = () => ({ capture, inject, budget, retention, maintenance, obsidianAuto, obsidianVault, obsidianFolder })
      const save = async () => {
        if (call === null || busy || !dirty) return
        setBusy(true)
        setNotice('')
        try {
          await call('updateSettings', {
            captureEnabled: capture,
            injectEnabled: inject,
            injectMaxTokens: Math.max(100, Number(budget) || 360),
            retentionEpisodeDays: Math.max(0, Number(retention) || 0),
            maintenanceEnabled: maintenance,
            obsidianAutoSync: obsidianAuto,
            obsidianVaultPath: obsidianVault.trim(),
            obsidianFolder: obsidianFolder.trim(),
          })
          setBaseline(snapshot())
          setNotice(t('settings.saved'))
          onSaved()
        } catch (failure) {
          setNotice(t('settings.failed', { reason: messageOf(failure) }))
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
              vaultPath: baseline.obsidianVault, folder: baseline.obsidianFolder, ...(direction === 'import' ? { dryRun: false } : {}),
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
      const numberRow = (label, value, unit, min, max, step, onChange) => h('div', { className: 'dsh-memory-settings-row' },
        h('span', { className: 'dsh-memory-settings-label' }, label),
        h('span', { className: 'dsh-memory-number' },
          h('input', { type: 'number', min, max, step, value, 'aria-label': label, onChange }),
          h('em', null, unit)))
      const textRow = (label, value, placeholder, onChange) => h('div', { className: 'dsh-memory-settings-row' },
        h('span', { className: 'dsh-memory-settings-label' }, label),
        h('input', {
          className: 'dsh-memory-settings-input',
          type: 'text',
          value,
          placeholder,
          'aria-label': label,
          onChange,
        }))
      const button = (label, onClick) => h('button', {
        type: 'button',
        className: 'dsh-memory-button',
        onClick,
        disabled: busy,
      }, label)

      return h('section', { className: 'dsh-memory-settings', 'aria-label': t('view.' + group) },
        stats?.settingsIssue ? h('p', { className: 'dsh-memory-error', role: 'alert' }, stats.settingsIssue.message) : null,
        group === 'retention' && stats?.maintenance?.backupError ? h('p', { className: 'dsh-memory-error', role: 'alert' }, stats.maintenance.backupError.message) : null,
        group === 'capture'
          ? h('div', { className: 'dsh-memory-settings-group' },
            switchRow(t('settings.capture'), capture, setCapture),
            switchRow(t('settings.inject'), inject, setInject),
            numberRow(t('settings.budget'), budget, 'token', '100', '8000', '50', (event) => setBudget(event.target.value)))
          : group === 'retention'
            ? h('div', { className: 'dsh-memory-settings-group' },
              numberRow(t('settings.retention'), retention, '天', '0', '36500', '10', (event) => setRetention(event.target.value)),
              switchRow(t('settings.maintenance'), maintenance, setMaintenance))
            : group === 'data'
              ? h('div', { className: 'dsh-memory-settings-group' },
                h('p', { className: 'dsh-memory-muted' }, t('data.backupHint')),
                h('div', { className: 'dsh-memory-settings-row' },
                  h('span', { className: 'dsh-memory-settings-label' }, t('settings.data.label')),
                  h('div', { className: 'dsh-memory-settings-buttons' },
                    button(t('data.export'), exportAll),
                    button(t('data.import'), () => fileRef.current?.click()),
                    button(t('data.backup'), backupNow),
                    h('input', {
                      ref: fileRef,
                      type: 'file',
                      accept: 'application/json',
                      className: 'dsh-memory-file-input',
                      onChange: importAll,
                    }))),
                h('div', { className: 'dsh-memory-settings-row' },
                  h('span', { className: 'dsh-memory-settings-label' }, t('data.localSharing')),
                  h('div', { className: 'dsh-memory-settings-buttons' },
                    button(t('data.openSharing'), openLocalSharing),
                    button(t('data.stopSharing'), stopLocalSharing))),
                sharingUrl ? h('div', { className: 'dsh-memory-settings-row' },
                  h('span', { className: 'dsh-memory-settings-label' }, ''),
                  h('a', { href: sharingUrl, target: '_blank', rel: 'noopener noreferrer' }, t('data.sharingLink'))) : null)
              : h('div', { className: 'dsh-memory-settings-group' },
                switchRow(t('obsidian.auto'), obsidianAuto, setObsidianAuto),
                h('p', { className:'dsh-memory-muted' }, t('obsidian.autoHint')),
                textRow(t('obsidian.vault'), obsidianVault, '/Users/me/Vault', (event) => setObsidianVault(event.target.value)),
                textRow(t('obsidian.folder'), obsidianFolder, 'DSH Memory', (event) => setObsidianFolder(event.target.value)),
                h(ObsidianSyncStatus, {call,t,disabled:busy||dirty}),
                h('details', { className: 'dsh-memory-manual-sync' },
                  h('summary', null, t('sync.manual')),
                  ['memories', 'notes'].map(kind => h('div', { key: kind, className: 'dsh-memory-settings-row' },
                    h('span', { className: 'dsh-memory-settings-label' }, t('sync.' + kind)),
                    h('div', { className: 'dsh-memory-settings-buttons' },
                      ['export','import'].map(direction => h('button', {
                        key: direction, type: 'button', className: 'dsh-memory-button',
                        'aria-label': t('data.' + direction) + ' · ' + t('sync.' + kind),
                        disabled: !call || busy || dirty || !baseline?.obsidianVault,
                        onClick: () => transfer(kind, direction),
                      }, t('data.' + direction)))))))),
        notice === '' ? null : h('p', { className: 'dsh-memory-settings-notice', role: 'status' }, notice),
        group === 'data' ? null : h('div', { className: 'dsh-memory-settings-foot' },
          dirty ? h('span', { className: 'dsh-memory-settings-state' }, t('settings.state.dirty')) : null,
          h('button', {
            type: 'button',
            className: 'dsh-memory-button dsh-memory-button-primary',
            onClick: save,
            disabled: busy || !dirty,
          }, busy ? t('settings.saving') : t('settings.save'))))
    }
