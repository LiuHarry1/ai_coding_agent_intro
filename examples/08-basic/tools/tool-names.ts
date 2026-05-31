/**
 * Canonical tool names. Subagent deny-lists and any other code that
 * references tools by name should import from here so a rename of a tool
 * is a single-file change.
 *
 * Names follow Claude Code (claude-code-rev) where a matching tool exists.
 * Why not just import each tool definition and read `.name`? Two
 * reasons: (1) the tool files import zod / runtime deps we don't want to
 * pull into prompt-construction paths, and (2) string literals here are
 * cheap to grep for ("what code references Read by name?") even
 * before tooling lands to verify the constants match the definitions.
 */

export const BASH_TOOL_NAME = "Bash";
export const POWERSHELL_TOOL_NAME = "PowerShell";
export const READ_FILE_TOOL_NAME = "Read";
export const WRITE_FILE_TOOL_NAME = "Write";
export const EDIT_FILE_TOOL_NAME = "Edit";
/** No Claude Code equivalent — project-specific directory tree listing. */
export const LIST_DIR_TOOL_NAME = "list_dir";
export const TODO_WRITE_TOOL_NAME = "TodoWrite";
export const WEB_SEARCH_TOOL_NAME = "WebSearch";
export const WEB_FETCH_TOOL_NAME = "WebFetch";
export const GLOB_TOOL_NAME = "Glob";
export const GREP_TOOL_NAME = "Grep";
export const ASK_USER_QUESTION_TOOL_NAME = "AskUserQuestion";
/** Not `tool_search` — OpenAI Responses treats that as native `tool_search_call`. */
export const TOOL_SEARCH_TOOL_NAME = "ToolSearch";
export const SKILL_TOOL_NAME = "Skill";

/**
 * Single tool that dispatches to all built-in subagents via `subagent_type`.
 */
export const AGENT_TOOL_NAME = "Agent";

/** @deprecated Use {@link AGENT_TOOL_NAME}. Kept so older docs/configs mentioning `task` are easy to grep. */
export const TASK_TOOL_NAME = AGENT_TOOL_NAME;

/**
 * Tools that mutate the filesystem or system state. Used as the deny-list
 * for read-only subagents (`explore`, `plan`). Adding a new mutating tool
 * here automatically restricts every read-only subagent from inheriting
 * it — the alternative is editing every subagent's deny-list by hand.
 *
 * `TodoWrite` is included even though it doesn't touch the filesystem:
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
