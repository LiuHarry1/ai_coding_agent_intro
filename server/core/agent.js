import { streamText } from "ai";
import { createProvider } from "./provider.js";

const provider = createProvider();

export async function runAgent(message, { tools, systemPrompt, sendSSE, maxSteps = 30 }) {
  sendSSE("thinking", {});

  let stream;
  try {
    stream = streamText({
      model: provider.chatModel("gpt-4"),
      system: systemPrompt,
      prompt: message,
      tools,
      maxSteps,
    });
  } catch (err) {
    sendSSE("error", { message: err.message });
    return;
  }

  let stepCount = 0;

  try {
    for await (const event of stream.fullStream) {
      switch (event.type) {
        case "start-step":
          stepCount++;
          break;

        case "text-delta":
          sendSSE("text_delta", { delta: event.text });
          break;

        case "tool-call":
          sendSSE("tool_call", {
            name: event.toolName,
            args: event.input ?? event.args,
          });
          break;

        case "tool-result":
          sendSSE("tool_result", {
            name: event.toolName,
            result: typeof event.result === "string" ? event.result : JSON.stringify(event.result),
          });
          sendSSE("thinking", {});
          break;

        case "error":
          sendSSE("error", { message: String(event.error) });
          break;
      }
    }
  } catch (err) {
    sendSSE("error", { message: err.message });
  }

  sendSSE("done", { stepCount });
}
