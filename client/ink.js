// Ink UI Client — connects to agent server via WebSocket
//
// Usage:
//   node client/ink.js                           # basic mode
//   node client/ink.js --project /path/to/proj   # refactor mode

import React from "react";
import { render } from "ink";
import { createConnection } from "./lib/connection.js";
import { AgentApp } from "./ui/components.js";

const h = React.createElement;

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

  try {
    await conn.connect();
  } catch (err) {
    console.error(`Cannot connect to server: ${err.message}`);
    console.error("Start the server first: node server/index.js");
    process.exit(1);
  }

  if (opts.project) {
    conn.configure({ mode: "refactor", projectDir: opts.project });
  }

  render(
    h(AgentApp, {
      title: "AI Coding Agent (Ink Client)",
      info: {
        模式: mode === "refactor" ? "Code Review & Refactor" : "Basic",
        服务器: opts.server,
        ...(opts.project ? { 项目目录: opts.project } : {}),
      },
      connection: conn,
    }),
    { patchConsole: false },
  );
}

main();
