// Console UI Client — connects to agent server via HTTP + SSE
//
// Usage:
//   node client/console.js                           # basic mode
//   node client/console.js --project /path/to/proj   # refactor mode

import * as readline from "readline";
import { createConnection } from "./lib/connection.js";
import {
  showWelcome,
  showToolCall,
  showToolResult,
  showStats,
  showError,
  startThinking,
  stopThinking,
  beginStreamingResponse,
  writeStreamDelta,
  endStreamingResponse,
  createMultilineREPL,
} from "./ui/display.js";

// ── Parse CLI args ─────────────────────────────────────────
function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { project: null, server: "http://localhost:4567" };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--project" && args[i + 1]) opts.project = args[++i];
    if (args[i] === "--server" && args[i + 1]) opts.server = args[++i];
  }
  return opts;
}

async function main() {
  const opts = parseArgs();
  const mode = opts.project ? "refactor" : "basic";
  const conn = createConnection(opts.server);

  try {
    await conn.connect();
  } catch (err) {
    showError(`Cannot connect to server: ${err.message}`);
    showError("Start the server first: node server/index.js");
    process.exit(1);
  }

  let chatResolve = null;
  let streamStarted = false;

  conn.onEvent((event) => {
    switch (event.type) {
      case "thinking":
        if (streamStarted) {
          endStreamingResponse();
          streamStarted = false;
        }
        startThinking("LLM 思考中...");
        break;

      case "tool_call":
        stopThinking();
        showToolCall(event.name, event.args);
        break;

      case "tool_result":
        showToolResult(event.result);
        startThinking("继续思考...");
        break;

      case "text_delta":
        stopThinking();
        if (!streamStarted) {
          beginStreamingResponse();
          streamStarted = true;
        }
        writeStreamDelta(event.delta);
        break;

      case "done":
        if (streamStarted) {
          endStreamingResponse();
          streamStarted = false;
        }
        stopThinking();
        showStats(event.stepCount);
        if (chatResolve) { chatResolve(); chatResolve = null; }
        break;

      case "error":
        stopThinking();
        if (streamStarted) { endStreamingResponse(); streamStarted = false; }
        showError(event.message);
        if (chatResolve) { chatResolve(); chatResolve = null; }
        break;
    }
  });

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  showWelcome("AI Coding Agent (Console Client)", {
    模式: mode === "refactor" ? "Code Review & Refactor" : "Basic",
    服务器: opts.server,
    ...(opts.project ? { 项目目录: opts.project } : {}),
  });

  const chatOpts = { mode };
  if (opts.project) chatOpts.projectDir = opts.project;

  createMultilineREPL(rl, async (input) => {
    await new Promise((resolve) => {
      chatResolve = resolve;
      conn.chat(input, chatOpts);
    });
  });

  rl.on("close", () => {
    conn.abort();
    process.exit(0);
  });
}

main();
