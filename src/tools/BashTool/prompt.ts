import { isWindows } from '../../core/platform.js'
import {
  TASK_OUTPUT_TOOL_NAME,
  TASK_STOP_TOOL_NAME,
} from '../../constants/tool_names.js'

const windowsNote = isWindows
  ? `
On Windows this tool runs Git Bash (not cmd.exe). Install Git for Windows or set BAIX_GIT_BASH_PATH if spawn fails. Prefer the PowerShell tool for native Windows cmdlets. Shell env (\`conda activate\`) does not persist across calls — chain in one command.
`
  : ''

export const DESCRIPTION = `Run bash commands in the workspace shell.${windowsNote}

Modes:
1. Run command — provide \`command\`. Blocks until completion, streams live output to the UI.
2. Background — \`run_in_background: true\`. Only use this if you don't need the result immediately and are OK being notified when the command completes later. You do not need to check the output right away — you'll be notified when it finishes (\`<task-notification>\`). You do not need to use \`&\` at the end of the command. Prefer Read on the output-file path from the tool result (session task files are readable even outside the project cwd). For a non-blocking peek while still running, use ${TASK_OUTPUT_TOOL_NAME} with \`block: false\`. If waiting for a background task you started with \`run_in_background\`, you will be notified when it completes — do not poll. Long-lived processes (dev servers, watchers) never exit: after backgrounding, optionally Read/\`${TASK_OUTPUT_TOOL_NAME}\`(\`block: false\`) once to confirm startup, then reply to the user — do not use \`${TASK_OUTPUT_TOOL_NAME}\` with \`block: true\` on them; use ${TASK_STOP_TOOL_NAME} only when asked to stop.

Working directory:
- On Unix, the shell binary is \`$SHELL\` when it is bash/zsh/sh (else \`/bin/bash\`), spawned as a login shell (\`-lc\`) so \`PATH\` / aliases / version-manager init from profile scripts are picked up. On Windows (Git Bash), non-login \`-c\` + inherited process env (see Windows note above).
- The cwd persists across calls — \`cd subdir\` in one call affects the next call. Shell variables / \`conda activate\` do **not** persist across calls — chain them in one command (\`conda activate python3_11 && python …\`).
- Prefer absolute paths or stay in the project root rather than \`cd\`-hopping; deep \`cd\` chains make later calls hard to reason about.
- Before \`mkdir\` / \`touch\` for a new path, run \`ls\` on the parent directory to confirm it exists and is the one you expect.

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
- Combined stdout+stderr for foreground is capped; large background output is written to the task output file.
- Default timeout 120s for foreground. Pass \`timeout\` for slower commands. Ignored when \`run_in_background\` is true.

Workspace boundary:
- Prefer dedicated tools (\`read_file\`, \`grep\`, \`glob\`, \`write_file\`, \`edit_file\`) for file I/O — they enforce the workspace boundary.
- When SANDBOX_MODE=strict (SSO multi-tenant), do NOT list, read, or modify paths outside the current working directory (including sibling user workspaces). Stay inside the project root.
- When sandbox is off (local/admin), read-only commands (\`ls\`, \`cat\`, \`grep\`, \`git log\`, etc.) MAY target paths outside the workspace for system config or sibling projects; file mutations still belong to \`write_file\` / \`edit_file\`.
- Don't use bash redirections (\`>\`, \`>>\`, \`tee\`) or \`rm\` / \`mv\` / \`cp\` to write OUTSIDE the workspace — that's the user's filesystem, not yours.

IMPORTANT: Avoid using this tool to run \`find\`, \`grep\`, \`cat\`, \`head\`, \`tail\`, \`sed\`, \`awk\`, or \`echo\` unless explicitly instructed or after you have verified that a dedicated tool cannot accomplish your task. Prefer the dedicated tools instead:
- File search: Use \`glob\` (NOT find or ls)
- Content search: Use \`grep\` (the tool) (NOT grep or rg)
- Read files: Use \`read_file\` (NOT cat/head/tail)
- Edit files: Use \`edit_file\` (NOT sed/awk)
- Write files: Use \`write_file\` (NOT echo >/cat <<EOF)

Reserve this tool for system commands and terminal operations (git, package managers, build/test runners) and read-only directory checks (\`ls\`, \`git status\`, etc.).`
