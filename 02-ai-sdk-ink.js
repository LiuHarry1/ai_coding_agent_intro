// ============================================================
// 阶段 2b：AI SDK + Ink UI 版
//
// 教学要点：
//   - 用 React (Ink) 驱动终端 UI
//   - 每个 step、tool call、agent 回答都是独立组件
//   - state 变化 → UI 自动更新（spinner 原地旋转、步骤实时刷新）
//   - 对比 02-ai-sdk-basic.js 的 console.log 方式
//
// 运行: node 02-ai-sdk-ink.js
// ============================================================

import React from "react";
import { render } from "ink";
import { generateText, tool, stepCountIs } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import * as fs from "fs";
import { execSync } from "child_process";
import { z } from "zod";
import { AgentApp } from "./ui/components.js";

const h = React.createElement;

// ── Provider ─────────────────────────────────────────────────
const provider = createOpenAICompatible({
  name: "copilot-proxy",
  baseURL: "http://localhost:4141/v1",
  apiKey: "not-needed",
});

// ── Tools ────────────────────────────────────────────────────
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

// ── Agent Loop ───────────────────────────────────────────────
// callbacks 让 UI 实时感知每一步
async function runAgent(userMessage, callbacks) {
  callbacks.onThinking();

  const { text, steps } = await generateText({
    model: provider.chatModel("gpt-4"),
    system: `You are a helpful coding assistant. You can read files, write files, and run shell commands to help the user. Current directory: ${process.cwd()}`,
    prompt: userMessage,
    tools: agentTools,
    stopWhen: stepCountIs(20),
    onStepFinish: ({ toolCalls, toolResults }) => {
      if (toolCalls && toolCalls.length > 0) {
        for (let i = 0; i < toolCalls.length; i++) {
          const tc = toolCalls[i];
          callbacks.onToolCall(tc.toolName, tc.args);
          if (toolResults && toolResults[i]) {
            callbacks.onToolResult(tc.toolName, String(toolResults[i].result));
          }
        }
      }
      callbacks.onThinking();
    },
  });

  return { text, steps };
}

// ── Render ───────────────────────────────────────────────────
render(
  h(AgentApp, {
    title: "AI Coding Agent (Ink UI)",
    info: { 模式: "AI SDK + Ink + Zod", 目录: process.cwd() },
    onUserInput: runAgent,
  }),
  { patchConsole: false },
);
