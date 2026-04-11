import { defaultRegistry } from "./tools/index.js";
import type { ToolContext } from "./core/types.js";

export function createTools(cwd: string, context: ToolContext) {
  return defaultRegistry.createAll(cwd, context);
}
