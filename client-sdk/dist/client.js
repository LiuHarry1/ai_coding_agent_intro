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
export class AgentClientError extends Error {
    status;
    body;
    constructor(message, status, body) {
        super(message);
        this.status = status;
        this.body = body;
        this.name = "AgentClientError";
    }
}
export class AgentClient {
    #baseURL;
    #defaultWorkspace;
    #headers;
    #fetch;
    constructor(opts) {
        if (!opts.baseURL)
            throw new Error("AgentClient: baseURL is required");
        // Strip trailing slash so URL joining never doubles it.
        this.#baseURL = opts.baseURL.replace(/\/$/, "");
        this.#defaultWorkspace = opts.defaultWorkspace;
        this.#headers = opts.headers ?? {};
        this.#fetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
        if (!this.#fetch) {
            throw new Error("AgentClient: no fetch available; pass `fetch` in options on runtimes <Node18.");
        }
    }
    // ── discovery ──────────────────────────────────────────────────────
    /** List skills discoverable for a workspace (active + conditional). */
    async listSkills(workspace) {
        const ws = workspace ?? this.#defaultWorkspace;
        const qs = ws ? `?workspace=${encodeURIComponent(ws)}` : "";
        return this.#getJSON(`/skills${qs}`);
    }
    /** List subagents (built-in + project-level `.agents/`). */
    async listAgents(workspace) {
        const ws = workspace ?? this.#defaultWorkspace;
        const qs = ws ? `?workspace=${encodeURIComponent(ws)}` : "";
        return this.#getJSON(`/agents${qs}`);
    }
    // ── direct skill invocation ────────────────────────────────────────
    /**
     * Run a skill directly, bypassing the model's "should I use this skill"
     * decision. For `context: "inline"` skills this is a pure template
     * expansion — no LLM call. For `context: "fork"` skills it spins up a
     * subagent and waits for completion (use `invokeSkillStream` for SSE).
     */
    async invokeSkill(name, req = {}) {
        const body = {
            ...req,
            workspace: req.workspace ?? this.#defaultWorkspace,
            stream: false,
        };
        return this.#postJSON(`/skills/${encodeURIComponent(name)}/invoke?stream=false`, body);
    }
    /**
     * Streaming variant of `invokeSkill`. Inline skills surface as a
     * single text_delta + finish; fork skills emit the full subagent event
     * stream (text_delta / tool_call / tool_result / finish).
     */
    invokeSkillStream(name, req = {}, signal) {
        const body = {
            ...req,
            workspace: req.workspace ?? this.#defaultWorkspace,
        };
        return this.#postSSE(`/skills/${encodeURIComponent(name)}/invoke`, body, signal);
    }
    // ── free-form chat ─────────────────────────────────────────────────
    /**
     * One-shot chat: fires a turn, waits for the agent's final text,
     * resolves to JSON. Easier than SSE when you don't need progress
     * updates ("review this diff and tell me what's wrong").
     */
    async chatComplete(req) {
        const body = {
            ...req,
            workspace: req.workspace ?? this.#defaultWorkspace,
            stream: false,
        };
        return this.#postJSON("/chat?stream=false", body);
    }
    /**
     * Streaming chat. Use when you want to render tokens as they arrive,
     * see tool calls live, or cancel mid-turn via the AbortSignal.
     */
    chat(req, signal) {
        const body = {
            ...req,
            workspace: req.workspace ?? this.#defaultWorkspace,
        };
        return this.#postSSE("/chat", body, signal);
    }
    // ── low-level helpers ──────────────────────────────────────────────
    async #getJSON(path) {
        const res = await this.#fetch(this.#baseURL + path, {
            method: "GET",
            headers: { Accept: "application/json", ...this.#headers },
        });
        return this.#parseJSON(res);
    }
    async #postJSON(path, body) {
        const res = await this.#fetch(this.#baseURL + path, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Accept: "application/json",
                ...this.#headers,
            },
            body: JSON.stringify(body),
        });
        return this.#parseJSON(res);
    }
    async #parseJSON(res) {
        const text = await res.text();
        let parsed;
        try {
            parsed = text.length > 0 ? JSON.parse(text) : null;
        }
        catch (e) {
            throw new AgentClientError(`Invalid JSON from server: ${e.message}`, res.status, text);
        }
        if (!res.ok) {
            const msg = parsed?.error ??
                `HTTP ${res.status}`;
            throw new AgentClientError(msg, res.status, parsed);
        }
        return parsed;
    }
    async *#postSSE(path, body, signal) {
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
            let parsed = text;
            try {
                parsed = JSON.parse(text);
            }
            catch {
                /* leave as raw text */
            }
            const msg = parsed?.error ?? `HTTP ${res.status}`;
            throw new AgentClientError(msg, res.status, parsed);
        }
        if (!res.body) {
            throw new AgentClientError("Empty response body", res.status, null);
        }
        yield* parseSSE(res.body, signal);
    }
}
//# sourceMappingURL=client.js.map