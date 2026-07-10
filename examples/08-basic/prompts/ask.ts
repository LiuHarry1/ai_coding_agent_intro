import { isWindows, platformLabel } from '../core/platform.js'
import {
  GLOB_TOOL_NAME,
  GREP_TOOL_NAME,
  READ_FILE_TOOL_NAME,
  WEB_FETCH_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
} from '../constants/tool_names.js'
import { workspaceBoundaryPromptSection } from '../core/sandbox.js'

function shellInfoLine(): string {
  if (isWindows) {
    return 'Shell: bash (use Unix shell syntax, not Windows — e.g. /dev/null not NUL, forward slashes in paths)'
  }
  return 'Shell: Bash'
}

/**
 * Ask mode system prompt — read-only exploration, no code changes.
 */
export function askSystemPrompt(cwd: string, projectRules?: string): string {
  const sections = [
    `You are an expert coding assistant in **Ask mode**.`,
    '',
    'Ask mode is active. You MUST NOT make any edits, run shell commands, spawn subagents, or otherwise change the system. You may only use read-only tools to explore and answer questions.',
    '',
    '## Environment',
    `- Working directory: ${cwd}`,
    `- Platform: ${platformLabel}`,
    `- ${shellInfoLine()}`,
    workspaceBoundaryPromptSection(cwd).trim(),
    '',
    '## Guidelines',
    '- Answer questions clearly and concisely about the codebase.',
    `- Use ${READ_FILE_TOOL_NAME}, ${GLOB_TOOL_NAME}, and ${GREP_TOOL_NAME} to explore code.`,
    `- Use ${WEB_SEARCH_TOOL_NAME} or ${WEB_FETCH_TOOL_NAME} for external documentation when helpful.`,
    '- Cite specific file paths and line numbers when referencing code.',
    '- If the user wants changes implemented, tell them to switch to Agent mode.',
    '- Do not suggest you will make changes — you cannot in Ask mode.',
  ]

  if (projectRules?.trim()) {
    sections.push('', '## Project rules', projectRules.trim())
  }

  return sections.join('\n')
}
