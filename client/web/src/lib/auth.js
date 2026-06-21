/**
 * Frontend auth client for the SSO deploy mode.
 *
 * Mirrors the KnowBot SSO flow: when auth is enabled the SPA redirects to
 * the auth-service `/sso/authorize`, which bounces back with `#token=<jwt>`.
 * We stash the JWT in localStorage and attach it as a bearer token on every
 * agent API call. The agent backend verifies it and pins the workspace.
 *
 * Auth is OFF unless the runtime config says otherwise, so the password and
 * local deploy modes (and `npm run dev`) are completely unaffected.
 */

const TOKEN_KEY = "coding_agent_auth_token";

/** Runtime flag injected via /app-config.js (see deploy/web-runtime-config.sh). */
export function authEnabled() {
  return Boolean(globalThis.__APP_CONFIG__?.authEnabled);
}

export function getToken() {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token) {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* storage unavailable */
  }
}

export function clearToken() {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

/** Authorization header object (empty when no token / auth disabled). */
export function authHeader() {
  const t = authEnabled() ? getToken() : null;
  return t ? { Authorization: `Bearer ${t}` } : {};
}

/** Decode (NOT verify) a JWT payload for display purposes only. */
export function decodeToken(token = getToken()) {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
    return JSON.parse(atob(b64 + pad));
  } catch {
    return null;
  }
}

/** Best-effort current user from the token. */
export function getUser() {
  const p = decodeToken();
  if (!p) return null;
  return {
    email: p.sub || p.email || "",
    username: p.username || p.sub || "",
    role: p.role || "user",
  };
}

/** Privileged role that may list/view all users' sessions (SSO mode). */
const SUPER_ROLE = "super";

export function isSuperUser(user = getUser()) {
  return Boolean(user?.role && String(user.role).toLowerCase() === SUPER_ROLE);
}

function tokenExpired(token = getToken()) {
  const p = decodeToken(token);
  if (!p || typeof p.exp !== "number") return false;
  return Math.floor(Date.now() / 1000) >= p.exp;
}

/**
 * Parse `#token=<jwt>` left by the SSO redirect, store it, then strip the
 * fragment from the URL so it doesn't linger in history / get shared.
 */
export function consumeTokenFromUrl() {
  const hash = window.location.hash || "";
  const m = hash.match(/[#&]token=([^&]+)/);
  if (!m) return false;
  setToken(decodeURIComponent(m[1]));
  const clean = window.location.pathname + window.location.search;
  window.history.replaceState(null, "", clean);
  return true;
}

/** Send the browser to the auth-service login, returning here afterwards. */
export function redirectToLogin() {
  const returnTo = window.location.origin + window.location.pathname;
  window.location.href = `/sso/authorize?return_to=${encodeURIComponent(returnTo)}`;
}

/** Clear local token and ask the auth-service to drop the SSO cookie. */
export function logout() {
  clearToken();
  const returnTo = window.location.origin + window.location.pathname;
  window.location.href = `/sso/logout?return_to=${encodeURIComponent(returnTo)}`;
}

/**
 * Called once at boot. Returns true when the app may render; false when we
 * are redirecting to login (so main.jsx should not paint a flash of UI).
 */
export function ensureAuth() {
  if (!authEnabled()) return true;
  consumeTokenFromUrl();
  const token = getToken();
  if (!token || tokenExpired(token)) {
    clearToken();
    redirectToLogin();
    return false;
  }
  return true;
}

/** Shared 401 handler: drop the stale token and re-login. */
export function handleUnauthorized() {
  if (!authEnabled()) return;
  clearToken();
  redirectToLogin();
}
