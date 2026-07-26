/**
 * Request-scoped filesystem sandbox for multi-tenant (SSO) deployments.
 *
 *   SANDBOX_MODE=off|unset  → local/admin: no extra read restrictions
 *   SANDBOX_MODE=strict     → SSO: read+write must stay in policy.root
 *
 * When SANDBOX_MODE is unset, AUTH_ENABLED=true implies strict.
 *
 * This is an application-layer control (File tools + HTTP workspace API).
 * Bash is NOT OS-sandboxed here — see system prompt / tool descriptions.
 */
import * as fs from 'fs'
import * as path from 'path'
import { isPathInWorkspace } from './workspace.js'

export type SandboxMode = 'off' | 'strict'

export interface SandboxPolicy {
  mode: SandboxMode
  /** Allowed project root (SSO: pinned userWorkspace). */
  root: string
  /** Optional extra roots readable in strict mode (comma-separated env). */
  extraReadRoots: string[]
  /**
   * Extra roots writable even when outside `root` (e.g. auto-memory dir).
   * Used for trusted carve-outs; each write is audit-logged.
   */
  extraWriteRoots: string[]
}

function parseExtraReadRoots(): string[] {
  const raw = process.env.SANDBOX_EXTRA_READ_ROOTS?.trim()
  if (!raw) return []
  return raw
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(p => path.resolve(p))
}

function isAuthEnabledEnv(): boolean {
  return (
    String(process.env.AUTH_ENABLED ?? '')
      .trim()
      .toLowerCase() === 'true'
  )
}

/** Resolve effective sandbox mode from env (and AUTH_ENABLED fallback). */
export function resolveSandboxMode(): SandboxMode {
  const raw = String(process.env.SANDBOX_MODE ?? '')
    .trim()
    .toLowerCase()
  if (raw === 'strict' || raw === 'app-only') return 'strict'
  if (raw === 'off' || raw === 'false' || raw === '0') return 'off'
  if (isAuthEnabledEnv()) return 'strict'
  return 'off'
}

export function isSandboxStrict(policy?: SandboxPolicy): boolean {
  return (policy?.mode ?? resolveSandboxMode()) === 'strict'
}

export type CreateSandboxPolicyOptions = {
  extraReadRoots?: string[]
  extraWriteRoots?: string[]
}

/** Build a policy for the request cwd / pinned user workspace. */
export function createSandboxPolicy(
  root: string,
  opts?: CreateSandboxPolicyOptions,
): SandboxPolicy {
  const envReads = parseExtraReadRoots()
  const extraReads = [
    ...envReads,
    ...(opts?.extraReadRoots ?? []).map(p => path.resolve(p)),
  ]
  const extraWrites = (opts?.extraWriteRoots ?? []).map(p => path.resolve(p))
  return {
    mode: resolveSandboxMode(),
    root: path.resolve(root),
    extraReadRoots: extraReads,
    extraWriteRoots: extraWrites,
  }
}

function pathAllowedForRead(absPath: string, policy: SandboxPolicy): boolean {
  if (isPathInWorkspace(absPath, policy.root)) return true
  return policy.extraReadRoots.some(r => isPathInWorkspace(absPath, r))
}

function pathAllowedForWrite(absPath: string, policy: SandboxPolicy): boolean {
  if (isPathInWorkspace(absPath, policy.root)) return true
  return (policy.extraWriteRoots ?? []).some(r =>
    isPathInWorkspace(absPath, r),
  )
}

function refusalMessage(
  absPath: string,
  root: string,
  access: 'read' | 'write',
): string {
  const verb = access === 'read' ? 'Access' : 'Writes'
  return (
    `Refused: "${absPath}" is outside the workspace "${root}". ` +
    `${verb} are limited to your workspace.`
  )
}

/**
 * Enforce path access according to policy.
 *
 * - mode=off + read  → allow (local flexibility)
 * - mode=off + write → must be inside root or extraWriteRoots
 * - mode=strict      → read in root|extraReadRoots; write in root|extraWriteRoots
 */
export function assertAccessible(
  absPath: string,
  policy: SandboxPolicy,
  access: 'read' | 'write',
): void {
  const resolved = path.resolve(absPath)

  if (policy.mode === 'off') {
    if (access === 'write' && !pathAllowedForWrite(resolved, policy)) {
      throw new Error(refusalMessage(resolved, policy.root, 'write'))
    }
    if (
      access === 'write' &&
      !isPathInWorkspace(resolved, policy.root) &&
      pathAllowedForWrite(resolved, policy)
    ) {
      console.log(`[sandbox] write carve-out path=${resolved}`)
    }
    return
  }

  if (access === 'read') {
    if (!pathAllowedForRead(resolved, policy)) {
      throw new Error(refusalMessage(resolved, policy.root, 'read'))
    }
    return
  }

  if (!pathAllowedForWrite(resolved, policy)) {
    throw new Error(refusalMessage(resolved, policy.root, 'write'))
  }
  if (!isPathInWorkspace(resolved, policy.root)) {
    console.log(`[sandbox] write carve-out path=${resolved}`)
  }
}

/**
 * Check both the given path and its realpath (when it exists) so a symlink
 * inside the workspace cannot point at another tenant's files.
 */
export function assertAccessibleResolved(
  absPath: string,
  policy: SandboxPolicy,
  access: 'read' | 'write',
): void {
  const resolved = path.resolve(absPath)
  assertAccessible(resolved, policy, access)

  let real: string | undefined
  try {
    real = fs.realpathSync(resolved)
  } catch {
    // Path may not exist yet (e.g. write_file creating a new file).
    // Also try realpath on the nearest existing ancestor.
    let dir = path.dirname(resolved)
    for (let i = 0; i < 32; i++) {
      try {
        const realDir = fs.realpathSync(dir)
        const rest = path.relative(dir, resolved)
        const candidate = path.resolve(realDir, rest)
        if (candidate !== resolved) {
          assertAccessible(candidate, policy, access)
        }
        return
      } catch (inner) {
        if (inner instanceof Error && inner.message.startsWith('Refused:')) {
          throw inner
        }
        const parent = path.dirname(dir)
        if (parent === dir) break
        dir = parent
      }
    }
    return
  }

  if (real && path.resolve(real) !== resolved) {
    assertAccessible(real, policy, access)
  }
}

/** Resolve policy from ToolContext-like object or fall back to cwd. */
export function policyFromContext(
  cwd: string,
  sandbox?: SandboxPolicy,
): SandboxPolicy {
  return sandbox ?? createSandboxPolicy(cwd)
}

/** System-prompt section when strict mode is on; empty otherwise. */
export function workspaceBoundaryPromptSection(cwd: string): string {
  if (resolveSandboxMode() !== 'strict') return ''
  const root = path.resolve(cwd)
  return `
# Workspace boundary (enforced)
 - Your only project directory is: ${root}
 - Do NOT list, read, search, or modify files outside this directory (including sibling directories under the parent path, or other users' workspaces).
 - If a path is outside this directory, stop and work only within ${root}.
 - System binaries (git, python, npm, etc.) may still be executed via the shell; only file data outside the workspace is off-limits.
`
}
