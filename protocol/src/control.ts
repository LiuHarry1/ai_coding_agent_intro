import { z } from 'zod'
import { PermissionModeSchema } from './common.js'

/**
 * Bidirectional control sub-protocol.
 *
 * Directly controlSchemas.ts:
 *   - `control_request`        — one side asks the other to do / decide something
 *   - `control_response`       — success / error reply, correlated by `request_id`
 *   - `control_cancel_request` — withdraw a still-open request
 *
 * This is what lets interactive flows (tool-permission prompts, plan
 * approval, mode switches, interrupt) work over ANY transport — SSE,
 * stdio NDJSON, or ACP — instead of being bolted onto bespoke HTTP
 * endpoints. The inner request is discriminated by `subtype`.
 *
 * Today these mirror existing backend endpoints:
 *   - can_use_tool        ← /ask_user_question (permission gate)
 *   - ask_user_question   ← the AskUserQuestion tool
 *   - approve_plan        ← /plan/approve
 *   - set_permission_mode ← /session/mode
 *   - interrupt           ← client-initiated abort
 */

export const CanUseToolRequestSchema = z.object({
  subtype: z.literal('can_use_tool'),
  tool_name: z.string(),
  tool_use_id: z.string(),
  input: z.record(z.string(), z.unknown()),
  /** Optional human-facing hints the GUI can render in the prompt. */
  title: z.string().optional(),
  description: z.string().optional(),
})

export const AskUserQuestionRequestSchema = z.object({
  subtype: z.literal('ask_user_question'),
  /** Correlates with the tool invocation that raised the question. */
  question_id: z.string(),
  questions: z.array(z.unknown()),
})

export const ApprovePlanRequestSchema = z.object({
  subtype: z.literal('approve_plan'),
  request_id: z.string().optional(),
  plan: z.string(),
})

export const SetPermissionModeRequestSchema = z.object({
  subtype: z.literal('set_permission_mode'),
  mode: PermissionModeSchema,
})

export const InterruptRequestSchema = z.object({
  subtype: z.literal('interrupt'),
})

/** Inner request payload, discriminated by `subtype` . */
export const ControlRequestInnerSchema = z.discriminatedUnion('subtype', [
  CanUseToolRequestSchema,
  AskUserQuestionRequestSchema,
  ApprovePlanRequestSchema,
  SetPermissionModeRequestSchema,
  InterruptRequestSchema,
])
export type ControlRequestInner = z.infer<typeof ControlRequestInnerSchema>

export const ControlRequestSchema = z.object({
  type: z.literal('control_request'),
  request_id: z.string(),
  request: ControlRequestInnerSchema,
})
export type ControlRequest = z.infer<typeof ControlRequestSchema>

const ControlSuccessSchema = z.object({
  subtype: z.literal('success'),
  request_id: z.string(),
  response: z.record(z.string(), z.unknown()).optional(),
})

const ControlErrorSchema = z.object({
  subtype: z.literal('error'),
  request_id: z.string(),
  error: z.string(),
})

export const ControlResponseSchema = z.object({
  type: z.literal('control_response'),
  response: z.union([ControlSuccessSchema, ControlErrorSchema]),
})
export type ControlResponse = z.infer<typeof ControlResponseSchema>

export const ControlCancelRequestSchema = z.object({
  type: z.literal('control_cancel_request'),
  request_id: z.string(),
})
export type ControlCancelRequest = z.infer<typeof ControlCancelRequestSchema>
