import type { LspServerConfig as AppLspServerConfig } from '../../core/types.js'

export type LspServerConfig = AppLspServerConfig

export type LspServerState =
  'stopped' | 'starting' | 'running' | 'stopping' | 'error'

export interface ScopedLspServerConfig extends LspServerConfig {
  name: string
  workspaceFolder: string
}
