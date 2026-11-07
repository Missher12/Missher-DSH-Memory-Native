/** Bind a data root to the native profileContext service supplied by DSH. */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, basename, isAbsolute, join, resolve } from 'node:path'
import { atomicWritePrivate, withFileLock } from './persistence.js'

const issue = (code, message) => Object.assign(new Error(message), { code })
function canonical(path) {
  try { return realpathSync(path) }
  catch (error) {
    if (error.code !== 'ENOENT') throw error
    return join(canonical(dirname(path)), basename(path))
  }
}

export function prepareStorage(ctx, config) {
  let profile
  try { profile = ctx.get('profileContext') } catch { /* A standalone composition must choose an explicit directory. */ }
  const native = profile && typeof profile.name === 'string' &&
    typeof profile.home === 'string' && isAbsolute(profile.home) && typeof profile.dir === 'string' && isAbsolute(profile.dir)
  const explicit = typeof config.dataDir === 'string' && config.dataDir.trim() !== ''
  if (!native && !explicit) throw issue('profile-unavailable', '无法确认当前宿主配置身份，记忆读写已暂停。请更新宿主或配置独立数据目录后重新加载插件。')
  const home = native ? canonical(profile.home) : null
  const profileDir = native ? canonical(profile.dir) : null
  const desktop = native && profile.name === 'desktop' && profileDir === canonical(join(home, 'profiles', 'desktop'))
  const legacyRoot = native ? canonical(join(home, 'dsh-memory')) : null
  const root = canonical(explicit ? resolve(config.dataDir.trim()) : desktop ? legacyRoot : join(profileDir, 'dsh-memory'))
  if (native && !desktop && root === legacyRoot) throw issue('storage-owner-conflict', '数据目录属于其他宿主配置，已停止读写。请为当前配置选择独立目录。')
  const owner = {
    version: 1,
    kind: native ? 'profile' : 'explicit',
    identity: createHash('sha256').update(native ? profileDir : 'explicit-standalone-directory').digest('hex'),
  }
  mkdirSync(root, { recursive: true, mode: 0o700 })
  withFileLock(join(root, '.owner.lock'), () => {
    const file = join(root, 'data-owner.json')
    let saved
    try { saved = JSON.parse(readFileSync(file, 'utf8')) }
    catch (error) {
      if (error.code !== 'ENOENT') throw issue('storage-owner-invalid', '数据目录归属信息不可读取，已停止读写。请检查文件权限或从完整备份恢复到新目录。')
    }
    if (saved !== undefined && (!saved || typeof saved !== 'object' || saved.version !== owner.version || saved.kind !== owner.kind || saved.identity !== owner.identity)) {
      throw issue('storage-owner-conflict', '数据目录属于其他宿主配置，已停止读写。请为当前配置选择独立目录。')
    }
    if (saved === undefined) atomicWritePrivate(file, `${JSON.stringify(owner)}\n`)
  })
  return { root, isolation: owner.kind }
}
