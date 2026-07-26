import { getAppDirName } from '../../utils/app-dir.js'

/** Dot entries always listed without enabling full hidden-file mode. */
function isAlwaysVisibleDotEntry(name: string): boolean {
  if (name === getAppDirName()) return true
  // Skill/runtime config — users edit these from the IDE file tree.
  if (name === '.env' || name.startsWith('.env.')) return true
  return false
}

/**
 * Whether a directory entry should appear in the workspace file tree.
 *
 * - Normal files/folders: always shown.
 * - `.ai-agent` (or `AI_AGENT_DIR`): always shown so skills/agents/MCP
 *   can be edited from the IDE without enabling full hidden-file mode.
 * - `.env` / `.env.*`: always shown (skill credentials, templates).
 * - Other dot entries: only when `showHidden` is true.
 */
export function shouldListDirEntry(name: string, showHidden: boolean): boolean {
  if (name === '.' || name === '..') return false
  if (!name.startsWith('.')) return true
  if (isAlwaysVisibleDotEntry(name)) return true
  return showHidden
}
