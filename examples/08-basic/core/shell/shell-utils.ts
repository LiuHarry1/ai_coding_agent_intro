import { isWindows } from '../platform.js'
import { BASH_TOOL_NAME } from '../../constants/tool_names.js'

/**
 * Windows → both shell tools; Unix → bash only.
 */
export function isPowerShellToolEnabled(): boolean {
  return isWindows
}

/** Default: bash on every platform, including Windows (via Git Bash). */
export const DEFAULT_SHELL_TOOL_NAME = BASH_TOOL_NAME
