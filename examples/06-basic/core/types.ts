import type { LanguageModel, Tool } from "ai";

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
  wrap(name: string, executeFn: (args: unknown) => Promise<unknown>): (args: unknown) => Promise<unknown>;
}

// ── Tool Registry ───────────────────────────────

export interface ToolContext {
  eventBus: IEventBus;
  middleware?: IMiddleware;
  runAgent?: RunAgentFn;
  registry?: IToolRegistry;
}

export interface ToolDefinition {
  name: string;
  description: string;
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
}

export type UserContentPart = TextPart | ImagePart;
export type AssistantContentPart = TextPart | ToolCallPart;

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
}

export type RunAgentFn = (userMessage: string, options: AgentOptions) => Promise<string>;

// ── Provider ────────────────────────────────────

export interface IProvider {
  chatModel(model: string): LanguageModel;
}

export interface ProviderConfig {
  name?: string;
  baseURL?: string;
  apiKey?: string;
}

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
}

export interface SessionInfo {
  id: string;
  createdAt?: number;
  messageCount: number;
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

export interface SubagentConfig {
  name: string;
  description: string;
  systemPrompt: string;
  tools: string[];
  maxSteps?: number;
  label?: string;
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

export interface MCPConfig {
  mcpServers: Record<string, MCPServerConfig>;
}

export interface MCPServerStatus {
  name: string;
  status: "connected" | "error" | "disconnected";
  tools: string[];
  error?: string;
}
