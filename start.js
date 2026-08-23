import { readFileSync } from 'fs'

// CC fast-path: zero business imports for --version / --help.
const args = process.argv.slice(2)
if (args.includes('--version') || args.includes('-v')) {
  const pkg = JSON.parse(
    readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
  )
  console.log(pkg.version)
  process.exit(0)
}
if (args.includes('--help') || args.includes('-h')) {
  console.log(`Usage: node start.js [--acp | --stdio]

Modes:
  (default)  HTTP server on PORT (default 4567)
  --acp      Agent Client Protocol (stdout JSON-RPC)
  --stdio    NDJSON stdio agent`)
  process.exit(0)
}

// ACP uses stdout for JSON-RPC — keep boot logs on stderr only.
if (args.includes('--acp')) {
  console.log = console.error
  console.info = console.error
  console.warn = console.error
  console.debug = console.error
}

await import('./src/entrypoints/cli.ts')
