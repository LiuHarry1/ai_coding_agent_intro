import type { LspServerConfig as AppLspServerConfig } from '../../core/types.js'

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

export interface LspDiagnostic {
  message: string
  severity: 'Error' | 'Warning' | 'Info' | 'Hint'
  range: {
    start: { line: number; character: number }
    end: { line: number; character: number }
  }
  source?: string
  code?: string
}

export interface LspDiagnosticFile {
  uri: string
  diagnostics: LspDiagnostic[]
}

export interface PendingLspDiagnosticSet {
  serverName: string
  files: LspDiagnosticFile[]
}
