    function KnowledgeLibrary(props) {
      const { data, loading, error, t, call, onChanged, projectKeys = [] } = props
      const notes = data !== null && Array.isArray(data.notes) ? data.notes : []
      const [editing, setEditing] = React.useState(false)
      const [note, setNote] = React.useState(null)
      const [draft, setDraft] = React.useState(null)
      const [opening, setOpening] = React.useState(false)
      const [saving, setSaving] = React.useState(false)
      const [noteError, setNoteError] = React.useState('')
      const [conflict, setConflict] = React.useState(false)
      const [notice, setNotice] = React.useState('')

      const close = () => {
        setEditing(false)
        setNote(null)
        setDraft(null)
        setNoteError('')
        setConflict(false)
        setOpening(false)
      }

      const loadNote = async (file) => {
        if (call === null) return
        setEditing(true)
        setOpening(true)
        setNoteError('')
        setConflict(false)
        setNotice('')
        try {
          const next = await call('knowledgeNote', { file })
          setNote(next)
          setDraft({
            title: next.title ?? '',
            topic: next.topic ?? '',
            tags: (Array.isArray(next.tags) ? next.tags : []).join(', '),
            body: next.body ?? '',
            scope: next.scope ?? 'unbound',
            projectKey: next.projectKey ?? '',
          })
        } catch (failure) {
          setNoteError(t('library.openFailed', { reason: messageOf(failure) }))
        } finally {
          setOpening(false)
        }
      }

      const save = async (event) => {
        event.preventDefault()
        if (call === null || note === null || draft === null || saving) return
        setSaving(true)
        setNoteError('')
        setConflict(false)
        try {
          const tags = draft.tags.split(/[,\uFF0C]/u).map((tag) => tag.trim()).filter((tag) => tag !== '')
          const result = await call('knowledgeSave', {
            file: note.file,
            title: draft.title.trim(),
            body: draft.body,
            topic: draft.topic.trim(),
            tags,
            expectedMtimeMs: note.mtimeMs,
            scope: draft.scope,
            projectKey: draft.scope === 'project' ? draft.projectKey : null,
          })
          if (result !== null && result !== undefined && result.saved === false && result.reason === 'conflict') {
            setConflict(true)
            return
          }
          setNotice(t('library.saved'))
          close()
          if (typeof onChanged === 'function') onChanged()
        } catch (failure) {
          setNoteError(t('library.saveFailed', { reason: messageOf(failure) }))
        } finally {
          setSaving(false)
        }
      }


      const editor = draft === null
        ? null
        : h('form', { className: 'dsh-memory-form', onSubmit: save },
          conflict ? h('p', { className: 'dsh-memory-library-conflict', role: 'alert' }, t('library.conflict')) : null,
          h(Field, { label: t('library.titleField') },
            h('input', {
              className: 'dsh-memory-input',
              value: draft.title,
              maxLength: 200,
              onChange: (event) => setDraft({ ...draft, title: event.target.value }),
            })),
          h(Field, { label: t('library.topicField') },
            h('input', {
              className: 'dsh-memory-input',
              value: draft.topic,
              maxLength: 40,
              onChange: (event) => setDraft({ ...draft, topic: event.target.value }),
            })),
          h(Field, { label: t('library.tagsField') },
            h('input', {
              className: 'dsh-memory-input',
              value: draft.tags,
              placeholder: t('library.tagsHint'),
              onChange: (event) => setDraft({ ...draft, tags: event.target.value }),
            })),
          h(Field, { label: t('library.recallScope'), hint: t('library.scopeHint') },
            h(Select, { className: 'dsh-memory-select', value: draft.scope, 'aria-label': t('library.recallScope'),
              onChange: event => setDraft({ ...draft, scope: event.target.value, projectKey: event.target.value === 'project' ? draft.projectKey : '' }) },
              ['unbound','project','global'].map(scope => h('option', { key: scope, value: scope }, t('library.scope.' + scope))))),
          draft.scope === 'project' ? h(Field, { label: t('brief.project') },
            h(Select, { className: 'dsh-memory-select', value: draft.projectKey, 'aria-label': t('brief.project'),
              onChange: event => setDraft({ ...draft, projectKey: event.target.value }) },
              h('option', { value: '' }, t('brief.choose')),
              [...new Set([...projectKeys, ...(draft.projectKey ? [draft.projectKey] : [])])].map(key => h('option', { key, value: key }, key)))) : null,
          h(Field, { label: t('library.bodyField'), wide: true, hint: t('library.bodyHint') },
            h('textarea', {
              className: 'dsh-memory-textarea dsh-memory-library-body',
              rows: 10,
              value: draft.body,
              onChange: (event) => setDraft({ ...draft, body: event.target.value }),
            })),
          noteError === '' ? null : h('p', { className: 'dsh-memory-error-text', role: 'alert' }, noteError),
          h('div', { className: 'dsh-memory-modal-actions' },
            conflict
              ? h('button', { type: 'button', className: 'dsh-memory-button', onClick: () => loadNote(note.file), disabled: saving }, t('library.reload'))
              : null,
            h('button', { type: 'button', className: 'dsh-memory-button', onClick: close, disabled: saving }, t('actions.cancel')),
            h('button', {
              type: 'submit',
              className: 'dsh-memory-button',
              'data-primary': 'true',
              disabled: saving || draft.title.trim() === '' || (draft.scope === 'project' && !draft.projectKey),
            }, saving ? t('library.saving') : t('actions.save'))))

      const modal = editing
        ? h(PanelDialog, { title: t('library.editorTitle'), onClose: close, busy: saving },
          note === null ? null : h('p', { className: 'dsh-memory-library-file' }, note.file),
          opening
            ? h('p', { className: 'dsh-memory-muted', role: 'status' }, t('library.loading'))
            : editor === null
              ? h('div', null,
                noteError === '' ? null : h('p', { className: 'dsh-memory-error-text', role: 'alert' }, noteError),
                h('div', { className: 'dsh-memory-modal-actions' },
                  h('button', { type: 'button', className: 'dsh-memory-button', onClick: close }, t('actions.cancel'))))
              : editor)
        : null

      return h('section', { className: 'dsh-memory-library' },
        h('div', { className: 'dsh-memory-section-head' },
          h('h3', { className: 'dsh-memory-section-title' }, t('library.title')),
          h('span', { className: 'dsh-memory-list-total' }, t('library.total', { count: String(notes.length) }))),
        notice === '' ? null : h('p', { className: 'dsh-memory-library-notice', role: 'status' }, notice),
        loading
          ? h('p', { className: 'dsh-memory-muted', role: 'status' }, t('library.loading'))
          : error !== ''
            ? h('p', { className: 'dsh-memory-error-text', role: 'alert' }, t('library.failed', { reason: error }))
            : notes.length === 0
              ? h('p', { className: 'dsh-memory-muted' }, t('library.empty'))
              : h('ul', { className: 'dsh-memory-history' }, notes.map((note) => h('li', { key: note.file, className: 'dsh-memory-history-item' },
                h('button', {
                  type: 'button',
                  className: 'dsh-memory-library-open',
                  onClick: () => loadNote(note.file),
                },
                h('span', { className: 'dsh-memory-library-description' },
                  h('strong', null, note.title),
                  h('span', { className: 'dsh-memory-muted' },
                    [t('library.scope.' + (note.scope ?? 'unbound')),
                      note.scope === 'project' ? note.projectKey : null, note.topic].filter(Boolean).join(' · '))),
                h('span', { className: 'dsh-memory-library-edit' }, t('library.edit')))))),
        modal)
    }

    function MemoryEditor(props) {

      const { t, record, busy, error, onCancel, onSave } = props
      const [content, setContent] = React.useState(record.content)
      const [tags, setTags] = React.useState((Array.isArray(record.tags) ? record.tags : []).join(', '))
      const [status, setStatus] = React.useState(EDITABLE_STATUSES.includes(record.status) ? record.status : 'archived')
      const [pinned, setPinned] = React.useState(record.pinned === true)
      const contentRef = React.useRef(null)

      React.useEffect(() => {
        const node = contentRef.current
        if (node !== null) {
          node.focus()
          if (typeof node.select === 'function') node.select()
        }
      }, [])

      const submit = (event) => {
        event.preventDefault()
        if (busy) return
        const nextTags = tags.split(/[,\uFF0C]/u).map((tag) => tag.trim()).filter((tag) => tag !== '')
        onSave({ content: content.trim(), tags: nextTags, status, pinned })
      }

      return h(PanelDialog, { title: t('edit.title'), onClose: onCancel, busy },
        h('form', { className: 'dsh-memory-form', onSubmit: submit },
          h(Field, { label: t('edit.content'), wide: true },
            h('textarea', {
              ref: contentRef,
              className: 'dsh-memory-textarea',
              value: content,
              rows: 5,
              maxLength: 500,
              onChange: (event) => setContent(event.target.value),
            })),
          h(Field, { label: t('edit.tags') },
            h('input', {
              className: 'dsh-memory-input',
              value: tags,
              onChange: (event) => setTags(event.target.value),
              placeholder: t('edit.tagsHint'),
            })),
          h(Field, { label: t('edit.status') },
            h(Select, {
              className: 'dsh-memory-select',
              value: status,
              'aria-label': t('edit.status'),
              onChange: (event) => setStatus(event.target.value),
            }, EDITABLE_STATUSES.map((value) => h('option', { key: value, value }, t('status.' + value))))),
          h('label', { className: 'dsh-memory-check' },
            h('input', {
              type: 'checkbox',
              checked: pinned,
              onChange: (event) => setPinned(event.target.checked),
            }),
            h('span', null, t('edit.pinned'))),
          error === '' ? null : h('p', { className: 'dsh-memory-error-text', role: 'alert' }, t('edit.error', { message: error })),
          h('div', { className: 'dsh-memory-modal-actions' },
            h('button', { type: 'button', className: 'dsh-memory-button', onClick: onCancel, disabled: busy }, t('actions.cancel')),
            h('button', {
              type: 'submit',
              className: 'dsh-memory-button',
              'data-primary': 'true',
              disabled: busy || content.trim() === '',
            }, busy ? t('actions.saving') : t('actions.save')))))
    }

    /** Character-level change summary between two revisions. */
