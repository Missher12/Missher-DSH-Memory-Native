    const CSS = `
    /* The panel uses the host's controls, type and surface colors. */
    :is([role="dialog"], dialog):has(.dsh-memory-root),
    :is([role="dialog"], dialog) :has(.dsh-memory-root) { scrollbar-gutter: stable; }

    .dsh-memory-root {
      --memory-text: var(--dsw-alias-label-primary);
      --memory-muted: var(--dsw-alias-label-secondary);
      --memory-line: var(--dsw-alias-border-l2, rgba(127, 127, 127, .2));
      --memory-fill: var(--dsw-alias-bg-layer-1);
      --memory-hover: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, .12));
      --memory-accent: var(--dsw-alias-state-business-primary, #2f6df6);
      --memory-danger: var(--dsw-alias-state-error-primary, #c23b30);
      --memory-focus: var(--dsw-focus-ring-color, var(--memory-accent));
      --memory-radius: 7px;
      --memory-control-height: 32px;
      --memory-control-column: minmax(112px, 46%);
      display: flex; flex-direction: column; gap: 16px;
      max-width: 760px; min-width: 0; padding-bottom: 8px;
      container-type: inline-size; color: var(--memory-text); font-size: 13px; line-height: 1.5;
    }
    .dsh-memory-page-top { display: grid; gap: 12px; min-width: 0; }
    .dsh-memory-heading { margin: 0; font-size: 22px; line-height: 30px; font-weight: 600; }
    .dsh-memory-section-title,
    .dsh-memory-settings-group-title { margin: 0; font-size: 15px; line-height: 21px; font-weight: 600; }
    .dsh-memory-section-head {
      display: flex; justify-content: space-between; align-items: baseline; gap: 8px 12px; flex-wrap: wrap;
    }
    .dsh-memory-muted, .dsh-memory-help, .dsh-memory-empty-body, .dsh-memory-list-total {
      margin: 0; color: var(--memory-muted); font-size: 12px; overflow-wrap: anywhere;
    }
    .dsh-memory-help { line-height: 1.45; }
    .dsh-memory-notice, .dsh-memory-library-notice, .dsh-memory-settings-notice {
      margin: 0; color: var(--memory-muted); font-size: 12px; overflow-wrap: anywhere;
    }
    .dsh-memory-error, .dsh-memory-error-text, .dsh-memory-field-error {
      margin: 0; color: var(--memory-danger); font-size: 12px; overflow-wrap: anywhere;
    }
    .dsh-memory-error-title, .dsh-memory-empty-title { margin: 0; font-size: 14px; font-weight: 600; }
    .dsh-memory-error-card { display: grid; gap: 8px; padding-block: 12px; border-top: 1px solid var(--memory-line); }
    .dsh-memory-detail { color: var(--memory-muted); font-size: 12px; overflow-wrap: anywhere; }
    .dsh-memory-empty { display: grid; gap: 6px; padding: 16px 0; border-top: 1px solid var(--memory-line); }

    .dsh-memory-navigation { display: grid; gap: 8px; min-width: 0; }
    .dsh-memory-view-tabs, .dsh-memory-subnav { display: flex; flex-wrap: wrap; align-items: stretch; min-width: 0; }
    .dsh-memory-view-tabs { gap: 4px 20px; border-bottom: 1px solid var(--memory-line); }
    .dsh-memory-subnav { gap: 4px; }
    .dsh-memory-view-tab, .dsh-memory-kind-tab, .dsh-memory-tabs button {
      min-height: var(--memory-control-height); border: 0; background: transparent; color: var(--memory-muted);
      padding: 4px 9px; border-radius: 6px; font: inherit; cursor: pointer;
    }
    .dsh-memory-view-tabs .dsh-memory-view-tab { min-height: 36px; padding: 4px 1px 7px; border-radius: 0; font-weight: 500; }
    .dsh-memory-view-tabs .dsh-memory-view-tab[data-active="true"] {
      box-shadow: inset 0 -2px var(--memory-text); color: var(--memory-text);
    }
    .dsh-memory-subnav .dsh-memory-view-tab[data-active="true"],
    .dsh-memory-kind-tab[data-active="true"],
    .dsh-memory-tabs button[aria-selected="true"] {
      background: var(--memory-hover); color: var(--memory-text); font-weight: 600;
    }
    .dsh-memory-view-tab:hover, .dsh-memory-kind-tab:hover, .dsh-memory-tabs button:hover { color: var(--memory-text); }

    /* Controls and anchored menus */
    .dsh-memory-button, .dsh-memory-input, .dsh-memory-select,
    .dsh-memory-settings-input, .dsh-memory-textarea, .dsh-memory-number {
      box-sizing: border-box; border: 1px solid var(--memory-line); border-radius: var(--memory-radius);
      background: var(--memory-fill); color: var(--memory-text); font: inherit; font-size: 12px;
    }
    .dsh-memory-button {
      min-height: var(--memory-control-height); max-width: 100%; padding: 4px 10px; line-height: 1.35;
      text-align: center; cursor: pointer; overflow-wrap: anywhere;
    }
    .dsh-memory-button:hover:not(:disabled) { background: var(--memory-hover); }
    .dsh-memory-button:disabled, .dsh-memory-select:disabled { opacity: .55; cursor: default; }
    .dsh-memory-button-primary, .dsh-memory-button[data-primary="true"] {
      border-color: transparent; background: var(--memory-text);
      color: var(--dsw-alias-label-primary-inverted, var(--memory-fill));
    }
    .dsh-memory-button-primary:hover:not(:disabled), .dsh-memory-button[data-primary="true"]:hover:not(:disabled) {
      background: color-mix(in srgb, var(--memory-text) 86%, var(--memory-fill));
    }
    .dsh-memory-button[data-danger="true"] { color: var(--memory-danger); }
    .dsh-memory-button[data-danger="true"]:hover:not(:disabled),
    .dsh-memory-button[data-confirming="true"] { background: color-mix(in srgb, var(--memory-danger) 10%, transparent); }
    .dsh-memory-root :is(button, input, textarea, summary, a):focus-visible {
      outline: 2px solid var(--memory-focus); outline-offset: 2px;
    }
    .dsh-memory-input, .dsh-memory-select, .dsh-memory-settings-input {
      min-width: 0; max-width: 100%; height: var(--memory-control-height); padding: 0 20px; text-align: center;
    }
    .dsh-memory-input::placeholder, .dsh-memory-settings-input::placeholder { color: var(--memory-muted); }
    .dsh-memory-input[type="search"] { position: relative; padding-inline: 24px; }
    .dsh-memory-input[type="search"]::-webkit-search-cancel-button { position: absolute; right: 8px; margin: 0; }
    .dsh-memory-textarea { width: 100%; min-height: 104px; resize: vertical; padding: 9px 12px; text-align: start; }
    .dsh-memory-input[aria-invalid="true"], .dsh-memory-settings-input[aria-invalid="true"],
    .dsh-memory-number:has([aria-invalid="true"]) { border-color: var(--memory-danger); }
    button.dsh-memory-select { position: relative; display: inline-flex; justify-content: center; align-items: center; cursor: pointer; }
    .dsh-memory-select-value { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .dsh-memory-select-arrow { position: absolute; right: 7px; width: 12px; height: 12px; pointer-events: none; }
    .dsh-memory-select-menu, .dsh-memory-palette-menu {
      box-sizing: border-box; padding: 4px; border: 1px solid var(--memory-line); border-radius: 8px;
      background: var(--dsw-alias-bg-overlay, var(--memory-fill)); color: var(--memory-text);
      box-shadow: var(--dsw-elevation-soft, 0 4px 16px #0002);
    }
    .dsh-memory-select-menu {
      position: fixed; inset: auto; margin: 0; font: inherit; font-size: 12px;
      overflow: auto; overscroll-behavior: contain; scrollbar-gutter: stable;
    }
    .dsh-memory-select-option, .dsh-memory-palette-option {
      display: flex; align-items: center; gap: 8px; padding: 7px 8px; border-radius: 5px;
      overflow-wrap: anywhere; cursor: pointer;
    }
    .dsh-memory-select-option[data-active="true"], .dsh-memory-palette-option:hover,
    .dsh-memory-palette-option[aria-selected="true"] { background: var(--memory-hover); }
    .dsh-memory-select-option[aria-disabled="true"] { opacity: .5; cursor: default; }
    .dsh-memory-select-mark { width: 12px; flex: none; }
    .dsh-memory-field, .dsh-memory-settings-row {
      display: grid; grid-template-columns: minmax(0, 1fr) var(--memory-control-column);
      align-items: center; gap: 4px 14px; min-width: 0;
    }
    .dsh-memory-field > :is(.dsh-memory-select, .dsh-memory-input, .dsh-memory-textarea) { width: 100%; }
    .dsh-memory-field-copy { display: grid; gap: 2px; min-width: 0; }
    .dsh-memory-field-label, .dsh-memory-settings-label { font-size: 13px; overflow-wrap: anywhere; }
    .dsh-memory-field-wide { grid-template-columns: minmax(0, 1fr); gap: 6px; }
    .dsh-memory-disclosure > summary, .dsh-memory-sync-conflict > summary, .dsh-memory-brief-sources > summary {
      list-style: none; cursor: pointer;
    }
    .dsh-memory-disclosure > summary::-webkit-details-marker,
    .dsh-memory-sync-conflict > summary::-webkit-details-marker,
    .dsh-memory-brief-sources > summary::-webkit-details-marker { display: none; }
    .dsh-memory-disclosure-head {
      display: flex; align-items: center; justify-content: space-between; gap: 10px; min-height: 36px;
    }
    .dsh-memory-disclosure-head::after, .dsh-memory-brief-sources > summary::before, .dsh-memory-sync-conflict > summary::before {
      content: ""; display: inline-block; flex: none; width: 6px; height: 6px; border: solid currentColor;
      border-width: 0 1px 1px 0; transform: rotate(-45deg); color: var(--memory-muted);
    }
    .dsh-memory-disclosure[open] > summary::after,
    :is(.dsh-memory-brief-sources, .dsh-memory-sync-conflict)[open] > summary::before { transform: rotate(45deg); }
    .dsh-memory-disclosure-head::after { margin-inline-end: 2px; }
    .dsh-memory-disclosure-head:hover { color: var(--memory-text); }

    /* Activity overview */
    .dsh-memory-activity-view { display: grid; gap: 18px; min-width: 0; }
    .dsh-memory-context-usage { display: grid; gap: 6px; min-width: 0; }
    .dsh-memory-context-usage-head, .dsh-memory-activity-head, .dsh-memory-trend-head {
      display: flex; align-items: baseline; justify-content: space-between; gap: 6px 12px; flex-wrap: wrap;
    }
    .dsh-memory-context-usage-amount, .dsh-memory-trend-total {
      color: var(--memory-muted); font-size: 12px; font-variant-numeric: tabular-nums;
    }
    .dsh-memory-context-usage-track { height: 5px; border-radius: 3px; overflow: hidden; background: var(--memory-line); }
    .dsh-memory-context-usage-track > span { display: block; height: 100%; border-radius: inherit; background: var(--memory-accent); }
    .dsh-memory-activity-totals {
      display: grid; grid-auto-flow: column; grid-auto-columns: minmax(0, 1fr); gap: 8px;
      margin: 0; padding: 10px 0; border-block: 1px solid var(--memory-line);
    }
    .dsh-memory-activity-totals dt { color: var(--memory-muted); font-size: 12px; overflow-wrap: anywhere; }
    .dsh-memory-activity-totals dd { margin: 0; font-size: 21px; font-weight: 600; font-variant-numeric: tabular-nums; }
    .dsh-memory-trends-section > summary { min-height: 28px; }
    .dsh-memory-trends-body { display: grid; gap: 16px; padding-top: 8px; min-width: 0; }
    .dsh-memory-activity { min-width: 0; }
    .dsh-memory-activity-title, .dsh-memory-tabs, .dsh-memory-palette { display: flex; align-items: center; gap: 5px; }
    .dsh-memory-activity-title { min-width: 0; }
    .dsh-memory-activity-title h3, .dsh-memory-trend-title { margin: 0; font-size: 13px; font-weight: 600; }
    .dsh-memory-tabs { gap: 2px; }
    .dsh-memory-tabs button, .dsh-memory-palette-trigger {
      min-height: 28px; padding: 3px 7px; font-size: 12px; line-height: 18px; white-space: nowrap;
    }
    .dsh-memory-palette { position: relative; }
    .dsh-memory-palette-trigger {
      display: flex; align-items: center; gap: 4px; border: 0; border-radius: 6px; background: transparent;
      font-family: inherit; color: var(--memory-muted); cursor: pointer;
    }
    .dsh-memory-palette-trigger:hover, .dsh-memory-palette-trigger[aria-expanded="true"] { background: var(--memory-hover); }
    .dsh-memory-palette-swatch { display: flex; gap: 2px; align-items: center; }
    .dsh-memory-palette-swatch i { width: 3px; height: 11px; border-radius: 2px; background: var(--dsh-memory-swatch); }
    .dsh-memory-palette-swatch i:first-child { opacity: .35; }
    .dsh-memory-palette-swatch i:nth-child(2) { opacity: .65; }
    .dsh-memory-palette-menu {
      position: absolute; top: calc(100% + 4px); left: 0; z-index: 10; width: 168px;
      max-height: min(240px, 50vh); overflow: auto;
    }
    .dsh-memory-palette-option {
      width: 100%; border: 0; background: transparent; color: inherit; font: inherit; font-size: 12px; text-align: start;
    }
    .dsh-memory-palette-dot, .dsh-memory-palette-theme { width: 12px; height: 12px; border-radius: 3px; }
    .dsh-memory-color-input { width: 18px; height: 18px; padding: 0; border: 0; background: transparent; }
    .dsh-memory-heatmap-stage { position: relative; margin-top: 8px; min-width: 0; }
    .dsh-memory-heatmap, .dsh-memory-heat-months {
      display: grid; grid-template-columns: repeat(53, minmax(0, 1fr)); gap: 3px;
    }
    .dsh-memory-heatmap { grid-template-rows: repeat(7, minmax(0, 1fr)); grid-auto-flow: column; }
    .dsh-memory-heat-cell {
      width: 100%; min-width: 0; aspect-ratio: 1; border-radius: 2px;
      background: var(--dsw-alias-bg-skeleton, var(--memory-hover));
    }
    .dsh-memory-heat-cell[data-future="true"] { opacity: .35; }
    .dsh-memory-heat-cell[data-level="1"] { background: color-mix(in srgb, var(--dsh-memory-particle-color) 26%, var(--memory-fill)); }
    .dsh-memory-heat-cell[data-level="2"] { background: color-mix(in srgb, var(--dsh-memory-particle-color) 42%, var(--memory-fill)); }
    .dsh-memory-heat-cell[data-level="3"] { background: color-mix(in srgb, var(--dsh-memory-particle-color) 59%, var(--memory-fill)); }
    .dsh-memory-heat-cell[data-level="4"] { background: color-mix(in srgb, var(--dsh-memory-particle-color) 76%, var(--memory-fill)); }
    .dsh-memory-heat-cell[data-level="5"] { background: var(--dsh-memory-particle-color); }
    .dsh-memory-heat-months { margin-top: 6px; color: var(--memory-muted); font-size: 10px; line-height: 16px; }
    .dsh-memory-heat-months > span { white-space: nowrap; }
    .dsh-memory-heat-months > span:last-child { justify-self: end; }
    .dsh-memory-heat-tooltip {
      position: absolute; z-index: 5; transform: translateX(-50%); max-width: min(240px, calc(100% - 16px));
      padding: 4px 8px; border: 1px solid var(--memory-line); border-radius: 6px;
      background: var(--dsw-alias-bg-overlay, var(--memory-fill)); color: var(--memory-text);
      box-shadow: 0 4px 16px #0002; font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; pointer-events: none;
    }
    .dsh-memory-trend { display: grid; gap: 6px; min-width: 0; }
    .dsh-memory-trend-chart {
      display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 6px; height: 82px; min-width: 0;
    }
    .dsh-memory-trend-col { display: flex; flex-direction: column; align-items: center; gap: 4px; min-width: 0; }
    .dsh-memory-trend-bars {
      display: flex; flex: 1; align-items: flex-end; justify-content: center; gap: 3px; width: 100%;
      min-height: 0; border-bottom: 1px solid var(--memory-line);
    }
    .dsh-memory-trend-bar { flex: 1; max-width: 12px; border-radius: 3px 3px 0 0; background: var(--memory-accent); }
    .dsh-memory-trend-bar[data-kind="extract"], .dsh-memory-trend-legend i[data-kind="extract"] { opacity: .48; }
    .dsh-memory-trend-date { color: var(--memory-muted); font-size: 10px; font-variant-numeric: tabular-nums; white-space: nowrap; }
    .dsh-memory-trend-empty, .dsh-memory-trend-note { margin: 0; color: var(--memory-muted); font-size: 11px; }
    .dsh-memory-trend-legend, .dsh-memory-trend-facts {
      display: flex; flex-wrap: wrap; align-items: center; gap: 4px 14px;
      color: var(--memory-muted); font-size: 11px; font-variant-numeric: tabular-nums;
    }
    .dsh-memory-trend-legend span { display: flex; align-items: center; gap: 4px; }
    .dsh-memory-trend-legend i { width: 7px; height: 7px; border-radius: 2px; background: var(--memory-accent); }
    .dsh-memory-trend-legend em { color: var(--dsw-alias-state-warn-primary, var(--memory-text)); font-style: normal; }
    .dsh-memory-trend-facts { padding-top: 8px; border-top: 1px solid var(--memory-line); }
    .dsh-memory-activity-operations { display: grid; }
    .dsh-memory-activity-operations > h3 { margin-bottom: 8px; }
    .dsh-memory-activity-line {
      display: flex; align-items: center; gap: 6px 10px; min-height: 40px; box-sizing: border-box;
      padding: 4px 0; border-top: 1px solid var(--memory-line); overflow-wrap: anywhere;
    }
    .dsh-memory-activity-label { margin-right: auto; font-weight: 500; min-width: 0; }
    .dsh-memory-activity-line .dsh-memory-muted, .dsh-memory-activity-warning { text-align: right; }
    .dsh-memory-activity-warning { color: var(--dsw-alias-state-warn-primary, var(--memory-text)); font-size: 12px; }
    .dsh-memory-activity-details { display: grid; gap: 8px; padding-bottom: 12px; min-width: 0; overflow-wrap: anywhere; }
    .dsh-memory-activity-details ul, .dsh-memory-activity-issues { margin: 0; padding-left: 20px; }
    .dsh-memory-activity-issues { margin-bottom: 8px; font-size: 12px; color: var(--memory-muted); overflow-wrap: anywhere; }
    .dsh-memory-extraction-status .dsh-memory-activity-line { flex-wrap: wrap; }
    .dsh-memory-extraction-status > p { margin-bottom: 6px; }
    .dsh-memory-detail-actions {
      display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px;
    }
    .dsh-memory-activity-details progress { max-width: 100%; accent-color: var(--memory-accent); }

    /* Memory records */
    .dsh-memory-toolbar { display: grid; gap: 6px; min-width: 0; }
    .dsh-memory-search-row, .dsh-memory-brief-tools {
      display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 8px;
    }
    .dsh-memory-search-row input { width: 100%; }
    .dsh-memory-scope {
      display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px 16px;
    }
    .dsh-memory-scope .dsh-memory-field { grid-template-columns: auto minmax(0, 1fr); }
    .dsh-memory-filter-details > summary { min-height: 30px; padding-inline: 1px; color: var(--memory-muted); }
    .dsh-memory-filter-details .dsh-memory-field { padding: 4px 0; }
    .dsh-memory-filter-actions { display: flex; justify-content: flex-end; padding-top: 4px; }
    .dsh-memory-list-head {
      display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 6px 8px; min-width: 0;
    }
    .dsh-memory-kind-tabs { display: flex; gap: 2px; flex-wrap: wrap; }
    .dsh-memory-kind-tab { min-height: 28px; padding: 4px 7px; font-size: 12px; }
    .dsh-memory-kind-count { margin-left: 4px; font-size: 11px; font-variant-numeric: tabular-nums; opacity: .78; }
    .dsh-memory-list, .dsh-memory-history, .dsh-memory-profile-list {
      display: grid; margin: 0; padding: 0; list-style: none;
    }
    .dsh-memory-row {
      display: grid; gap: 6px; min-width: 0; padding: 11px 0; border-top: 1px solid var(--memory-line);
    }
    .dsh-memory-row[data-selected="true"] { background: color-mix(in srgb, var(--memory-accent) 5%, transparent); }
    .dsh-memory-row-head, .dsh-memory-history-head { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 8px; min-width: 0; }
    .dsh-memory-row-select { display: inline-flex; align-items: center; cursor: pointer; }
    .dsh-memory-select-box { width: 14px; height: 14px; margin: 0; flex: none; accent-color: var(--memory-accent); cursor: pointer; }
    .dsh-memory-kind { font-weight: 600; }
    .dsh-memory-status-pill, .dsh-memory-pin { color: var(--memory-muted); font-size: 11px; white-space: nowrap; }
    .dsh-memory-status-pill[data-status="active"]::before, .dsh-memory-status-pill[data-status="candidate"]::before {
      content: ""; display: inline-block; width: 5px; height: 5px; margin-right: 4px; border-radius: 50%;
      background: var(--dsw-alias-state-success-primary, var(--memory-muted)); vertical-align: 2px;
    }
    .dsh-memory-status-pill[data-status="candidate"]::before { background: var(--dsw-alias-state-warn-primary, var(--memory-muted)); }
    .dsh-memory-row-meta {
      display: flex; flex-wrap: wrap; gap: 2px 8px; margin-left: auto;
      color: var(--memory-muted); font-size: 11px; font-variant-numeric: tabular-nums;
    }
    .dsh-memory-row-meta > span + span::before { content: "·"; margin-right: 8px; }
    .dsh-memory-content, .dsh-memory-row-foot { margin: 0 0 0 22px; min-width: 0; }
    .dsh-memory-content { white-space: pre-wrap; font-size: 14px; line-height: 1.6; overflow-wrap: anywhere; }
    .dsh-memory-row-foot, .dsh-memory-tags, .dsh-memory-row-actions, .dsh-memory-bulk-actions {
      display: flex; align-items: center; flex-wrap: wrap; gap: 4px;
    }
    .dsh-memory-tags { margin: 0; padding: 0; list-style: none; min-width: 0; }
    .dsh-memory-tag {
      max-width: 100%; padding: 1px 6px; border-radius: 4px; background: var(--memory-hover);
      color: var(--memory-muted); font-size: 11px; overflow-wrap: anywhere;
    }
    .dsh-memory-row-actions { margin-left: auto; }
    .dsh-memory-row-danger { display: flex; padding-left: 4px; border-left: 1px solid var(--memory-line); }
    .dsh-memory-row-foot .dsh-memory-button {
      min-height: 28px; padding: 3px 6px; border: 0; border-radius: 5px; background: transparent;
    }
    .dsh-memory-row-foot .dsh-memory-button-primary { color: var(--memory-text); font-weight: 600; }
    .dsh-memory-row-foot .dsh-memory-button[data-danger="true"][data-confirming="true"] {
      background: color-mix(in srgb, var(--memory-danger) 10%, transparent);
    }
    .dsh-memory-bulk {
      display: grid; gap: 7px; padding: 9px 0; border-block: 1px solid var(--memory-line);
      color: var(--memory-muted); font-size: 12px;
    }
    .dsh-memory-danger-actions {
      display: flex; justify-content: flex-end; flex-basis: 100%; padding-top: 7px; border-top: 1px solid var(--memory-line);
    }
    .dsh-memory-pager, .dsh-memory-pager-actions, .dsh-memory-page-size {
      display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
    }
    .dsh-memory-pager {
      justify-content: space-between; padding-top: 10px; border-top: 1px solid var(--memory-line);
      color: var(--memory-muted); font-size: 12px;
    }

    /* Preferences, notes and project archive */
    .dsh-memory-brief, .dsh-memory-brief-section, .dsh-memory-profile, .dsh-memory-library {
      display: grid; gap: 8px; min-width: 0;
    }
    .dsh-memory-brief { gap: 18px; }
    .dsh-memory-brief-tools .dsh-memory-field { grid-template-columns: auto minmax(0, 1fr); }
    .dsh-memory-history-item, .dsh-memory-profile-item { padding: 9px 0; border-top: 1px solid var(--memory-line); min-width: 0; }
    .dsh-memory-history-content { margin: 0; color: var(--memory-text); font-size: 13px; white-space: pre-wrap; overflow-wrap: anywhere; }
    .dsh-memory-history-foot, .dsh-memory-brief-meta {
      display: flex; align-items: center; flex-wrap: wrap; gap: 4px 10px; min-width: 0;
    }
    .dsh-memory-history-foot { justify-content: space-between; }
    .dsh-memory-history-foot .dsh-memory-row-meta { margin-left: 0; }
    .dsh-memory-brief-meta { margin: 3px 0 0; color: var(--memory-muted); font-size: 12px; overflow-wrap: anywhere; }
    .dsh-memory-brief-sources { margin-top: 4px; min-width: 0; color: var(--memory-muted); font-size: 12px; overflow-wrap: anywhere; }
    .dsh-memory-brief-sources > summary, .dsh-memory-sync-conflict > summary {
      padding: 5px 0; min-width: 0; overflow-wrap: anywhere;
    }
    .dsh-memory-brief-sources > summary::before, .dsh-memory-sync-conflict > summary::before { margin: 0 8px 2px 1px; }
    .dsh-memory-brief-entry { margin-top: 3px; }
    .dsh-memory-brief-entry > summary {
      display: flex; padding: 0; justify-content: space-between; gap: 4px 12px; flex-wrap: wrap;
    }
    .dsh-memory-brief-entry > summary::before { content: none; }
    .dsh-memory-brief-entry .dsh-memory-brief-meta { margin-top: 0; }
    .dsh-memory-brief-toggle { margin-left: auto; }
    .dsh-memory-brief-toggle::after {
      content: ""; display: inline-block; width: 5px; height: 5px; margin: 0 2px 2px 6px;
      border: solid currentColor; border-width: 0 1px 1px 0; transform: rotate(-45deg);
    }
    .dsh-memory-brief-entry[open] .dsh-memory-brief-toggle::after { transform: rotate(45deg); }
    .dsh-memory-brief-sources blockquote {
      margin: 6px 0; padding: 3px 9px; border-left: 2px solid var(--memory-line); white-space: pre-wrap; overflow-wrap: anywhere;
    }
    .dsh-memory-profile-line { display: grid; gap: 2px; min-width: 0; overflow-wrap: anywhere; }
    .dsh-memory-profile-statement { font-size: 14px; line-height: 1.55; }
    .dsh-memory-profile-meta { color: var(--memory-muted); font-size: 11px; font-variant-numeric: tabular-nums; }
    .dsh-memory-profile-evidence {
      display: grid; gap: 5px; margin: 7px 0 2px; padding-left: 14px; border-left: 2px solid var(--memory-line);
      list-style: none; color: var(--memory-muted); font-size: 12px; white-space: pre-wrap; overflow-wrap: anywhere;
    }
    .dsh-memory-library-open {
      display: flex; align-items: center; justify-content: space-between; gap: 10px; width: 100%; min-width: 0;
      padding: 3px 0; border: 0; background: transparent; color: inherit; font: inherit; text-align: start; cursor: pointer;
    }
    .dsh-memory-library-open:hover .dsh-memory-library-edit { color: var(--memory-text); }
    .dsh-memory-library-description { display: grid; gap: 2px; min-width: 0; overflow-wrap: anywhere; }
    .dsh-memory-library-description strong { font-size: 14px; font-weight: 500; }
    .dsh-memory-library-edit, .dsh-memory-library-file { color: var(--memory-muted); font-size: 12px; }
    .dsh-memory-library-edit { flex: none; }
    .dsh-memory-library-file { margin: 0; overflow-wrap: anywhere; }

    /* Settings rows share a label column and a single right edge. */
    .dsh-memory-settings { display: grid; gap: 22px; min-width: 0; }
    .dsh-memory-settings-group { min-width: 0; }
    .dsh-memory-settings-group-title { margin-bottom: 7px; }
    .dsh-memory-settings-row { min-height: 34px; padding: 8px 0; border-top: 1px solid var(--memory-line); }
    .dsh-memory-settings-copy { display: grid; gap: 2px; min-width: 0; }
    .dsh-memory-settings-control, .dsh-memory-settings-buttons {
      display: flex; flex-wrap: wrap; justify-content: flex-end; align-items: center; gap: 6px; min-width: 0;
    }
    .dsh-memory-settings-control .dsh-memory-muted { text-align: right; }
    .dsh-memory-settings-input { width: 100%; }
    .dsh-memory-settings-input:not(:focus) { text-overflow: ellipsis; }
    .dsh-memory-switch {
      position: relative; flex: none; width: 38px; height: 22px; padding: 0; border: 1px solid var(--memory-line);
      border-radius: 12px; background: var(--memory-hover); cursor: pointer;
    }
    .dsh-memory-switch[aria-checked="true"] { border-color: transparent; background: var(--memory-text); }
    .dsh-memory-switch-knob {
      position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%;
      background: var(--memory-fill); box-shadow: 0 1px 2px #0004;
    }
    .dsh-memory-switch[aria-checked="true"] .dsh-memory-switch-knob { transform: translateX(16px); }
    .dsh-memory-number { position: relative; width: min(100%, 164px); height: var(--memory-control-height); }
    .dsh-memory-number:focus-within { outline: 2px solid var(--memory-focus); outline-offset: 2px; }
    .dsh-memory-number input {
      box-sizing: border-box; width: 100%; height: 100%; padding: 0 36px; border: 0; background: transparent;
      color: inherit; font: inherit; text-align: center; font-variant-numeric: tabular-nums; appearance: textfield;
    }
    .dsh-memory-root .dsh-memory-number input:focus-visible { outline: none; }
    .dsh-memory-number input::-webkit-inner-spin-button, .dsh-memory-number input::-webkit-outer-spin-button { appearance: none; margin: 0; }
    .dsh-memory-number span {
      position: absolute; right: 7px; top: 50%; transform: translateY(-50%);
      color: var(--memory-muted); font-size: 10px; pointer-events: none;
    }
    .dsh-memory-settings-foot {
      display: flex; justify-content: flex-end; align-items: center; flex-wrap: wrap; gap: 8px 14px;
      padding-top: 12px; border-top: 1px solid var(--memory-line);
    }
    .dsh-memory-settings-state { margin-right: auto; color: var(--memory-muted); font-size: 12px; }
    .dsh-memory-settings-group > .dsh-memory-settings-notice { padding: 2px 0 8px; }
    .dsh-memory-settings-foot > .dsh-memory-settings-notice { margin-right: auto; flex: 1 1 152px; }
    .dsh-memory-file-input { display: none; }
    .dsh-memory-manual-sync, .dsh-memory-sync-conflict { border-top: 1px solid var(--memory-line); }
    .dsh-memory-sync-conflict { padding-block: 4px; }
    .dsh-memory-sync-conflict > pre {
      margin: 4px 0 9px; padding: 8px; border-left: 2px solid var(--memory-line);
      white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12px;
    }

    /* Modal editors use the browser top layer and one scroll container. */
    .dsh-memory-modal {
      position: fixed; box-sizing: border-box; width: min(520px, calc(100vw - 32px)); max-width: none;
      max-height: calc(100dvh - 32px); margin: auto; overflow-y: auto; overscroll-behavior: contain;
      padding: 18px; border: 1px solid var(--memory-line); border-radius: 12px;
      background: var(--dsw-alias-bg-overlay, var(--memory-fill)); color: var(--memory-text);
      box-shadow: var(--dsw-elevation-soft, 0 8px 30px #0003);
    }
    .dsh-memory-modal[open] { display: grid; gap: 10px; }
    .dsh-memory-modal::backdrop { background: #0005; }
    .dsh-memory-modal-title { margin: 0; font-size: 17px; font-weight: 600; line-height: 24px; }
    .dsh-memory-form { display: grid; gap: 9px; min-width: 0; }
    .dsh-memory-modal-actions {
      display: flex; justify-content: flex-end; flex-wrap: wrap; gap: 7px;
      padding-top: 10px; border-top: 1px solid var(--memory-line);
    }
    .dsh-memory-check { display: inline-flex; align-items: center; justify-content: space-between; gap: 8px; }
    .dsh-memory-check input { order: 1; accent-color: var(--memory-accent); }
    .dsh-memory-library-body { min-height: 155px; font-family: var(--dsw-font-mono, ui-monospace, monospace); line-height: 1.55; }
    .dsh-memory-library-conflict { margin: 0; color: var(--dsw-alias-state-warn-primary, var(--memory-text)); font-size: 12px; }
    .dsh-memory-diff { display: grid; margin: 4px 0; gap: 2px; font-size: 12px; overflow-wrap: anywhere; }
    .dsh-memory-diff-del { color: var(--memory-danger); }
    .dsh-memory-diff-add { color: var(--dsw-alias-state-success-primary, var(--memory-text)); }

    @container (max-width: 430px) {
      .dsh-memory-view-tabs { gap: 2px 14px; }
      .dsh-memory-row .dsh-memory-row-meta { flex-basis: 100%; margin-left: 22px; }
      .dsh-memory-row-foot > .dsh-memory-tags { flex-basis: 100%; }
      .dsh-memory-row-actions { margin-left: 0; }
      .dsh-memory-activity-totals dd { font-size: 18px; }
      .dsh-memory-heatmap, .dsh-memory-heat-months { gap: 2px; }
      .dsh-memory-heat-months { font-size: 9px; }
      .dsh-memory-settings-row { gap: 4px 9px; }
    }

    @container (max-width: 350px) {
      .dsh-memory-scope { grid-template-columns: minmax(0, 1fr); }
      .dsh-memory-scope .dsh-memory-field { grid-template-columns: minmax(0, 1fr) var(--memory-control-column); }
    }

    @container (max-width: 300px) {
      .dsh-memory-view-tabs { gap: 2px 10px; }
      .dsh-memory-heat-months > span:nth-child(even):not(:last-child) { visibility: hidden; }
      .dsh-memory-trend-chart { gap: 3px; }
    }
`
