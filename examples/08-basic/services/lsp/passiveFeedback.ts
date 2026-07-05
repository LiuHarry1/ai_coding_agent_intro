import type { LspServerManager } from './server-manager.js'
import {
  formatDiagnosticsForAttachment,
  registerPendingLSPDiagnostic,
} from './LSPDiagnosticRegistry.js'

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
 * Register LSP notification handlers on all servers (CC passiveFeedback.ts).
 */
export function registerLSPNotificationHandlers(
  manager: LspServerManager,
): void {
  const workspaceKey = manager.workspaceKey
  const servers = manager.getAllServers()

  for (const [serverName, serverInstance] of servers.entries()) {
    if (!serverInstance || typeof serverInstance.onNotification !== 'function') {
      console.warn(
        `[lsp:diagnostics] skip handler registration for ${serverName}: no onNotification`,
      )
      continue
    }

    serverInstance.onNotification(
      'textDocument/publishDiagnostics',
      (params: unknown) => {
        try {
          if (!isPublishDiagnosticsParams(params)) {
            console.warn(
              `[lsp:diagnostics] invalid publishDiagnostics params from ${serverName}`,
            )
            return
          }

          const diagnosticFiles = formatDiagnosticsForAttachment(params)
          const firstFile = diagnosticFiles[0]
          if (!firstFile || firstFile.diagnostics.length === 0) {
            console.log(
              `[lsp:diagnostics] publish empty server=${serverName} file=${params.uri}`,
            )
            return
          }

          const filePath = firstFile.uri
          console.log(
            `[lsp:diagnostics] publish server=${serverName} file=${filePath} diagnostics=${firstFile.diagnostics.length}`,
          )

          registerPendingLSPDiagnostic(workspaceKey, {
            serverName,
            files: diagnosticFiles,
          })
        } catch (err) {
          console.warn(
            `[lsp:diagnostics] handler error server=${serverName}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          )
        }
      },
    )
  }
}
