/**
 * Request-scoped filesystem policy. Implementation lives in
 * `utils/permissions/filesystem.ts` (CC checkRead / checkWrite).
 *
 * Cloud (`AUTH_ENABLED`): mode `dontAsk` — outside the pinned working dir
 * is deny (no UI). Desktop: mode `default` — outside is ask.
 *
 * This is an application-layer control (File tools + HTTP workspace API).
 * Bash is NOT OS-sandboxed here — see system prompt / tool descriptions.
 */
export {
  createFilesystemPermissionContext as createSandboxPolicy,
  settingsPermissionOpts,
  type FilesystemPermissionContext as SandboxPolicy,
  type FilesystemPermissionMode as SandboxMode,
  type CreateFilesystemPermissionContextOptions as CreateSandboxPolicyOptions,
  assertAccessible,
  assertAccessibleResolved,
  policyFromContext,
  resolveFilesystemPermissionMode as resolveSandboxMode,
} from '../utils/permissions/filesystem.js'

import { resolveSettings } from './settings-manager.js'
import {
  resolveFilesystemPermissionMode,
  workspaceBoundaryPromptSection as workspaceBoundaryPromptSectionImpl,
  type FilesystemPermissionContext,
} from '../utils/permissions/filesystem.js'

/** True when remaining `ask` decisions are mapped to deny (SSO / AUTH). */
export function isSandboxStrict(
  policy?: FilesystemPermissionContext,
): boolean {
  return (policy?.mode ?? resolveFilesystemPermissionMode()) === 'dontAsk'
}

/** Enforced workspace-boundary blurb when File tools deny outside cwd. */
export function workspaceBoundaryPromptSection(cwd: string): string {
  if (resolveFilesystemPermissionMode() === 'dontAsk') {
    return workspaceBoundaryPromptSectionImpl(cwd, 'dontAsk')
  }
  try {
    if (resolveSettings(cwd).config.permissions?.defaultMode === 'dontAsk') {
      return workspaceBoundaryPromptSectionImpl(cwd, 'dontAsk')
    }
  } catch {
    // settings may be unavailable during early boot
  }
  return ''
}
