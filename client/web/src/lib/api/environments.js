import { fetchJSON } from './_http.js'

export const environmentsApi = {
  list: () => fetchJSON('/environments'),

  resolve: input =>
    fetchJSON('/environments/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input }),
    }),

  connect: (environmentId, preferredCwd) =>
    fetchJSON('/environments/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ environmentId, preferredCwd }),
    }),

  listDir: (environmentId, dirPath) => {
    const q = new URLSearchParams({ environmentId })
    if (dirPath) q.set('path', dirPath)
    return fetchJSON(`/environments/fs/list?${q}`)
  },

  getFile: (environmentId, filePath) => {
    const q = new URLSearchParams({ environmentId, path: filePath })
    return fetchJSON(`/environments/fs/file?${q}`)
  },

  bindSessionWorkspace: (sessionId, workspace) =>
    fetchJSON(`/sessions/${sessionId}/workspace`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(workspace),
    }),
}
