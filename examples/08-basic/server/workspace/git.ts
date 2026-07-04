import { execFile } from 'child_process'
import * as path from 'path'
import * as fs from 'fs'

/**
 * Read-only git helpers for the workspace IDE's "Changes" view.
 *
 * - Status: parse `git status --porcelain=v1 -z --untracked-files=all`
 *   plus `git diff --numstat -z HEAD` for line counts.
 * - Diff:   compare HEAD vs working tree for tracked files; treat
 *   untracked as "all added" and deleted as "all removed".
 *
 * Path-safety: every caller-supplied path is joined against the workspace
 * root and the result must remain inside it. The wider workspace module
 * intentionally doesn't sandbox `resolvePath`, but git operations are
 * tied to a specific repo and we don't want a stray `..` to leak diffs
 * from outside the tree.
 */

const MAX_DIFF_BYTES = 1.5 * 1024 * 1024

export type ChangeStatus =
  | 'modified'
  | 'added'
  | 'deleted'
  | 'untracked'
  | 'renamed'

export interface ChangeEntry {
  path: string
  absPath: string
  status: ChangeStatus
  oldPath?: string
  insertions: number
  deletions: number
  isBinary: boolean
}

export interface ChangesSummary {
  isGitRepo: boolean
  branch: string | null
  entries: ChangeEntry[]
  totals: { files: number; insertions: number; deletions: number }
}

export interface FileDiff {
  path: string
  status: ChangeStatus
  isBinary: boolean
  oldContent: string
  newContent: string
  truncated: boolean
}

function gitExec(
  root: string,
  args: string[],
  opts: { allowFailure?: boolean; maxBuffer?: number } = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      {
        cwd: root,
        maxBuffer: opts.maxBuffer ?? 16 * 1024 * 1024,
        // Binary-safe: keep bytes intact for the porcelain `-z` parser.
        encoding: 'buffer',
      } as any,
      (err, stdoutBuf, stderrBuf) => {
        const stdout = Buffer.isBuffer(stdoutBuf)
          ? stdoutBuf.toString('utf8')
          : String(stdoutBuf || '')
        const stderr = Buffer.isBuffer(stderrBuf)
          ? stderrBuf.toString('utf8')
          : String(stderrBuf || '')
        if (err) {
          const code =
            (err as NodeJS.ErrnoException & { code?: number }).code ?? 1
          if (opts.allowFailure) {
            resolve({
              stdout,
              stderr,
              code: typeof code === 'number' ? code : 1,
            })
          } else {
            reject(Object.assign(err, { stderr }))
          }
          return
        }
        resolve({ stdout, stderr, code: 0 })
      },
    )
  })
}

/** True iff the directory is inside a git working tree. */
async function isGitRepo(root: string): Promise<boolean> {
  if (!fs.existsSync(root)) return false
  try {
    const r = await gitExec(root, ['rev-parse', '--is-inside-work-tree'], {
      allowFailure: true,
    })
    return r.code === 0 && r.stdout.trim() === 'true'
  } catch {
    return false
  }
}

async function currentBranch(root: string): Promise<string | null> {
  try {
    const r = await gitExec(root, ['rev-parse', '--abbrev-ref', 'HEAD'], {
      allowFailure: true,
    })
    if (r.code !== 0) return null
    const name = r.stdout.trim()
    return name === 'HEAD' ? null : name
  } catch {
    return null
  }
}

/**
 * Parse `git status --porcelain=v1 -z`. Records are NUL-separated;
 * renames occupy TWO records: `R<x> newPath\0oldPath\0`.
 *
 * We collapse XY → a single high-level status:
 *   `??`     → untracked
 *   `R*`/`*R`→ renamed
 *   `*D`/`D*`→ deleted
 *   `*A`/`A*`→ added
 *   anything else with a non-space → modified
 */
function parseStatusZ(buf: string): Array<{
  status: ChangeStatus
  path: string
  oldPath?: string
}> {
  const out: Array<{ status: ChangeStatus; path: string; oldPath?: string }> =
    []
  // Walk records: each starts with 2 status chars + space.
  let i = 0
  while (i < buf.length) {
    // A record looks like "XY path\0" (or "R<x> new\0old\0").
    const x = buf[i]
    const y = buf[i + 1]
    if (x === undefined || y === undefined) break
    // Skip the space at index i+2.
    let end = buf.indexOf('\0', i + 3)
    if (end === -1) break
    const filePath = buf.slice(i + 3, end)
    let oldPath: string | undefined
    let status: ChangeStatus

    const isRename = x === 'R' || y === 'R'
    if (isRename) {
      const oldEnd = buf.indexOf('\0', end + 1)
      if (oldEnd === -1) break
      oldPath = buf.slice(end + 1, oldEnd)
      end = oldEnd
      status = 'renamed'
    } else if (x === '?' && y === '?') {
      status = 'untracked'
    } else if (x === 'D' || y === 'D') {
      status = 'deleted'
    } else if (x === 'A' || y === 'A') {
      status = 'added'
    } else {
      status = 'modified'
    }

    out.push({ status, path: filePath, oldPath })
    i = end + 1
  }
  return out
}

/**
 * `git diff --numstat -z HEAD` for tracked changes. Output format
 * (NUL-separated): `<ins>\t<del>\t<path>\0` per record. Binary files
 * report `-\t-`. Renames produce `<ins>\t<del>\t<old>\0<new>\0` —
 * we key by the new path to align with status entries.
 */
async function trackedNumstats(
  root: string,
): Promise<
  Map<string, { insertions: number; deletions: number; isBinary: boolean }>
> {
  const r = await gitExec(root, ['diff', '--numstat', '-z', 'HEAD'], {
    allowFailure: true,
  })
  const out = new Map<
    string,
    { insertions: number; deletions: number; isBinary: boolean }
  >()
  if (r.code !== 0) return out
  const buf = r.stdout
  let i = 0
  while (i < buf.length) {
    const tab1 = buf.indexOf('\t', i)
    if (tab1 === -1) break
    const tab2 = buf.indexOf('\t', tab1 + 1)
    if (tab2 === -1) break
    const insRaw = buf.slice(i, tab1)
    const delRaw = buf.slice(tab1 + 1, tab2)
    let end = buf.indexOf('\0', tab2 + 1)
    if (end === -1) break
    let p = buf.slice(tab2 + 1, end)
    // Rename: numstat path is empty → next NUL-separated pair is old\0new\0
    if (!p) {
      const e2 = buf.indexOf('\0', end + 1)
      if (e2 === -1) break
      end = e2
      const e3 = buf.indexOf('\0', end + 1)
      if (e3 === -1) break
      p = buf.slice(end + 1, e3)
      end = e3
    }
    const isBinary = insRaw === '-' && delRaw === '-'
    out.set(p, {
      insertions: isBinary ? 0 : parseInt(insRaw, 10) || 0,
      deletions: isBinary ? 0 : parseInt(delRaw, 10) || 0,
      isBinary,
    })
    i = end + 1
  }
  return out
}

/** Best-effort line count for untracked files. */
function countLines(absPath: string): number {
  try {
    const buf = fs.readFileSync(absPath)
    if (buf.length === 0) return 0
    let n = 0
    for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a) n++
    if (buf[buf.length - 1] !== 0x0a) n++
    return n
  } catch {
    return 0
  }
}

/**
 * Cheap binary heuristic for untracked files: a NUL byte in the first
 * 8KB. Matches what most diff tools (and git itself) do for new files.
 */
function looksBinary(absPath: string): boolean {
  try {
    const fd = fs.openSync(absPath, 'r')
    try {
      const buf = Buffer.alloc(8192)
      const n = fs.readSync(fd, buf, 0, buf.length, 0)
      for (let i = 0; i < n; i++) if (buf[i] === 0) return true
      return false
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return false
  }
}

export async function gitStatus(root: string): Promise<ChangesSummary> {
  if (!(await isGitRepo(root))) {
    return {
      isGitRepo: false,
      branch: null,
      entries: [],
      totals: { files: 0, insertions: 0, deletions: 0 },
    }
  }
  const [statusRes, numstats, branch] = await Promise.all([
    gitExec(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
    trackedNumstats(root),
    currentBranch(root),
  ])
  const raw = parseStatusZ(statusRes.stdout)

  const entries: ChangeEntry[] = raw.map(r => {
    const absPath = path.resolve(root, r.path)
    if (r.status === 'untracked') {
      const isBinary = looksBinary(absPath)
      return {
        path: r.path,
        absPath,
        status: r.status,
        insertions: isBinary ? 0 : countLines(absPath),
        deletions: 0,
        isBinary,
      }
    }
    const n = numstats.get(r.path)
    return {
      path: r.path,
      absPath,
      status: r.status,
      oldPath: r.oldPath,
      insertions: n?.insertions ?? 0,
      deletions: n?.deletions ?? 0,
      isBinary: n?.isBinary ?? false,
    }
  })

  // Stable sort: directory + path so siblings group naturally.
  entries.sort((a, b) => a.path.localeCompare(b.path))

  const totals = entries.reduce(
    (acc, e) => ({
      files: acc.files + 1,
      insertions: acc.insertions + e.insertions,
      deletions: acc.deletions + e.deletions,
    }),
    { files: 0, insertions: 0, deletions: 0 },
  )

  return { isGitRepo: true, branch, entries, totals }
}

/** Read HEAD:<path>; returns "" if the file didn't exist at HEAD. */
async function readHead(root: string, p: string): Promise<string> {
  const r = await gitExec(root, ['show', `HEAD:${p}`], {
    allowFailure: true,
  })
  if (r.code !== 0) return ''
  return r.stdout
}

function readWorking(absPath: string): string {
  try {
    const stat = fs.statSync(absPath)
    if (stat.size > MAX_DIFF_BYTES) return ''
    return fs.readFileSync(absPath, 'utf8')
  } catch {
    return ''
  }
}

/** Resolve a status row by relative path so the client doesn't need to. */
async function findEntry(
  root: string,
  relPath: string,
): Promise<ChangeEntry | null> {
  const summary = await gitStatus(root)
  return summary.entries.find(e => e.path === relPath) ?? null
}

export async function gitDiff(
  root: string,
  relPath: string,
): Promise<FileDiff> {
  if (!(await isGitRepo(root))) {
    throw new Error('Not a git repository')
  }
  const entry = await findEntry(root, relPath)
  if (!entry) {
    return {
      path: relPath,
      status: 'modified',
      isBinary: false,
      oldContent: '',
      newContent: readWorking(path.resolve(root, relPath)),
      truncated: false,
    }
  }

  const absPath = entry.absPath
  const stat = fs.existsSync(absPath) ? fs.statSync(absPath) : null
  const truncated = (stat?.size ?? 0) > MAX_DIFF_BYTES

  let oldContent = ''
  let newContent = ''

  if (entry.isBinary) {
    return {
      path: entry.path,
      status: entry.status,
      isBinary: true,
      oldContent: '',
      newContent: '',
      truncated,
    }
  }

  switch (entry.status) {
    case 'untracked':
      newContent = readWorking(absPath)
      break
    case 'deleted':
      oldContent = await readHead(root, entry.path)
      break
    case 'renamed':
      oldContent = entry.oldPath ? await readHead(root, entry.oldPath) : ''
      newContent = readWorking(absPath)
      break
    case 'added':
    case 'modified':
    default:
      oldContent = await readHead(root, entry.path)
      newContent = readWorking(absPath)
      break
  }

  return {
    path: entry.path,
    status: entry.status,
    isBinary: false,
    oldContent,
    newContent,
    truncated,
  }
}
