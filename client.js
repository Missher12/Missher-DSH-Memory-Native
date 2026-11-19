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
    const METHODS = ['list', 'stats', 'activity', 'profile', 'update', 'removeMemory', 'rebuildIndex', 'updateSettings', 'exportData', 'importData', 'backup', 'restoreMemory', 'purgeMemory', 'history', 'restoreRevision', 'bulkAction', 'topicSuggestions', 'mergeTopics', 'obsidianExport', 'obsidianImport', 'obsidianStatus', 'obsidianSync', 'obsidianResolve', 'knowledgeGraph', 'knowledgePromote', 'knowledgeList', 'knowledgeNote', 'knowledgeSave', 'knowledgeSync', 'captureStatus', 'captureRetry', 'semanticModel', 'projectBrief', 'localSharing']
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
      semanticModel: 'MemorySemanticModel',
      projectBrief: 'MemoryProjectBrief',
      localSharing: 'MemoryLocalSharingAction',
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
        'activity.blueColor': 'Lake blue',
        'activity.cell': '{date} · {count} memories',
        'activity.colorMenu': 'Colour',
        'activity.cumulativeTooltip': 'Through {end}: {count} memories',
        'activity.customColor': 'Custom colour…',
        'activity.amberColor': 'Warm gold',
        'activity.less': 'Less',
        'activity.mode.cumulative': 'Cumulative',
        'activity.mode.daily': 'Daily',
        'activity.mode.weekly': 'Weekly',
        'activity.more': 'More',
        'activity.roseColor': 'Dusty rose',
        'activity.sparseHint': 'No recorded activity in this view.',
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
        'filter.project': 'Project',
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
        'filter.more': 'Filters',
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
        'view.capture': "Memory behavior",
        'view.retention': "Retention",
        'view.data': "Backup & sharing",
        'view.obsidian': "Obsidian",
        'library.title': "Notes",
        'library.hint': "Long-form Markdown notes, editable here and synced with Obsidian. Choose where each note can be recalled.",
        'library.empty': "No notes yet. Sync notes from Obsidian in Settings to get started.",
        'library.loading': 'Loading notes…',
        'library.failed': 'Could not load notes: {reason}',
        'library.total': '{count} notes',
        'library.vault': 'Vault: {path}',
        'library.noVault': "Configure Obsidian sync in Settings.",
        'library.note': 'Note',
        'library.syncExport': 'Sync to Obsidian',
        'library.syncImport': 'Import from Obsidian',
        'library.edit': 'Edit',
        'library.editorTitle': 'Edit note',
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
        'settings.captureAllowance': 'Automatic calls today: {used}/{limit} · shared by extraction and deeper recall',
        'settings.captureResume': '{count} waiting · resumes {time} local. Manual recovery uses extra calls.',
        'settings.capturePaused': '{count} waiting · automatic capture or its allowance is off.',
        'settings.captureStorage': 'Capture storage: {sources} sources · {size} · {tasks} tasks',
        'settings.captureRetry': 'Recover next task',
        'settings.captureUnknownConfirm': 'The previous request has no confirmed result. Retrying may charge again. Send a new request?',
        'settings.captureNothing': 'No recoverable leaf remains. Check any in-flight or unresolved child task.',
        'settings.captureRetried': 'Capture task queued for retry.',
        'settings.captureRetryFailed': 'Retry failed: {reason}',
        'settings.title': 'Memory settings',
        'settings.loading': 'Reading settings…',
        'settings.capture': "Remember conversations",
        'settings.inject': "Use memories in replies",
        'settings.budget': "Per-conversation recall cap",
        'settings.budgetHint': 'Reduced automatically when the conversation has less room.',
        'settings.retention': 'Episode retention',
        'settings.retentionHint': 'Only older, low-confidence, unpinned episodes are archived. 0 disables automatic archiving.',
        'settings.days': 'days',
        'settings.maintenance': 'Self-maintenance',
        'settings.index': 'Search index',
        'settings.group.capture': 'Recording & recall',
        'settings.group.retention': 'Retention & maintenance',
        'settings.group.data': 'Data',
        'settings.group.obsidian': 'Vault settings',
        'settings.group.sync': 'Sync & transfer',
        'settings.group.records': 'Backup & transfer',
        'settings.group.sharing': 'Local sharing',
        'settings.data.records': 'Memory records',
        'settings.invalid.budget': 'Enter a whole number from 100 to 8000.',
        'settings.invalid.retention': 'Enter a whole number from 0 to 36500.',
        'settings.conflict': 'This setting changed in another window. Your edit is kept; save again to apply it.',
        'settings.repair.numbersInvalid': 'Correct the recall budget and retention days on Memory behavior before restoring settings.',
        'settings.obsidian.pathInvalid': 'Choose an existing Obsidian vault folder.',
        'settings.obsidian.folderInvalid': 'Use a relative folder path inside the vault.',
        "obsidian.auto": "Automatic two-way sync",
        'obsidian.autoHint': 'Conflicts keep both versions.',
        'obsidian.vaultPlaceholder': 'Path to an Obsidian vault',
        'obsidian.status': 'Sync status',
        "obsidian.now": "Sync now",
        "obsidian.syncStatus": "Last sync: {time} · sent {sent} · received {received} · conflicts {conflicts}",
        "obsidian.notYet": "Not synced yet",
        "obsidian.fullScan": "Run full sync now",
        'obsidian.syncing': 'Syncing…',
        "obsidian.pending": "Pending file checks: {count}",
        "obsidian.fullPending": "A full reconciliation is pending",
        "obsidian.mode.full": "Full scan",
        "obsidian.mode.incremental": "Incremental",
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
        'settings.maintenance.off': 'Self-maintenance is off · existing backups stay local',
        'settings.data.label': 'Export, import & backup',
        'data.export': 'Export',
        'data.import': 'Import',
        'data.importConfirm': 'Preview: import {imported} records and skip {skipped}. Continue?',
        'data.importCanceled': 'Import canceled; no records were changed.',
        'data.backup': 'Full backup',
        'data.backupAction': 'Create backup',
        'data.backupHint': 'Export saves current records. Full backups also retain sources, history, settings and receipts.',
        'data.localSharing': 'Share this profile locally',
        'data.openSharing': 'Open local sharing',
        'data.stopSharing': 'Stop sharing',
        'data.sharingLink': 'Open local memory',
        'data.sharingReady': 'Local sharing is ready.',
        'data.sharingStopped': 'Local sharing stopped.',
        'data.exported': 'Exported',
        'data.imported': 'Imported {imported}, skipped {skipped}',
        'data.protectedDeleted': 'Kept {count} locally forgotten records deleted.',
        'data.backupDone': 'Backup written to {path}',
        'data.failed': 'Failed: {reason}',
        'settings.failed': 'Save failed: {reason}',
        'settings.maintenance.none': 'Self-maintenance has not run yet',
        'settings.maintenance.summary': 'Last maintenance: archived {archived} · pruned {pruned} backups',
        'contextUsage.title': 'Memory in this chat',
        'contextUsage.amount': '{tokens} / {budget} tokens',
        'contextUsage.detail': 'Last step: {items} items · estimate',
        'contextUsage.detailZero': 'No memory added last step',
        'contextUsage.noRoom': 'No room in the last step',
        'contextUsage.noSession': 'No chat selected',
        'contextUsage.empty': 'Waiting for a model step',
        'contextUsage.disabled': 'Memory injection off',
        'usage.title': 'Token usage · last 7 days',
        'usage.total': '{tokens} tokens',
        'usage.inject': 'Injection',
        'usage.extract': 'Extraction',
        'usage.empty': 'No usage recorded yet. Injection and extraction counts appear here.',
        'usage.day': '{date} · injection {inject} · extraction {extract}',
        'usage.avg': 'Avg {tokens}/turn',
        'usage.overBudget': '{count} over budget',
        'usage.provider': 'Provider usage: {calls} calls · input {input} · output {output} · total {total}',
        'usage.providerMissing': 'Estimated prompt tokens. Provider usage is unavailable.',
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
        'health.title': 'Health',
        "health.ok": "Available",
        'health.attention': 'Needs attention',
        "health.unavailable": "Paused",
        "health.download": "Export diagnostic summary",
        "health.hint": "Contains only version, status codes and counts. Memory text, file paths and session identifiers are excluded.",
        "health.profile": "Isolated by host profile",
        "health.explicit": "Explicit standalone directory",
        "health.memories": "Current memories {memories} · deletion markers {deleted}",
        "health.corrupt": "Unreadable authority lines: {count}",
        "health.storage-probe-failed": "Local read/write verification failed. Check permissions and free disk space.",
        "health.panel-unavailable": "The settings panel gateway is unavailable. Reload the plugin after checking the host extension service.",
        "health.panel-check-failed": "The settings panel could not complete its gateway check.",
        "health.hooks-unavailable": "A required session or pre-step hook is unavailable. Reload the plugin after checking host compatibility.",
        "health.extraction-route-unavailable": "The extraction route is unavailable. Select a working model in the host and retry the queued task.",
        "health.lexical-failed": "Keyword search encountered an error. Reload the plugin and retry.",
        'health.semantic-failed': 'Semantic search is using keyword fallback. Prepare the local model.',
        "health.injection-failed": "Context injection encountered an error. Review capture and injection settings, then retry.",
        "health.obsidian-failed": "Some Obsidian files need attention. Open sync settings to review or retry.",
        "health.component.storage": "Storage read/write",
        "health.component.panel": "Panel gateway",
        "health.component.hooks": "Host hooks",
        "health.component.capture": "Capture",
        "health.component.extraction": "Extraction route",
        "health.component.lexical": "Keyword index",
        "health.component.semantic": "Local semantic model",
        "health.component.injection": "Pre-step injection",
        "health.component.obsidian": "Obsidian sync",
        "health.state.ready": "Ready",
        "health.state.waiting": "Waiting for first use",
        "health.state.disabled": "Disabled",
        "health.state.running": "Working",
        "health.state.attention": "Needs attention",
        "health.state.unavailable": "Unavailable",
        "health.action.capture": "Open capture settings",
        "health.action.model": "Prepare model",
        "health.action.obsidian": "Open sync settings",
        "health.profile-unavailable": "The host profile identity is unavailable. Update the host or configure an independent data directory, then reload the plugin.",
        "health.storage-owner-conflict": "This directory belongs to another host profile. Choose a separate directory, then reload the plugin.",
        "health.storage-owner-invalid": "Directory ownership could not be verified. Check file permissions or restore a complete backup to a new directory.",
        "health.storage-unavailable": "Storage is unavailable. Check directory permissions, free disk space and file version, then reload the plugin.",
        "health.settings-invalid": "Settings are damaged. Capture, injection, maintenance and sync are paused until you explicitly save the settings again.",
        "health.settings-unreadable": "Settings cannot be read. Check file permissions before reloading the plugin.",
        "health.profile-explicit": "This standalone directory was explicitly configured; native profile isolation is not verified.",
        "health.backup-failed": "The complete backup did not finish. Existing backups were retained; check storage or retry later.",
        'health.corrupt-lines': 'Unreadable records were skipped. Check quarantine or restore a backup.',
        'health.capture-incomplete': 'Some extraction tasks need a retry.',
        'health.capture-unknown': 'Unknown requests are held to avoid duplicate charges.',
        'section.activity': "Activity",
        'section.settings': "Settings",
        'nav.sections': "Memory sections",
        'view.activity': 'Activity',
        'activity.trends': 'Trends',
        'activity.operations': 'Activity details',
        'activity.extraction': 'Extraction',
        'activity.idle': 'Idle',
        'activity.off': 'Off',
        'activity.queue.pending': 'Queued {count}',
        'activity.queue.running': 'Running {count}',
        'activity.queue.partial': 'Incomplete {count}',
        'activity.queue.failed': 'Failed {count}',
        'activity.queue.unknown': 'Unverified {count}',
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
        'recall.title': 'Latest recall',
        'recall.empty': 'None yet',
        'recall.found': 'Evidence included in this answer',
        'recall.missing': 'Still missing evidence',
        'recall.hits': 'Retrieved hits',
        'recall.injected': 'Text actually injected',
        'recall.notInjected': 'Found but omitted by the context budget',
        'recall.answer': 'Final answer',
        'recall.answer.pending': 'Waiting for the turn to finish',
        'recall.answer.covered': 'Supported in the final answer',
        'recall.answer.unverified': 'Needs verification',
        'recall.answer.no-evidence': 'No matching memory found',
        'recall.answer.not-injected': 'Matching evidence was not injected',
        'recall.answer.aborted': 'Turn cancelled; not assessed',
        'recall.memorySource': '{kind} · {scope}',
        'recall.localDeepUsage': 'Local deep search · {count} gaps · {tokens} / {limit} tokens',
        'recall.coverage': '{covered}/{total} supported',
        'recall.candidates': 'Candidate passages included; answers not yet confirmed',
        'recall.forgetSource': 'Forget this original message',
        'recall.forgetConfirm': 'Forget the entire original message and its extracted memories? This also blocks all of its indexed passages.',
        'recall.semantic': 'Local semantic search',
        'recall.semanticProgress': '{indexed} of {total} passages indexed',
        'recall.semantic.idle': 'Starts when needed',
        'recall.semantic.preparing': 'Preparing local model',
        'recall.semantic.importing': 'Importing offline model',
        'recall.semantic.loading': 'Loading model',
        'recall.semantic.downloading': 'Downloading public model',
        'recall.semantic.indexing': 'Indexing in background',
        'recall.semantic.ready': 'Ready',
        'recall.semantic.disabled': 'Disabled',
        'recall.semantic.failed': 'Unavailable; using keyword search',
        'recall.model.prepare': 'Prepare model',
        'recall.model.retry': 'Retry preparation',
        'recall.model.cancel': 'Cancel preparation',
        'recall.model.import': 'Import offline model',
        'recall.model.folder': 'Model folder',
        'recall.model.folderHint': 'Choose a folder with the pinned model files.',
        'recall.model.progress': '{file}: {done} / {total}',
        'recall.model.preparing': 'Preparing local model',
        'recall.model.importing': 'Importing local model',
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
        'activity.blueColor': '湖蓝',
        'activity.cell': '{date} · {count} 条',
        'activity.colorMenu': '配色',
        'activity.cumulativeTooltip': '截至 {end}：累计 {count} 条记忆',
        'activity.customColor': '自定义颜色…',
        'activity.amberColor': '暖金',
        'activity.less': '少',
        'activity.mode.cumulative': '累计',
        'activity.mode.daily': '每日',
        'activity.mode.weekly': '每周',
        'activity.more': '多',
        'activity.roseColor': '烟粉',
        'activity.sparseHint': '此范围暂无活动记录。',
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
        'filter.project': '\u9879\u76ee',
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
        'filter.more': '筛选',
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
        'view.capture': "记忆行为",
        'view.retention': "保留与清理",
        'view.data': "备份与共享",
        'view.obsidian': "Obsidian",
        'library.title': "笔记",
        'library.hint': "保存完整的 Markdown 笔记，可编辑并与 Obsidian 同步；每篇笔记可选择用于哪些对话。",
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
        'library.editorTitle': '编辑笔记',
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
        'library.syncKnowledgeExport': '同步笔记到 Obsidian',
        'library.syncKnowledgeImport': '从 Obsidian 导入笔记',
        'library.exportResult': '已导出 {written} 条 · 跳过 {skipped} 条。',
        'library.importResult': '已导入 {imported} 条 · 跳过 {skipped} 条 · 冲突 {conflicts} 条。',
        'library.syncFailed': '同步失败：{reason}',
        'settings.captureAllowance': '今日自动调用 {used}/{limit} · 提炼与深查共用',
        'settings.captureResume': '{count} 项等额度 · {time} 自动续跑。手动恢复会额外调用。',
        'settings.capturePaused': '{count} 项暂停 · 捕获关闭或额度为 0。',
        'settings.captureStorage': '原文 {sources} 条 · {size} · 任务 {tasks} 项',
        'settings.captureRetry': '恢复下一项',
        'settings.captureUnknownConfirm': '上一次请求结果未知，重新发送可能再次计费。确认发送新请求？',
        'settings.captureNothing': '没有可恢复的末级任务，请检查正在运行或结果未知的子任务。',
        'settings.captureRetried': '已加入重试队列。',
        'settings.captureRetryFailed': '重试失败：{reason}',
        'settings.title': '\u8bb0\u5fc6\u8bbe\u7f6e',
        'settings.capture': "自动记住对话",
        'settings.inject': "回答时参考记忆",
        'settings.budget': "单次回答参考上限",
        'settings.budgetHint': '可用上下文较少时会自动下调。',
        'settings.retention': '\u7247\u6bb5\u4fdd\u7559',
        'settings.retentionHint': '仅归档较旧、低置信度且未置顶的片段；设为 0 可关闭自动归档。',
        'settings.days': '天',
        'settings.maintenance': '\u81ea\u7ef4\u62a4',
        'settings.index': '搜索索引',
        'settings.group.capture': '记录与召回',
        'settings.group.retention': '\u4fdd\u7559\u4e0e\u7ef4\u62a4',
        'settings.group.data': '\u6570\u636e',
        'settings.group.obsidian': '仓库设置',
        'settings.group.sync': '同步与迁移',
        'settings.group.records': '备份与迁移',
        'settings.group.sharing': '本机共享',
        'settings.data.records': '记忆记录',
        'settings.invalid.budget': '请输入 100 到 8000 之间的整数。',
        'settings.invalid.retention': '请输入 0 到 36500 之间的整数。',
        'settings.conflict': '此项设置已在另一窗口更改。你的编辑已保留；再次保存即可应用。',
        'settings.repair.numbersInvalid': '请先在“记忆行为”中修正参考上限和保留天数，再恢复设置。',
        'settings.loading': '正在读取设置…',
        'settings.obsidian.pathInvalid': '请选择一个已存在的 Obsidian Vault 文件夹。',
        'settings.obsidian.folderInvalid': '文件夹路径须为 Vault 内的相对路径。',
        "obsidian.auto": "自动双向同步",
        'obsidian.autoHint': '发生冲突时保留双方版本。',
        'obsidian.vaultPlaceholder': 'Obsidian 仓库路径',
        'obsidian.status': '同步状态',
        "obsidian.now": "立即同步",
        "obsidian.syncStatus": "最近同步：{time} · 导出 {sent} · 导入 {received} · 冲突 {conflicts}",
        "obsidian.notYet": "尚未同步",
        "obsidian.fullScan": "立即全量同步",
        'obsidian.syncing': '正在同步…',
        "obsidian.pending": "待检查文件：{count}",
        "obsidian.fullPending": "等待全量对账",
        "obsidian.mode.full": "全量扫描",
        "obsidian.mode.incremental": "增量同步",
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
        'settings.maintenance.off': '\u81ea\u7ef4\u62a4\u5df2\u5173\u95ed \u00b7 \u5386\u53f2\u5907\u4efd\u4ecd\u4fdd\u7559\u5728\u672c\u5730',
        'settings.data.label': '\u5bfc\u51fa\u3001\u5bfc\u5165\u4e0e\u5907\u4efd',
        'data.export': '\u5bfc\u51fa',
        'data.import': '\u5bfc\u5165',
        'data.importConfirm': '预览：将导入 {imported} 条记录，跳过 {skipped} 条。继续吗？',
        'data.importCanceled': '已取消导入，记录未更改。',
        'health.title': '运行状态',
        "health.ok": "可用",
        'health.attention': '需处理',
        "health.unavailable": "已暂停",
        "health.download": "导出诊断摘要",
        "health.hint": "只包含版本、状态码和数量，不含记忆正文、文件路径或会话标识。",
        "health.profile": "按宿主配置隔离",
        "health.explicit": "独立指定目录",
        "health.memories": "当前记忆 {memories} · 删除标记 {deleted}",
        "health.corrupt": "无法读取的原始记录行：{count}",
        "health.storage-probe-failed": "本地读写核验失败，请检查目录权限和磁盘空间。",
        "health.panel-unavailable": "设置面板网关不可用，请检查宿主扩展服务后重新加载插件。",
        "health.panel-check-failed": "设置面板未能完成网关核验。",
        "health.hooks-unavailable": "必要的会话或预处理钩子不可用，请检查宿主兼容性后重新加载插件。",
        "health.extraction-route-unavailable": "提炼模型路由不可用，请在宿主选择可用模型后重试队列任务。",
        "health.lexical-failed": "关键词检索遇到错误，请重新加载插件后重试。",
        'health.semantic-failed': '语义检索已回退到关键词，可准备本地模型。',
        "health.injection-failed": "上下文注入遇到错误，请检查捕获和注入设置后重试。",
        "health.obsidian-failed": "部分 Obsidian 文件需要处理，请打开同步设置查看或重试。",
        "health.component.storage": "存储读写",
        "health.component.panel": "面板网关",
        "health.component.hooks": "宿主钩子",
        "health.component.capture": "捕获",
        "health.component.extraction": "提炼路由",
        "health.component.lexical": "关键词索引",
        "health.component.semantic": "本地语义模型",
        "health.component.injection": "预处理注入",
        "health.component.obsidian": "Obsidian 同步",
        "health.state.ready": "可用",
        "health.state.waiting": "等待首次使用",
        "health.state.disabled": "已关闭",
        "health.state.running": "处理中",
        "health.state.attention": "需要处理",
        "health.state.unavailable": "不可用",
        "health.action.capture": "打开捕获设置",
        "health.action.model": "准备模型",
        "health.action.obsidian": "打开同步设置",
        "health.profile-unavailable": "无法确认宿主配置身份。请更新宿主或配置独立数据目录后重新加载插件。",
        "health.storage-owner-conflict": "目录属于其他宿主配置。请选择独立目录后重新加载插件。",
        "health.storage-owner-invalid": "无法确认数据目录归属。请检查文件权限或从完整备份恢复到新目录。",
        "health.storage-unavailable": "存储不可用。请检查目录权限、磁盘空间和文件版本后重新加载插件。",
        "health.settings-invalid": "设置损坏，捕获、注入、维护和同步已暂停。请在设置页重新确认并保存。",
        "health.settings-unreadable": "无法读取设置。请检查文件权限后重新加载插件。",
        "health.profile-explicit": "当前目录由独立配置指定，尚未核验宿主配置隔离。",
        "health.backup-failed": "完整备份未完成，已有备份保留。请检查存储或稍后重试。",
        'health.corrupt-lines': '部分记录无法读取，请检查隔离文件或备份。',
        'health.capture-incomplete': '部分提炼任务需恢复。',
        'health.capture-unknown': '待核实任务暂停重发，避免重复计费。',
        'data.backup': '完整备份',
        'data.backupAction': '立即备份',
        'data.backupHint': '导出保存当前记录，完整备份另含原文、历史、设置和调用记录。',
        'data.localSharing': '\u672c\u673a\u5171\u4eab\u8bb0\u5fc6',
        'data.openSharing': '\u6253\u5f00\u672c\u673a\u5171\u4eab',
        'data.stopSharing': '\u505c\u6b62\u5171\u4eab',
        'data.sharingLink': '\u6253\u5f00\u672c\u673a\u8bb0\u5fc6',
        'data.sharingReady': '\u672c\u673a\u5171\u4eab\u5df2\u542f\u52a8\u3002',
        'data.sharingStopped': '\u672c\u673a\u5171\u4eab\u5df2\u505c\u6b62\u3002',
        'data.exported': '\u5df2\u5bfc\u51fa',
        'data.imported': '\u5df2\u5bfc\u5165 {imported} \u6761\uff0c\u8df3\u8fc7 {skipped} \u6761',
        'data.protectedDeleted': '已保留 {count} 条本地记忆的遗忘状态。',
        'data.backupDone': '\u5907\u4efd\u5df2\u5199\u5165 {path}',
        'data.failed': '\u64cd\u4f5c\u5931\u8d25\uff1a{reason}',
        'settings.failed': '\u4fdd\u5b58\u5931\u8d25\uff1a{reason}',
        'settings.maintenance.none': '\u5c1a\u672a\u6267\u884c\u81ea\u7ef4\u62a4',
        'settings.maintenance.summary': '\u4e0a\u6b21\u81ea\u7ef4\u62a4\uff1a\u5f52\u6863 {archived} \u6761 \u00b7 \u6e05\u7406\u5907\u4efd {pruned} \u4efd',
        'contextUsage.title': '当前会话记忆',
        'contextUsage.amount': '{tokens} / {budget} Token',
        'contextUsage.detail': '上一轮 {items} 条 · 估算',
        'contextUsage.detailZero': '上一轮未注入',
        'contextUsage.noRoom': '上一轮无剩余空间',
        'contextUsage.noSession': '未打开会话',
        'contextUsage.empty': '等待模型回复',
        'contextUsage.disabled': '记忆注入已关闭',
        'usage.title': 'Token 用量 · 近 7 天',
        'usage.total': '共 {tokens} token',
        'usage.inject': '注入',
        'usage.extract': '抽取',
        'usage.empty': '暂无用量，注入或抽取后开始统计。',
        'usage.day': '{date} · 注入 {inject} · 抽取 {extract}',
        'usage.avg': '平均 {tokens}/回合',
        'usage.overBudget': '{count} 次超预算',
        'usage.provider': 'Provider \u7528\u91cf\uff1a{calls} \u6b21 \u00b7 \u8f93\u5165 {input} \u00b7 \u8f93\u51fa {output} \u00b7 \u603b {total}',
        'usage.providerMissing': '图表显示估算用量，服务商未返回实际用量。',
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
        'section.activity': "活动",
        'section.settings': "设置",
        'nav.sections': "记忆导航",
        'view.activity': '活动',
        'activity.trends': '趋势',
        'activity.operations': '活动详情',
        'activity.extraction': '提炼',
        'activity.idle': '空闲',
        'activity.off': '已关闭',
        'activity.queue.pending': '待处理 {count}',
        'activity.queue.running': '处理中 {count}',
        'activity.queue.partial': '待补全 {count}',
        'activity.queue.failed': '失败 {count}',
        'activity.queue.unknown': '待核实 {count}',
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
        'recall.title': '最近召回',
        'recall.empty': '暂无记录',
        'recall.found': '已放入本轮回答的证据',
        'recall.missing': '仍缺少证据',
        'recall.hits': '检索命中',
        'recall.injected': '实际注入文字',
        'recall.notInjected': '已找到，但受上下文预算限制未注入',
        'recall.answer': '最终回答',
        'recall.answer.pending': '等待本轮结束',
        'recall.answer.covered': '最终回答包含可核对的依据',
        'recall.answer.unverified': '待核实',
        'recall.answer.no-evidence': '未找到匹配记忆',
        'recall.answer.not-injected': '匹配依据未注入',
        'recall.answer.aborted': '本轮已取消，未评估',
        'recall.memorySource': '{kind} · {scope}',
        'recall.localDeepUsage': '本地深查 · {count} 项缺口 · {tokens} / {limit} Token',
        'recall.coverage': '{covered}/{total} 项有证据',
        'recall.candidates': '已送入候选原文，答案尚未确认',
        'recall.forgetSource': '忘记这条原始消息',
        'recall.forgetConfirm': '忘记整条原始消息及其提炼出的记忆？这也会阻止该消息的所有分段再次进入召回。',
        'recall.semantic': '本地语义检索',
        'recall.semanticProgress': '已建立 {indexed} / {total} 段索引',
        'recall.semantic.idle': '需要时启动',
        'recall.semantic.preparing': '正在准备本地模型',
        'recall.semantic.importing': '正在导入离线模型',
        'recall.semantic.loading': '正在加载模型',
        'recall.semantic.downloading': '正在下载公开模型',
        'recall.semantic.indexing': '正在后台建立索引',
        'recall.semantic.ready': '已就绪',
        'recall.semantic.disabled': '已关闭',
        'recall.semantic.failed': '暂不可用，已使用关键词检索',
        'recall.model.prepare': '准备模型',
        'recall.model.retry': '重试准备',
        'recall.model.cancel': '取消准备',
        'recall.model.import': '导入离线模型',
        'recall.model.folder': '模型文件夹',
        'recall.model.folderHint': '选择包含固定版本模型文件的目录。',
        'recall.model.progress': '{file}：{done} / {total}',
        'recall.model.preparing': '正在准备本地模型',
        'recall.model.importing': '正在导入本地模型',
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

    function SettingRow({ label, hint, error, children }) {
      const descriptionId = React.useId()
      const hasDescription = Boolean(hint || error)
      return h('div', { className: 'dsh-memory-settings-row' },
        h('div', { className: 'dsh-memory-settings-copy' },
          h('span', { className: 'dsh-memory-settings-label' }, label),
          hasDescription ? h('div', { id: descriptionId },
            hint ? h('p', { className: 'dsh-memory-help' }, hint) : null,
            error ? h('p', { className: 'dsh-memory-field-error', role: 'alert' }, error) : null) : null),
        h('div', { className: 'dsh-memory-settings-control' },
          typeof children === 'function' ? children(hasDescription ? descriptionId : undefined) : children))
    }

    function PanelDialog({ title, children, onClose, busy = false }) {
      const ref = React.useRef(null)
      const titleId = React.useId()
      React.useLayoutEffect(() => {
        const dialog = ref.current
        const returnFocus = document.activeElement
        dialog.showModal()
        return () => {
          dialog.close()
          if (returnFocus instanceof HTMLElement && returnFocus.isConnected) returnFocus.focus({ preventScroll: true })
        }
      }, [])
      return h('dialog', {
        ref,
        className: 'dsh-memory-modal',
        'aria-labelledby': titleId,
        onCancel: event => {
          event.preventDefault()
          if (!busy) onClose()
        },
        onKeyDown: event => {
          if (event.key !== 'Escape') return
          event.preventDefault()
          event.stopPropagation()
          if (!busy) onClose()
        },
        onMouseDown: event => {
          if (busy || event.target !== event.currentTarget) return
          const bounds = event.currentTarget.getBoundingClientRect()
          if (event.clientX < bounds.left || event.clientX > bounds.right ||
              event.clientY < bounds.top || event.clientY > bounds.bottom) onClose()
        },
      }, h('h3', { className: 'dsh-memory-modal-title', id: titleId }, title), children)
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
      const label = h('span', { className: 'dsh-memory-field-label' }, props.label)
      const hint = props.hint ? h('span', { className: 'dsh-memory-help' }, props.hint) : null
      if (props.wide) return h('label', { className: 'dsh-memory-field dsh-memory-field-wide' }, label, props.children, hint)
      return h('label', { className: 'dsh-memory-field' },
        h('span', { className: 'dsh-memory-field-copy' }, label, hint), props.children)
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

    function MemoryTotals({ stats, t, locale }) {
      const counts = ['total', 'active', 'candidate', 'projects']
      return h('dl', { className: 'dsh-memory-activity-totals' },
        counts.filter(key => key !== 'candidate' || stats.candidate > 0).map(key =>
          h('div', { key },
            h('dt', null, t('stats.' + key)),
            h('dd', null, stats[key].toLocaleString(locale || undefined)))))
    }

    function ActivityHeading({ title, value, warning = false }) {
      return [
        h('span', { key: 'title', className: 'dsh-memory-activity-label' }, title),
        value ? h('span', { key: 'value', className: warning ? 'dsh-memory-activity-warning' : 'dsh-memory-muted' }, value) : null,
      ]
    }

    function ActivityDisclosure({ title, value, warning, children }) {
      const attrs = { className: 'dsh-memory-activity-disclosure dsh-memory-disclosure' }
      const heading = h(ActivityHeading, { title, value, warning })
      if (children == null) return h('div', { className: 'dsh-memory-activity-line' }, heading)
      return h('details', attrs,
        h('summary', { className: 'dsh-memory-activity-line dsh-memory-disclosure-head' }, heading),
        h('div', { className: 'dsh-memory-activity-details' }, children))
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
      const { activity, t, locale } = props
      const [mode, setMode] = React.useState('daily')
      const [color, setColor] = React.useState(readPalette)
      const [tooltip, setTooltip] = React.useState(null)
      const stageRef = React.useRef(null)
      const counts = new Map()
      const days = activity !== null && activity !== undefined && Array.isArray(activity.days) ? activity.days : []
      for (const day of days) {
        if (day === null || typeof day !== 'object' || typeof day.date !== 'string') continue
        const count = Number(day.count)
        if (!Number.isFinite(count) || count <= 0) continue
        counts.set(day.date, count)
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
      return h('section', { className: 'dsh-memory-activity', 'aria-label': t('activity.title'), style: { '--dsh-memory-particle-color': color === '' ? 'var(--dsw-alias-state-business-primary, #2f6df6)' : color } },
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
        counts.size === 0 ? h('p', { className: 'dsh-memory-help' }, t('activity.sparseHint')) : null)
    }

    function ContextUsage({ sessionId, sample, enabled, t, locale }) {
      const title = t('contextUsage.title')
      const usage = sample?.sessionId === sessionId ? sample?.usage : null
      const hasUsage = enabled && Number.isInteger(usage?.tokens) && Number.isInteger(usage?.budget) && usage.budget >= 0
      const amount = hasUsage ? t('contextUsage.amount', {
        tokens: usage.tokens.toLocaleString(locale || undefined),
        budget: usage.budget.toLocaleString(locale || undefined),
      }) : null
      const value = hasUsage ? Math.min(usage.tokens, usage.budget) : 0
      const detail = hasUsage
        ? t(usage.budget === 0 ? 'contextUsage.noRoom' : usage.tokens === 0 ? 'contextUsage.detailZero' : 'contextUsage.detail', { items: String(usage.items) })
        : t(!enabled ? 'contextUsage.disabled' : !sessionId ? 'contextUsage.noSession' : 'contextUsage.empty')
      return h('section', { className: 'dsh-memory-context-usage' },
        h('div', { className: 'dsh-memory-context-usage-head' },
          h('h3', { className: 'dsh-memory-section-title' }, title),
          amount === null
            ? h('span', { className: 'dsh-memory-muted' }, detail)
            : h('span', { className: 'dsh-memory-context-usage-amount', title: formatTime(usage.at, locale) }, amount)),
        !hasUsage || usage.budget === 0 ? null : h('div', {
          className: 'dsh-memory-context-usage-track', role: 'meter', 'aria-label': title,
          'aria-valuemin': 0, 'aria-valuemax': usage.budget, 'aria-valuenow': value, 'aria-valuetext': amount,
        }, h('span', { style: { width: (100 * value / usage.budget) + '%' } })),
        hasUsage ? h('p', { className: 'dsh-memory-help' }, detail) : null)
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
      const title = t('recall.title')
      if (!report) return h(ActivityDisclosure, { title, value: t('recall.empty') })
      const stateKey = { 'not-needed': 'local', completed: 'completed', failed: 'failed', unknown: 'unknown', 'budget-exhausted': 'budget' }[report.completionState] ?? 'notSent'
      const sent = ['completed', 'unknown', 'requested'].includes(report.providerState)
      const tokens = report.usage?.totalTokens
      const questions = Array.isArray(report.questions) ? report.questions : []
      const covered = questions.filter(question => question.answerCoverage === 'covered').length
      const coverage = t('recall.coverage', { covered: String(covered), total: String(report.total ?? questions.length) })
      const warning = report.outcome === 'aborted' || ['failed', 'unknown', 'budget'].includes(stateKey)
      const value = [coverage, report.outcome === 'pending' ? t('recall.answer.pending') : report.outcome === 'aborted' ? t('recall.answer.aborted') : ''].filter(Boolean).join(' · ')
      const evidenceNode = (evidence, showInjected = false) => {
        const refs = Array.isArray(evidence.sourceRefs) ? evidence.sourceRefs : []
        const source = evidence.noteTitle ?? t('recall.memorySource', {
          kind: evidence.kind ?? 'memory', scope: evidence.scope === 'global' ? t('library.scope.global') : (evidence.projectKey ?? t('library.scope.project')),
        })
        return h('div', { key: evidence.id },
          showInjected && evidence.text ? h('blockquote', null, evidence.text) : null,
          h('p', { className: 'dsh-memory-muted' }, [evidence.verified === false ? t('recall.answer.unverified') : null, source].filter(Boolean).join(' · ')),
          showInjected ? null : refs.map((ref, index) => ref.excerpt ? h('blockquote', { key: index }, ref.excerpt) : null),
          evidence.kind === 'source' ? h('div', { className: 'dsh-memory-danger-actions' }, h('button', {
            type: 'button', className: 'dsh-memory-button', 'data-danger': 'true', disabled: busy,
            onClick: () => forget(evidence),
          }, t('recall.forgetSource'))) : null)
      }
      const questionRows = questions.map((question, index) => {
        const status = t('recall.answer.' + (question.answerCoverage ?? 'pending'))
        const injected = Array.isArray(question.injected) ? question.injected : []
        const injectedIds = new Set(injected.map(evidence => evidence.id))
        const notInjected = Array.isArray(question.notInjected) ? question.notInjected : []
        const hiddenIds = new Set([...injectedIds, ...notInjected.map(evidence => evidence.id)])
        const additionalHits = (question.hits ?? []).filter(evidence => !hiddenIds.has(evidence.id))
        const detailSections = []
        if (injected.length) detailSections.push(h('div', { key: 'injected' },
          h('strong', null, t('recall.injected')),
          h('ul', null, injected.map(evidence => h('li', { key: evidence.id }, evidenceNode(evidence, true))))))
        detailSections.push(h('div', { key: 'answer' }, h('strong', null, t('recall.answer')),
          question.answerCoverage === 'covered' && question.answerExcerpt
            ? h('blockquote', null, question.answerExcerpt)
            : h('p', { className: 'dsh-memory-muted' }, status)))
        if (additionalHits.length) detailSections.push(h('div', { key: 'hits' },
          h('strong', null, t('recall.hits')),
          h('ul', null, additionalHits.map(evidence => h('li', { key: evidence.id }, evidenceNode(evidence))))))
        if (notInjected.length) detailSections.push(h('div', { key: 'not-injected' },
          h('strong', null, t('recall.notInjected')),
          h('ul', null, notInjected.map(evidence => h('li', { key: evidence.id }, evidenceNode(evidence))))))
        return h('li', { key: index }, h('details', { className: 'dsh-memory-brief-sources' },
          h('summary', null, question.query, ' · ', status),
          h('div', { className: 'dsh-memory-activity-details' }, detailSections)))
      })
      return h(ActivityDisclosure, { title, value, warning },
        h('p', { className: 'dsh-memory-brief-meta' },
          Number.isFinite(report.at) ? h('time', { dateTime: new Date(report.at).toISOString() }, new Date(report.at).toLocaleString(locale)) : null,
          report.projectKey ? h('span', null, report.projectKey) : null,
          warning || !coverage ? null : h('span', null, t('recall.' + stateKey)),
          sent && report.provider?.model ? h('span', null, report.provider.model) : null,
          sent ? h('span', null, Number.isFinite(tokens) ? t('recall.usage', { tokens: String(tokens) }) : t('recall.usageUnknown')) : null),
        error ? h('p', { role: 'alert', className: 'dsh-memory-error-text' }, error) : null,
        report.reason ? h('p', { className: 'dsh-memory-muted' }, report.reason) : null,
        report.localDeepRecall ? h('p', { className: 'dsh-memory-muted' }, t('recall.localDeepUsage', {
          count: String(report.localDeepRecall.queries.length),
          tokens: report.localDeepRecall.tokens.toLocaleString(locale || undefined),
          limit: report.localDeepRecall.limit.toLocaleString(locale || undefined),
        })) : null,
        questionRows.length ? h('ul', null, questionRows) : null)
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
            h('details', { className: 'dsh-memory-brief-sources dsh-memory-brief-entry' },
              h('summary', null,
                h('span', { className: 'dsh-memory-brief-meta' },
                  h('span', null, t(statusKey)),
                  Number.isFinite(item.validFrom) ? h('span', null, t('brief.since', { time: formatTime(item.validFrom, locale) })) : null,
                  Number.isFinite(item.validTo) ? h('span', null, t('brief.until', { time: formatTime(item.validTo, locale) })) : null),
                h('span', { className: 'dsh-memory-brief-toggle' }, t('brief.sources'), sources.length ? ' · ' + sources.length : '')),
              sources.length ? sources : h('p', { className: 'dsh-memory-muted' }, t('brief.noQuote'))))
        })
        return h('section', { key: section.id, className: 'dsh-memory-brief-section' },
          h('h3', { className: 'dsh-memory-section-title' }, t('brief.' + section.id)),
          h('ul', { className: 'dsh-memory-history' }, items))
      })
      return h('section', { className: 'dsh-memory-brief' },
        h('div', { className: 'dsh-memory-brief-tools' },
          h(Field, { label: t('brief.project') },
            h(Select, { className: 'dsh-memory-select', value: project, title: project, 'aria-label': t('brief.project'), onChange: event => { setProject(event.target.value); setOffset(0) } },
              !project ? h('option', { value: '' }, t('brief.choose')) : null,
              options.map(key => h('option', { key, value: key }, key)))),
          h('button', { type: 'button', className: 'dsh-memory-button', disabled: loading || !project, onClick: () => setRefresh(value => value + 1) }, t('actions.refresh'))),
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
      return h('section', { className: 'dsh-memory-profile' },
        h('div', { className: 'dsh-memory-section-head' },
          h('h3', { className: 'dsh-memory-section-title' }, t('profile.title')),
          h('span', { className: 'dsh-memory-list-total' }, t('profile.summary', { count: String(total) }))),
        traits.length === 0
          ? h('p', { className: 'dsh-memory-muted' }, t('profile.empty'))
          : h('ul', { className: 'dsh-memory-profile-list' },
            traits.map(trait => {
              const evidence = Array.isArray(trait.evidence) ? trait.evidence.slice(0, 3) : []
              const heading = h('span', { className: 'dsh-memory-profile-line' },
                h('span', { className: 'dsh-memory-profile-statement' }, trait.statement),
                h('span', { className: 'dsh-memory-profile-meta' },
                  t('profile.evidence', { count: String(trait.evidenceCount) }), ' · ',
                  t('row.confidence', { value: Number(trait.confidence).toFixed(2) })))
              return h('li', { key: trait.id, className: 'dsh-memory-profile-item' },
                evidence.length === 0 ? heading : h('details', { className: 'dsh-memory-disclosure' },
                  h('summary', { className: 'dsh-memory-disclosure-head' }, heading),
                  h('ul', { className: 'dsh-memory-profile-evidence' },
                    evidence.map(item => h('li', { key: item.id }, item.content)))))
            })))
    }

    /** Seven-day injection and extraction token usage. */
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
        total === 0 && number(totals.extractProviderCalls) === 0
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

    function ExtractionStatus({ stats, call, t, locale, onSaved }) {
      const [retrying, setRetrying] = React.useState(false)
      const [notice, setNotice] = React.useState('')
      const counts = stats.capture ?? {}
      const states = ['pending', 'running', 'partial', 'failed', 'unknown']
      const queued = states.filter(state => counts[state] > 0)
      const canRetry = queued.some(state => state !== 'running')
      const warning = queued.some(state => ['partial', 'failed', 'unknown'].includes(state))
      const value = [...(stats.captureEnabled ? [] : [t('activity.off')]),
        ...queued.map(state => t('activity.queue.' + state, { count: counts[state] }))].join(' · ') || t('activity.idle')
      const budget = stats.captureBudget
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

      return h('section', { className: 'dsh-memory-extraction-status' },
        h('div', { className: 'dsh-memory-activity-line' },
          h(ActivityHeading, { title: t('activity.extraction'), value, warning }),
          canRetry ? h('button', { type: 'button', className: 'dsh-memory-button', onClick: retryCapture, disabled: retrying || !call },
            t('settings.captureRetry')) : null),
        budget?.waiting > 0 ? h('p', { className: 'dsh-memory-muted', role: 'status' },
          t(budget.resumeAt ? 'settings.captureResume' : 'settings.capturePaused', {
            count: budget.waiting, time: formatTime(budget.resumeAt, locale),
          })) : null,
        notice ? h('p', { className: 'dsh-memory-settings-notice', role: 'status' }, notice) : null)
    }

    function ActivityTrends({ stats, activity, locale, t }) {
      const storage = stats.captureStorage
      const [open, setOpen] = React.useState(true)
      return h('details', { className: 'dsh-memory-trends-section dsh-memory-disclosure', open, onToggle: event => setOpen(event.currentTarget.open) },
        h('summary', { className: 'dsh-memory-disclosure-head dsh-memory-section-title' }, t('activity.trends')),
        open ? h('div', { className: 'dsh-memory-trends-body' },
          h(ActivityHeatmap, { activity, t, locale }),
          h(TokenTrend, { usage: stats.usage, t }),
          stats.captureBudget || storage ? h('div', { className: 'dsh-memory-trend-facts' },
            stats.captureBudget ? h('span', null, t('settings.captureAllowance', stats.captureBudget)) : null,
            storage ? h('span', null, t('settings.captureStorage', {
              sources: String(storage.sources?.count ?? 0),
              size: ((storage.bytes ?? 0) / 1024 / 1024).toFixed(1) + ' MB',
              tasks: String(storage.tasks ?? 0),
            })) : null) : null) : null)
    }

    function HealthStatus({ health, capture, t, onRepair }) {
      if (!health) return null
      const download = () => {
        const blob = new Blob([JSON.stringify(health, null, 2)], { type: 'application/json' })
        const url = URL.createObjectURL(blob), anchor = document.createElement('a')
        anchor.href = url; anchor.download = 'dsh-memory-diagnostics.json'; anchor.click()
        setTimeout(() => URL.revokeObjectURL(url), 1000)
      }
      const queueNeedsRecovery = capture?.failed > 0 || capture?.partial > 0 || capture?.unknown > 0
      const issues = health.issues.filter(code => code !== 'capture-incomplete' || !queueNeedsRecovery)
      return h('section', null,
        h(ActivityDisclosure, { title: t('health.title'), value: t('health.' + health.status), warning: health.status !== 'ok' },
          health.isolation === 'unavailable' ? null : h('p', { className: 'dsh-memory-muted' }, t('health.' + health.isolation)),
          health.status === 'unavailable' ? null : h('p', { className: 'dsh-memory-muted' }, t('health.memories', health.counts)),
          h('div', { className: 'dsh-memory-settings-group' }, Object.entries(health.components ?? {}).map(([key, component]) => {
            const repair = component.action !== 'none' && component.state !== 'disabled' && onRepair
            const state = t('health.state.' + component.state)
            return h(SettingRow, { key, label: t('health.component.' + key), hint: repair ? state : null },
              repair ? h('button', { type: 'button', className: 'dsh-memory-button', onClick: () => onRepair(component.action) }, t('health.action.' + component.action))
                : h('span', { className: 'dsh-memory-muted' }, state))
          })),
          h('div', { className: 'dsh-memory-detail-actions' },
            h('p', { className: 'dsh-memory-help' }, t('health.hint')),
            h('button', { type: 'button', className: 'dsh-memory-button', onClick: download }, t('health.download')))),
        issues.length ? h('ul', { className: 'dsh-memory-activity-issues', role: 'status' },
          issues.map(code => h('li', { key: code }, t('health.' + code),
            code === 'corrupt-lines' && health.counts?.corruptLines ? ' ' + t('health.corrupt', { count: health.counts.corruptLines }) : null))) : null)
    }

    function SemanticModelControls({ call, initial, t }) {
      const [status, setStatus] = React.useState(initial)
      const [folder, setFolder] = React.useState('')
      const [busy, setBusy] = React.useState('')
      const [error, setError] = React.useState('')
      const operationVersion = React.useRef(0), statusVersion = React.useRef(0)
      const active = ['preparing', 'downloading', 'importing', 'loading', 'indexing'].includes(status?.state)
      React.useEffect(() => {
        if (!busy && !active) setStatus(initial)
      }, [initial])
      React.useEffect(() => {
        if (!call || (!busy && !active)) return undefined
        let stopped = false
        const read = () => {
          const version = ++statusVersion.current
          return call('semanticModel', { action: 'status' }).then(value => {
            if (!stopped && version === statusVersion.current) { setStatus(value); setError('') }
          }).catch(value => { if (!stopped && version === statusVersion.current) setError(messageOf(value)) })
        }
        void read()
        const timer = setInterval(read, 1200)
        return () => { stopped = true; clearInterval(timer) }
      }, [call, busy, active])
      const run = async (action) => {
        const version = ++operationVersion.current
        statusVersion.current++
        setBusy(action);setError('')
        try {
          const result = await call('semanticModel', { action, ...(action === 'import' ? { sourceDir: folder } : {}) })
          if (version === operationVersion.current) setStatus(result)
        } catch (value) { if (version === operationVersion.current) setError(messageOf(value)) }
        finally { if (version === operationVersion.current) setBusy('') }
      }
      const title = t('recall.semantic')
      const value = t('recall.semantic.' + (status?.state ?? 'idle'))
      if (!call || status?.state === 'disabled') return h(ActivityDisclosure, { title, value })
      const progress = status?.progress
      return h(ActivityDisclosure, { title, value, warning: !!status?.error || status?.state === 'failed' },
        progress?.total ? h('p', { className: 'dsh-memory-muted', role: 'status' },
          t('recall.model.progress', { file: progress.asset ?? '', done: String(progress.downloaded ?? 0), total: String(progress.total) })) : null,
        progress?.total ? h('progress', { max: progress.total, value: Math.min(progress.total, progress.downloaded ?? 0), 'aria-label': t('recall.semantic') }) : null,
        status?.total ? h('p', { className: 'dsh-memory-muted' },
          t('recall.semanticProgress', { indexed: String(status.indexed), total: String(status.total) })) : null,
        h(SettingRow, { label: t('recall.model.folder'), hint: t('recall.model.folderHint') },
          description => h('input', { className: 'dsh-memory-settings-input', type: 'text', value: folder,
            title: folder || undefined, onChange: event => setFolder(event.target.value), 'aria-label': t('recall.model.folder'), 'aria-describedby': description })),
        h('div', { className: 'dsh-memory-settings-buttons' },
          active
            ? h('button', { type: 'button', className: 'dsh-memory-button', disabled: !!busy, onClick: () => run('cancel') }, t('recall.model.cancel'))
            : h('button', { type: 'button', className: 'dsh-memory-button', disabled: !!busy, onClick: () => run(status?.state === 'failed' ? 'retry' : 'prepare') },
              t(status?.state === 'failed' ? 'recall.model.retry' : 'recall.model.prepare')),
          h('button', { type: 'button', className: 'dsh-memory-button', disabled: !!busy || !folder.trim(), onClick: () => run('import') }, t('recall.model.import'))),
        error ? h('p', { className: 'dsh-memory-error-text', role: 'alert' }, error) : null)
    }

    const EMPTY_SESSION_SOURCE = { subscribe: () => () => {}, getSnapshot: () => null }
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
      const loadGeneration = React.useRef(0)
      const sessionRequestGeneration = React.useRef(0)
      const projectViewGeneration = React.useRef(0)
      const projectSelectionRef = React.useRef(projectSelection)
      projectSelectionRef.current = projectSelection
      const activeSessionId = React.useRef(sessionId)
      activeSessionId.current = sessionId
      const data = dataState !== null && dataState.scope === scope && dataState.sessionId === sessionId ? dataState : null

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
        { key: 'settings', views: ['capture', 'data', 'obsidian'] },
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
      const pageTop = h('div', { className: 'dsh-memory-page-top' }, header, viewTabs)
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
        return h('div', { className: 'dsh-memory-root' }, pageTop,
          error ? h('p', { className: 'dsh-memory-error-text', role: 'alert' }, error) : null,
          h(ProjectBrief, { call, t, locale, initialProject: stats?.currentProjectKey, projectKeys: stats?.projectKeys ?? [] }))
      }

      if (view === 'activity') {
        return h('div', { className: 'dsh-memory-root' }, pageTop,
          error ? h('p', { className: 'dsh-memory-error-text', role: 'alert' }, error) : null,
          stats ? h('div', { className: 'dsh-memory-activity-view' },
            h(ContextUsage, { sessionId,
              sample: activeSessionPanel === null ? null : { sessionId: activeSessionPanel.sessionId, usage: activeSessionPanel.usage },
              enabled: activeSessionPanel?.injectEnabled ?? stats.injectEnabled, t, locale }),
            h(MemoryTotals, { stats, t, locale }),
            h(ActivityTrends, { stats, activity: data?.activity, t, locale }),
            h('section', { className: 'dsh-memory-activity-operations' },
              h('h3', { className: 'dsh-memory-section-title' }, t('activity.operations')),
              h(ExtractionStatus, { stats, call, t, locale, onSaved: load }),
              h(RecallReport, { report: activeSessionPanel?.report ?? null, t, locale, call, onSaved: reloadAfterRecallChange }),
              h(HealthStatus, { health: stats.health, capture: stats.capture, t, onRepair: repairHealth }),
              stats.semantic ? h(SemanticModelControls, { call, initial: stats.semantic, t }) : null)) : null)
      }

      if (view === 'profile') {
        return h('div', { className: 'dsh-memory-root' },
          pageTop,
          notice === '' ? null : h('p', { className: 'dsh-memory-notice', role: 'status' }, notice),
          error === '' ? null : h('p', { className: 'dsh-memory-error-text', role: 'alert' }, error),
          h(ProfileView, { profile: data === null ? null : data.profile, t }))
      }

      if (view === 'library') {
        return h('div', { className: 'dsh-memory-root' },
          pageTop,
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

      if (view === 'capture' || view === 'data' || view === 'obsidian') {
        return h('div', { className: 'dsh-memory-root' },
          pageTop,
          notice === '' ? null : h('p', { className: 'dsh-memory-notice', role: 'status' }, notice),
          error === '' ? null : h('p', { className: 'dsh-memory-error-text', role: 'alert' }, error),
          h(SettingsCard, { stats, call, t, onSaved: load, group: view, onRebuild: rebuild, rebuilding: busy === 'rebuild', actionBusy: busy !== '' }))
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
      const closeHistory = () => setHistoryRecord(null)
      const historyModal = historyRecord === null ? null : h(PanelDialog, { title: t('history.title'), onClose: closeHistory },
        historyBusy
          ? h('p', { className: 'dsh-memory-muted', role: 'status' }, t('history.loading'))
          : historyError !== ''
            ? h('p', { className: 'dsh-memory-error-text', role: 'alert' }, historyError)
            : h('ul', { className: 'dsh-memory-history' }, revisionRows),
        h('div', { className: 'dsh-memory-modal-actions' },
          h('button', { type: 'button', className: 'dsh-memory-button', onClick: closeHistory }, t('actions.close'))))
      const closeBulkTag = () => { setBulkTagOpen(false); setBulkTagValue('') }
      const bulkTagModal = bulkTagOpen ? h(PanelDialog, { title: t('bulk.tagTitle'), onClose: closeBulkTag, busy: busy !== '' },
        h('input', {
          className: 'dsh-memory-input',
          'aria-label': t('bulk.tagTitle'),
          value: bulkTagValue,
          placeholder: t('bulk.tagPlaceholder'),
          onChange: (event) => setBulkTagValue(event.target.value),
        }),
        h('div', { className: 'dsh-memory-modal-actions' },
          h('button', { type: 'button', className: 'dsh-memory-button', onClick: closeBulkTag, disabled: busy !== '' }, t('actions.cancel')),
          h('button', { type: 'button', className: 'dsh-memory-button dsh-memory-button-primary', disabled: bulkTagValue.trim() === '' || busy !== '', onClick: submitBulkTag }, t('bulk.tagApply')))) : null
      const closeTopicSuggestions = () => setTopicSuggestOpen(false)
      const topicModal = topicSuggestOpen ? h(PanelDialog, { title: t('topic.mergeTitle'), onClose: closeTopicSuggestions },
        topicSuggestBusy ? h('p', { className: 'dsh-memory-muted', role: 'status' }, t('history.loading')) : suggestionNode,
        h('div', { className: 'dsh-memory-modal-actions' },
          h('button', { type: 'button', className: 'dsh-memory-button', onClick: closeTopicSuggestions }, t('actions.close')))) : null

      const topics = Object.keys(topicCounts).filter(key => key !== '__none__').sort()
      const filterCount = Number(status !== '') + Number(topic !== '')

      return h('div', { className: 'dsh-memory-root' },
        pageTop,
        h('div', { className: 'dsh-memory-toolbar' },
          h('div', { className: 'dsh-memory-search-row' },
            h('input', {
              className: 'dsh-memory-input',
              type: 'search',
              value: queryInput,
              placeholder: t('filter.searchPlaceholder'),
              onChange: event => setQueryInput(event.target.value),
              'aria-label': t('filter.search'),
            }),
            h('button', {
              type: 'button',
              className: 'dsh-memory-button',
              onClick: () => runAction('refresh', async () => {}, null),
              disabled: loading || busy !== '',
            }, t('actions.refresh'))),
          h('div', { className: 'dsh-memory-scope' },
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
            }, projectOptions.map(key => h('option', { key, value: key, title: key }, key)))) : null),
          h('details', { className: 'dsh-memory-filter-details dsh-memory-disclosure' },
            h('summary', { className: 'dsh-memory-disclosure-head' }, t('filter.more'), filterCount > 0 ? ' · ' + filterCount : ''),
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
            h(Field, { label: t('filter.topic') },
              h(Select, { className: 'dsh-memory-select', value: topic,
                'aria-label': t('filter.topic'),
                onChange: event => { setTopic(event.target.value); setPage(0) },
              },
              h('option', { value: '' }, t('filter.topic.all')),
              h('option', { value: '__none__' }, t('filter.topic.none')),
              topics.map(key => h('option', { key, value: key }, key + ' (' + String(topicCounts[key]) + ')')))),
            topics.length > 1 ? h('div', { className: 'dsh-memory-filter-actions' },
              h('button', { type: 'button', className: 'dsh-memory-button', onClick: openTopicSuggestions }, t('topic.suggest'))) : null)),
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
          kind === '' && total === kindCountsTotal ? null
            : h('span', { className: 'dsh-memory-list-total' }, t('pager.total', { total: String(total) }))),
        loading && data === null ? h('p', { className: 'dsh-memory-muted', role: 'status' }, t('list.loading')) : null,
        error !== '' || (loading && data === null) ? null : items.length === 0
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
              const deleted = record.status === 'deleted'
              const isConfirming = (deleted ? purgingId : confirmingId) === record.id
              const actionBusy = busy !== ''
              const deleteLabel = deleted ? (isConfirming ? 'actions.purgeConfirm' : 'actions.purge')
                : (isConfirming ? 'actions.deleteConfirm' : 'actions.delete')
              const deleteRecord = () => {
                if (deleted) { void purge(record); return }
                if (!isConfirming) { setConfirmingId(record.id); return }
                setConfirmingId('')
                void remove(record)
              }
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
                    deleted
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
                    ]),
                  h('div', { className: 'dsh-memory-row-danger' }, h('button', {
                    type: 'button',
                    className: 'dsh-memory-button',
                    'data-danger': 'true',
                    'data-confirming': isConfirming,
                    onClick: deleteRecord,
                    disabled: actionBusy,
                  }, t(deleteLabel)))))
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
