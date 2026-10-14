/**
 * Bridge between vitest and the legacy `src/scripts/test-*.ts` scripts.
 *
 * Each legacy script is a standalone program that exits non‑zero on failure.
 * `defineScriptSuite` turns a list of them into one vitest `describe` block
 * with one `it` per script, so `vitest run` reports pass/fail per script and
 * only prints a script's output when it fails.
 *
 * New tests should be written as native `*.test.ts` files instead of being
 * added here.
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import { describe, it } from 'vitest'

export interface ScriptSuiteOptions {
  /** Extra env for every script; `undefined` deletes a variable. */
  env?: Record<string, string | undefined>
  /** Per-script wall-clock limit before the child is killed. */
  timeoutMs?: number
}

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..')
const TSX_CLI = path.join(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs')
const DEFAULT_TIMEOUT_MS = 240_000
const TAIL_LINES = 120

export function defineScriptSuite(
  name: string,
  scripts: string[],
  opts: ScriptSuiteOptions = {},
): void {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  describe(name, () => {
    for (const script of scripts) {
      it(script, { timeout: timeoutMs + 10_000 }, async () => {
        await runScript(script, { ...opts, timeoutMs })
      })
    }
  })
}

export async function runScript(
  script: string,
  opts: ScriptSuiteOptions = {},
): Promise<void> {
  const file = path.isAbsolute(script)
    ? script
    : path.join(REPO_ROOT, 'src/scripts', script)
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS

  const env: NodeJS.ProcessEnv = { ...process.env }
  // Vitest sets these for its own workers; the scripts should not think
  // they are running inside vitest.
  delete env.VITEST
  delete env.VITEST_WORKER_ID
  delete env.VITEST_POOL_ID
  for (const [k, v] of Object.entries(opts.env ?? {})) {
    if (v === undefined) delete env[k]
    else env[k] = v
  }

  const started = Date.now()
  const chunks: string[] = []
  const child = spawn(process.execPath, [TSX_CLI, file], {
    cwd: REPO_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', d => chunks.push(d))
  child.stderr.on('data', d => chunks.push(d))

  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    child.kill('SIGKILL')
  }, timeoutMs)

  const { code, signal } = await new Promise<{
    code: number | null
    signal: NodeJS.Signals | null
  }>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code, signal }))
  }).finally(() => clearTimeout(timer))

  const output = chunks.join('')
  if (process.env.TEST_SCRIPT_OUTPUT === '1' && output) {
    console.log(`\n[${path.basename(file)}]\n${output}`)
  }

  if (timedOut) {
    throw new Error(
      `${path.basename(file)} timed out after ${timeoutMs}ms\n${tail(output)}`,
    )
  }
  if (code !== 0) {
    const how = code === null ? `signal ${signal}` : `exit code ${code}`
    const secs = ((Date.now() - started) / 1000).toFixed(1)
    throw new Error(
      `${path.basename(file)} failed (${how}, ${secs}s)\n${tail(output)}`,
    )
  }
}

function tail(output: string): string {
  const lines = output.trimEnd().split(/\r?\n/)
  const shown = lines.slice(-TAIL_LINES)
  const header =
    lines.length > shown.length
      ? `--- output (last ${shown.length} of ${lines.length} lines) ---`
      : '--- output ---'
  return `${header}\n${shown.join('\n')}`
}
