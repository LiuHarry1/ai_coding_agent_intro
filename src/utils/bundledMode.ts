/**
 * Runtime shape detection — CC `utils/bundledMode.ts`.
 *
 * A Bun `--compile` binary always runs its own embedded entry: a script path
 * passed as argv[1] is handed to the program as a plain argument, not executed.
 * Anything that re-spawns this process for a different mode must therefore
 * pass only our own flags (see `resolveWorkerLaunch`), the way CC dispatches
 * embedded ripgrep and the computer-use MCP server.
 */

type BunGlobal = { embeddedFiles?: unknown }

/** True when running under Bun at all (compiled binary or `bun run`). */
export function isRunningWithBun(): boolean {
  return process.versions.bun !== undefined
}

/**
 * True when running as a Bun-compiled standalone executable.
 *
 * CC checks `Bun.embeddedFiles`, which is populated for compiled binaries.
 * We fall back to the runtime check because this agent is only ever executed
 * by Bun as the compiled artifact — dev uses tsx/node, desktop uses Electron.
 */
export function isInBundledMode(): boolean {
  const bun = (globalThis as { Bun?: BunGlobal }).Bun
  if (bun && Array.isArray(bun.embeddedFiles) && bun.embeddedFiles.length > 0) {
    return true
  }
  return isRunningWithBun()
}
