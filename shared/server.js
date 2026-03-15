import * as http from "http";
import * as path from "path";
import * as fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = path.resolve(__dirname, "../client/web");

const MIME_TYPES = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

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

export function startServer({ runAgent, createTools, systemPrompt }) {
  const PORT = parseInt(process.env.PORT || "4567", 10);

  const server = http.createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === "GET" && req.url === "/health") {
      sendJSON(res, 200, { status: "ok" });
      return;
    }

    if (req.method === "GET" && req.url === "/workspace") {
      sendJSON(res, 200, { workspace: process.cwd() });
      return;
    }

    if (req.method === "GET" && req.url.startsWith("/workspace/list")) {
      const params = new URL(req.url, `http://${req.headers.host}`).searchParams;
      let dir = params.get("dir") || process.cwd();

      dir = dir.replace(/^~/, process.env.HOME || "/");
      dir = path.resolve(dir);

      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
        sendJSON(res, 200, { dir, parent: path.dirname(dir), entries: [] });
        return;
      }

      try {
        const raw = fs.readdirSync(dir, { withFileTypes: true });
        const entries = raw
          .filter((d) => !d.name.startsWith("."))
          .map((d) => ({
            name: d.name,
            isDir: d.isDirectory(),
            path: path.join(dir, d.name),
          }))
          .sort((a, b) => {
            if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
            return a.name.localeCompare(b.name);
          });
        sendJSON(res, 200, { dir, parent: path.dirname(dir), entries });
      } catch {
        sendJSON(res, 200, { dir, parent: path.dirname(dir), entries: [] });
      }
      return;
    }

    if (req.method === "POST" && req.url === "/chat") {
      let body;
      try {
        body = await readBody(req);
      } catch {
        sendJSON(res, 400, { error: "Invalid JSON" });
        return;
      }

      const { message, workspace } = body;
      if (!message) {
        sendJSON(res, 400, { error: "Missing 'message' field" });
        return;
      }

      const cwd = workspace && fs.existsSync(workspace) ? path.resolve(workspace) : process.cwd();
      const tools = createTools(cwd);
      const prompt = systemPrompt(cwd);

      console.log(`[server] chat [${cwd}] [${message.length} chars]: ${message}`);

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
        console.log("[server] client disconnected");
      });

      await runAgent(message, { tools, systemPrompt: prompt, sendSSE });

      res.end();
      return;
    }

    const urlPath = req.url === "/" ? "/index.html" : req.url.split("?")[0];
    const filePath = path.join(STATIC_DIR, urlPath);

    if (req.method === "GET" && filePath.startsWith(STATIC_DIR) && fs.existsSync(filePath)) {
      const ext = path.extname(filePath);
      const mime = MIME_TYPES[ext] || "application/octet-stream";
      res.writeHead(200, { "Content-Type": mime });
      fs.createReadStream(filePath).pipe(res);
      return;
    }

    sendJSON(res, 404, { error: "Not found" });
  });

  server.listen(PORT, () => {
    console.log(`[server] listening on http://localhost:${PORT}`);
    console.log(`[server]   Web UI:      http://localhost:${PORT}/`);
    console.log(`[server]   POST /chat   — SSE stream`);
  });

  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.error(`[server] port ${PORT} is already in use.`);
      console.error(`[server] run: npm run server:stop`);
    } else {
      console.error(`[server] error: ${err.message}`);
    }
    process.exit(1);
  });
}
