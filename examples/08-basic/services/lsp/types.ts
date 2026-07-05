import type { LspServerConfig as AppLspServerConfig, Diagnostic, DiagnosticFile } from '../../core/types.js'

export type LspServerConfig = AppLspServerConfig

export type LspServerState =
  | 'stopped'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'error'

export interface ScopedLspServerConfig extends LspServerConfig {
  name: string
  workspaceFolder: string
}

export type LspDiagnostic = Diagnostic
export type LspDiagnosticFile = DiagnosticFile

export interface PendingLspDiagnosticSet {
  serverName: string
  files: LspDiagnosticFile[]
}
