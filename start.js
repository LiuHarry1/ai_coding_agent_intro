// ACP uses stdout for JSON-RPC — keep boot logs on stderr only.
// Must run before any business imports that might console.log.
if (process.argv.includes('--acp')) {
  console.log = console.error
  console.info = console.error
  console.warn = console.error
  console.debug = console.error
}

await import('./src/entrypoints/cli.ts')
