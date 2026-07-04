import { createShellTool } from './shell-runner.js'
import { bashShell } from '../core/platform.js'
import { BASH_TOOL_NAME } from './tool-names.js'

const DESCRIPTION = `Run bash commands in the workspace shell.

Modes:
1. Run command — provide \`command\`. Blocks until completion, streams live output to the UI.
2. Background — \`background: true\`. Returns PID immediately. Use ONLY for processes that don't exit on their own (dev servers, watchers).
3. Check background — provide \`pid\` only.
4. Kill background — provide \`pid\` + \`kill: true\`.

Working directory:
- Spawned as a login shell (\`-lc\`) so your \`PATH\` / aliases / version-manager init from \`.bash_profile\` / \`.zprofile\` are picked up.
- The cwd persists across calls — \`cd subdir\` in one call affects the next call.
- Prefer absolute paths or stay in the project root rather than \`cd\`-hopping; deep \`cd\` chains make later calls hard to reason about.
- Before \`mkdir\` / \`touch\` for a new path, run \`ls\` (or use \`list_dir\`) to confirm the parent directory exists and is the one you expect.

Syntax tips:
- Chain with \`&&\` (run-if-success), \`||\` (run-if-failure), \`;\` (always run), \`|\` (pipe).
- Quote paths with spaces. Use single quotes to suppress \`$\` / backtick expansion.
- HEREDOCs work, but prefer the dedicated \`write_file\` / \`edit_file\` tools for file I/O.
- Pass \`--no-pager\` or pipe to \`cat\` for git/less commands so they don't hang on a pager.

Issuing multiple commands:
- **Independent commands → multiple bash tool calls in ONE response.** If you need \`git status\` and \`git diff\`, send them as two parallel tool calls, not one chained call.
- **Dependent commands → ONE bash call with \`&&\`** (e.g. \`cd build && cmake ..\`). Do not split into two calls — the cwd / env from the first won't carry over reliably under load.
- Use \`;\` only when later commands should run regardless of earlier failures.
- Do NOT split commands across newlines in a single call to fake parallelism. Newlines are fine inside quoted strings / HEREDOCs.

Constraints:
- Non-interactive only — no TTY. Anything that prompts will hang until timeout.
- Combined stdout+stderr capped at ~100KB; older output is truncated.
- Default timeout 120s. Pass \`timeout\` for slower commands.

Prefer dedicated tools when available — \`read_file\` over \`cat\` / \`head\` / \`tail\`, \`list_dir\` over \`ls\`, \`edit_file\` over \`sed\`, \`write_file\` over heredoc redirection. Reserve this tool for actual system operations (git, package managers, build/test runners).`

export const definition = createShellTool({
  name: BASH_TOOL_NAME,
  description: DESCRIPTION,
  commandFieldDesc: 'The bash command to execute.',
  shellConfig: bashShell,
})
