import type { DiagnosticFile } from '../../core/types.js'
import type { LspServerManager } from './server-manager.js'
import {
  formatDiagnosticsForAttachment,
  registerPendingLSPDiagnostic,
} from './LSPDiagnosticRegistry.js'

export type DiagnosticsSink = (input: {
  serverName: string
  files: DiagnosticFile[]
}) => void

/** Prefer stderr so Worker NDJSON on stdout stays clean. */
function diagLog(message: string): void {
  console.error(`[lsp:diagnostics:verify] ${message}`)
}

function isPublishDiagnosticsParams(params: unknown): params is {
  uri: string
  diagnostics: Array<{
    message: string
    severity?: number
    range: {
      start: { line: number; character: number }
      end: { line: number; character: number }
    }
    source?: string
    code?: string | number
  }>
} {
  return (
    typeof params === 'object' &&
    params !== null &&
    'uri' in params &&
    typeof (params as { uri?: unknown }).uri === 'string' &&
    'diagnostics' in params &&
    Array.isArray((params as { diagnostics?: unknown }).diagnostics)
  )
}

/**
 * Register LSP notification handlers on all servers.
 * When `onDiagnostics` is provided (Worker), emit there instead of the in-process registry.
 */
export function registerLSPNotificationHandlers(
  manager: LspServerManager,
  onDiagnostics?: DiagnosticsSink,
): void {
  const workspaceKey = manager.workspaceKey
  const servers = manager.getAllServers()

  for (const [serverName, serverInstance] of servers.entries()) {
    if (
      !serverInstance ||
      typeof serverInstance.onNotification !== 'function'
    ) {
      diagLog(`skip handler registration for ${serverName}: no onNotification`)
      continue
    }

    serverInstance.onNotification(
      'textDocument/publishDiagnostics',
      (params: unknown) => {
        try {
          if (!isPublishDiagnosticsParams(params)) {
            diagLog(
              `invalid publishDiagnostics from ${serverName} paramsType=${typeof params}`,
            )
            return
          }

          const count = params.diagnostics.length
          diagLog(
            `recv publishDiagnostics server=${serverName} uri=${params.uri} count=${count}`,
          )

          const diagnosticFiles = formatDiagnosticsForAttachment(params)
          const firstFile = diagnosticFiles[0]
          if (!firstFile || firstFile.diagnostics.length === 0) {
            diagLog(
              `skip empty (not forwarded) server=${serverName} uri=${params.uri}`,
            )
            return
          }

          diagLog(
            `forward server=${serverName} file=${firstFile.uri} diagnostics=${firstFile.diagnostics.length} via=${onDiagnostics ? 'lsp_event' : 'local-registry'}`,
          )

          if (onDiagnostics) {
            onDiagnostics({ serverName, files: diagnosticFiles })
          } else {
            registerPendingLSPDiagnostic(workspaceKey, {
              serverName,
              files: diagnosticFiles,
            })
          }
        } catch (err) {
          diagLog(
            `handler error server=${serverName}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          )
        }
      },
    )

    diagLog(
      `handler registered server=${serverName} workspaceKey=${workspaceKey.slice(0, 12)}…`,
    )
  }
}
