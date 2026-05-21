/**
 * Minimal SSE parser tailored to the agent backend's wire format.
 *
 * We don't use the browser's `EventSource` because:
 *   - It can't POST a body, which `/chat` requires.
 *   - It auto-reconnects on close, which we want to control ourselves
 *     (a finished agent run should NOT trigger a new turn).
 *   - It's browser-only — we need this in Node too.
 *
 * The protocol the agent emits is a strict subset of the SSE spec:
 *
 *   event: <name>\n
 *   data: <json>\n
 *   \n
 *
 * No `id:` / `retry:` / multi-line `data:` blocks — so the parser stays
 * tiny. If the server ever starts emitting those, extend `flushEvent`.
 */
/**
 * Wrap a fetch `ReadableStream<Uint8Array>` and yield one decoded event
 * per SSE record. Surfaces unrecognized event names as
 * `{ type: "unknown", event, data }` so additive server changes don't
 * crash existing callers.
 */
export async function* parseSSE(stream, signal) {
    const reader = stream.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    // If the caller aborts, propagate to the underlying reader so the
    // upstream agent stops being charged for tokens we'll never read.
    const onAbort = () => {
        void reader.cancel().catch(() => { });
    };
    signal?.addEventListener("abort", onAbort);
    try {
        while (true) {
            const { value, done } = await reader.read();
            if (done)
                break;
            buffer += decoder.decode(value, { stream: true });
            // Events are delimited by a blank line. Split on \n\n and keep
            // the trailing partial in `buffer` for the next chunk.
            let sep;
            while ((sep = buffer.indexOf("\n\n")) !== -1) {
                const raw = buffer.slice(0, sep);
                buffer = buffer.slice(sep + 2);
                const ev = parseOneEvent(raw);
                if (ev)
                    yield ev;
            }
        }
        // Flush trailing record (server may not always send a final \n\n).
        if (buffer.trim().length > 0) {
            const ev = parseOneEvent(buffer);
            if (ev)
                yield ev;
        }
    }
    finally {
        signal?.removeEventListener("abort", onAbort);
        try {
            reader.releaseLock();
        }
        catch {
            /* already released */
        }
    }
}
function parseOneEvent(raw) {
    let eventName = "message";
    let dataLine = "";
    for (const line of raw.split("\n")) {
        if (line.startsWith("event:"))
            eventName = line.slice(6).trim();
        else if (line.startsWith("data:"))
            dataLine = line.slice(5).trim();
        // Other SSE fields (id:, retry:, comments) are intentionally ignored.
    }
    if (!dataLine)
        return null;
    let parsed;
    try {
        parsed = JSON.parse(dataLine);
    }
    catch {
        // Server sent a non-JSON data field — wrap as unknown so callers can
        // still observe it instead of having the whole stream die.
        return { type: "unknown", event: eventName, data: dataLine };
    }
    return discriminate(eventName, parsed);
}
function discriminate(event, data) {
    const d = (data ?? {});
    switch (event) {
        case "session":
            return { type: "session", session_id: String(d.session_id ?? "") };
        case "skill_start":
            return {
                type: "skill_start",
                skill: String(d.skill ?? ""),
                agentType: String(d.agentType ?? ""),
                workspace: String(d.workspace ?? ""),
            };
        case "text_delta":
            return { type: "text_delta", delta: String(d.delta ?? "") };
        case "reasoning_delta":
            return { type: "reasoning_delta", delta: String(d.delta ?? "") };
        case "tool_call":
            return {
                type: "tool_call",
                name: String(d.name ?? ""),
                toolCallId: String(d.toolCallId ?? ""),
                args: d.args,
            };
        case "tool_result":
            return {
                type: "tool_result",
                toolCallId: String(d.toolCallId ?? ""),
                result: String(d.result ?? ""),
            };
        case "finish":
            return {
                type: "finish",
                reason: String(d.reason ?? ""),
                text: typeof d.text === "string" ? d.text : undefined,
            };
        case "error":
            return { type: "error", message: String(d.message ?? "") };
        default:
            return { type: "unknown", event, data };
    }
}
//# sourceMappingURL=sse.js.map