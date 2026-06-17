import type { IncomingMessage, ServerResponse } from "http";
import { resolvePath } from "./path-safety.js";
import {
  listDir,
  readFile,
  createFile,
  saveFile,
  makeDir,
  removeEntry,
  searchFiles,
  invalidateFileSearchCache,
  FsOpError,
} from "./fs-ops.js";
import { gitStatus, gitDiff } from "./git.js";
import { handleUpload, handleDownload } from "./transfer.js";
import { isPathInWorkspace } from "../../core/workspace.js";

/**
 * Self-contained workspace HTTP module.
 *
 * - Handles all `/workspace/*` endpoints.
 * - Knows nothing about agent / sessions / MCP / config — only depends on
 *   `node:fs` and `node:path`.
 * - The host router composes it via `await workspaceRouter(req, res)`,
 *   which returns `true` iff the request was handled.
 */
export interface WorkspaceRouterOptions {
  /**
   * The workspace root advertised by `GET /workspace` and used as the cwd
   * for resolving relative paths. NOT a security sandbox — this module
   * intentionally allows browsing/creating anywhere on disk so the UI's
   * directory picker can pick or create a new workspace folder.
   */
  root: string;
}

const MAX_BODY = 6 * 1024 * 1024;

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) { req.destroy(); reject(new Error("Body too large")); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString() || "{}")); }
      catch { reject(new Error("Invalid JSON")); }
    });
    req.on("error", reject);
  });
}

function sendJSON(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function statusFor(err: unknown): number {
  if (!(err instanceof FsOpError)) return 500;
  switch (err.code) {
    case "ENOENT": return 404;
    case "EEXIST": return 409;
    case "EMTIME": return 409;
    case "ENOTEMPTY": return 409;
    case "E2BIG": return 413;
    case "EACCES": return 403;
    default: return 500;
  }
}

function errorBody(err: unknown): { error: string; code?: string } {
  if (err instanceof FsOpError) return { error: err.message, code: err.code };
  return { error: err instanceof Error ? err.message : String(err) };
}

export function createWorkspaceRouter(opts: WorkspaceRouterOptions) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const { method, url } = req;
    if (!url || !url.startsWith("/workspace")) return false;

    // Per-request root: when the auth gate pinned a user workspace
    // (req.userWorkspace), use it and SANDBOX every path to it. Otherwise
    // fall back to the server default with no sandbox (legacy single-user).
    const pinned = (req as { userWorkspace?: string }).userWorkspace;
    const root = pinned ?? opts.root;
    const sandbox = Boolean(pinned);
    const safe = (input: string): string => {
      const abs = resolvePath(input, root);
      if (sandbox && !isPathInWorkspace(abs, root)) {
        throw new FsOpError("EACCES", "Path is outside your workspace");
      }
      return abs;
    };

    try {
      // GET /workspace
      if (method === "GET" && url === "/workspace") {
        sendJSON(res, 200, { workspace: root });
        return true;
      }

      // POST /workspace/upload  (multipart/form-data: dir + file[])
      if (method === "POST" && url.startsWith("/workspace/upload")) {
        await handleUpload(req, res, root);
        return true;
      }

      // GET /workspace/download?path=  (file → attachment, dir → zip)
      if (method === "GET" && url.startsWith("/workspace/download")) {
        const params = new URL(url, `http://${req.headers.host}`).searchParams;
        await handleDownload(res, root, params.get("path"));
        return true;
      }

      // GET /workspace/list?dir=&showHidden=
      if (method === "GET" && url.startsWith("/workspace/list")) {
        const params = new URL(url, `http://${req.headers.host}`).searchParams;
        const dirParam = params.get("dir") || root;
        const showHidden = params.get("showHidden") === "1" || params.get("showHidden") === "true";
        sendJSON(res, 200, listDir(safe(dirParam), { showHidden }));
        return true;
      }

      // GET /workspace/search?q=&dir=&limit=&showHidden=  (@-mention autocomplete)
      if (method === "GET" && url.startsWith("/workspace/search")) {
        const params = new URL(url, `http://${req.headers.host}`).searchParams;
        const q = params.get("q") ?? "";
        const dirParam = params.get("dir") || root;
        const limit = Math.min(50, Math.max(1, parseInt(params.get("limit") ?? "15", 10) || 15));
        const showHidden = params.get("showHidden") === "1" || params.get("showHidden") === "true";
        const searchRoot = safe(dirParam);
        sendJSON(res, 200, searchFiles(searchRoot, q, limit, showHidden));
        return true;
      }

      // GET /workspace/file?path=
      if (method === "GET" && url.startsWith("/workspace/file?")) {
        const params = new URL(url, `http://${req.headers.host}`).searchParams;
        const p = params.get("path");
        if (!p) { sendJSON(res, 400, { error: "Missing 'path'" }); return true; }
        sendJSON(res, 200, readFile(safe(p)));
        return true;
      }

      // POST /workspace/file  { path, content }
      if (method === "POST" && url === "/workspace/file") {
        const body = await readBody(req);
        const p = body.path as string | undefined;
        const content = (body.content as string | undefined) ?? "";
        if (!p) { sendJSON(res, 400, { error: "Missing 'path'" }); return true; }
        sendJSON(res, 200, createFile(safe(p), content));
        return true;
      }

      // PUT /workspace/file  { path, content, mtimeMs? }
      if (method === "PUT" && url === "/workspace/file") {
        const body = await readBody(req);
        const p = body.path as string | undefined;
        const content = body.content as string | undefined;
        const expectedMtimeMs = body.mtimeMs as number | undefined;
        if (!p || content === undefined) {
          sendJSON(res, 400, { error: "Missing 'path' or 'content'" });
          return true;
        }
        sendJSON(res, 200, saveFile(safe(p), content, expectedMtimeMs));
        return true;
      }

      // POST /workspace/mkdir  { path }
      if (method === "POST" && url === "/workspace/mkdir") {
        const body = await readBody(req);
        const p = body.path as string | undefined;
        if (!p) { sendJSON(res, 400, { error: "Missing 'path'" }); return true; }
        sendJSON(res, 200, makeDir(safe(p)));
        return true;
      }

      // GET /workspace/git/status
      if (method === "GET" && url === "/workspace/git/status") {
        sendJSON(res, 200, await gitStatus(root));
        return true;
      }

      // GET /workspace/git/diff?path=
      if (method === "GET" && url.startsWith("/workspace/git/diff")) {
        const params = new URL(url, `http://${req.headers.host}`).searchParams;
        const p = params.get("path");
        if (!p) { sendJSON(res, 400, { error: "Missing 'path'" }); return true; }
        sendJSON(res, 200, await gitDiff(root, p));
        return true;
      }

      // DELETE /workspace/entry?path=
      if (method === "DELETE" && url.startsWith("/workspace/entry")) {
        const params = new URL(url, `http://${req.headers.host}`).searchParams;
        const p = params.get("path");
        if (!p) { sendJSON(res, 400, { error: "Missing 'path'" }); return true; }
        sendJSON(res, 200, removeEntry(safe(p)));
        return true;
      }

      return false;
    } catch (err) {
      if (!res.headersSent) sendJSON(res, statusFor(err), errorBody(err));
      else res.end();
      return true;
    }
  };
}

export { resolvePath } from "./path-safety.js";
