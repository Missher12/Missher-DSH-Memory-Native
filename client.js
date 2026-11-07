/**
 * Browser half of @missher/dsh-memory.
 *
 * One Settings → Memory section over the Host panel RPC. The bundle is
 * self-contained: React comes from the page module table, dictionaries are
 * inlined (mirroring locale/en.json and locale/zh.json), and storage logic
 * stays on the Host — the panel only lists, searches, edits and deletes
 * records through `dshMemory` Remote methods.
 *
 * Transport selection: when the Host fell back to its web-server handler it
 * injects `globalThis.__DSH_MEMORY__ = { transport: 'web-server', path }`; the
 * panel then speaks plain JSON POST to that random path and never mounts the
 * descriptors. Otherwise it mounts the hand-authored descriptors through
 * `remote.$mount` and calls `remote.dshMemory`.
 */
window.__ModuleLoader__.load({
  id: '@missher/dsh-memory',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const PACKAGE = '@missher/dsh-memory'
    const NAMESPACE = 'dshMemory'
    const SERVICE_KEY = 'remote.' + NAMESPACE
    const NS = 'dsh-memory'
    const METHODS = ['list', 'stats', 'activity', 'profile', 'update', 'removeMemory', 'rebuildIndex', 'updateSettings', 'exportData', 'importData', 'backup', 'restoreMemory', 'purgeMemory', 'history', 'restoreRevision', 'bulkAction', 'topicSuggestions', 'mergeTopics', 'obsidianExport', 'obsidianImport', 'obsidianStatus', 'obsidianSync', 'obsidianResolve', 'knowledgeGraph', 'knowledgePromote', 'knowledgeList', 'knowledgeNote', 'knowledgeSave', 'knowledgeSync', 'captureStatus', 'captureRetry', 'projectBrief']
    const RESULT_TYPES = {
      list: 'MemoryList',
      stats: 'MemoryStats',
      activity: 'MemoryActivity',
      profile: 'MemoryProfile',
      update: 'MemoryUpdateResult',
      removeMemory: 'MemoryRemoveResult',
      rebuildIndex: 'MemoryRebuildResult',
      updateSettings: 'MemorySettingsResult',
      exportData: 'MemoryExport',
      importData: 'MemoryImportResult',
      backup: 'MemoryBackupResult',
      restoreMemory: 'MemoryUpdateResult',
      purgeMemory: 'MemoryPurgeResult',
      history: 'MemoryHistoryResult',
      restoreRevision: 'MemoryUpdateResult',
      bulkAction: 'MemoryBulkResult',
      topicSuggestions: 'MemoryTopicSuggestions',
      mergeTopics: 'MemoryTopicMerge',
      obsidianExport: 'MemoryObsidianExport',
      obsidianImport: 'MemoryObsidianImport',
      obsidianStatus: 'MemoryObsidianStatus',
      obsidianSync: 'MemoryObsidianSync',
      obsidianResolve: 'MemoryObsidianResolve',
      knowledgeGraph: 'MemoryKnowledgeGraph',
      knowledgePromote: 'MemoryKnowledgePromote',
      knowledgeList: 'MemoryKnowledgeList',
      knowledgeNote: 'MemoryKnowledgeNote',
      knowledgeSave: 'MemoryKnowledgeSave',
      knowledgeSync: 'MemoryKnowledgeSync',
      captureStatus: 'MemoryCaptureStatus',
      captureRetry: 'MemoryCaptureRetry',
      projectBrief: 'MemoryProjectBrief',
    }
    const KINDS = ['preference', 'fact', 'decision', 'episode']
    const STATUSES = ['active', 'candidate', 'archived', 'superseded', 'deleted']
    const EDITABLE_STATUSES = ['active', 'candidate', 'archived']
    const BOOT_GLOBAL = '__DSH_MEMORY__'

    const DICTIONARIES = {
      en: {
        nav: 'Memory',
        'panel.title': 'Long-term memory',
        'panel.intro': 'Memories your assistant captured, ready to review, edit or remove.',
        'stats.active': 'Active',
        'stats.candidate': 'Candidates',
        'stats.total': 'Total',
        'stats.projects': 'Projects',
        'activity.activeDays': 'Active days',
        'activity.avgConfidence': 'Avg confidence',
        'activity.blueColor': 'Lake blue',
        'activity.cell': '{date} · {count} memories',
        'activity.colorMenu': 'Colour',
        'activity.cumulativeTooltip': 'Through {end}: {count} memories',
        'activity.customColor': 'Custom colour…',
        'activity.amberColor': 'Warm gold',
        'activity.last7': 'Last 7 days',
        'activity.less': 'Less',
        'activity.mode.cumulative': 'Cumulative',
        'activity.mode.daily': 'Daily',
        'activity.mode.weekly': 'Weekly',
        'activity.more': 'More',
        'activity.roseColor': 'Dusty rose',
        'activity.sparseHint': 'The heatmap fills in as memories accumulate.',
        'activity.streak': 'Current streak',
        'activity.summary': '{total} memories · {days} active days',
        'activity.tealColor': 'Teal',
        'activity.themeColor': 'Follow theme',
        'activity.title': 'Memory activity',
        'activity.violetColor': 'Dusk violet',
        'activity.weeklyTooltip': 'Week of {start} – {end}: {count} memories',
        'capture.label': 'Capture',
        'inject.label': 'Injection',
        'flag.on': 'On',
        'flag.off': 'Off',
        'filter.scope': 'Scope',
        'filter.scope.project': 'Current project',
        'filter.scope.global': 'Global',
        'filter.status': 'Status',
        'filter.topic': 'Topic',
        'filter.topic.all': 'All topics',
        'filter.topic.none': 'No topic',
        'filter.status.all': 'All statuses',
        'filter.kind': 'Kind',
        'filter.kind.all': 'All kinds',
        'filter.search': 'Search',
        'filter.searchPlaceholder': 'Search content or tags',
        'kind.preference': 'Preference',
        'kind.fact': 'Fact',
        'kind.decision': 'Decision',
        'kind.episode': 'Episode',
        'kind.knowledge': 'Knowledge note',
        'kind.vault': 'Vault note',
        'status.active': 'Active',
        'status.candidate': 'Candidate',
        'status.archived': 'Archived',
        'status.superseded': 'Superseded',
        'status.deleted': 'Deleted',
        'row.confidence': 'Confidence {value}',
        'row.updated': 'Updated {value}',
        'row.pinned': 'Pinned',
        'count.showing': 'Showing {shown} of {total}',
        'view.memory': "Records",
        'view.library': "Notes",
        'view.settings': 'Settings',
        'view.capture': "Capture & recall",
        'view.retention': "Retention",
        'view.data': "Backup & transfer",
        'view.obsidian': "Obsidian sync",
        'library.title': "Notes",
        'library.hint': "Saved knowledge with its sources and recall scope.",
        'library.empty': "No notes yet. Sync notes from Obsidian in Settings to get started.",
        'library.loading': 'Loading knowledge notes…',
        'library.failed': 'Knowledge base failed: {reason}',
        'library.total': '{count} notes',
        'library.vault': 'Vault: {path}',
        'library.noVault': "Configure Obsidian sync in Settings.",
        'library.note': 'Note',
        'library.syncExport': 'Sync to Obsidian',
        'library.syncImport': 'Import from Obsidian',
        'library.edit': 'Edit',
        'library.editorTitle': 'Knowledge note',
        'library.titleField': 'Title',
        'library.topicField': 'Topic',
        'library.tagsField': 'Tags',
        'library.tagsHint': 'Comma separated',
        'library.bodyField': 'Body',
        'library.bodyHint': 'Markdown and [[wiki links]] are kept as plain text.',
        'library.saving': 'Saving…',
        'library.saved': 'Note saved.',
        'library.saveFailed': 'Save failed: {reason}',
        'library.openFailed': 'Could not open the note: {reason}',
        'library.conflict': 'This file changed on disk. Reload before saving, or your edit would overwrite it.',
        'library.reload': 'Reload',
        'library.syncKnowledgeExport': 'Sync notes to Obsidian',
        'library.syncKnowledgeImport': 'Import notes from Obsidian',
        'library.exportResult': 'Exported {written} notes · skipped {skipped}.',
        'library.importResult': 'Imported {imported} · skipped {skipped} · conflicts {conflicts}.',
        'library.syncFailed': 'Sync failed: {reason}',
        'settings.captureQueue': 'Capture tasks: {pending} pending · {partial} partial · {unknown} unknown · {failed} failed · {done} done',
        'settings.captureAllowance': 'Automatic calls today: {used}/{limit} · shared by extraction and deeper recall',
        'settings.captureResume': '{count} waiting · resumes automatically at {time} (local time). Manual recovery uses additional calls.',
        'settings.capturePaused': '{count} waiting · automatic capture is disabled or its daily allowance is zero.',
        'settings.captureStorage': 'Capture storage: {sources} sources · {size} · {tasks} tasks',
        'settings.captureRetry': 'Recover next task',
        'settings.captureUnknownConfirm': 'The previous request has no confirmed result. Retrying may charge again. Send a new request?',
        'settings.captureNothing': 'No recoverable leaf remains. Check any in-flight or unresolved child task.',
        'settings.captureRetried': 'Capture task queued for retry.',
        'settings.captureRetryFailed': 'Retry failed: {reason}',
        'settings.title': 'Memory settings',
        'settings.capture': "Remember conversations",
        'settings.inject': "Use memories in replies",
        'settings.budget': "Recall context limit",
        'settings.retention': 'Episode retention',
        'settings.maintenance': 'Self-maintenance',
        'settings.group.capture': 'Capture & injection',
        'settings.group.retention': 'Retention & maintenance',
        'settings.group.data': 'Data',
        'settings.group.obsidian': 'Obsidian',
        "obsidian.auto": "Automatic two-way sync",
        "obsidian.autoHint": "Syncs while DSH is running, about every 5 seconds after the previous pass. Save settings first. Conflicts keep both copies in _conflicts; replaced files are retained in _history.",
        "obsidian.now": "Sync now",
        "obsidian.syncStatus": "Last sync: {time} · sent {sent} · received {received} · conflicts {conflicts}",
        "obsidian.notYet": "Not synced yet",
        "obsidian.keepMemory": "Use Memory version (keep copies)",
        "obsidian.keepVault": "Use Obsidian version (keep copies)",
        "obsidian.deleted": "Deleted on this side",
        "kind.unresolved": "Unresolved link",
        "status.unresolved": "Target not found",
        'obsidian.vault': 'Vault path',
        'obsidian.folder': 'Folder',
        'obsidian.actions': 'Sync',
        'obsidian.export': 'Export to Obsidian',
        'obsidian.import': 'Import from Obsidian',
        'obsidian.exported': 'Exported {written}, skipped {skipped}',
        'obsidian.imported': 'Imported {imported}, updated {updated}, skipped {skipped}',
        'obsidian.failed': 'Obsidian sync failed: {reason}',
        'settings.save': 'Save settings',
        'settings.saving': 'Saving…',
        'settings.saved': 'Settings saved',
        'settings.state.dirty': 'Unsaved changes',
        'settings.state.saved': 'Saved',
        'settings.state.savedAt': 'Saved · {time}',
        'settings.badge.on': 'Self-maintenance on',
        'settings.badge.off': 'Self-maintenance off',
        'settings.maintenance.off': 'Self-maintenance is off · existing backups stay local',
        'settings.data.label': 'Export, import & backup',
        'data.export': 'Export',
        'data.import': 'Import',
        'data.backup': 'Complete backup',
        'data.backupHint': 'Export/import merges current records. Complete backups also retain history, source evidence, settings and request receipts; restore them to a new directory with the recovery tool.',
        'data.exported': 'Exported',
        'data.imported': 'Imported {imported}, skipped {skipped}',
        'data.protectedDeleted': 'Kept {count} locally forgotten records deleted.',
        'data.backupDone': 'Backup written to {path}',
        'data.failed': 'Failed: {reason}',
        'settings.failed': 'Save failed: {reason}',
        'settings.maintenance.none': 'Self-maintenance has not run yet',
        'settings.maintenance.summary': 'Last maintenance: archived {archived} · pruned {pruned} backups',
        'settings.inject.usage': 'Last injection {tokens}/{budget} tokens',
        'settings.extract.usage': 'extraction ~{tokens} tokens (estimated)',
        'usage.title': 'Token usage · last 7 days',
        'usage.total': '{tokens} tokens',
        'usage.inject': 'Injection',
        'usage.extract': 'Extraction',
        'usage.empty': 'No usage recorded yet. Injection and extraction counts appear here.',
        'usage.day': '{date} · injection {inject} · extraction {extract}',
        'usage.avg': 'Avg {tokens}/turn',
        'usage.overBudget': '{count} over budget',
        'usage.provider': 'Provider usage: {calls} calls · input {input} · output {output} · total {total}',
        'usage.providerMissing': 'Provider did not return usage; the chart shows estimated prompt tokens only.',
        'view.profile': "Preferences",
        'profile.hint': 'Durable preferences grouped with evidence. Expand a row to see the source memories.',
        'profile.empty': 'No stable preferences yet.',
        'profile.evidenceTitle': 'Evidence',
        'profile.title': "Preferences",
        'profile.summary': '{count} traits',
        'profile.evidence': '{count} evidence',
        'pager.total': '{total} items',
        'pager.summary': 'Page {page} / {pages} · {total} items',
        'pager.perPageLabel': 'Per page',
        'pager.prev': 'Previous',
        'pager.next': 'Next',
        'actions.refresh': 'Refresh',
        'actions.rebuild': 'Rebuild index',
        'actions.edit': 'Edit',
        'actions.restore': 'Restore',
        'actions.purge': 'Delete forever',
        'actions.purgeConfirm': 'Confirm delete',
        'actions.history': 'History',
        'actions.close': 'Close',
        'notice.restored': 'Memory restored',
        'notice.purged': 'Memory permanently deleted',
        'notice.bulkDone': '{count} memories processed',
        'bulk.selected': '{count} selected',
        'bulk.selectAll': 'Select all on page',
        'bulk.clear': 'Clear',
        'bulk.archive': 'Archive',
        'bulk.delete': 'Delete',
        'bulk.restore': 'Restore',
        'bulk.selectRow': 'Select memory',
        'history.title': 'Revision history',
        'history.loading': 'Loading revisions…',
        'history.restore': 'Restore this revision',
        'history.current': 'current',
        'history.time': 'Updated {time}',
        'history.diffRemoved': 'removed: {text}',
        'history.diffAdded': 'added: {text}',
        'bulk.tag': 'Tags',
        'bulk.tagTitle': 'Add tags to selected memories',
        'bulk.tagPlaceholder': 'Comma separated, e.g. pnpm, node',
        'bulk.tagApply': 'Add tags',
        'notice.bulkPartial': '{updated} updated, {failed} failed',
        'notice.bulkRolledBack': '{failed} failed, all changes rolled back',
        'topic.suggest': 'Merge suggestions',
        'topic.mergeTitle': 'Topic merge suggestions',
        'topic.mergeLine': '{from} ({fromCount}) → {to} ({toCount})',
        'topic.mergeAction': 'Merge',
        'topic.merged': '{count} memories merged',
        'topic.none': 'No merge suggestions',
        'actions.approve': 'Approve',
        'actions.archive': 'Archive',
        'actions.delete': 'Delete',
        'actions.deleteConfirm': 'Click again to delete',
        'actions.cancel': 'Cancel',
        'actions.save': 'Save',
        'actions.saving': 'Saving\u2026',
        'actions.rebuilding': 'Rebuilding\u2026',
        'list.empty.title': 'No memories yet',
        'list.empty.body': 'Chat for a while, or say \u201cremember this\u201d in a conversation.',
        'list.noMatch': 'No memories match these filters.',
        'list.loading': 'Loading memories\u2026',
        'list.error.title': 'The memory panel could not load',
        'list.error.retry': 'Retry',
        'list.unavailable.title': 'Memory panel is unavailable',
        'list.unavailable.body': 'The Host did not expose the memory RPC. Restart Harness and reopen Settings.',
        'edit.title': 'Edit memory',
        'edit.content': 'Content',
        'edit.tags': 'Tags',
        'edit.tagsHint': 'Separate tags with commas',
        'edit.status': 'Status',
        'edit.pinned': 'Pin this memory',
        'edit.error': 'Could not save: {message}',
        'notice.saved': 'Memory updated',
        'notice.approved': 'Candidate approved',
        'notice.archived': 'Memory archived',
        'notice.deleted': 'Memory deleted',
        'notice.rebuilt': 'Index rebuilt',
        'error.invalid': 'Invalid input: {message}',
        'error.missingProject': 'No current project is known yet.',
        'section.memory': "Memories",
        'section.brief': "Project brief",
        'section.knowledge': "Knowledge",
        "health.title": "Storage health",
        "health.ok": "Available",
        "health.attention": "Needs attention",
        "health.unavailable": "Paused",
        "health.download": "Export diagnostic summary",
        "health.hint": "Contains only version, status codes and counts. Memory text, file paths and session identifiers are excluded.",
        "health.profile": "Isolated by host profile",
        "health.explicit": "Explicit standalone directory",
        "health.memories": "Current memories {memories} · deletion markers {deleted}",
        "health.jobs": "Queued {pending} · running {running} · incomplete {partial} · failed {failed} · unknown {unknown}",
        "health.corrupt": "Unreadable authority lines: {count}",
        "health.profile-unavailable": "The host profile identity is unavailable. Update the host or configure an independent data directory, then reload the plugin.",
        "health.storage-owner-conflict": "This directory belongs to another host profile. Choose a separate directory, then reload the plugin.",
        "health.storage-owner-invalid": "Directory ownership could not be verified. Check file permissions or restore a complete backup to a new directory.",
        "health.storage-unavailable": "Storage is unavailable. Check directory permissions, free disk space and file version, then reload the plugin.",
        "health.settings-invalid": "Settings are damaged. Capture, injection, maintenance and sync are paused until you explicitly save the settings again.",
        "health.settings-unreadable": "Settings cannot be read. Check file permissions before reloading the plugin.",
        "health.profile-explicit": "This standalone directory was explicitly configured; native profile isolation is not verified.",
        "health.backup-failed": "The complete backup did not finish. Existing backups were retained; check storage or retry later.",
        "health.corrupt-lines": "Unreadable authority lines were skipped. Check the local quarantine or restore a verified backup before relying on the record count.",
        "health.capture-incomplete": "Some extraction tasks are incomplete or failed. Inspect them in the task list below.",
        "health.capture-unknown": "Some request outcomes are unknown. They are not automatically resubmitted to avoid duplicate billing.",
        'section.activity': "Activity",
        'section.settings': "Settings",
        'nav.sections': "Memory sections",
        'view.activity': "Processing & usage",
        'view.brief': "Project brief",
        'sync.manual': "Manual transfer",
        'sync.memories': "Memories",
        'sync.notes': "Knowledge notes",
        'brief.project': "Project",
        'brief.choose': "Choose a project",
        'brief.hint': "Current facts, decisions and history, linked to their original evidence.",
        'brief.empty': "This project has no records yet.",
        'brief.current': "Current facts & constraints",
        'brief.decisions': "Confirmed decisions",
        'brief.history': "Previous decisions & facts",
        'brief.unresolved': "Pending confirmation or effective date",
        'brief.pending': 'Not effective yet',
        'brief.expired': 'Expired',
        'brief.sources': "View evidence",
        'brief.noQuote': "No exact quote was saved for this record.",
        'brief.user': "User message",
        'brief.since': "Effective from {time}",
        'brief.until': "Effective until {time}",
        'library.recallScope': "Use in replies",
        'library.scope.unbound': "Do not use in replies",
        'library.scope.project': "Only in one project",
        'library.scope.global': "Across all projects",
        'library.scopeHint': "Linked notes remain limited by their source memory. Forgotten content is not recalled.",
        'recall.title': 'Latest evidence lookup',
        'recall.empty': 'Evidence will appear here after a recall question.',
        'recall.found': 'Evidence included in this answer',
        'recall.missing': 'Still missing evidence',
        'recall.coverage': 'Included {covered} of {total} questions',
        'recall.candidates': 'Candidate passages included; answers not yet confirmed',
        'recall.forgetSource': 'Forget this original message',
        'recall.forgetConfirm': 'Forget the entire original message and its extracted memories? This also blocks all of its indexed passages.',
        'recall.semantic': 'Local semantic search',
        'recall.semanticProgress': '{indexed} of {total} passages indexed',
        'recall.semantic.idle': 'Starts when needed',
        'recall.semantic.loading': 'Loading model',
        'recall.semantic.downloading': 'Downloading public model',
        'recall.semantic.indexing': 'Indexing in background',
        'recall.semantic.ready': 'Ready',
        'recall.semantic.disabled': 'Disabled',
        'recall.semantic.failed': 'Unavailable; using keyword search',
        'recall.budgetOmitted': 'Found, but omitted by the context limit',
        'recall.local': 'Local evidence was sufficient',
        'recall.completed': 'Additional lookup completed',
        'recall.failed': 'Additional lookup failed; no automatic retry',
        'recall.unknown': 'Outcome unknown; no automatic retry',
        'recall.notSent': 'No additional request sent',
        'recall.budget': 'Additional lookup paused at the usage limit',
        'recall.usage': 'Reported usage: {tokens} tokens',
        'recall.usageUnknown': 'Provider usage unavailable',
      },
      zh: {
        nav: '\u8bb0\u5fc6',
        'panel.title': '\u957f\u671f\u8bb0\u5fc6',
        'panel.intro': '\u52a9\u624b\u81ea\u52a8\u6355\u83b7\u7684\u8bb0\u5fc6\uff0c\u53ef\u5728\u8fd9\u91cc\u5ba1\u9605\u3001\u4fee\u6539\u6216\u5220\u9664\u3002',
        'stats.active': '\u751f\u6548',
        'stats.candidate': '\u5f85\u5ba1',
        'stats.total': '\u603b\u8ba1',
        'stats.projects': '\u9879\u76ee',
        'activity.activeDays': '活跃天数',
        'activity.avgConfidence': '平均置信度',
        'activity.blueColor': '湖蓝',
        'activity.cell': '{date} · {count} 条',
        'activity.colorMenu': '配色',
        'activity.cumulativeTooltip': '截至 {end}：累计 {count} 条记忆',
        'activity.customColor': '自定义颜色…',
        'activity.amberColor': '暖金',
        'activity.last7': '近 7 天',
        'activity.less': '少',
        'activity.mode.cumulative': '累计',
        'activity.mode.daily': '每日',
        'activity.mode.weekly': '每周',
        'activity.more': '多',
        'activity.roseColor': '烟粉',
        'activity.sparseHint': '热力图会随着记忆积累逐渐点亮。',
        'activity.streak': '连续天数',
        'activity.summary': '近一年 {total} 条 · {days} 天有记录',
        'activity.tealColor': '青绿',
        'activity.themeColor': '跟随主题',
        'activity.title': '记忆活动',
        'activity.violetColor': '暮紫',
        'activity.weeklyTooltip': '{start} – {end} 当周：{count} 条记忆',
        'capture.label': '\u81ea\u52a8\u6355\u83b7',
        'inject.label': '\u4e0a\u4e0b\u6587\u6ce8\u5165',
        'flag.on': '\u5f00\u542f',
        'flag.off': '\u5173\u95ed',
        'filter.scope': '\u8303\u56f4',
        'filter.scope.project': '\u5f53\u524d\u9879\u76ee',
        'filter.scope.global': '\u5168\u5c40',
        'filter.status': '\u72b6\u6001',
        'filter.topic': '\u4e3b\u9898',
        'filter.topic.all': '\u5168\u90e8\u4e3b\u9898',
        'filter.topic.none': '\u65e0\u4e3b\u9898',
        'filter.status.all': '\u5168\u90e8\u72b6\u6001',
        'filter.kind': '\u7c7b\u578b',
        'filter.kind.all': '\u5168\u90e8\u7c7b\u578b',
        'filter.search': '\u641c\u7d22',
        'filter.searchPlaceholder': '\u641c\u7d22\u5185\u5bb9\u6216\u6807\u7b7e',
        'kind.preference': '\u504f\u597d',
        'kind.fact': '\u4e8b\u5b9e',
        'kind.decision': '\u51b3\u7b56',
        'kind.episode': '\u7247\u6bb5',
        'kind.knowledge': '\u77e5\u8bc6\u7b14\u8bb0',
        'kind.vault': 'Vault \u7b14\u8bb0',
        'status.active': '\u751f\u6548',
        'status.candidate': '\u5f85\u5ba1',
        'status.archived': '\u5df2\u5f52\u6863',
        'status.superseded': '\u5df2\u53d6\u4ee3',
        'status.deleted': '\u5df2\u5220\u9664',
        'row.confidence': '\u7f6e\u4fe1\u5ea6 {value}',
        'row.updated': '\u66f4\u65b0\u4e8e {value}',
        'row.pinned': '\u5df2\u7f6e\u9876',
        'count.showing': '\u663e\u793a {shown}/{total} \u6761',
        'view.memory': "记忆记录",
        'view.library': "笔记",
        'view.settings': '\u8bbe\u7f6e',
        'view.capture': "记忆方式",
        'view.retention': "保留与清理",
        'view.data': "备份与迁移",
        'view.obsidian': "Obsidian 同步",
        'library.title': "笔记",
        'library.hint': "保存长期知识，查看出处并选择用于哪些对话。",
        'library.empty': "还没有笔记。可到设置中同步 Obsidian 笔记。",
        'library.loading': '\u6b63\u5728\u52a0\u8f7d\u77e5\u8bc6\u7b14\u8bb0\u2026',
        'library.failed': '\u77e5\u8bc6\u5e93\u52a0\u8f7d\u5931\u8d25\uff1a{reason}',
        'library.total': '{count} \u6761\u7b14\u8bb0',
        'library.vault': 'Vault\uff1a{path}',
        'library.noVault': "请到设置中配置 Obsidian 同步。",
        'library.note': '\u7b14\u8bb0',
        'library.syncExport': '\u540c\u6b65\u5230 Obsidian',
        'library.syncImport': '\u4ece Obsidian \u5bfc\u5165',
        'library.edit': '编辑',
        'library.editorTitle': '知识笔记',
        'library.titleField': '标题',
        'library.topicField': '主题',
        'library.tagsField': '标签',
        'library.tagsHint': '逗号分隔',
        'library.bodyField': '正文',
        'library.bodyHint': 'Markdown 与 [[wiki 链接]] 按纯文本保存。',
        'library.saving': '保存中…',
        'library.saved': '笔记已保存。',
        'library.saveFailed': '保存失败：{reason}',
        'library.openFailed': '打开笔记失败：{reason}',
        'library.conflict': '文件已被外部修改。请先重新加载，否则保存会覆盖外部改动。',
        'library.reload': '重新加载',
        'library.syncKnowledgeExport': '同步知识到 Obsidian',
        'library.syncKnowledgeImport': '从 Obsidian 导入知识',
        'library.exportResult': '已导出 {written} 条 · 跳过 {skipped} 条。',
        'library.importResult': '已导入 {imported} 条 · 跳过 {skipped} 条 · 冲突 {conflicts} 条。',
        'library.syncFailed': '同步失败：{reason}',
        'settings.captureQueue': '提炼任务：待处理 {pending} · 待补全 {partial} · 未知 {unknown} · 失败 {failed} · 完成 {done}',
        'settings.captureAllowance': '今日自动调用 {used}/{limit} · 提炼与深查共用',
        'settings.captureResume': '{count} 项等待额度 · 本地时间 {time} 自动继续。手动恢复会使用额外调用额度。',
        'settings.capturePaused': '{count} 项等待额度 · 自动捕获已关闭或每日额度为 0。',
        'settings.captureRetry': '恢复下一项',
        'settings.captureUnknownConfirm': '上一次请求结果未知，重新发送可能再次计费。确认发送新请求？',
        'settings.captureNothing': '没有可恢复的末级任务，请检查正在运行或结果未知的子任务。',
        'settings.captureRetried': '已加入重试队列。',
        'settings.captureRetryFailed': '重试失败：{reason}',
        'settings.title': '\u8bb0\u5fc6\u8bbe\u7f6e',
        'settings.capture': "自动记住对话",
        'settings.inject': "回答时参考记忆",
        'settings.budget': "参考内容上限",
        'settings.retention': '\u7247\u6bb5\u4fdd\u7559',
        'settings.maintenance': '\u81ea\u7ef4\u62a4',
        'settings.group.capture': '\u6355\u83b7\u4e0e\u6ce8\u5165',
        'settings.group.retention': '\u4fdd\u7559\u4e0e\u7ef4\u62a4',
        'settings.group.data': '\u6570\u636e',
        'settings.group.obsidian': 'Obsidian',
        "obsidian.auto": "自动双向同步",
        "obsidian.autoHint": "DSH 运行期间，上一轮结束后约每 5 秒同步一次。请先保存设置。冲突双方保留在 _conflicts，替换过的文件保留在 _history。",
        "obsidian.now": "立即同步",
        "obsidian.syncStatus": "最近同步：{time} · 导出 {sent} · 导入 {received} · 冲突 {conflicts}",
        "obsidian.notYet": "尚未同步",
        "obsidian.keepMemory": "使用 Memory 版本（保留副本）",
        "obsidian.keepVault": "使用 Obsidian 版本（保留副本）",
        "obsidian.deleted": "这一侧已删除",
        "kind.unresolved": "未解析链接",
        "status.unresolved": "目标尚不存在",
        'obsidian.vault': 'Vault \u8def\u5f84',
        'obsidian.folder': '\u6587\u4ef6\u5939',
        'obsidian.actions': '\u540c\u6b65',
        'obsidian.export': '\u5bfc\u51fa\u5230 Obsidian',
        'obsidian.import': '\u4ece Obsidian \u5bfc\u5165',
        'obsidian.exported': '\u5df2\u5bfc\u51fa {written} \u6761\uff0c\u8df3\u8fc7 {skipped} \u6761',
        'obsidian.imported': '\u5df2\u5bfc\u5165 {imported} \u6761\uff0c\u66f4\u65b0 {updated} \u6761\uff0c\u8df3\u8fc7 {skipped} \u6761',
        'obsidian.failed': 'Obsidian \u540c\u6b65\u5931\u8d25\uff1a{reason}',
        'settings.save': '\u4fdd\u5b58\u8bbe\u7f6e',
        'settings.saving': '\u4fdd\u5b58\u4e2d\u2026',
        'settings.saved': '\u8bbe\u7f6e\u5df2\u4fdd\u5b58',
        'settings.state.dirty': '\u6709\u672a\u4fdd\u5b58\u7684\u66f4\u6539',
        'settings.state.saved': '\u5df2\u4fdd\u5b58',
        'settings.state.savedAt': '\u5df2\u4fdd\u5b58 \u00b7 {time}',
        'settings.badge.on': '\u81ea\u52a8\u7ef4\u62a4\u4e2d',
        'settings.badge.off': '\u81ea\u7ef4\u62a4\u5df2\u5173\u95ed',
        'settings.maintenance.off': '\u81ea\u7ef4\u62a4\u5df2\u5173\u95ed \u00b7 \u5386\u53f2\u5907\u4efd\u4ecd\u4fdd\u7559\u5728\u672c\u5730',
        'settings.data.label': '\u5bfc\u51fa\u3001\u5bfc\u5165\u4e0e\u5907\u4efd',
        'data.export': '\u5bfc\u51fa',
        'data.import': '\u5bfc\u5165',
        "health.title": "存储状态",
        "health.ok": "可用",
        "health.attention": "需要处理",
        "health.unavailable": "已暂停",
        "health.download": "导出诊断摘要",
        "health.hint": "只包含版本、状态码和数量，不含记忆正文、文件路径或会话标识。",
        "health.profile": "按宿主配置隔离",
        "health.explicit": "独立指定目录",
        "health.memories": "当前记忆 {memories} · 删除标记 {deleted}",
        "health.jobs": "排队 {pending} · 处理中 {running} · 未完成 {partial} · 失败 {failed} · 待核实 {unknown}",
        "health.corrupt": "无法读取的原始记录行：{count}",
        "health.profile-unavailable": "无法确认宿主配置身份。请更新宿主或配置独立数据目录后重新加载插件。",
        "health.storage-owner-conflict": "目录属于其他宿主配置。请选择独立目录后重新加载插件。",
        "health.storage-owner-invalid": "无法确认数据目录归属。请检查文件权限或从完整备份恢复到新目录。",
        "health.storage-unavailable": "存储不可用。请检查目录权限、磁盘空间和文件版本后重新加载插件。",
        "health.settings-invalid": "设置损坏，捕获、注入、维护和同步已暂停。请在设置页重新确认并保存。",
        "health.settings-unreadable": "无法读取设置。请检查文件权限后重新加载插件。",
        "health.profile-explicit": "当前目录由独立配置指定，尚未核验宿主配置隔离。",
        "health.backup-failed": "完整备份未完成，已有备份保留。请检查存储或稍后重试。",
        "health.corrupt-lines": "已跳过无法读取的记录行。请检查本地隔离记录或恢复已验证备份，再判断记忆是否完整。",
        "health.capture-incomplete": "存在未完成或失败的提炼任务，请查看下方任务列表。",
        "health.capture-unknown": "部分请求结果未知，为避免重复计费不会自动重发。",
        'data.backup': '完整备份',
        'data.backupHint': '导出和导入用于迁移当前记忆。完整备份还保留历史、原文、设置和请求回执；通过恢复工具还原到新目录。',
        'data.exported': '\u5df2\u5bfc\u51fa',
        'data.imported': '\u5df2\u5bfc\u5165 {imported} \u6761\uff0c\u8df3\u8fc7 {skipped} \u6761',
        'data.protectedDeleted': '已保留 {count} 条本地记忆的遗忘状态。',
        'data.backupDone': '\u5907\u4efd\u5df2\u5199\u5165 {path}',
        'data.failed': '\u64cd\u4f5c\u5931\u8d25\uff1a{reason}',
        'settings.failed': '\u4fdd\u5b58\u5931\u8d25\uff1a{reason}',
        'settings.maintenance.none': '\u5c1a\u672a\u6267\u884c\u81ea\u7ef4\u62a4',
        'settings.maintenance.summary': '\u4e0a\u6b21\u81ea\u7ef4\u62a4\uff1a\u5f52\u6863 {archived} \u6761 \u00b7 \u6e05\u7406\u5907\u4efd {pruned} \u4efd',
        'settings.inject.usage': '\u4e0a\u6b21\u6ce8\u5165 {tokens}/{budget} token',
        'settings.extract.usage': '\u62bd\u53d6\u7ea6 {tokens} token\uff08\u4f30\u7b97\uff09',
        'usage.title': 'Token 用量 · 近 7 天',
        'usage.total': '共 {tokens} token',
        'usage.inject': '注入',
        'usage.extract': '抽取',
        'usage.empty': '暂无用量，注入或抽取后开始统计。',
        'usage.day': '{date} · 注入 {inject} · 抽取 {extract}',
        'usage.avg': '平均 {tokens}/回合',
        'usage.overBudget': '{count} 次超预算',
        'usage.provider': 'Provider \u7528\u91cf\uff1a{calls} \u6b21 \u00b7 \u8f93\u5165 {input} \u00b7 \u8f93\u51fa {output} \u00b7 \u603b {total}',
        'usage.providerMissing': 'Provider \u672a\u8fd4\u56de\u7528\u91cf\uff1b\u56fe\u8868\u4ec5\u5c55\u793a\u4f30\u7b97\u7684 prompt token\u3002',
        'view.profile': "用户偏好",
        'profile.hint': '\u7531\u6301\u4e45\u504f\u597d\u5f52\u7eb3\uff0c\u6bcf\u6761\u90fd\u5e26\u8bc1\u636e\u3002',
        'profile.empty': '\u8fd8\u6ca1\u6709\u7a33\u5b9a\u504f\u597d\u3002',
        'profile.evidenceTitle': '\u8bc1\u636e',
        'profile.title': "用户偏好",
        'profile.summary': '\u5171 {count} \u6761',
        'profile.evidence': '{count} \u6761\u8bc1\u636e',
        'pager.total': '\u5171 {total} \u6761',
        'pager.summary': '\u7b2c {page} / {pages} \u9875 \u00b7 \u5171 {total} \u6761',
        'pager.perPageLabel': '\u6bcf\u9875',
        'pager.prev': '\u4e0a\u4e00\u9875',
        'pager.next': '\u4e0b\u4e00\u9875',
        'actions.refresh': '\u5237\u65b0',
        'actions.rebuild': '\u91cd\u5efa\u7d22\u5f15',
        'actions.edit': '\u7f16\u8f91',
        'actions.restore': '\u6062\u590d',
        'actions.purge': '\u5f7b\u5e95\u5220\u9664',
        'actions.purgeConfirm': '\u786e\u8ba4\u5f7b\u5e95\u5220\u9664',
        'actions.history': '\u5386\u53f2',
        'actions.close': '\u5173\u95ed',
        'notice.restored': '\u8bb0\u5fc6\u5df2\u6062\u590d',
        'notice.purged': '\u8bb0\u5fc6\u5df2\u5f7b\u5e95\u5220\u9664',
        'notice.bulkDone': '\u5df2\u5904\u7406 {count} \u6761',
        'bulk.selected': '\u5df2\u9009 {count} \u6761',
        'bulk.selectAll': '\u5168\u9009\u672c\u9875',
        'bulk.clear': '\u6e05\u9664',
        'bulk.archive': '\u5f52\u6863',
        'bulk.delete': '\u5220\u9664',
        'bulk.restore': '\u6062\u590d',
        'bulk.selectRow': '\u9009\u62e9\u8bb0\u5fc6',
        'history.title': '\u7248\u672c\u5386\u53f2',
        'history.loading': '\u6b63\u5728\u52a0\u8f7d\u7248\u672c\u2026',
        'history.restore': '\u6062\u590d\u6b64\u7248\u672c',
        'history.current': '\u5f53\u524d',
        'history.time': '\u66f4\u65b0\u4e8e {time}',
        'history.diffRemoved': '\u5220\u9664\uff1a{text}',
        'history.diffAdded': '\u65b0\u589e\uff1a{text}',
        'bulk.tag': '\u6807\u7b7e',
        'bulk.tagTitle': '\u7ed9\u9009\u4e2d\u8bb0\u5fc6\u6dfb\u52a0\u6807\u7b7e',
        'bulk.tagPlaceholder': '\u9017\u53f7\u5206\u9694\uff0c\u5982 pnpm, node',
        'bulk.tagApply': '\u6dfb\u52a0\u6807\u7b7e',
        'notice.bulkPartial': '\u5df2\u66f4\u65b0 {updated} \u6761\uff0c\u5931\u8d25 {failed} \u6761',
        'notice.bulkRolledBack': '\u5931\u8d25 {failed} \u6761\uff0c\u5df2\u56de\u6eda\u5168\u90e8\u66f4\u6539',
        'topic.suggest': '\u5408\u5e76\u5efa\u8bae',
        'topic.mergeTitle': '\u4e3b\u9898\u5408\u5e76\u5efa\u8bae',
        'topic.mergeLine': '{from}\uff08{fromCount}\uff09\u2192 {to}\uff08{toCount}\uff09',
        'topic.mergeAction': '\u5408\u5e76',
        'topic.merged': '\u5df2\u5408\u5e76 {count} \u6761',
        'topic.none': '\u6682\u65e0\u5408\u5e76\u5efa\u8bae',
        'actions.approve': '\u6279\u51c6',
        'actions.archive': '\u5f52\u6863',
        'actions.delete': '\u5220\u9664',
        'actions.deleteConfirm': '\u518d\u6b21\u70b9\u51fb\u4ee5\u5220\u9664',
        'actions.cancel': '\u53d6\u6d88',
        'actions.save': '\u4fdd\u5b58',
        'actions.saving': '\u4fdd\u5b58\u4e2d\u2026',
        'actions.rebuilding': '\u91cd\u5efa\u4e2d\u2026',
        'list.empty.title': '\u8fd8\u6ca1\u6709\u8bb0\u5fc6',
        'list.empty.body': '\u804a\u4e00\u4f1a\u513f\uff0c\u6216\u5728\u5bf9\u8bdd\u91cc\u8bf4\u300c\u8bb0\u4f4f\u8fd9\u4e2a\u300d\u3002',
        'list.noMatch': '\u6ca1\u6709\u7b26\u5408\u7b5b\u9009\u6761\u4ef6\u7684\u8bb0\u5fc6\u3002',
        'list.loading': '\u6b63\u5728\u52a0\u8f7d\u8bb0\u5fc6\u2026',
        'list.error.title': '\u8bb0\u5fc6\u9762\u677f\u52a0\u8f7d\u5931\u8d25',
        'list.error.retry': '\u91cd\u8bd5',
        'list.unavailable.title': '\u8bb0\u5fc6\u9762\u677f\u6682\u4e0d\u53ef\u7528',
        'list.unavailable.body': 'Host \u672a\u63d0\u4f9b\u8bb0\u5fc6 RPC\uff0c\u8bf7\u91cd\u542f Harness \u540e\u91cd\u65b0\u6253\u5f00\u8bbe\u7f6e\u3002',
        'edit.title': '\u7f16\u8f91\u8bb0\u5fc6',
        'edit.content': '\u5185\u5bb9',
        'edit.tags': '\u6807\u7b7e',
        'edit.tagsHint': '\u7528\u9017\u53f7\u5206\u9694\u6807\u7b7e',
        'edit.status': '\u72b6\u6001',
        'edit.pinned': '\u7f6e\u9876\u6b64\u8bb0\u5fc6',
        'edit.error': '\u4fdd\u5b58\u5931\u8d25\uff1a{message}',
        'notice.saved': '\u8bb0\u5fc6\u5df2\u66f4\u65b0',
        'notice.approved': '\u5019\u9009\u5df2\u6279\u51c6',
        'notice.archived': '\u8bb0\u5fc6\u5df2\u5f52\u6863',
        'notice.deleted': '\u8bb0\u5fc6\u5df2\u5220\u9664',
        'notice.rebuilt': '\u7d22\u5f15\u5df2\u91cd\u5efa',
        'error.invalid': '\u8f93\u5165\u65e0\u6548\uff1a{message}',
        'error.missingProject': '\u5c1a\u672a\u8bc6\u522b\u5f53\u524d\u9879\u76ee\u3002',
        'section.memory': "记忆",
        'section.brief': "项目档案",
        'section.knowledge': "知识",
        'section.activity': "活动",
        'section.settings': "设置",
        'nav.sections': "记忆导航",
        'view.activity': "提炼与用量",
        'view.brief': "项目档案",
        'sync.manual': "手动导入与导出",
        'sync.memories': "记忆记录",
        'sync.notes': "知识笔记",
        'brief.project': "项目",
        'brief.choose': "选择项目",
        'brief.hint': "按当前事实、决定和历史整理，每项保留原始依据。",
        'brief.empty': "这个项目还没有记忆记录。",
        'brief.current': "当前事实与约束",
        'brief.decisions': "已确认的决定",
        'brief.history': "历史变化",
        'brief.unresolved': "待确认与待生效",
        'brief.pending': '待生效',
        'brief.expired': '已过期',
        'brief.sources': "查看依据",
        'brief.noQuote': "这条记录尚未保存可定位的原句。",
        'brief.user': "用户原话",
        'brief.since': "生效于 {time}",
        'brief.until': "截止于 {time}",
        'library.recallScope': "用于回答",
        'library.scope.unbound': "不用于回答",
        'library.scope.project': "仅指定项目",
        'library.scope.global': "所有项目",
        'library.scopeHint': "关联记忆的笔记仍受原记忆范围限制，已遗忘内容不会重新参与回答。",
        'recall.title': '最近一次查证',
        'recall.empty': '询问记忆后，这里会显示查证结果。',
        'recall.found': '已放入本轮回答的证据',
        'recall.missing': '仍缺少证据',
        'recall.coverage': '本轮已覆盖 {covered} / {total} 项问题',
        'recall.candidates': '已送入候选原文，答案尚未确认',
        'recall.forgetSource': '忘记这条原始消息',
        'recall.forgetConfirm': '忘记整条原始消息及其提炼出的记忆？这也会阻止该消息的所有分段再次进入召回。',
        'recall.semantic': '本地语义检索',
        'recall.semanticProgress': '已建立 {indexed} / {total} 段索引',
        'recall.semantic.idle': '需要时启动',
        'recall.semantic.loading': '正在加载模型',
        'recall.semantic.downloading': '正在下载公开模型',
        'recall.semantic.indexing': '正在后台建立索引',
        'recall.semantic.ready': '已就绪',
        'recall.semantic.disabled': '已关闭',
        'recall.semantic.failed': '暂不可用，已使用关键词检索',
        'recall.budgetOmitted': '已找到，但受上下文限额未放入本轮',
        'recall.local': '本地证据已覆盖问题',
        'recall.completed': '已完成补充查证',
        'recall.failed': '补充查证失败，未自动重试',
        'recall.unknown': '请求结果未知，未自动重试',
        'recall.notSent': '未发送补充请求',
        'recall.budget': '已达额度，暂停补充查证',
        'recall.usage': '实际用量：{tokens} token',
        'recall.usageUnknown': '服务商未返回用量',
      },
    }

    const CSS = [
      'html:has(.dsh-memory-root),body:has(.dsh-memory-root){scrollbar-gutter:stable}',
      '*:has(.dsh-memory-root){scrollbar-gutter:stable}',
      '.dsh-memory-root{max-width:760px;display:flex;flex-direction:column;gap:14px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5;container-type:inline-size}',
      '.dsh-memory-header{display:flex;flex-direction:column;gap:6px;padding:0;border:0;border-radius:0;background:transparent;box-shadow:none;margin-bottom:16px}',
      '.dsh-memory-heading{margin:0;font-size:20px;font-weight:600;line-height:28px}',
      '.dsh-memory-intro{margin:0;color:var(--dsw-alias-label-secondary);font-size:13px}',
      '.dsh-memory-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(96px,1fr));gap:8px}',
      '.dsh-memory-summary{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));margin:0;border:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.25));background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-layer-1,#fff));border-radius:12px;overflow:hidden}',
      '.dsh-memory-metric{min-width:0;padding:11px 8px 10px}',
      '.dsh-memory-metric+.dsh-memory-metric{border-left:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.25))}',
      '.dsh-memory-metric dt{color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary,#6b7280));font-size:11px;line-height:18px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.dsh-memory-metric dd{margin:2px 0 0;font-size:16px;font-weight:500;line-height:22px;font-variant-numeric:tabular-nums}',
      '.dsh-memory-activity{margin-top:20px}',
      '.dsh-memory-activity-head{display:flex;align-items:center;justify-content:space-between;gap:12px}',
      '.dsh-memory-activity-title{display:flex;align-items:center;gap:10px;min-width:0}',
      '.dsh-memory-activity-title h3{margin:0;font-size:13px;font-weight:500;line-height:20px;color:var(--dsw-alias-label-primary,#1f2328)}',
      '.dsh-memory-tabs{display:inline-flex;gap:2px}',
      '.dsh-memory-tabs button{font:inherit;font-size:11px;line-height:18px;padding:3px 7px;border:0;border-radius:5px;background:0 0;color:var(--dsw-alias-label-tertiary,#6b7280);cursor:pointer}',
      '.dsh-memory-tabs button[aria-selected="true"]{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));color:var(--dsw-alias-label-primary,#1f2328)}',
      '.dsh-memory-tabs button:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#2f6df6);outline-offset:1px}',
      '.dsh-memory-palette{position:relative;display:flex}',
      '.dsh-memory-palette-trigger{display:inline-flex;align-items:center;gap:5px;border:0;background:0 0;border-radius:6px;padding:4px 6px;font:inherit;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#6b7280);cursor:pointer}',
      '.dsh-memory-palette-trigger:hover,.dsh-memory-palette-trigger[aria-expanded="true"]{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));color:var(--dsw-alias-label-primary,#1f2328)}',
      '.dsh-memory-palette-swatch{display:inline-flex;align-items:center;gap:2px}',
      '.dsh-memory-palette-swatch i{width:4px;height:11px;border-radius:2px;background:var(--dsh-memory-swatch,#2f6df6)}',
      '.dsh-memory-palette-swatch i:first-child{opacity:.35}',
      '.dsh-memory-palette-swatch i:nth-child(2){opacity:.65}',
      '.dsh-memory-palette-menu{position:absolute;top:calc(100% + 4px);left:0;z-index:20;min-width:176px;display:flex;flex-direction:column;gap:2px;padding:6px;border:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.25));border-radius:20px;background:var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-layer-2,#fff));box-shadow:var(--dsw-elevation-soft)}',
      '.dsh-memory-palette-option{display:flex;align-items:center;gap:8px;border:0;background:0 0;border-radius:6px;padding:5px 7px;font:inherit;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary,#1f2328);cursor:pointer;text-align:left}',
      '.dsh-memory-palette-option:hover,.dsh-memory-palette-option[aria-selected="true"]{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}',
      '.dsh-memory-palette-dot{display:inline-block;width:12px;height:12px;border-radius:3px}',
      '.dsh-memory-palette-theme{width:12px;text-align:center;color:var(--dsw-alias-label-secondary,#6b7280)}',
      '.dsh-memory-color-input{width:16px;height:16px;padding:0;border:0;background:0 0}',
      '.dsh-memory-heatmap-stage{position:relative;margin-top:16px;min-width:0}',
      '.dsh-memory-heatmap{display:grid;grid-template-rows:repeat(7,minmax(0,1fr));grid-template-columns:repeat(53,minmax(0,1fr));grid-auto-flow:column;gap:3px}',
      '.dsh-memory-heat-cell{display:block;width:100%;min-width:0;aspect-ratio:1;border-radius:2px;background:var(--dsw-alias-bg-skeleton,var(--dsw-alias-bg-layer-2,rgba(127,127,127,.14)))}',
      '.dsh-memory-heat-cell[data-future="true"]{opacity:.35}',
      '.dsh-memory-heat-cell[data-level="1"]{background:color-mix(in srgb,var(--dsh-memory-particle-color,#2f6df6) 22%,transparent);background:oklch(from var(--dsh-memory-particle-color,#2f6df6) .89 calc(c * .35) h)}',
      '.dsh-memory-heat-cell[data-level="2"]{background:color-mix(in srgb,var(--dsh-memory-particle-color,#2f6df6) 38%,transparent);background:oklch(from var(--dsh-memory-particle-color,#2f6df6) .78 calc(c * .55) h)}',
      '.dsh-memory-heat-cell[data-level="3"]{background:color-mix(in srgb,var(--dsh-memory-particle-color,#2f6df6) 60%,transparent);background:oklch(from var(--dsh-memory-particle-color,#2f6df6) .67 calc(c * .75) h)}',
      '.dsh-memory-heat-cell[data-level="4"]{background:color-mix(in srgb,var(--dsh-memory-particle-color,#2f6df6) 82%,transparent);background:oklch(from var(--dsh-memory-particle-color,#2f6df6) .56 calc(c * .9) h)}',
      '.dsh-memory-heat-cell[data-level="5"]{background:color-mix(in srgb,var(--dsh-memory-particle-color,#2f6df6) 100%,transparent);background:oklch(from var(--dsh-memory-particle-color,#2f6df6) .45 c h)}',
      '.dsh-memory-heat-months{display:grid;grid-template-columns:repeat(53,minmax(0,1fr));gap:3px;margin-top:7px;font-size:9px;line-height:14px;color:var(--dsw-alias-label-tertiary,#6b7280)}',
      '.dsh-memory-heat-months>span{white-space:nowrap;overflow:visible}',
      '.dsh-memory-heat-tooltip{position:absolute;transform:translateX(-50%);z-index:5;max-width:min(240px,calc(100% - 16px));padding:5px 9px;border-radius:8px;background:var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-layer-2,#fff));border:.5px solid var(--dsw-alias-border-l1,rgba(127,127,127,.2));box-shadow:0 6px 18px rgba(0,0,0,.12);color:var(--dsw-alias-label-primary,#1f2328);font-size:11px;line-height:18px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;pointer-events:none}',
      '.dsh-memory-activity-hint{margin:6px 0 0;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#6b7280)}',
      '.dsh-memory-activity-insights{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin:18px 0 0}',
      '.dsh-memory-activity-insights dt{color:var(--dsw-alias-label-tertiary,#6b7280);font-size:11px;line-height:16px}',
      '.dsh-memory-activity-insights dd{margin:2px 0 0;font-size:14px;font-weight:500;line-height:20px;font-variant-numeric:tabular-nums}',
      '@container (max-width:620px){.dsh-memory-summary{grid-template-columns:repeat(2,minmax(0,1fr))}.dsh-memory-metric:nth-child(n+3){border-top:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.25))}.dsh-memory-metric:nth-child(odd){border-left:0}.dsh-memory-activity-insights{grid-template-columns:repeat(2,minmax(0,1fr));gap:10px 12px}}',

      '.dsh-memory-stat{display:flex;flex-direction:column;gap:2px;padding:10px 12px;border:.5px solid var(--dsw-alias-settings-card-stroke, var(--dsw-alias-border-l1));border-radius:var(--dsw-radius-xl, 12px);background:var(--dsw-alias-settings-card-fill, var(--dsw-alias-bg-layer-1))}',
      '.dsh-memory-stat-label{color:var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary));font-size:12px}',
      '.dsh-memory-stat-value{font-size:20px;font-weight:600;line-height:24px}',
      '.dsh-memory-summary-row{display:flex;align-items:center;gap:12px;flex-wrap:wrap}',
      '.dsh-memory-summary-row .dsh-memory-summary{flex:1 1 320px;min-width:0}',
      '.dsh-memory-flags{display:flex;flex-wrap:nowrap;gap:8px;align-items:center;flex:0 0 auto}',
      '.dsh-memory-chip{display:inline-flex;align-items:center;gap:5px;padding:2px 8px;border:.5px solid var(--dsw-alias-border-l3, var(--dsw-alias-border-l1));border-radius:var(--dsw-radius-xs, 4px);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}',
      '.dsh-memory-chip[data-on="true"]{color:var(--dsw-alias-state-success-primary)}',
      '.dsh-memory-chip[data-on="false"]{color:var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary))}',
      '.dsh-memory-toolbar{display:flex;flex-wrap:wrap;gap:0;align-items:stretch;flex-direction:column;padding:0;border:0;border-radius:0;background:transparent;box-shadow:none;margin-top:28px}',
      '.dsh-memory-toolbar .dsh-memory-field{flex:0 0 auto;min-width:0;display:grid;grid-template-columns:minmax(0,1fr) minmax(112px,42%);align-items:center;gap:12px;padding:10px 0;border-bottom:.5px solid var(--dsh-memory-card-border)}',
      '.dsh-memory-toolbar .dsh-memory-select{max-width:118px;min-width:0;font-size:12px}',
      '.dsh-memory-toolbar-actions{display:flex;gap:6px;margin-left:0;padding-bottom:1px;flex:0 0 auto;justify-content:flex-end;width:100%;padding:12px 0}',
      '.dsh-memory-field{display:flex;flex-direction:column;gap:3px;min-width:0}',
      '.dsh-memory-field-label{color:var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary));font-size:11px;line-height:16px}',
      '.dsh-memory-field-grow{flex:1 1 0;min-width:110px}',
      '.dsh-memory-input,.dsh-memory-select{box-sizing:border-box;height:32px;padding:0 24px;border:.5px solid var(--dsw-alias-border-l3, var(--dsw-alias-border-l1));border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:30px;text-align:center;text-align-last:center}',
      '.dsh-memory-textarea{box-sizing:border-box;min-height:28px;padding:4px 8px;border:.5px solid var(--dsw-alias-border-l3, var(--dsw-alias-border-l1));border-radius:var(--dsw-radius-sm, 6px);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:20px}',
      '.dsh-memory-input::placeholder,.dsh-memory-textarea::placeholder{color:var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary))}',
      '.dsh-memory-input:focus-visible,.dsh-memory-select:focus-visible,.dsh-memory-textarea:focus-visible,.dsh-memory-button:focus-visible{outline:var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary)));outline-offset:1px}',
      '.dsh-memory-textarea{resize:vertical;min-height:96px;line-height:1.5}',
      '.dsh-memory-spacer{flex:1 1 auto}',
      '.dsh-memory-button{box-sizing:border-box;min-height:32px;padding:3px 10px;border:.5px solid var(--dsw-alias-border-l3, var(--dsw-alias-border-l1));border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:20px;cursor:pointer}',
      '.dsh-memory-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2))}',
      '.dsh-memory-button:disabled{opacity:.55;cursor:default}',
      '.dsh-memory-button[data-primary="true"]{border-color:transparent;background:var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary));color:var(--dsw-alias-label-primary-inverted, #ffffff)}',
      '.dsh-memory-button[data-primary="true"]:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary)))}',
      '.dsh-memory-button[data-danger="true"]:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger, var(--dsw-alias-state-error-primary));color:var(--dsw-alias-state-error-primary)}',
      '.dsh-memory-notice{margin:0;color:var(--dsw-alias-state-success-primary);font-size:12px}',
      '.dsh-memory-error-card{display:flex;flex-direction:column;gap:6px;padding:12px 14px;border:.5px solid var(--dsw-alias-state-error-secondary, var(--dsw-alias-state-error-primary));border-radius:var(--dsw-radius-xl, 12px);background:var(--dsw-alias-settings-card-fill, var(--dsw-alias-bg-layer-1))}',
      '.dsh-memory-error-title{margin:0;color:var(--dsw-alias-state-error-primary);font-size:13px;font-weight:600}',
      '.dsh-memory-error-text{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;word-break:break-word}',
      '.dsh-memory-detail{margin:0;padding:6px 8px;border-radius:var(--dsw-radius-xs, 4px);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary));font-size:11px;word-break:break-word}',
      '.dsh-memory-muted{margin:0;color:var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary));font-size:12px}',
      '.dsh-memory-list{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:8px}',
      '.dsh-memory-row{display:flex;flex-direction:column;gap:6px;padding:11px 13px;border:.5px solid var(--dsw-alias-settings-card-stroke, var(--dsw-alias-border-l1));border-radius:var(--dsw-radius-xl, 12px);background:var(--dsw-alias-settings-card-fill, var(--dsw-alias-bg-layer-1))}',
      '.dsh-memory-row-head{display:flex;flex-wrap:wrap;align-items:center;gap:6px}',
      '.dsh-memory-kind{display:inline-flex;align-items:center;padding:1px 7px;border:.5px solid var(--dsw-alias-border-l3, var(--dsw-alias-border-l1));border-radius:var(--dsw-radius-xs, 4px);font-size:11px;line-height:17px;background:var(--dsw-alias-bg-layer-2)}',
      '.dsh-memory-kind[data-kind="preference"]{color:var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary))}',
      '.dsh-memory-kind[data-kind="decision"]{color:var(--dsw-alias-state-success-primary)}',
      '.dsh-memory-kind[data-kind="fact"]{color:var(--dsw-alias-label-secondary)}',
      '.dsh-memory-kind[data-kind="episode"]{color:var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary))}',
      '.dsh-memory-status-pill{font-size:11px;line-height:17px;color:var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary))}',
      '.dsh-memory-status-pill[data-status="active"]{color:var(--dsw-alias-state-success-primary)}',
      '.dsh-memory-status-pill[data-status="candidate"]{color:var(--dsw-alias-state-warn-primary)}',
      '.dsh-memory-status-pill[data-status="superseded"]{color:var(--dsw-alias-label-dimmed, var(--dsw-alias-label-secondary))}',
      '.dsh-memory-pin{font-size:11px;line-height:17px;color:var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary))}',
      '.dsh-memory-row-meta{display:flex;flex-wrap:wrap;gap:10px;margin-left:auto;color:var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary));font-size:11px}',
      '.dsh-memory-content{margin:0;white-space:pre-wrap;word-break:break-word;color:var(--dsw-alias-label-primary)}',
      '.dsh-memory-tags{display:flex;flex-wrap:wrap;gap:5px;margin:0;padding:0;list-style:none}',
      '.dsh-memory-tag{padding:1px 6px;border:.5px solid var(--dsw-alias-border-l4, var(--dsw-alias-border-l2));border-radius:var(--dsw-radius-xs, 4px);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:17px}',
      '.dsh-memory-row-actions{display:flex;flex-wrap:wrap;gap:6px;align-items:center}',
      '.dsh-memory-empty{display:flex;flex-direction:column;gap:4px;padding:18px 16px;border:.5px solid var(--dsw-alias-settings-card-stroke, var(--dsw-alias-border-l1));border-radius:var(--dsw-radius-xl, 12px);background:var(--dsw-alias-settings-card-fill, var(--dsw-alias-bg-layer-1))}',
      '.dsh-memory-empty-title{margin:0;font-size:14px;font-weight:600}',
      '.dsh-memory-empty-body{margin:0;color:var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary));font-size:12px}',
      '.dsh-memory-overlay{position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;padding:16px;background:color-mix(in srgb, var(--dsw-alias-bg-base) 72%, transparent)}',
      '.dsh-memory-modal{box-sizing:border-box;display:flex;flex-direction:column;gap:10px;width:min(520px,100%);max-height:calc(100vh - 48px);overflow:auto;padding:16px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-xl, 12px);background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-shadow-lv2, 0 8px 24px rgba(0, 0, 0, 0.12))}',
      '.dsh-memory-modal-title{margin:0;font-size:15px;font-weight:600;line-height:22px}',
      '.dsh-memory-form{display:flex;flex-direction:column;gap:10px}',
      '.dsh-memory-check{display:inline-flex;align-items:center;gap:7px;color:var(--dsw-alias-label-secondary);font-size:12px}',
      '.dsh-memory-check input{accent-color:var(--dsw-alias-brand-primary)}',
      '.dsh-memory-modal-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:2px}',
      '.dsh-memory-root{--dsh-memory-card-border:var(--dsw-alias-border-l2,rgba(127,127,127,.22));--dsh-memory-card-bg:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-layer-1,#fff));--dsh-memory-gap:14px;--dsh-memory-radius:12px}',
      '.dsh-memory-card{padding:14px;border:.5px solid var(--dsh-memory-card-border);border-radius:var(--dsh-memory-radius);background:var(--dsh-memory-card-bg)}',
      '.dsh-memory-hero-cards{display:grid;grid-template-columns:minmax(0,1.6fr) minmax(0,1fr);gap:var(--dsh-memory-gap,14px);align-items:stretch}',
      '.dsh-memory-hero-main,.dsh-memory-hero-side{display:flex;align-items:center;padding:14px;border:.5px solid var(--dsh-memory-card-border);border-radius:var(--dsh-memory-radius);background:var(--dsh-memory-card-bg)}',
      '.dsh-memory-hero-metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;flex:1 1 auto;min-width:0}',
      '.dsh-memory-hero-metric{display:flex;align-items:baseline;gap:6px;min-width:0}',
      '.dsh-memory-hero-metric b{font-size:20px;font-weight:600;letter-spacing:-.01em;line-height:28px;font-variant-numeric:tabular-nums}',
      '.dsh-memory-hero-metric span{color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary,#6b7280));font-size:12px;line-height:18px}',
      '.dsh-memory-flags{display:flex;gap:8px;align-items:center;flex:0 0 auto;flex-wrap:nowrap;margin-left:auto}',
      '.dsh-memory-chip{display:inline-flex;align-items:center;gap:5px;height:22px;padding:0 8px;border:.5px solid var(--dsw-alias-border-l1,rgba(127,127,127,.2));border-radius:6px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:11.5px;line-height:20px}',
      '.dsh-memory-chip[data-on="true"]{color:var(--dsw-alias-state-success-primary,#1a9e63);background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#1a9e63) 10%,transparent);border-color:transparent}',
      '.dsh-memory-activity.dsh-memory-card{margin-top:14px;padding:14px;border:.5px solid var(--dsh-memory-card-border);border-radius:var(--dsh-memory-radius);background:var(--dsh-memory-card-bg)}',
      '.dsh-memory-toolbar{display:flex;grid-template-columns:repeat(3,minmax(0,1fr)) minmax(110px,1.6fr) auto;gap:0;align-items:stretch;margin-top:28px;padding:0;border:0;border-radius:0;background:transparent;box-shadow:none;flex-direction:column}',
      '.dsh-memory-toolbar .dsh-memory-field{min-width:0;display:grid;grid-template-columns:minmax(0,1fr) minmax(112px,42%);align-items:center;gap:12px;padding:10px 0;border-bottom:.5px solid var(--dsh-memory-card-border)}',
      '.dsh-memory-toolbar .dsh-memory-select{width:100%;max-width:none}',
      '.dsh-memory-toolbar[data-narrow="true"]{grid-template-columns:repeat(12,minmax(0,1fr))}',
      '.dsh-memory-toolbar[data-narrow="true"] .dsh-memory-field{grid-column:span 4}',
      '.dsh-memory-toolbar[data-narrow="true"] .dsh-memory-field-grow{grid-column:span 6}',
      '.dsh-memory-toolbar[data-narrow="true"] .dsh-memory-toolbar-actions{grid-column:span 6;justify-content:flex-end;gap:8px;margin-left:0;width:100%;padding:12px 0}',
      '.dsh-memory-toolbar[data-narrow="true"] .dsh-memory-toolbar-actions .dsh-memory-button{flex:1;min-width:0;padding:0 6px;border-radius:8px;min-height:32px}',
      '.dsh-memory-list{display:flex;flex-direction:column;gap:0;margin:10px 0 0;padding:0 16px;list-style:none;background:var(--dsh-memory-card-bg);border:1px solid var(--dsh-memory-card-border);border-radius:12px}',
      '.dsh-memory-row{min-width:0;display:flex;flex-direction:column;gap:9px;padding:15px 0 12px;border:0;border-radius:0;background:transparent}',
      '.dsh-memory-row+.dsh-memory-row{border-top:1px solid var(--dsh-memory-card-border)}',
      '.dsh-memory-row-head{display:flex;align-items:center;gap:9px;flex-wrap:wrap}',
      '.dsh-memory-row .dsh-memory-kind{display:inline-flex;align-items:center;gap:6px;height:auto;padding:0;border:0;border-radius:0;background:transparent;color:var(--dsw-alias-label-primary);font-size:12px;font-weight:600;line-height:18px}',
      '.dsh-memory-row .dsh-memory-status-pill{padding:0 6px;border:0;border-radius:5px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:18px}',
      '.dsh-memory-row .dsh-memory-status-pill[data-status="active"]{color:var(--dsw-alias-label-secondary);background:transparent;padding:0}',
      '.dsh-memory-row .dsh-memory-status-pill[data-status="active"]::before{content:"";display:inline-block;width:5px;height:5px;margin-right:5px;border-radius:50%;background:var(--dsw-alias-state-success-primary,currentColor)}',
      '.dsh-memory-row-select{display:inline-flex;align-items:center;position:relative;cursor:pointer}.dsh-memory-row-select::before{content:"";position:absolute;inset:-6px}',
      '.dsh-memory-row[data-selected="true"]{background:color-mix(in srgb,var(--dsw-alias-brand-primary,var(--dsw-alias-label-primary)) 5%,transparent)}',
      '.dsh-memory-row .dsh-memory-status-pill[data-status="candidate"]{color:var(--dsw-alias-state-warn-primary,var(--dsw-alias-label-secondary))}',
      '.dsh-memory-row-meta{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-left:auto;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;font-variant-numeric:tabular-nums}',
      '.dsh-memory-row-meta>span+span::before{content:"·";margin-right:8px}',
      '.dsh-memory-content{margin:0 0 0 23px;min-width:0;color:var(--dsw-alias-label-primary);font-size:14px;font-weight:400;line-height:1.6;overflow-wrap:anywhere}',
      '.dsh-memory-row-foot{display:flex;flex-wrap:wrap;align-items:center;gap:4px 16px;margin:0 0 0 23px;min-width:0}',
      '.dsh-memory-tags{display:flex;flex-wrap:wrap;align-items:center;gap:5px;min-width:0;max-width:100%;margin:0;padding:0;list-style:none}',
      '.dsh-memory-row .dsh-memory-tag{flex:0 1 auto;max-width:100%;box-sizing:border-box;height:auto;padding:1px 7px;border:0;border-radius:5px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;white-space:normal;overflow-wrap:anywhere}',
      '.dsh-memory-row-actions{display:flex;flex:0 1 auto;flex-wrap:wrap;gap:2px;align-items:center;max-width:100%;margin-left:auto}',
      '.dsh-memory-row-actions .dsh-memory-button{width:auto;min-height:28px;height:auto;padding:2px 7px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:20px}',
      '.dsh-memory-row-actions .dsh-memory-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2));color:var(--dsw-alias-label-primary)}',
      '.dsh-memory-row-actions .dsh-memory-button-primary{color:var(--dsw-alias-state-business-primary,var(--dsw-alias-label-primary));background:var(--dsw-alias-bg-layer-2)}',
      '.dsh-memory-row-actions .dsh-memory-button[data-danger="true"][data-confirming="true"],.dsh-memory-row-actions .dsh-memory-button[data-danger="true"]:hover:not(:disabled){color:var(--dsw-alias-state-error-primary,var(--dsw-alias-label-error));background:color-mix(in srgb,currentColor 9%,transparent)}',
      '.dsh-memory-row-actions .dsh-memory-button[data-danger="true"]{margin-left:4px}',
      '@container (max-width:480px){.dsh-memory-list{padding-inline:12px}.dsh-memory-row .dsh-memory-row-meta{flex-basis:100%;margin-left:23px}.dsh-memory-row-foot{row-gap:6px}.dsh-memory-row-actions{margin-left:0}.dsh-memory-row-foot>.dsh-memory-tags{flex-basis:100%}}',
      '.dsh-memory-button-primary{background:var(--dsw-alias-state-business-primary,var(--dsw-alias-brand-primary,#2f6df6));border-color:transparent;color:#fff}',
      '.dsh-memory-button-primary:hover{filter:brightness(1.05)}',
      '.dsh-memory-muted{margin:14px 0 0}',
      '.dsh-memory-list-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:16px 0 8px;flex-wrap:wrap}',
      '.dsh-memory-kind-tabs{display:flex;gap:6px;flex-wrap:wrap}',
      '.dsh-memory-list-tools{display:flex;align-items:center;gap:8px;margin-left:auto;flex-wrap:wrap;min-width:0}',
      '.dsh-memory-topic-select{max-width:170px;min-width:110px;font-size:12px}',
      '.dsh-memory-kind-tab{height:26px;padding:0 10px;border-radius:7px;border:.5px solid var(--dsh-memory-card-border);background:var(--dsh-memory-card-bg);color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:24px;cursor:pointer}',
      '.dsh-memory-kind-tab:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.dsh-memory-kind-tab[data-active="true"]{background:var(--dsw-alias-state-business-primary,var(--dsw-alias-brand-primary,#2f6df6));border-color:transparent;color:#fff}',
      '.dsh-memory-kind-count{margin-left:6px;font-size:11px;opacity:.75;font-variant-numeric:tabular-nums}',
      '.dsh-memory-list-total{color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary,#6b7280));font-size:12px}',
      '.dsh-memory-pager{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:14px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary,#6b7280));font-size:12px;flex-wrap:wrap}',
      '.dsh-memory-pager-actions{display:flex;align-items:center;gap:6px}',
      '.dsh-memory-page-size{display:inline-flex;align-items:center;gap:6px}',
      '.dsh-memory-page-select{height:26px}',
      '.dsh-memory-activity-insights{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));margin:16px 0 0;border:.5px solid var(--dsh-memory-card-border);border-radius:10px;overflow:hidden;background:var(--dsw-alias-bg-layer-1,var(--dsh-memory-card-bg))}',
      '.dsh-memory-activity-insights>div{padding:10px 8px 9px;text-align:center;min-width:0}',
      '.dsh-memory-activity-insights>div+div{border-left:.5px solid var(--dsh-memory-card-border)}',
      '.dsh-memory-activity-insights dd{margin:0;font-size:15px;font-weight:600;line-height:21px;font-variant-numeric:tabular-nums}',
      '.dsh-memory-activity-insights dt{margin:2px 0 0;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary,#6b7280));font-size:11px;line-height:16px}',
      '.dsh-memory-profile{margin-top:14px;padding:14px;border:.5px solid var(--dsh-memory-card-border);border-radius:var(--dsh-memory-radius);background:var(--dsh-memory-card-bg)}',
      '.dsh-memory-profile-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:10px}',
      '.dsh-memory-profile-list{display:flex;flex-direction:column;gap:8px;margin:0;padding:0;list-style:none}',
      '.dsh-memory-profile-item{display:flex;align-items:center;gap:8px;min-width:0}',
      '.dsh-memory-profile-statement{flex:1 1 auto;min-width:0;font-size:13px;line-height:1.5;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.dsh-memory-profile-meta{color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary,#6b7280));font-size:11px;white-space:nowrap}',
      '.dsh-memory-kind,.dsh-memory-status-pill,.dsh-memory-tag,.dsh-memory-chip{flex:0 0 auto;white-space:nowrap}',
      '.dsh-memory-profile-statement{min-width:0}',
      '.dsh-memory-profile-meta{flex:0 0 auto}',
      '.dsh-memory-chip{display:inline-flex;align-items:center;gap:5px;flex:0 0 auto;white-space:nowrap}',
      '.dsh-memory-chip-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary,#9ca0a6))}',
      '.dsh-memory-chip[data-on="true"] .dsh-memory-chip-dot{background:var(--dsw-alias-state-success-primary,#22c55e)}',
      '@container (max-width:620px){.dsh-memory-hero-metrics{grid-template-columns:repeat(2,minmax(0,1fr));row-gap:10px}.dsh-memory-hero-metrics .dsh-memory-hero-metric,.dsh-memory-hero-insights .dsh-memory-hero-metric{flex-direction:column;align-items:flex-start;gap:0}}',
      '@container (max-width:479px){.dsh-memory-hero-cards{grid-template-columns:minmax(0,1fr)}.dsh-memory-hero-metrics .dsh-memory-hero-metric,.dsh-memory-hero-insights .dsh-memory-hero-metric{flex-direction:row;align-items:baseline;gap:6px}}',
      '.dsh-memory-hero-insights{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px 12px;width:100%;min-width:0}',
      '.dsh-memory-settings{display:flex;flex-direction:column}',
      '.dsh-memory-settings-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}',
      '.dsh-memory-settings-title{margin:0;font-size:16px;font-weight:600;line-height:24px;color:var(--dsw-alias-label-primary,#1f2328)}',
      '.dsh-memory-settings-sub{margin:3px 0 0;font-size:11.5px;line-height:16px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary,#6b7280))}',
      '.dsh-memory-settings-badge{display:inline-flex;align-items:center;gap:6px;flex:0 0 auto;height:22px;padding:0 9px;border-radius:999px;background:var(--dsw-alias-bg-layer-1,#fff);border:.5px solid var(--dsh-memory-card-border);color:var(--dsw-alias-label-secondary,#6b7280);font-size:11px;white-space:nowrap}',
      '.dsh-memory-settings-badge i{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-success-primary,#34a26b)}',
      '.dsh-memory-settings-badge[data-off="true"] i{background:var(--dsw-alias-label-tertiary,#9ca0a6)}',
      '.dsh-memory-settings-group{margin-top:0}',
      '.dsh-memory-settings-head+.dsh-memory-settings-group{margin-top:20px}',
      '.dsh-memory-settings-group+.dsh-memory-settings-group{padding-top:22px;border-top:.5px solid var(--dsh-memory-card-border)}',
      '.dsh-memory-settings-tabs{display:flex;gap:2px;flex-wrap:wrap;margin:6px 0 10px;padding-bottom:8px;border-bottom:.5px solid var(--dsh-memory-card-border)}',
      '.dsh-memory-settings-tab{border:0;background:transparent;padding:4px 10px;border-radius:7px;font:inherit;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#6b7280);cursor:pointer}',
      '.dsh-memory-settings-tab[data-active="true"]{background:var(--dsw-alias-bg-layer-2,#f5f6f8);color:var(--dsw-alias-label-primary,#1f2328);font-weight:600}',
      '.dsh-memory-settings-group-title{margin:0 0 2px;font-size:11px;font-weight:500;line-height:16px;letter-spacing:.02em;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary,#6b7280))}',
      '.dsh-memory-settings-row{display:flex;align-items:center;justify-content:space-between;gap:16px;box-sizing:border-box;min-height:48px;font-size:13.5px;color:var(--dsw-alias-label-primary,#1f2328)}',
      '.dsh-memory-settings-row+.dsh-memory-settings-row{border-top:.5px solid var(--dsh-memory-card-border)}',
      '.dsh-memory-settings-label{min-width:0;overflow:visible;text-overflow:clip;white-space:normal;flex:1 1 auto}',
      '.dsh-memory-navigation{display:flex;flex-direction:column;gap:12px;margin:0 0 12px;min-width:0}',
      '.dsh-memory-brief{display:flex;flex-direction:column;gap:14px;min-width:0}',
      '.dsh-memory-brief-tools{display:flex;gap:12px;align-items:center;justify-content:space-between;min-width:0}',
      '.dsh-memory-brief-project{display:flex;align-items:center;gap:12px;min-width:0;flex:1}',
      '.dsh-memory-brief-project select{min-width:0;max-width:100%;flex:1}',
      '.dsh-memory-brief-section{margin-top:14px;min-width:0}',
      '.dsh-memory-recall-report{margin:24px 0;min-width:0;overflow-wrap:anywhere}',
      '.dsh-memory-recall-report ul{margin:8px 0;padding-left:20px}',
      '.dsh-memory-recall-report li{margin:6px 0}',
      '.dsh-memory-brief-meta{display:flex;flex-wrap:wrap;gap:6px 12px;font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.dsh-memory-brief-sources{margin-top:8px;font-size:12px;overflow-wrap:anywhere}',
      '.dsh-memory-brief-sources summary{cursor:pointer;color:var(--dsw-alias-label-secondary)}',
      '.dsh-memory-brief-sources blockquote{margin:8px 0;padding:4px 12px;border-left:2px solid var(--dsh-memory-card-border);white-space:pre-wrap}',
      '.dsh-memory-manual-sync{margin-top:24px;padding-top:16px;border-top:1px solid var(--dsh-memory-card-border)}',
      '.dsh-memory-manual-sync summary{cursor:pointer;font-size:13px;font-weight:500}',
      '.dsh-memory-library.dsh-memory-card,.dsh-memory-profile,.dsh-memory-settings.dsh-memory-card{border:0;background:transparent;box-shadow:none;border-radius:0;padding:0;margin-top:0}',
      '.dsh-memory-view-tabs{display:flex;flex-wrap:wrap;width:100%;box-sizing:border-box;gap:4px;padding:0 0 10px;margin:0;border-bottom:1px solid var(--dsh-memory-card-border);background:transparent}',
      '.dsh-memory-subnav{display:flex;flex-wrap:wrap;gap:4px;min-width:0}',
      '.dsh-memory-subnav .dsh-memory-view-tab{font-size:12px;font-weight:400}',
      '.dsh-memory-subnav .dsh-memory-view-tab[data-active="true"]{font-weight:600}',
      '.dsh-memory-navigation .dsh-memory-view-tab:focus-visible{outline:2px solid var(--dsw-alias-label-primary);outline-offset:2px}',
      '@container (max-width:400px){.dsh-memory-navigation .dsh-memory-view-tabs{gap:0;justify-content:space-between}.dsh-memory-navigation .dsh-memory-view-tab{padding-inline:7px}}',
      '.dsh-memory-view-tab{border:0;background:transparent;min-height:28px;padding:5px 9px;border-radius:6px;font:inherit;font-size:13px;font-weight:500;line-height:18px;white-space:nowrap;flex:0 0 auto;color:var(--dsw-alias-label-secondary,#6b7280);cursor:pointer}',
      '.dsh-memory-view-tab[data-active="true"]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary,#1f2328);box-shadow:none}',
      '.dsh-memory-load-row{display:flex;gap:12px;flex-wrap:wrap;font-size:12px}',
      '.dsh-memory-profile-line{display:flex;align-items:baseline;gap:8px;min-width:0}',
      '.dsh-memory-profile-line .dsh-memory-profile-statement{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsh-memory-profile-evidence{list-style:none;margin:4px 0 0 0;padding:0 0 0 28px;display:flex;flex-direction:column;gap:2px;font-size:12px;color:var(--dsw-alias-label-secondary,#6b7280)}',
      '.dsh-memory-settings-input{box-sizing:border-box;flex:0 1 42%;min-width:112px;height:28px;border:.5px solid var(--dsh-memory-card-border);border-radius:7px;padding:0 24px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1f2328);font:inherit;font-size:12px;text-align:center;line-height:30px}',
      '.dsh-memory-settings-control{display:flex;align-items:center;gap:8px;flex:0 0 auto}',
      '.dsh-memory-switch{position:relative;flex:0 0 auto;width:40px;height:22px;padding:0;border:0;border-radius:999px;background:var(--dsw-alias-border-l2,rgba(127,127,127,.35));cursor:pointer;transition:background .18s ease}',
      '.dsh-memory-switch[aria-checked="true"]{background:var(--dsw-alias-label-primary,#111113)}',
      '.dsh-memory-switch-knob{position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:50%;background:var(--dsw-alias-bg-layer-1,#fff);box-shadow:0 1px 2px rgba(16,24,40,.24);transition:transform .18s cubic-bezier(.3,.7,.3,1)}',
      '.dsh-memory-switch[aria-checked="true"] .dsh-memory-switch-knob{transform:translateX(18px)}',
      '.dsh-memory-switch:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#2f6df6);outline-offset:2px}',
      '.dsh-memory-number{display:block;align-items:center;flex:0 0 auto;box-sizing:border-box;height:32px;padding:0;border:.5px solid var(--dsh-memory-card-border);border-radius:8px;background:var(--dsw-alias-bg-layer-1,#fff);position:relative;width:176px;max-width:48%;min-width:124px}',
      '.dsh-memory-number:focus-within{border-color:var(--dsw-alias-state-business-primary,#2f6df6)}',
      '.dsh-memory-number input{box-sizing:border-box;width:100%;height:100%;border:0;background:transparent;color:var(--dsw-alias-label-primary,#1f2328);font:inherit;font-size:13px;text-align:center;outline:none;font-variant-numeric:tabular-nums;padding:0 36px;line-height:30px;appearance:textfield}',
      '.dsh-memory-number em{color:var(--dsw-alias-label-tertiary,#6b7280);font-style:normal;font-size:11px;margin-left:0;position:absolute;right:10px;top:50%;transform:translateY(-50%);pointer-events:none}',
      '.dsh-memory-settings-buttons{display:flex;align-items:center;justify-content:flex-end;gap:8px;flex-wrap:wrap}',
      '.dsh-memory-settings .dsh-memory-button{height:32px;padding:0 12px;font-size:12px;border-radius:8px;min-height:32px}',
      '.dsh-memory-settings-foot{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-top:24px;padding:16px 0 0;border:0;border-radius:0;background:transparent;box-shadow:none;border-top:.5px solid var(--dsh-memory-card-border)}',
      '.dsh-memory-settings-state{display:inline-flex;align-items:center;gap:7px;color:var(--dsw-alias-label-secondary,#6b7280);font-size:12px}',
      '.dsh-memory-settings-state i{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-success-primary,#34a26b)}',
      '.dsh-memory-settings-state[data-dirty="true"] i{background:var(--dsw-alias-state-warning-primary,#d97706)}',
      '.dsh-memory-settings-notice{margin:10px 0 0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#6b7280)}',
      '.dsh-memory-trend{margin-top:20px;padding-top:18px;border-top:.5px solid var(--dsh-memory-card-border)}',
      '.dsh-memory-trend-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;flex-wrap:wrap}',
      '.dsh-memory-trend-title{margin:0;font-size:11px;font-weight:500;line-height:16px;letter-spacing:.02em;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary,#6b7280))}',
      '.dsh-memory-trend-total{font-size:11.5px;line-height:16px;color:var(--dsw-alias-label-secondary,#6b7280);font-variant-numeric:tabular-nums}',
      '.dsh-memory-trend-chart{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:8px;align-items:end;height:88px;margin-top:12px}',
      '.dsh-memory-trend-col{display:flex;flex-direction:column;align-items:center;justify-content:flex-end;gap:6px;height:100%;min-width:0}',
      '.dsh-memory-trend-bars{display:flex;align-items:flex-end;justify-content:center;gap:3px;flex:1 1 auto;width:100%;min-height:0;box-sizing:border-box;padding:0 1px;border-bottom:.5px solid var(--dsh-memory-card-border)}',
      '.dsh-memory-trend-bar{display:block;flex:1 1 0;max-width:12px;min-height:3px;border-radius:3px 3px 0 0;background:color-mix(in srgb,var(--dsw-alias-label-tertiary,#9ca0a6) 18%,transparent)}',
      '.dsh-memory-trend-bar[data-kind="inject"]{background:var(--dsw-alias-state-business-primary,#2f6df6)}',
      '.dsh-memory-trend-bar[data-kind="extract"]{background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#2f6df6) 34%,transparent)}',
      '.dsh-memory-trend-date{font-size:10px;line-height:14px;color:var(--dsw-alias-label-tertiary,#9ca0a6);font-variant-numeric:tabular-nums;white-space:nowrap}',
      '.dsh-memory-trend-empty{margin:12px 0 0;font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-tertiary,#9ca0a6)}',
      '.dsh-memory-trend-legend{display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin-top:10px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary,#6b7280);font-variant-numeric:tabular-nums}',
      '.dsh-memory-trend-note{margin:2px 0 0;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary,#6b7280))}',
      '.dsh-memory-trend-legend span{display:inline-flex;align-items:center;gap:5px}',
      '.dsh-memory-trend-legend i{width:8px;height:8px;border-radius:2px;background:var(--dsw-alias-state-business-primary,#2f6df6)}',
      '.dsh-memory-trend-legend i[data-kind="extract"]{opacity:.34}',
      '.dsh-memory-trend-legend em{font-style:normal;color:var(--dsw-alias-state-warning-primary,#d97706)}',
      '.dsh-memory-select-box{box-sizing:border-box;width:14px;height:14px;margin:0;flex:0 0 auto;accent-color:var(--dsw-alias-state-business-primary,#2f6df6);cursor:pointer}',
      '.dsh-memory-bulk{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;margin:8px 0;padding:8px 10px;border:.5px solid var(--dsh-memory-card-border);border-radius:8px;background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#2f6df6) 6%,transparent);color:var(--dsw-alias-label-secondary,#6b7280);font-size:12px}',
      '.dsh-memory-bulk-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap}',
      '.dsh-memory-history{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:10px;max-height:52vh;overflow:auto}',
      '.dsh-memory-history-item{padding-top:8px;border-top:.5px solid var(--dsh-memory-card-border)}',
      '.dsh-memory-history-item:first-child{padding-top:0;border-top:0}',
      '.dsh-memory-history-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.dsh-memory-library-open{display:flex;flex-direction:column;align-items:stretch;gap:4px;width:100%;box-sizing:border-box;padding:0;border:0;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}',
      '.dsh-memory-library-open:focus-visible{outline:var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary)));outline-offset:3px;border-radius:6px}',
      '.dsh-memory-library-edit{margin-left:auto;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary,#6b7280))}',
      '.dsh-memory-library-file{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary,#6b7280));word-break:break-all}',
      '.dsh-memory-library-notice{margin:8px 0 0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-success-primary,#34a26b)}',
      '.dsh-memory-library-conflict{margin:0;padding:8px 10px;border:.5px solid var(--dsw-alias-state-warning-primary,#d97706);border-radius:8px;background:color-mix(in srgb,var(--dsw-alias-state-warning-primary,#d97706) 8%,transparent);color:var(--dsw-alias-state-warning-primary,#d97706);font-size:12px;line-height:18px}',
      '.dsh-memory-library-body{min-height:200px;font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:12px;line-height:1.6}',
      '.dsh-memory-history-content{margin:4px 0 6px;font-size:13px;line-height:1.45;color:var(--dsw-alias-label-primary,#1f2328);word-break:break-word}',
      '.dsh-memory-history-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}',
      '.dsh-memory-diff{display:flex;flex-direction:column;gap:2px;margin:4px 0 6px;font-size:11.5px;line-height:16px}',
      '.dsh-memory-diff-del{color:var(--dsw-alias-state-danger-primary,#c0392b)}',
      '.dsh-memory-diff-add{color:var(--dsw-alias-state-success-primary,#1a9e63)}',
      '.dsh-memory-file-input{display:none}',
      '.dsh-memory-input,.dsh-memory-select,.dsh-memory-textarea,.dsh-memory-settings-input{border-radius:10px;text-align:center;padding:0 24px}',
      '.dsh-memory-library-head{display:flex;align-items:baseline;justify-content:space-between;gap:10px;flex-wrap:wrap}',
      '.dsh-memory-view-tab:focus-visible,.dsh-memory-palette-trigger:focus-visible,.dsh-memory-palette-option:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}',
      '@container (max-width:560px){.dsh-memory-activity-head{flex-wrap:wrap;row-gap:6px}.dsh-memory-tabs{flex:0 0 auto}.dsh-memory-settings-head{gap:10px}.dsh-memory-settings-row{gap:12px}}',
      '@container (max-width:430px){.dsh-memory-settings-row{min-height:46px}.dsh-memory-settings .dsh-memory-button{height:30px;padding:0 10px;border-radius:8px;min-height:32px}}',
      '@container (max-width:560px){.dsh-memory-activity-head{flex-wrap:wrap;row-gap:6px}.dsh-memory-tabs{flex:0 0 auto}}',
      '.dsh-memory-root>.dsh-memory-card,.dsh-memory-root>.dsh-memory-profile{padding:0;border:0;border-radius:0;background:transparent;box-shadow:none}',
      '.dsh-memory-settings{padding:0;border:0;border-radius:0;background:transparent}',
      '.dsh-memory-settings-head{margin-bottom:16px}',
      '.dsh-memory-toolbar .dsh-memory-input,.dsh-memory-toolbar .dsh-memory-select{width:100%;max-width:none;min-width:0}',
      '.dsh-memory-field-label{font-size:13px;color:var(--dsw-alias-label-primary)}',
      '.dsh-memory-textarea{align-content:center;text-align:center}',
      '.dsh-memory-number input::-webkit-inner-spin-button,.dsh-memory-number input::-webkit-outer-spin-button{appearance:none;margin:0}',
      '.dsh-memory-bulk-actions{display:flex;flex-wrap:wrap;gap:8px;width:100%}',
      '.dsh-memory-danger-actions{display:flex;justify-content:flex-end;flex-basis:100%;margin-top:8px;padding-top:8px;border-top:.5px solid var(--dsh-memory-card-border)}',
      '.dsh-memory-button[data-danger="true"]{color:var(--dsw-alias-state-error-primary)}',
      '.dsh-memory-button[data-danger="true"]:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent);color:var(--dsw-alias-state-error-primary)}',
    ].join('\n')

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

    function Field(props) {
      return h('label', { className: 'dsh-memory-field' + (props.grow === true ? ' dsh-memory-field-grow' : '') },
        h('span', { className: 'dsh-memory-field-label' }, props.label),
        props.children)
    }

    const DAY_MS = 86_400_000
    const HEAT_WEEKS = 53
    const PALETTE_KEY = 'dsh.memory.particle-color.v1'
    const PALETTE_PRESETS = [
      { value: '', key: 'themeColor' },
      { value: '#8b6ccf', key: 'violetColor' },
      { value: '#447fcb', key: 'blueColor' },
      { value: '#369f97', key: 'tealColor' },
      { value: '#c69749', key: 'amberColor' },
      { value: '#ca758f', key: 'roseColor' },
    ]
    const HEAT_MODES = ['daily', 'weekly', 'cumulative']

    function dateKey(date) {
      const month = String(date.getMonth() + 1).padStart(2, '0')
      const day = String(date.getDate()).padStart(2, '0')
      return date.getFullYear() + '-' + month + '-' + day
    }

    function monthShort(date, locale) {
      try {
        return new Intl.DateTimeFormat(locale || undefined, { month: 'short' }).format(date)
      } catch {
        return (date.getMonth() + 1) + '\u6708'
      }
    }

    function compactNumber(value, locale) {
      try {
        return new Intl.NumberFormat(locale || undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(value)
      } catch {
        return String(value)
      }
    }

    function readPalette() {
      try {
        const value = localStorage.getItem(PALETTE_KEY)
        return typeof value === 'string' && /^#[0-9a-f]{6}$/iu.test(value) ? value.toLowerCase() : ''
      } catch {
        return ''
      }
    }

    function writePalette(value) {
      try {
        if (value === '') localStorage.removeItem(PALETTE_KEY)
        else localStorage.setItem(PALETTE_KEY, value)
      } catch {
        // Colour is a cosmetic preference; storage may be unavailable.
      }
    }

    function colorLevel(value, maximum) {
      if (value <= 0 || maximum <= 0) return 0
      return Math.min(5, Math.max(1, Math.ceil((5 * value) / maximum)))
    }

    function logarithmicRows(value, maximum) {
      if (value <= 0 || maximum <= 0) return 0
      const ratio = Math.log1p(value) / Math.log1p(maximum)
      return Math.min(7, Math.max(1, Math.ceil(ratio * 7)))
    }

    function cumulativeRows(value, maximum) {
      if (value <= 0 || maximum <= 0) return 0
      return Math.min(7, Math.max(1, Math.ceil((value / maximum) * 7)))
    }

    function buildHeatWeeks(counts, mode, t) {
      const today = new Date()
      today.setHours(0, 0, 0, 0)
      const first = new Date(today.getTime() - (HEAT_WEEKS * 7 - 1) * DAY_MS)
      first.setHours(0, 0, 0, 0)
      first.setDate(first.getDate() - first.getDay())
      const daily = []
      for (let week = 0; week < HEAT_WEEKS; week += 1) {
        const days = []
        for (let row = 0; row < 7; row += 1) {
          const date = new Date(first)
          date.setDate(first.getDate() + week * 7 + row)
          if (date.getTime() > today.getTime()) {
            days.push(null)
            continue
          }
          const key = dateKey(date)
          days.push({ key, count: counts.get(key) ?? 0 })
        }
        daily.push(days)
      }
      if (mode === 'daily') {
        const maximum = Math.max(0, ...daily.flat().filter((cell) => cell !== null).map((cell) => cell.count))
        return daily.map((days) => ({
          tip: null,
          cells: days.map((cell) => (cell === null ? null : { ...cell, level: colorLevel(cell.count, maximum) })),
        }))
      }
      if (mode === 'weekly') {
        const totals = daily.map((days) => days.reduce((sum, cell) => sum + (cell === null ? 0 : cell.count), 0))
        const maximum = Math.max(0, ...totals)
        return daily.map((days, index) => {
          const value = totals[index]
          const level = colorLevel(value, maximum)
          const filled = logarithmicRows(value, maximum)
          const present = days.filter((cell) => cell !== null)
          const start = present[0] === undefined ? '' : present[0].key
          const end = present[present.length - 1] === undefined ? '' : present[present.length - 1].key
          return {
            tip: value <= 0 ? null : t('activity.weeklyTooltip', { start, end, count: compactNumber(value) }),
            cells: days.map((cell, row) => (cell === null ? null : { ...cell, level: row >= 7 - filled ? level : 0 })),
          }
        })
      }
      const totals = daily.map((days) => days.reduce((sum, cell) => sum + (cell === null ? 0 : cell.count), 0))
      let running = 0
      const cumulative = totals.map((value) => {
        running += value
        return running
      })
      const maximum = Math.max(0, ...cumulative)
      return daily.map((days, index) => {
        const value = cumulative[index]
        const level = colorLevel(value, maximum)
        const filled = cumulativeRows(value, maximum)
        const present = days.filter((cell) => cell !== null)
        const end = present[present.length - 1] === undefined ? '' : present[present.length - 1].key
        return {
          tip: value <= 0 ? null : t('activity.cumulativeTooltip', { end, count: compactNumber(value) }),
          cells: days.map((cell, row) => (cell === null ? null : { ...cell, level: row >= 7 - filled ? level : 0 })),
        }
      })
    }

    function computeStreak(counts) {
      const today = new Date()
      today.setHours(0, 0, 0, 0)
      let cursor = today.getTime()
      if (!counts.has(dateKey(today))) cursor -= DAY_MS
      let streak = 0
      while (streak < 400) {
        const key = dateKey(new Date(cursor))
        if (!counts.has(key)) break
        streak += 1
        cursor -= DAY_MS
      }
      return streak
    }

    function HeroMetrics(props) {
      const { stats, t } = props
      const rows = [
        [t('stats.active'), stats === null ? '\u2014' : String(stats.active)],
        [t('stats.candidate'), stats === null ? '\u2014' : String(stats.candidate)],
        [t('stats.total'), stats === null ? '\u2014' : String(stats.total)],
        [t('stats.projects'), stats === null ? '\u2014' : String(stats.projects)],
      ]
      return h('div', { className: 'dsh-memory-hero-metrics' },
        rows.map(([label, value]) => h('div', { key: label, className: 'dsh-memory-hero-metric' },
          h('b', null, value),
          h('span', null, label))))
    }

    function computeInsights(activity, stats) {
      const counts = new Map()
      const days = activity !== null && activity !== undefined && Array.isArray(activity.days) ? activity.days : []
      for (const day of days) {
        if (day === null || typeof day !== 'object' || typeof day.date !== 'string') continue
        const count = Number(day.count)
        if (!Number.isFinite(count) || count <= 0) continue
        counts.set(day.date, count)
      }
      const today = new Date()
      today.setHours(0, 0, 0, 0)
      let last7 = 0
      for (let index = 0; index < 7; index += 1) {
        const date = new Date(today)
        date.setDate(today.getDate() - index)
        last7 += counts.get(dateKey(date)) ?? 0
      }
      return {
        streak: computeStreak(counts),
        activeDays: counts.size,
        last7,
        averageConfidence: stats !== null && stats !== undefined && typeof stats.avgConfidence === 'number'
          ? stats.avgConfidence.toFixed(2)
          : '\u2014',
      }
    }

    function HeroInsights(props) {
      const { activity, stats, t, locale } = props
      const insights = computeInsights(activity, stats)
      const rows = [
        [t('activity.streak'), String(insights.streak)],
        [t('activity.activeDays'), compactNumber(insights.activeDays, locale)],
        [t('activity.last7'), compactNumber(insights.last7, locale)],
        [t('activity.avgConfidence'), insights.averageConfidence],
      ]
      return h('div', { className: 'dsh-memory-hero-insights' },
        rows.map(([label, value]) => h('div', { key: label, className: 'dsh-memory-hero-metric' },
          h('b', null, value),
          h('span', null, label))))
    }

    function PalettePicker(props) {
      const { color, onColor, t } = props
      const [open, setOpen] = React.useState(false)
      const rootRef = React.useRef(null)
      React.useEffect(() => {
        if (!open) return undefined
        const onPointerDown = (event) => {
          if (rootRef.current !== null && !rootRef.current.contains(event.target)) setOpen(false)
        }
        const onKeyDown = (event) => {
          if (event.key === 'Escape') setOpen(false)
        }
        document.addEventListener('mousedown', onPointerDown)
        document.addEventListener('keydown', onKeyDown)
        return () => {
          document.removeEventListener('mousedown', onPointerDown)
          document.removeEventListener('keydown', onKeyDown)
        }
      }, [open])
      return h('div', { className: 'dsh-memory-palette', ref: rootRef },
        h('button', {
          type: 'button',
          className: 'dsh-memory-palette-trigger',
          'aria-expanded': open,
          'aria-haspopup': 'listbox',
          onClick: () => setOpen((value) => !value),
          title: t('activity.colorMenu'),
        },
        h('span', { className: 'dsh-memory-palette-swatch', style: { '--dsh-memory-swatch': color === '' ? 'var(--dsw-alias-state-business-primary, #2f6df6)' : color } },
          h('i', null), h('i', null), h('i', null)),
        t('activity.colorMenu')),
        open ? h('div', { className: 'dsh-memory-palette-menu', role: 'listbox', 'aria-label': t('activity.colorMenu') },
          PALETTE_PRESETS.map((preset) => h('button', {
            key: preset.key,
            type: 'button',
            role: 'option',
            'aria-selected': preset.value === color,
            className: 'dsh-memory-palette-option',
            onClick: () => {
              onColor(preset.value)
              setOpen(false)
            },
          },
          preset.value === '' ? h('span', { className: 'dsh-memory-palette-theme' }, '\u25d1') : h('i', { className: 'dsh-memory-palette-dot', style: { background: preset.value } }),
          t('activity.' + preset.key))),
          h('label', { className: 'dsh-memory-palette-option' },
            h('input', {
              type: 'color',
              className: 'dsh-memory-color-input',
              value: color === '' ? '#2f6df6' : color,
              onChange: (event) => onColor(event.target.value),
            }),
            t('activity.customColor'))) : null)
    }

    function ActivityHeatmap(props) {
      const { activity, stats, t, locale } = props
      const [mode, setMode] = React.useState('daily')
      const [color, setColor] = React.useState(readPalette)
      const [tooltip, setTooltip] = React.useState(null)
      const stageRef = React.useRef(null)
      const counts = new Map()
      const days = activity !== null && activity !== undefined && Array.isArray(activity.days) ? activity.days : []
      let total = 0
      for (const day of days) {
        if (day === null || typeof day !== 'object' || typeof day.date !== 'string') continue
        const count = Number(day.count)
        if (!Number.isFinite(count) || count <= 0) continue
        counts.set(day.date, count)
        total += count
      }
      const weeks = buildHeatWeeks(counts, mode, t)
      const labels = []
      let lastMonth = ''
      for (let week = 0; week < weeks.length; week += 1) {
        const firstCell = weeks[week].cells.find((cell) => cell !== null)
        if (firstCell === undefined) continue
        const month = firstCell.key.slice(0, 7)
        if (month === lastMonth) continue
        const isFirst = lastMonth === ''
        lastMonth = month
        if (isFirst) continue
        const sunday = new Date(firstCell.key + 'T00:00:00')
        labels.push({ week, text: monthShort(sunday, locale) })
      }
      const showTooltip = (event, column, cell) => {
        const stage = stageRef.current
        if (stage === null) return
        const rect = event.currentTarget.getBoundingClientRect()
        const stageRect = stage.getBoundingClientRect()
        const text = column.tip === null || column.tip === undefined
          ? t('activity.cell', { date: cell.key, count: String(cell.count) })
          : column.tip
        const maxWidth = Math.min(240, stageRect.width - 16)
        const half = maxWidth / 2
        const center = rect.left - stageRect.left + rect.width / 2
        const x = stageRect.width > maxWidth + 16
          ? Math.min(Math.max(center, 8 + half), stageRect.width - 8 - half)
          : stageRect.width / 2
        const above = rect.top - stageRect.top > 34
        const top = above ? rect.top - stageRect.top - 28 : rect.bottom - stageRect.top + 6
        setTooltip({ x, top, text })
      }
      return h('section', { className: 'dsh-memory-activity dsh-memory-card', 'aria-label': t('activity.title'), style: { '--dsh-memory-particle-color': color === '' ? 'var(--dsw-alias-state-business-primary, #2f6df6)' : color } },
        h('div', { className: 'dsh-memory-activity-head' },
          h('div', { className: 'dsh-memory-activity-title' },
            h('h3', null, t('activity.title')),
            h(PalettePicker, { color, onColor: (next) => { setColor(next); writePalette(next) }, t })),
          h('div', { className: 'dsh-memory-tabs', role: 'tablist', 'aria-label': t('activity.title') },
            HEAT_MODES.map((item) => h('button', {
              key: item,
              type: 'button',
              role: 'tab',
              'aria-selected': mode === item,
              onClick: () => setMode(item),
            }, t('activity.mode.' + item))))),
        h('div', { className: 'dsh-memory-heatmap-stage', ref: stageRef },
          h('div', { className: 'dsh-memory-heatmap' },
            weeks.map((column, week) => column.cells.map((cell, row) => (cell === null
              ? h('span', { key: week + ':' + row, className: 'dsh-memory-heat-cell', 'data-level': '0', 'data-future': 'true' })
              : h('span', {
                key: week + ':' + row,
                className: 'dsh-memory-heat-cell',
                'data-level': String(cell.level),
                onMouseEnter: (event) => showTooltip(event, column, cell),
                onMouseLeave: () => setTooltip(null),
                'aria-label': t('activity.cell', { date: cell.key, count: String(cell.count) }),
              }))))),
          tooltip === null ? null : h('div', { className: 'dsh-memory-heat-tooltip', style: { left: tooltip.x, top: tooltip.top } }, tooltip.text)),
        h('div', { className: 'dsh-memory-heat-months' },
          labels.map((label) => h('span', { key: label.week, style: { gridColumn: String(label.week + 1) } }, label.text))),
        counts.size < 7 ? h('p', { className: 'dsh-memory-activity-hint' }, t('activity.sparseHint')) : null)
    }

    function RecallReport({ report, t, locale, call, onSaved }) {
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')
      const forget = async evidence => {
        if (busy || !call || !window.confirm(t('recall.forgetConfirm'))) return
        setBusy(true); setError('')
        try { await call('removeMemory', { id: evidence.id, scope: 'project', projectKey: evidence.projectKey }); await onSaved?.() }
        catch (failure) { setError(messageOf(failure)) }
        finally { setBusy(false) }
      }
      if (!report) return h('section', { className: 'dsh-memory-recall-report' },
        h('h3', { className: 'dsh-memory-settings-title' }, t('recall.title')),
        h('p', { className: 'dsh-memory-muted' }, t('recall.empty')))
      const stateKey = { 'not-needed': 'local', completed: 'completed', failed: 'failed', unknown: 'unknown', 'budget-exhausted': 'budget' }[report.completionState] ?? 'notSent'
      const sent = ['completed', 'unknown', 'requested'].includes(report.providerState)
      const tokens = report.usage?.totalTokens
      const missing = report.unresolved ?? report.missing ?? []
      const evidenceList = items => items.map((item, index) => {
        const evidenceNodes = (item.evidence ?? []).map(evidence => {
          const quotes = (evidence.sourceRefs ?? []).filter(ref => typeof ref.excerpt === 'string' && ref.excerpt !== '')
          return h('div', { key: evidence.id },
            evidence.noteTitle ? h('p', null, evidence.noteTitle) : null,
            quotes.map((ref, refIndex) => h('blockquote', { key: refIndex }, ref.excerpt)),
            !evidence.noteTitle && quotes.length === 0 ? h('p', { className: 'dsh-memory-muted' }, t('brief.noQuote')) : null,
            evidence.kind === 'source' ? h('div', { className: 'dsh-memory-danger-actions' }, h('button', { type: 'button', className: 'dsh-memory-button', 'data-danger': 'true', disabled: busy, onClick: () => forget(evidence) }, t('recall.forgetSource'))) : null)
        })
        return h('li', { key: index }, item.query,
          h('details', { className: 'dsh-memory-brief-sources' }, h('summary', null, t('brief.sources')), evidenceNodes))
      })
      const found = evidenceList(report.covered ?? [])
      const candidates = evidenceList(report.candidates ?? [])
      return h('section', { className: 'dsh-memory-recall-report' },
        h('h3', { className: 'dsh-memory-settings-title' }, t('recall.title')),
        h('p', { className: 'dsh-memory-brief-meta' },
          Number.isFinite(report.at) ? h('time', { dateTime: new Date(report.at).toISOString() }, new Date(report.at).toLocaleString(locale)) : null,
          h('span', null, t('recall.' + stateKey)),
          sent && report.provider?.model ? h('span', null, report.provider.model) : null,
          sent ? h('span', null, Number.isFinite(tokens) ? t('recall.usage', { tokens: String(tokens) }) : t('recall.usageUnknown')) : null),
        error ? h('p', { role: 'alert', className: 'dsh-memory-error-text' }, error) : null,
        report.reason ? h('p', { className: 'dsh-memory-muted' }, report.reason) : null,
        Number.isInteger(report.total) ? h('p', null, t('recall.coverage', { covered: String(found.length), total: String(report.total) })) : null,
        found.length ? h('div', null, h('strong', null, t('recall.found')), h('ul', null, found)) : null,
        candidates.length ? h('div', null, h('strong', null, t('recall.candidates')), h('ul', null, candidates)) : null,
        (report.budgetOmitted ?? []).length ? h('div', null,
          h('strong', null, t('recall.budgetOmitted')),
          h('ul', null, report.budgetOmitted.map((query, index) => h('li', { key: index }, query)))) : null,
        missing.length ? h('div', null,
          h('strong', null, t('recall.missing')),
          h('ul', null, missing.map((query, index) => h('li', { key: index }, query)))) : null)
    }

    function ProjectBrief({ call, projectKeys, initialProject, t, locale }) {
      const [project, setProject] = React.useState(initialProject ?? '')
      const [offset, setOffset] = React.useState(0)
      const [result, setResult] = React.useState(null)
      const [error, setError] = React.useState('')
      const [loading, setLoading] = React.useState(false)
      const [refresh, setRefresh] = React.useState(0)
      const options = [...new Set([...projectKeys, ...(initialProject ? [initialProject] : [])])]
      React.useEffect(() => {
        if (!project && initialProject) setProject(initialProject)
      }, [project, initialProject])
      React.useEffect(() => {
        if (!call || !project) return undefined
        let cancelled = false
        setLoading(true); setError(''); setResult(null)
        call('projectBrief', { projectKey: project, offset, limit: 40 })
          .then(next => { if (!cancelled) setResult(next) })
          .catch(failure => { if (!cancelled) setError(messageOf(failure)) })
          .finally(() => { if (!cancelled) setLoading(false) })
        return () => { cancelled = true }
      }, [call, project, offset, refresh])
      const sectionNodes = (result?.sections ?? []).map(section => {
        const items = section.items.map(item => {
          const statusKey = item.status !== 'active' ? 'status.' + item.status
            : Number.isFinite(item.validTo) && item.validTo <= Date.now() ? 'brief.expired'
              : Number.isFinite(item.validFrom) && item.validFrom > Date.now() ? 'brief.pending' : 'status.active'
          const sources = (item.sourceRefs ?? []).map((ref, index) => h('div', { key: index },
            ref.excerpt ? h('blockquote', null, ref.excerpt) : h('p', null, t('brief.noQuote')),
            h('p', { className: 'dsh-memory-muted' }, [ref.role === 'user' ? t('brief.user') : ref.role, ref.sessionId].filter(Boolean).join(' · '))))
          return h('li', { key: item.id, className: 'dsh-memory-history-item' },
            h('p', { className: 'dsh-memory-history-content' }, item.content),
            h('div', { className: 'dsh-memory-brief-meta' },
              h('span', null, t(statusKey)),
              Number.isFinite(item.validFrom) ? h('span', null, t('brief.since', { time: formatTime(item.validFrom, locale) })) : null,
              Number.isFinite(item.validTo) ? h('span', null, t('brief.until', { time: formatTime(item.validTo, locale) })) : null),
            h('details', { className: 'dsh-memory-brief-sources' },
              h('summary', null, t('brief.sources')),
              sources.length ? sources : h('p', { className: 'dsh-memory-muted' }, t('brief.noQuote'))))
        })
        return h('section', { key: section.id, className: 'dsh-memory-brief-section' },
          h('h3', { className: 'dsh-memory-settings-title' }, t('brief.' + section.id)),
          h('ul', { className: 'dsh-memory-history' }, items))
      })
      return h('section', { className: 'dsh-memory-brief' },
        h('div', { className: 'dsh-memory-brief-tools' },
          h('label', { className: 'dsh-memory-brief-project' }, t('brief.project'),
            h('select', { className: 'dsh-memory-select', value: project, title: project, onChange: event => { setProject(event.target.value); setOffset(0) } },
              !project ? h('option', { value: '' }, t('brief.choose')) : null,
              options.map(key => h('option', { key, value: key }, key)))),
          h('button', { type: 'button', className: 'dsh-memory-button', disabled: loading || !project, onClick: () => setRefresh(value => value + 1) }, t('actions.refresh'))),
        h('p', { className: 'dsh-memory-muted' }, t('brief.hint')),
        loading ? h('p', { role: 'status', className: 'dsh-memory-muted' }, t('list.loading')) : null,
        error ? h('p', { role: 'alert', className: 'dsh-memory-error-text' }, error) : null,
        !project ? h('p', { className: 'dsh-memory-muted' }, t('error.missingProject')) : null,
        result?.total === 0 ? h('p', { className: 'dsh-memory-muted' }, t('brief.empty')) : null,
        sectionNodes,
        result ? h('div', { className: 'dsh-memory-pager' },
          h('span', null, t('pager.total', { total: String(result.total) })),
          h('div', { className: 'dsh-memory-pager-actions' },
            h('button', { type: 'button', className: 'dsh-memory-button', disabled: offset === 0 || loading, onClick: () => setOffset(Math.max(0, offset - 40)) }, t('pager.prev')),
            h('button', { type: 'button', className: 'dsh-memory-button', disabled: result.nextOffset == null || loading, onClick: () => setOffset(result.nextOffset) }, t('pager.next')))) : null)
    }

    function ProfileView(props) {
      const { profile, t } = props
      const traits = profile !== null && profile !== undefined && Array.isArray(profile.traits) ? profile.traits : []
      const total = typeof profile?.total === 'number' ? profile.total : traits.length
      return h('section', { className: 'dsh-memory-card dsh-memory-profile' },
        h('div', { className: 'dsh-memory-profile-head' },
          h('h3', { className: 'dsh-memory-activity-title' }, t('profile.title')),
          h('span', { className: 'dsh-memory-list-total' }, t('profile.summary', { count: String(total) }))),
        h('p', { className: 'dsh-memory-muted' }, t('profile.hint')),
        traits.length === 0
          ? h('p', { className: 'dsh-memory-muted' }, t('profile.empty'))
          : h('ul', { className: 'dsh-memory-profile-list' },
            traits.map((trait) => h('li', { key: trait.id, className: 'dsh-memory-profile-item' },
              h('div', { className: 'dsh-memory-profile-line' },
                h('span', { className: 'dsh-memory-kind', 'data-kind': trait.kind }, t('kind.' + trait.kind)),
                h('span', { className: 'dsh-memory-profile-statement', title: trait.statement }, trait.statement),
                h('span', { className: 'dsh-memory-profile-meta' },
                  t('profile.evidence', { count: String(trait.evidenceCount) }),
                  ' · ',
                  Number(trait.confidence).toFixed(2))),
              Array.isArray(trait.evidence) && trait.evidence.length > 0
                ? h('ul', { className: 'dsh-memory-profile-evidence' }, trait.evidence.slice(0, 3).map((item) => h('li', { key: item.id }, item.content)))
                : null))))
    }

    function ProfileCard(props) {
      const { profile, t } = props
      const traits = profile !== null && profile !== undefined && Array.isArray(profile.traits) ? profile.traits : []
      if (traits.length === 0) return null
      const total = typeof profile.total === 'number' ? profile.total : traits.length
      return h('section', { className: 'dsh-memory-card dsh-memory-profile' },
        h('div', { className: 'dsh-memory-profile-head' },
          h('h3', { className: 'dsh-memory-activity-title' }, t('profile.title')),
          h('span', { className: 'dsh-memory-list-total' }, t('profile.summary', { count: String(total) }))),
        h('ul', { className: 'dsh-memory-profile-list' },
          traits.slice(0, 3).map((trait) => h('li', { key: trait.id, className: 'dsh-memory-profile-item' },
            h('span', { className: 'dsh-memory-kind', 'data-kind': trait.kind }, t('kind.' + trait.kind)),
            h('span', { className: 'dsh-memory-profile-statement', title: trait.statement }, trait.statement),
            h('span', { className: 'dsh-memory-profile-meta' },
              t('profile.evidence', { count: String(trait.evidenceCount) }),
              ' · ',
              Number(trait.confidence).toFixed(2))))))
    }

    function timeNowText() {
      const now = new Date()
      return String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0')
    }

    /** Seven-day injection/extraction token bars (capture tab only). */
    function TokenTrend(props) {
      const { usage, t } = props
      const days = usage !== null && usage !== undefined && Array.isArray(usage.days) ? usage.days : []
      const totals = usage !== null && usage !== undefined && usage.totals !== null && typeof usage.totals === 'object' ? usage.totals : {}
      const number = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
      const tokensOf = (day, kind) => {
        if (day === null || day === undefined || day[kind] === null || day[kind] === undefined) return 0
        return number(day[kind].tokens)
      }
      const injectTokens = number(totals.injectTokens)
      const extractTokens = number(totals.extractTokens)
      const total = injectTokens + extractTokens
      const max = days.reduce((peak, day) => Math.max(peak, tokensOf(day, 'inject'), tokensOf(day, 'extract')), 0)
      const barHeight = (value) => (value <= 0 ? '0px' : Math.max(3, Math.round((value / Math.max(1, max)) * 60)) + 'px')
      const overBudget = number(totals.overBudget)
      const chart = days.length === 0 || total === 0
        ? h('p', { className: 'dsh-memory-trend-empty' }, t('usage.empty'))
        : h('div', { className: 'dsh-memory-trend-chart', role: 'img', 'aria-label': t('usage.total', { tokens: String(total) }) },
          days.map((day) => h('div', {
            key: day.date,
            className: 'dsh-memory-trend-col',
            title: t('usage.day', {
              date: String(day.date ?? ''),
              inject: String(tokensOf(day, 'inject')),
              extract: String(tokensOf(day, 'extract')),
            }),
          },
          h('div', { className: 'dsh-memory-trend-bars' },
            h('i', { className: 'dsh-memory-trend-bar', 'data-kind': 'inject', style: { height: barHeight(tokensOf(day, 'inject')) } }),
            h('i', { className: 'dsh-memory-trend-bar', 'data-kind': 'extract', style: { height: barHeight(tokensOf(day, 'extract')) } })),
          h('span', { className: 'dsh-memory-trend-date' }, String(day.date ?? '').slice(5).replace('-', '/')))))
      return h('div', { className: 'dsh-memory-trend' },
        h('div', { className: 'dsh-memory-trend-head' },
          h('h4', { className: 'dsh-memory-trend-title' }, t('usage.title')),
          h('span', { className: 'dsh-memory-trend-total' }, t('usage.total', { tokens: String(total) }))),
        chart,
        total === 0
          ? null
          : h('div', { className: 'dsh-memory-trend-legend' },
            h('span', null, h('i', { 'data-kind': 'inject' }), t('usage.inject') + ' ' + String(injectTokens)),
            h('span', null, h('i', { 'data-kind': 'extract' }), t('usage.extract') + ' ' + String(extractTokens)),
            h('span', null, t('usage.avg', {
              tokens: String(number(totals.injectCalls) === 0 ? 0 : Math.round(injectTokens / number(totals.injectCalls))),
            })),
            overBudget > 0 ? h('em', null, t('usage.overBudget', { count: String(overBudget) })) : null),
        usage === null || usage === undefined
          ? null
          : h('p', { className: 'dsh-memory-trend-note' }, number(totals.extractProviderCalls) > 0
            ? t('usage.provider', {
              calls: String(totals.extractProviderCalls),
              input: String(totals.extractProviderInputTokens ?? '—'),
              output: String(totals.extractProviderOutputTokens ?? '—'),
              total: String(totals.extractProviderTotalTokens ?? '—'),
            })
            : t('usage.providerMissing')))
    }

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
        h('p',{className:'dsh-memory-muted',role:'status'},status?.at?t('obsidian.syncStatus',{time:new Date(status.at).toLocaleTimeString(),sent:status.exported,received:status.imported,conflicts:status.conflicts.length}):t('obsidian.notYet')),
        h('button',{type:'button',className:'dsh-memory-button',disabled:disabled||busy||!call,onClick:()=>action('obsidianSync')},t('obsidian.now')),
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
      const { stats, call, t, locale, onSaved, group = 'capture' } = props
      const [capture, setCapture] = React.useState(true)
      const [inject, setInject] = React.useState(true)
      const [budget, setBudget] = React.useState('360')
      const [retention, setRetention] = React.useState('90')
      const [maintenance, setMaintenance] = React.useState(true)
      const [obsidianVault, setObsidianVault] = React.useState('')
      const [obsidianAuto, setObsidianAuto] = React.useState(false)
      const [obsidianFolder, setObsidianFolder] = React.useState('DSH Memory')
      const [baseline, setBaseline] = React.useState(null)
      const [savedAt, setSavedAt] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [retrying, setRetrying] = React.useState(false)
      const [notice, setNotice] = React.useState('')
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
      const last = stats === null ? null : stats.maintenance
      const injection = stats === null || stats.lastInjection === null || stats.lastInjection === undefined ? null : stats.lastInjection
      const extraction = stats === null || stats.lastExtraction === null || stats.lastExtraction === undefined ? null : stats.lastExtraction
      const captureQueue = stats === null || stats.capture === null || stats.capture === undefined ? null : stats.capture
      const captureStorage = stats === null || stats.captureStorage === null || stats.captureStorage === undefined ? null : stats.captureStorage
      const usage = (injection === null
        ? ''
        : ' · ' + t('settings.inject.usage', { tokens: String(injection.tokens ?? 0), budget: String(injection.budget ?? 360) })) +
        (extraction === null ? '' : ' · ' + t('settings.extract.usage', { tokens: String(extraction.promptTokens ?? 0) }))
      const summary = (maintenance
        ? (last === null || last === undefined
          ? t('settings.maintenance.none')
          : t('settings.maintenance.summary', { archived: String(last.archived ?? 0), pruned: String(last.pruned ?? 0) }))
        : t('settings.maintenance.off')) + usage
      const stateText = dirty
        ? t('settings.state.dirty')
        : (savedAt === '' ? t('settings.state.saved') : t('settings.state.savedAt', { time: savedAt }))

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
          setSavedAt(timeNowText())
          setNotice(t('settings.saved'))
          onSaved()
        } catch (failure) {
          setNotice(t('settings.failed', { reason: messageOf(failure) }))
        } finally {
          setBusy(false)
        }
      }
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

      return h('section', { className: 'dsh-memory-card dsh-memory-settings' },
        stats?.settingsIssue ? h('p', { className: 'dsh-memory-error', role: 'alert' }, stats.settingsIssue.message) : null,
        (group === 'activity' || group === 'retention') && stats?.maintenance?.backupError ? h('p', { className: 'dsh-memory-error', role: 'alert' }, stats.maintenance.backupError.message) : null,
        h('div', { className: 'dsh-memory-settings-head' },
          h('div', null,
            h('h3', { className: 'dsh-memory-settings-title' }, t('view.' + group))),
          group === 'retention' ? h('span', { className: 'dsh-memory-settings-badge', 'data-off': maintenance ? 'false' : 'true' },
            h('i', null),
            maintenance ? t('settings.badge.on') : t('settings.badge.off')) : null),
        group === 'capture'
          ? h('div', { className: 'dsh-memory-settings-group' },
            switchRow(t('settings.capture'), capture, setCapture),
            switchRow(t('settings.inject'), inject, setInject),
            numberRow(t('settings.budget'), budget, 'token', '100', '8000', '50', (event) => setBudget(event.target.value)))
          : group === 'activity' ? h('div', { className: 'dsh-memory-settings-group' },
            captureQueue === null
              ? null
              : h('div', { className: 'dsh-memory-settings-row' },
                h('span', { className: 'dsh-memory-settings-label' }, t('settings.captureQueue', {
                  pending: String(captureQueue.pending ?? 0),
                  partial: String(captureQueue.partial ?? 0),
                  unknown: String(captureQueue.unknown ?? 0),
                  failed: String(captureQueue.failed ?? 0),
                  done: String(captureQueue.done ?? 0),
                })),
                (captureQueue.unknown ?? 0) + (captureQueue.failed ?? 0) + (captureQueue.pending ?? 0) + (captureQueue.partial ?? 0) > 0
                  ? h('button', { type: 'button', className: 'dsh-memory-button', onClick: retryCapture, disabled: retrying }, t('settings.captureRetry'))
                  : null),
            stats?.captureBudget ? h('div', { role: 'status' },
              h('p', { className: 'dsh-memory-muted' }, t('settings.captureAllowance', stats.captureBudget)),
              stats.captureBudget.waiting > 0 ? h('p', { className: 'dsh-memory-muted' },
                t(stats.captureBudget.resumeAt ? 'settings.captureResume' : 'settings.capturePaused', {
                  count: stats.captureBudget.waiting, time: formatTime(stats.captureBudget.resumeAt, locale),
                })) : null) : null,
            captureStorage === null
              ? null
              : h('div', { className: 'dsh-memory-settings-row' },
                h('span', { className: 'dsh-memory-settings-label' }, t('settings.captureStorage', {
                  sources: String(captureStorage.sources?.count ?? 0),
                  size: String(((captureStorage.bytes ?? 0) / 1024 / 1024).toFixed(1)) + ' MB',
                  tasks: String(captureStorage.tasks ?? 0),
                }))),
            h(TokenTrend, { usage: stats === null ? null : stats.usage, t }))
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
                    }))))
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
        group === 'activity' || group === 'data' ? null : h('div', { className: 'dsh-memory-settings-foot' },
          h('span', { className: 'dsh-memory-settings-state', 'data-dirty': dirty ? 'true' : 'false' },
            h('i', null),
            stateText),
          h('button', {
            type: 'button',
            className: 'dsh-memory-button dsh-memory-button-primary',
            onClick: save,
            disabled: busy || !dirty,
          }, busy ? t('settings.saving') : t('settings.save'))))
    }

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
      const titleId = React.useId()

      const close = () => {
        setEditing(false)
        setNote(null)
        setDraft(null)
        setNoteError('')
        setConflict(false)
        setOpening(false)
      }

      React.useEffect(() => {
        if (!editing) return undefined
        const onKeyDown = (event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            close()
          }
        }
        document.addEventListener('keydown', onKeyDown)
        return () => document.removeEventListener('keydown', onKeyDown)
      }, [editing])

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
          h(Field, { label: t('library.recallScope') },
            h('select', { className: 'dsh-memory-select', value: draft.scope, 'aria-label': t('library.recallScope'),
              onChange: event => setDraft({ ...draft, scope: event.target.value, projectKey: event.target.value === 'project' ? draft.projectKey : '' }) },
              ['unbound','project','global'].map(scope => h('option', { key: scope, value: scope }, t('library.scope.' + scope))))),
          draft.scope === 'project' ? h(Field, { label: t('brief.project') },
            h('select', { className: 'dsh-memory-select', value: draft.projectKey, 'aria-label': t('brief.project'),
              onChange: event => setDraft({ ...draft, projectKey: event.target.value }) },
              h('option', { value: '' }, t('brief.choose')),
              [...new Set([...projectKeys, ...(draft.projectKey ? [draft.projectKey] : [])])].map(key => h('option', { key, value: key }, key)))) : null,
          h('p', { className: 'dsh-memory-muted' }, t('library.scopeHint')),
          h(Field, { label: t('library.bodyField') },
            h('textarea', {
              className: 'dsh-memory-textarea dsh-memory-library-body',
              rows: 10,
              value: draft.body,
              onChange: (event) => setDraft({ ...draft, body: event.target.value }),
            })),
          h('p', { className: 'dsh-memory-muted' }, t('library.bodyHint')),
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
        ? h('div', {
          className: 'dsh-memory-overlay',
          onMouseDown: (event) => {
            if (event.target === event.currentTarget) close()
          },
        },
        h('div', { className: 'dsh-memory-modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId },
          h('h3', { className: 'dsh-memory-modal-title', id: titleId }, t('library.editorTitle')),
          note === null ? null : h('p', { className: 'dsh-memory-library-file' }, note.file),
          opening
            ? h('p', { className: 'dsh-memory-muted', role: 'status' }, t('library.loading'))
            : editor === null
              ? h('div', null,
                noteError === '' ? null : h('p', { className: 'dsh-memory-error-text', role: 'alert' }, noteError),
                h('div', { className: 'dsh-memory-modal-actions' },
                  h('button', { type: 'button', className: 'dsh-memory-button', onClick: close }, t('actions.cancel'))))
              : editor))
        : null

      return h('section', { className: 'dsh-memory-card dsh-memory-library' },
        h('div', { className: 'dsh-memory-library-head' },
          h('h3', { className: 'dsh-memory-settings-title' }, t('library.title')),
          h('span', { className: 'dsh-memory-list-total' }, t('library.total', { count: String(notes.length) }))),
        h('p', { className: 'dsh-memory-muted' }, t('library.hint')),
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
                h('span', { className: 'dsh-memory-history-head' },
                  h('strong', null, note.title),
                  note.topic === null ? null : h('span', { className: 'dsh-memory-tag' }, note.topic),
                  h('span', { className: 'dsh-memory-library-edit' }, t('library.edit'))),
                h('span', { className: 'dsh-memory-muted' }, t('library.scope.' + (note.scope ?? 'unbound')),
                  note.scope === 'project' && note.projectKey ? ' · ' + note.projectKey : ''))))),
        modal)
    }

    function MemoryEditor(props) {

      const { t, record, busy, error, onCancel, onSave } = props
      const [content, setContent] = React.useState(record.content)
      const [tags, setTags] = React.useState((Array.isArray(record.tags) ? record.tags : []).join(', '))
      const [status, setStatus] = React.useState(EDITABLE_STATUSES.includes(record.status) ? record.status : 'archived')
      const [pinned, setPinned] = React.useState(record.pinned === true)
      const contentRef = React.useRef(null)
      const titleId = React.useId()

      React.useEffect(() => {
        const node = contentRef.current
        if (node !== null) {
          node.focus()
          if (typeof node.select === 'function') node.select()
        }
      }, [])

      React.useEffect(() => {
        const onKeyDown = (event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            onCancel()
          }
        }
        document.addEventListener('keydown', onKeyDown)
        return () => document.removeEventListener('keydown', onKeyDown)
      }, [onCancel])

      const submit = (event) => {
        event.preventDefault()
        if (busy) return
        const nextTags = tags.split(/[,\uFF0C]/u).map((tag) => tag.trim()).filter((tag) => tag !== '')
        onSave({ content: content.trim(), tags: nextTags, status, pinned })
      }

      return h('div', {
        className: 'dsh-memory-overlay',
        onMouseDown: (event) => {
          if (event.target === event.currentTarget) onCancel()
        },
      },
      h('div', { className: 'dsh-memory-modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId },
        h('h3', { className: 'dsh-memory-modal-title', id: titleId }, t('edit.title')),
        h('form', { className: 'dsh-memory-form', onSubmit: submit },
          h(Field, { label: t('edit.content') },
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
            h('select', {
              className: 'dsh-memory-select',
              value: status,
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
            }, busy ? t('actions.saving') : t('actions.save'))))))
    }

    /** Character-level change summary between two revisions. */
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

    function HealthStatus({ health, t }) {
      if (!health) return null
      const download = () => {
        const blob = new Blob([JSON.stringify(health, null, 2)], { type: 'application/json' })
        const url = URL.createObjectURL(blob), anchor = document.createElement('a')
        anchor.href = url; anchor.download = 'dsh-memory-diagnostics.json'; anchor.click()
        setTimeout(() => URL.revokeObjectURL(url), 1000)
      }
      return h('section', { className: 'dsh-memory-settings' },
        h('h3', { className: 'dsh-memory-settings-title' }, t('health.title') + ' · ' + t('health.' + health.status)),
        h('p', { className: 'dsh-memory-muted' }, health.isolation === 'unavailable' ? null : t('health.' + health.isolation)),
        health.status === 'unavailable' ? null : h('p', { className: 'dsh-memory-muted' }, t('health.memories', health.counts)),
        health.status === 'unavailable' ? null : h('p', { className: 'dsh-memory-muted' }, t('health.jobs', health.counts)),
        health.counts?.corruptLines ? h('p', { className: 'dsh-memory-error-text' }, t('health.corrupt', { count: health.counts.corruptLines })) : null,
        health.issues.map(code => h('p', { key: code, className: 'dsh-memory-error-text', role: 'status' }, t('health.' + code))),
        h('div', { className: 'dsh-memory-settings-actions' }, h('button', { type: 'button', className: 'dsh-memory-button', onClick: download }, t('health.download'))),
        h('p', { className: 'dsh-memory-muted' }, t('health.hint')))
    }

    function MemoryPanel(props) {
      const { t, store } = props
      const locale = props.locale
      const transport = React.useSyncExternalStore(store.subscribe, store.getState, store.getState)
      const call = transport.status === 'ready' ? transport.call : null

      const [scope, setScope] = React.useState('project')
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
      const [data, setData] = React.useState(null)
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
        setLoading(true)
        setError('')
        try {
          const stats = await call('stats', { scope })
          if (stats?.health?.status === 'unavailable') { setData({ stats, list: null, activity: null, profile: null }); return }
          const activity = await call('activity', { scope, days: 371 })
          const profile = await call('profile', { limit: 10 })
          const projectKey = scope === 'project' && typeof stats?.currentProjectKey === 'string'
            ? stats.currentProjectKey
            : undefined
          const listed = await call('list', {
            scope,
            projectKey,
            status: status === '' ? undefined : status,
            kind: kind === '' ? undefined : kind,
            topic: topic === '' ? undefined : topic,
            query: query === '' ? undefined : query,
            limit: pageSize,
            offset: page * pageSize,
          })
          setData({ stats, activity, profile, list: listed })
        } catch (failure) {
          setError(messageOf(failure))
        } finally {
          setLoading(false)
        }
      }, [call, scope, status, kind, topic, query, page, pageSize])

      React.useEffect(() => {
        void load()
      }, [load])

      React.useEffect(() => {
        if (view !== 'activity' || !call) return undefined
        let cancelled = false
        const refresh = () => call('stats', { scope }).then(stats => {
          if (!cancelled) setData(previous => previous ? { ...previous, stats } : previous)
        }).catch(failure => { if (!cancelled) setError(messageOf(failure)) })
        void refresh()
        const timer = setInterval(refresh, 5000)
        return () => { cancelled = true; clearInterval(timer) }
      }, [view, call, scope])

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
        setBusy(key)
        setError('')
        try {
          await action(call)
          if (typeof successKey === 'string' && successKey !== '') setNotice(t(successKey))
          await load()
        } catch (failure) {
          setError(messageOf(failure))
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

      const remove = (record) => runAction('delete:' + record.id, (invoke) => invoke('removeMemory', targetOf(record)), 'notice.deleted')
        .then(() => setConfirmingId(''))

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
        setHistoryRecord(record)
        setHistoryData(null)
        setHistoryError('')
        setHistoryBusy(true)
        try {
          setHistoryData(await call('history', targetOf(record)))
        } catch (failure) {
          setHistoryError(messageOf(failure))
        } finally {
          setHistoryBusy(false)
        }
      }

      const restoreRevision = (revision) => {
        if (historyRecord === null) return
        void runAction('revision:' + revision, (invoke) => invoke('restoreRevision', {
          ...targetOf(historyRecord),
          revision,
        }), 'notice.restored').then(() => setHistoryRecord(null))
      }

      const toggleSelected = (id) => {
        setSelected((previous) => previous.includes(id)
          ? previous.filter((value) => value !== id)
          : [...previous, id])
      }

      const bulk = async (action, extra) => {
        if (call === null || selected.length === 0 || busy !== '') return
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
          setError(messageOf(failure))
        } finally {
          setBusy('')
        }
      }

      const openTopicSuggestions = async () => {
        if (call === null) return
        const projectKey = scope === 'project' && typeof currentProjectKey === 'string' ? currentProjectKey : undefined
        setTopicSuggestOpen(true)
        setTopicSuggestions(null)
        setTopicSuggestBusy(true)
        try {
          setTopicSuggestions(await call('topicSuggestions', { scope, projectKey }))
        } catch (failure) {
          setError(messageOf(failure))
          setTopicSuggestOpen(false)
        } finally {
          setTopicSuggestBusy(false)
        }
      }

      const mergeTopic = async (item) => {
        if (call === null || busy !== '') return
        const projectKey = scope === 'project' && typeof currentProjectKey === 'string' ? currentProjectKey : undefined
        setBusy('topic:merge')
        setError('')
        try {
          const result = await call('mergeTopics', { scope, projectKey, from: item.from, to: item.to })
          setNotice(t('topic.merged', { count: String(result.merged ?? 0) }))
          setTopicSuggestOpen(false)
          await load()
        } catch (failure) {
          setError(messageOf(failure))
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
      const listed = data === null ? null : data.list
      const items = listed === null ? [] : listed.items
      const total = listed === null ? 0 : listed.total
      const kindCounts = listed !== null && listed.kindCounts !== undefined && listed.kindCounts !== null ? listed.kindCounts : {}
      const kindCountsTotal = Object.values(kindCounts).reduce((sum, value) => sum + (Number(value) || 0), 0)
      const topicCounts = listed !== null && listed.topicCounts !== undefined && listed.topicCounts !== null ? listed.topicCounts : {}
      const pageCount = Math.max(1, Math.ceil(total / pageSize))
      const currentProjectKey = stats === null ? null : stats.currentProjectKey
      const filtering = query !== '' || status !== '' || kind !== '' || topic !== ''
      const showMissingProject = !filtering && scope === 'project' && currentProjectKey === null &&
        stats !== null && stats.total > 0

      const sections = [
        { key: 'activity', views: ['activity'] },
        { key: 'memory', views: ['memory', 'profile'] },
        { key: 'brief', views: ['brief'] },
        { key: 'knowledge', views: ['library'] },
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

      if (stats?.health?.status === 'unavailable') return h('div', { className: 'dsh-memory-root' }, header, h(HealthStatus, { health: stats.health, t }))

      if (view === 'brief') {
        return h('div', { className: 'dsh-memory-root' }, header, viewTabs,
          error ? h('p', { className: 'dsh-memory-error-text', role: 'alert' }, error) : null,
          h(ProjectBrief, { call, t, locale, initialProject: stats?.currentProjectKey, projectKeys: stats?.projectKeys ?? [] }))
      }

      if (view === 'activity') {
        return h('div', { className: 'dsh-memory-root' }, header, viewTabs,
          error ? h('p', { className: 'dsh-memory-error-text', role: 'alert' }, error) : null,
          h('section', { className: 'dsh-memory-hero-cards' },
            h('div', { className: 'dsh-memory-hero-main' }, h(HeroMetrics, { stats, t })),
            h('div', { className: 'dsh-memory-hero-side' }, h(HeroInsights, { activity: data?.activity, stats, t, locale }))),
          h(HealthStatus, { health: stats?.health, t }),
          h(ActivityHeatmap, { activity: data?.activity, stats, t, locale }),
          stats?.semantic ? h('section', { className: 'dsh-memory-recall-report' },
            h('h3', { className: 'dsh-memory-settings-title' }, t('recall.semantic')),
            h('p', { role: 'status' }, t('recall.semantic.' + stats.semantic.state)),
            stats.semantic.total ? h('p', { className: 'dsh-memory-muted' }, t('recall.semanticProgress', { indexed: String(stats.semantic.indexed), total: String(stats.semantic.total) })) : null,
            stats.semantic.error ? h('p', { className: 'dsh-memory-error-text' }, stats.semantic.error) : null) : null,
          h(RecallReport, { report: stats?.lastRecall, t, locale, call, onSaved: load }),
          h(SettingsCard, { stats, call, t, locale, onSaved: load, group: 'activity' }))
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
          h(SettingsCard, { stats, call, t, locale, onSaved: load, group: view }))
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
            h('select', {
              className: 'dsh-memory-select',
              value: scope,
              onChange: (event) => {
                setScope(event.target.value)
                setPage(0)
              },
              'aria-label': t('filter.scope'),
            },
            h('option', { value: 'project' }, t('filter.scope.project')),
            h('option', { value: 'global' }, t('filter.scope.global')))),
          h(Field, { label: t('filter.status') },
            h('select', {
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
            h('select', {
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
              h('select', {
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
