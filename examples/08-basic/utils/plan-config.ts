/**
 * Plan mode V2 config — Claude Code planModeV2.ts equivalent (5-phase only).
 */

function parsePositiveInt(
  raw: string | undefined,
  fallback: number,
  max = 10,
): number {
  if (!raw) return fallback
  const n = parseInt(raw, 10)
  if (Number.isNaN(n) || n <= 0 || n > max) return fallback
  return n
}

/** Plan design agents in Phase 2 (default 1). */
export function getPlanModeAgentCount(): number {
  return parsePositiveInt(process.env.CLAUDE_CODE_PLAN_V2_AGENT_COUNT, 1)
}

/** Explore agents in Phase 1 (default 3). */
export function getPlanModeExploreAgentCount(): number {
  return parsePositiveInt(
    process.env.CLAUDE_CODE_PLAN_V2_EXPLORE_AGENT_COUNT,
    3,
  )
}
