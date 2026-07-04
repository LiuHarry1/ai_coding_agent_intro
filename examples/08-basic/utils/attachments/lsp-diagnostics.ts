import * as path from 'path'
import type { LspServerConfig, Message } from '../../core/types.js'
import { drainPendingLspDiagnostics } from '../../services/lsp/diagnostics.js'
import { getLspWorkspaceKey, hasLspServers } from '../../services/lsp/manager.js'

export function buildLspDiagnosticMessages(
  cwd: string,
  lspServers: Record<string, LspServerConfig> | undefined,
): Message[] {
  if (!hasLspServers(lspServers)) return []

  const workspaceKey = getLspWorkspaceKey(cwd, lspServers)
  const sets = drainPendingLspDiagnostics(workspaceKey)
  if (sets.length === 0) return []

  const lines: string[] = [
    'Language server diagnostics were reported after recent file changes. Use them as fresh feedback when deciding the next action.',
  ]

  for (const set of sets) {
    lines.push('', `From LSP server(s): ${set.serverName}`)
    for (const file of set.files) {
      lines.push(`\n${formatFilePath(cwd, file.uri)}:`)
      for (const diag of file.diagnostics) {
        lines.push(
          `- ${diag.severity} ${diag.range.start.line + 1}:${
            diag.range.start.character + 1
          } ${diag.source ? `[${diag.source}] ` : ''}${diag.message}`,
        )
      }
    }
  }

  return [
    {
      role: 'user',
      content: `<system-reminder>\n${lines.join('\n')}\n</system-reminder>`,
    },
  ]
}

function formatFilePath(cwd: string, filePath: string): string {
  const relative = path.relative(cwd, filePath).replaceAll('\\', '/')
  return relative && !relative.startsWith('..') ? relative : filePath
}
