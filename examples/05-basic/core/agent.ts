import { streamText } from "ai";
import { defaultManager } from "./provider-manager.js";
import { summarizeIfNeeded } from "./context.js";
import type {
  AgentOptions,
  Message,
  AssistantContentPart,
  ToolResultPart,
} from "./types.js";

export async function runAgent(
  userMessage: string,
  { tools, systemPrompt, eventBus, messages = [], maxSteps = 40, model = "gpt-5.2" }: AgentOptions
): Promise<string> {
  messages.push({ role: "user", content: userMessage });

  let finalText = "";
  const provider = defaultManager.get();

  for (let step = 0; step < maxSteps; step++) {
    eventBus.emit("step_start", { step });

    const managed = await summarizeIfNeeded(messages as Message[], eventBus);
    if (managed !== messages) {
      messages.length = 0;
      messages.push(...managed);
    }

    const stream = streamText({
      model: provider.chatModel(model),
      system: systemPrompt,
      messages,
      tools,
    });

    const { text, toolCalls, toolResults } = await consumeStream(stream, eventBus);

    if (text) finalText = text;

    const assistantContent: AssistantContentPart[] = [];
    if (text) assistantContent.push({ type: "text", text });
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
      eventBus.emit("done", { steps: step + 1 });
      return finalText;
    }

    for (const tr of toolResults) {
      const part: ToolResultPart = {
        type: "tool-result",
        toolCallId: tr.toolCallId,
        toolName: tr.toolName,
        output: { type: "text", value: tr.result },
      };
      messages.push({ role: "tool", content: [part] });
    }

    eventBus.emit("thinking", {});
  }

  eventBus.emit("error", { message: `Reached max steps (${maxSteps})` });
  eventBus.emit("done", { steps: maxSteps });
  return finalText;
}

interface StreamResult {
  text: string;
  toolCalls: Array<{ toolCallId: string; toolName: string; input: Record<string, unknown> }>;
  toolResults: Array<{ toolCallId: string; toolName: string; result: string }>;
}

async function consumeStream(
  stream: ReturnType<typeof streamText>,
  eventBus: AgentOptions["eventBus"]
): Promise<StreamResult> {
  const toolCalls: StreamResult["toolCalls"] = [];
  const toolResults: StreamResult["toolResults"] = [];
  let text = "";

  for await (const event of stream.fullStream) {
    switch (event.type) {
      case "text-delta": {
        const delta = event.text;
        if (delta) {
          text += delta;
          eventBus.emit("text_delta", { delta });
        }
        break;
      }

      case "tool-call":
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
