/**
 * CC-aligned tool permission gate (Phase 1: allow-all stub).
 * Phase 2 will wire settings rules + interactive prompts.
 */
export type PermissionDecision =
  | { behavior: 'allow'; updatedInput?: unknown }
  | { behavior: 'deny'; message: string }

export type CanUseToolFn = (
  toolName: string,
  input: unknown,
) => Promise<PermissionDecision> | PermissionDecision

/** Default gate — all tools allowed. */
export const allowAllTools: CanUseToolFn = async () => ({ behavior: 'allow' })
