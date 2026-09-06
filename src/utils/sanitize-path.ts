/**
 * Make an absolute path safe as a single directory name
 * (Claude Code / auto-memory / session projects bucket).
 */

const MAX_SANITIZED_LENGTH = 200

export function sanitizePath(name: string): string {
  const sanitized = name.replace(/[^a-zA-Z0-9]/g, '-')
  if (sanitized.length <= MAX_SANITIZED_LENGTH) return sanitized
  let hash = 0
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0
  }
  const h = Math.abs(hash).toString(36)
  return `${sanitized.slice(0, MAX_SANITIZED_LENGTH)}-${h}`
}
