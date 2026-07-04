/**
 * Wire types mirrored from `examples/08-basic/server/skills-api.ts`
 * and `examples/08-basic/server/router.ts`. Kept narrow on purpose —
 * callers shouldn't have to import server-internal types just to talk
 * to the API. If the server adds fields, we add them here; nothing
 * here should reference server modules.
 */

export type SkillContextMode = 'inline' | 'fork'
export type SkillSource = 'built-in' | 'user' | 'project'

export interface SkillSummary {
  name: string
  description: string
  context: SkillContextMode
  agent?: string
  argumentNames: string[]
  paths?: string[]
  source: SkillSource
  filePath?: string
  baseDir?: string
  /** True iff the skill is unconditionally active (no `paths:` filter). */
  active: boolean
}

export interface AgentSummary {
  agentType: string
  whenToUse: string
  description: string
  tools?: string[]
  disallowedTools?: string[]
  maxSteps?: number
  model?: string
}

export interface SkillsListResponse {
  workspace: string
  skills: SkillSummary[]
  errors: Array<{ filePath: string; error: string }>
}

export interface AgentsListResponse {
  workspace: string
  agents: AgentSummary[]
  builtin: string[]
  errors: Array<{ filePath: string; error: string }>
}

export interface SkillInvokeRequest {
  /** Absolute path to the workspace the skill should run against. */
  workspace?: string
  /**
   * Skill arguments. Either a raw string (`"audience=eng-team --strict"`,
   * same shape `$1` / `$ARGUMENTS` would see) or a structured object
   * (`{ audience: "eng-team", strict: true }`). The server flattens
   * objects to `key=value` pairs with shell-style quoting before
   * substitution, so `$name` resolution works either way.
   */
  arguments?: string | Record<string, string | number | boolean>
  /**
   * Only meaningful for `context: "fork"` skills. When `false`, the
   * server buffers the subagent's final text and returns one JSON blob
   * instead of an SSE stream. Inline skills always return JSON.
   */
  stream?: boolean
}

export interface SkillInvokeInlineResult {
  skill: string
  context: 'inline'
  workspace: string
  result: string
}

export interface SkillInvokeForkResult {
  skill: string
  context: 'fork'
  agentType: string
  workspace: string
  result: string
}

export type SkillInvokeResult = SkillInvokeInlineResult | SkillInvokeForkResult

export interface ChatRequest {
  message: string
  workspace?: string
  session_id?: string
  images?: string[]
  /** Same semantics as `SkillInvokeRequest.stream`. */
  stream?: boolean
}

export interface ChatJSONResult {
  session_id: string
  text: string
  messages?: unknown[]
  /** Present when the server short-circuited via a built-in slash command. */
  reason?: string
}

/**
 * SSE events emitted by `/chat` and the fork branch of
 * `/skills/:name/invoke`. The wire format is a flat `(event, data)` pair
 * — we surface it as a tagged union for ergonomic switch handling.
 *
 * Anything we haven't typed yet falls into `UnknownAgentEvent` so callers
 * never have to crash on a new event name; they can just ignore it.
 */
export type AgentEvent =
  | { type: 'session'; session_id: string }
  | { type: 'skill_start'; skill: string; agentType: string; workspace: string }
  | { type: 'text_delta'; delta: string }
  | { type: 'reasoning_delta'; delta: string }
  | { type: 'tool_call'; name: string; toolCallId: string; args: unknown }
  | { type: 'tool_result'; toolCallId: string; result: string }
  | { type: 'finish'; reason: string; text?: string }
  | { type: 'error'; message: string }
  | { type: 'unknown'; event: string; data: unknown }
