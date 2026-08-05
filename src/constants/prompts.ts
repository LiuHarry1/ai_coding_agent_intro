/**
 * System-prompt helpers — naming / structure aligned with Claude Code
 * `src/constants/prompts.ts` (`computeEnvInfo`, `computeSimpleEnvInfo`,
 * `enhanceSystemPromptWithEnvDetails`, `getUnameSR`, `prependBullets`).
 *
 * Do NOT use `enhanceSystemPromptWithEnvDetails` on cache-sharing forks
 * (`runForkedAgent` / `CacheSafeParams`) — those must reuse the parent
 * system prompt bytes.
 */
import * as os from 'os'
import { getCwd } from '../utils/cwd.js'
import { getIsGit } from '../utils/git.js'

const isWindows = process.platform === 'win32'

/** Platform string for env blocks — CC `env.platform`. */
function platform(): string {
  return process.platform
}

export function prependBullets(items: Array<string | string[]>): string[] {
  return items.flatMap(item =>
    Array.isArray(item)
      ? item.map(subitem => `  - ${subitem}`)
      : [` - ${item}`],
  )
}

function getShellInfoLine(): string {
  const shell = process.env.SHELL || 'unknown'
  const shellName = shell.includes('zsh')
    ? 'zsh'
    : shell.includes('bash')
      ? 'bash'
      : shell
  if (isWindows) {
    return `Shell: ${shellName} (use Unix shell syntax, not Windows — e.g., /dev/null not NUL, forward slashes in paths)`
  }
  return `Shell: ${shellName}`
}

/**
 * `Darwin 24.6.0` / `Linux …` / Windows friendly version.
 * CC: `getUnameSR()`.
 */
export function getUnameSR(): string {
  if (isWindows) {
    return `${os.version()} ${os.release()}`
  }
  return `${os.type()} ${os.release()}`
}

/**
 * Compact `<env>` block for subagents.
 * CC: `computeEnvInfo` (model / knowledge-cutoff lines omitted when modelId empty).
 */
export async function computeEnvInfo(
  modelId: string,
  additionalWorkingDirectories?: string[],
): Promise<string> {
  const isGit = await getIsGit()
  const unameSR = getUnameSR()

  const modelDescription = modelId
    ? `You are powered by the model ${modelId}.`
    : ''

  const additionalDirsInfo =
    additionalWorkingDirectories && additionalWorkingDirectories.length > 0
      ? `Additional working directories: ${additionalWorkingDirectories.join(', ')}\n`
      : ''

  return `Here is useful information about the environment you are running in:
<env>
Working directory: ${getCwd()}
Is directory a git repo: ${isGit ? 'Yes' : 'No'}
${additionalDirsInfo}Platform: ${platform()}
${getShellInfoLine()}
OS Version: ${unameSR}
</env>
${modelDescription}`
}

/**
 * Markdown `# Environment` block for the main session.
 * CC: `computeSimpleEnvInfo` (product marketing lines omitted).
 */
export async function computeSimpleEnvInfo(
  modelId: string,
  additionalWorkingDirectories?: string[],
): Promise<string> {
  const isGit = await getIsGit()
  const unameSR = getUnameSR()

  const modelDescription = modelId
    ? `You are powered by the model ${modelId}.`
    : null

  const cwd = getCwd()

  const envItems = [
    `Primary working directory: ${cwd}`,
    `Is a git repository: ${isGit ? 'Yes' : 'No'}`,
    additionalWorkingDirectories && additionalWorkingDirectories.length > 0
      ? `Additional working directories:`
      : null,
    additionalWorkingDirectories && additionalWorkingDirectories.length > 0
      ? additionalWorkingDirectories
      : null,
    `Platform: ${platform()}`,
    getShellInfoLine(),
    `OS Version: ${unameSR}`,
    modelDescription,
  ].filter((item): item is string | string[] => item !== null)

  return [
    `# Environment`,
    `You have been invoked in the following environment: `,
    ...prependBullets(envItems),
  ].join(`\n`)
}

/**
 * Append notes + `<env>` to a subagent role prompt.
 * CC: `enhanceSystemPromptWithEnvDetails`.
 *
 * Not for cache-safe forks — those must keep the parent system prompt.
 */
export async function enhanceSystemPromptWithEnvDetails(
  existingSystemPrompt: string[],
  model: string,
  additionalWorkingDirectories?: string[],
  _enabledToolNames?: ReadonlySet<string>,
): Promise<string[]> {
  const notes = `Notes:
- Agent threads always have their cwd reset between bash calls, as a result please only use absolute file paths.
- In your final response, share file paths (always absolute, never relative) that are relevant to the task. Include code snippets only when the exact text is load-bearing (e.g., a bug you found, a function signature the caller asked for) — do not recap code you merely read.
- For clear communication with the user the assistant MUST avoid using emojis.
- Do not use a colon before tool calls. Text like "Let me read the file:" followed by a read tool call should just be "Let me read the file." with a period.`

  const envInfo = await computeEnvInfo(model, additionalWorkingDirectories)
  return [...existingSystemPrompt, notes, envInfo]
}
