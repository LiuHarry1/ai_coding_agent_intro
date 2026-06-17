/**
 * Shared low-level fetch helper. Lives below both feature modules; neither
 * `agent.js` nor `workspace.js` imports the other, but both import this.
 *
 * When auth is enabled it injects the bearer token on every request and, on
 * a 401, clears the stale token and bounces to the SSO login.
 */
import { authHeader, handleUnauthorized } from "../auth.js";

/** Merge the auth header into a fetch init's headers (auth-off → no-op). */
export function withAuth(options = {}) {
  const auth = authHeader();
  if (!auth.Authorization) return options;
  return { ...options, headers: { ...(options.headers || {}), ...auth } };
}

export async function fetchJSON(url, options) {
  const res = await fetch(url, withAuth(options));
  if (res.status === 401) {
    handleUnauthorized();
  }
  if (!res.ok) {
    let detail = "";
    try {
      const body = await res.json();
      detail = body?.error ? `: ${body.error}` : "";
    } catch {}
    const err = new Error(`HTTP ${res.status}${detail}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}
