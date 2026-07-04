/**
 * Slash command definition. A slash command is a markdown template that
 * gets expanded into a user message at the moment the user types
 * `/<name> <args>` in the chat input.
 *
 * Trimmed to the subset we actually need: prompt commands only (no UI
 * commands, no MCP commands). Slash commands here never become LLM tools —
 * the dispatcher just rewrites the user's message text before sending.
 */

import type { ExtensionSource } from '../utils/markdownConfigLoader.js'

export interface SlashCommand {
  /** Command name as the user types it (without the leading `/`). */
  name: string
  /** One-line summary shown in `/help` listings and autocomplete. */
  description: string
  /** Where the command was loaded from (UI display + override resolution). */
  source: 'built-in' | ExtensionSource
  /** Original file path (only set for file-loaded commands). */
  filePath?: string
  /** Optional UX hint shown in autocomplete, e.g. "[issue-number]". */
  argumentHint?: string
  /**
   * Named argument list parsed from `arguments:` frontmatter, e.g.
   * `arguments: "issue title"` → `["issue", "title"]`. Enables
   * `$issue` / `$title` substitution alongside `$1` / `$ARGUMENTS`.
   */
  argumentNames: string[]
  /**
   * Optional model override applied when the expanded message is sent.
   * Currently not wired into the runtime (Phase 2). Captured for parity
   * with common frontmatter so user files don't get rejected.
   */
  model?: string
  /** Markdown body — the prompt template with `$ARGUMENTS` / `!` / `@` syntax. */
  body: string
}
