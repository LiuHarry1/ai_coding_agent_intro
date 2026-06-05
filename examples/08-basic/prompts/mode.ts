import type { ExternalMode } from "../core/permission-mode.js";
import { systemPrompt } from "./system.js";
import { askSystemPrompt } from "./ask.js";
import { planSystemPrompt } from "./plan.js";

export interface SystemPromptOptions {
  planFilePath?: string;
  planExists?: boolean;
}

export function getSystemPromptForMode(
  mode: ExternalMode,
  cwd: string,
  projectRules?: string,
  options: SystemPromptOptions = {},
): string {
  switch (mode) {
    case "ask":
      return askSystemPrompt(cwd, projectRules);
    case "plan":
      return planSystemPrompt(cwd, projectRules, {
        planFilePath: options.planFilePath ?? ".ai-agent/plans/plan.md",
        planExists: options.planExists ?? false,
      });
    default:
      return systemPrompt(cwd, projectRules);
  }
}
