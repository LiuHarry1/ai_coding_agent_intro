import * as fs from 'fs'
import * as path from 'path'
import { WALK_IGNORE_DIR_NAMES } from '../../constants/file_filters.js'
import { shouldListDirEntry } from './list-filter.js'

const MAX_FILE_PREVIEW_BYTES = 2 * 1024 * 1024 // 2 MB cap for file viewer

export interface DirEntry {
  name: string
  isDir: boolean
  path: string
}

export interface ListDirResult {
  dir: string
  parent: string
  entries: DirEntry[]
}

export interface ReadFileResult {
  path: string
  content: string
  size: number
  truncated: boolean
  isBinary: boolean
  mtimeMs: number
}

export interface ListDirOptions {
  /** When true, include dotfiles/dotdirs (`.ai-agent`, `.env` are always shown). */
  showHidden?: boolean
}

export function listDir(
  dir: string,
  options: ListDirOptions = {},
): ListDirResult {
  const showHidden = options.showHidden ?? false
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    return { dir, parent: path.dirname(dir), entries: [] }
  }
  const raw = fs.readdirSync(dir, { withFileTypes: true })
  const entries: DirEntry[] = raw
    .filter(d => shouldListDirEntry(d.name, showHidden))
    .map(d => ({
      name: d.name,
      isDir: d.isDirectory(),
      path: path.join(dir, d.name),
    }))
    .sort((a, b) =>
      a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name),
    )
  return { dir, parent: path.dirname(dir), entries }
}

function isProbablyBinary(buf: Buffer): boolean {
  // Heuristic: any null byte in the first 8 KB → binary.
  const len = Math.min(buf.length, 8192)
  for (let i = 0; i < len; i++) if (buf[i] === 0) return true
  return false
}

export function readFile(filePath: string): ReadFileResult {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw new FsOpError('ENOENT', `File not found: ${filePath}`)
  }
  const stat = fs.statSync(filePath)
  const size = stat.size
  const truncated = size > MAX_FILE_PREVIEW_BYTES
  const fd = fs.openSync(filePath, 'r')
  const toRead = truncated ? MAX_FILE_PREVIEW_BYTES : size
  const buf = Buffer.alloc(toRead)
  fs.readSync(fd, buf, 0, toRead, 0)
  fs.closeSync(fd)

  if (isProbablyBinary(buf)) {
    return {
      path: filePath,
      content: '',
      size,
      truncated: false,
      isBinary: true,
      mtimeMs: stat.mtimeMs,
    }
  }
  return {
    path: filePath,
    content: buf.toString('utf-8'),
    size,
    truncated,
    isBinary: false,
    mtimeMs: stat.mtimeMs,
  }
}

const MAX_WRITE_BYTES = 5 * 1024 * 1024 // 5 MB

function assertWriteSize(content: string): void {
  if (Buffer.byteLength(content, 'utf-8') > MAX_WRITE_BYTES) {
    throw new FsOpError('E2BIG', `Content exceeds ${MAX_WRITE_BYTES} bytes`)
  }
}

/** Atomic write via temp file + rename. */
function atomicWrite(filePath: string, content: string): void {
  const dir = path.dirname(filePath)
  if (!fs.existsSync(dir)) {
    throw new FsOpError('ENOENT', `Parent directory does not exist: ${dir}`)
  }
  const tmp = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  )
  fs.writeFileSync(tmp, content, 'utf-8')
  fs.renameSync(tmp, filePath)
}

export function createFile(filePath: string, content: string): ReadFileResult {
  if (fs.existsSync(filePath)) {
    throw new FsOpError('EEXIST', `Already exists: ${filePath}`)
  }
  assertWriteSize(content)
  atomicWrite(filePath, content)
  return readFile(filePath)
}

/**
 * Save edits to an existing file. If `expectedMtimeMs` is provided and
 * doesn't match the current mtime, throws EMTIME (caller should surface
 * a 409 Conflict so the UI can prompt the user to reload).
 */
export function saveFile(
  filePath: string,
  content: string,
  expectedMtimeMs?: number,
): ReadFileResult {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw new FsOpError('ENOENT', `File not found: ${filePath}`)
  }
  if (expectedMtimeMs !== undefined) {
    const cur = fs.statSync(filePath).mtimeMs
    // ms can be fractional on some filesystems; allow 1ms tolerance.
    if (Math.abs(cur - expectedMtimeMs) > 1) {
      throw new FsOpError('EMTIME', `File modified externally: ${filePath}`)
    }
  }
  assertWriteSize(content)
  atomicWrite(filePath, content)
  return readFile(filePath)
}

export function makeDir(dirPath: string): { path: string } {
  if (fs.existsSync(dirPath)) {
    if (fs.statSync(dirPath).isDirectory()) return { path: dirPath }
    throw new FsOpError(
      'EEXIST',
      `Path exists and is not a directory: ${dirPath}`,
    )
  }
  fs.mkdirSync(dirPath, { recursive: true })
  return { path: dirPath }
}

export function removeEntry(targetPath: string): { path: string } {
  if (!fs.existsSync(targetPath)) {
    throw new FsOpError('ENOENT', `Not found: ${targetPath}`)
  }
  // Recursive delete for directories (files + nested folders). The UI asks
  // for confirmation before calling this endpoint.
  fs.rmSync(targetPath, { recursive: true, force: true })
  return { path: targetPath }
}

export class FsOpError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

// ── @-mention file search (fileSuggestions pattern, simplified) ──

export interface FileSearchEntry {
  /** Path relative to workspace root, forward slashes. */
  path: string
  isDir: boolean
}

export interface FileSearchResult {
  query: string
  entries: FileSearchEntry[]
}

const MAX_INDEX_ENTRIES = 12_000
const INDEX_TTL_MS = 30_000

let fileIndexCache: {
  root: string
  showHidden: boolean
  builtAt: number
  entries: FileSearchEntry[]
} | null = null

function toPosixRel(root: string, abs: string): string {
  return path.relative(root, abs).split(path.sep).join('/')
}

function buildFileIndex(root: string, showHidden: boolean): FileSearchEntry[] {
  const entries: FileSearchEntry[] = []

  function walk(absDir: string): void {
    if (entries.length >= MAX_INDEX_ENTRIES) return
    let items: fs.Dirent[]
    try {
      items = fs.readdirSync(absDir, { withFileTypes: true })
    } catch {
      return
    }
    for (const item of items) {
      if (!shouldListDirEntry(item.name, showHidden)) continue
      const abs = path.join(absDir, item.name)
      const rel = toPosixRel(root, abs)
      if (item.isDirectory()) {
        entries.push({ path: rel, isDir: true })
        if (!WALK_IGNORE_DIR_NAMES.has(item.name)) walk(abs)
      } else {
        entries.push({ path: rel, isDir: false })
      }
      if (entries.length >= MAX_INDEX_ENTRIES) return
    }
  }

  if (fs.existsSync(root) && fs.statSync(root).isDirectory()) {
    walk(root)
  }
  return entries
}

function getFileIndex(root: string, showHidden: boolean): FileSearchEntry[] {
  const now = Date.now()
  if (
    !fileIndexCache ||
    fileIndexCache.root !== root ||
    fileIndexCache.showHidden !== showHidden ||
    now - fileIndexCache.builtAt > INDEX_TTL_MS
  ) {
    fileIndexCache = {
      root,
      showHidden,
      builtAt: now,
      entries: buildFileIndex(root, showHidden),
    }
  }
  return fileIndexCache.entries
}

function scorePath(relPath: string, query: string): number {
  const lower = relPath.toLowerCase()
  const base = lower.split('/').pop() ?? lower
  if (base.startsWith(query)) return 200 - lower.length
  if (lower.startsWith(query)) return 150 - lower.length
  if (lower.includes(query)) return 80 - lower.length
  // Subsequence match on basename (light fuzzy)
  let qi = 0
  for (let i = 0; i < base.length && qi < query.length; i++) {
    if (base[i] === query[qi]) qi++
  }
  if (qi === query.length) return 40 - lower.length
  return 0
}

export function invalidateFileSearchCache(): void {
  fileIndexCache = null
}

export function searchFiles(
  root: string,
  query: string,
  limit = 15,
  showHidden = false,
): FileSearchResult {
  const q = query.trim().toLowerCase()
  const index = getFileIndex(root, showHidden)

  let matches: FileSearchEntry[]
  if (!q) {
    matches = [...index]
      .sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
        return a.path.localeCompare(b.path)
      })
      .slice(0, limit)
  } else {
    matches = index
      .map(entry => ({ entry, score: scorePath(entry.path, q) }))
      .filter(x => x.score > 0)
      .sort(
        (a, b) => b.score - a.score || a.entry.path.localeCompare(b.entry.path),
      )
      .slice(0, limit)
      .map(x => x.entry)
  }

  return { query, entries: matches }
}
