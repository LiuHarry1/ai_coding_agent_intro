/**
 * Workspace-scoped agent picker helpers for session create / mode switches.
 */
import { resolveSettings } from './settings-manager.js'
import { loadWorkspaceContributions } from './workspace-load.js'
import {
  isAgentTypeAllowedByPicker,
  isModeAllowedByPicker,
  resolveAgentPicker,
  type ResolvedAgentPicker,
} from './agent-picker.js'
import type { Session } from './types.js'
import {
  createDefaultPermissionMode,
  type ExternalMode,
} from './permission-mode.js'

export async function loadResolvedAgentPicker(
  cwd: string,
): Promise<ResolvedAgentPicker> {
  const settings = resolveSettings(cwd)
  const { agents } = await loadWorkspaceContributions(cwd)
  return resolveAgentPicker(settings.config.agents, agents.activeAgents)
}

/** Apply picker defaults onto a freshly created session. */
export function applyPickerDefaultsToSession(
  session: Session,
  picker: ResolvedAgentPicker,
): void {
  session.permissionMode = {
    ...createDefaultPermissionMode(),
    mode: picker.default.mode,
  }
  session.agentType = picker.default.agentType
}

export function pickerModeError(
  picker: ResolvedAgentPicker,
  mode: string,
): string | null {
  if (isModeAllowedByPicker(picker, mode)) return null
  if (picker.modes.length === 0) {
    return `Mode '${mode}' is not available (picker.modes is empty; only agent permission with a primary is allowed)`
  }
  return `Mode '${mode}' is not in picker.modes [${picker.modes.join(', ')}]`
}

export function pickerAgentTypeError(
  picker: ResolvedAgentPicker,
  agentType: string | null,
): string | null {
  if (isAgentTypeAllowedByPicker(picker, agentType)) return null
  if (agentType === null) {
    return 'Default coding agent (agentType null) is not available for this workspace picker'
  }
  const allowed = picker.primaries.map(a => a.agentType)
  return `agentType '${agentType}' is not in picker.primaries [${allowed.join(', ') || '(none)'}]`
}

export type { ResolvedAgentPicker, ExternalMode }
