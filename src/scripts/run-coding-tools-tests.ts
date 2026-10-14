/**
 * Standalone runner for the coding-tools suites. `npm test` runs the same
 * scripts through vitest (`suites/tools.test.ts`); this entry point exists so
 * `coverage:tools` can wrap the child processes with c8.
 */
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import {
  CODING_TOOLS_ENV,
  CODING_TOOLS_INTEGRATION,
  CODING_TOOLS_UNIT,
} from './coding-tools-suites.js'

const suite = process.argv[2] ?? 'all'
const scripts =
  suite === 'unit'
    ? CODING_TOOLS_UNIT
    : suite === 'integration'
      ? CODING_TOOLS_INTEGRATION
      : suite === 'all'
        ? [...CODING_TOOLS_UNIT, ...CODING_TOOLS_INTEGRATION]
        : []

if (scripts.length === 0) {
  throw new Error(`Unknown coding-tools suite "${suite}"`)
}

const env = { ...process.env }
for (const [k, v] of Object.entries(CODING_TOOLS_ENV)) {
  if (v === undefined) delete env[k]
  else env[k] = v
}

const tsxCli = path.resolve('node_modules/tsx/dist/cli.mjs')
for (const script of scripts) {
  const file = path.join('src/scripts', script)
  console.log(`\n[coding-tools] ${file}`)
  const result = spawnSync(process.execPath, [tsxCli, file], {
    cwd: process.cwd(),
    env,
    stdio: 'inherit',
  })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

console.log(
  `\n[coding-tools] ${suite} suite passed (${scripts.length} scripts)`,
)
