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

import { parseSSE } from "./sse.js";
import type {
  AgentEvent,
  AgentsListResponse,
  ChatJSONResult,
  ChatRequest,
  SkillInvokeRequest,
  SkillInvokeResult,
  SkillsListResponse,
} from "./types.js";

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

export class AgentClientError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = "AgentClientError";
  }
}

export class AgentClient {
  readonly #baseURL: string;
  readonly #defaultWorkspace?: string;
  readonly #headers: Record<string, string>;
  readonly #fetch: typeof fetch;

  constructor(opts: AgentClientOptions) {
    if (!opts.baseURL) throw new Error("AgentClient: baseURL is required");
    // Strip trailing slash so URL joining never doubles it.
    this.#baseURL = opts.baseURL.replace(/\/$/, "");
    this.#defaultWorkspace = opts.defaultWorkspace;
    this.#headers = opts.headers ?? {};
    this.#fetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
    if (!this.#fetch) {
      throw new Error(
        "AgentClient: no fetch available; pass `fetch` in options on runtimes <Node18.",
      );
    }
  }

  // ── discovery ──────────────────────────────────────────────────────

  /** List skills discoverable for a workspace (active + conditional). */
  async listSkills(workspace?: string): Promise<SkillsListResponse> {
    const ws = workspace ?? this.#defaultWorkspace;
    const qs = ws ? `?workspace=${encodeURIComponent(ws)}` : "";
    return this.#getJSON<SkillsListResponse>(`/skills${qs}`);
  }

  /** List subagents (built-in + project-level `.agents/`). */
  async listAgents(workspace?: string): Promise<AgentsListResponse> {
    const ws = workspace ?? this.#defaultWorkspace;
    const qs = ws ? `?workspace=${encodeURIComponent(ws)}` : "";
    return this.#getJSON<AgentsListResponse>(`/agents${qs}`);
  }

  // ── direct skill invocation ────────────────────────────────────────

  /**
   * Run a skill directly, bypassing the model's "should I use this skill"
   * decision. For `context: "inline"` skills this is a pure template
   * expansion — no LLM call. For `context: "fork"` skills it spins up a
   * subagent and waits for completion (use `invokeSkillStream` for SSE).
   */
  async invokeSkill(
    name: string,
    req: SkillInvokeRequest = {},
  ): Promise<SkillInvokeResult> {
    const body = {
      ...req,
      workspace: req.workspace ?? this.#defaultWorkspace,
      stream: false,
    };
    return this.#postJSON<SkillInvokeResult>(
      `/skills/${encodeURIComponent(name)}/invoke?stream=false`,
      body,
    );
  }

  /**
   * Streaming variant of `invokeSkill`. Inline skills surface as a
   * single text_delta + finish; fork skills emit the full subagent event
   * stream (text_delta / tool_call / tool_result / finish).
   */
  invokeSkillStream(
    name: string,
    req: SkillInvokeRequest = {},
    signal?: AbortSignal,
  ): AsyncIterable<AgentEvent> {
    const body = {
      ...req,
      workspace: req.workspace ?? this.#defaultWorkspace,
    };
    return this.#postSSE(
      `/skills/${encodeURIComponent(name)}/invoke`,
      body,
      signal,
    );
  }

  // ── free-form chat ─────────────────────────────────────────────────

  /**
   * One-shot chat: fires a turn, waits for the agent's final text,
   * resolves to JSON. Easier than SSE when you don't need progress
   * updates ("review this diff and tell me what's wrong").
   */
  async chatComplete(req: ChatRequest): Promise<ChatJSONResult> {
    const body = {
      ...req,
      workspace: req.workspace ?? this.#defaultWorkspace,
      stream: false,
    };
    return this.#postJSON<ChatJSONResult>("/chat?stream=false", body);
  }

  /**
   * Streaming chat. Use when you want to render tokens as they arrive,
   * see tool calls live, or cancel mid-turn via the AbortSignal.
   */
  chat(req: ChatRequest, signal?: AbortSignal): AsyncIterable<AgentEvent> {
    const body = {
      ...req,
      workspace: req.workspace ?? this.#defaultWorkspace,
    };
    return this.#postSSE("/chat", body, signal);
  }

  // ── low-level helpers ──────────────────────────────────────────────

  async #getJSON<T>(path: string): Promise<T> {
    const res = await this.#fetch(this.#baseURL + path, {
      method: "GET",
      headers: { Accept: "application/json", ...this.#headers },
    });
    return this.#parseJSON<T>(res);
  }

  async #postJSON<T>(path: string, body: unknown): Promise<T> {
    const res = await this.#fetch(this.#baseURL + path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...this.#headers,
      },
      body: JSON.stringify(body),
    });
    return this.#parseJSON<T>(res);
  }

  async #parseJSON<T>(res: Response): Promise<T> {
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text.length > 0 ? JSON.parse(text) : null;
    } catch (e) {
      throw new AgentClientError(
        `Invalid JSON from server: ${(e as Error).message}`,
        res.status,
        text,
      );
    }
    if (!res.ok) {
      const msg =
        (parsed as { error?: string } | null)?.error ??
        `HTTP ${res.status}`;
      throw new AgentClientError(msg, res.status, parsed);
    }
    return parsed as T;
  }

  async *#postSSE(
    path: string,
    body: unknown,
    signal?: AbortSignal,
  ): AsyncGenerator<AgentEvent> {
    const res = await this.#fetch(this.#baseURL + path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        ...this.#headers,
      },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        /* leave as raw text */
      }
      const msg =
        (parsed as { error?: string } | null)?.error ?? `HTTP ${res.status}`;
      throw new AgentClientError(msg, res.status, parsed);
    }
    if (!res.body) {
      throw new AgentClientError("Empty response body", res.status, null);
    }
    yield* parseSSE(res.body, signal);
  }
}
