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
    const METHODS = ['list', 'stats', 'activity', 'profile', 'update', 'removeMemory', 'rebuildIndex', 'updateSettings', 'exportData', 'importData', 'backup', 'restoreMemory', 'purgeMemory', 'history', 'restoreRevision', 'bulkAction', 'topicSuggestions', 'mergeTopics', 'obsidianExport', 'obsidianImport', 'obsidianStatus', 'knowledgeGraph', 'knowledgePromote', 'knowledgeList', 'knowledgeNote', 'knowledgeSave', 'knowledgeSync']
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
      knowledgeGraph: 'MemoryKnowledgeGraph',
      knowledgePromote: 'MemoryKnowledgePromote',
      knowledgeList: 'MemoryKnowledgeList',
      knowledgeNote: 'MemoryKnowledgeNote',
      knowledgeSave: 'MemoryKnowledgeSave',
      knowledgeSync: 'MemoryKnowledgeSync',
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
        'view.memory': 'Memories',
        'view.knowledge': 'Knowledge map',
        'view.library': 'Knowledge base',
        'view.settings': 'Settings',
        'view.capture': 'Capture & injection',
        'view.retention': 'Retention & maintenance',
        'view.data': 'Data',
        'view.obsidian': 'Obsidian',
        'library.title': 'Knowledge base',
        'library.hint': 'Long-term notes promoted from memories. Sync them with your Obsidian vault below.',
        'library.empty': 'No long-term notes yet. Open the knowledge map and promote a memory.',
        'library.loading': 'Loading knowledge notes…',
        'library.failed': 'Knowledge base failed: {reason}',
        'library.total': '{count} notes',
        'library.vault': 'Vault: {path}',
        'library.noVault': 'Configure the Obsidian vault in Settings first.',
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
        'knowledge.title': 'Knowledge map',
        'knowledge.hint': 'Topics are hubs; lines are shared tags. Drag to pan, scroll to zoom, click a node for details.',
        'knowledge.search': 'Search memories or topics',
        'knowledge.zoomIn': 'Zoom in',
        'knowledge.zoomOut': 'Zoom out',
        'knowledge.reset': 'Reset',
        'knowledge.topicChip': 'Topic: {topic}',
        'knowledge.empty': 'No memories to visualize yet.',
        'knowledge.loading': 'Building the knowledge map…',
        'knowledge.failed': 'Knowledge map failed: {reason}',
        'knowledge.stats': '{memories} memories · {topics} topics · {tags} tags',
        'knowledge.truncated': 'Showing the most recent 400 memories.',
        'knowledge.detail': 'Details',
        'knowledge.promote': 'Promote to knowledge',
        'knowledge.promoting': 'Promoting…',
        'knowledge.promoted': 'Knowledge note written: {path}',
        'knowledge.promoteFailed': 'Promote failed: {reason}',
        'knowledge.knowledgeNote': 'Long-term knowledge note',
        'knowledge.vaultNote': 'Vault note. Import it into the knowledge base to edit it here.',
        'knowledge.legendMemories': 'Memories',
        'knowledge.legendKnowledge': 'Knowledge notes',
        'knowledge.legendVault': 'Vault notes',
        'knowledge.traitNote': 'Profile preference derived from evidence memories',
        'knowledge.noSelection': 'Click a node to inspect it.',
        'knowledge.kind': 'Kind',
        'knowledge.status': 'Status',
        'knowledge.topic': 'Topic',
        'knowledge.confidence': 'Confidence',
        'knowledge.tags': 'Tags',
        'settings.title': 'Memory settings',
        'settings.capture': 'Auto capture',
        'settings.inject': 'Context injection',
        'settings.budget': 'Injection budget',
        'settings.retention': 'Episode retention',
        'settings.maintenance': 'Self-maintenance',
        'settings.group.capture': 'Capture & injection',
        'settings.group.retention': 'Retention & maintenance',
        'settings.group.data': 'Data',
        'settings.group.obsidian': 'Obsidian',
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
        'data.backup': 'Backup now',
        'data.exported': 'Exported',
        'data.imported': 'Imported {imported}, skipped {skipped}',
        'data.backupDone': 'Backup written to {path}',
        'data.failed': 'Failed: {reason}',
        'settings.failed': 'Save failed: {reason}',
        'settings.maintenance.none': 'Self-maintenance has not run yet',
        'settings.maintenance.summary': 'Last maintenance: archived {archived} · pruned {pruned} backups',
        'settings.inject.usage': 'Last injection {tokens}/{budget} tokens',
        'settings.extract.usage': 'extraction {tokens} tokens',
        'usage.title': 'Token usage · last 7 days',
        'usage.total': '{tokens} tokens',
        'usage.inject': 'Injection',
        'usage.extract': 'Extraction',
        'usage.empty': 'No usage recorded yet. Injection and extraction counts appear here.',
        'usage.day': '{date} · injection {inject} · extraction {extract}',
        'usage.avg': 'Avg {tokens}/turn',
        'usage.overBudget': '{count} over budget',
        'view.profile': 'User profile',
        'profile.hint': 'Durable preferences grouped with evidence. Expand a row to see the source memories.',
        'profile.empty': 'No stable preferences yet.',
        'profile.evidenceTitle': 'Evidence',
        'profile.title': 'User profile',
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
        'view.memory': '\u8bb0\u5fc6',
        'view.knowledge': '\u77e5\u8bc6\u56fe\u8c31',
        'view.library': '\u77e5\u8bc6\u5e93',
        'view.settings': '\u8bbe\u7f6e',
        'view.capture': '\u6355\u83b7\u4e0e\u6ce8\u5165',
        'view.retention': '\u4fdd\u7559\u4e0e\u7ef4\u62a4',
        'view.data': '\u6570\u636e',
        'view.obsidian': 'Obsidian',
        'library.title': '\u77e5\u8bc6\u5e93',
        'library.hint': '\u7531\u8bb0\u5fc6\u63d0\u5347\u7684\u957f\u671f\u7b14\u8bb0\uff0c\u53ef\u540c\u6b65\u5230 Obsidian\u3002',
        'library.empty': '\u8fd8\u6ca1\u6709\u957f\u671f\u7b14\u8bb0\uff1a\u53bb\u77e5\u8bc6\u56fe\u8c31\u63d0\u5347\u4e00\u6761\u8bb0\u5fc6\u5427\u3002',
        'library.loading': '\u6b63\u5728\u52a0\u8f7d\u77e5\u8bc6\u7b14\u8bb0\u2026',
        'library.failed': '\u77e5\u8bc6\u5e93\u52a0\u8f7d\u5931\u8d25\uff1a{reason}',
        'library.total': '{count} \u6761\u7b14\u8bb0',
        'library.vault': 'Vault\uff1a{path}',
        'library.noVault': '\u5148\u5728\u300c\u8bbe\u7f6e\u300d\u91cc\u914d\u7f6e Obsidian vault\u3002',
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
        'knowledge.title': '\u77e5\u8bc6\u56fe\u8c31',
        'knowledge.hint': '\u4e3b\u9898\u662f\u4e2d\u5fc3\u8282\u70b9\uff0c\u8fde\u7ebf\u662f\u5171\u4eab\u6807\u7b7e\u3002\u62d6\u52a8\u5e73\u79fb\u3001\u6eda\u8f6e\u7f29\u653e\uff0c\u70b9\u51fb\u8282\u70b9\u67e5\u770b\u8be6\u60c5\u3002',
        'knowledge.search': '\u641c\u7d22\u8bb0\u5fc6\u6216\u4e3b\u9898',
        'knowledge.zoomIn': '\u653e\u5927',
        'knowledge.zoomOut': '\u7f29\u5c0f',
        'knowledge.reset': '\u91cd\u7f6e',
        'knowledge.topicChip': '\u4e3b\u9898\uff1a{topic}',
        'knowledge.empty': '\u6682\u65e0\u53ef\u53ef\u89c6\u5316\u7684\u8bb0\u5fc6\u3002',
        'knowledge.loading': '\u6b63\u5728\u6784\u5efa\u77e5\u8bc6\u56fe\u8c31\u2026',
        'knowledge.failed': '\u77e5\u8bc6\u56fe\u8c31\u52a0\u8f7d\u5931\u8d25\uff1a{reason}',
        'knowledge.stats': '{memories} \u6761\u8bb0\u5fc6 \u00b7 {topics} \u4e2a\u4e3b\u9898 \u00b7 {tags} \u4e2a\u6807\u7b7e',
        'knowledge.truncated': '\u4ec5\u5c55\u793a\u6700\u8fd1 400 \u6761\u8bb0\u5fc6\u3002',
        'knowledge.detail': '\u8be6\u60c5',
        'knowledge.promote': '\u63d0\u5347\u4e3a\u77e5\u8bc6',
        'knowledge.promoting': '\u63d0\u5347\u4e2d\u2026',
        'knowledge.promoted': '\u5df2\u5199\u5165\u77e5\u8bc6\u7b14\u8bb0\uff1a{path}',
        'knowledge.promoteFailed': '\u63d0\u5347\u5931\u8d25\uff1a{reason}',
        'knowledge.knowledgeNote': '\u957f\u671f\u77e5\u8bc6\u7b14\u8bb0',
        'knowledge.vaultNote': 'Vault \u7b14\u8bb0\u3002\u5bfc\u5165\u77e5\u8bc6\u5e93\u540e\u53ef\u5728\u6b64\u7f16\u8f91\u3002',
        'knowledge.legendMemories': '\u8bb0\u5fc6',
        'knowledge.legendKnowledge': '\u77e5\u8bc6\u7b14\u8bb0',
        'knowledge.legendVault': 'Vault \u7b14\u8bb0',
        'knowledge.traitNote': '\u7531\u8bc1\u636e\u8bb0\u5fc6\u5f52\u7eb3\u7684\u753b\u50cf\u504f\u597d',
        'knowledge.noSelection': '\u70b9\u51fb\u4e00\u4e2a\u8282\u70b9\u67e5\u770b\u8be6\u60c5\u3002',
        'knowledge.kind': '\u7c7b\u578b',
        'knowledge.status': '\u72b6\u6001',
        'knowledge.topic': '\u4e3b\u9898',
        'knowledge.confidence': '\u7f6e\u4fe1\u5ea6',
        'knowledge.tags': '\u6807\u7b7e',
        'settings.title': '\u8bb0\u5fc6\u8bbe\u7f6e',
        'settings.capture': '\u81ea\u52a8\u6355\u83b7',
        'settings.inject': '\u4e0a\u4e0b\u6587\u6ce8\u5165',
        'settings.budget': '\u6ce8\u5165\u9884\u7b97',
        'settings.retention': '\u7247\u6bb5\u4fdd\u7559',
        'settings.maintenance': '\u81ea\u7ef4\u62a4',
        'settings.group.capture': '\u6355\u83b7\u4e0e\u6ce8\u5165',
        'settings.group.retention': '\u4fdd\u7559\u4e0e\u7ef4\u62a4',
        'settings.group.data': '\u6570\u636e',
        'settings.group.obsidian': 'Obsidian',
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
        'data.backup': '\u7acb\u5373\u5907\u4efd',
        'data.exported': '\u5df2\u5bfc\u51fa',
        'data.imported': '\u5df2\u5bfc\u5165 {imported} \u6761\uff0c\u8df3\u8fc7 {skipped} \u6761',
        'data.backupDone': '\u5907\u4efd\u5df2\u5199\u5165 {path}',
        'data.failed': '\u64cd\u4f5c\u5931\u8d25\uff1a{reason}',
        'settings.failed': '\u4fdd\u5b58\u5931\u8d25\uff1a{reason}',
        'settings.maintenance.none': '\u5c1a\u672a\u6267\u884c\u81ea\u7ef4\u62a4',
        'settings.maintenance.summary': '\u4e0a\u6b21\u81ea\u7ef4\u62a4\uff1a\u5f52\u6863 {archived} \u6761 \u00b7 \u6e05\u7406\u5907\u4efd {pruned} \u4efd',
        'settings.inject.usage': '\u4e0a\u6b21\u6ce8\u5165 {tokens}/{budget} token',
        'settings.extract.usage': '\u62bd\u53d6 {tokens} token',
        'usage.title': 'Token 用量 · 近 7 天',
        'usage.total': '共 {tokens} token',
        'usage.inject': '注入',
        'usage.extract': '抽取',
        'usage.empty': '暂无用量，注入或抽取后开始统计。',
        'usage.day': '{date} · 注入 {inject} · 抽取 {extract}',
        'usage.avg': '平均 {tokens}/回合',
        'usage.overBudget': '{count} 次超预算',
        'view.profile': '\u7528\u6237\u753b\u50cf',
        'profile.hint': '\u7531\u6301\u4e45\u504f\u597d\u5f52\u7eb3\uff0c\u6bcf\u6761\u90fd\u5e26\u8bc1\u636e\u3002',
        'profile.empty': '\u8fd8\u6ca1\u6709\u7a33\u5b9a\u504f\u597d\u3002',
        'profile.evidenceTitle': '\u8bc1\u636e',
        'profile.title': '\u7528\u6237\u753b\u50cf',
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
      },
    }

    const CSS = [
      'html:has(.dsh-memory-root),body:has(.dsh-memory-root){scrollbar-gutter:stable}',
      '*:has(.dsh-memory-root){scrollbar-gutter:stable}',
      '.dsh-memory-root{max-width:760px;display:flex;flex-direction:column;gap:14px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5;container-type:inline-size}',
      '.dsh-memory-heading{margin:0;font-size:18px;font-weight:600;line-height:26px}',
      '.dsh-memory-intro{margin:0;color:var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary));font-size:13px}',
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
      '.dsh-memory-palette-menu{position:absolute;top:calc(100% + 4px);left:0;z-index:20;min-width:176px;display:flex;flex-direction:column;gap:2px;padding:6px;border:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.25));border-radius:10px;background:var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-layer-2,#fff));box-shadow:0 8px 24px rgba(0,0,0,.14)}',
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
      '.dsh-memory-toolbar{display:flex;flex-wrap:wrap;gap:8px;align-items:flex-end}',
      '.dsh-memory-toolbar .dsh-memory-field{flex:0 0 auto;min-width:0}',
      '.dsh-memory-toolbar .dsh-memory-select{max-width:118px;min-width:0;font-size:12px}',
      '.dsh-memory-toolbar-actions{display:flex;gap:6px;margin-left:auto;padding-bottom:1px;flex:0 0 auto}',
      '.dsh-memory-field{display:flex;flex-direction:column;gap:3px;min-width:0}',
      '.dsh-memory-field-label{color:var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary));font-size:11px;line-height:16px}',
      '.dsh-memory-field-grow{flex:1 1 0;min-width:110px}',
      '.dsh-memory-input,.dsh-memory-select{box-sizing:border-box;height:28px;padding:3px 8px;border:.5px solid var(--dsw-alias-border-l3, var(--dsw-alias-border-l1));border-radius:var(--dsw-radius-sm, 6px);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:20px}',
      '.dsh-memory-textarea{box-sizing:border-box;min-height:28px;padding:4px 8px;border:.5px solid var(--dsw-alias-border-l3, var(--dsw-alias-border-l1));border-radius:var(--dsw-radius-sm, 6px);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:20px}',
      '.dsh-memory-input::placeholder,.dsh-memory-textarea::placeholder{color:var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary))}',
      '.dsh-memory-input:focus-visible,.dsh-memory-select:focus-visible,.dsh-memory-textarea:focus-visible,.dsh-memory-button:focus-visible{outline:var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary)));outline-offset:1px}',
      '.dsh-memory-textarea{resize:vertical;min-height:96px;line-height:1.5}',
      '.dsh-memory-spacer{flex:1 1 auto}',
      '.dsh-memory-button{box-sizing:border-box;min-height:28px;padding:3px 10px;border:.5px solid var(--dsw-alias-border-l3, var(--dsw-alias-border-l1));border-radius:var(--dsw-radius-sm, 6px);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:20px;cursor:pointer}',
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
      '.dsh-memory-toolbar{display:grid;grid-template-columns:repeat(3,minmax(0,1fr)) minmax(110px,1.6fr) auto;gap:8px;align-items:end;margin-top:14px;padding:14px;border:.5px solid var(--dsh-memory-card-border);border-radius:var(--dsh-memory-radius);background:var(--dsh-memory-card-bg)}',
      '.dsh-memory-toolbar .dsh-memory-field{min-width:0}',
      '.dsh-memory-toolbar .dsh-memory-select{width:100%;max-width:none}',
      '.dsh-memory-toolbar[data-narrow="true"]{grid-template-columns:repeat(12,minmax(0,1fr))}',
      '.dsh-memory-toolbar[data-narrow="true"] .dsh-memory-field{grid-column:span 4}',
      '.dsh-memory-toolbar[data-narrow="true"] .dsh-memory-field-grow{grid-column:span 6}',
      '.dsh-memory-toolbar[data-narrow="true"] .dsh-memory-toolbar-actions{grid-column:span 6;justify-content:stretch;gap:8px;margin-left:0}',
      '.dsh-memory-toolbar[data-narrow="true"] .dsh-memory-toolbar-actions .dsh-memory-button{flex:1;min-width:0;padding:0 6px}',
      '.dsh-memory-list{display:flex;flex-direction:column;gap:10px;margin:10px 0 0;padding:0;list-style:none}',
      '.dsh-memory-row{padding:12px 14px;border:.5px solid var(--dsh-memory-card-border);border-left:2px solid var(--dsh-memory-kind-color,var(--dsw-alias-border-l2,#d3d8e0));border-radius:var(--dsh-memory-radius);background:var(--dsh-memory-card-bg)}',
      '.dsh-memory-row[data-kind="decision"]{--dsh-memory-kind-color:#6d4aff}',
      '.dsh-memory-row[data-kind="fact"]{--dsh-memory-kind-color:#0d7f8c}',
      '.dsh-memory-row[data-kind="preference"]{--dsh-memory-kind-color:#2f6df6}',
      '.dsh-memory-row[data-kind="episode"]{--dsh-memory-kind-color:#b7791f}',
      '.dsh-memory-row-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.dsh-memory-kind{display:inline-flex;align-items:center;height:20px;padding:0 6px;border:0;border-radius:5px;font-size:11px;line-height:20px;color:var(--dsh-memory-kind-color,var(--dsw-alias-label-secondary));background:color-mix(in srgb,var(--dsh-memory-kind-color,#6b7280) 12%,transparent)}',
      '.dsh-memory-status-pill{display:inline-flex;align-items:center;height:20px;padding:0 6px;border-radius:5px;font-size:11px;line-height:20px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary))}',
      '.dsh-memory-status-pill[data-status="active"]{color:var(--dsw-alias-state-success-primary,#1a9e63);background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#1a9e63) 12%,transparent)}',
      '.dsh-memory-status-pill[data-status="candidate"]{color:var(--dsw-alias-state-warn-primary,#b7791f);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#b7791f) 12%,transparent)}',
      '.dsh-memory-row-meta{display:flex;gap:10px;margin-left:auto;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));font-size:11.5px}',
      '.dsh-memory-content{margin:6px 0 0;font-size:13px;line-height:1.55}',
      '.dsh-memory-row-foot{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:9px}',
      '.dsh-memory-tags{display:flex;gap:6px;margin:0;padding:0;list-style:none;flex-wrap:wrap}',
      '.dsh-memory-tag{height:20px;padding:0 6px;border-radius:5px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:20px}',
      '.dsh-memory-row-actions{display:flex;gap:4px;align-items:center;margin-left:auto}',
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
      '.dsh-memory-settings-title{margin:0;font-size:15px;font-weight:600;line-height:22px;color:var(--dsw-alias-label-primary,#1f2328)}',
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
      '.dsh-memory-settings-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsh-memory-view-tabs{display:flex;flex-wrap:wrap;justify-content:center;width:100%;box-sizing:border-box;gap:2px;padding:3px;margin:10px 0 2px;border:.5px solid var(--dsh-memory-card-border);border-radius:9px;background:var(--dsw-alias-bg-layer-2,#f5f6f8)}',
      '.dsh-memory-view-tab{border:0;background:transparent;padding:5px 9px;border-radius:7px;font:inherit;font-size:12px;font-weight:600;line-height:18px;white-space:nowrap;flex:0 0 auto;color:var(--dsw-alias-label-secondary,#6b7280);cursor:pointer}',
      '.dsh-memory-view-tab[data-active="true"]{background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1f2328);box-shadow:0 1px 2px rgba(0,0,0,.08)}',
      '.dsh-memory-knowledge{display:flex;flex-direction:column;gap:8px}',
      '.dsh-memory-knowledge-head{display:flex;align-items:baseline;justify-content:space-between;gap:10px;flex-wrap:wrap}',
      '.dsh-memory-graph-tools{display:flex;align-items:center;gap:6px;flex-wrap:wrap}',
      '.dsh-memory-graph-search{box-sizing:border-box;height:28px;min-width:0;flex:1 1 180px;max-width:280px;border:.5px solid var(--dsh-memory-card-border);border-radius:7px;padding:0 8px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1f2328);font:inherit;font-size:12px}',
      '.dsh-memory-graph-btn{box-sizing:border-box;height:28px;min-width:28px;padding:0 8px;border:.5px solid var(--dsh-memory-card-border);border-radius:7px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1f2328);font:inherit;font-size:12px;cursor:pointer}',
      '.dsh-memory-graph-chip{box-sizing:border-box;height:28px;padding:0 10px;border:.5px solid var(--dsw-alias-state-business-primary,#2f6df6);border-radius:14px;background:transparent;color:var(--dsw-alias-state-business-primary,#2f6df6);font:inherit;font-size:12px;cursor:pointer}',
      '.dsh-memory-graph-wrap{overflow:hidden;border:.5px solid var(--dsh-memory-card-border);border-radius:10px;background:var(--dsw-alias-bg-layer-1,#fff);cursor:grab;touch-action:none}',
      '.dsh-memory-graph-hit{fill:transparent}',
      '.dsh-memory-graph-node-group{cursor:pointer}',
      '.dsh-memory-graph-results{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;max-height:180px;overflow:auto}',
      '.dsh-memory-graph-result{display:flex;justify-content:space-between;gap:10px;width:100%;border:0;background:transparent;padding:4px 2px;font:inherit;font-size:12px;text-align:left;color:var(--dsw-alias-label-primary,#1f2328);cursor:pointer}',
      '.dsh-memory-graph{display:block;width:100%;height:auto}',
      '.dsh-memory-graph-edge{stroke:var(--dsw-alias-border-l3,rgba(127,127,127,.35));stroke-width:1;opacity:.55}',
      '.dsh-memory-graph-edge[data-type="tag"]{stroke:var(--dsw-alias-state-business-primary,#2f6df6);stroke-dasharray:3 3;opacity:.45}',
      '.dsh-memory-graph-hub circle{fill:color-mix(in srgb,var(--dsw-alias-label-tertiary,#6b7280) 14%,transparent);stroke:var(--dsw-alias-border-l3,rgba(127,127,127,.35))}',
      '.dsh-memory-graph-hub-label{font-size:11px;fill:var(--dsw-alias-label-secondary,#6b7280)}',
      '.dsh-memory-graph-node{cursor:pointer;stroke:var(--dsw-alias-bg-layer-1,#fff);stroke-width:1.5}',
      '.dsh-memory-graph-node[data-kind="preference"]{fill:#2f6df6}',
      '.dsh-memory-graph-node[data-kind="fact"]{fill:#1a9e63}',
      '.dsh-memory-graph-node[data-kind="decision"]{fill:#b7791f}',
      '.dsh-memory-graph-node[data-kind="episode"]{fill:#8b5cf6}',
      '.dsh-memory-graph-node[data-kind="trait"]{fill:#eab308}',
      '.dsh-memory-graph-node[data-kind="knowledge"]{fill:#0ea5e9}',
      '.dsh-memory-graph-node[data-kind="vault"]{fill:#14b8a6}',
      '.dsh-memory-graph-edge[data-type="wiki"]{stroke:#0ea5e9;stroke-dasharray:2 3;opacity:.6}',
      '.dsh-memory-graph-legend{display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin:2px 0 0;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary,#6b7280)}',
      '.dsh-memory-graph-legend span{display:inline-flex;align-items:center;gap:5px}',
      '.dsh-memory-graph-dot{width:7px;height:7px;border-radius:50%;background:#6b7280}',
      '.dsh-memory-graph-dot[data-kind="memory"]{background:#2f6df6}',
      '.dsh-memory-graph-dot[data-kind="knowledge"]{background:#0ea5e9}',
      '.dsh-memory-graph-dot[data-kind="vault"]{background:#14b8a6}',
      '.dsh-memory-graph-node:focus{outline:none;stroke:#1f2328;stroke-width:2}',
      '.dsh-memory-load-row{display:flex;gap:12px;flex-wrap:wrap;font-size:12px}',
      '.dsh-memory-profile-line{display:flex;align-items:baseline;gap:8px;min-width:0}',
      '.dsh-memory-profile-line .dsh-memory-profile-statement{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsh-memory-profile-evidence{list-style:none;margin:4px 0 0 0;padding:0 0 0 28px;display:flex;flex-direction:column;gap:2px;font-size:12px;color:var(--dsw-alias-label-secondary,#6b7280)}',
      '.dsh-memory-settings-input{box-sizing:border-box;flex:0 1 240px;min-width:0;height:28px;border:.5px solid var(--dsh-memory-card-border);border-radius:7px;padding:0 8px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1f2328);font:inherit;font-size:12px}',
      '.dsh-memory-settings-control{display:flex;align-items:center;gap:8px;flex:0 0 auto}',
      '.dsh-memory-switch{position:relative;flex:0 0 auto;width:40px;height:22px;padding:0;border:0;border-radius:999px;background:var(--dsw-alias-border-l2,rgba(127,127,127,.35));cursor:pointer;transition:background .18s ease}',
      '.dsh-memory-switch[aria-checked="true"]{background:var(--dsw-alias-state-business-primary,#2f6df6)}',
      '.dsh-memory-switch-knob{position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(16,24,40,.24);transition:transform .18s cubic-bezier(.3,.7,.3,1)}',
      '.dsh-memory-switch[aria-checked="true"] .dsh-memory-switch-knob{transform:translateX(18px)}',
      '.dsh-memory-switch:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#2f6df6);outline-offset:2px}',
      '.dsh-memory-number{display:inline-flex;align-items:center;flex:0 0 auto;box-sizing:border-box;height:32px;padding:0 9px 0 2px;border:.5px solid var(--dsh-memory-card-border);border-radius:8px;background:var(--dsw-alias-bg-layer-1,#fff)}',
      '.dsh-memory-number:focus-within{border-color:var(--dsw-alias-state-business-primary,#2f6df6)}',
      '.dsh-memory-number input{width:66px;height:30px;border:0;background:transparent;color:var(--dsw-alias-label-primary,#1f2328);font:inherit;font-size:13px;text-align:right;outline:none;font-variant-numeric:tabular-nums}',
      '.dsh-memory-number em{color:var(--dsw-alias-label-tertiary,#6b7280);font-style:normal;font-size:11px;margin-left:5px}',
      '.dsh-memory-settings-buttons{display:flex;align-items:center;justify-content:flex-end;gap:8px;flex-wrap:wrap}',
      '.dsh-memory-settings .dsh-memory-button{height:32px;padding:0 12px;font-size:12px}',
      '.dsh-memory-settings-foot{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:0;padding-top:20px;border-top:.5px solid var(--dsh-memory-card-border)}',
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
      '@container (max-width:560px){.dsh-memory-activity-head{flex-wrap:wrap;row-gap:6px}.dsh-memory-tabs{flex:0 0 auto}.dsh-memory-settings-head{gap:10px}.dsh-memory-settings-row{gap:12px}}',
      '@container (max-width:430px){.dsh-memory-settings-row{min-height:46px}.dsh-memory-settings .dsh-memory-button{height:30px;padding:0 10px}}',
      '@container (max-width:560px){.dsh-memory-activity-head{flex-wrap:wrap;row-gap:6px}.dsh-memory-tabs{flex:0 0 auto}}',
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
            overBudget > 0 ? h('em', null, t('usage.overBudget', { count: String(overBudget) })) : null))
    }

    function SettingsCard(props) {
      const { stats, call, t, onSaved, group = 'capture' } = props
      const [capture, setCapture] = React.useState(true)
      const [inject, setInject] = React.useState(true)
      const [budget, setBudget] = React.useState('360')
      const [retention, setRetention] = React.useState('90')
      const [maintenance, setMaintenance] = React.useState(true)
      const [obsidianVault, setObsidianVault] = React.useState('')
      const [obsidianFolder, setObsidianFolder] = React.useState('DSH Memory')
      const [baseline, setBaseline] = React.useState(null)
      const [savedAt, setSavedAt] = React.useState('')
      const [busy, setBusy] = React.useState(false)
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
          obsidianVault: typeof stats.obsidianVaultPath === 'string' ? stats.obsidianVaultPath : '',
          obsidianFolder: typeof stats.obsidianFolder === 'string' ? stats.obsidianFolder : 'DSH Memory',
        }
        setCapture(next.capture)
        setInject(next.inject)
        setBudget(next.budget)
        setRetention(next.retention)
        setMaintenance(next.maintenance)
        setObsidianVault(next.obsidianVault)
        setObsidianFolder(next.obsidianFolder)
        setBaseline(next)
      }, [stats])

      const dirty = baseline !== null && (
        capture !== baseline.capture ||
        inject !== baseline.inject ||
        budget !== baseline.budget ||
        retention !== baseline.retention ||
        maintenance !== baseline.maintenance ||
        obsidianVault !== baseline.obsidianVault ||
        obsidianFolder !== baseline.obsidianFolder
      )
      const last = stats === null ? null : stats.maintenance
      const injection = stats === null || stats.lastInjection === null || stats.lastInjection === undefined ? null : stats.lastInjection
      const extraction = stats === null || stats.lastExtraction === null || stats.lastExtraction === undefined ? null : stats.lastExtraction
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

      const snapshot = () => ({ capture, inject, budget, retention, maintenance, obsidianVault, obsidianFolder })
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
          setNotice(t('data.imported', { imported: String(result.imported ?? 0), skipped: String(result.skipped ?? 0) }))
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

      const obsidianExport = async () => {
        if (call === null || busy) return
        setBusy(true)
        setNotice('')
        try {
          const result = await call('obsidianExport', {
            vaultPath: obsidianVault.trim(),
            folder: obsidianFolder.trim(),
          })
          setNotice(t('obsidian.exported', { written: String(result.written ?? 0), skipped: String(result.skipped ?? 0) }))
          onSaved()
        } catch (failure) {
          setNotice(t('obsidian.failed', { reason: messageOf(failure) }))
        } finally {
          setBusy(false)
        }
      }
      const obsidianImport = async () => {
        if (call === null || busy) return
        setBusy(true)
        setNotice('')
        try {
          const result = await call('obsidianImport', {
            vaultPath: obsidianVault.trim(),
            folder: obsidianFolder.trim(),
            dryRun: false,
          })
          setNotice(t('obsidian.imported', {
            imported: String(result.imported ?? 0),
            updated: String(result.updated ?? 0),
            skipped: String(result.skipped ?? 0),
          }))
          onSaved()
        } catch (failure) {
          setNotice(t('obsidian.failed', { reason: messageOf(failure) }))
        } finally {
          setBusy(false)
        }
      }

      return h('section', { className: 'dsh-memory-card dsh-memory-settings' },
        h('div', { className: 'dsh-memory-settings-head' },
          h('div', null,
            h('h3', { className: 'dsh-memory-settings-title' }, t('settings.title')),
            h('p', { className: 'dsh-memory-settings-sub' }, summary)),
          h('span', { className: 'dsh-memory-settings-badge', 'data-off': maintenance ? 'false' : 'true' },
            h('i', null),
            maintenance ? t('settings.badge.on') : t('settings.badge.off'))),
        group === 'capture'
          ? h('div', { className: 'dsh-memory-settings-group' },
            switchRow(t('settings.capture'), capture, setCapture),
            switchRow(t('settings.inject'), inject, setInject),
            numberRow(t('settings.budget'), budget, 'token', '100', '8000', '50', (event) => setBudget(event.target.value)),
            h(TokenTrend, { usage: stats === null ? null : stats.usage, t }))
          : group === 'retention'
            ? h('div', { className: 'dsh-memory-settings-group' },
              numberRow(t('settings.retention'), retention, '天', '0', '36500', '10', (event) => setRetention(event.target.value)),
              switchRow(t('settings.maintenance'), maintenance, setMaintenance))
            : group === 'data'
              ? h('div', { className: 'dsh-memory-settings-group' },
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
                textRow(t('obsidian.vault'), obsidianVault, '/Users/me/Vault', (event) => setObsidianVault(event.target.value)),
                textRow(t('obsidian.folder'), obsidianFolder, 'DSH Memory', (event) => setObsidianFolder(event.target.value)),
                h('div', { className: 'dsh-memory-settings-row' },
                  h('span', { className: 'dsh-memory-settings-label' }, t('obsidian.actions')),
                  h('div', { className: 'dsh-memory-settings-buttons' },
                    button(t('obsidian.export'), obsidianExport),
                    button(t('obsidian.import'), obsidianImport)))),
        notice === '' ? null : h('p', { className: 'dsh-memory-settings-notice', role: 'status' }, notice),
        h('div', { className: 'dsh-memory-settings-foot' },
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

    function KnowledgeView(props) {
      const { graph, loading, error, t, onPromote, promoting } = props
      const [selected, setSelected] = React.useState(null)
      const [scale, setScale] = React.useState(1)
      const [offset, setOffset] = React.useState({ x: 0, y: 0 })
      const [query, setQuery] = React.useState('')
      const [topicFilter, setTopicFilter] = React.useState(null)
      const dragRef = React.useRef(null)
      if (loading) return h('p', { className: 'dsh-memory-muted', role: 'status' }, t('knowledge.loading'))
      if (error !== '') return h('p', { className: 'dsh-memory-error-text', role: 'alert' }, t('knowledge.failed', { reason: error }))
      if (graph === null || !Array.isArray(graph.nodes) || graph.nodes.length === 0) {
        return h('div', { className: 'dsh-memory-empty' }, h('p', { className: 'dsh-memory-empty-title' }, t('knowledge.empty')))
      }
      const width = 800
      const height = 460
      const cx = width / 2
      const cy = height / 2
      const hubs = Array.isArray(graph.hubs) ? graph.hubs : []
      const positions = new Map()
      const membersByTopic = new Map()
      for (const node of graph.nodes) {
        if (!membersByTopic.has(node.topic)) membersByTopic.set(node.topic, [])
        membersByTopic.get(node.topic).push(node)
      }
      hubs.forEach((hub, index) => {
        const angle = (index / Math.max(1, hubs.length)) * Math.PI * 2 - Math.PI / 2
        const distance = hubs.length <= 1 ? 0 : 165
        const hx = cx + Math.cos(angle) * distance
        const hy = cy + Math.sin(angle) * distance
        positions.set(hub.id, { x: hx, y: hy })
        const members = membersByTopic.get(hub.label) ?? []
        const ring = Math.max(28, 14 + members.length * 2.6)
        members.forEach((node, memberIndex) => {
          const memberAngle = (memberIndex / Math.max(1, members.length)) * Math.PI * 2 + angle
          positions.set(node.id, {
            x: hx + Math.cos(memberAngle) * ring,
            y: hy + Math.sin(memberAngle) * ring,
          })
        })
      })
      const lowered = query.trim().toLowerCase()
      const matches = (node) => {
        if (topicFilter !== null && node.topic !== topicFilter) return false
        if (lowered === '') return true
        return (String(node.label) + ' ' + String(node.topic) + ' ' + String(node.kind)).toLowerCase().includes(lowered)
      }
      const visibleNodes = graph.nodes.filter(matches)
      const visibleIds = new Set(visibleNodes.map((node) => node.id))
      const visibleHubs = topicFilter === null ? hubs : hubs.filter((hub) => hub.label === topicFilter)
      const resetView = () => {
        setScale(1)
        setOffset({ x: 0, y: 0 })
        setQuery('')
        setTopicFilter(null)
      }
      const zoomBy = (factor) => {
        setScale((value) => Math.min(3, Math.max(0.4, Math.round(value * factor * 100) / 100)))
      }
      const onWheel = (event) => {
        event.preventDefault()
        zoomBy(event.deltaY < 0 ? 1.12 : 0.89)
      }
      const onPointerDown = (event) => {
        if (event.button !== 0) return
        const rect = event.currentTarget.getBoundingClientRect()
        const factor = 800 / Math.max(1, rect.width)
        dragRef.current = { x: event.clientX, y: event.clientY, ox: offset.x, oy: offset.y, factor }
        if (typeof event.currentTarget.setPointerCapture === 'function') {
          event.currentTarget.setPointerCapture(event.pointerId)
        }
      }
      const onPointerMove = (event) => {
        const drag = dragRef.current
        if (drag === null) return
        setOffset({
          x: drag.ox + (event.clientX - drag.x) * drag.factor,
          y: drag.oy + (event.clientY - drag.y) * drag.factor,
        })
      }
      const onPointerUp = () => {
        dragRef.current = null
      }
      const edgeNodes = graph.edges.map((edge, index) => {
        if (!visibleIds.has(edge.source) && !visibleHubs.some((hub) => hub.id === edge.source)) return null
        if (!visibleIds.has(edge.target) && !visibleHubs.some((hub) => hub.id === edge.target)) return null
        const from = positions.get(edge.source)
        const to = positions.get(edge.target)
        if (from === undefined || to === undefined) return null
        return h('line', {
          key: 'e' + index,
          x1: from.x,
          y1: from.y,
          x2: to.x,
          y2: to.y,
          className: 'dsh-memory-graph-edge',
          'data-type': edge.type,
        })
      })
      const hubNodes = visibleHubs.map((hub) => {
        const point = positions.get(hub.id)
        if (point === undefined) return null
        return h('g', {
          key: hub.id,
          className: 'dsh-memory-graph-hub',
          onClick: () => setTopicFilter((value) => (value === hub.label ? null : hub.label)),
        },
          h('circle', { cx: point.x, cy: point.y, r: 10 }),
          h('text', { x: point.x, y: point.y - 15, className: 'dsh-memory-graph-hub-label', textAnchor: 'middle' }, hub.label))
      })
      const memoryNodes = visibleNodes.map((node) => {
        const point = positions.get(node.id)
        if (point === undefined) return null
        return h('g', {
          key: node.id,
          className: 'dsh-memory-graph-node-group',
          tabIndex: 0,
          role: 'button',
          'aria-label': node.label,
          onClick: () => setSelected(node),
          onKeyDown: (event) => { if (event.key === 'Enter' || event.key === ' ') setSelected(node) },
        },
          h('circle', { cx: point.x, cy: point.y, r: 12, className: 'dsh-memory-graph-hit' }),
          h('circle', {
            cx: point.x,
            cy: point.y,
            r: 4.5 + Math.max(0, Math.min(1, node.confidence)) * 3,
            className: 'dsh-memory-graph-node',
            'data-kind': node.kind,
          }),
          h('title', null, node.label))
      })
      const resultRows = (query.trim() === '' && topicFilter === null) ? [] : visibleNodes.slice(0, 20)
      return h('section', { className: 'dsh-memory-card dsh-memory-knowledge' },
        h('div', { className: 'dsh-memory-knowledge-head' },
          h('h3', { className: 'dsh-memory-settings-title' }, t('knowledge.title')),
          h('span', { className: 'dsh-memory-list-total' }, t('knowledge.stats', {
            memories: String(graph.memoryCount ?? graph.nodes.length),
            topics: String(graph.topicCount ?? hubs.length),
            tags: String(graph.tagCount ?? 0),
          }))),
        h('p', { className: 'dsh-memory-muted' }, t('knowledge.hint')),
        h('div', { className: 'dsh-memory-graph-legend' },
          h('span', null, h('i', { className: 'dsh-memory-graph-dot', 'data-kind': 'memory' }), t('knowledge.legendMemories')),
          h('span', null, h('i', { className: 'dsh-memory-graph-dot', 'data-kind': 'knowledge' }), t('knowledge.legendKnowledge')),
          h('span', null, h('i', { className: 'dsh-memory-graph-dot', 'data-kind': 'vault' }), t('knowledge.legendVault'))),
        h('div', { className: 'dsh-memory-graph-tools' },
          h('input', {
            className: 'dsh-memory-graph-search',
            type: 'search',
            value: query,
            placeholder: t('knowledge.search'),
            'aria-label': t('knowledge.search'),
            onChange: (event) => setQuery(event.target.value),
          }),
          h('button', { type: 'button', className: 'dsh-memory-graph-btn', onClick: () => zoomBy(0.8), 'aria-label': t('knowledge.zoomOut') }, '−'),
          h('button', { type: 'button', className: 'dsh-memory-graph-btn', onClick: () => zoomBy(1.25), 'aria-label': t('knowledge.zoomIn') }, '+'),
          h('button', { type: 'button', className: 'dsh-memory-graph-btn', onClick: resetView }, t('knowledge.reset')),
          topicFilter === null ? null : h('button', {
            type: 'button',
            className: 'dsh-memory-graph-chip',
            onClick: () => setTopicFilter(null),
          }, t('knowledge.topicChip', { topic: topicFilter }) + ' ×')),
        h('div', { className: 'dsh-memory-graph-wrap' },
          h('svg', {
            viewBox: '0 0 ' + width + ' ' + height,
            className: 'dsh-memory-graph',
            role: 'img',
            'aria-label': t('knowledge.title'),
            onWheel,
            onPointerDown,
            onPointerMove,
            onPointerUp,
            onPointerLeave: onPointerUp,
          },
            h('g', { transform: 'translate(' + offset.x + ' ' + offset.y + ') scale(' + scale + ')' },
              edgeNodes, hubNodes, memoryNodes))),
        resultRows.length === 0 ? null : h('ul', { className: 'dsh-memory-graph-results' }, resultRows.map((node) => h('li', { key: node.id },
          h('button', { type: 'button', className: 'dsh-memory-graph-result', onClick: () => setSelected(node) },
            h('span', null, String(node.label).slice(0, 56)),
            h('span', { className: 'dsh-memory-muted' }, node.topic))))),
        graph.truncated === true ? h('p', { className: 'dsh-memory-muted' }, t('knowledge.truncated')) : null,
        h('div', { className: 'dsh-memory-knowledge-detail' },
          h('h4', { className: 'dsh-memory-settings-group-title' }, t('knowledge.detail')),
          selected === null
            ? h('p', { className: 'dsh-memory-muted' }, t('knowledge.noSelection'))
            : h('div', { className: 'dsh-memory-knowledge-selected' },
              h('p', { className: 'dsh-memory-content' }, selected.label),
              h('div', { className: 'dsh-memory-load-row' },
                h('span', { className: 'dsh-memory-muted' }, t('knowledge.kind') + ': ' + t('kind.' + selected.kind)),
                h('span', { className: 'dsh-memory-muted' }, t('knowledge.status') + ': ' + t('status.' + selected.status)),
                h('span', { className: 'dsh-memory-muted' }, t('knowledge.topic') + ': ' + selected.topic),
                h('span', { className: 'dsh-memory-muted' }, t('knowledge.confidence') + ': ' + Number(selected.confidence).toFixed(2))),
              selected.type === 'memory'
                ? h('button', {
                  type: 'button',
                  className: 'dsh-memory-button',
                  onClick: () => onPromote(selected),
                  disabled: promoting,
                }, promoting ? t('knowledge.promoting') : t('knowledge.promote'))
                : h('p', { className: 'dsh-memory-muted' }, selected.type === 'trait'
                  ? t('knowledge.traitNote')
                  : selected.kind === 'vault' ? t('knowledge.vaultNote') : t('knowledge.knowledgeNote')))))
    }

    function KnowledgeLibrary(props) {
      const { data, loading, error, t, onSync, busy, call, onChanged } = props
      const notes = data !== null && Array.isArray(data.notes) ? data.notes : []
      const vault = data !== null && typeof data.vaultPath === 'string' ? data.vaultPath : ''
      const [editing, setEditing] = React.useState(false)
      const [note, setNote] = React.useState(null)
      const [draft, setDraft] = React.useState(null)
      const [opening, setOpening] = React.useState(false)
      const [saving, setSaving] = React.useState(false)
      const [noteError, setNoteError] = React.useState('')
      const [conflict, setConflict] = React.useState(false)
      const [notice, setNotice] = React.useState('')
      const [syncing, setSyncing] = React.useState(false)
      const [syncError, setSyncError] = React.useState('')
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

      const syncNotes = async (direction) => {
        if (call === null || syncing) return
        setSyncing(true)
        setSyncError('')
        setNotice('')
        try {
          const result = await call('knowledgeSync', { direction })
          setNotice(direction === 'export'
            ? t('library.exportResult', { written: String(result?.written ?? 0), skipped: String(result?.skipped ?? 0) })
            : t('library.importResult', {
              imported: String(result?.imported ?? 0),
              skipped: String(result?.skipped ?? 0),
              conflicts: String(result?.conflicts ?? 0),
            }))
          if (typeof onChanged === 'function') onChanged()
        } catch (failure) {
          setSyncError(t('library.syncFailed', { reason: messageOf(failure) }))
        } finally {
          setSyncing(false)
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
              disabled: saving || draft.title.trim() === '',
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
        h('div', { className: 'dsh-memory-knowledge-head' },
          h('h3', { className: 'dsh-memory-settings-title' }, t('library.title')),
          h('span', { className: 'dsh-memory-list-total' }, t('library.total', { count: String(notes.length) }))),
        h('p', { className: 'dsh-memory-muted' }, t('library.hint')),
        h('p', { className: 'dsh-memory-muted' }, vault === '' ? t('library.noVault') : t('library.vault', { path: vault })),
        h('div', { className: 'dsh-memory-settings-buttons' },
          h('button', { type: 'button', className: 'dsh-memory-button', onClick: () => onSync('export'), disabled: busy }, t('library.syncExport')),
          h('button', { type: 'button', className: 'dsh-memory-button', onClick: () => onSync('import'), disabled: busy }, t('library.syncImport')),
          h('button', { type: 'button', className: 'dsh-memory-button', onClick: () => syncNotes('export'), disabled: syncing }, t('library.syncKnowledgeExport')),
          h('button', { type: 'button', className: 'dsh-memory-button', onClick: () => syncNotes('import'), disabled: syncing }, t('library.syncKnowledgeImport'))),
        syncError === '' ? null : h('p', { className: 'dsh-memory-error-text', role: 'alert' }, syncError),
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
                h('span', { className: 'dsh-memory-muted' }, note.file))))),
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
      const [view, setView] = React.useState('memory')
      const [graph, setGraph] = React.useState(null)
      const [graphLoading, setGraphLoading] = React.useState(false)
      const [graphError, setGraphError] = React.useState('')
      const [graphRefresh, setGraphRefresh] = React.useState(0)
      const [promotingNode, setPromotingNode] = React.useState(false)
      const [library, setLibrary] = React.useState(null)
      const [libraryLoading, setLibraryLoading] = React.useState(false)
      const [libraryError, setLibraryError] = React.useState('')
      const [libraryBusy, setLibraryBusy] = React.useState(false)
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
        if (view !== 'knowledge' || call === null) return undefined
        let cancelled = false
        setGraphLoading(true)
        setGraphError('')
        call('knowledgeGraph', { scope })
          .then((next) => { if (!cancelled) setGraph(next) })
          .catch((failure) => { if (!cancelled) setGraphError(messageOf(failure)) })
          .finally(() => { if (!cancelled) setGraphLoading(false) })
        return () => { cancelled = true }
      }, [view, call, scope, graphRefresh])

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
      const intro = h('p', { className: 'dsh-memory-intro' }, t('panel.intro'))

      if (transport.status === 'loading') {

      return h('div', { className: 'dsh-memory-root' },
          heading,
          intro,
          h('p', { className: 'dsh-memory-muted', role: 'status' }, t('list.loading')))
      }

      if (transport.status === 'unavailable') {
        return h('div', { className: 'dsh-memory-root' },
          heading,
          intro,
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

      const promoteNode = async (node) => {
        if (call === null || promotingNode) return
        const projectKey = scope === 'project' && typeof currentProjectKey === 'string' ? currentProjectKey : undefined
        setPromotingNode(true)
        setError('')
        try {
          const result = await call('knowledgePromote', { id: node.id, scope, projectKey })
          setNotice(t('knowledge.promoted', { path: String(result.path ?? '') }))
          setGraphRefresh((value) => value + 1)
        } catch (failure) {
          setError(t('knowledge.promoteFailed', { reason: messageOf(failure) }))
        } finally {
          setPromotingNode(false)
        }
      }

      const syncKnowledge = async (direction) => {
        if (call === null || libraryBusy) return
        const vaultPath = stats === null || typeof stats.obsidianVaultPath !== 'string' ? '' : stats.obsidianVaultPath
        const folder = stats === null || typeof stats.obsidianFolder !== 'string' ? 'DSH Memory' : stats.obsidianFolder
        setLibraryBusy(true)
        setError('')
        try {
          if (direction === 'export') {
            const result = await call('obsidianExport', { vaultPath, folder })
            setNotice(t('obsidian.exported', { written: String(result.written ?? 0), skipped: String(result.skipped ?? 0) }))
          } else {
            const result = await call('obsidianImport', { vaultPath, folder, dryRun: false })
            setNotice(t('obsidian.imported', {
              imported: String(result.imported ?? 0),
              updated: String(result.updated ?? 0),
              skipped: String(result.skipped ?? 0),
            }))
          }
          setLibraryRefresh((value) => value + 1)
        } catch (failure) {
          setError(messageOf(failure))
        } finally {
          setLibraryBusy(false)
        }
      }

      const viewTabs = h('div', { className: 'dsh-memory-view-tabs', role: 'tablist' },
        ['memory', 'profile', 'knowledge', 'library', 'capture', 'retention', 'data', 'obsidian'].map((value) => h('button', {
          key: value,
          type: 'button',
          role: 'tab',
          'aria-selected': view === value,
          'data-active': view === value ? 'true' : 'false',
          className: 'dsh-memory-view-tab',
          onClick: () => setView(value),
        }, t('view.' + value))))

      if (view === 'knowledge') {
        return h('div', { className: 'dsh-memory-root' },
          heading,
          intro,
          viewTabs,
          notice === '' ? null : h('p', { className: 'dsh-memory-notice', role: 'status' }, notice),
          error === '' ? null : h('p', { className: 'dsh-memory-error-text', role: 'alert' }, error),
          h(KnowledgeView, { graph, loading: graphLoading, error: graphError, t, onPromote: promoteNode, promoting: promotingNode }))
      }

      if (view === 'profile') {
        return h('div', { className: 'dsh-memory-root' },
          heading,
          intro,
          viewTabs,
          notice === '' ? null : h('p', { className: 'dsh-memory-notice', role: 'status' }, notice),
          error === '' ? null : h('p', { className: 'dsh-memory-error-text', role: 'alert' }, error),
          h(ProfileView, { profile: data === null ? null : data.profile, t }))
      }

      if (view === 'library') {
        return h('div', { className: 'dsh-memory-root' },
          heading,
          intro,
          viewTabs,
          notice === '' ? null : h('p', { className: 'dsh-memory-notice', role: 'status' }, notice),
          error === '' ? null : h('p', { className: 'dsh-memory-error-text', role: 'alert' }, error),
          h(KnowledgeLibrary, {
            data: library,
            loading: libraryLoading,
            error: libraryError,
            t,
            call,
            onSync: syncKnowledge,
            busy: libraryBusy,
            onChanged: () => {
              setLibraryRefresh((value) => value + 1)
              setGraphRefresh((value) => value + 1)
            },
          }))
      }

      if (view === 'capture' || view === 'retention' || view === 'data' || view === 'obsidian') {
        return h('div', { className: 'dsh-memory-root' },
          heading,
          intro,
          viewTabs,
          notice === '' ? null : h('p', { className: 'dsh-memory-notice', role: 'status' }, notice),
          error === '' ? null : h('p', { className: 'dsh-memory-error-text', role: 'alert' }, error),
          h(SettingsCard, { stats, call, t, onSaved: load, group: view }))
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
        heading,
        intro,
        viewTabs,
        h('section', { className: 'dsh-memory-hero-cards' },
          h('div', { className: 'dsh-memory-hero-main' }, h(HeroMetrics, { stats, t })),
          h('div', { className: 'dsh-memory-hero-side' }, h(HeroInsights, { activity: data === null ? null : data.activity, stats, t, locale }))),
        h(ActivityHeatmap, { activity: data === null ? null : data.activity, stats, t, locale }),
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
          h(Field, { label: t('filter.kind') },
            h('select', {
              className: 'dsh-memory-select',
              value: kind,
              onChange: (event) => {
                setKind(event.target.value)
                setPage(0)
              },
              'aria-label': t('filter.kind'),
            },
            h('option', { value: '' }, t('filter.kind.all')),
            KINDS.map((value) => h('option', { key: value, value }, t('kind.' + value))))),
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
                  : h('button', { type: 'button', className: 'dsh-memory-button', 'data-danger': 'true', onClick: () => bulk('delete') }, t('bulk.delete')),
                status === 'deleted'
                  ? null
                  : h('button', { type: 'button', className: 'dsh-memory-button', onClick: () => setBulkTagOpen(true) }, t('bulk.tag')),
                h('button', { type: 'button', className: 'dsh-memory-button', onClick: () => setSelected([]) }, t('bulk.clear')))),
            h('ul', { key: 'list', className: 'dsh-memory-list' },
            items.map((record) => {
              const isConfirming = confirmingId === record.id
              const actionBusy = busy !== ''
              return h('li', { key: record.id, className: 'dsh-memory-row', 'data-kind': record.kind },
                h('div', { className: 'dsh-memory-row-head' },
                  h('input', {
                    type: 'checkbox',
                    className: 'dsh-memory-select-box',
                    checked: selected.includes(record.id),
                    onChange: () => toggleSelected(record.id),
                    'aria-label': t('bulk.selectRow'),
                  }),
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
