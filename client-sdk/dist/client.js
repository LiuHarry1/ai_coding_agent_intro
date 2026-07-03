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
import { mintJwt } from "./auth.js";
import { AgentClientError } from "./errors.js";
import { parseSSE } from "./sse.js";
export class AgentClient {
    #baseURL;
    #defaultWorkspace;
    #headers;
    #fetch;
    #token;
    constructor(opts) {
        if (!opts.baseURL)
            throw new Error("AgentClient: baseURL is required");
        this.#baseURL = opts.baseURL.replace(/\/$/, "");
        this.#defaultWorkspace = opts.defaultWorkspace;
        this.#headers = opts.headers ?? {};
        this.#fetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
        if (!this.#fetch) {
            throw new Error("AgentClient: no fetch available; pass `fetch` in options on runtimes <Node18.");
        }
        if (opts.token) {
            this.#token = opts.token;
        }
        else if (opts.jwtSecret) {
            if (!opts.email) {
                throw new Error("AgentClient: email is required when minting from jwtSecret");
            }
            this.#token = mintJwt(opts.jwtSecret, opts.email, {
                username: opts.username,
                role: opts.role,
                ttlSeconds: opts.tokenTtl,
            });
        }
    }
    async health() {
        return this.#getJSON("/health");
    }
    async listSkills(workspace) {
        return this.#getJSON(this.#workspacePath("/skills", workspace));
    }
    async listAgents(workspace) {
        return this.#getJSON(this.#workspacePath("/agents", workspace));
    }
    async invokeSkill(name, req = {}) {
        return this.#postJSON(`/skills/${encodeURIComponent(name)}/invoke?stream=false`, this.#skillBody(req));
    }
    invokeSkillStream(name, req = {}, signal) {
        return this.#postSSE(`/skills/${encodeURIComponent(name)}/invoke`, this.#skillBody(req), signal);
    }
    async chatComplete(req) {
        return this.#postJSON("/chat?stream=false", this.#chatBody(req));
    }
    chat(req, signal) {
        return this.#postSSE("/chat", this.#chatBody(req), signal);
    }
    #workspacePath(path, workspace) {
        const ws = workspace ?? this.#defaultWorkspace;
        return ws ? `${path}?workspace=${encodeURIComponent(ws)}` : path;
    }
    #skillBody(req) {
        const body = {
            workspace: req.workspace ?? this.#defaultWorkspace,
        };
        if (req.arguments !== undefined)
            body.arguments = req.arguments;
        return body;
    }
    #chatBody(req) {
        const body = {
            message: req.message,
            workspace: req.workspace ?? this.#defaultWorkspace,
        };
        if (req.session_id)
            body.session_id = req.session_id;
        if (req.images?.length)
            body.images = req.images;
        return body;
    }
    #authHeaders() {
        const h = { ...this.#headers };
        if (this.#token)
            h.Authorization = `Bearer ${this.#token}`;
        return h;
    }
    async #getJSON(path) {
        const res = await this.#fetch(this.#baseURL + path, {
            method: "GET",
            headers: { Accept: "application/json", ...this.#authHeaders() },
        });
        return this.#parseJSON(res);
    }
    async #postJSON(path, body) {
        const res = await this.#fetch(this.#baseURL + path, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Accept: "application/json",
                ...this.#authHeaders(),
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
            const { message, body } = errorFromBody(parsed, res.status);
            throw new AgentClientError(message, res.status, body);
        }
        if (parsed !== null &&
            typeof parsed === "object" &&
            !Array.isArray(parsed)) {
            return parsed;
        }
        return { result: parsed };
    }
    async *#postSSE(path, body, signal) {
        const res = await this.#fetch(this.#baseURL + path, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Accept: "text/event-stream",
                ...this.#authHeaders(),
            },
            body: JSON.stringify(body),
            signal,
        });
        if (!res.ok) {
            const text = await res.text().catch(() => "");
            const { message, body: errBody } = parseErrorText(text, res.status);
            throw new AgentClientError(message, res.status, errBody);
        }
        if (!res.body) {
            throw new AgentClientError("Empty response body", res.status, null);
        }
        yield* parseSSE(res.body, signal);
    }
}
function errorFromBody(parsed, status) {
    return { message: errorMessage(parsed, status), body: parsed };
}
function parseErrorText(text, status) {
    let parsed = text;
    try {
        parsed = text ? JSON.parse(text) : null;
    }
    catch {
        /* keep raw text */
    }
    return errorFromBody(parsed, status);
}
function errorMessage(parsed, status) {
    if (parsed &&
        typeof parsed === "object" &&
        !Array.isArray(parsed) &&
        typeof parsed.error === "string") {
        return parsed.error;
    }
    return `HTTP ${status}`;
}
//# sourceMappingURL=client.js.map