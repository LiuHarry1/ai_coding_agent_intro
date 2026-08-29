/**
 * Shared nested step density under Explored / Subagent.
 * Cards receive `nested` and use explore-line / read density policies;
 * this module documents the contract for NestedToolRuns / ExploredGroup.
 */

/** Indent (px) for nested step bodies under a parent tool line. */
export const NESTED_STEP_INDENT_PX = 14

/**
 * Props every nested tool card should honor for Cursor flat density.
 * @returns {{ nested: true }}
 */
export function nestedStepCardProps() {
  return { nested: true }
}
