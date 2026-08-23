/**
 * Settings Zod validation — strict schema rejects invalid types.
 */
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  resolveSettings,
  resetSettingsCache,
} from '../core/settings-manager.js'

function withTempDir(fn: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-val-'))
  try {
    fn(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
    resetSettingsCache()
  }
}

withTempDir(dir => {
  const settingsDir = path.join(dir, '.ai-agent')
  fs.mkdirSync(settingsDir, { recursive: true })
  fs.writeFileSync(
    path.join(settingsDir, 'settings.json'),
    JSON.stringify({
      compaction: { enabled: 'yes' },
    }),
  )
  const resolved = resolveSettings(dir)
  assert.ok(resolved.validationErrors.length > 0, 'invalid enabled type rejected')
  assert.equal(resolved.config.compaction.enabled, true, 'defaults kept when layer invalid')
  console.log('[ok] invalid compaction.enabled rejected')
})

withTempDir(dir => {
  const settingsDir = path.join(dir, '.ai-agent')
  fs.mkdirSync(settingsDir, { recursive: true })
  fs.writeFileSync(
    path.join(settingsDir, 'settings.json'),
    JSON.stringify({
      compaction: { enabled: false, contextWindow: 100_000 },
      disabledTools: ['Bash'],
    }),
  )
  const resolved = resolveSettings(dir)
  const projectErrors = resolved.validationErrors.filter(e =>
    e.file.includes(dir),
  )
  assert.equal(projectErrors.length, 0)
  assert.equal(resolved.config.compaction.enabled, false)
  assert.equal(resolved.config.compaction.contextWindow, 100_000)
  assert.deepEqual(resolved.config.disabledTools, ['Bash'])
  console.log('[ok] valid settings applied')
})

console.log('test-settings-validation: all passed')
