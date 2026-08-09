/**
 * Logical agent HOME (request-scoped under AUTH/SSO).
 *
 * - AUTH off: `os.homedir()` (admin / local)
 * - AUTH on + ALS set: pinned `userWorkspace`
 * - AUTH on + no ALS: throw (fail-closed — never silently write to /root)
 *
 * Managed/policy paths (`getManagedDir`) must never use this.
 *
 * Auth gate is read from env here (same rule as `isAuthEnabled`) to avoid a
 * circular import with `server/auth/identity` → `workspace` → this module.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import * as os from 'os'
import * as path from 'path'

const agentHomeAls = new AsyncLocalStorage<string>()

function authEnabled(): boolean {
  return (
    String(process.env.AUTH_ENABLED ?? '')
      .trim()
      .toLowerCase() === 'true'
  )
}

/** Run `fn` with logical HOME bound for the current async context. */
export function runWithAgentHome<T>(home: string, fn: () => T): T {
  const resolved = path.resolve(home)
  return agentHomeAls.run(resolved, fn)
}

/**
 * Logical HOME for user-scope app-dir, `~` expansion, and local bash `$HOME`.
 * Fail-closed when AUTH is on but the request was not wrapped.
 */
export function getAgentHome(): string {
  if (!authEnabled()) {
    return os.homedir()
  }
  const home = agentHomeAls.getStore()
  if (!home) {
    throw new Error(
      'getAgentHome() called with AUTH_ENABLED but no agent home in context; wrap the request with runWithAgentHome(userWorkspace)',
    )
  }
  return home
}

/**
 * HOME for local shell spawn. Prefer ALS; under AUTH outside ALS (worker
 * child), use process.env.HOME pinned by LocalProvider at runtime open.
 * Does not relax fail-closed for app-dir / settings callers.
 */
export function getShellHome(): string {
  try {
    return getAgentHome()
  } catch (err) {
    if (authEnabled()) {
      const pinned = process.env.HOME?.trim()
      if (pinned) return path.resolve(pinned)
    }
    throw err
  }
}
