/**
 * Shared API client — centralizes all fetch calls.
 */

export async function fetchJSON(url, options) {
  const res = await fetch(url, options);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export const api = {
  getWorkspace: () => fetchJSON("/workspace"),
  listDir: (dir) => fetchJSON(`/workspace/list?dir=${encodeURIComponent(dir)}`),
  getFile: (path) => fetchJSON(`/workspace/file?path=${encodeURIComponent(path)}`),

  listSessions: () => fetchJSON("/sessions"),
  createSession: () => fetchJSON("/sessions", { method: "POST" }),
  deleteSession: (id) => fetch(`/sessions/${id}`, { method: "DELETE" }),
  getSessionMessages: (id) => fetchJSON(`/sessions/${id}/messages`),

  postChat: (body, signal) =>
    fetch("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    }),
};
