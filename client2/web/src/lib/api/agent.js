/**
 * Coding-agent HTTP client. Sessions, chat streaming, and any future
 * settings/MCP endpoints live here. Independent of the workspace module.
 */
import { fetchJSON } from "./_http.js";

export const agentApi = {
  listSessions: () => fetchJSON("/sessions"),
  createSession: () => fetchJSON("/sessions", { method: "POST" }),
  deleteSession: (id) => fetch(`/sessions/${id}`, { method: "DELETE" }),
  getSessionMessages: (id) => fetchJSON(`/sessions/${id}/messages`),

  getSlashCommands: (workspace) => {
    const qs = workspace ? `?workspace=${encodeURIComponent(workspace)}` : "";
    return fetchJSON(`/slash-commands${qs}`);
  },

  postChat: (body, signal) =>
    fetch("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    }),
};
