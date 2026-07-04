import type { Tool } from 'ai'
import type { ProviderOptions } from '@ai-sdk/provider-utils'
import type { LlmProfile } from './llm/types.js'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyTool = Tool<any, any>

// ── EventBus ────────────────────────────────────

export type EventHandler = (data: unknown, event: string) => void

export interface IEventBus {
  on(event: string, handler: EventHandler): () => void
  off(event: string, handler: EventHandler): void
  emit(event: string, data?: unknown): void
  scoped(prefix: string): IEventBus
  removeAllListeners(): void
}

// ── Middleware ───────────────────────────────────

export type MiddlewareHook = 'beforeTool' | 'afterTool' | 'onError'

export interface MiddlewareContext {
  name: string
  args: unknown
  startTime: number
  result?: unknown
  error?: unknown
  duration?: number
}

export type MiddlewareHandler = (ctx: MiddlewareContext) => void | Promise<void>

export interface IMiddleware {
  use(hook: MiddlewareHook, handler: MiddlewareHandler): void
  wrap(
    name: string,
    executeFn: (args: unknown) => Promise<unknown>,
  ): (args: unknown) => Promise<unknown>
}

// ── Tool Registry ───────────────────────────────

export interface ToolContext {
  eventBus: IEventBus
  middleware?: IMiddleware
  runAgent?: RunAgentFn
  registry?: IToolRegistry
  /** MCP tools keyed by merged name from MCPManager (e.g. `web_fetch`). Subagents list these in SubagentConfig.tools */
  mcpTools?: Record<string, AnyTool>
  /** From AppConfig: omit disabled tools in registry.createAll; subagents pass through for MCP merge + filter */
  toolEnablement?: Pick<AppConfig, 'disabledTools'>
}

export interface ToolDefinition {
  name: string
  description: string
  /** When false, the tool is never exposed to the model */
  enabled?: boolean
  /**
   * Marks tools created via `createSubagentDefinition`. Used to prevent
   * subagent → subagent recursion: a subagent never inherits other subagents
   * as tools regardless of allow/deny lists.
   */
  isSubagent?: boolean
  create(cwd: string, context: ToolContext): AnyTool
}

export interface IToolRegistry {
  register(def: ToolDefinition): void
  get(name: string): ToolDefinition | undefined
  list(): Array<{ name: string; description: string }>
  createAll(
    cwd: string,
    context: ToolContext,
    only?: string[],
  ): Record<string, AnyTool>
}

// ── Messages (AI SDK format) ────────────────────

export interface TextPart {
  type: 'text'
  text: string
}

export interface ImagePart {
  type: 'image'
  image: string | Buffer | Uint8Array
  mediaType?: string
}

export interface ToolCallPart {
  type: 'tool-call'
  toolCallId: string
  toolName: string
  input: Record<string, unknown>
  providerOptions?: ProviderOptions
}

/**
 * Reasoning part produced by reasoning models (e.g. OpenAI Responses API).
 * `providerOptions.openai.{ itemId, reasoningEncryptedContent }` carries the
 * opaque state that MUST be replayed verbatim on the next request, otherwise
 * the model loses its chain-of-thought across tool-call rounds.
 */
export interface ReasoningPart {
  type: 'reasoning'
  text: string
  providerOptions?: ProviderOptions
}

export type UserContentPart = TextPart | ImagePart
export type AssistantContentPart = TextPart | ReasoningPart | ToolCallPart

export interface UserMessage {
  role: 'user'
  content: string | UserContentPart[]
}

export interface AssistantMessage {
  role: 'assistant'
  content: AssistantContentPart[]
}

export interface ToolResultOutput {
  type: 'text'
  value: string
}

export interface ToolResultPart {
  type: 'tool-result'
  toolCallId: string
  toolName: string
  output: ToolResultOutput
}

export interface ToolMessage {
  role: 'tool'
  content: ToolResultPart[]
}

export type Message = UserMessage | AssistantMessage | ToolMessage

// ── Agent ───────────────────────────────────────

export interface AgentOptions {
  tools: Record<string, AnyTool>
  systemPrompt: string
  eventBus: IEventBus
  messages?: Message[]
  images?: string[]
  maxSteps?: number
  model?: string
  /**
   * Names of tools that are subagent wrappers. Used purely for UI: when
   * provided, the agent tags `tool_call` / `tool_input_start` events with
   * `isSubagent: true` so the frontend can render them with the special
   * "subagent" card style + auto-expanded nested step list.
   */
  subagentNames?: Set<string>
}

export type RunAgentFn = (
  userMessage: string,
  options: AgentOptions,
) => Promise<string>

// ── LLM provider ─────────────────────────────────
// Profile/strategy types live in `./llm/`. Re-exported here for convenience.

export type {
  LlmProfile,
  ProviderId,
  ThinkingConfig,
  IProvider,
  AgentStreamTextExtras,
  ProviderStrategy,
} from './llm/types.js'

// ── Plugin ──────────────────────────────────────

export interface PluginContext {
  tools: IToolRegistry
  events: IEventBus
  middleware: IMiddleware
}

export interface Plugin {
  name: string
  version?: string
  description?: string
  init(context: PluginContext): void | Promise<void>
  destroy?(): void | Promise<void>
}

// ── Session ─────────────────────────────────────

export interface Session {
  id: string
  messages: Message[]
  createdAt: number
}

export interface SessionInfo {
  id: string
  createdAt?: number
  messageCount: number
  preview?: string
}

// ── Server ──────────────────────────────────────

export interface ServerOptions {
  runAgent: RunAgentFn
  systemPrompt: (cwd: string, projectRules?: string) => string
}

export interface RouterOptions {
  runAgent: RunAgentFn
  systemPrompt: (cwd: string, projectRules?: string) => string
  staticDir: string | null
}

export interface SSETransport {
  send(event: string, data: unknown): void
  end(): void
}

// ── Subagent ────────────────────────────────────

/**
 * Pure-data definition of a subagent. After the single-Task architecture
 * refactor, subagents are no longer registered as individual tools — they
 * are entries in the `task` tool's directory. The model picks one via
 * `subagent_type` parameter.
 *
 */
export interface AgentDefinition {
  /** Stable identifier shown to the model as `subagent_type` value. */
  agentType: string
  /**
   * One-paragraph description rendered in the `task` tool's description
   * directory. Should include 1-3 user-phrasing examples in quotes so the
   * model recognizes triggers like "how does X work" / "audit Y".
   *
   * Add the literal string "use proactively" here to opt this agent into
   * the proactive-use protocol surfaced in the main system prompt.
   */
  whenToUse: string
  /** Brief description for activity logs / UI / events. */
  description: string
  /** System prompt the subagent runs with. */
  systemPrompt: string
  /**
   * Allow-list of tool names. Mutually exclusive with `disallowedTools`.
   * If neither set, subagent inherits the full registry + MCP tools.
   */
  tools?: string[]
  /** Deny-list of tool names. */
  disallowedTools?: string[]
  /** Max agentic steps before stopping. Default 20. */
  maxSteps?: number
  /** Optional model override (provider-dependent). */
  model?: string
  /** Display label used in the UI's SubagentCard. Defaults to titlecased agentType. */
  label?: string
}

// ── MCP ─────────────────────────────────────────

export interface MCPServerStdio {
  command: string
  args?: string[]
  env?: Record<string, string>
}

export interface MCPServerHTTP {
  url: string
  transport?: 'http' | 'sse'
  headers?: Record<string, string>
}

export type MCPServerConfig = MCPServerStdio | MCPServerHTTP

export interface MCPServerStatus {
  name: string
  status: 'connected' | 'error' | 'disconnected'
  tools: string[]
  error?: string
}

// ── Todo ────────────────────────────────────────

export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled'

export interface TodoItem {
  id: string
  content: string
  status: TodoStatus
}

// ── App Config ──────────────────────────────────

export interface CompactionConfig {
  /** Run full LLM summarization when total conversation tokens >= this. */
  tokenThreshold: number
  /** Run cheap micro-compaction (clear old tool_result content) when total tokens >= this. */
  microCompactThreshold: number
  /** Token budget for the tail preserved verbatim across a full LLM compaction. */
  tailTokenBudget: number
  /** Number of most-recent tool results to keep verbatim during micro-compaction. */
  microCompactKeepRecent: number
  /** Model used for full LLM summarization. */
  model: string
}

export interface AppConfig {
  provider: LlmProfile
  compaction: CompactionConfig
  mcpServers: Record<string, MCPServerConfig>
  /** Tool names to hide from the model (local or MCP, e.g. `web_fetch`, `someServer_fetch`) */
  disabledTools?: string[]
}
