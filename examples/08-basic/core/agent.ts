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
  Message,
  UserMessage,
  UserContentPart,
  TodoItem,
  TodoStatus,
} from "./types.js";
import {
  ensureToolResultPairing,
  inlineReasoningAsText,
  sanitizeReasoningParts,
} from "./agent/message-sanitize.js";
import { applyCacheControlBreakpoint } from "./agent/cache-control.js";
import { consumeStream, type StreamResult } from "./agent/stream-consumer.js";
import { TOOL_SEARCH_TOOL_NAME } from "../tools/tool_search.js";
import type { AnyTool } from "./types.js";

// ── User-message helpers ────────────────────────────

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

// ── Todo helpers ────────────────────────────────────

function autoCompleteTodos(todos: TodoItem[], eventBus: AgentOptions["eventBus"]): void {
  const hasIncomplete = todos.some(
    (t) => t.status === "pending" || t.status === "in_progress",
  );
  if (!hasIncomplete) return;
  const updated = todos.map((t) =>
    t.status === "pending" || t.status === "in_progress"
      ? { ...t, status: "completed" as TodoStatus }
      : t,
  );
  eventBus.emit("todo_update", { todos: updated });
}

function formatTodoReminder(todos: TodoItem[]): string {
  const lines = todos.map((t) => `- [${t.status}] ${t.id}: ${t.content}`);
  return `[Active todo list — update via todo_write(merge=true) as you complete items]\n${lines.join("\n")}`;
}

/**
 * After a full compaction we may have rewritten the entire history. If the
 * pre-compaction state had an active todo list, re-attach it as a system
 * reminder on the last assistant message so the model doesn't forget what
 * it was working on. Mutates `messages` in place.
 */
function attachTodoReminderAfterCompaction(
  messages: Message[],
  todos: TodoItem[],
): void {
  if (todos.length === 0) return;
  const last = messages[messages.length - 1];
  if (last?.role !== "assistant" || !Array.isArray(last.content)) return;
  const existing = last.content.find((p) => p.type === "text");
  const reminder = "\n\n" + formatTodoReminder(todos);
  if (existing && "text" in existing) {
    existing.text += reminder;
  } else {
    last.content.push({ type: "text", text: reminder });
  }
}

// ── Deferred-tool activation ────────────────────────

/**
 * After each step, check if the model called `tool_search`. If so,
 * extract the `matches` array from tool results and move matching tools
 * from the deferred pool into the active set so the next step can use
 * them. Mirrors CC's mid-turn tool activation flow.
 */
function activateDeferredTools(
  toolCalls: StreamResult["toolCalls"],
  pool: Record<string, AnyTool>,
  active: Record<string, AnyTool>,
  discovered: Set<string>,
): void {
  for (const tc of toolCalls) {
    if (tc.toolName !== TOOL_SEARCH_TOOL_NAME) continue;

    // The tool_search execute returns { matches: string[], text, ... }.
    // In the stream result, the input is what we sent; the result comes
    // via the corresponding toolResult entry.  But we can also parse the
    // query's select: prefix to know what was requested.  Simplest: look
    // at the query input and activate all names found in the pool.
    const query = (tc.input as any)?.query as string | undefined;
    if (!query) continue;

    const trimmed = query.trim();
    let names: string[] = [];

    if (trimmed.toLowerCase().startsWith("select:")) {
      names = trimmed
        .slice(7)
        .split(",")
        .map((n) => n.trim())
        .filter(Boolean);
    } else {
      // For keyword queries, we can't know exact matches until the result.
      // Activate all pool tools whose name partially matches the keywords.
      const kw = trimmed.toLowerCase().split(/\s+/).filter(Boolean);
      for (const name of Object.keys(pool)) {
        if (kw.some((k) => name.toLowerCase().includes(k))) {
          names.push(name);
        }
      }
    }

    for (const name of names) {
      if (pool[name] && !active[name]) {
        active[name] = pool[name];
        delete pool[name];
        discovered.add(name);
        console.log(`[agent] activated deferred tool: ${name}`);
      }
    }
  }
}

// ── runAgent ────────────────────────────────────────

// Two independent retry budgets:
//   - ctxLengthAttempt (max 1): on 413 / context_length_exceeded, run
//     aggressive compaction and try once more.
//   - transientAttempt (max 2): on socket-closed / 5xx / undici
//     "terminated", just resend with backoff (proxy hiccup, no
//     compaction needed). Common with copilot-api on long bodies.
const MAX_TRANSIENT_RETRIES = 2;

export async function runAgent(
  userMessage: string,
  {
    tools,
    systemPrompt,
    eventBus,
    messages = [],
    images,
    maxSteps = 80,
    model,
    subagentNames,
    skillListing,
    deferredToolPool,
  }: AgentOptions,
): Promise<string> {
  if (skillListing) {
    messages.push({
      role: "user",
      content: `<system-reminder>\n${skillListing}\n</system-reminder>`,
    });
  }
  messages.push(buildUserMessage(userMessage, images));

  let finalText = "";
  const provider = defaultManager.get();
  const resolvedModel = model ?? provider.defaultModelId();

  let currentTodos: TodoItem[] = [];
  const unsubTodo = eventBus.on("todo_update", (data) => {
    currentTodos = (data as { todos: TodoItem[] }).todos;
  });

  // Mutable copy so we can activate deferred tools mid-loop.
  const activeTools = { ...tools };
  const pool = deferredToolPool ? { ...deferredToolPool } : undefined;

  try {
    for (let step = 0; step < maxSteps; step++) {
      eventBus.emit("step_start", { step });
      const stepStart = Date.now();

      await runCompactionAndLog(messages, eventBus, step, resolvedModel, provider, currentTodos);

      const stepResult = await runOneStep({
        messages,
        tools: activeTools,
        systemPrompt,
        provider,
        resolvedModel,
        eventBus,
        subagentNames,
        step,
        stepStart,
        currentTodos,
      });

      if (stepResult === null) {
        return finalText;
      }

      const { text, toolCalls } = stepResult;
      if (text) finalText = text;

      // Activate tools discovered via tool_search in this step.
      if (pool) {
        const newlyDiscovered = new Set<string>();
        activateDeferredTools(toolCalls, pool, activeTools, newlyDiscovered);
        if (newlyDiscovered.size > 0) {
          eventBus.emit("tools_discovered", {
            tools: [...newlyDiscovered],
          });
        }
      }

      if (toolCalls.length === 0) {
        autoCompleteTodos(currentTodos, eventBus);
        eventBus.emit("done", { steps: step + 1 });
        return finalText;
      }

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

async function runCompactionAndLog(
  messages: Message[],
  eventBus: AgentOptions["eventBus"],
  step: number,
  resolvedModel: string,
  provider: ReturnType<typeof defaultManager.get>,
  currentTodos: TodoItem[],
): Promise<void> {
  const compactStart = Date.now();
  const managed = await compactIfNeeded(messages, eventBus);
  const compactMs = Date.now() - compactStart;

  const counted = tokenCountWithEstimation(messages);
  const tokenLabel =
    counted.source === "real+est"
      ? `${counted.total.toLocaleString()} tokens ` +
        `(${counted.realBaseline?.toLocaleString()} real + ${counted.estimatedDelta?.toLocaleString()} est)`
      : `~${counted.total.toLocaleString()} tokens (est, no usage cached yet)`;
  console.log(
    `[agent] step ${step} start — ${messages.length} msgs, ${tokenLabel}, ` +
      `model=${resolvedModel}, llm=${provider.describe()}` +
      (compactMs > 50 ? `, compaction=${compactMs}ms` : ""),
  );

  if (managed !== messages) {
    messages.length = 0;
    messages.push(...managed);
    attachTodoReminderAfterCompaction(messages, currentTodos);
  }
}

interface RunOneStepArgs {
  messages: Message[];
  tools: AgentOptions["tools"];
  systemPrompt: string;
  provider: ReturnType<typeof defaultManager.get>;
  resolvedModel: string;
  eventBus: AgentOptions["eventBus"];
  subagentNames?: Set<string>;
  step: number;
  stepStart: number;
  currentTodos: TodoItem[];
}

/**
 * One LLM round-trip, including reactive compaction / transient retry.
 *
 * Returns `null` when the step terminally fails (error + done events
 * already emitted, caller should return finalText immediately). Returns
 * the StreamResult on success.
 */
async function runOneStep(args: RunOneStepArgs): Promise<StreamResult | null> {
  const {
    messages,
    tools,
    systemPrompt,
    provider,
    resolvedModel,
    eventBus,
    subagentNames,
    step,
    stepStart,
  } = args;

  let ctxLengthAttempt = 0;
  let transientAttempt = 0;
  let reactiveCompacted = false;
  let requestStart = Date.now();

  while (true) {
    try {
      const stream = streamText({
        model: provider.chatModel(resolvedModel),
        system: systemPrompt,
        // Triple-pass message preparation before the SDK sees them:
        //   1. inlineReasoningAsText — rewrite reasoning blocks as
        //      <thinking> text so the request is portable across stateless
        //      proxies (copilot-api, etc.).
        //   2. ensureToolResultPairing — guarantee every assistant
        //      tool-call has a matching tool-result and strip orphan
        //      tool-results. Without this, ANY historical damage (a prior
        //      step where the stream got cut, a session resumed from a
        //      truncated JSONL, etc.) deadlocks the next request with a
        //      400 from the Responses API.
        //   3. applyCacheControlBreakpoint — attach a single
        //      `cache_control: ephemeral` marker to the last message when
        //      the provider supports prompt caching (Anthropic). No-op
        //      for OpenAI (auto-cached) and openai-compatible (no caching).
        messages: applyCacheControlBreakpoint(
          ensureToolResultPairing(inlineReasoningAsText(messages)),
          provider,
        ),
        tools,
        maxRetries: 3,
        ...provider.streamTextExtras(),
      });

      const timing = { firstEventMs: 0 };
      const stepResult = await consumeStream(stream, eventBus, timing, subagentNames);

      // Trust the SDK's response.messages for ordering (reasoning → text
      // → tool-call → tool-result). Then strip OpenAI-specific
      // providerOptions so what we persist is the human-readable summary.
      const response = await stream.response;
      const sdkMessages = response.messages as unknown as Message[];
      sanitizeReasoningParts(sdkMessages);
      messages.push(...sdkMessages);

      // AI SDK exposes usage as a settled-after-stream promise. Stateless
      // proxies that drop the final SSE event may leave fields undefined.
      let usage: AttachedTokenUsage = {};
      try {
        usage = (await stream.usage) ?? {};
      } catch {
        // Don't fail the step over a missing telemetry counter.
      }
      // Cache real usage onto the last assistant message of this step's
      // response — next step's tokenCountWithEstimation uses it as the
      // precise baseline.
      if (usage.inputTokens != null || usage.totalTokens != null) {
        for (let i = sdkMessages.length - 1; i >= 0; i--) {
          if (sdkMessages[i].role === "assistant") {
            attachTokenUsage(sdkMessages[i], usage);
            break;
          }
        }
      }

      logStepCompletion({
        step,
        stepStart,
        requestStart,
        firstEventMs: timing.firstEventMs,
        sdkMessages,
        toolCallsLen: stepResult.toolCalls.length,
        usage,
        reactiveCompacted,
      });
      return stepResult;
    } catch (err) {
      if (ctxLengthAttempt === 0 && isContextLengthError(err)) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.warn(
          `[agent] step ${step} hit context-length error → reactive aggressive compaction. ${errMsg}`,
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
        continue;
      }
      if (transientAttempt < MAX_TRANSIENT_RETRIES && isTransientStreamError(err)) {
        transientAttempt++;
        // Exponential backoff: 500ms, 1500ms.
        const backoffMs = 500 * Math.pow(3, transientAttempt - 1);
        const errMsg = err instanceof Error ? err.message : String(err);
        console.warn(
          `[agent] step ${step} transient stream error (attempt ${transientAttempt}/${MAX_TRANSIENT_RETRIES}), retrying in ${backoffMs}ms: ${errMsg}`,
        );
        eventBus.emit("transient_retry", {
          attempt: transientAttempt,
          max: MAX_TRANSIENT_RETRIES,
          backoffMs,
          error: errMsg,
        });
        await new Promise((r) => setTimeout(r, backoffMs));
        requestStart = Date.now();
        continue;
      }
      // Terminal failure: surface to UI, end the agent loop gracefully so
      // the SSE stream closes cleanly and the session stays usable.
      const message = err instanceof Error ? err.message : String(err);
      const cause =
        err instanceof Error && err.cause instanceof Error ? ` (${err.cause.message})` : "";
      console.error(`[agent] step ${step} failed: ${message}${cause}`);
      eventBus.emit("error", {
        message: `Upstream stream failed: ${message}${cause}. Try again or check your proxy logs.`,
      });
      autoCompleteTodos(args.currentTodos, eventBus);
      eventBus.emit("done", { steps: step + 1 });
      return null;
    }
  }
}

interface LogArgs {
  step: number;
  stepStart: number;
  requestStart: number;
  firstEventMs: number;
  sdkMessages: Message[];
  toolCallsLen: number;
  usage: AttachedTokenUsage;
  reactiveCompacted: boolean;
}

function logStepCompletion(a: LogArgs): void {
  const fmt = (n: number | undefined): string =>
    typeof n === "number" ? n.toLocaleString() : "?";
  const totalMs = Date.now() - a.requestStart;
  const ttfb = a.firstEventMs ? a.firstEventMs - a.requestStart : -1;
  const generationMs = ttfb >= 0 ? totalMs - ttfb : -1;
  const reasoningCount = a.sdkMessages.reduce(
    (n, m) =>
      n +
      (m.role === "assistant" && Array.isArray(m.content)
        ? m.content.filter((p) => p.type === "reasoning").length
        : 0),
    0,
  );
  const usageParts = [
    `in=${fmt(a.usage.inputTokens)}`,
    `out=${fmt(a.usage.outputTokens)}`,
  ];
  if (typeof a.usage.reasoningTokens === "number" && a.usage.reasoningTokens > 0) {
    usageParts.push(`reasoning=${fmt(a.usage.reasoningTokens)}`);
  }
  if (typeof a.usage.cachedInputTokens === "number" && a.usage.cachedInputTokens > 0) {
    usageParts.push(`cached=${fmt(a.usage.cachedInputTokens)}`);
  }
  console.log(
    `[agent] step ${a.step} done — total=${totalMs}ms ` +
      `(ttfb=${ttfb}ms upstream-wait, gen=${generationMs}ms streaming), ` +
      `usage[${usageParts.join(" ")}], ` +
      `reasoning_blocks=${reasoningCount}, tool_calls=${a.toolCallsLen}, ` +
      `step_total=${Date.now() - a.stepStart}ms` +
      (a.reactiveCompacted ? ", reactive_compaction=yes" : ""),
  );
}
