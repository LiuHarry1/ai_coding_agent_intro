/**
 * Workspace HTTP client. Talks to the `/workspace/*` module on the server,
 * which is itself decoupled from the agent/session/MCP routes.
 *
 * Owned by the workspace IDE feature. Nothing in `agent.js` should import
 * this file, and nothing here should import from `agent.js` — the only
 * shared code is the tiny `fetchJSON` helper.
 */
import { fetchJSON } from "./_http.js";

const json = (body) => ({
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

export const workspaceApi = {
  getRoot: () => fetchJSON("/workspace"),

  listDir: (dir) => fetchJSON(`/workspace/list?dir=${encodeURIComponent(dir)}`),

  getFile: (path) => fetchJSON(`/workspace/file?path=${encodeURIComponent(path)}`),

  /** Create a new file. Fails (409) if it already exists. */
  createFile: (path, content = "") =>
    fetchJSON("/workspace/file", { method: "POST", ...json({ path, content }) }),

  /**
   * Save edits to an existing file. Pass `mtimeMs` (from a prior read) to
   * enable optimistic-concurrency: the server returns 409 if the file was
   * modified externally since then.
   */
  saveFile: (path, content, mtimeMs) =>
    fetchJSON("/workspace/file", {
      method: "PUT",
      ...json({ path, content, mtimeMs }),
    }),

  createFolder: (path) =>
    fetchJSON("/workspace/mkdir", { method: "POST", ...json({ path }) }),

  removeEntry: (path) =>
    fetchJSON(`/workspace/entry?path=${encodeURIComponent(path)}`, {
      method: "DELETE",
    }),

  // ── Git (read-only) ─────────────────────────────────────
  gitStatus: () => fetchJSON("/workspace/git/status"),
  gitDiff: (path) =>
    fetchJSON(`/workspace/git/diff?path=${encodeURIComponent(path)}`),
};
