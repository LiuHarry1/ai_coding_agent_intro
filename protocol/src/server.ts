import { z } from 'zod'
import {
  envelopeFields,
  PermissionModeSchema,
  TodoItemSchema,
  UsageSchema,
} from './common.js'
import { PROTOCOL_VERSION } from './version.js'
import { ControlRequestSchema } from './control.js'

/**
 * Messages flowing from the agent engine to a GUI / client.
 *
 * Shape mirrors Claude Code's SDKMessage union:
 *   - top-level discriminant is `type`
 *   - the `system` type carries a secondary `subtype` discriminant
 *     (init / todo_update / skill_start / mode_changed / …)
 *   - the union itself is a plain `z.union` (not discriminatedUnion)
 *     precisely because several members share `type: "system"`.
 *
 * The engine emits these regardless of transport; SSE / NDJSON / ACP
 * adapters just serialize them differently.
 */

// ── Handshake ────────────────────────────────────────
// First message of a session. Announces protocol version + capabilities,
// like CC's `system/init`. Fields the engine can't know yet are optional.
export const InitMessageSchema = z.object({
  type: z.literal('system'),
  subtype: z.literal('init'),
  protocol_version: z.literal(PROTOCOL_VERSION),
  permission_mode: PermissionModeSchema,
  cwd: z.string().optional(),
  model: z.string().optional(),
  tools: z.array(z.string()).optional(),
  slash_commands: z.array(z.string()).optional(),
  skills: z.array(z.string()).optional(),
  ...envelopeFields,
})

// ── Streaming assistant output ───────────────────────
// Incremental deltas (CC's `stream_event` / partial assistant). `kind`
// separates visible answer text from chain-of-thought reasoning.
export const StreamEventMessageSchema = z.object({
  type: z.literal('stream_event'),
  delta: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('text'), text: z.string() }),
    z.object({ kind: z.literal('reasoning'), text: z.string() }),
  ]),
  ...envelopeFields,
})

// A settled assistant message (CC's `assistant`). `content` is left as
// unknown for now — it carries the provider message shape verbatim.
export const AssistantMessageSchema = z.object({
  type: z.literal('assistant'),
  content: z.unknown(),
  ...envelopeFields,
})

// ── Tool activity ────────────────────────────────────
export const ToolCallMessageSchema = z.object({
  type: z.literal('tool_call'),
  tool_use_id: z.string(),
  name: z.string(),
  args: z.unknown(),
  ...envelopeFields,
})

export const ToolResultMessageSchema = z.object({
  type: z.literal('tool_result'),
  tool_use_id: z.string(),
  result: z.string(),
  is_error: z.boolean().optional(),
  ...envelopeFields,
})

// ── system/<subtype> progress events ─────────────────
export const TodoUpdateMessageSchema = z.object({
  type: z.literal('system'),
  subtype: z.literal('todo_update'),
  todos: z.array(TodoItemSchema),
  ...envelopeFields,
})

export const SkillStartMessageSchema = z.object({
  type: z.literal('system'),
  subtype: z.literal('skill_start'),
  skill: z.string(),
  agent_type: z.string().optional(),
  workspace: z.string().optional(),
  ...envelopeFields,
})

export const ModeChangedMessageSchema = z.object({
  type: z.literal('system'),
  subtype: z.literal('mode_changed'),
  mode: PermissionModeSchema,
  ...envelopeFields,
})

// ── Terminal result ──────────────────────────────────
// Ends a turn (CC's `result`, split into success / error variants).
export const ResultSuccessMessageSchema = z.object({
  type: z.literal('result'),
  subtype: z.literal('success'),
  reason: z.string(),
  text: z.string().optional(),
  usage: UsageSchema.optional(),
  ...envelopeFields,
})

export const ResultErrorMessageSchema = z.object({
  type: z.literal('result'),
  subtype: z.literal('error'),
  error: z.string(),
  ...envelopeFields,
})

/**
 * Anything the engine emits that isn't (yet) part of the stable public
 * contract — internal progress like compaction, token usage, tool-input
 * previews. Kept as an explicit escape hatch so additive engine changes
 * never crash a GUI (mirrors CC keeping internal events off the SDK
 * stream while still being forward-compatible).
 */
export const KeepAliveMessageSchema = z.object({
  type: z.literal('keep_alive'),
})

export const ServerMessageSchema = z.union([
  InitMessageSchema,
  StreamEventMessageSchema,
  AssistantMessageSchema,
  ToolCallMessageSchema,
  ToolResultMessageSchema,
  TodoUpdateMessageSchema,
  SkillStartMessageSchema,
  ModeChangedMessageSchema,
  ResultSuccessMessageSchema,
  ResultErrorMessageSchema,
  // The engine can also reach back to the client (permission, plan, …).
  ControlRequestSchema,
  KeepAliveMessageSchema,
])
export type ServerMessage = z.infer<typeof ServerMessageSchema>
