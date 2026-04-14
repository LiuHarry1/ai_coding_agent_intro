import { tool } from "ai";
import { z } from "zod";
import type { SubagentConfig, ToolDefinition, ToolContext } from "../core/types.js";

export function createSubagentDefinition(config: SubagentConfig): ToolDefinition {
  const {
    name,
    description,
    systemPrompt,
    tools: toolNames,
    maxSteps = 20,
    label,
  } = config;

  return {
    name,
    description: `Subagent: ${description}`,
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

          const subTools = registry
            ? registry.createAll(cwd, { eventBus: subBus }, toolNames)
            : {};

          const result = await runAgent!(task, {
            tools: subTools,
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
