import { streamText } from "ai";
import { defaultManager } from "./provider-manager.js";
import {
  attachTokenUsage,
  compactIfNeeded,
  isContextLengthError,
  isTransientStreamError,
  tokenCountWithEstimation,
} from "./context.js";
import type { AttachedTokenUsage } from "./context.js";
import type {
  AgentOptions,
  AssistantContentPart,
  Message,
  ReasoningPart,
  UserMessage,
  UserContentPart,
  ToolResultPart,
  TodoItem,
  TodoStatus,
} from "./types.js";

function parseDataUrl(dataUrl: string): { buffer: Buffer; mediaType: string } {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) throw new Error("Invalid data URL");
  return { mediaType: match[1], buffer: Buffer.from(match[2], "base64") };
}

function buildUserMessage(text: string, images?: string[]): UserMessage {
  if (!images || images.length === 0) {
    return { role: "user", content: text };
  }
  const parts: UserContentPart[] = [{ type: "text", text }];
  for (const dataUrl of images) {
    const { buffer, mediaType } = parseDataUrl(dataUrl);
    parts.push({ type: "image", image: buffer, mediaType });
  }
  return { role: "user", content: parts };
}

function autoCompleteTodos(todos: TodoItem[], eventBus: AgentOptions["eventBus"]): void {
  const hasIncomplete = todos.some((t) => t.status === "pending" || t.status === "in_progress");
  if (!hasIncomplete) return;

  const updated = todos.map((t) =>
    t.status === "pending" || t.status === "in_progress"
      ? { ...t, status: "completed" as TodoStatus }
      : t
  );
  eventBus.emit("todo_update", { todos: updated });
}

function formatTodoReminder(todos: TodoItem[]): string {
  const lines = todos.map((t) => `- [${t.status}] ${t.id}: ${t.content}`);
  return `[Active todo list — update via todo_write(merge=true) as you complete items]\n${lines.join("\n")}`;
}

/**
 * Strip OpenAI Responses-API specific fields from assistant content parts
 * before we persist them. The Responses API attaches `providerOptions.openai
 * .{itemId, reasoningEncryptedContent}` to reasoning, text, and tool-call
 * parts; on the next request the AI SDK serializes any part with an
 * `itemId` as `{type: "item_reference", id: ...}` instead of inline content.
 *
 * Stateless proxies (copilot-api, etc.) don't store those items server-side
 * → the request 404s on the second turn. We therefore drop providerOptions
 * from EVERY assistant part (not just reasoning) so the next request always
 * carries full inline content. Lossy vs OpenAI's native encrypted replay,
 * but portable.
 */
function sanitizeReasoningParts(messages: Message[]): void {
  for (const msg of messages) {
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
    for (const part of msg.content) {
      // All three of TextPart / ReasoningPart / ToolCallPart can carry
      // providerOptions. Strip them all — `delete` is a no-op when absent.
      delete (part as { providerOptions?: unknown }).providerOptions;
    }
  }
}

/**
 * Maximum number of historical `ReasoningPart`s to inline into the next
 * request. Older reasoning is dropped from the prompt entirely (it still
 * lives on disk and renders in the UI on session reload — this only affects
 * what we resend to the LLM).
 *
 * Why bound it: every turn we re-inline the full prior reasoning as plain
 * text. For deep reasoning models running 5-10 tool steps the prompt grows
 * super-linearly and quickly trips proxy body-size / timeout limits
 * (copilot-api, etc.). Keeping just the most recent block preserves the
 * "what was I just thinking before this tool result" context, which is the
 * piece that actually matters for the next decision.
 */
const KEEP_RECENT_REASONINGS = 1;

/**
 * Replace every `ReasoningPart` in the conversation with a plain `TextPart`
 * wrapped in `<thinking>…</thinking>` markers. Used right before we hand the
 * messages to the SDK so:
 *   - The Responses API request never contains `{type:"reasoning", id,
 *     encrypted_content}` items (which require a stateful upstream).
 *   - chat/completions / copilot-api proxies just see normal assistant text.
 *   - The model still has visibility into prior chains-of-thought (lossy but
 *     better than nothing).
 *
 * Only the last `KEEP_RECENT_REASONINGS` reasoning parts are inlined; older
 * ones are silently dropped from the request payload to keep prompt growth
 * bounded across multi-step agent loops.
 *
 * Returns shallow copies; the original `messages` array is not mutated so
 * sanitized reasoning parts remain in the on-disk session.
 */
function inlineReasoningAsText(messages: Message[]): Message[] {
  // First pass (back-to-front): mark the most recent N reasoning parts to
  // keep. We use a WeakSet keyed by the part object reference so the second
  // pass can decide cheaply per-part.
  const keep = new WeakSet<object>();
  let remaining = KEEP_RECENT_REASONINGS;
  for (let i = messages.length - 1; i >= 0 && remaining > 0; i--) {
    const m = messages[i];
    if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
    for (let j = m.content.length - 1; j >= 0 && remaining > 0; j--) {
      const part = m.content[j];
      if (part.type !== "reasoning") continue;
      keep.add(part);
      remaining--;
    }
  }

  return messages
    .map((m): Message | null => {
      // Token usage is held in a WeakMap (not on the message), so non-
      // assistant messages pass through untouched.
      if (m.role !== "assistant" || !Array.isArray(m.content)) return m;

      const newContent: AssistantContentPart[] = [];
      for (const part of m.content) {
        if (part.type === "reasoning") {
          if (!keep.has(part)) continue;
          const text = (part.text ?? "").trim();
          if (text) {
            newContent.push({
              type: "text",
              text: `<thinking>\n${text}\n</thinking>`,
            });
          }
          continue;
        }
        newContent.push(part);
      }

      if (newContent.length === 0) return null;
      return { role: "assistant", content: newContent };
    })
    .filter((m): m is Message => m !== null);
}

export async function runAgent(
  userMessage: string,
  { tools, systemPrompt, eventBus, messages = [], images, maxSteps = 80, model }: AgentOptions
): Promise<string> {
  messages.push(buildUserMessage(userMessage, images));

  let finalText = "";
  const provider = defaultManager.get();
  const resolvedModel = model ?? provider.defaultModelId();

  let currentTodos: TodoItem[] = [];
  const unsubTodo = eventBus.on("todo_update", (data) => {
    currentTodos = (data as { todos: TodoItem[] }).todos;
  });

  try {
    for (let step = 0; step < maxSteps; step++) {
      eventBus.emit("step_start", { step });

      const stepStart = Date.now();
      const compactStart = Date.now();
      const managed = await compactIfNeeded(messages as Message[], eventBus);
      const compactMs = Date.now() - compactStart;
      const counted = tokenCountWithEstimation(messages as Message[]);
      const tokenLabel =
        counted.source === "real+est"
          ? `${counted.total.toLocaleString()} tokens ` +
            `(${counted.realBaseline?.toLocaleString()} real + ${counted.estimatedDelta?.toLocaleString()} est)`
          : `~${counted.total.toLocaleString()} tokens (est, no usage cached yet)`;
      console.log(
        `[agent] step ${step} start — ${messages.length} msgs, ${tokenLabel}, ` +
          `model=${resolvedModel}, llm=${provider.describe()}` +
          (compactMs > 50 ? `, compaction=${compactMs}ms` : "")
      );
      if (managed !== messages) {
        messages.length = 0;
        messages.push(...managed);

        if (currentTodos.length > 0) {
          const lastMsg = messages[messages.length - 1];
          if (lastMsg.role === "assistant" && Array.isArray(lastMsg.content)) {
            const existing = lastMsg.content.find((p) => p.type === "text");
            const reminder = "\n\n" + formatTodoReminder(currentTodos);
            if (existing && "text" in existing) {
              existing.text += reminder;
            } else {
              lastMsg.content.push({ type: "text", text: reminder });
            }
          }
        }
      }

      let stepResult: { text: string; toolCalls: StreamResult["toolCalls"]; toolResults: StreamResult["toolResults"] };
      let reactiveCompacted = false;
      let ctxLengthAttempt = 0;
      let transientAttempt = 0;
      // Two independent retry budgets:
      //   - ctxLengthAttempt (max 1): on 413 / context_length_exceeded, run
      //     aggressive compaction (clear tool_results + summarize down to
      //     the last 5K-token tail) and try once more.
      //   - transientAttempt (max 2): on socket-closed / 5xx / undici
      //     "terminated", just resend with backoff (proxy hiccup, no
      //     compaction needed). These are common with copilot-api on long
      //     bodies / slow models.
      const MAX_TRANSIENT_RETRIES = 2;
      let requestStart = Date.now();
      retry: while (true) {
        try {
          const stream = streamText({
            model: provider.chatModel(resolvedModel),
            system: systemPrompt,
            // Inline any prior `ReasoningPart` as `<thinking>…</thinking>` text so
            // we don't depend on `{type:"reasoning", id, encrypted_content}`
            // round-tripping. This makes the request portable across stateless
            // proxies (copilot-api, etc.) at the cost of being lossy compared to
            // OpenAI's native encrypted replay.
            messages: inlineReasoningAsText(messages),
            tools,
            maxRetries: 3,
            ...provider.streamTextExtras(),
          });

          const timing = { firstEventMs: 0 };
          stepResult = await consumeStream(stream, eventBus, timing);

          // Trust the SDK's response.messages for ordering (reasoning → text →
          // tool-call → tool-result). We then strip the OpenAI-specific
          // providerOptions from reasoning parts so what we persist is just the
          // human-readable summary text. The next turn re-inlines those parts as
          // `<thinking>…</thinking>` text via `inlineReasoningAsText`.
          const response = await stream.response;
          const sdkMessages = response.messages as unknown as Message[];
          sanitizeReasoningParts(sdkMessages);
          messages.push(...sdkMessages);

          // AI SDK exposes usage as a promise that settles after the stream
          // completes. Some providers (or stateless proxies that drop the
          // final SSE event) leave fields undefined — guard with `?? "?"`.
          let usage: AttachedTokenUsage = {};
          try {
            usage = (await stream.usage) ?? {};
          } catch {
            // Some providers throw on usage access when the stream ended
            // abruptly (e.g. mid-stream socket close survived by retries).
            // Don't fail the whole step over a missing telemetry counter.
          }
          // Cache the real usage onto the last assistant message of this
          // step's response. Next step's `tokenCountWithEstimation` walks
          // back, finds it, and uses it as the precise baseline rather
          // than guessing the whole prefix from chars/4. Mirrors Claude
          // Code's pattern in utils/tokens.ts:226.
          if (usage.inputTokens != null || usage.totalTokens != null) {
            for (let i = sdkMessages.length - 1; i >= 0; i--) {
              if (sdkMessages[i].role === "assistant") {
                attachTokenUsage(sdkMessages[i], usage);
                break;
              }
            }
          }
          const fmt = (n: number | undefined): string =>
            typeof n === "number" ? n.toLocaleString() : "?";

          const totalMs = Date.now() - requestStart;
          const ttfb = timing.firstEventMs ? timing.firstEventMs - requestStart : -1;
          const reasoningCount = sdkMessages.reduce(
            (n, m) =>
              n +
              (m.role === "assistant" && Array.isArray(m.content)
                ? m.content.filter((p) => p.type === "reasoning").length
                : 0),
            0
          );
          const generationMs = ttfb >= 0 ? totalMs - ttfb : -1;
          const usageParts = [
            `in=${fmt(usage.inputTokens)}`,
            `out=${fmt(usage.outputTokens)}`,
          ];
          if (typeof usage.reasoningTokens === "number" && usage.reasoningTokens > 0) {
            usageParts.push(`reasoning=${fmt(usage.reasoningTokens)}`);
          }
          if (typeof usage.cachedInputTokens === "number" && usage.cachedInputTokens > 0) {
            usageParts.push(`cached=${fmt(usage.cachedInputTokens)}`);
          }
          console.log(
            `[agent] step ${step} done — total=${totalMs}ms ` +
              `(ttfb=${ttfb}ms upstream-wait, gen=${generationMs}ms streaming), ` +
              `usage[${usageParts.join(" ")}], ` +
              `reasoning_blocks=${reasoningCount}, tool_calls=${stepResult.toolCalls.length}, ` +
              `step_total=${Date.now() - stepStart}ms` +
              (reactiveCompacted ? ", reactive_compaction=yes" : "")
          );
          break retry;
        } catch (err) {
          if (ctxLengthAttempt === 0 && isContextLengthError(err)) {
            const errMsg = err instanceof Error ? err.message : String(err);
            console.warn(
              `[agent] step ${step} hit context-length error → reactive aggressive compaction. ${errMsg}`
            );
            eventBus.emit("compaction_reactive", { error: errMsg });
            const recompacted = await compactIfNeeded(messages, eventBus, {
              force: true,
              aggressive: true,
            });
            if (recompacted !== messages) {
              messages.length = 0;
              messages.push(...recompacted);
            }
            ctxLengthAttempt++;
            reactiveCompacted = true;
            requestStart = Date.now();
            continue retry;
          }
          if (transientAttempt < MAX_TRANSIENT_RETRIES && isTransientStreamError(err)) {
            transientAttempt++;
            // Exponential backoff: 500ms, 1500ms. Keeps us under most proxy
            // idle-timeout windows while giving the upstream a chance to
            // recover.
            const backoffMs = 500 * Math.pow(3, transientAttempt - 1);
            const errMsg = err instanceof Error ? err.message : String(err);
            console.warn(
              `[agent] step ${step} transient stream error (attempt ${transientAttempt}/${MAX_TRANSIENT_RETRIES}), retrying in ${backoffMs}ms: ${errMsg}`
            );
            eventBus.emit("transient_retry", {
              attempt: transientAttempt,
              max: MAX_TRANSIENT_RETRIES,
              backoffMs,
              error: errMsg,
            });
            await new Promise((r) => setTimeout(r, backoffMs));
            requestStart = Date.now();
            continue retry;
          }
          // Anything thrown here (mid-stream socket close from a flaky proxy,
          // upstream 5xx, etc.) used to escape as an unhandled rejection and
          // crash the Node process. Catch it, surface it to the UI, and end
          // the agent loop gracefully so the SSE stream closes cleanly and the
          // session stays usable.
          const message = err instanceof Error ? err.message : String(err);
          const cause = err instanceof Error && err.cause instanceof Error ? ` (${err.cause.message})` : "";
          console.error(`[agent] step ${step} failed: ${message}${cause}`);
          eventBus.emit("error", {
            message: `Upstream stream failed: ${message}${cause}. Try again or check your proxy logs.`,
          });
          autoCompleteTodos(currentTodos, eventBus);
          eventBus.emit("done", { steps: step + 1 });
          return finalText;
        }
      }

      const { text, toolCalls, toolResults } = stepResult;
      if (text) finalText = text;

      if (toolCalls.length === 0) {
        autoCompleteTodos(currentTodos, eventBus);
        eventBus.emit("done", { steps: step + 1 });
        return finalText;
      }

      // Safety net: if the SDK didn't emit a tool-result for some tool-call
      // (e.g. an exception inside execute), append a synthetic error result so
      // the next turn's request is well-formed.
      ensureToolResultsPresent(messages, toolCalls, toolResults);

      eventBus.emit("thinking", {});
    }

    autoCompleteTodos(currentTodos, eventBus);
    eventBus.emit("error", { message: `Reached max steps (${maxSteps})` });
    eventBus.emit("done", { steps: maxSteps });
    return finalText;
  } finally {
    unsubTodo();
  }
}

interface StreamResult {
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

async function consumeStream(
  stream: ReturnType<typeof streamText>,
  eventBus: AgentOptions["eventBus"],
  timing?: { firstEventMs: number }
): Promise<StreamResult> {
  const toolCalls: StreamResult["toolCalls"] = [];
  const toolResults: StreamResult["toolResults"] = [];
  let text = "";
  let reasoningStarted = false;

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
        if (delta) {
          eventBus.emit("reasoning_delta", { delta });
        }
        break;
      }

      case "reasoning-end":
        if (reasoningStarted) {
          eventBus.emit("reasoning_end", {});
          reasoningStarted = false;
        }
        break;

      case "text-delta": {
        if (reasoningStarted) {
          eventBus.emit("reasoning_end", {});
          reasoningStarted = false;
        }
        const delta = streamPartText(event);
        if (delta) {
          text += delta;
          eventBus.emit("text_delta", { delta });
        }
        break;
      }

      case "tool-input-start": {
        // Fired when the model begins streaming a tool-call's argument JSON
        // (before it's fully parsed). We use it to surface a placeholder card
        // immediately so the user sees something during long arg generation
        // (e.g. an edit_file with a 2000-token new_string).
        if (reasoningStarted) {
          eventBus.emit("reasoning_end", {});
          reasoningStarted = false;
        }
        const e = event as { id?: string; toolCallId?: string; toolName?: string };
        const id = e.id ?? e.toolCallId;
        if (id) {
          eventBus.emit("tool_input_start", {
            toolCallId: id,
            name: e.toolName,
          });
        }
        break;
      }

      case "tool-input-delta": {
        // Each delta is a chunk of the partial JSON args. We don't try to
        // parse it (would need a tolerant JSON parser); we just count bytes
        // so the UI can show "Generating arguments… 1.2k chars" progress.
        const e = event as { id?: string; toolCallId?: string; delta?: string };
        const id = e.id ?? e.toolCallId;
        if (id && e.delta) {
          eventBus.emit("tool_input_delta", {
            toolCallId: id,
            bytes: e.delta.length,
          });
        }
        break;
      }

      case "tool-call":
        if (reasoningStarted) {
          eventBus.emit("reasoning_end", {});
          reasoningStarted = false;
        }
        eventBus.emit("tool_call", {
          name: event.toolName,
          args: event.input,
          toolCallId: event.toolCallId,
        });
        toolCalls.push({
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          input: event.input as Record<string, unknown>,
        });
        break;

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
        break;
      }

      case "error":
        eventBus.emit("error", { message: String(event.error) });
        break;
    }
  }

  if (reasoningStarted) {
    eventBus.emit("reasoning_end", {});
  }

  backfillMissingResults(toolCalls, toolResults, eventBus);
  return { text, toolCalls, toolResults };
}

function backfillMissingResults(
  toolCalls: StreamResult["toolCalls"],
  toolResults: StreamResult["toolResults"],
  eventBus: AgentOptions["eventBus"]
): void {
  const seen = new Set(toolResults.map((tr) => tr.toolCallId));
  for (const tc of toolCalls) {
    if (seen.has(tc.toolCallId)) continue;
    const result = `Error: Missing tool result for ${tc.toolName} (call ${tc.toolCallId}).`;
    eventBus.emit("tool_result", { name: tc.toolName, result, toolCallId: tc.toolCallId });
    toolResults.push({ toolCallId: tc.toolCallId, toolName: tc.toolName, result });
  }
}

/**
 * Walk the messages we just appended from `response.messages` and make sure
 * every tool-call has a matching tool-result. If the SDK dropped one (e.g. a
 * thrown execute that didn't produce a result message), append a synthetic
 * error result so the next request stays well-formed for the OpenAI
 * Responses API (which 400s on unmatched tool_call_ids).
 */
function ensureToolResultsPresent(
  messages: Message[],
  toolCalls: StreamResult["toolCalls"],
  toolResults: StreamResult["toolResults"]
): void {
  const haveResultIds = new Set<string>();
  for (const m of messages) {
    if (m.role !== "tool") continue;
    for (const part of m.content) {
      if (part.type === "tool-result") haveResultIds.add(part.toolCallId);
    }
  }

  const missing = toolCalls.filter((tc) => !haveResultIds.has(tc.toolCallId));
  if (missing.length === 0) return;

  const resultById = new Map(toolResults.map((tr) => [tr.toolCallId, tr.result]));
  const parts: ToolResultPart[] = missing.map((tc) => ({
    type: "tool-result",
    toolCallId: tc.toolCallId,
    toolName: tc.toolName,
    output: {
      type: "text",
      value:
        resultById.get(tc.toolCallId) ??
        `Error: Missing tool result for ${tc.toolName} (call ${tc.toolCallId}).`,
    },
  }));
  messages.push({ role: "tool", content: parts });
}
