import path from "path";
import type { AgentDefinition } from "../../core/types.js";
import type { MarkdownFile } from "../../utils/markdownConfigLoader.js";
import {
  parseToolList,
  parseBool,
  parsePositiveInt,
  parseString,
  parseIdentifier,
} from "../../utils/frontmatterParser.js";
import { AGENT_TOOL_NAME, INTERACTIVE_TOOLS } from "../../constants/tool_names.js";

export interface AgentParseResult {
  agent: AgentDefinition | null;
  filePath: string;
  error?: string;
}

export function parseAgentFromMarkdown(file: MarkdownFile): AgentParseResult {
  const fm = file.frontmatter;

  const agentType = parseIdentifier(fm.name);
  if (!agentType) {
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

  let allowedTools = tools;
  if (allowedTools) {
    allowedTools = allowedTools.filter((t) => t !== AGENT_TOOL_NAME);
  }
  const disallowed = disallowedRaw
    ? Array.from(new Set([...disallowedRaw, AGENT_TOOL_NAME]))
    : [...INTERACTIVE_TOOLS, AGENT_TOOL_NAME];

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

export function mergeAgents(
  builtins: readonly AgentDefinition[],
  files: readonly MarkdownFile[],
): { agents: AgentDefinition[]; errors: Array<{ filePath: string; error: string }> } {
  const errors: Array<{ filePath: string; error: string }> = [];
  const byType = new Map<string, AgentDefinition>();

  for (const b of builtins) byType.set(b.agentType, b);

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
