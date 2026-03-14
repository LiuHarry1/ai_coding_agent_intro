import { generateText, stepCountIs } from "ai";
import { createProvider } from "./provider.js";

const provider = createProvider();

export async function runAgent(message, { tools, systemPrompt, onEvent, maxSteps = 30 }) {
  onEvent({ type: "thinking" });

  try {
    const { text, steps } = await generateText({
      model: provider.chatModel("gpt-4"),
      system: systemPrompt,
      prompt: message,
      tools,
      stopWhen: stepCountIs(maxSteps),
      onStepFinish: ({ toolCalls, toolResults }) => {
        if (toolCalls && toolCalls.length > 0) {
          for (let i = 0; i < toolCalls.length; i++) {
            const tc = toolCalls[i];
            onEvent({ type: "tool_call", name: tc.toolName, args: tc.args });
            if (toolResults && toolResults[i]) {
              onEvent({ type: "tool_result", name: tc.toolName, result: String(toolResults[i].result) });
            }
          }
          onEvent({ type: "thinking" });
        }
      },
    });

    onEvent({ type: "response", text, stepCount: steps.length });
  } catch (err) {
    onEvent({ type: "error", message: err.message });
  }
}
