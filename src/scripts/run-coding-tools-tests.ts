import { spawnSync } from 'node:child_process'
import path from 'node:path'

const unit = [
  'src/scripts/test-coding-tools-manifest.ts',
  'src/scripts/test-coding-tools-core.ts',
  'src/scripts/test-coding-tools-platform.ts',
  'src/scripts/test-coding-tools-orchestration.ts',
  'src/scripts/test-file-change-card-dom.mjs',
]

const integration = [
  'src/scripts/test-dual-channel-tools.ts',
  'src/scripts/test-grep-wire.ts',
  'src/scripts/test-ask-mode-restrictions.ts',
  'src/scripts/test-streaming-tool-exec.ts',
  'src/scripts/test-web-fetch.ts',
  'src/scripts/test-forked-agent.ts',
  'src/scripts/test-agent-loading.ts',
  'src/scripts/test-coding-tools-agent-skill.ts',
  'src/scripts/test-coding-tools-cron.ts',
]

const suite = process.argv[2] ?? 'all'
const scripts =
  suite === 'unit'
    ? unit
    : suite === 'integration'
      ? integration
      : suite === 'all'
        ? [...unit, ...integration]
        : []

if (scripts.length === 0) {
  throw new Error(`Unknown coding-tools suite "${suite}"`)
}

const env = { ...process.env }
delete env.AUTH_ENABLED
env.SKIP_LLM = '1'
env.WEB_FETCH_LIVE = '0'

for (const script of scripts) {
  console.log(`\n[coding-tools] ${script}`)
  const tsxCli = path.resolve('node_modules/tsx/dist/cli.mjs')
  const result = spawnSync(process.execPath, [tsxCli, script], {
    cwd: process.cwd(),
    env,
    stdio: 'inherit',
  })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

console.log(`\n[coding-tools] ${suite} suite passed (${scripts.length} scripts)`)

