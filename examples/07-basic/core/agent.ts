import { streamText } from "ai";
import { defaultManager } from "./provider-manager.js";
import { configManager } from "./config-manager.js";
import { summarizeIfNeeded } from "./context.js";
import type { AgentOptions, Message, UserMessage, UserContentPart, AssistantContentPart, ToolResultPart, TodoItem, TodoStatus, ReasoningEffort } from "./types.js";

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

export async function runAgent(
  userMessage: string,
  { tools, systemPrompt, eventBus, messages = [], images, maxSteps = 40, model }: AgentOptions
): Promise<string> {
  const providerConfig = configManager.get("provider");
  const resolvedModel = model ?? providerConfig.model;
  const reasoningEffort = providerConfig.reasoningEffort ?? "medium";
  messages.push(buildUserMessage(userMessage, images));

  let finalText = "";
  const provider = defaultManager.get();

  let currentTodos: TodoItem[] = [];
  const unsubTodo = eventBus.on("todo_update", (data) => {
    currentTodos = (data as { todos: TodoItem[] }).todos;
  });

  try {
    for (let step = 0; step < maxSteps; step++) {
      eventBus.emit("step_start", { step });

      const managed = await summarizeIfNeeded(messages as Message[], eventBus);
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

      const stream = streamText({
        model: provider.chatModel(resolvedModel),
        system: systemPrompt,
        messages,
        tools,
        ...(reasoningEffort !== "none" && {
          providerOptions: {
            openai: { reasoningEffort },
          },
        }),
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
        autoCompleteTodos(currentTodos, eventBus);
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

async function consumeStream(
  stream: ReturnType<typeof streamText>,
  eventBus: AgentOptions["eventBus"]
): Promise<StreamResult> {
  const toolCalls: StreamResult["toolCalls"] = [];
  const toolResults: StreamResult["toolResults"] = [];
  let text = "";
  let reasoningStarted = false;

  for await (const event of stream.fullStream) {
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
        const delta = event.text;
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
        const delta = event.text;
        if (delta) {
          text += delta;
          eventBus.emit("text_delta", { delta });
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
