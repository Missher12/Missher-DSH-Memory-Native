#!/usr/bin/env node
import { restoreBackup, verifyBackup } from './backup.js'

const [action, backup, target] = process.argv.slice(2)
try {
  if (action === 'verify' && backup && !target) {
    const value = await verifyBackup(backup)
    console.log(JSON.stringify({ verified: true, files: value.files.length, createdAt: value.createdAt }))
  } else if (action === 'restore' && backup && target) {
    console.log(JSON.stringify({ restored: true, ...await restoreBackup(backup, target) }))
  } else throw new Error('用法：node host/recovery-cli.js verify <备份目录> 或 restore <备份目录> <新目录>')
} catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
