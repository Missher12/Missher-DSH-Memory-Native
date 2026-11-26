import { join } from 'node:path'
import { readAuthorityIntent } from './authority-intent.js'
import { knowledgeScopeWithinMemory } from './knowledge.js'
import { isValidProjectKey } from './paths.js'
import { withFileLock } from './persistence.js'
import { isValidMemoryId } from './records.js'
import { PERMANENT_REVISION, readRevocationLedger } from './revocation-ledger.js'

export function hasKnowledgeLink(note) {
  return note.memoryId != null || note.memoryScope != null || note.memoryProjectKey != null
}

export function knowledgeLineageAllowed(check, note, previous) {
  const current = check(note)
  if (!current.allowed) return false
  for (const binding of previous) {
    const original = check(binding)
    if (!original.allowed) return false
    if (original.parent && (!current.parent || original.parent.id !== current.parent.id ||
        original.parent.scope !== current.parent.scope || original.parent.projectKey !== current.parent.projectKey)) return false
  }
  return true
}

/** One authority view per read operation. The writer lock protects publication separately. */
export function knowledgeAuthority(store, { refresh = true } = {}) {
  const global = { scope: 'global', projectKey: null }
  const checked = new Set()
  let pending, purged, projectKeys, purgedScopes
  const find = (id, scope) => {
    const key = scope.projectKey ?? null
    if (refresh && !checked.has(key)) {
      store.refreshScope?.(scope.scope, key)
      checked.add(key)
    }
    return store.find(id, [scope])
  }
  return note => {
    if (!hasKnowledgeLink(note)) return { allowed: true, parent: null }
    if (!isValidMemoryId(note.memoryId)) return { allowed: false, parent: null }
    pending ??= new Set((typeof store.root === 'string' ? readAuthorityIntent(store.root)?.targets.recordThrough ?? [] : [])
      .map(({ id, projectKey }) => JSON.stringify([id, projectKey])))
    purged ??= store.purgedIds?.() ?? new Set()
    if (purged.has(note.memoryId)) {
      if (!purgedScopes) {
        purgedScopes = new Map()
        const rows = typeof store.root === 'string' ? readRevocationLedger(store.root).records.values() : []
        for (const row of rows) {
          if (row.revision !== PERMANENT_REVISION) continue
          const projects = purgedScopes.get(row.id) ?? new Set()
          projects.add(row.projectKey)
          purgedScopes.set(row.id, projects)
        }
      }
      const scopes = purgedScopes.get(note.memoryId)
      // A legacy note with an ambiguous parent must never attach to another project.
      if (!scopes || note.memoryScope == null || scopes.has(note.memoryProjectKey ?? null)) {
        return { allowed:false, parent:null }
      }
    }

    let scopes
    if (note.memoryScope === 'global' && note.memoryProjectKey == null) scopes = [global]
    else if (note.memoryScope === 'project' && isValidProjectKey(note.memoryProjectKey)) {
      scopes = [{ scope: 'project', projectKey: note.memoryProjectKey }]
    } else if (note.memoryScope != null || note.memoryProjectKey != null) return { allowed: false, parent: null }
    else if (note.scope === 'project') scopes = [{ scope: 'project', projectKey: note.projectKey }, global]
    else if (note.scope === 'global') scopes = [global]
    else {
      // Older notes can be edited before receiving a scope, when their origin is unique.
      projectKeys ??= store.listProjects?.() ?? []
      scopes = [global, ...projectKeys.map(projectKey => ({ scope: 'project', projectKey }))]
    }
    if (scopes.some(({ projectKey }) => pending.has(JSON.stringify([note.memoryId, projectKey])))) {
      return { allowed: false, parent: null }
    }
    const parents = scopes.map(scope => find(note.memoryId, scope)).filter(Boolean)
    const parent = parents.length === 1 ? parents[0] : null
    const allowed = parent !== null && parent.status !== 'deleted' &&
      knowledgeScopeWithinMemory(note.scope, note.projectKey, parent.scope, parent.projectKey)
    return { allowed, parent }
  }
}

/** Keep a note edit or copy ordered with forget, purge and snapshot recovery. */
export function withKnowledgeWriter(store, action) {
  return withFileLock(join(store.root, '.write.lock'), () => action(knowledgeAuthority(store)))
}
