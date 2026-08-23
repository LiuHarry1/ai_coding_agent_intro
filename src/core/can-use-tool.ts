/**
 * CC-aligned tool permission gate (Phase 1: allow-all stub).
 * Phase 2 will wire settings rules + interactive prompts.
 */
export type PermissionDecision =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown> }
  | { behavior: 'deny'; message: string }

export type CanUseToolFn = (
  toolName: string,
  input: Record<string, unknown>,
) => Promise<PermissionDecision>

/** Default gate — all tools allowed. */
export const allowAllTools: CanUseToolFn = async () => ({ behavior: 'allow' })
