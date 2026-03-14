import OpenAI from "openai";

// ============================================================
// 轻量 Agent Runner
//
// 解决的问题：AI SDK v6 + Zod v4 的 schema 转换和 copilot-proxy 不兼容
// 方案：直接用 openai SDK，自己封装 tool() 和 agent loop
//
// 用法：
//   import { createAgent, defineTool } from "./agent-runner.js";
//
//   const agent = createAgent({
//     baseURL: "http://localhost:4141/v1",
//     model: "gpt-4",
//     system: "You are a helpful assistant.",
//     tools: {
//       read_file: defineTool({
//         description: "Read a file",
//         parameters: {
//           type: "object",
//           properties: { path: { type: "string" } },
//           required: ["path"],
//         },
//         execute: async ({ path }) => fs.readFileSync(path, "utf-8"),
//       }),
//     },
//   });
//
//   const { text, steps } = await agent.run("帮我看看有什么文件", {
//     maxSteps: 20,
//     onToolCall: (name, args, result) => { ... },
//   });
// ============================================================

export function defineTool({ description, parameters, execute }) {
  return { description, parameters, execute };
}

export function createAgent({ baseURL, apiKey = "not-needed", model, system, tools }) {
  const client = new OpenAI({ baseURL, apiKey });

  const openaiTools = Object.entries(tools).map(([name, t]) => ({
    type: "function",
    function: {
      name,
      description: t.description,
      parameters: t.parameters,
    },
  }));

  async function run(prompt, options = {}) {
    const { maxSteps = 20, onToolCall } = options;

    const messages = [];
    if (system) messages.push({ role: "system", content: system });
    messages.push({ role: "user", content: prompt });

    const steps = [];

    for (let i = 0; i < maxSteps; i++) {
      const response = await client.chat.completions.create({
        model,
        messages,
        tools: openaiTools,
      });

      const message = response.choices[0].message;
      messages.push(message);

      if (!message.tool_calls || message.tool_calls.length === 0) {
        steps.push({ type: "text", text: message.content });
        return { text: message.content, steps };
      }

      const toolCalls = [];
      for (const tc of message.tool_calls) {
        const name = tc.function.name;
        const args = JSON.parse(tc.function.arguments);
        const toolDef = tools[name];

        if (!toolDef) {
          const errMsg = `Unknown tool: ${name}`;
          messages.push({ role: "tool", tool_call_id: tc.id, content: errMsg });
          toolCalls.push({ name, args, result: errMsg });
          continue;
        }

        const result = await toolDef.execute(args);
        const resultStr = String(result);

        messages.push({ role: "tool", tool_call_id: tc.id, content: resultStr });
        toolCalls.push({ name, args, result: resultStr });

        if (onToolCall) onToolCall(name, args, resultStr);
      }

      steps.push({ type: "tool_calls", toolCalls });
    }

    return { text: "(达到最大步数)", steps };
  }

  return { run };
}
