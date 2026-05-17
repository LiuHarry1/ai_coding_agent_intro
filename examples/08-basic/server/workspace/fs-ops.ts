import * as fs from "fs";
import * as path from "path";

const MAX_FILE_PREVIEW_BYTES = 2 * 1024 * 1024; // 2 MB cap for file viewer

export interface DirEntry {
  name: string;
  isDir: boolean;
  path: string;
}

export interface ListDirResult {
  dir: string;
  parent: string;
  entries: DirEntry[];
}

export interface ReadFileResult {
  path: string;
  content: string;
  size: number;
  truncated: boolean;
  isBinary: boolean;
  mtimeMs: number;
}

export function listDir(dir: string): ListDirResult {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    return { dir, parent: path.dirname(dir), entries: [] };
  }
  const raw = fs.readdirSync(dir, { withFileTypes: true });
  const entries: DirEntry[] = raw
    .filter((d) => !d.name.startsWith("."))
    .map((d) => ({ name: d.name, isDir: d.isDirectory(), path: path.join(dir, d.name) }))
    .sort((a, b) => (a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name)));
  return { dir, parent: path.dirname(dir), entries };
}

function isProbablyBinary(buf: Buffer): boolean {
  // Heuristic: any null byte in the first 8 KB → binary.
  const len = Math.min(buf.length, 8192);
  for (let i = 0; i < len; i++) if (buf[i] === 0) return true;
  return false;
}

export function readFile(filePath: string): ReadFileResult {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw new FsOpError("ENOENT", `File not found: ${filePath}`);
  }
  const stat = fs.statSync(filePath);
  const size = stat.size;
  const truncated = size > MAX_FILE_PREVIEW_BYTES;
  const fd = fs.openSync(filePath, "r");
  const toRead = truncated ? MAX_FILE_PREVIEW_BYTES : size;
  const buf = Buffer.alloc(toRead);
  fs.readSync(fd, buf, 0, toRead, 0);
  fs.closeSync(fd);

  if (isProbablyBinary(buf)) {
    return { path: filePath, content: "", size, truncated: false, isBinary: true, mtimeMs: stat.mtimeMs };
  }
  return {
    path: filePath,
    content: buf.toString("utf-8"),
    size,
    truncated,
    isBinary: false,
    mtimeMs: stat.mtimeMs,
  };
}

const MAX_WRITE_BYTES = 5 * 1024 * 1024; // 5 MB

function assertWriteSize(content: string): void {
  if (Buffer.byteLength(content, "utf-8") > MAX_WRITE_BYTES) {
    throw new FsOpError("E2BIG", `Content exceeds ${MAX_WRITE_BYTES} bytes`);
  }
}

/** Atomic write via temp file + rename. */
function atomicWrite(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    throw new FsOpError("ENOENT", `Parent directory does not exist: ${dir}`);
  }
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, content, "utf-8");
  fs.renameSync(tmp, filePath);
}

export function createFile(filePath: string, content: string): ReadFileResult {
  if (fs.existsSync(filePath)) {
    throw new FsOpError("EEXIST", `Already exists: ${filePath}`);
  }
  assertWriteSize(content);
  atomicWrite(filePath, content);
  return readFile(filePath);
}

/**
 * Save edits to an existing file. If `expectedMtimeMs` is provided and
 * doesn't match the current mtime, throws EMTIME (caller should surface
 * a 409 Conflict so the UI can prompt the user to reload).
 */
export function saveFile(
  filePath: string,
  content: string,
  expectedMtimeMs?: number
): ReadFileResult {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw new FsOpError("ENOENT", `File not found: ${filePath}`);
  }
  if (expectedMtimeMs !== undefined) {
    const cur = fs.statSync(filePath).mtimeMs;
    // ms can be fractional on some filesystems; allow 1ms tolerance.
    if (Math.abs(cur - expectedMtimeMs) > 1) {
      throw new FsOpError("EMTIME", `File modified externally: ${filePath}`);
    }
  }
  assertWriteSize(content);
  atomicWrite(filePath, content);
  return readFile(filePath);
}

export function makeDir(dirPath: string): { path: string } {
  if (fs.existsSync(dirPath)) {
    if (fs.statSync(dirPath).isDirectory()) return { path: dirPath };
    throw new FsOpError("EEXIST", `Path exists and is not a directory: ${dirPath}`);
  }
  fs.mkdirSync(dirPath, { recursive: true });
  return { path: dirPath };
}

export function removeEntry(targetPath: string): { path: string } {
  if (!fs.existsSync(targetPath)) {
    throw new FsOpError("ENOENT", `Not found: ${targetPath}`);
  }
  const stat = fs.statSync(targetPath);
  if (stat.isDirectory()) {
    // Refuse non-empty dir deletion to avoid accidents; caller can recurse
    // explicitly later if we ever add it.
    const entries = fs.readdirSync(targetPath);
    if (entries.length > 0) {
      throw new FsOpError("ENOTEMPTY", `Directory not empty: ${targetPath}`);
    }
    fs.rmdirSync(targetPath);
  } else {
    fs.unlinkSync(targetPath);
  }
  return { path: targetPath };
}

export class FsOpError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}
