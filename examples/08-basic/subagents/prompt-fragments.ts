import { isWindows } from "../core/platform.js";
import {
  BASH_TOOL_NAME,
  GLOB_TOOL_NAME,
  GREP_TOOL_NAME,
  POWERSHELL_TOOL_NAME,
  READ_FILE_TOOL_NAME,
  WEB_FETCH_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
} from "../tools/tool-names.js";

/**
 * Shared system-prompt fragments used by multiple subagents. Centralized
 * here so a copy-edit (or a new restriction we want enforced across all
 * read-only subagents) happens in one place.
 */

/** Active shell tool name for the current platform. Subagents reference
 *  this in their prompts so the read-only guard names the right tool. */
export const SHELL_TOOL_NAME = isWindows ? POWERSHELL_TOOL_NAME : BASH_TOOL_NAME;

const SHELL_READ_ONLY_LINE = isWindows
  ? `- ${POWERSHELL_TOOL_NAME}: read-only cmdlets only (Get-ChildItem, Get-Content, Select-String, git status/log/diff). NEVER Set-Content / Out-File / Add-Content / redirects, mkdir / New-Item / Remove-Item / Move-Item / Copy-Item, git add/commit, or package installs.`
  : `- ${BASH_TOOL_NAME}: read-only commands only (ls, cat, head, tail, find, git status/log/diff). NEVER redirects (\`>\`, \`>>\`), mkdir / touch / rm / mv / cp, git add/commit, or package installs.`;

/** Strict read-only restriction. Used by `explore` and `plan`. */
export const READ_ONLY_MODE = `=== READ-ONLY MODE — STRICTLY ENFORCED ===
You MUST NOT:
- Create, modify, move, copy, or delete any files.
- Use redirects, heredocs, or pipes that write to files.
- Run commands that change state (mkdir, touch, rm, mv, cp, git add/commit, npm/pip install, etc.).
File-mutating tools have been disabled for you; attempting to use them will fail.`;

/** Read-only tool surface available to subagents that inherit the parent's
 *  toolset minus mutating tools. */
export const READ_ONLY_TOOLS = `Available tools (inherited from the parent agent, except mutating ones):
- ${GLOB_TOOL_NAME}: broad file pattern matching (e.g. "src/**/*.ts").
- ${GREP_TOOL_NAME}: regex search across file contents.
- ${READ_FILE_TOOL_NAME}: read a specific file (use offset/limit for windows into large files).
${SHELL_READ_ONLY_LINE}
- ${WEB_SEARCH_TOOL_NAME} / ${WEB_FETCH_TOOL_NAME}: look up external docs when relevant.
- any read-only MCP tools the parent has configured.`;
