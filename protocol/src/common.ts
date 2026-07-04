import { z } from 'zod'

/**
 * Shared primitives used across server, client, and control messages.
 *
 * Design note (aligned with Claude Code's coreSchemas.ts): every message
 * that crosses the wire carries a correlation envelope (`session_id` +
 * optional `uuid`). The transport may fill in `uuid` if the engine
 * doesn't, so it stays optional here.
 */

/** Correlation fields stamped on every wire message. Spread into objects. */
export const envelopeFields = {
  /** Conversation this message belongs to. */
  session_id: z.string(),
  /**
   * Per-message id. Lets GUIs dedupe and lets late control responses be
   * matched. Optional because incremental stream deltas often omit it.
   */
  uuid: z.string().optional(),
}

/**
 * Permission / operating mode. Mirrors the backend's external modes
 * (`isValidExternalMode`) and maps cleanly onto ACP's `session/set_mode`.
 */
export const PermissionModeSchema = z.enum(['ask', 'agent', 'plan'])
export type PermissionMode = z.infer<typeof PermissionModeSchema>

/** A single TODO item as produced by the `TodoWrite` tool. */
export const TodoStatusSchema = z.enum([
  'pending',
  'in_progress',
  'completed',
  'cancelled',
])
export type TodoStatus = z.infer<typeof TodoStatusSchema>

export const TodoItemSchema = z.object({
  id: z.string(),
  content: z.string(),
  status: TodoStatusSchema,
})
export type TodoItem = z.infer<typeof TodoItemSchema>

/** Token accounting attached to terminal `result` messages. */
export const UsageSchema = z.object({
  input_tokens: z.number().optional(),
  output_tokens: z.number().optional(),
  total_tokens: z.number().optional(),
})
export type Usage = z.infer<typeof UsageSchema>
