// Console UI Client — connects to agent server via WebSocket
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
  showAgentResponse,
  showStats,
  showError,
  startThinking,
  stopThinking,
  createMultilineREPL,
} from "./ui/display.js";

// ── Parse CLI args ─────────────────────────────────────────
function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { project: null, server: "ws://localhost:4567" };
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

  let resolveReady;
  const ready = new Promise((r) => { resolveReady = r; });

  let stepCount = 0;
  let chatResolve = null;

  conn.onEvent((event) => {
    switch (event.type) {
      case "connected":
      case "config_ack":
        resolveReady();
        break;

      case "thinking":
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

      case "response":
        stopThinking();
        showAgentResponse(event.text);
        showStats(event.stepCount);
        if (chatResolve) { chatResolve(); chatResolve = null; }
        break;

      case "error":
        stopThinking();
        showError(event.message);
        if (chatResolve) { chatResolve(); chatResolve = null; }
        break;

      case "disconnected":
        stopThinking();
        showError("Server disconnected");
        process.exit(1);
        break;
    }
  });

  try {
    await conn.connect();
  } catch (err) {
    showError(`Cannot connect to server: ${err.message}`);
    showError("Start the server first: node server/index.js");
    process.exit(1);
  }

  if (opts.project) {
    conn.configure({ mode: "refactor", projectDir: opts.project });
  }

  await ready;

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  showWelcome("AI Coding Agent (Console Client)", {
    模式: mode === "refactor" ? "Code Review & Refactor" : "Basic",
    服务器: opts.server,
    ...(opts.project ? { 项目目录: opts.project } : {}),
  });

  createMultilineREPL(rl, async (input) => {
    await new Promise((resolve) => {
      chatResolve = resolve;
      conn.chat(input);
    });
  });

  rl.on("close", () => {
    conn.disconnect();
    process.exit(0);
  });
}

main();
