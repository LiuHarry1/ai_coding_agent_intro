// ============================================================
// 阶段 1：手写版 Agent（纯 OpenAI SDK）
//
// 教学要点：
//   - 理解 Agent 的本质：tool calling + agent loop
//   - 看清每一步发生了什么：messages 管理、tool 执行、循环判断
//   - 没有任何框架魔法，所有逻辑透明可见
//
// 运行: node 01-raw-openai.js
// ============================================================

import OpenAI from "openai";
import * as fs from "fs";
import { execSync } from "child_process";
import * as readline from "readline";
import {
  showWelcome,
  showStep,
  showToolCall,
  showToolResult,
  showAgentResponse,
  showError,
  startThinking,
  stopThinking,
  createMultilineREPL,
} from "./display.js";

// 第 1 步：创建 OpenAI 客户端
// 指向你的 copilot-proxy，兼容 OpenAI 接口
const client = new OpenAI({
  baseURL: "http://localhost:4141/v1",
  apiKey: "not-needed",
});

// 第 2 步：定义 Tools（工具）
// 用 JSON Schema 告诉 LLM "你能做什么"
// LLM 并不执行工具，它只是输出 "我想调用 read_file({ path: 'xxx' })"
const tools = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read the contents of a file at the given path",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "The file path to read" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description:
        "Write content to a file. Creates the file if it does not exist.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "The file path to write to" },
          content: {
            type: "string",
            description: "The content to write to the file",
          },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_command",
      description: "Run a shell command and return its output",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "The shell command to run" },
        },
        required: ["command"],
      },
    },
  },
];

// 第 3 步：实现工具的执行逻辑
// LLM 决定调 read_file → 我们在这里真正执行 fs.readFileSync
function executeTool(name, args) {
  switch (name) {
    case "read_file":
      try {
        return fs.readFileSync(args.path, "utf-8");
      } catch (e) {
        return `Error reading file: ${e.message}`;
      }

    case "write_file":
      try {
        fs.writeFileSync(args.path, args.content);
        return `Successfully wrote to ${args.path}`;
      } catch (e) {
        return `Error writing file: ${e.message}`;
      }

    case "run_command":
      try {
        return execSync(args.command, {
          encoding: "utf-8",
          timeout: 30000,
          cwd: process.cwd(),
        });
      } catch (e) {
        return `Exit code ${e.status}\n${e.stdout || ""}${e.stderr || ""}`;
      }

    default:
      return `Unknown tool: ${name}`;
  }
}

// 第 4 步：Agent Loop（核心循环）
//
//   用户输入
//      ↓
//   发送给 LLM（带 tools 定义）
//      ↓
//   LLM 返回：文本回复 or tool_calls
//      ↓
//   如果是 tool_calls → 执行工具 → 把结果发回给 LLM → 重复
//   如果是文本回复   → 输出给用户 → 结束
//
// 这个循环就是 Agent 和普通 Chat 的本质区别。
async function agentLoop(userMessage) {
  const messages = [
    {
      role: "system",
      content: `You are a helpful coding assistant. You can read files, write files, and run shell commands to help the user with coding tasks. Current directory: ${process.cwd()}`,
    },
    { role: "user", content: userMessage },
  ];

  let iterations = 0;
  const MAX_ITERATIONS = 20;

  while (iterations < MAX_ITERATIONS) {
    iterations++;
    showStep(iterations);
    startThinking("LLM 思考中...");

    const response = await client.chat.completions.create({
      model: "gpt-4",
      messages,
      tools,
    });

    stopThinking();
    const message = response.choices[0].message;
    messages.push(message);

    // 没有 tool_calls → LLM 给出了最终回答 → 结束
    if (!message.tool_calls || message.tool_calls.length === 0) {
      showAgentResponse(message.content);
      return;
    }

    // 有 tool_calls → 执行每个工具 → 把结果送回 LLM
    for (const toolCall of message.tool_calls) {
      const funcName = toolCall.function.name;
      const args = JSON.parse(toolCall.function.arguments);

      showToolCall(funcName, args);
      const result = executeTool(funcName, args);
      showToolResult(result);

      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: result,
      });
    }
  }

  showError("达到最大迭代次数，停止。");
}

// 第 5 步：交互式 REPL（支持多行粘贴）
async function main() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  showWelcome("AI Coding Agent (手写版)", {
    模式: "Raw OpenAI SDK",
    目录: process.cwd(),
  });

  createMultilineREPL(rl, async (input) => {
    try {
      await agentLoop(input);
    } catch (err) {
      showError(err.message);
    }
  });
}

main();
