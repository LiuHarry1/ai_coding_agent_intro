import * as fs from 'fs'

// Load .env (Node 20.12+ built-in, no dotenv dependency needed).
// Silent when the file doesn't exist.
try {
  process.loadEnvFile('.env')
  console.log('[start] Loaded .env')
} catch (err) {
  if (err?.code !== 'ENOENT') {
    console.warn(`[start] Failed to load .env: ${err.message}`)
  }
}

// Log the env vars that actually drive glob/grep behavior so a stale
// server (or a typo in .env) shows up immediately at boot instead of
// being diagnosed by inspection. Undefined here = ripgrep gets the
// surprise-permissive defaults baked into utils/glob.ts.
console.log(
  `[start] GLOB_NO_IGNORE=${process.env.GLOB_NO_IGNORE ?? '(unset → defaults true)'} ` +
    `GLOB_HIDDEN=${process.env.GLOB_HIDDEN ?? '(unset → defaults true)'}`,
)
console.log(
  `[start] ANALYTICS_URL=${process.env.ANALYTICS_URL ?? '(unset → telemetry disabled)'}`,
)

// First positional that isn't a `--flag` is the example name.
const positionals = process.argv.slice(2).filter(a => !a.startsWith('--'))
const example = positionals[0] || '08-basic'

console.log(`[start] Loading example: ${example}`)

async function tryImport(base) {
  const tsPath = `./examples/${example}/${base}.ts`
  const jsPath = `./examples/${example}/${base}.js`
  const tsExists = fs.existsSync(new URL(tsPath, import.meta.url))
  return import(tsExists ? tsPath : jsPath)
}

let runAgent, systemPrompt, startServer
try {
  ;({ runAgent } = await tryImport('agent'))

  ;({ startServer } = await tryImport('server'))
  // 07-basic still wires systemPrompt into its router; 08-basic ignores it.
  try {
    ;({ systemPrompt } = await tryImport('prompts'))
  } catch {
    systemPrompt = undefined
  }
  console.log(`[start] Using server from ${example}/`)
} catch (err) {
  console.error(`[start] Failed to load example "${example}": ${err.message}`)
  console.error(`[start] Available examples:`)

  const dirs = fs.readdirSync(new URL('./examples', import.meta.url))
  dirs.forEach(d => console.error(`  - ${d}`))
  process.exit(1)
}

// Resolve the default workspace ONCE at boot (CLI --workspace > $WORKSPACE >
// process.cwd()). Logs early so a typo blows up here rather than on the first
// tool call. The actual resolver lives inside the example so each example can
// own its workspace semantics; we just trigger it and log the result.
try {
  const { resolveDefaultWorkspace } = await tryImport('core/workspace')
  const workspace = resolveDefaultWorkspace()
  console.log(`[start] workspace = ${workspace}`)
} catch (err) {
  // Examples without a core/workspace module (older ones) are unaffected.
  if (err?.code !== 'ERR_MODULE_NOT_FOUND') {
    console.error(`[start] Failed to resolve workspace: ${err.message}`)
    process.exit(1)
  }
}

if (process.argv.includes('--stdio')) {
  try {
    const { startStdioAgent } = await tryImport('cli')
    await startStdioAgent(runAgent)
  } catch (err) {
    console.error(`[start] stdio CLI failed: ${err.message}`)
    process.exit(1)
  }
} else {
  startServer({ runAgent, ...(systemPrompt ? { systemPrompt } : {}) })
}
