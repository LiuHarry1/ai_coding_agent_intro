import type { WireEmitter } from '../wire-emitter.js'

/**
 * Scoped wire emitter for a subagent invocation. Every message carries
 * `parent_tool_use_id` so the frontend routes nested events to SubagentCard.
 * 
 */
export function createSubagentWire(
  parent: WireEmitter,
  parentToolUseId: string,
): WireEmitter {
  return parent.scoped(parentToolUseId)
}
