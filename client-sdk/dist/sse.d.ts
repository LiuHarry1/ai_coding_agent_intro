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
import type { AgentEvent } from "./types.js";
/**
 * Wrap a fetch `ReadableStream<Uint8Array>` and yield one decoded event
 * per SSE record. Surfaces unrecognized event names as
 * `{ type: "unknown", event, data }` so additive server changes don't
 * crash existing callers.
 */
export declare function parseSSE(stream: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<AgentEvent>;
//# sourceMappingURL=sse.d.ts.map