import type { Tool } from "ai";
import type { ProviderOptions } from "@ai-sdk/provider-utils";
import type { LlmProfile } from "./llm/types.js";
import type { ConcurrencyPolicyFn } from "./concurrency-policy.js";
import type { ExternalMode, PermissionModeContext } from "./permission-mode.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyTool = Tool<any, any>;

// ── EventBus ────────────────────────────────────

export type EventHandler = (data: unknown, event: string) => void;

export interface IEventBus {
  on(event: string, handler: EventHandler): () => void;
  off(event: string, handler: EventHandler): void;
  emit(event: string, data?: unknown): void;
  scoped(prefix: string): IEventBus;
  removeAllListeners(): void;
}

// ── Middleware ───────────────────────────────────

export type MiddlewareHook = "beforeTool" | "afterTool" | "onError";

export interface MiddlewareContext {
  name: string;
  args: unknown;
  startTime: number;
  result?: unknown;
  error?: unknown;
  duration?: number;
}

export type MiddlewareHandler = (ctx: MiddlewareContext) => void | Promise<void>;

export interface IMiddleware {
  use(hook: MiddlewareHook, handler: MiddlewareHandler): void;
  wrap(name: string, executeFn: (args: unknown, options?: unknown) => Promise<unknown>): (args: unknown, options?: unknown) => Promise<unknown>;
}

// ── Tool Registry ───────────────────────────────

export interface ToolContext {
  eventBus: IEventBus;
  middleware?: IMiddleware;
  runAgent?: RunAgentFn;
  registry?: IToolRegistry;
  /** MCP tools keyed by merged name from MCPManager (e.g. `web_fetch`). Subagents list these in SubagentConfig.tools */
  mcpTools?: Record<string, AnyTool>;
  /** From AppConfig: omit disabled tools in registry.createAll; subagents pass through for MCP merge + filter */
  toolEnablement?: Pick<AppConfig, "disabledTools">;
  /** Session id for persisting large tool outputs under `.sessions/{id}/`. */
  sessionId?: string;
  /** Active session — set on main-agent runs for mode/plan tools. */
  session?: Session;
  /** Workspace cwd for plan file resolution. */
  cwd?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  /** When false, the tool is never exposed to the model */
  enabled?: boolean;
  /**
   * Marks tools created via `createSubagentDefinition`. Used to prevent
   * subagent → subagent recursion: a subagent never inherits other subagents
   * as tools regardless of allow/deny lists.
   */
  isSubagent?: boolean;
  /**
   * When true, the tool is deferred: its schema is excluded from the API
   * `tools[]` array until the model discovers it via `tool_search`. MCP
   * tools are auto-deferred (see `isDeferredTool`).
   */
  shouldDefer?: boolean;
  /**
   * When true, the tool is never deferred — full schema in the initial
   * prompt even when tool_search is enabled. For MCP tools, set via
   * config. Overrides both `shouldDefer` and the MCP auto-defer rule.
   */
  alwaysLoad?: boolean;
  /**
   * When true for a given input, the tool may run in parallel with other
   * consecutive concurrency-safe calls in the same assistant turn. Runtime
   * policy — the model is not told about this flag.
   */
  isConcurrencySafe?: (input: unknown) => boolean;
  create(cwd: string, context: ToolContext): AnyTool;
}

export interface IToolRegistry {
  register(def: ToolDefinition): void;
  get(name: string): ToolDefinition | undefined;
  list(): Array<{ name: string; description: string }>;
  createAll(cwd: string, context: ToolContext, only?: string[]): Record<string, AnyTool>;
}

// ── Messages (AI SDK format) ────────────────────

export interface TextPart {
  type: "text";
  text: string;
}

export interface ImagePart {
  type: "image";
  image: string | Buffer | Uint8Array;
  mediaType?: string;
}

export interface ToolCallPart {
  type: "tool-call";
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
  providerOptions?: ProviderOptions;
}

/**
 * Reasoning part produced by reasoning models (e.g. OpenAI Responses API).
 * `providerOptions.openai.{ itemId, reasoningEncryptedContent }` carries the
 * opaque state that MUST be replayed verbatim on the next request, otherwise
 * the model loses its chain-of-thought across tool-call rounds.
 */
export interface ReasoningPart {
  type: "reasoning";
  text: string;
  providerOptions?: ProviderOptions;
}

export type UserContentPart = TextPart | ImagePart;
export type AssistantContentPart = TextPart | ReasoningPart | ToolCallPart;

export interface UserMessage {
  role: "user";
  content: string | UserContentPart[];
}

export interface AssistantMessage {
  role: "assistant";
  content: AssistantContentPart[];
}

export interface ToolResultOutput {
  type: "text";
  value: string;
}

export interface ToolResultPart {
  type: "tool-result";
  toolCallId: string;
  toolName: string;
  output: ToolResultOutput;
}

export interface ToolMessage {
  role: "tool";
  content: ToolResultPart[];
}

export type Message = UserMessage | AssistantMessage | ToolMessage;

// ── Agent ───────────────────────────────────────

export interface AgentOptions {
  tools: Record<string, AnyTool>;
  systemPrompt: string;
  eventBus: IEventBus;
  messages?: Message[];
  images?: string[];
  maxSteps?: number;
  model?: string;
  /**
   * Names of tools that are subagent wrappers. Used purely for UI: when
   * provided, the agent tags `tool_call` / `tool_input_start` events with
   * `isSubagent: true` so the frontend can render them with the special
   * "subagent" card style + auto-expanded nested step list.
   */
  subagentNames?: Set<string>;
  /**
   * Pre-formatted skill/agent listing injected as a `<system-reminder>`
   * user message before the real user message. Keeps volatile listings
   * out of the tool schema and system prompt so those stay cacheable.
   */
  skillListing?: string;
  /**
   * Deferred tools pool — keyed by name, created but not in `tools`.
   * When the model calls `tool_search` and discovers a tool, the agent
   * loop activates it by moving it from this pool into `tools` for the
   * next step.
   */
  deferredToolPool?: Record<string, AnyTool>;
  /**
   * Per-tool concurrency policy for manual tool orchestration. When omitted,
   * all tools run serially (safe default).
   */
  concurrencyPolicy?: ConcurrencyPolicyFn;
  /** Persists large tool outputs; inherited by subagent runs. */
  sessionId?: string;
  /**
   * @-mention file attachments injected before the user message (Claude Code
   * getAttachmentMessages pattern).
   */
  attachmentMessages?: Message[];
  /**
   * Rebuild the active tool set when permission mode changes mid-turn
   * (e.g. ExitPlanMode approval unlocks Write/Bash after planning).
   */
  refreshTools?: () => Record<string, AnyTool>;
  /** Rebuild system prompt when permission mode changes mid-turn. */
  refreshSystemPrompt?: () => string;
  /** Inject plan-exit reminders when transitioning out of plan mode mid-turn. */
  onPermissionModeChange?: () => Message[];
}

export type RunAgentFn = (userMessage: string, options: AgentOptions) => Promise<string>;

// ── LLM provider ─────────────────────────────────
// Profile/strategy types live in `./llm/`. Re-exported here for convenience.

export type {
  LlmProfile,
  ProviderId,
  ThinkingConfig,
  IProvider,
  AgentStreamTextExtras,
  ProviderStrategy,
} from "./llm/types.js";

// ── Plugin ──────────────────────────────────────

export interface PluginContext {
  tools: IToolRegistry;
  events: IEventBus;
  middleware: IMiddleware;
}

export interface Plugin {
  name: string;
  version?: string;
  description?: string;
  init(context: PluginContext): void | Promise<void>;
  destroy?(): void | Promise<void>;
}

// ── Session ─────────────────────────────────────

export interface Session {
  id: string;
  messages: Message[];
  createdAt: number;
  /**
   * Email of the user who created the session (SSO mode only). Used to keep
   * sessions private per-user. Undefined for sessions created without auth.
   */
  ownerEmail?: string;
  /** Tool names discovered via `tool_search` — activated in subsequent turns. */
  discoveredTools?: Set<string>;
  /** Tracks files read for @-mention dedup (mtime-based), per session. */
  readFileState?: Map<string, { content: string; timestamp: number }>;
  /** Session-level Agent / Ask / Plan mode. */
  permissionMode: PermissionModeContext;
  /** Set when exiting plan — triggers reentry attachment on next plan entry. */
  hasExitedPlanMode?: boolean;
  /** One-shot attachment after plan exit allowing execution. */
  needsPlanModeExitAttachment?: boolean;
}

export interface SessionInfo {
  id: string;
  createdAt?: number;
  messageCount: number;
  preview?: string;
  permissionMode?: ExternalMode;
  /** Present when SSO mode records session ownership (shown to super users). */
  ownerEmail?: string;
}

// ── Server ──────────────────────────────────────

export interface ServerOptions {
  runAgent: RunAgentFn;
  systemPrompt: (cwd: string, projectRules?: string) => string;
}

export interface RouterOptions {
  runAgent: RunAgentFn;
  systemPrompt: (cwd: string, projectRules?: string) => string;
  staticDir: string | null;
}

export interface SSETransport {
  send(event: string, data: unknown): void;
  end(): void;
}

// ── Subagent ────────────────────────────────────

/**
 * Pure-data definition of a subagent. After the single-Task architecture
 * refactor, subagents are no longer registered as individual tools — they
 * are entries in the `task` tool's directory. The model picks one via
 * `subagent_type` parameter.
 */
export interface AgentDefinition {
  /** Stable identifier shown to the model as `subagent_type` value. */
  agentType: string;
  /**
   * One-paragraph description rendered in the `task` tool's description
   * directory. Should include 1-3 user-phrasing examples in quotes so the
   * model recognizes triggers like "how does X work" / "audit Y".
   *
   * Add the literal string "use proactively" here to opt this agent into
   * the proactive-use protocol surfaced in the main system prompt.
   */
  whenToUse: string;
  /** Brief description for activity logs / UI / events. */
  description: string;
  /** System prompt the subagent runs with. */
  systemPrompt: string;
  /**
   * Allow-list of tool names. Mutually exclusive with `disallowedTools`.
   * If neither set, subagent inherits the full registry + MCP tools.
   */
  tools?: string[];
  /** Deny-list of tool names. */
  disallowedTools?: string[];
  /** Max agentic steps before stopping. Default 20. */
  maxSteps?: number;
  /** Optional model override (provider-dependent). */
  model?: string;
  /** Display label used in the UI's SubagentCard. Defaults to titlecased agentType. */
  label?: string;
  /**
   * Skip injecting project rules (AGENTS.md / CLAUDE.md / .cursor/rules/*)
   * into this subagent's system prompt. Set true for fast read-only
   * exploration agents — the rules carry commit/PR/lint guidance the
   * subagent will never act on, and the parent already interprets results
   * with full context.
   */
  omitProjectRules?: boolean;
}

// ── MCP ─────────────────────────────────────────

export interface MCPServerStdio {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface MCPServerHTTP {
  url: string;
  transport?: "http" | "sse";
  headers?: Record<string, string>;
}

export type MCPServerConfig = MCPServerStdio | MCPServerHTTP;

export interface MCPServerStatus {
  name: string;
  status: "connected" | "error" | "disconnected";
  tools: string[];
  error?: string;
}

// ── Todo ────────────────────────────────────────

export type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled";

export interface TodoItem {
  id: string;
  content: string;
  status: TodoStatus;
}

// ── App Config ──────────────────────────────────

export interface CompactionConfig {
  /** Master switch — when false, proactive auto-compact is skipped (manual /compact still works). */
  enabled: boolean;
  /** Model's context window size in tokens. Used to dynamically compute compact threshold. */
  contextWindow: number;
  /** Number of most-recent tool results to keep verbatim during micro-compaction. */
  microCompactKeepRecent: number;
  /** Max number of recently-read files to re-inject post-compact. */
  maxFilesToRestore: number;
  /** Max tokens (estimated) per restored file. */
  maxTokensPerFile: number;
  /** Total token budget for all restored files combined. */
  fileBudget: number;
}

export interface AppConfig {
  provider: LlmProfile;
  compaction: CompactionConfig;
  mcpServers: Record<string, MCPServerConfig>;
  /** Tool names to hide from the model (local or MCP, e.g. `web_fetch`, `someServer_fetch`) */
  disabledTools?: string[];
}
