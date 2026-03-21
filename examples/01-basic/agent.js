import { streamText } from "ai";
import { createProvider } from "../../shared/provider.js";

const provider = createProvider();

/**
 * Agent Loop — the core of any coding agent.
 *
 * Unlike a simple chatbot that calls the model once,
 * an agent LOOPS:
 *   1. Send messages to the model
 *   2. Model returns text OR tool_calls
 *   3. If tool_calls → SDK executes them → we capture results
 *   4. Append assistant message + tool results to conversation
 *   5. Go back to step 1
 *   6. If text only (no tool_calls) → done
 *
 * This is exactly how Claude Code, Cursor, OpenCode, etc. work under the hood.
 */
export async function runAgent(userMessage, { tools, systemPrompt, sendSSE, maxSteps = 40 } ) {
  const messages = [
    { role: "user", content: userMessage },
  ];

  for (let step = 0; step < maxSteps; step++) {
    sendSSE("step_start", { step });

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

        case "tool-error": {
          const errRaw = event.error ?? event.message ?? "Tool execution failed";
          const errText = typeof errRaw === "string" ? errRaw : JSON.stringify(errRaw);
          const result = `Error: ${errText}`;
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

    const seenIds = new Set(toolResults.map((tr) => tr.toolCallId));
    for (const tc of toolCalls) {
      if (!seenIds.has(tc.toolCallId)) {
        const result = `Error: Missing tool result for ${tc.toolName} (call ${tc.toolCallId}).`;
        sendSSE("tool_result", {
          name: tc.toolName,
          result,
          toolCallId: tc.toolCallId,
        });
        toolResults.push({
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          result,
        });
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
