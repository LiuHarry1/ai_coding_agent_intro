/**
 * Shared low-level fetch helper. Lives below both feature modules; neither
 * `agent.js` nor `workspace.js` imports the other, but both import this.
 *
 * When auth is enabled it injects the bearer token on every request and, on
 * a 401, clears the stale token and bounces to the SSO login.
 */
import { authHeader, handleUnauthorized } from '../auth.js'

/**
 * Resolve the agent backend base URL. Empty string = same-origin (the
 * default, identical to the old hard-coded relative paths). This is what
 * lets the frontend be deployed independently of the backend:
 *
 *   - runtime  : window.__APP_CONFIG__.apiBase (set by app-config.js, so
 *                ONE web image can point at any backend without a rebuild)
 *   - build    : import.meta.env.VITE_API_BASE (handy for `npm run dev`)
 *   - fallback : "" → same-origin
 */
function apiBase() {
  const runtime = globalThis.__APP_CONFIG__?.apiBase
  if (typeof runtime === 'string' && runtime) return runtime.replace(/\/$/, '')
  const build = import.meta.env?.VITE_API_BASE
  if (typeof build === 'string' && build) return build.replace(/\/$/, '')
  return ''
}

/** Prefix an absolute API path (e.g. "/chat") with the backend base URL. */
export function apiUrl(path) {
  return apiBase() + path
}

/** Merge the auth header into a fetch init's headers (auth-off → no-op). */
export function withAuth(options = {}) {
  const auth = authHeader()
  if (!auth.Authorization) return options
  return { ...options, headers: { ...(options.headers || {}), ...auth } }
}

export async function fetchJSON(path, options) {
  const res = await fetch(apiUrl(path), withAuth(options))
  if (res.status === 401) {
    handleUnauthorized()
  }
  if (!res.ok) {
    let detail = ''
    try {
      const body = await res.json()
      detail = body?.error ? `: ${body.error}` : ''
    } catch {}
    const err = new Error(`HTTP ${res.status}${detail}`)
    err.status = res.status
    throw err
  }
  return res.json()
}
