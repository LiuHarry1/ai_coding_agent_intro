import * as fs from 'fs'

// ACP uses stdout for JSON-RPC — keep boot logs on stderr only.
if (process.argv.includes('--acp')) {
  console.log = console.error
  console.info = console.error
  console.warn = console.error
  console.debug = console.error
}

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

async function tryImport(base) {
  const tsPath = `./src/${base}.ts`
  const jsPath = `./src/${base}.js`
  const tsExists = fs.existsSync(new URL(tsPath, import.meta.url))
  return import(tsExists ? tsPath : jsPath)
}

console.log('[start] Loading agent from src/')

let runAgent, systemPrompt, startServer
try {
  ;({ runAgent } = await tryImport('agent'))
  ;({ startServer } = await tryImport('server'))
  try {
    ;({ systemPrompt } = await tryImport('prompts'))
  } catch {
    systemPrompt = undefined
  }
  console.log('[start] Using server from src/')
} catch (err) {
  console.error(`[start] Failed to load src/: ${err.message}`)
  process.exit(1)
}

// Resolve the default workspace ONCE at boot (CLI --workspace > $WORKSPACE >
// process.cwd()). Logs early so a typo blows up here rather than on the first
// tool call.
try {
  const { resolveDefaultWorkspace } = await tryImport('core/workspace')
  const workspace = resolveDefaultWorkspace()
  console.log(`[start] workspace = ${workspace}`)
} catch (err) {
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
} else if (process.argv.includes('--acp')) {
  process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason)
  })
  try {
    const { startAcpAgent } = await tryImport('acp')
    await startAcpAgent(runAgent)
  } catch (err) {
    console.error(`[start] ACP agent failed: ${err.message}`)
    process.exit(1)
  }
} else {
  startServer({ runAgent, ...(systemPrompt ? { systemPrompt } : {}) })
}
