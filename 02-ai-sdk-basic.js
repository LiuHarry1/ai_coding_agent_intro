// ============================================================
// 阶段 2：AI SDK 基础版
//
// 教学要点：
//   - 对比阶段 1，看框架帮你省了什么
//   - tool() 把定义 + 执行合一，不用 JSON Schema + switch/case
//   - stopWhen 控制 agent loop 最大步数
//   - 引出问题：工具还是太少，不够做 refactor → 进入阶段 3
//
// 运行: node 02-ai-sdk-basic.js
// ============================================================

import { generateText, tool, stepCountIs } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import * as fs from "fs";
import { execSync } from "child_process";
import * as readline from "readline";
import { z } from "zod";
import {
  showWelcome,
  showToolCall,
  showToolResult,
  showAgentResponse,
  showStats,
  showError,
  startThinking,
  stopThinking,
  createMultilineREPL,
} from "./display.js";

// 创建 Provider — 用 openai-compatible 兼容 copilot-proxy
const provider = createOpenAICompatible({
  name: "copilot-proxy",
  baseURL: "http://localhost:4141/v1",
  apiKey: "not-needed",
});

// 定义 Tools — 用 Zod schema + execute 合在一起
const agentTools = {
  read_file: tool({
    description: "Read the contents of a file at the given path",
    inputSchema: z.object({
      path: z.string().describe("The file path to read"),
    }),
    execute: async ({ path }) => {
      try {
        return fs.readFileSync(path, "utf-8");
      } catch (e) {
        return `Error reading file: ${e.message}`;
      }
    },
  }),

  write_file: tool({
    description: "Write content to a file. Creates the file if it doesn't exist.",
    inputSchema: z.object({
      path: z.string().describe("The file path to write to"),
      content: z.string().describe("The content to write"),
    }),
    execute: async ({ path, content }) => {
      try {
        fs.writeFileSync(path, content);
        return `Successfully wrote to ${path}`;
      } catch (e) {
        return `Error writing file: ${e.message}`;
      }
    },
  }),

  run_command: tool({
    description: "Run a shell command and return its output",
    inputSchema: z.object({
      command: z.string().describe("The shell command to run"),
    }),
    execute: async ({ command }) => {
      try {
        return execSync(command, {
          encoding: "utf-8",
          timeout: 30000,
          cwd: process.cwd(),
        });
      } catch (e) {
        return `Exit code ${e.status}\n${e.stdout || ""}${e.stderr || ""}`;
      }
    },
  }),
};

// Agent Loop — 对比阶段 1 的 while 循环，这里一个 generateText 搞定
async function agentLoop(userMessage) {
  startThinking("LLM 思考中...");

  const { text, steps } = await generateText({
    model: provider.chatModel("gpt-4"),
    system: `You are a helpful coding assistant. You can read files, write files, and run shell commands to help the user. Current directory: ${process.cwd()}`,
    prompt: userMessage,
    tools: agentTools,
    stopWhen: stepCountIs(20),
    onStepFinish: ({ toolCalls, toolResults }) => {
      stopThinking();
      if (toolCalls && toolCalls.length > 0) {
        for (let i = 0; i < toolCalls.length; i++) {
          const tc = toolCalls[i];
          showToolCall(tc.toolName, tc.args);
          if (toolResults && toolResults[i]) {
            showToolResult(String(toolResults[i].result));
          }
        }
        startThinking("继续思考...");
      }
    },
  });

  stopThinking();
  showAgentResponse(text);
  showStats(steps.length);
}

// 交互式 REPL（支持多行粘贴）
async function main() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  showWelcome("AI Coding Agent (AI SDK 基础版)", {
    模式: "AI SDK + Zod",
    目录: process.cwd(),
  });

  createMultilineREPL(rl, async (input) => {
    try {
      await agentLoop(input);
    } catch (err) {
      stopThinking();
      showError(err.message);
    }
  });
}

main();
