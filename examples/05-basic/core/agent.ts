import { streamText } from "ai";
import { defaultManager } from "./provider-manager.js";
import { summarizeIfNeeded } from "./context.js";
import type {
  AgentOptions,
  Message,
  AssistantContentPart,
  ToolResultPart,
} from "./types.js";

interface ToolCallRecord {
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
}

interface ToolResultRecord {
  toolCallId: string;
  toolName: string;
  result: string;
}

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

    const toolCalls: ToolCallRecord[] = [];
    const toolResults: ToolResultRecord[] = [];
    let textAccum = "";

    for await (const event of stream.fullStream) {
      switch (event.type) {
        case "text-delta": {
          const delta = (event as any).textDelta ?? event.text ?? "";
          if (delta) {
            textAccum += delta;
            eventBus.emit("text_delta", { delta });
          }
          break;
        }

        case "tool-call":
          eventBus.emit("tool_call", {
            name: event.toolName,
            args: event.input ?? (event as Record<string, unknown>).args,
            toolCallId: event.toolCallId,
          });
          toolCalls.push({
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            input: (event.input ?? (event as Record<string, unknown>).args) as Record<string, unknown>,
          });
          break;

        case "tool-result": {
          const raw = event.output ?? (event as Record<string, unknown>).result ?? "";
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

    const seenIds = new Set(toolResults.map((tr) => tr.toolCallId));
    for (const tc of toolCalls) {
      if (!seenIds.has(tc.toolCallId)) {
        const result = `Error: Missing tool result for ${tc.toolName} (call ${tc.toolCallId}).`;
        eventBus.emit("tool_result", {
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

    if (textAccum) finalText = textAccum;

    const assistantContent: AssistantContentPart[] = [];
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
      eventBus.emit("done", { steps: step + 1 });
      return finalText;
    }

    for (const tr of toolResults) {
      const toolResultPart: ToolResultPart = {
        type: "tool-result",
        toolCallId: tr.toolCallId,
        toolName: tr.toolName,
        output: { type: "text", value: tr.result },
      };
      messages.push({ role: "tool", content: [toolResultPart] });
    }

    eventBus.emit("thinking", {});
  }

  eventBus.emit("error", { message: `Reached max steps (${maxSteps})` });
  eventBus.emit("done", { steps: maxSteps });
  return finalText;
}
