import { tool } from "ai";
import { z } from "zod";
import { filterToolsByEnablement } from "../core/tool-enablement.js";
import type { AnyTool, SubagentConfig, ToolDefinition, ToolContext } from "../core/types.js";

export function createSubagentDefinition(config: SubagentConfig): ToolDefinition {
  const {
    name,
    description,
    systemPrompt,
    tools: toolNames,
    disallowedTools,
    maxSteps = 20,
    label,
  } = config;

  if (toolNames && disallowedTools) {
    throw new Error(
      `Subagent '${name}': specify either 'tools' (allow-list) or 'disallowedTools' (deny-list), not both.`,
    );
  }
  const denySet = new Set(disallowedTools ?? []);

  return {
    name,
    description: `Subagent: ${description}`,
    isSubagent: true,
    create(cwd: string, context: ToolContext) {
      const { runAgent, eventBus } = context;
      const registry = context.registry;

      return tool({
        description,
        inputSchema: z.object({
          task: z.string().describe("What to explore or analyze"),
        }),
        execute: async ({ task }: { task: string }) => {
          const subBus = eventBus.scoped(`subagent_${name}`);

          subBus.emit("step_start", {
            step: 0,
            task: task.slice(0, 80),
            label: label || `${name} subagent`,
          });

          const localTools = registry
            ? registry.createAll(cwd, {
              eventBus: subBus,
              registry,
              toolEnablement: context.toolEnablement,
            }, toolNames)
            : {};

          const subTools: Record<string, AnyTool> = { ...localTools };
          const mcp = context.mcpTools;
          if (mcp) {
            if (toolNames) {
              // Allow-list: only pull explicitly-listed MCP tools.
              for (const n of toolNames) {
                const t = mcp[n];
                if (t) subTools[n] = t;
              }
            } else {
              // Deny-list / inherit-all: include every MCP tool by default.
              for (const [n, t] of Object.entries(mcp)) {
                subTools[n] = t;
              }
            }
          }

          for (const denied of denySet) {
            delete subTools[denied];
          }

          // Anti-recursion: a subagent never sees other subagents (or itself)
          // as tools, regardless of allow/deny lists. Mirrors Claude Code's
          // explicit AGENT_TOOL_NAME deny.
          if (registry) {
            for (const n of Object.keys(subTools)) {
              const def = registry.get(n);
              if (def?.isSubagent) delete subTools[n];
            }
          }

          const filteredSubTools = registry
            ? filterToolsByEnablement(subTools, registry, context.toolEnablement)
            : subTools;

          const result = await runAgent!(task, {
            tools: filteredSubTools,
            systemPrompt,
            eventBus: subBus,
            messages: [],
            maxSteps,
          });

          return result || `(${name} subagent returned no result)`;
        },
      });
    },
  };
}
