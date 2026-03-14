import * as http from "http";
import * as path from "path";
import * as fs from "fs";
import { runAgent } from "./core/agent.js";
import { createBasicTools, createRefactorTools } from "./core/tools.js";
import { basicPrompt, refactorPrompt } from "./core/prompts.js";

const PORT = parseInt(process.env.PORT || "4567", 10);

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
      catch { reject(new Error("Invalid JSON")); }
    });
    req.on("error", reject);
  });
}

function sendJSON(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // ── Health check ──────────────────────────────────────────
  if (req.method === "GET" && req.url === "/health") {
    sendJSON(res, 200, { status: "ok" });
    return;
  }

  // ── Chat — POST /chat  →  SSE stream ─────────────────────
  if (req.method === "POST" && req.url === "/chat") {
    let body;
    try {
      body = await readBody(req);
    } catch {
      sendJSON(res, 400, { error: "Invalid JSON" });
      return;
    }

    const { message, mode = "basic", projectDir } = body;

    if (!message) {
      sendJSON(res, 400, { error: "Missing 'message' field" });
      return;
    }

    const resolvedDir = projectDir ? path.resolve(projectDir) : process.cwd();
    if (projectDir && !fs.existsSync(resolvedDir)) {
      sendJSON(res, 400, { error: `Directory "${resolvedDir}" does not exist` });
      return;
    }

    const tools = mode === "refactor"
      ? createRefactorTools(resolvedDir)
      : createBasicTools(resolvedDir);

    const systemPrompt = mode === "refactor"
      ? refactorPrompt(resolvedDir)
      : basicPrompt(resolvedDir);

    console.log(`[server] chat (${mode}) [${message.length} chars]:`);
    console.log(message);

    // SSE headers
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    function sendSSE(event, data) {
      if (res.writableEnded) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    }

    req.on("close", () => {
      console.log("[server] client disconnected from SSE");
    });

    await runAgent(message, { tools, systemPrompt, sendSSE });

    res.end();
    return;
  }

  // ── 404 ───────────────────────────────────────────────────
  sendJSON(res, 404, { error: "Not found" });
});

server.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT}`);
  console.log(`[server]   POST /chat   — send a message (SSE stream response)`);
  console.log(`[server]   GET  /health — health check`);
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`[server] port ${PORT} is already in use.`);
    console.error(`[server] kill the old process or use another port: PORT=4568 node server/index.js`);
  } else {
    console.error(`[server] error: ${err.message}`);
  }
  process.exit(1);
});
