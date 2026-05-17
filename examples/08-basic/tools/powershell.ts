import { createShellTool } from "./shell-runner.js";
import { powershellShell } from "../core/platform.js";
import { POWERSHELL_TOOL_NAME } from "./tool-names.js";
import { detectPowerShellEdition, type PowerShellEdition } from "../core/powershell-edition.js";

/**
 * Edition-specific syntax guidance. Without this branch the model either
 * (a) emits PS 7+ idioms (`&&`, `??`) on a 5.1 host → parser error / exit 1,
 * or (b) needlessly avoids them on a 7+ host. Mirrors Claude Code's
 * `getEditionSection` in `PowerShellTool/prompt.ts`.
 */
function getEditionSection(edition: PowerShellEdition): string {
  if (edition === "desktop") {
    return `PowerShell edition: Windows PowerShell 5.1 (powershell.exe)
- Pipeline chain operators \`&&\` and \`||\` are NOT available — they cause a parser error. To run B only if A succeeds: \`A; if ($?) { B }\`. To chain unconditionally: \`A; B\`.
- Ternary (\`?:\`), null-coalescing (\`??\`), and null-conditional (\`?.\`) operators are NOT available. Use \`if/else\` and explicit \`$null -eq\` checks instead.
- Avoid \`2>&1\` on native executables. In 5.1, redirecting a native command's stderr inside PowerShell wraps each line in a NativeCommandError ErrorRecord and sets \`$?\` to \`$false\` even when the exe returned exit code 0. stderr is already captured for you — don't redirect it.
- Default file encoding is UTF-16 LE with BOM. When writing files other tools will read, pass \`-Encoding utf8\` to \`Out-File\` / \`Set-Content\`.
- \`ConvertFrom-Json\` returns a PSCustomObject, not a hashtable. \`-AsHashtable\` is not available.`;
  }
  if (edition === "core") {
    return `PowerShell edition: PowerShell 7+ (pwsh)
- Pipeline chain operators \`&&\` and \`||\` ARE available and work like bash. Prefer \`A && B\` over \`A; B\` when B should only run if A succeeds.
- Ternary (\`$cond ? $a : $b\`), null-coalescing (\`??\`), and null-conditional (\`?.\`) operators are available.
- Default file encoding is UTF-8 without BOM.`;
  }
  // Detection failed (PS not installed?) or running on non-Windows test env.
  // Give the conservative 5.1-safe guidance — works on either edition.
  return `PowerShell edition: unknown — assume Windows PowerShell 5.1 for compatibility
- Do NOT use \`&&\`, \`||\`, ternary \`?:\`, null-coalescing \`??\`, or null-conditional \`?.\`. These are PowerShell 7+ only and parser-error on 5.1.
- To chain commands conditionally: \`A; if ($?) { B }\`. Unconditionally: \`A; B\`.`;
}

const DESCRIPTION = `Run PowerShell commands in the workspace shell. Working directory persists between calls; shell state (variables, functions) does not.

${getEditionSection(detectPowerShellEdition())}

Modes:
1. Run command — provide \`command\`. Blocks until completion, streams live output to the UI.
2. Background — \`background: true\`. Returns PID immediately. Use ONLY for processes that don't exit on their own (dev servers, watchers).
3. Check background — provide \`pid\` only.
4. Kill background — provide \`pid\` + \`kill: true\`.

Working directory:
- The cwd persists across calls — \`Set-Location subdir\` (or \`cd\`) in one call affects the next.
- Before \`New-Item\` / \`mkdir\` for a new path, verify the parent exists with \`Get-ChildItem\` on that single directory.

PowerShell syntax notes:
- Variables use \`$\` prefix: \`$myVar = "value"\`. Escape character is backtick \`\`\`\` \`\`\`\` (NOT backslash).
- Cmdlet naming is Verb-Noun: \`Get-ChildItem\`, \`Set-Location\`, \`New-Item\`, \`Remove-Item\`. Aliases (\`ls\`, \`cd\`, \`cat\`, \`rm\`) work but full names are more reliable in scripts.
- The pipe \`|\` passes objects, not text. Use \`Select-Object\` / \`Where-Object\` / \`ForEach-Object\` for filtering / transformation; pipe to \`Out-String\` if a downstream tool needs flat text.
- String interpolation: \`"Hello $name"\` or \`"Result: $($obj.Property)"\`. Single quotes are literal — no expansion.
- Environment variables: read with \`$env:NAME\`, set with \`$env:NAME = "value"\`. Do NOT use bash \`export\`.
- Registry paths use PSDrive prefixes: \`HKLM:\\SOFTWARE\\...\`, \`HKCU:\\...\` — NOT raw \`HKEY_LOCAL_MACHINE\\...\`.
- Native exe with spaces in path: use the call operator — \`& "C:\\Program Files\\App\\app.exe" arg1 arg2\`.

Multiline strings (commit messages, file content) into native executables:
- Use a single-quoted here-string so PowerShell does not expand \`$\` or backticks. The closing \`'@\` MUST be at column 0 (no leading whitespace) on its own line — indenting it is a parse error:
  \`\`\`
  git commit -m @'
  Commit message here.
  Second line with $literal dollar signs.
  '@
  \`\`\`
- Use \`@'...'@\` (literal) over \`@"..."@\` (interpolated) unless you need variable expansion.
- For arguments PS would parse as operators (\`-\`, \`@\`, etc.), use the stop-parsing token: \`git log --% --format=%H\`.

Interactive cmdlets / commands that will hang (this tool runs with \`-NonInteractive\`):
- NEVER use \`Read-Host\`, \`Get-Credential\`, \`Out-GridView\`, \`$Host.UI.PromptForChoice\`, or \`pause\`.
- Destructive cmdlets (\`Remove-Item\`, \`Stop-Process\`, \`Clear-Content\`) may prompt. Add \`-Confirm:$false\` when you intend to proceed; \`-Force\` for read-only / hidden items.
- Never run \`git rebase -i\`, \`git add -i\`, or anything that opens an interactive editor.

Issuing multiple commands:
- **Independent commands → multiple powershell tool calls in ONE response** (parallel).
- **Dependent commands → ONE powershell call**, chained per the edition syntax above.
- Use \`;\` only when later commands should run regardless of earlier failure.
- Do NOT split commands across newlines in a single call to fake parallelism. Newlines are fine inside quoted strings / here-strings.

Constraints:
- Non-interactive only — no TTY. Prompts will hang until timeout.
- Combined stdout+stderr capped at ~100KB; older output is truncated.
- Default timeout 120s. Pass \`timeout\` for slower commands.

Prefer dedicated tools — \`read_file\` over \`Get-Content\`, \`glob\` over \`Get-ChildItem -Recurse\`, \`grep\` (the tool) over \`Select-String\`, \`edit_file\` for surgical edits, \`write_file\` for new files. Reserve this tool for actual system operations (git, npm/pnpm, build/test runners).`;

export const definition = createShellTool({
  name: POWERSHELL_TOOL_NAME,
  description: DESCRIPTION,
  commandFieldDesc: "The PowerShell command to execute.",
  shellConfig: powershellShell,
});
