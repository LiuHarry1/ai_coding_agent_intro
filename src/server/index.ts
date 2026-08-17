import * as http from 'http'
import * as path from 'path'
import * as fs from 'fs'
import { fileURLToPath } from 'url'
import { createRouter } from './router.js'
import type { ServerOptions } from '../core/types.js'
import { shutdownAllLspManagers } from '../services/lsp/manager.js'
import {
  bootstrapExecutionPlane,
  shutdownExecutionPlane,
} from '../execution/index.js'
import * as os from 'os'
import { resolveSettings } from '../core/settings-manager.js'
import { getDefaultWorkspace } from '../core/workspace.js'
import { runWithRequestScope } from '../utils/request-scope.js'
import { initBrowserLifecycle } from '../browser/manager.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export function startServer({ runAgent }: ServerOptions): void {
  const PORT = parseInt(process.env.PORT || '4567', 10)

  // Last-line defense against flaky upstreams (e.g. copilot-api dropping the
  // socket mid-stream). Without these the undici fetch/body errors surface as
  // unhandled rejections and Node 22+ kills the whole server. We keep the
  // process alive and log the failure; in-flight requests will already have
  // been failed by the agent's own try/catch around the stream.
  process.on('unhandledRejection', reason => {
    const msg =
      reason instanceof Error
        ? (reason.stack ?? reason.message)
        : String(reason)
    console.error('[server] unhandledRejection:', msg)
  })
  process.on('uncaughtException', err => {
    console.error('[server] uncaughtException:', err.stack ?? err.message)
  })

  // Static hosting is opt-out via SERVE_STATIC=0 (or "false"). Default keeps
  // serving the bundled SPA so local `npm start` and the Electron shell are
  // unchanged. Set SERVE_STATIC=0 to run a pure headless API -- the mode you
  // want when the frontend is deployed separately and talks cross-origin.
  const serveStatic = !['0', 'false', 'no'].includes(
    (process.env.SERVE_STATIC ?? '').toLowerCase(),
  )
  const distDir = path.resolve(__dirname, '../../client/web/dist')
  const staticDir = serveStatic && fs.existsSync(distDir) ? distDir : null

  if (!serveStatic) {
    console.log(`[server] Headless mode (SERVE_STATIC=0): not serving any SPA.`)
  } else if (!staticDir) {
    console.log(`[server] Warning: client/web/dist not found.`)
    console.log(`[server] Run: cd client/web && npm install && npm run build`)
    console.log(`[server] Or use dev mode: cd client/web && npm run dev`)
  }

  const handler = createRouter({ runAgent, staticDir })

  const server = http.createServer(handler)
  let shuttingDown = false
  const shutdown = (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`[server] ${signal}: shutting down`)
    server.close(() => {
      void shutdownExecutionPlane()
        .catch(() => {})
        .finally(() =>
          void shutdownAllLspManagers().finally(() => process.exit(0)),
        )
    })
  }
  process.once('SIGINT', () => shutdown('SIGINT'))
  process.once('SIGTERM', () => shutdown('SIGTERM'))

  void (async () => {
    try {
      // AUTH fail-closed: getAgentHome() needs ALS. Boot is outside any
      // request — pin OS home + default workspace so resolveSettings/bootstrap
      // can load SSH hosts (managed still comes from getManagedDir).
      // Per-request scope is set in the router via runWithRequestScope.
      const bootCwd = getDefaultWorkspace()
      await runWithRequestScope(
        { agentHome: os.homedir(), cwd: bootCwd },
        async () => {
          const settings = resolveSettings(bootCwd)
          initBrowserLifecycle(bootCwd)
          await bootstrapExecutionPlane({
            sshHosts: settings.config.environments?.ssh ?? [],
          })
        },
      )
      console.log(`[server] execution plane ready (local + ssh providers)`)
    } catch (err) {
      console.warn(
        '[server] execution plane bootstrap failed:',
        err instanceof Error ? err.message : err,
      )
    }

    server.listen(PORT, () => {
      console.log(`[server] listening on http://localhost:${PORT}`)
      console.log(`[server]   POST /sessions     -- create session`)
      console.log(`[server]   GET  /sessions     -- list sessions`)
      console.log(`[server]   DELETE /sessions/id -- delete session`)
      console.log(`[server]   POST /chat         -- chat (SSE stream)`)
      console.log(`[server]   POST /tool/abort   -- abort one tool/subagent`)
      console.log(`[server]   GET  /environments -- list execution environments`)
      if (staticDir) {
        console.log(`[server]   Static files from: ${distDir}`)
      }
    })
  })()

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[server] port ${PORT} is already in use.`)
    } else {
      console.error(`[server] error: ${err.message}`)
    }
    process.exit(1)
  })
}
