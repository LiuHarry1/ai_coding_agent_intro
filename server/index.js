import { WebSocketServer } from "ws";
import * as path from "path";
import * as fs from "fs";
import { runAgent } from "./core/agent.js";
import { createBasicTools, createRefactorTools } from "./core/tools.js";
import { basicPrompt, refactorPrompt } from "./core/prompts.js";

const PORT = parseInt(process.env.PORT || "4567", 10);

const wss = new WebSocketServer({ port: PORT });

wss.on("listening", () => {
  console.log(`[server] listening on ws://localhost:${PORT}`);
});

wss.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`[server] port ${PORT} is already in use.`);
    console.error(`[server] kill the old process:  lsof -ti :${PORT} | xargs kill`);
    console.error(`[server] or use another port:   PORT=4568 node server/index.js`);
  } else {
    console.error(`[server] error: ${err.message}`);
  }
  process.exit(1);
});

wss.on("connection", (ws) => {
  let config = {
    mode: "basic",
    projectDir: process.cwd(),
  };

  console.log("[server] client connected");

  function send(event) {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(event));
    }
  }

  send({ type: "connected", mode: config.mode, projectDir: config.projectDir });

  ws.on("message", async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      send({ type: "error", message: "Invalid JSON" });
      return;
    }

    if (msg.type === "config") {
      if (msg.mode) config.mode = msg.mode;
      if (msg.projectDir) {
        const resolved = path.resolve(msg.projectDir);
        if (!fs.existsSync(resolved)) {
          send({ type: "error", message: `Directory "${resolved}" does not exist` });
          return;
        }
        config.projectDir = resolved;
      }
      console.log(`[server] config updated: mode=${config.mode}, projectDir=${config.projectDir}`);
      send({ type: "config_ack", mode: config.mode, projectDir: config.projectDir });
      return;
    }

    if (msg.type === "chat") {
      const tools = config.mode === "refactor"
        ? createRefactorTools(config.projectDir)
        : createBasicTools(config.projectDir);

      const systemPrompt = config.mode === "refactor"
        ? refactorPrompt(config.projectDir)
        : basicPrompt(config.projectDir);

      console.log(`[server] chat (${config.mode}): ${msg.message.substring(0, 80)}`);

      await runAgent(msg.message, {
        tools,
        systemPrompt,
        onEvent: send,
      });
      return;
    }

    send({ type: "error", message: `Unknown message type: ${msg.type}` });
  });

  ws.on("close", () => {
    console.log("[server] client disconnected");
  });
});
