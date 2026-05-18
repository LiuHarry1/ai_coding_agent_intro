/**
 * Skill definition. A skill is a markdown template the MODEL invokes
 * (via the `skill` dispatcher tool) when it needs a reusable procedure
 * — code review checklist, PR-author template, debug protocol, etc.
 *
 * Two execution modes (CC convention):
 *
 *   "inline" (default): the body — after `$ARGUMENTS` / `!` / `@` expansion
 *                       — is returned as the tool result. The main agent
 *                       reads it on the next turn as if it had remembered
 *                       a procedure mid-thought.
 *
 *   "fork":            the body becomes the system prompt of a fresh
 *                      subagent (typically `general_purpose`). Useful when
 *                      the skill needs many tool calls — keeps the main
 *                      agent's context clean.
 */

import type { ExtensionSource } from "../core/markdown-config-loader.js";

export type SkillContextMode = "inline" | "fork";

export interface SkillDefinition {
  /** Name as the model invokes it via the `skill` tool. */
  name: string;
  /** One-line "when to use" rendered into the skill tool's directory. */
  description: string;
  /** Where the file was discovered. */
  source: "built-in" | ExtensionSource;
  /** Original file path (file-loaded skills only). */
  filePath?: string;
  /**
   * "inline" — expand body, return as tool result.
   * "fork"   — run as a subagent with body as system prompt.
   */
  context: SkillContextMode;
  /**
   * When `context === "fork"`, which subagent_type to dispatch to.
   * Defaults to "general_purpose" if omitted.
   */
  agent?: string;
  /** Named arg list for `$name` substitution (mirrors slash commands). */
  argumentNames: string[];
  /** Markdown body — template with `$ARGUMENTS` / `!`-block / `@file` syntax. */
  body: string;
}
