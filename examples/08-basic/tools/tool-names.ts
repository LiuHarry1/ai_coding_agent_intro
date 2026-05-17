/**
 * Canonical tool names. Subagent deny-lists and any other code that
 * references tools by name should import from here so a rename of a tool
 * is a single-file change.
 *
 * Modeled after Claude Code's per-tool `*_TOOL_NAME` constants — there
 * each tool's prompt module exports its own name, then subagent
 * deny-lists compose them (see `built-in/exploreAgent.ts:67`).
 *
 * Why not just import each tool definition and read `.name`? Two
 * reasons: (1) the tool files import zod / runtime deps we don't want to
 * pull into prompt-construction paths, and (2) string literals here are
 * cheap to grep for ("what code references write_file by name?") even
 * before tooling lands to verify the constants match the definitions.
 */

export const BASH_TOOL_NAME = "bash";
export const POWERSHELL_TOOL_NAME = "powershell";
export const READ_FILE_TOOL_NAME = "read_file";
export const WRITE_FILE_TOOL_NAME = "write_file";
export const EDIT_FILE_TOOL_NAME = "edit_file";
export const LIST_DIR_TOOL_NAME = "list_dir";
export const TODO_WRITE_TOOL_NAME = "todo_write";
export const WEB_SEARCH_TOOL_NAME = "web_search";
export const WEB_FETCH_TOOL_NAME = "web_fetch";
export const GLOB_TOOL_NAME = "glob";
export const GREP_TOOL_NAME = "grep";
export const ASK_USER_QUESTION_TOOL_NAME = "ask_user_question";

/**
 * Single tool that dispatches to all built-in subagents via a
 * `subagent_type` parameter. Modeled after Claude Code's `Task` tool.
 */
export const TASK_TOOL_NAME = "task";

/**
 * Tools that mutate the filesystem or system state. Used as the deny-list
 * for read-only subagents (`explore`, `plan`). Adding a new mutating tool
 * here automatically restricts every read-only subagent from inheriting
 * it — the alternative is editing every subagent's deny-list by hand.
 *
 * `todo_write` is included even though it doesn't touch the filesystem:
 * todo state is a per-conversation construct of the parent agent, not
 * something we want a read-only fact-finding subagent to manipulate.
 */
export const MUTATING_TOOLS: readonly string[] = [
  WRITE_FILE_TOOL_NAME,
  EDIT_FILE_TOOL_NAME,
  TODO_WRITE_TOOL_NAME,
];

/**
 * Tools that require user interaction to complete. Subagents have no UI
 * channel back to the user, so these would block forever. Added to every
 * subagent deny-list alongside `MUTATING_TOOLS` for read-only agents.
 */
export const INTERACTIVE_TOOLS: readonly string[] = [
  ASK_USER_QUESTION_TOOL_NAME,
];
