/**
 * Single-file desktop/CLI agent entry (esbuild → dist/agent/{slug}-agent.cjs).
 * Mirrors start.js fast-paths, then delegates to the mode dispatcher in cli.ts.
 */
import { applyRuntimeModulePath } from '../execution/worker-paths.js'

applyRuntimeModulePath()

import { readFileSync } from 'fs'
import { join } from 'path'
import { getRepoRoot } from '../execution/worker-paths.js'

const args = process.argv.slice(2)

function readPackageVersion(): string {
  try {
    const pkgPath = join(getRepoRoot(), 'package.json')
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string }
    return pkg.version ?? '1.0.0'
  } catch {
    return '1.0.0'
  }
}

if (args.includes('--version') || args.includes('-v')) {
  console.log(readPackageVersion())
  process.exit(0)
}

if (args.includes('--help') || args.includes('-h')) {
  console.log(`Usage: baize-agent [--acp | --stdio | --worker-stdio]

Modes:
  (default)       HTTP server on PORT (default 4567)
  --acp           Agent Client Protocol (stdout JSON-RPC)
  --stdio         NDJSON stdio agent
  --worker-stdio  Execution-plane worker (FS/shell/LSP over stdio NDJSON)`)
  process.exit(0)
}

// ACP uses stdout for JSON-RPC — keep boot logs on stderr only.
if (args.includes('--acp')) {
  console.log = console.error
  console.info = console.error
  console.warn = console.error
  console.debug = console.error
}

void import('./cli.js')
