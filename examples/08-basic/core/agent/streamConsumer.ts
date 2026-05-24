import type { streamText } from "ai";
import type { AgentOptions } from "../types.js";
import { appendPreviewDelta, maybeStartPreview, type PreviewState } from "./previewStream.js";
import { formatToolError } from "./toolErrors.js";

export interface StreamResult {
  text: string;
  toolCalls: Array<{ toolCallId: string; toolName: string; input: Record<string, unknown> }>;
  toolResults: Array<{ toolCallId: string; toolName: string; result: string }>;
}

// Event types that represent actual upstream content (not SDK-side
// bookkeeping like "start" / "start-step"). We tag the first occurrence of
// any of these as our real time-to-first-byte.
const CONTENT_EVENT_TYPES = new Set([
  "reasoning-start",
  "reasoning-delta",
  "text-delta",
  "tool-input-start",
  "tool-input-delta",
  "tool-call",
]);

/** AI SDK maps provider `delta` → `text` in most paths; read both for safety. */
function streamPartText(e: { text?: string; delta?: string }): string {
  const t = e.text;
  const d = e.delta;
  if (typeof t === "string" && t.length > 0) return t;
  if (typeof d === "string" && d.length > 0) return d;
  return typeof t === "string" ? t : typeof d === "string" ? d : "";
}

/**
 * AI SDK v5 used `{ id, delta }` for tool-input-delta; v6 renamed it to
 * `{ toolCallId, inputTextDelta }`. Read both so the same code works
 * across SDK upgrades — without this fallback v6 silently broke streaming
 * previews (file content only appeared after the entire tool call
 * completed).
 */
function readInputDelta(event: unknown): { id?: string; delta?: string } {
  const e = event as {
    id?: string;
    toolCallId?: string;
    delta?: string;
    inputTextDelta?: string;
  };
  return { id: e.id ?? e.toolCallId, delta: e.inputTextDelta ?? e.delta };
}

/**
 * Drives the full SDK stream for a single agent step. Pumps upstream
 * events into:
 *   1. `eventBus` — for the SSE transport (frontend rendering).
 *   2. `toolCalls` / `toolResults` accumulators — for the agent loop's
 *      next-step bookkeeping (retry budget, paired-result invariant).
 *   3. `timing.firstEventMs` — for TTFB logging.
 *
 * Also handles two edge cases the SDK leaves to the caller:
 *   - `tool-error` events (Zod validation failure / execute() throw):
 *     synthesize a paired tool_call + tool_result so the next request
 *     stays well-formed.
 *   - Orphan `tool-input-start`s that never reached tool-call (upstream
 *     cut mid-args, model hit max_tokens during a giant write_file, ...):
 *     same synthesis, with a concrete reason in the message.
 */
export async function consumeStream(
  stream: ReturnType<typeof streamText>,
  eventBus: AgentOptions["eventBus"],
  timing?: { firstEventMs: number },
  subagentNames?: Set<string>,
): Promise<StreamResult> {
  const isSubagentName = (n?: string): boolean =>
    !!(n && subagentNames && subagentNames.has(n));

  const toolCalls: StreamResult["toolCalls"] = [];
  const toolResults: StreamResult["toolResults"] = [];
  let text = "";
  let reasoningStarted = false;

  /** Per-toolCallId preview state. Cleared on tool-call / tool-error. */
  const previewStates = new Map<string, PreviewState>();
  /** Every toolCallId that fired tool-input-start. Drained on tool-call / tool-error / tool-result; survivors become synthetic results. */
  const startedInputs = new Map<string, string | undefined>();

  const flushReasoning = (): void => {
    if (reasoningStarted) {
      eventBus.emit("reasoning_end", {});
      reasoningStarted = false;
    }
  };

  /**
   * Push a synthetic (toolCall, toolResult) pair onto the bus + local
   * accumulators. Used by both `tool-error` (Zod / execute throws) and
   * orphan-input cleanup (stream ended mid-args). Centralized so future
   * additions to the StreamResult shape only need to touch one place.
   */
  const synthesizePair = (
    id: string,
    name: string,
    input: Record<string, unknown>,
    result: string,
  ): void => {
    eventBus.emit("tool_call", {
      name,
      args: input,
      toolCallId: id,
      isSubagent: isSubagentName(name),
    });
    eventBus.emit("tool_result", { name, result, toolCallId: id });
    toolCalls.push({ toolCallId: id, toolName: name, input });
    toolResults.push({ toolCallId: id, toolName: name, result });
    previewStates.delete(id);
    startedInputs.delete(id);
  };

  for await (const event of stream.fullStream) {
    if (timing && !timing.firstEventMs && CONTENT_EVENT_TYPES.has(event.type)) {
      timing.firstEventMs = Date.now();
    }
    switch (event.type) {
      case "reasoning-start":
        reasoningStarted = true;
        eventBus.emit("reasoning_start", {});
        break;

      case "reasoning-delta": {
        if (!reasoningStarted) {
          reasoningStarted = true;
          eventBus.emit("reasoning_start", {});
        }
        const delta = streamPartText(event);
        if (delta) eventBus.emit("reasoning_delta", { delta });
        break;
      }

      case "reasoning-end":
        flushReasoning();
        break;

      case "text-delta": {
        flushReasoning();
        const delta = streamPartText(event);
        if (delta) {
          text += delta;
          eventBus.emit("text_delta", { delta });
        }
        break;
      }

      case "tool-input-start": {
        flushReasoning();
        const e = event as { id?: string; toolCallId?: string; toolName?: string };
        const id = e.id ?? e.toolCallId;
        if (!id) break;
        startedInputs.set(id, e.toolName);
        eventBus.emit("tool_input_start", {
          toolCallId: id,
          name: e.toolName,
          isSubagent: isSubagentName(e.toolName),
        });
        const preview = maybeStartPreview(e.toolName);
        if (preview) previewStates.set(id, preview);
        break;
      }

      case "tool-input-delta": {
        const { id, delta } = readInputDelta(event);
        if (!id || !delta) break;

        eventBus.emit("tool_input_delta", { toolCallId: id, bytes: delta.length });

        const state = previewStates.get(id);
        if (state) {
          const newlyDecoded = appendPreviewDelta(state, delta);
          if (newlyDecoded) {
            eventBus.emit("tool_input_preview_delta", {
              toolCallId: id,
              delta: newlyDecoded,
            });
          }
        }
        break;
      }

      case "tool-call":
        flushReasoning();
        eventBus.emit("tool_call", {
          name: event.toolName,
          args: event.input,
          toolCallId: event.toolCallId,
          isSubagent: isSubagentName(event.toolName),
        });
        toolCalls.push({
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          input: event.input as Record<string, unknown>,
        });
        previewStates.delete(event.toolCallId);
        startedInputs.delete(event.toolCallId);
        break;

      case "tool-error": {
        // SDK emits this when (a) inputSchema validation fails — the
        // single most common cause of the synthetic "Missing tool result"
        // we used to surface — or (b) execute() threw. Either way the SDK
        // will NOT also emit a tool-result, so we must synthesize one
        // ourselves; otherwise the Responses API 400s on an unmatched
        // tool_call_id, and the frontend's tool card hangs forever.
        const e = event as {
          toolCallId: string;
          toolName: string;
          error?: unknown;
          input?: unknown;
        };
        synthesizePair(
          e.toolCallId,
          e.toolName,
          (e.input ?? {}) as Record<string, unknown>,
          `Error: ${formatToolError(e.toolName, e.error)}`,
        );
        break;
      }

      case "tool-result": {
        const raw = event.output;
        const result = typeof raw === "string" ? raw : JSON.stringify(raw);
        eventBus.emit("tool_result", {
          name: event.toolName,
          result,
          toolCallId: event.toolCallId,
        });
        toolResults.push({
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          result,
        });
        startedInputs.delete(event.toolCallId);
        break;
      }

      case "error":
        eventBus.emit("error", { message: String(event.error) });
        break;
    }
  }

  flushReasoning();

  // Any toolCallId still in `startedInputs` had a `tool-input-start` but
  // never reached `tool-call` / `tool-error` / `tool-result`. That means
  // the upstream stream was cut off mid-args (transient proxy disconnect,
  // model hit max_tokens while writing a giant payload, etc.). Synthesize
  // a clear error so the frontend's spinner transitions to a real result.
  for (const [id, toolName] of startedInputs.entries()) {
    synthesizePair(
      id,
      toolName ?? "unknown",
      {},
      "Error: Tool call was started but never completed " +
        "(upstream stream interrupted before arguments finished — " +
        "likely a proxy timeout or the model hit its output token limit).",
    );
  }

  backfillMissingResults(toolCalls, toolResults, eventBus);
  return { text, toolCalls, toolResults };
}

/**
 * Last-resort safety net. By the time we reach here we've already handled
 * `tool-error` inline and synthesized results for any orphan
 * `tool-input-start`s, so this should fire only when the SDK delivered a
 * fully-parsed `tool-call` event without any matching result OR error —
 * i.e. a genuine SDK/runtime bug, not a model-args problem. Note that
 * fact in the message so future debugging doesn't get sent chasing
 * input-schema phantoms again.
 */
function backfillMissingResults(
  toolCalls: StreamResult["toolCalls"],
  toolResults: StreamResult["toolResults"],
  eventBus: AgentOptions["eventBus"],
): void {
  const seen = new Set(toolResults.map((tr) => tr.toolCallId));
  for (const tc of toolCalls) {
    if (seen.has(tc.toolCallId)) continue;
    const result =
      `Error: Internal — tool-call for ${tc.toolName} (id ${tc.toolCallId}) ` +
      `was received but neither tool-result nor tool-error followed. ` +
      `This indicates a bug in the AI SDK runtime, not a problem with ` +
      `the tool's arguments. Please retry.`;
    console.error(`[agent] ${result}`);
    eventBus.emit("tool_result", { name: tc.toolName, result, toolCallId: tc.toolCallId });
    toolResults.push({ toolCallId: tc.toolCallId, toolName: tc.toolName, result });
  }
}
