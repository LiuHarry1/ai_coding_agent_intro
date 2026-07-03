/**
 * SSE parser and stream helpers for the agent backend wire format.
 */

import { AgentClientError } from "./errors.js";
import type { AgentEvent } from "./types.js";

const KNOWN_EVENTS = new Set([
  "session",
  "skill_start",
  "text_delta",
  "reasoning_delta",
  "tool_call",
  "tool_result",
  "finish",
  "error",
]);

export async function* parseSSE(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<AgentEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  const onAbort = () => {
    void reader.cancel().catch(() => {});
  };
  signal?.addEventListener("abort", onAbort);

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const raw = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const ev = parseOneEvent(raw);
        if (ev) yield ev;
      }
    }
    if (buffer.trim().length > 0) {
      const ev = parseOneEvent(buffer);
      if (ev) yield ev;
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }
}

/** Drain an event stream; prefer finish.text, else join text_delta chunks. */
export async function collectText(
  events: AsyncIterable<AgentEvent>,
): Promise<string> {
  const deltas: string[] = [];
  let final: string | undefined;

  for await (const ev of events) {
    switch (ev.type) {
      case "text_delta":
        deltas.push(ev.delta);
        break;
      case "finish":
        if (typeof ev.text === "string") final = ev.text;
        break;
      case "error":
        throw new AgentClientError(ev.message || "stream error", 0, ev);
    }
  }

  return final ?? deltas.join("");
}

function parseOneEvent(raw: string): AgentEvent | null {
  let eventName = "message";
  let dataLine = "";
  for (const line of raw.split("\n")) {
    if (line.startsWith("event:")) eventName = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLine = line.slice(5).trim();
  }
  if (!dataLine) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(dataLine);
  } catch {
    return { type: "unknown", event: eventName, data: dataLine };
  }

  return discriminate(eventName, parsed);
}

function discriminate(event: string, data: unknown): AgentEvent {
  if (!KNOWN_EVENTS.has(event)) {
    return { type: "unknown", event, data };
  }
  const fields =
    data && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : {};
  return { type: event, ...fields } as AgentEvent;
}
