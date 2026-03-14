// ============================================================
// 阶段 3b：实战版 Agent + Ink UI（Code Refactor）
//
// 教学要点：
//   - 增加 list_files、search_code 工具
//   - 支持指定目标项目路径
//   - Ink UI 实时展示每一步
//
// 运行: node 03-refactor-ink.js /path/to/project
// ============================================================

import React from "react";
import { render } from "ink";
import { generateText, tool, stepCountIs } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import { z } from "zod";
import { AgentApp } from "./ui/components.js";

const h = React.createElement;

// ── 解析目标项目路径 ─────────────────────────────────────────
const projectDir = path.resolve(process.argv[2] || ".");

if (!fs.existsSync(projectDir)) {
  console.error(`Error: directory "${projectDir}" does not exist.`);
  process.exit(1);
}

// ── Provider ─────────────────────────────────────────────────
const provider = createOpenAICompatible({
  name: "copilot-proxy",
  baseURL: "http://localhost:4141/v1",
  apiKey: "not-needed",
});

// ── Tools ────────────────────────────────────────────────────

function resolvePath(filePath) {
  if (path.isAbsolute(filePath)) return filePath;
  return path.resolve(projectDir, filePath);
}

const agentTools = {
  list_files: tool({
    description:
      "List files in a directory recursively. Returns file paths relative to the project root.",
    inputSchema: z.object({
      directory: z.string().optional().describe("Directory to list, relative to project root. Defaults to '.'"),
      pattern: z.string().optional().describe("Glob-like filter, e.g. '*.ts' or '*.js'"),
      maxDepth: z.number().optional().describe("Max directory depth. Defaults to 4"),
    }),
    execute: async ({ directory = ".", pattern, maxDepth = 4 }) => {
      const target = resolvePath(directory);
      try {
        let cmd = `find "${target}" -maxdepth ${maxDepth} -type f`;
        if (pattern) cmd += ` -name "${pattern}"`;
        cmd += ` | head -200`;
        const output = execSync(cmd, { encoding: "utf-8", timeout: 10000 });
        const relative = output
          .split("\n")
          .filter(Boolean)
          .map((f) => path.relative(projectDir, f))
          .join("\n");
        return relative || "(no files found)";
      } catch (e) {
        return `Error: ${e.message}`;
      }
    },
  }),

  read_file: tool({
    description: "Read the contents of a file. Path is relative to project root.",
    inputSchema: z.object({
      path: z.string().describe("File path relative to project root"),
    }),
    execute: async ({ path: filePath }) => {
      try {
        const content = fs.readFileSync(resolvePath(filePath), "utf-8");
        const lines = content.split("\n");
        const numbered = lines
          .map((line, i) => `${String(i + 1).padStart(4)} | ${line}`)
          .join("\n");
        return numbered;
      } catch (e) {
        return `Error reading file: ${e.message}`;
      }
    },
  }),

  write_file: tool({
    description: "Write content to a file (overwrites). Path is relative to project root.",
    inputSchema: z.object({
      path: z.string().describe("File path relative to project root"),
      content: z.string().describe("The full file content to write"),
    }),
    execute: async ({ path: filePath, content }) => {
      try {
        const fullPath = resolvePath(filePath);
        const dir = path.dirname(fullPath);
        if (!dir.startsWith(projectDir)) {
          return "Error: cannot write outside the project directory";
        }
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(fullPath, content);
        return `Successfully wrote to ${filePath}`;
      } catch (e) {
        return `Error writing file: ${e.message}`;
      }
    },
  }),

  search_code: tool({
    description:
      "Search for a text pattern across all files in the project (like grep).",
    inputSchema: z.object({
      pattern: z.string().describe("The text or regex pattern to search for"),
      filePattern: z.string().optional().describe("File extension filter, e.g. '*.ts'"),
    }),
    execute: async ({ pattern, filePattern }) => {
      try {
        let cmd = `grep -rn "${pattern}" "${projectDir}"`;
        if (filePattern) cmd += ` --include="${filePattern}"`;
        cmd += " | head -100";
        const output = execSync(cmd, { encoding: "utf-8", timeout: 15000 });
        const relative = output.replace(new RegExp(projectDir + "/", "g"), "");
        return relative || "(no matches found)";
      } catch (e) {
        if (e.status === 1) return "(no matches found)";
        return `Error: ${e.message}`;
      }
    },
  }),

  run_command: tool({
    description: "Run a shell command in the project directory.",
    inputSchema: z.object({
      command: z.string().describe("The shell command to run"),
    }),
    execute: async ({ command }) => {
      try {
        return execSync(command, {
          encoding: "utf-8",
          timeout: 60000,
          cwd: projectDir,
        });
      } catch (e) {
        return `Exit code ${e.status}\n${e.stdout || ""}${e.stderr || ""}`;
      }
    },
  }),
};

// ── System Prompt ────────────────────────────────────────────
const SYSTEM_PROMPT = `You are an expert coding assistant specialized in code review and refactoring.

Project directory: ${projectDir}
All file paths are relative to this project root.

Your workflow for refactoring tasks:
1. First use list_files to understand the project structure
2. Use search_code to find relevant code patterns
3. Use read_file to examine the specific files
4. Plan your changes carefully
5. Use write_file to apply changes
6. Use run_command to verify (run tests, linters, etc.)

Guidelines:
- Always read a file before modifying it
- Make minimal, focused changes
- Preserve existing code style and conventions
- After making changes, run any available tests to verify
- Explain what you changed and why`;

// ── Agent Loop ───────────────────────────────────────────────
async function runAgent(userMessage, callbacks) {
  callbacks.onThinking();

  const { text, steps } = await generateText({
    model: provider.chatModel("gpt-4"),
    system: SYSTEM_PROMPT,
    prompt: userMessage,
    tools: agentTools,
    stopWhen: stepCountIs(30),
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
    title: "AI Coding Agent (Refactor + Ink)",
    info: {
      模式: "Code Review & Refactor",
      项目目录: projectDir,
    },
    onUserInput: runAgent,
  }),
  { patchConsole: false },
);
