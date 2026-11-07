/** Three-way, restart-safe Obsidian reconciliation. Files are never overwritten without preserving their bytes. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, writeFile, rename, link, unlink, lstat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { parseMemoryNote, resolveObsidianTarget, serializeMemory } from './obsidian.js'
import { isKnowledgeFile, parseKnowledgeNote } from './knowledge.js'
import { buildRecord, nextRevision, MEMORY_KINDS, MEMORY_STATUSES } from './records.js'
import { isValidProjectKey } from './paths.js'

const hash = value => createHash('sha256').update(value).digest('hex')
const fields = ['kind', 'scope', 'projectKey', 'content', 'topic', 'tags', 'confidence', 'importance', 'status']
const semantic = record => JSON.stringify(fields.map(key => record[key] ?? null))
const textAt = async file => { try { return await readFile(file, 'utf8') } catch (e) { if (e.code === 'ENOENT') return null; throw e } }
async function directory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 })
  if ((await lstat(path)).isSymbolicLink()) throw new Error('同步文件夹不能是符号链接')
}
async function names(path) {
  try { return (await readdir(path, { withFileTypes: true })).filter(e => e.isFile() && e.name.endsWith('.md') && !e.name.startsWith('_')).map(e => e.name).sort() }
  catch (e) { if (e.code === 'ENOENT') return []; throw e }
}
function memoryInput(text) {
  const parsed = parseMemoryNote(text)
  if (parsed?.data.dsh_memory !== true) throw new Error('不是 DSH 记忆笔记')
  const d = parsed.data
  if (typeof d.id !== 'string' || !/^mem_[A-Za-z0-9]+$/u.test(d.id) || !MEMORY_KINDS.includes(d.kind)) throw new Error('记忆 id 或类型无效')
  if (!['global', 'project'].includes(d.scope) || (d.scope === 'project' && !isValidProjectKey(d.projectKey))) throw new Error('记忆范围无效')
  if (!MEMORY_STATUSES.includes(d.status) || d.status === 'deleted') throw new Error('请在 Memory 中操作遗忘，不要修改笔记状态为 deleted')
  const input = { ...d, projectKey: d.scope === 'global' ? null : d.projectKey, content: parsed.body }
  const built = buildRecord(input, { id: d.id })
  if (!built.ok) throw new Error(built.reason)
  return { ...built.record, status: d.status }
}

export class ObsidianSync {
  constructor({ root, store, index, getConfig, synchronize = () => {}, onKnowledgeChange = () => {} }) {
    Object.assign(this, { root, store, index, getConfig, synchronize, onKnowledgeChange })
    this.timer = null; this.busy = null; this.stopped = false
    this.state = null; this.target = null; this.files = new Map(); this.records = new WeakMap()
    this.last = { at: null, exported: 0, imported: 0, conflicts: [], errors: [] }
  }
  status() { return { enabled: this.getConfig()?.autoSync === true, running: this.busy !== null, ...this.last } }
  start(intervalMs = 5000) {
    this.stopped = false
    const tick = async () => {
      try { if (this.getConfig()?.autoSync === true) await this.run() } catch { /* status exposes the error */ }
      if (!this.stopped) { this.timer = setTimeout(tick, intervalMs); this.timer.unref?.() }
    }
    this.timer = setTimeout(tick, intervalMs); this.timer.unref?.()
  }
  dispose() { this.stopped = true; clearTimeout(this.timer) }
  run(resolution = null) {
    if (this.busy) return resolution ? this.busy.then(() => this.run(resolution)) : this.busy
    this.busy = this.reconcile(resolution).catch(error => {
      this.last = { ...this.last, at: Date.now(), errors: [{ file: '', message: error.message }] }
      throw error
    }).finally(() => { this.busy = null })
    return this.busy
  }
  resolve({ key, token, side }) {
    if (typeof key !== 'string' || typeof token !== 'string' || !['memory', 'vault'].includes(side)) return Promise.reject(new Error('无效的冲突处理请求'))
    return this.run({ key, token, side })
  }
  async cachedText(file) {
    const info = await lstat(file)
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('同步来源必须是普通文件')
    const stamp = `${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`
    const cached = this.files.get(file)
    if (cached?.stamp === stamp) return cached.text
    const text = await readFile(file, 'utf8'); this.files.set(file, { stamp, text }); return text
  }
  async existingText(file) {
    try { return await this.cachedText(file) } catch (e) { if(e.code === 'ENOENT') return null; throw e }
  }
  memory(record) {
    let cached = this.records.get(record)
    if (!cached || cached.revision !== record.revision) {
      cached = { text: serializeMemory(record), value: semantic(record), revision: record.revision }
      this.records.set(record, cached)
    }
    return cached
  }
  async preserve(dir, name, text) {
    if (text === null) return null
    await directory(dir)
    const file = join(dir, name)
    try { await writeFile(file, text, { flag: 'wx', mode: 0o600 }) }
    catch (e) { if (e.code !== 'EEXIST') throw e; if (await textAt(file) !== text) throw new Error('恢复副本发生冲突') }
    return file
  }
  async replace(file, before, after, vaultDir) {
    if (before === after) return
    await directory(join(file, '..'))
    if (await textAt(file) !== before) throw new Error('文件已变化，请等待下一轮同步')
    if (before !== null) {
      const history = join(vaultDir, '_history'); await directory(history)
      const saved = join(history, `${Date.now()}-${randomUUID()}-${basename(file)}`)
      await rename(file, saved)
      if (await textAt(saved) !== before) {
        try { await link(saved, file) } catch (e) { if (e.code !== 'EEXIST') throw e }
        throw new Error('文件在同步时变化，两个版本已保留')
      }
    }
    if (after !== null) {
      const temp = join(vaultDir, `_sync-${randomUUID()}.tmp`)
      await writeFile(temp, after, { flag: 'wx', mode: 0o600 })
      try { await link(temp, file) }
      catch (e) {
        await this.preserve(join(vaultDir, '_conflicts'), `${randomUUID()}-pending.md`, after)
        throw new Error(`文件在同步时变化，待写入版本已保留：${e.code}`)
      } finally { await unlink(temp) }
    }
    this.files.delete(file)
  }
  async reconcile(resolution) {
    const config = this.getConfig()
    if (!config?.vaultPath) return this.last
    const { dir } = resolveObsidianTarget(config.vaultPath, config.folder)
    await directory(dir); await directory(join(dir, 'knowledge'))
    const stateFile = join(this.root, `obsidian-state-${hash(dir).slice(0, 20)}.json`)
    if (this.target !== dir) {
      let state = null
      try { state = JSON.parse(await textAt(stateFile)) } catch { /* An absent baseline means conflict, never overwrite. */ }
      this.state = state?.version === 1 && state.entries && typeof state.entries === 'object' ? state : { version: 1, entries: {} }
      this.target = dir; this.files.clear()
    }
    this.synchronize()
    const records = new Map(this.store.listAll({ includeDeleted: true }).map(r => [r.id, r]))
    const pairs = new Map(), blocked = new Set()
    const result = { at: Date.now(), dir, exported: 0, imported: 0, conflicts: [], errors: [] }
    for (const [id, record] of records) {
      const key = `memory:${id}`, previous = this.state.entries[key]
      pairs.set(key, { key, id, record, file: previous?.file ?? `${id}.md`, kind: 'memory' })
    }
    const vaultNames = await names(dir)
    const seen = new Set()
    for (const file of vaultNames) {
      try {
        const text = await this.cachedText(join(dir, file)), parsed = parseMemoryNote(text)
        if (parsed?.data.dsh_memory !== true) continue
        const input = memoryInput(text), key = `memory:${input.id}`
        if (seen.has(key)) { blocked.add(key); throw new Error('多个笔记使用相同记忆 id') }
        seen.add(key)
        const record = records.get(input.id)
        if (record && (record.scope !== input.scope || record.projectKey !== input.projectKey)) { blocked.add(key); throw new Error('笔记不能移动已有记忆的范围') }
        pairs.set(key, { key, id: input.id, record, file, kind: 'memory', input, diskText: text })
      } catch (e) {
        for (const [key, pair] of pairs) if (pair.file === file) blocked.add(key)
        result.errors.push({ file, message: e.message })
      }
    }
    const knowledgeRoot = join(this.root, 'knowledge')
    await directory(knowledgeRoot)
    for (const file of new Set([...(await names(knowledgeRoot)), ...(await names(join(dir, 'knowledge')))])) {
      if (isKnowledgeFile(file)) pairs.set(`knowledge:${file}`, { key: `knowledge:${file}`, file: `knowledge/${file}`, kind: 'knowledge' })
    }
    let resolved = false
    let knowledgeChanged = false
    for (const pair of pairs.values()) {
      if (blocked.has(pair.key)) continue
      try {
        const vaultFile = join(dir, pair.file), localFile = pair.kind === 'knowledge' ? join(this.root, pair.file) : null
        let right = pair.diskText ?? await this.existingText(vaultFile)
        let left = pair.kind === 'memory' ? (pair.record && pair.record.status !== 'deleted' ? this.memory(pair.record).text : null) : await this.existingText(localFile)
        if (pair.record?.status === 'deleted') {
          if (right !== null) await this.replace(vaultFile, right, null, dir)
          delete this.state.entries[pair.key]
          continue
        }
        let lv = left, rv = right
        if (pair.kind === 'memory') {
          lv = left === null ? null : this.memory(pair.record).value
          if (right !== null) {
            const input = memoryInput(right)
            if (input.id !== pair.id) throw new Error('笔记 id 已变化')
            pair.input = input; rv = semantic(input)
          }
        } else {
          for (const value of [left, right]) if (value !== null && parseKnowledgeNote(value).data.dsh_knowledge !== true) throw new Error('不是 DSH 知识笔记')
        }
        const lh = lv === null ? null : hash(lv), rh = rv === null ? null : hash(rv)
        const previous = this.state.entries[pair.key]
        const token = hash(JSON.stringify([left, right]))
        let direction = null
        if (resolution?.key === pair.key) {
          if (resolution.token !== token) throw new Error('冲突内容已变化，请刷新后重新选择')
          direction = resolution.side === 'memory' ? 'export' : 'import'; resolved = true
        } else if (lh === rh) {
          this.state.entries[pair.key] = { left: lh, right: rh, file: pair.file }; continue
        } else if (!previous && left === null) direction = 'import'
        else if (!previous && right === null) direction = 'export'
        else if (left !== null && right !== null && previous) {
          if (lh === previous.left && rh !== previous.right) direction = 'import'
          else if (rh === previous.right && lh !== previous.left) direction = 'export'
        }
        if (direction === null) {
          const folder = join(dir, '_conflicts', hash(pair.key).slice(0, 16))
          const copies = (await Promise.all([
            this.preserve(folder, `${token}-memory.md`, left),
            this.preserve(folder, `${token}-obsidian.md`, right),
          ])).filter(Boolean)
          result.conflicts.push({ key: pair.key, file: pair.file, token, copies, reason: left === null || right === null ? '一侧已删除，另一侧内容仍保留' : '两侧内容不同，未自动覆盖', memoryText: left, vaultText: right })
          continue
        }
        const currentConfig = this.getConfig()
        if (currentConfig.vaultPath !== config.vaultPath || currentConfig.folder !== config.folder || (config.autoSync && !currentConfig.autoSync)) throw new Error('同步设置已变化，本轮写入停止')
        if (direction === 'export') {
          // Recheck the authority after asynchronous file reads before publishing.
          if (pair.kind === 'memory' && this.store.find(pair.id, [{scope:pair.record.scope,projectKey:pair.record.projectKey}]) !== pair.record) throw new Error('记忆已变化，请等待下一轮同步')
          await this.replace(vaultFile, right, left, dir); right = left; rv = lv; result.exported++
          if (pair.kind === 'knowledge') knowledgeChanged = true
        } else {
          if (await textAt(vaultFile) !== right) throw new Error('笔记已变化，请等待下一轮同步')
          if (pair.kind === 'knowledge') { await this.replace(localFile, left, right, dir); knowledgeChanged = true }
          else {
            this.synchronize()
            const current = pair.record && this.store.find(pair.id, [{scope:pair.record.scope,projectKey:pair.record.projectKey}])
            if (pair.record && current !== pair.record) throw new Error('记忆已变化，请等待下一轮同步')
            if (right === null) { this.store.remove(pair.id, [{scope:current.scope,projectKey:current.projectKey}]); this.index.remove(pair.id) }
            else {
              const input = pair.input
              let record
              if (current) {
                const patch = Object.fromEntries(fields.filter(k => !['scope','projectKey'].includes(k)).map(k => [k,input[k]]))
                const normalized = nextRevision(current, patch)
                record = fields.every(k => isDeepStrictEqual(current[k], normalized[k])) ? current : this.store.update(pair.id, patch, [{scope:current.scope,projectKey:current.projectKey}])
              } else {
                const built = this.store.write(input, {id:pair.id}); if (!built.ok) throw new Error(built.reason); record = built.record
              }
              this.index.upsert(record)
            }
          }
          lv = rv; result.imported++
        }
        this.state.entries[pair.key] = { left: lv === null ? null : hash(lv), right: rv === null ? null : hash(rv), file: pair.file }
      } catch (e) {
        if (resolution?.key === pair.key) throw e
        result.errors.push({ file: pair.file, message: e.message })
      }
    }
    if (resolution && !resolved) throw new Error('冲突内容已变化或已经解决')
    if (knowledgeChanged) {
      try { this.onKnowledgeChange() } catch { /* Recall refresh is fail-soft; the next edit retries it. */ }
    }
    const serialized = JSON.stringify(this.state)
    if (await textAt(stateFile) !== serialized) {
      const temp = `${stateFile}.tmp`; await writeFile(temp, serialized, {mode:0o600}); await rename(temp, stateFile)
    }
    this.last = result
    return result
  }
}
