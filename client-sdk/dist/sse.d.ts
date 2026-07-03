/**
 * SSE parser and stream helpers for the agent backend wire format.
 */
import type { AgentEvent } from "./types.js";
export declare function parseSSE(stream: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<AgentEvent>;
/** Drain an event stream; prefer finish.text, else join text_delta chunks. */
export declare function collectText(events: AsyncIterable<AgentEvent>): Promise<string>;
//# sourceMappingURL=sse.d.ts.map