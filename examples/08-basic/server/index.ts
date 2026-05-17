import * as http from "http";
import * as path from "path";
import * as fs from "fs";
import { fileURLToPath } from "url";
import { createRouter } from "./router.js";
import type { ServerOptions } from "../core/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function startServer({ runAgent, systemPrompt }: ServerOptions): void {
  const PORT = parseInt(process.env.PORT || "4567", 10);

  // Last-line defense against flaky upstreams (e.g. copilot-api dropping the
  // socket mid-stream). Without these the undici fetch/body errors surface as
  // unhandled rejections and Node 22+ kills the whole server. We keep the
  // process alive and log the failure; in-flight requests will already have
  // been failed by the agent's own try/catch around the stream.
  process.on("unhandledRejection", (reason) => {
    const msg = reason instanceof Error ? reason.stack ?? reason.message : String(reason);
    console.error("[server] unhandledRejection:", msg);
  });
  process.on("uncaughtException", (err) => {
    console.error("[server] uncaughtException:", err.stack ?? err.message);
  });

  const distDir = path.resolve(__dirname, "../../../client2/web/dist");
  const staticDir = fs.existsSync(distDir) ? distDir : null;

  if (!staticDir) {
    console.log(`[server] Warning: client2/web/dist not found.`);
    console.log(`[server] Run: cd client2/web && npm install && npm run build`);
    console.log(`[server] Or use dev mode: cd client2/web && npm run dev`);
  }

  const handler = createRouter({ runAgent, systemPrompt, staticDir });

  const server = http.createServer(handler);

  server.listen(PORT, () => {
    console.log(`[server] listening on http://localhost:${PORT}`);
    console.log(`[server]   POST /sessions     — create session`);
    console.log(`[server]   GET  /sessions     — list sessions`);
    console.log(`[server]   DELETE /sessions/id — delete session`);
    console.log(`[server]   POST /chat         — chat (SSE stream)`);
    if (staticDir) {
      console.log(`[server]   Static files from: ${distDir}`);
    }
  });

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(`[server] port ${PORT} is already in use.`);
    } else {
      console.error(`[server] error: ${err.message}`);
    }
    process.exit(1);
  });
}
