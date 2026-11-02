(function () {
  const root = document.documentElement

  // ---- theme ----
  const storedTheme = localStorage.getItem('dsh-memory-demo-theme')
  if (storedTheme === 'dark') root.dataset.theme = 'dark'
  const themeLabel = () => (root.dataset.theme === 'dark' ? '☀ 浅色' : '☾ 深色')
  document.querySelectorAll('[data-action="theme"]').forEach((btn) => {
    btn.textContent = themeLabel()
    btn.addEventListener('click', () => {
      root.dataset.theme = root.dataset.theme === 'dark' ? 'light' : 'dark'
      localStorage.setItem('dsh-memory-demo-theme', root.dataset.theme)
      document.querySelectorAll('[data-action="theme"]').forEach((item) => { item.textContent = themeLabel() })
    })
  })

  // ---- palette ----
  const colors = { theme: '', violet: '#8b6ccf', blue: '#447fcb', teal: '#369f97', amber: '#c69749', rose: '#ca758f' }
  document.querySelectorAll('[data-palette]').forEach((wrap) => {
    const trigger = wrap.querySelector('.palette-trigger')
    const menu = wrap.querySelector('.palette-menu')
    trigger.addEventListener('click', (event) => {
      event.stopPropagation()
      menu.classList.toggle('open')
    })
    document.addEventListener('click', () => menu.classList.remove('open'))
    wrap.querySelectorAll('[data-color]').forEach((option) => {
      option.addEventListener('click', () => {
        const color = colors[option.dataset.color] || ''
        document.querySelectorAll('[data-accent-scope]').forEach((scope) => {
          if (color) scope.style.setProperty('--accent', color)
          else scope.style.removeProperty('--accent')
        })
        menu.classList.remove('open')
      })
    })
  })

  // ---- activity data (synthetic, deterministic: shows the design with history) ----
  const WEEK_ROWS = 7
  const WEEKS = 53
  function buildDays() {
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const first = new Date(today)
    first.setDate(today.getDate() - (WEEKS * WEEK_ROWS - 1))
    first.setDate(first.getDate() - first.getDay())
    const days = []
    for (let index = 0; index < WEEKS * WEEK_ROWS; index += 1) {
      const date = new Date(first)
      date.setDate(first.getDate() + index)
      const active = date.getTime() <= today.getTime()
      let count = 0
      if (active) {
        const seed = (index * 7919 + 31) % 100
        count = seed < 7 ? 4 : seed < 12 ? 3 : seed < 30 ? 2 : seed < 62 ? 1 : 0
      }
      days.push({ date, active, count })
    }
    return days
  }
  const days = buildDays()
  const key = (date) => {
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    return `${date.getFullYear()}-${month}-${day}`
  }
  function level(value, maximum) {
    if (value <= 0 || maximum <= 0) return 0
    return Math.min(5, Math.max(1, Math.ceil((5 * value) / maximum)))
  }
  function stackedRows(value, maximum) {
    if (value <= 0 || maximum <= 0) return 0
    return Math.min(7, Math.max(1, Math.ceil((value / maximum) * 7)))
  }
  function buildGrid(mode) {
    const weekly = []
    for (let week = 0; week < WEEKS; week += 1) {
      weekly.push(days.slice(week * 7, week * 7 + 7))
    }
    const totals = weekly.map((week) => week.reduce((sum, day) => sum + day.count, 0))
    const cells = []
    if (mode === 'daily') {
      const maximum = Math.max(...totals.map((_, index) => Math.max(...weekly[index].map((day) => day.count))))
      weekly.forEach((week) => week.forEach((day) => {
        cells.push({ day, level: level(day.count, maximum), void: !day.active, count: day.count })
      }))
      return cells
    }
    if (mode === 'weekly') {
      const maximum = Math.max(...totals)
      weekly.forEach((week, index) => {
        const value = totals[index]
        const filled = stackedRows(value, maximum)
        week.forEach((day, row) => {
          cells.push({ day, level: day.active && row >= 7 - filled ? level(value, maximum) : 0, void: !day.active, count: value })
        })
      })
      return cells
    }
    let running = 0
    const cumulative = totals.map((value) => { running += value; return running })
    const maximum = Math.max(...cumulative)
    weekly.forEach((week, index) => {
      const value = cumulative[index]
      const filled = stackedRows(value, maximum)
      week.forEach((day, row) => {
        cells.push({ day, level: day.active && row >= 7 - filled ? level(value, maximum) : 0, void: !day.active, count: value })
      })
    })
    return cells
  }
  function monthLabels() {
    const labels = []
    let lastMonth = ''
    for (let week = 0; week < WEEKS; week += 1) {
      const first = days[week * 7].date
      if (!days[week * 7].active && !days[week * 7 + 6].active) continue
      const month = first.getFullYear() + '-' + (first.getMonth() + 1)
      if (month === lastMonth) continue
      const isFirst = lastMonth === ''
      lastMonth = month
      if (isFirst) continue
      labels.push({ week, text: new Intl.DateTimeFormat('zh-CN', { month: 'short' }).format(first) })
    }
    return labels
  }
  document.querySelectorAll('[data-heat]').forEach((heat) => {
    const render = (mode) => {
      heat.innerHTML = ''
      const cells = buildGrid(mode)
      for (const cell of cells) {
        const span = document.createElement('span')
        span.dataset.level = String(cell.level)
        if (cell.void) span.dataset.void = '1'
        span.title = `${key(cell.day.date)} · ${cell.count} 条`
        heat.appendChild(span)
      }
      const months = heat.parentElement.querySelector('.months')
      if (months && months.dataset.rendered !== '1') {
        months.dataset.rendered = '1'
        months.innerHTML = ''
        for (const label of monthLabels()) {
          const span = document.createElement('span')
          span.textContent = label.text
          span.style.gridColumn = String(label.week + 1)
          months.appendChild(span)
        }
      }
    }
    const tabs = heat.closest('[data-activity]').querySelector('.tabs')
    render('daily')
    tabs.querySelectorAll('button').forEach((button) => {
      button.addEventListener('click', () => {
        tabs.querySelectorAll('button').forEach((item) => item.setAttribute('aria-selected', 'false'))
        button.setAttribute('aria-selected', 'true')
        render(button.dataset.mode)
      })
    })
  })

  // ---- filter chips / segmented controls (visual only) ----
  document.querySelectorAll('[data-group]').forEach((group) => {
    group.querySelectorAll('button').forEach((button) => {
      button.addEventListener('click', () => {
        group.querySelectorAll('button').forEach((item) => item.classList.remove('active'))
        button.classList.add('active')
      })
    })
  })
})()
