import type { ToolDefinition, ToolContext, IToolRegistry, AnyTool } from "./types.js";
import { computeToolEnabled } from "./tool-enablement.js";

export class ToolRegistry implements IToolRegistry {
  #tools = new Map<string, ToolDefinition>();

  register(def: ToolDefinition): void {
    this.#tools.set(def.name, def);
  }

  get(name: string): ToolDefinition | undefined {
    return this.#tools.get(name);
  }

  list(): Array<{ name: string; description: string }> {
    return [...this.#tools.values()].map((d) => ({
      name: d.name,
      description: d.description,
    }));
  }

  createAll(
    cwd: string,
    context: ToolContext,
    only?: string[]
  ): Record<string, AnyTool> {
    const tools: Record<string, AnyTool> = {};
    for (const [name, def] of this.#tools) {
      if (only && !only.includes(name)) continue;
      if (!computeToolEnabled(name, def, context.toolEnablement)) continue;

      const instance = def.create(cwd, context);
      if (context.middleware && typeof (instance as any).execute === "function") {
        const wrapped = context.middleware.wrap(name, (instance as any).execute);
        tools[name] = { ...instance, execute: wrapped } as AnyTool;
      } else {
        tools[name] = instance;
      }
    }
    return tools;
  }
}

export const defaultRegistry = new ToolRegistry();
