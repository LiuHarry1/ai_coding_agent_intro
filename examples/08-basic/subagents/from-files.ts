/**
 * Parse user/project markdown agent files into `AgentDefinition`.
 *
 * Frontmatter schema (subset of Claude Code's `parseAgentFromMarkdown`):
 *
 *   ---
 *   name: db-migrator                     # required, becomes agentType
 *   description: |                        # required, becomes whenToUse
 *     Use for writing & applying SQL migrations.
 *   tools: read_file, edit_file, bash     # optional allow-list (CSV or YAML list)
 *   disallowedTools: write_file           # optional deny-list (mutually exclusive)
 *   model: claude-sonnet-4-5              # optional model override
 *   maxSteps: 25                          # optional positive int
 *   label: DB                             # optional UI label
 *   omitProjectRules: true                # optional, skip AGENTS.md injection
 *   ---
 *
 *   <body>  ← the agent's system prompt
 *
 * Body is required (we use `extractDescriptionFromMarkdown` ONLY for slash
 * commands, never for agents — an empty body would make the agent useless).
 */

import path from "path";
import type { AgentDefinition } from "../core/types.js";
import type { MarkdownFile } from "../core/markdown-config-loader.js";
import {
  parseToolList,
  parseBool,
  parsePositiveInt,
  parseString,
  parseIdentifier,
} from "../core/frontmatter-helpers.js";
import { INTERACTIVE_TOOLS, TASK_TOOL_NAME } from "../tools/tool-names.js";

export interface AgentParseResult {
  agent: AgentDefinition | null;
  /** Path the file was loaded from (always set). */
  filePath: string;
  /** Why parsing failed, if `agent` is null. Undefined ⇒ silently skipped. */
  error?: string;
}

/**
 * Convert a `MarkdownFile` into an `AgentDefinition`. Mirrors CC's
 * `parseAgentFromMarkdown` rules:
 *
 *   - Missing `name` → silently skipped (file is probably a co-located
 *     README, not an agent attempt). Returns `{ agent: null }` with no error.
 *   - Missing `description` or empty body → reported error (looks like a
 *     malformed agent).
 *   - Both `tools` AND `disallowedTools` set → reported error (CC's rule).
 *   - Subagents NEVER get the `task` tool (anti-recursion). If the file
 *     defines a deny-list we append `task`; if it defines an allow-list
 *     we drop `task` from it.
 */
export function parseAgentFromMarkdown(file: MarkdownFile): AgentParseResult {
  const fm = file.frontmatter;

  const agentType = parseIdentifier(fm.name);
  if (!agentType) {
    // Co-located doc, not a malformed agent — silent skip.
    return { agent: null, filePath: file.filePath };
  }

  const whenToUse = parseString(fm.description);
  if (!whenToUse) {
    return {
      agent: null,
      filePath: file.filePath,
      error: `agent '${agentType}': missing or empty 'description' in frontmatter`,
    };
  }

  const body = file.body.trim();
  if (!body) {
    return {
      agent: null,
      filePath: file.filePath,
      error: `agent '${agentType}': markdown body (the system prompt) is empty`,
    };
  }

  const tools = parseToolList(fm.tools);
  const disallowedRaw = parseToolList(fm.disallowedTools);

  if (tools !== undefined && disallowedRaw !== undefined) {
    return {
      agent: null,
      filePath: file.filePath,
      error: `agent '${agentType}': specify either 'tools' (allow-list) or 'disallowedTools' (deny-list), not both`,
    };
  }

  // Anti-recursion: subagents never inherit `task`.
  let allowedTools = tools;
  if (allowedTools) {
    allowedTools = allowedTools.filter((t) => t !== TASK_TOOL_NAME);
  }
  // Default deny-list mirrors built-in subagents: interactive tools + task.
  const disallowed = disallowedRaw
    ? Array.from(new Set([...disallowedRaw, TASK_TOOL_NAME]))
    : [...INTERACTIVE_TOOLS, TASK_TOOL_NAME];

  const filename = path.basename(file.filePath, ".md");

  const agent: AgentDefinition = {
    agentType,
    whenToUse,
    description: parseString(fm.label) ?? `Custom agent (${filename})`,
    systemPrompt: body,
    ...(allowedTools !== undefined ? { tools: allowedTools } : {}),
    ...(allowedTools === undefined ? { disallowedTools: disallowed } : {}),
    ...(parsePositiveInt(fm.maxSteps) !== undefined
      ? { maxSteps: parsePositiveInt(fm.maxSteps) }
      : {}),
    ...(parseString(fm.model) !== undefined ? { model: parseString(fm.model) } : {}),
    ...(parseString(fm.label) !== undefined ? { label: parseString(fm.label) } : {}),
    ...(parseBool(fm.omitProjectRules) === true ? { omitProjectRules: true } : {}),
  };

  return { agent, filePath: file.filePath };
}

/**
 * Merge built-in agents with file-loaded ones.
 *
 * Priority (later overrides earlier, matching CC's `getActiveAgentsFromList`):
 *
 *   built-in < user < project
 *
 * The returned array preserves built-in order at the front, then loaded
 * agents in the order they appeared (project-first within `files`). The
 * `task` tool's description renders this list in order, so put higher-priority
 * agents later only if you WANT them at the bottom of the directory.
 */
export function mergeAgents(
  builtins: readonly AgentDefinition[],
  files: readonly MarkdownFile[],
): { agents: AgentDefinition[]; errors: Array<{ filePath: string; error: string }> } {
  const errors: Array<{ filePath: string; error: string }> = [];
  const byType = new Map<string, AgentDefinition>();

  for (const b of builtins) byType.set(b.agentType, b);

  // Sort so user comes before project — Map's last write wins ⇒ project takes
  // precedence over user, both override built-ins.
  const ordered = [...files].sort((a, b) => {
    const rank = (s: typeof a.source) => (s === "user" ? 0 : 1);
    return rank(a.source) - rank(b.source);
  });

  for (const f of ordered) {
    const { agent, error, filePath } = parseAgentFromMarkdown(f);
    if (error) {
      errors.push({ filePath, error });
      console.warn(`[agents] ${error} (${filePath})`);
    }
    if (agent) {
      if (byType.has(agent.agentType)) {
        console.log(`[agents] overriding '${agent.agentType}' from ${f.filePath}`);
      }
      byType.set(agent.agentType, agent);
    }
  }

  return { agents: [...byType.values()], errors };
}
