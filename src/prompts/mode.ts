import type { ExternalMode } from '../core/permission-mode.js'
import { systemPrompt } from './system.js'
import { askSystemPrompt } from './ask.js'
import { planSystemPrompt } from './plan.js'

export interface SystemPromptOptions {
  planFilePath?: string
  planExists?: boolean
}

export async function getSystemPromptForMode(
  mode: ExternalMode,
  cwd: string,
  projectRules?: string,
  options: SystemPromptOptions = {},
  modelId = '',
): Promise<string> {
  switch (mode) {
    case 'ask':
      return askSystemPrompt(cwd, projectRules, modelId)
    case 'plan':
      return planSystemPrompt(cwd, projectRules, {
        planFilePath: options.planFilePath ?? '~/.ai-agent/plans/plan.md',
        planExists: options.planExists ?? false,
      }, modelId)
    default:
      return systemPrompt(cwd, projectRules, modelId)
  }
}
