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
