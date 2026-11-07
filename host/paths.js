/**
 * Storage roots and project identity.
 *
 * A project key is a human-recognizable slug of the working-directory basename
 * plus a short hash of the canonical absolute path. The slug keeps the directory
 * readable; the hash keeps two checkouts with the same basename apart. Keys are
 * validated before they join a filesystem path.
 *
 * @module dsh-memory/host/paths
 */

import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'

const PROJECT_KEY_PATTERN = /^[\p{L}\p{N}._-]{1,80}$/u

/** Resolve the DSH home directory the same way the rest of the Harness does. */
export function resolveDshHome(configured) {
  const explicit = typeof configured === 'string' ? configured.trim() : ''
  if (explicit) return resolve(explicit)
  const env = process.env.DSH_HOME?.trim()
  if (env) return resolve(env)
  return join(homedir(), '.dsh')
}

/**
 * Resolve the plugin's data root.
 * @param {{ dataDir?: string | null, dshHome?: string | null }} [options]
 */
export function resolveMemoryRoot(options = {}) {
  const dataDir = typeof options.dataDir === 'string' ? options.dataDir.trim() : ''
  if (dataDir) return resolve(dataDir)
  return join(resolveDshHome(options.dshHome ?? undefined), 'dsh-memory')
}

/**
 * Derive the stable project key for an absolute working directory.
 * @param {string} cwd
 * @returns {{ key: string, name: string, cwd: string }}
 */
export function projectIdentity(cwd) {
  const canonical = resolve(String(cwd || process.cwd()))
  const rawBase = basename(canonical) || 'project'
  const base = rawBase.replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^-+|-+$/g, '') || 'project'
  const hash = createHash('sha256').update(canonical).digest('hex').slice(0, 12)
  return { key: `${base.slice(0, 40)}-${hash}`, name: rawBase, cwd: canonical }
}

/** Whether a string is a safe project key (no traversal, no separators). */
export function isValidProjectKey(key) {
  return typeof key === 'string' && PROJECT_KEY_PATTERN.test(key) && !['.', '..', '__proto__', 'constructor', 'prototype'].includes(key)
}

/**
 * File paths for one memory scope.
 * @param {string} root absolute data root
 * @param {'global' | 'project'} scope
 * @param {string | null} projectKey required for project scope
 */
export function scopePaths(root, scope, projectKey) {
  if (scope === 'global') {
    const dir = join(root, 'global')
    return { dir, file: join(dir, 'memories.jsonl') }
  }
  if (scope !== 'project') throw new Error(`unknown memory scope: ${String(scope)}`)
  if (!isValidProjectKey(projectKey)) throw new Error(`invalid project key: ${JSON.stringify(projectKey)}`)
  const dir = join(root, 'projects', projectKey)
  return { dir, file: join(dir, 'memories.jsonl') }
}
