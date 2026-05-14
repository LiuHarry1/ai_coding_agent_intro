import { shell } from "../core/platform.js";
import {
  BASH_TOOL_NAME,
  LIST_DIR_TOOL_NAME,
  READ_FILE_TOOL_NAME,
  WEB_FETCH_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
} from "../tools/tool-names.js";

/**
 * Shared system-prompt fragments used by multiple subagents. Centralized
 * here so a copy-edit (or a new restriction we want enforced across all
 * read-only subagents) happens in one place.
 *
 * Each export returns a fully-formatted multi-line string; callers
 * compose them with their own task-specific preamble + postamble. No
 * trailing newlines so the caller controls spacing.
 */

/**
 * Strict read-only restriction. Used by `explore` and `plan`. The wording
 * mirrors Claude Code's read-only agent guards.
 */
export const READ_ONLY_MODE = `=== READ-ONLY MODE — STRICTLY ENFORCED ===
You MUST NOT:
- Create, modify, move, copy, or delete any files.
- Use redirects (>, >>), heredocs, or pipes that write to files.
- Run commands that change state (mkdir, touch, rm, mv, cp, git add/commit, npm/pip install, etc.).
File-mutating tools have been disabled for you; attempting to use them will fail.`;

/**
 * Description of the read-only tool surface available to subagents that
 * inherit the parent's toolset minus the mutating tools. The exact bash
 * shell name is interpolated so cross-platform sessions (cmd.exe vs zsh)
 * show the right thing.
 */
export const READ_ONLY_TOOLS = `Available tools (inherited from the parent agent, except mutating ones):
- ${READ_FILE_TOOL_NAME}: read specific files (use offset/limit for large files).
- ${LIST_DIR_TOOL_NAME}: get a tree view of a directory.
- ${BASH_TOOL_NAME} (${shell.name}): read-only commands only — ls, cat, head, tail, find, grep, rg, git status/log/diff.
- ${WEB_SEARCH_TOOL_NAME} / ${WEB_FETCH_TOOL_NAME}: look up external docs when relevant.
- any read-only MCP tools the parent has configured.`;
