/**
 * REFERENCE client — drop into the coding agent (src) to report
 * usage to the analytics backend. Fire-and-forget + batched so it never blocks
 * or fails a chat turn. This file is documentation, not wired in by default.
 *
 * Wiring suggestion: call `reportUsage(...)` from `logStepCompletion` in
 * `core/agent.ts` (it already has model, usage tokens, and timings), passing
 * the session's `ownerEmail` + `id` through the call chain.
 */

const ENDPOINT = process.env.ANALYTICS_URL ?? ""; // e.g. http://analytics:8200
const API_KEY = process.env.ANALYTICS_INGEST_API_KEY ?? "";
const FLUSH_MS = 5000;
const MAX_BATCH = 200;

export interface UsageReport {
  event_id?: string; // idempotency, e.g. `${sessionId}:${turnIndex}`
  ts?: string; // ISO; defaults to server now
  user_email?: string;
  session_id?: string;
  turn_index?: number;
  model?: string;
  provider?: string;
  source?: "agent" | "subagent";
  input_tokens?: number;
  output_tokens?: number;
  cached_input_tokens?: number;
  reasoning_tokens?: number;
  total_tokens?: number;
  latency_ms?: number;
  ttfb_ms?: number;
  tool_calls?: number;
}

const queue: UsageReport[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;

export function reportUsage(r: UsageReport): void {
  if (!ENDPOINT) return; // telemetry disabled
  queue.push(r);
  if (queue.length >= MAX_BATCH) {
    void flush();
  } else if (!timer) {
    timer = setTimeout(() => void flush(), FLUSH_MS);
  }
}

export async function flush(): Promise<void> {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (!ENDPOINT || queue.length === 0) return;
  const records = queue.splice(0, queue.length);
  try {
    await fetch(`${ENDPOINT}/v1/usage`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(API_KEY ? { "X-API-Key": API_KEY } : {}),
      },
      body: JSON.stringify({ records }),
    });
  } catch {
    // Swallow — telemetry must never break the agent. Optionally re-enqueue
    // with a cap if you want at-least-once delivery.
  }
}

/** Generic event (session lifecycle, tool invocation, error, ...). */
export async function reportEvent(evt: {
  type: string;
  event_id?: string;
  user_email?: string;
  session_id?: string;
  payload?: Record<string, unknown>;
}): Promise<void> {
  if (!ENDPOINT) return;
  try {
    await fetch(`${ENDPOINT}/v1/events`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(API_KEY ? { "X-API-Key": API_KEY } : {}),
      },
      body: JSON.stringify(evt),
    });
  } catch {
    /* swallow */
  }
}
