/**
 * AgentClient — typed HTTP client for the coding agent backend.
 *
 * One class, three thin layers:
 *
 *   - Discovery:   listSkills(), listAgents()
 *   - Direct:      invokeSkill(name, …) — JSON for inline, async-iter for fork
 *   - Free-form:   chat({...}) / chatComplete({...}) / chatStream({...})
 *
 * Streaming methods return an `AsyncIterable<AgentEvent>`. Buffered
 * methods (`chatComplete`, `invokeSkill` for inline) resolve to plain
 * objects. No EventSource dependency — works in Node ≥18, browsers,
 * Bun, edge runtimes; anywhere `fetch` + `ReadableStream` exist.
 *
 * Errors thrown:
 *   - `AgentClientError`        — server returned a non-2xx
 *   - `TypeError`               — fetch-level failure (network, DNS)
 *   - `SyntaxError`             — server sent bad JSON
 *   - Cancellation via the optional `AbortSignal` parameter.
 */
import type { AgentEvent, AgentsListResponse, ChatJSONResult, ChatRequest, SkillInvokeRequest, SkillInvokeResult, SkillsListResponse } from "./types.js";
export interface AgentClientOptions {
    /** Origin (and optional pathname prefix) of the agent backend. */
    baseURL: string;
    /**
     * Per-request default workspace path (resolved server-side). Callers
     * can still override on every call. Useful when one client instance
     * always talks about the same project.
     */
    defaultWorkspace?: string;
    /**
     * Forwarded into every fetch. Use this to inject `X-API-Key` once
     * (when you turn auth on later) instead of threading it through every
     * call site.
     */
    headers?: Record<string, string>;
    /**
     * Override the fetch implementation. Lets you wrap with retries,
     * tracing, etc. without subclassing. Defaults to `globalThis.fetch`.
     */
    fetch?: typeof fetch;
}
export declare class AgentClientError extends Error {
    readonly status: number;
    readonly body: unknown;
    constructor(message: string, status: number, body: unknown);
}
export declare class AgentClient {
    #private;
    constructor(opts: AgentClientOptions);
    /** List skills discoverable for a workspace (active + conditional). */
    listSkills(workspace?: string): Promise<SkillsListResponse>;
    /** List subagents (built-in + project-level `.agents/`). */
    listAgents(workspace?: string): Promise<AgentsListResponse>;
    /**
     * Run a skill directly, bypassing the model's "should I use this skill"
     * decision. For `context: "inline"` skills this is a pure template
     * expansion — no LLM call. For `context: "fork"` skills it spins up a
     * subagent and waits for completion (use `invokeSkillStream` for SSE).
     */
    invokeSkill(name: string, req?: SkillInvokeRequest): Promise<SkillInvokeResult>;
    /**
     * Streaming variant of `invokeSkill`. Inline skills surface as a
     * single text_delta + finish; fork skills emit the full subagent event
     * stream (text_delta / tool_call / tool_result / finish).
     */
    invokeSkillStream(name: string, req?: SkillInvokeRequest, signal?: AbortSignal): AsyncIterable<AgentEvent>;
    /**
     * One-shot chat: fires a turn, waits for the agent's final text,
     * resolves to JSON. Easier than SSE when you don't need progress
     * updates ("review this diff and tell me what's wrong").
     */
    chatComplete(req: ChatRequest): Promise<ChatJSONResult>;
    /**
     * Streaming chat. Use when you want to render tokens as they arrive,
     * see tool calls live, or cancel mid-turn via the AbortSignal.
     */
    chat(req: ChatRequest, signal?: AbortSignal): AsyncIterable<AgentEvent>;
}
//# sourceMappingURL=client.d.ts.map