/**
 * Regression: a Bun-compiled agent must re-spawn itself with `--worker-stdio`,
 * never as `execPath worker.cjs --stdio`. The compiled binary ignores the
 * script path and starts the chat stdio agent, which never sends `ready`, so
 * every turn used to wait out the full bind timeout.
 *
 * Run: npx tsx src/scripts/test-worker-launch.ts
 */
import assert from 'node:assert/strict'
import { isInBundledMode } from '../utils/bundledMode.js'
import { resolveWorkerLaunch } from '../execution/worker-paths.js'

type BunSlot = { Bun?: unknown }
const g = globalThis as BunSlot

function withBundledMode<T>(fn: () => T): T {
  const had = 'Bun' in g
  const prev = g.Bun
  g.Bun = { embeddedFiles: ['<compiled entry>'] }
  try {
    return fn()
  } finally {
    if (had) g.Bun = prev
    else delete g.Bun
  }
}

// Under tsx/node there is no Bun global and no process.versions.bun.
assert.equal(isInBundledMode(), false, 'tsx run must not look bundled')

const bundled = withBundledMode(() => {
  assert.equal(isInBundledMode(), true, 'Bun.embeddedFiles must be detected')
  return resolveWorkerLaunch()
})

assert.deepEqual(
  bundled.args,
  ['--worker-stdio'],
  'bundled launch must pass only our own flag',
)
assert.equal(bundled.command, process.execPath)
assert.equal(bundled.artifactPath, process.execPath)
assert.equal(bundled.mode, 'agent-native')

const plain = resolveWorkerLaunch()
assert.notEqual(
  plain.mode,
  'agent-native',
  'non-bundled run must not take the compiled-self branch',
)
if (plain.mode === 'worker-bundle') {
  assert.deepEqual(plain.args, [plain.artifactPath, '--stdio'])
  assert.equal(plain.command, process.execPath)
}

console.log('PASS test-worker-launch')
console.log(`  bundled : ${bundled.command} ${bundled.args.join(' ')}`)
console.log(
  `  plain   : ${plain.mode} -> ${plain.command} ${plain.args.join(' ')}`,
)
