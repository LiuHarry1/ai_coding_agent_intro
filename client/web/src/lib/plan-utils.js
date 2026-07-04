import { WRITE, EDIT } from './tool-names.js'

/** Plan files live under `.ai-agent/plans/{slug}.md`. */
export function isPlanFilePath(filePath) {
  if (!filePath) return false
  const norm = String(filePath).replace(/\\/g, '/')
  return /\.ai-agent\/plans\/[^/]+\.md$/i.test(norm)
}

export function isPlanFileWrite(item) {
  if (!item || item.type !== 'tool_call') return false
  if (item.name !== WRITE && item.name !== EDIT) return false
  return isPlanFilePath(item.args?.file_path)
}

/** Show a short relative path in the UI instead of a full absolute path. */
export function formatPlanDisplayPath(filePath) {
  if (!filePath) return ''
  const norm = String(filePath).replace(/\\/g, '/')
  const marker = '.ai-agent/plans/'
  const idx = norm.indexOf(marker)
  if (idx >= 0) return norm.slice(idx)
  const parts = norm.split('/')
  return parts[parts.length - 1] ?? norm
}
