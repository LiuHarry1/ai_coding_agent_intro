import { getAppDirName } from "../../core/app-dir.js";

/**
 * Whether a directory entry should appear in the workspace file tree.
 *
 * - Normal files/folders: always shown.
 * - `.ai-agent` (or `AI_AGENT_DIR`): always shown so skills/agents/MCP
 *   can be edited from the IDE without enabling full hidden-file mode.
 * - Other dot entries: only when `showHidden` is true.
 */
export function shouldListDirEntry(name: string, showHidden: boolean): boolean {
  if (name === "." || name === "..") return false;
  if (!name.startsWith(".")) return true;
  if (name === getAppDirName()) return true;
  return showHidden;
}
