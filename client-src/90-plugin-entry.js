    const inject = ['slots', 'locale']

    function apply(ctx) {
      let style = null
      try {
        style = installStyle()
      } catch {
        style = null
      }
      const transport = createTransportStore(ctx)
      // Warm the RPC once per client activation: a broken mount or transport
      // surfaces immediately instead of only when the section is opened, and
      // the read-only `stats` call is cheap. The panel still loads its own data
      // on mount; this only exercises the same path early.
      {
        let probed = false
        const probe = () => {
          if (probed) return
          const state = transport.getState()
          if (state === null || state.status !== 'ready' || typeof state.call !== 'function') return
          probed = true
          try {
            const pending = state.call('stats', {})
            if (pending !== null && typeof pending === 'object' && typeof pending.catch === 'function') pending.catch(() => {})
          } catch {
            // The panel renders its own error state when a call fails.
          }
        }
        const unsubscribe = transport.subscribe(probe)
        probe()
        ctx.effect(() => () => unsubscribe(), 'dsh-memory:transport-probe')
      }
      ctx.effect(() => {
        try {
          return ctx.locale.register(NS, DICTIONARIES)
        } catch (error) {
          ctx.logger?.warn?.(`[dsh-memory] locale dictionary registration failed: ${messageOf(error)}`)
          return () => {}
        }
      }, 'dsh-memory:locale')
      const disposeSlot = ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'memory',
        order: 17,
        label: () => ctx.locale.bind(NS)('nav'),
        locale: NS,
        inject: () => ({
          t: ctx.locale.bind(NS),
          store: transport,
          locale: ctx.locale.snapshot?.active,
          sessionSource: ctx.get('uiSession')?.adapter?.current ?? EMPTY_SESSION_SOURCE,
        }),
      }, MemoryPanel))
      return () => {
        try {
          disposeSlot?.()
        } catch {
          // Slot removal is best effort during page teardown.
        }
        transport.dispose()
        if (style !== null) {
          try {
            style.remove()
          } catch {
            // The head may already be detached on teardown.
          }
        }
      }
    }

    return { inject, apply }
  },
})
