/**
 * Session working directory — mirrors Claude Code `utils/cwd.ts` (`getCwd`).
 * Prompt builders (`computeEnvInfo` / `computeSimpleEnvInfo`) read cwd from here.
 */
let cwdState: string = process.cwd()

export function getCwd(): string {
  return cwdState
}

/** Set before assembling system prompts for a turn / subagent spawn. */
export function setCwd(cwd: string): void {
  cwdState = cwd
}
