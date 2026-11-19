    function messageOf(error) {
      if (error === null || error === undefined) return 'unknown error'
      return typeof error.message === 'string' && error.message !== '' ? error.message : String(error)
    }

    function installStyle() {
      if (typeof document === 'undefined') return null
      const key = PACKAGE + '/client.css'
      if (document.querySelector('style[data-plugin-css="' + key + '"]') !== null) return null
      const style = document.createElement('style')
      style.dataset.plugin = PACKAGE
      style.dataset.pluginCss = key
      style.textContent = CSS
      document.head.appendChild(style)
      return style
    }

    function strictCodec(typeSymbol) {
      return {
        mode: 'strict',
        typeSymbol,
        create: () => ({ parse: (value) => value }),
      }
    }

    function descriptorFor(method) {
      return {
        id: PACKAGE + '#dshMemory/' + method,
        service: NAMESPACE,
        namespace: NAMESPACE,
        method,
        invocation: { kind: 'direct' },
        parameters: [{
          name: 'input',
          wire: 'input',
          source: 'json',
          codec: strictCodec(PACKAGE + '#PanelInput'),
        }],
        result: strictCodec(PACKAGE + '#' + RESULT_TYPES[method]),
        sourceLocation: { file: 'host/remote.js', line: 1, column: 1 },
      }
    }

    const CONTRIBUTION = {
      package: PACKAGE,
      descriptors: METHODS.map(descriptorFor),
    }

    async function remoteCall(service, method, input) {
      const invoke = service[method]
      if (typeof invoke !== 'function') throw new Error('Remote method ' + method + ' is not mounted')
      const result = await invoke.call(service, input)
      if (result !== null && typeof result === 'object' && result.ok === true) return result.value
      const failure = result !== null && typeof result === 'object' ? result.error : undefined
      const error = new Error(failure && typeof failure.message === 'string' ? failure.message : 'Remote call failed')
      if (failure && typeof failure.code === 'string') error.code = failure.code
      throw error
    }

    async function webServerCall(path, method, input) {
      const response = await fetch(path, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ method, input: input === undefined ? {} : input }),
      })
      if (!response.ok) throw new Error('Memory RPC failed with HTTP ' + response.status)
      let payload
      try {
        payload = await response.json()
      } catch {
        throw new Error('Memory RPC returned invalid JSON')
      }
      if (payload !== null && typeof payload === 'object' && payload.ok === true) return payload.value
      const failure = payload !== null && typeof payload === 'object' ? payload.error : undefined
      throw new Error(failure && typeof failure.message === 'string' ? failure.message : 'Memory RPC failed')
    }

    /**
     * Async transport state readable through useSyncExternalStore: the panel
     * renders a loading or unavailable state instead of a blank section.
     */
    function createTransportStore(ctx) {
      let state = { status: 'loading', call: null, error: '' }
      const listeners = new Set()
      let unmounted = null
      let disposed = false
      const publish = (next) => {
        if (disposed) return
        state = next
        for (const listener of [...listeners]) listener()
      }
      const subscribe = (listener) => {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      }
      const getState = () => state
      const boot = globalThis[BOOT_GLOBAL]
      if (boot !== null && typeof boot === 'object' && typeof boot.path === 'string' && boot.path.startsWith('/')) {
        publish({ status: 'ready', call: (method, input) => webServerCall(boot.path, method, input), error: '' })
      } else {
        void (async () => {
          try {
            const remote = ctx.get('remote')
            if (remote === undefined || remote === null || typeof remote.$mount !== 'function') {
              publish({ status: 'unavailable', call: null, error: 'the remote service is not mounted' })
              return
            }
            const release = await remote.$mount(CONTRIBUTION)
            if (disposed) {
              try {
                void release?.()
              } catch {
                // The page is going away; nothing else to release.
              }
              return
            }
            unmounted = release
            const service = ctx.get(SERVICE_KEY)
            if (service === undefined) {
              publish({ status: 'unavailable', call: null, error: 'remote.' + NAMESPACE + ' is not mounted' })
              return
            }
            publish({ status: 'ready', call: (method, input) => remoteCall(service, method, input), error: '' })
          } catch (error) {
            publish({ status: 'unavailable', call: null, error: messageOf(error) })
          }
        })()
      }
      return {
        subscribe,
        getState,
        dispose: () => {
          disposed = true
          listeners.clear()
          try {
            void unmounted?.()
          } catch {
            // Remote disposal is best effort on page teardown.
          }
        },
      }
    }

    function formatTime(value, locale) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '\u2014'
      const date = new Date(value)
      try {
        return new Intl.DateTimeFormat(locale || undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
      } catch {
        return date.toLocaleString()
      }
    }

    function StatCard(props) {
      return h('div', { className: 'dsh-memory-stat' },
        h('span', { className: 'dsh-memory-stat-label' }, props.label),
        h('strong', { className: 'dsh-memory-stat-value' }, props.value))
    }

    // Keep the menu in the browser top layer so scrolling containers cannot clip
    // it. Unlike an OS select popup, its bounds stay inside the settings dialog.
    function Select(props) {
      const { children, value, onChange, ...buttonProps } = props
      const options = React.Children.toArray(children).filter(React.isValidElement).map(child => ({
        value: String(child.props.value), label: child.props.children, disabled: child.props.disabled === true,
      }))
      const selected = options.findIndex(option => option.value === String(value))
      const [open, setOpen] = React.useState(false)
      const [active, setActive] = React.useState(selected)
      const buttonRef = React.useRef(null)
      const menuRef = React.useRef(null)
      const typeahead = React.useRef({ text: '', at: 0 })
      const id = React.useId()
      const enabled = options.map((option, index) => option.disabled ? -1 : index).filter(index => index >= 0)

      const choose = index => {
        const option = options[index]
        if (!option || option.disabled) return
        setOpen(false)
        if (option.value !== String(value)) onChange?.({ target: { value: option.value } })
      }
      const show = () => {
        setActive(enabled.includes(selected) ? selected : enabled[0] ?? -1)
        setOpen(true)
      }

      React.useLayoutEffect(() => {
        if (!open) return undefined
        const button = buttonRef.current, menu = menuRef.current
        const position = () => {
          const anchor = button.getBoundingClientRect()
          const dialog = button.closest('[role="dialog"],dialog')?.getBoundingClientRect()
          const viewport = window.visualViewport
          const x = viewport?.offsetLeft ?? 0, y = viewport?.offsetTop ?? 0
          const left = Math.max(x, dialog?.left ?? x) + 8
          const right = Math.min(x + (viewport?.width ?? innerWidth), dialog?.right ?? innerWidth) - 8
          const top = Math.max(y, dialog?.top ?? y) + 8
          const bottom = Math.min(y + (viewport?.height ?? innerHeight), dialog?.bottom ?? innerHeight) - 8
          if (anchor.bottom < top || anchor.top > bottom || right <= left) { setOpen(false); return }
          const below = Math.max(0, bottom - anchor.bottom - 4), above = Math.max(0, anchor.top - top - 4)
          const upward = below < Math.min(240, menu.scrollHeight) && above > below
          const width = Math.min(Math.max(anchor.width, 220), right - left)
          Object.assign(menu.style, {
            width: width + 'px', maxHeight: Math.min(260, upward ? above : below) + 'px',
            left: Math.max(left, Math.min(anchor.left, right - width)) + 'px',
          })
          menu.style.top = (upward ? anchor.top - menu.getBoundingClientRect().height - 4 : anchor.bottom + 4) + 'px'
        }
        menu.showPopover()
        position()
        const outside = event => {
          if (!button.contains(event.target) && !menu.contains(event.target)) setOpen(false)
        }
        const scroll = event => { if (!menu.contains(event.target)) position() }
        document.addEventListener('pointerdown', outside, true)
        document.addEventListener('scroll', scroll, true)
        window.addEventListener('resize', position)
        window.visualViewport?.addEventListener('resize', position)
        window.visualViewport?.addEventListener('scroll', position)
        return () => {
          if (menu.matches(':popover-open')) menu.hidePopover()
          document.removeEventListener('pointerdown', outside, true)
          document.removeEventListener('scroll', scroll, true)
          window.removeEventListener('resize', position)
          window.visualViewport?.removeEventListener('resize', position)
          window.visualViewport?.removeEventListener('scroll', position)
        }
      }, [open])

      React.useLayoutEffect(() => {
        if (!open) return
        const menu = menuRef.current, option = menu.children[active]
        if (!option) return
        if (option.offsetTop < menu.scrollTop) menu.scrollTop = option.offsetTop
        else if (option.offsetTop + option.offsetHeight > menu.scrollTop + menu.clientHeight) {
          menu.scrollTop = option.offsetTop + option.offsetHeight - menu.clientHeight
        }
      }, [open, active])

      const keyDown = event => {
        const key = event.key
        if (key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); setOpen(false); return }
        if (key === 'Tab') { setOpen(false); return }
        if (key === 'Enter' || key === ' ') {
          event.preventDefault()
          if (open) choose(active); else show()
        } else if (['ArrowDown', 'ArrowUp', 'Home', 'End', 'PageDown', 'PageUp'].includes(key)) {
          event.preventDefault()
          const current = enabled.indexOf(open ? active : selected)
          const offset = key === 'PageDown' ? 10 : key === 'PageUp' ? -10 : key === 'ArrowUp' ? -1 : 1
          const next = key === 'Home' ? 0 : key === 'End' ? enabled.length - 1 : Math.max(0, Math.min(enabled.length - 1, current + offset))
          setActive(enabled[next] ?? -1)
          setOpen(true)
        } else if (key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
          const now = Date.now(), previous = typeahead.current
          const text = (now - previous.at < 700 ? previous.text : '') + key.toLocaleLowerCase()
          typeahead.current = { text, at: now }
          const match = enabled.find(index => String(options[index].label).toLocaleLowerCase().startsWith(text))
          if (match !== undefined) { event.preventDefault(); setActive(match); setOpen(true) }
        }
      }
      return h(React.Fragment, null,
        h('button', { ...buttonProps, ref: buttonRef, type: 'button', role: 'combobox',
          'aria-expanded': open, 'aria-haspopup': 'listbox', 'aria-controls': id,
          'aria-activedescendant': open && active >= 0 ? id + '-' + active : undefined,
          title: buttonProps.title ?? String(options[selected]?.label ?? ''),
          onClick: () => open ? setOpen(false) : show(), onKeyDown: keyDown, onBlur: () => setOpen(false),
        }, h('span', { className: 'dsh-memory-select-value' }, options[selected]?.label ?? ''),
        h('svg', { className: 'dsh-memory-select-arrow', viewBox: '0 0 12 12', 'aria-hidden': true },
          h('path', { d: 'm3 4.5 3 3 3-3', fill: 'none', stroke: 'currentColor', strokeWidth: 1.3 }))),
        h('div', { ref: menuRef, id, className: 'dsh-memory-select-menu', popover: 'manual', role: 'listbox',
          'aria-label': buttonProps['aria-label'], onMouseDown: event => event.preventDefault(),
          onClick: event => event.preventDefault(),
        }, options.map((option, index) => h('div', {
          key: option.value, id: id + '-' + index, role: 'option', className: 'dsh-memory-select-option',
          'aria-selected': index === selected, 'aria-disabled': option.disabled || undefined, 'data-active': index === active,
          onPointerMove: () => { if (!option.disabled) setActive(index) }, onClick: () => choose(index),
        }, h('span', { className: 'dsh-memory-select-mark', 'aria-hidden': true }, index === selected ? '✓' : ''), option.label))))
    }

    function Field(props) {
      return h('label', { className: 'dsh-memory-field' + (props.grow === true ? ' dsh-memory-field-grow' : '') },
        h('span', { className: 'dsh-memory-field-label' }, props.label),
        props.children)
    }
