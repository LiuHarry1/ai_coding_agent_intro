/**
 * Mode dispatcher — peek argv, init once, dynamic-import only what that mode needs.
 * Mirrors Claude Code entrypoints/cli.tsx (without Commander / feature gates).
 */
import { init, type BootMode } from './init.js'

function detectMode(argv: string[]): BootMode {
  if (argv.includes('--acp')) return 'acp'
  if (argv.includes('--stdio')) return 'stdio'
  return 'http'
}

async function main(): Promise<void> {
  const mode = detectMode(process.argv.slice(2))
  await init(mode)

  bootLog(`[start] Loading agent for mode=${mode}`)
  const { runAgent } = await import('../agent.js')

  if (mode === 'stdio') {
    const { startStdioAgent } = await import('../cli.js')
    await startStdioAgent(runAgent)
    return
  }

  if (mode === 'acp') {
    process.on('unhandledRejection', (reason, promise) => {
      console.error('Unhandled Rejection at:', promise, 'reason:', reason)
    })
    const { startAcpAgent } = await import('../acp.js')
    await startAcpAgent(runAgent)
    return
  }

  const { startServer } = await import('../server.js')
  startServer({ runAgent })
}

function bootLog(message: string): void {
  console.error(message)
}

void main().catch((err) => {
  console.error(`[start] Fatal: ${(err as Error).message}`)
  process.exit(1)
})
