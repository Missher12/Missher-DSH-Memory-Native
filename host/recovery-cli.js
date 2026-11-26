#!/usr/bin/env node
import { restoreBackup, verifyBackup } from './backup.js'
import { exportRevocations } from './recovery-privacy.js'

const [action, input, target, option, value, ...extra] = process.argv.slice(2)
try {
  if (action === 'verify' && input && target === undefined) {
    const result = await verifyBackup(input)
    console.log(JSON.stringify({ verified:true, files:result.files.length, createdAt:result.createdAt }))
  } else if (action === 'export-revocations' && input && target && option === undefined) {
    console.log(JSON.stringify({ exported:true, ...exportRevocations(input, target) }))
  } else if (action === 'restore' && input && target && !extra.length &&
      (option === undefined || ['--current-root', '--revocations'].includes(option) && value)) {
    const options = option === '--current-root' ? { currentRoot:value } : option === '--revocations' ? { revocations:value } : {}
    console.log(JSON.stringify({ restored:true, ...await restoreBackup(input, target, options) }))
  } else throw new Error([
    'node host/recovery-cli.js verify <备份目录>',
    'node host/recovery-cli.js export-revocations <当前数据目录> <新凭据文件>',
    'node host/recovery-cli.js restore <备份目录> <新目录> [--current-root <当前数据目录> | --revocations <凭据文件>]',
  ].join('\n'))
} catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
