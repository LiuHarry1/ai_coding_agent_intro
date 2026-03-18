import { streamText } from "ai";
import { createProvider } from "../../shared/provider.js";
import { truncateToolOutputs, summarizeIfNeeded } from "./context.js";

const provider = createProvider();

/**
 * Agent Loop with Context Management + Multi-Turn Support.
 *
 * Three additions compared to 02-basic:
 *
 *   1. Accepts an existing `messages` array (multi-turn history).
 *      New user message is appended, then the loop runs as usual.
 *
 *   2. truncateToolOutputs() — before each LLM call, replace old tool
 *      outputs with one-line summaries (microcompaction).
 *
 *   3. summarizeIfNeeded() — when message count exceeds threshold,
 *      compress old messages into a structured summary (compaction).
 */
export async function runAgent(userMessage, { tools, systemPrompt, sendSSE, messages = [], maxSteps = 40, cwd = null }) {
  messages.push({ role: "user", content: userMessage });

  for (let step = 0; step < maxSteps; step++) {
    sendSSE("step_start", { step });

    // ── Context management ────────────────────────────────
    // 1. Truncate old tool outputs (cheap, every iteration)
    truncateToolOutputs(messages);
    // 2. Summarize if long + rehydrate last read files (so agent doesn't re-read)
    await summarizeIfNeeded(messages, sendSSE, cwd);

    const stream = streamText({
      model: provider.chatModel("gpt-5.2"),
      //claude-opus-4.6
      //claude-sonnet-4.6
      //gpt-5.2-codex
      system: systemPrompt,
      messages,
      tools,
    });

    const toolCalls = [];
    const toolResults = [];
    let textAccum = "";

    for await (const event of stream.fullStream) {
      switch (event.type) {
        case "text-delta": {
          const delta = event.textDelta ?? event.text ?? "";
          if (delta) {
            textAccum += delta;
            sendSSE("text_delta", { delta });
          }
          break;
        }

        case "tool-call":
          sendSSE("tool_call", {
            name: event.toolName,
            args: event.input ?? event.args,
            toolCallId: event.toolCallId,
          });
          toolCalls.push({
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            input: event.input ?? event.args,
          });
          break;

        case "tool-result": {
          const raw = event.output ?? event.result ?? "";
          const result = typeof raw === "string" ? raw : JSON.stringify(raw);
          sendSSE("tool_result", {
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
          sendSSE("error", { message: String(event.error) });
          break;
      }
    }

    const assistantContent = [];
    if (textAccum) {
      assistantContent.push({ type: "text", text: textAccum });
    }
    for (const tc of toolCalls) {
      assistantContent.push({
        type: "tool-call",
        toolCallId: tc.toolCallId,
        toolName: tc.toolName,
        input: tc.input,
      });
    }
    messages.push({ role: "assistant", content: assistantContent });

    if (toolCalls.length === 0) {
      sendSSE("done", { steps: step + 1 });
      return;
    }

    for (const tr of toolResults) {
      messages.push({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: tr.toolCallId,
            toolName: tr.toolName,
            output: { type: "text", value: tr.result },
          },
        ],
      });
    }

    sendSSE("thinking", {});
  }

  sendSSE("error", { message: `Reached max steps (${maxSteps})` });
  sendSSE("done", { steps: maxSteps });
}
