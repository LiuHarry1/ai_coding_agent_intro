/**
 * Shared low-level fetch helper. Lives below both feature modules; neither
 * `agent.js` nor `workspace.js` imports the other, but both import this.
 */
export async function fetchJSON(url, options) {
  const res = await fetch(url, options);
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
