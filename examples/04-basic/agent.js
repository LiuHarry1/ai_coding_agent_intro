import { streamText } from "ai";
import { createProvider } from "../../shared/provider.js";
import { summarizeIfNeeded } from "./context.js";

const provider = createProvider();

/**
 * Shared agent loop — used by both the primary agent AND subagents.
 *
 * Primary agent: called with session messages, full tool set, sendSSE for UI.
 * Subagent:      called with messages=[] (fresh context), limited tools,
 *                prefixed sendSSE so UI can distinguish subagent events.
 *
 * Returns the final text response (used by subagents to pass result back).
 */
export async function runAgent(userMessage, { tools, systemPrompt, sendSSE, messages = [], maxSteps = 40 }) {
  messages.push({ role: "user", content: userMessage });

  let finalText = "";

  for (let step = 0; step < maxSteps; step++) {
    sendSSE("step_start", { step });

    const managed = await summarizeIfNeeded(messages, sendSSE);
    if (managed !== messages) {
      messages.length = 0;
      messages.push(...managed);
    }

    const stream = streamText({
      model: provider.chatModel("gpt-5.2"),
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

    if (textAccum) finalText = textAccum;

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
      return finalText;
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
  return finalText;
}
