import assert from 'node:assert/strict'
import * as path from 'node:path'
import {
  buildAgentSpawnEnv,
  resolveDefaultDesktopWorkspace,
} from '../../electron/agent-launch.mjs'

const home = path.resolve('/test-user-home')
const workspace = resolveDefaultDesktopWorkspace({
  packaged: true,
  homeDir: home,
  env: {},
})
assert.equal(
  workspace,
  path.join(home, '.ai-agent', 'workspace'),
  'packaged Electron workspace must live under persistent user HOME',
)

const env = buildAgentSpawnEnv(
  '/read-only/app',
  4567,
  { HOME: home },
  {
    packaged: true,
    workspace,
  },
)
assert.equal(env.HOME, home, 'Electron agent child must preserve user HOME')
assert.equal(
  env.WORKSPACE,
  workspace,
  'Electron agent child must use the persistent desktop workspace',
)

const configured = buildAgentSpawnEnv(
  '/read-only/app',
  4567,
  { HOME: home, WORKSPACE: '/explicit-workspace' },
  { packaged: true, workspace },
)
assert.equal(
  configured.WORKSPACE,
  '/explicit-workspace',
  'explicit Electron workspace override must win',
)

console.log('All memory deployment checks passed.')
