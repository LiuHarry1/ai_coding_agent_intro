/**
 * Coding-agent HTTP client. Sessions, chat streaming, and any future
 * settings/MCP endpoints live here. Independent of the workspace module.
 */
import { fetchJSON, withAuth, apiUrl } from './_http.js'

export const agentApi = {
  listSessions: () => fetchJSON('/sessions'),
  createSession: () => fetchJSON('/sessions', { method: 'POST' }),
  deleteSession: id =>
    fetch(apiUrl(`/sessions/${id}`), withAuth({ method: 'DELETE' })),
  getSessionMessages: id => fetchJSON(`/sessions/${id}/messages`),
  listSessionTasks: id => fetchJSON(`/sessions/${id}/tasks`),
  stopSessionTask: (sessionId, taskId) =>
    fetchJSON(`/sessions/${sessionId}/tasks/${taskId}/stop`, {
      method: 'POST',
    }),

  getSlashCommands: workspace => {
    const qs = workspace ? `?workspace=${encodeURIComponent(workspace)}` : ''
    return fetchJSON(`/slash-commands${qs}`)
  },

  getAgents: workspace => {
    const qs = workspace ? `?workspace=${encodeURIComponent(workspace)}` : ''
    return fetchJSON(`/agents${qs}`)
  },

  getSkills: workspace => {
    const qs = workspace ? `?workspace=${encodeURIComponent(workspace)}` : ''
    return fetchJSON(`/skills${qs}`)
  },

  getPlugins: workspace => {
    const qs = workspace ? `?workspace=${encodeURIComponent(workspace)}` : ''
    return fetchJSON(`/plugins${qs}`)
  },

  /** MCP server statuses + their tool lists for the workspace. */
  getMcp: workspace => {
    const qs = workspace ? `?workspace=${encodeURIComponent(workspace)}` : ''
    return fetchJSON(`/mcp${qs}`)
  },

  /** Configured / running LSP servers for the workspace. */
  getLsp: workspace => {
    const qs = workspace ? `?workspace=${encodeURIComponent(workspace)}` : ''
    return fetchJSON(`/lsp${qs}`)
  },

  postChat: (body, signal) =>
    fetch(
      apiUrl('/chat'),
      withAuth({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      }),
    ),

  streamSessionLive: (sessionId, signal) =>
    fetch(
      apiUrl(`/sessions/${encodeURIComponent(sessionId)}/live`),
      withAuth({ signal }),
    ),

  /**
   * Upload composer images before /chat (OpenClaw claim-check).
   * Creates a session when sessionId is null. Returns durable /sessions/.../uploads URLs.
   * @param {string|null} sessionId
   * @param {File[]} files
   * @returns {Promise<{ session_id: string, urls: string[] }>}
   */
  uploadChatImages: (sessionId, files) => {
    const form = new FormData()
    for (const f of files) form.append('file', f)
    const qs = sessionId
      ? `?session_id=${encodeURIComponent(sessionId)}`
      : ''
    return fetchJSON(`/chat/uploads${qs}`, {
      method: 'POST',
      body: form,
    })
  },

  answerQuestion: body =>
    fetchJSON('/ask_user_question/answer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),

  answerCanUseTool: body =>
    fetchJSON('/can_use_tool/answer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),

  approvePlan: body =>
    fetchJSON('/plan/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),

  setSessionMode: body =>
    fetchJSON('/session/mode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),

  setSessionAgent: body =>
    fetchJSON('/session/agent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),

  /** Abort a single in-flight tool (e.g. Explore subagent) by tool_use_id. */
  abortTool: body =>
    fetchJSON('/tool/abort', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),

  /** Stop the in-flight chat turn; SSE stays open until the server ends it. */
  cancelChat: sessionId =>
    fetchJSON('/chat/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId }),
    }),

  getScheduledTasks: (sessionId, workspace) => {
    const params = new URLSearchParams()
    if (sessionId) params.set('session_id', sessionId)
    if (workspace) params.set('workspace', workspace)
    const qs = params.toString()
    return fetchJSON(`/scheduled-tasks${qs ? `?${qs}` : ''}`)
  },
  createScheduledTask: body =>
    fetchJSON('/scheduled-tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  deleteScheduledTask: (id, sessionId, workspace) => {
    const params = new URLSearchParams({ session_id: sessionId })
    if (workspace) params.set('workspace', workspace)
    return fetchJSON(`/scheduled-tasks/${encodeURIComponent(id)}?${params}`, {
      method: 'DELETE',
    })
  },

  getBrowserLock: sessionId =>
    fetchJSON(
      sessionId
        ? `/browser/lock?session_id=${encodeURIComponent(sessionId)}`
        : '/browser/lock',
    ),
  setBrowserLock: (userHasControl, sessionId) =>
    fetchJSON('/browser/lock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userHasControl,
        ...(sessionId ? { session_id: sessionId } : {}),
      }),
    }),
}
