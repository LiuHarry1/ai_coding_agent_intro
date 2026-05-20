import { isWindows } from "./platform.js";
import { BASH_TOOL_NAME } from "../tools/tool-names.js";

/**
 * Claude Code exposes PowerShellTool on Windows (no env gate for internal builds).
 * We mirror that with a single rule: Windows → both shell tools; Unix → bash only.
 */
export function isPowerShellToolEnabled(): boolean {
  return isWindows;
}

/** CC default: bash on every platform, including Windows (via Git Bash). */
export const DEFAULT_SHELL_TOOL_NAME = BASH_TOOL_NAME;
