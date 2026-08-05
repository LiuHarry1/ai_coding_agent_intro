/**
 * Main-thread agent profile prompt.
 * When session.agentType is set, the profile body REPLACES the default
 * system prompt for that turn.
 */
import type { AgentDefinition } from '../core/types.js'
import { computeSimpleEnvInfo } from '../constants/prompts.js'
import { setCwd } from '../utils/cwd.js'
import { workspaceBoundaryPromptSection } from '../core/sandbox.js'
import { previewSection } from './preview.js'

/**
 * Build the effective system prompt for a primary agent profile.
 * REPLACE default agent/ask/plan prompts with the markdown body, then append
 * a short environment block and project rules (unless omitProjectRules).
 */
export async function getSystemPromptForAgentProfile(
  profile: AgentDefinition,
  cwd: string,
  projectRules?: string,
  modelId = '',
): Promise<string> {
  setCwd(cwd)
  const env =
    (await computeSimpleEnvInfo(modelId)) +
    previewSection() +
    workspaceBoundaryPromptSection(cwd)

  const rulesAppend =
    !profile.omitProjectRules && projectRules ? `\n\n${projectRules}` : ''

  return `${profile.systemPrompt}\n\n${env}${rulesAppend}`
}
