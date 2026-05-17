import type {
  AssistantContentPart,
  Message,
  ToolResultPart,
} from "../types.js";

/**
 * Maximum number of historical `ReasoningPart`s to inline into the next
 * request. Older reasoning is dropped from the prompt entirely (it still
 * lives on disk and renders in the UI on session reload — this only
 * affects what we resend to the LLM).
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
 * Placeholder used when we have to synthesize a tool-result for an
 * assistant tool-call that has no real result on disk (stream cut between
 * tool-call and tool-result, session resumed from a truncated JSONL, etc.).
 * Matches Claude Code's `SYNTHETIC_TOOL_RESULT_PLACEHOLDER` semantically.
 */
export const SYNTHETIC_TOOL_RESULT_PLACEHOLDER =
  "[Tool result missing due to internal error]";

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
export function sanitizeReasoningParts(messages: Message[]): void {
  for (const msg of messages) {
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
    for (const part of msg.content) {
      delete (part as { providerOptions?: unknown }).providerOptions;
    }
  }
}

/**
 * Replace every `ReasoningPart` in the conversation with a plain `TextPart`
 * wrapped in `<thinking>…</thinking>` markers. Used right before we hand
 * the messages to the SDK so:
 *
 *   - The Responses API request never contains `{type:"reasoning", id,
 *     encrypted_content}` items (which require a stateful upstream).
 *   - chat/completions / copilot-api proxies just see normal assistant text.
 *   - The model still has visibility into prior chains-of-thought (lossy
 *     but better than nothing).
 *
 * Only the last `KEEP_RECENT_REASONINGS` reasoning parts are inlined;
 * older ones are silently dropped to keep prompt growth bounded.
 *
 * Returns shallow copies; the original `messages` array is not mutated.
 */
export function inlineReasoningAsText(messages: Message[]): Message[] {
  // First pass (back-to-front): mark the most recent N reasoning parts to
  // keep. WeakSet keyed by the part reference makes the second pass cheap.
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

/**
 * Defensive bidirectional check of tool-call ↔ tool-result pairing across
 * the ENTIRE message history. Runs once per step in O(n).
 *
 * Two directions:
 *   - Forward: assistant `tool-call` with no matching `tool-result` in the
 *     next tool message → inject a synthetic `[Tool result missing…]`
 *     tool-result so OpenAI's Responses API doesn't 400 on unmatched
 *     `tool_call_id`s.
 *   - Reverse: a `tool-result` whose `toolCallId` doesn't appear in the
 *     preceding assistant's tool-calls → strip it. These orphans come from
 *     session-resume bugs and trigger the mirror 400 ("tool_use_id not
 *     found").
 *
 * Replaces both the per-step `ensureToolResultsPresent` AND the
 * pre-request `ensureToolResultPairing` from the old code. Same invariant,
 * one pass, applied to the whole history right before every streamText
 * call.
 *
 * Returns a new array — does not mutate `messages`. Logs once per repair
 * so the underlying bug stays visible.
 */
export function ensureToolResultPairing(messages: Message[]): Message[] {
  const out: Message[] = [];
  let injected = 0;
  let stripped = 0;

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;

    if (m.role !== "assistant" || !Array.isArray(m.content)) {
      // Start-of-conversation orphan handling (mirrors Claude Code's
      // messages.ts:5161-5200): a `tool` message at index 0 — or any `tool`
      // message NOT immediately preceded by an assistant in our output —
      // has tool-results whose paired tool-calls don't exist. This is the
      // shape we get when a session is resumed after a compaction step
      // dropped the assistant tool-calls but the on-disk JSONL still
      // starts with tool-results. The downstream assistant-lookahead
      // branch (below) only catches the assistant→tool adjacency case;
      // orphans at the very start slip past unless we strip them here.
      if (m.role === "tool" && Array.isArray(m.content) && out.at(-1)?.role !== "assistant") {
        const original = m.content.length;
        // Drop every tool-result — there's no preceding assistant to pair
        // against, so EVERY result here is orphaned. If something other
        // than tool-result lives in this message (shouldn't, by schema),
        // keep it.
        const kept = m.content.filter((p) => p.type !== "tool-result");
        if (kept.length !== original) {
          stripped += original - kept.length;
          // Empty content would leave the API with two non-tool messages
          // in a row (or worse, an empty tool block) — neither is valid.
          // Drop the message entirely when nothing's left.
          if (kept.length > 0) out.push({ role: "tool", content: kept });
          continue;
        }
      }
      out.push(m);
      continue;
    }

    const toolCalls: { id: string; name: string }[] = [];
    for (const p of m.content) {
      if (p.type === "tool-call") {
        const tc = p as { toolCallId: string; toolName: string };
        toolCalls.push({ id: tc.toolCallId, name: tc.toolName });
      }
    }

    out.push(m);
    if (toolCalls.length === 0) continue;

    const next = messages[i + 1];
    const isNextToolMsg = next?.role === "tool" && Array.isArray(next.content);
    const existingResultIds = new Set<string>();
    if (isNextToolMsg) {
      for (const p of next!.content as ToolResultPart[]) {
        if (p.type === "tool-result") existingResultIds.add(p.toolCallId);
      }
    }

    const callIdSet = new Set(toolCalls.map((tc) => tc.id));
    const missing = toolCalls.filter((tc) => !existingResultIds.has(tc.id));
    const orphans = new Set<string>();
    for (const rid of existingResultIds) {
      if (!callIdSet.has(rid)) orphans.add(rid);
    }

    if (missing.length === 0 && orphans.size === 0) {
      if (isNextToolMsg) {
        out.push(next!);
        i++;
      }
      continue;
    }

    injected += missing.length;
    stripped += orphans.size;

    const syntheticParts: ToolResultPart[] = missing.map((tc) => ({
      type: "tool-result",
      toolCallId: tc.id,
      toolName: tc.name,
      output: { type: "text", value: SYNTHETIC_TOOL_RESULT_PLACEHOLDER },
    }));

    if (isNextToolMsg) {
      const kept = (next!.content as ToolResultPart[]).filter(
        (p) => !(p.type === "tool-result" && orphans.has(p.toolCallId)),
      );
      // Synthetic blocks go FIRST so their order matches the assistant's
      // tool-call order — some providers care about that alignment.
      out.push({ role: "tool", content: [...syntheticParts, ...kept] });
      i++;
    } else if (syntheticParts.length > 0) {
      out.push({ role: "tool", content: syntheticParts });
    }
  }

  if (injected > 0 || stripped > 0) {
    console.warn(
      `[agent] ensureToolResultPairing repaired conversation: ` +
        `+${injected} synthetic tool-results, -${stripped} orphan tool-results`,
    );
  }

  return out;
}
