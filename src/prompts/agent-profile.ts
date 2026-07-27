/**
 * CC-aligned main-thread agent profile prompt.
 * When session.agentType is set, the profile body REPLACES the default
 * system prompt (see claude-code-rev systemPrompt.buildEffectiveSystemPrompt).
 */
import { isWindows, platformLabel } from '../core/platform.js'
import { BASH_TOOL_NAME } from '../constants/tool_names.js'
import { previewSection } from './preview.js'
import { workspaceBoundaryPromptSection } from '../core/sandbox.js'
import type { AgentDefinition } from '../core/types.js'

function shellInfoLine(): string {
  if (isWindows) {
    return 'Shell: bash (use Unix shell syntax, not Windows — e.g. /dev/null not NUL, forward slashes in paths)'
  }
  return `Shell: ${BASH_TOOL_NAME}`
}

/**
 * Build the effective system prompt for a primary agent profile.
 * REPLACE default agent/ask/plan prompts with the markdown body, then append
 * a short environment block and project rules (unless omitProjectRules).
 */
export function getSystemPromptForAgentProfile(
  profile: AgentDefinition,
  cwd: string,
  projectRules?: string,
): string {
  const env = `# Environment
 - Primary working directory: ${cwd}
 - Platform: ${platformLabel}
 - ${shellInfoLine()}${previewSection()}
${workspaceBoundaryPromptSection(cwd)}`

  const rulesAppend =
    !profile.omitProjectRules && projectRules ? `\n\n${projectRules}` : ''

  return `${profile.systemPrompt}\n\n${env}${rulesAppend}`
}
