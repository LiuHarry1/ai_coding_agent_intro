/**
 * Ensure remote Grep/Glob use Worker `rg` RPC (CC-style), not shell fallthrough.
 * Run: npx tsx src/scripts/test-remote-grep-shell.ts
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const grepSrc = readFileSync(
  path.join(here, '../tools/GrepTool/GrepTool.ts'),
  'utf8',
)
const globSrc = readFileSync(
  path.join(here, '../tools/GlobTool/GlobTool.ts'),
  'utf8',
)
const protocolSrc = readFileSync(
  path.join(here, '../execution/runtime-protocol.ts'),
  'utf8',
)
const workerMain = readFileSync(path.join(here, '../worker/main.ts'), 'utf8')
const runRg = readFileSync(path.join(here, '../worker/run-rg.ts'), 'utf8')

assert.ok(protocolSrc.includes("op: 'rg'"), 'protocol must define rg op')
assert.ok(workerMain.includes("case 'rg':"), 'worker must handle rg op')
assert.ok(
  runRg.includes('error.code === 1'),
  'run-rg must treat exit 1 as success',
)
assert.ok(
  grepSrc.includes('execution.rg('),
  'Grep remote path must call execution.rg',
)
assert.ok(
  globSrc.includes('execution.rg('),
  'Glob remote path must call execution.rg',
)
assert.ok(
  !grepSrc.includes('rg || grep') &&
    !grepSrc.includes('buildRemoteGrepShellCommand') &&
    !grepSrc.includes('grep -RIn'),
  'Grep must not shell out to grep fallback',
)
assert.ok(
  !globSrc.includes('rg || find') && !globSrc.includes("find . -type f"),
  'Glob must not shell out to find fallback',
)
assert.ok(
  grepSrc.includes("execution.environmentId === 'local'"),
  'Grep should skip remote rg for local Worker',
)
assert.ok(
  globSrc.includes("execution.environmentId === 'local'"),
  'Glob should skip remote rg for local Worker',
)

console.log('ok remote grep/glob use CC-style Worker rg RPC')
