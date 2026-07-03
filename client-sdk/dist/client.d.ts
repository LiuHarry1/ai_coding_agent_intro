/**
 * AgentClient — typed HTTP client for the coding agent backend.
 *
 * One class, three thin layers:
 *
 *   - Discovery:   listSkills(), listAgents(), health()
 *   - Direct:      invokeSkill(name, …) — JSON for inline, async-iter for fork
 *   - Free-form:   chat({...}) / chatComplete({...})
 *
 * Streaming methods return an `AsyncIterable<AgentEvent>`. Buffered
 * methods resolve to plain objects. Works in Node ≥18, browsers, Bun,
 * edge runtimes — anywhere `fetch` + `ReadableStream` exist.
 */
import type { AgentEvent, AgentsListResponse, ChatJSONResult, ChatRequest, SkillInvokeRequest, SkillInvokeResult, SkillsListResponse } from "./types.js";
export interface AgentClientOptions {
    baseURL: string;
    token?: string;
    jwtSecret?: string;
    email?: string;
    username?: string;
    role?: string;
    tokenTtl?: number;
    defaultWorkspace?: string;
    headers?: Record<string, string>;
    fetch?: typeof fetch;
}
export declare class AgentClient {
    #private;
    constructor(opts: AgentClientOptions);
    health(): Promise<{
        ok: boolean;
    }>;
    listSkills(workspace?: string): Promise<SkillsListResponse>;
    listAgents(workspace?: string): Promise<AgentsListResponse>;
    invokeSkill(name: string, req?: SkillInvokeRequest): Promise<SkillInvokeResult>;
    invokeSkillStream(name: string, req?: SkillInvokeRequest, signal?: AbortSignal): AsyncIterable<AgentEvent>;
    chatComplete(req: ChatRequest): Promise<ChatJSONResult>;
    chat(req: ChatRequest, signal?: AbortSignal): AsyncIterable<AgentEvent>;
}
//# sourceMappingURL=client.d.ts.map