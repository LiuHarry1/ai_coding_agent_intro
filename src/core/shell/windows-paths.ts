/**
 * Windows paths + shell binary resolution (aligned with Claude Code
 * `utils/windowsPaths.ts` + powershell detection).
 *
 * Bash trailers use POSIX paths; Node I/O uses native Windows paths.
 */
import { existsSync } from 'fs'
import * as path from 'path'
import { spawnSync } from 'child_process'

const isWindows = process.platform === 'win32'

// ── Path conversion ──────────────────────────────────────────────────────────

/** `C:\Users\foo` → `/c/Users/foo`; UNC `\\server\share` → `//server/share`. */
export function windowsPathToPosixPath(windowsPath: string): string {
  if (windowsPath.startsWith('\\\\')) {
    return windowsPath.replace(/\\/g, '/')
  }
  const match = windowsPath.match(/^([A-Za-z]):[/\\]/)
  if (match) {
    const driveLetter = match[1]!.toLowerCase()
    return '/' + driveLetter + windowsPath.slice(2).replace(/\\/g, '/')
  }
  return windowsPath.replace(/\\/g, '/')
}

/**
 * `/c/Users/foo` → `C:\Users\foo`; also `/cygdrive/c/...` and `//server/share`.
 */
export function posixPathToWindowsPath(posixPath: string): string {
  if (posixPath.startsWith('//')) {
    return posixPath.replace(/\//g, '\\')
  }
  const cygdrive = posixPath.match(/^\/cygdrive\/([A-Za-z])(\/|$)/)
  if (cygdrive) {
    const drive = cygdrive[1]!.toUpperCase()
    const rest = posixPath.slice(('/cygdrive/' + cygdrive[1]).length)
    return drive + ':' + (rest || '\\').replace(/\//g, '\\')
  }
  const drive = posixPath.match(/^\/([A-Za-z])(\/|$)/)
  if (drive) {
    const letter = drive[1]!.toUpperCase()
    const rest = posixPath.slice(2).replace(/\//g, '\\')
    return letter + ':' + (rest || '\\')
  }
  if (/^[A-Za-z]:/.test(posixPath)) {
    return posixPath.replace(/\//g, '\\')
  }
  return posixPath
}

// ── Git Bash ─────────────────────────────────────────────────────────────────

let cachedGitBash: string | null | undefined

/**
 * Locate Git for Windows bash.exe.
 * Order: GIT_BASH_PATH → CLAUDE_CODE_GIT_BASH_PATH → Program Files → where git.
 * Returns null if missing — never fall back to System32/WSL bash.
 */
export function findGitBashPath(): string | null {
  if (!isWindows) return null
  if (cachedGitBash !== undefined) return cachedGitBash

  for (const envKey of ['GIT_BASH_PATH', 'CLAUDE_CODE_GIT_BASH_PATH']) {
    const fromEnv = process.env[envKey]?.trim()
    if (fromEnv && existsSync(fromEnv)) {
      cachedGitBash = fromEnv
      return cachedGitBash
    }
  }

  for (const p of [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
  ]) {
    if (existsSync(p)) {
      cachedGitBash = p
      return cachedGitBash
    }
  }

  try {
    const r = spawnSync('where', ['git'], {
      encoding: 'utf8',
      windowsHide: true,
    })
    const cwdNorm = process.cwd().toLowerCase()
    const sep = path.sep.toLowerCase()
    for (const gitExe of (r.stdout ?? '')
      .trim()
      .split(/\r?\n/)
      .map(l => l.trim())
      .filter(Boolean)) {
      if (gitExe.toLowerCase().startsWith(cwdNorm + sep)) continue
      const bashPath = path.join(
        path.dirname(gitExe),
        '..',
        '..',
        'bin',
        'bash.exe',
      )
      if (existsSync(bashPath)) {
        cachedGitBash = bashPath
        return cachedGitBash
      }
    }
  } catch {
    // where.exe / git missing
  }

  cachedGitBash = null
  return null
}

function pickUnixShell(): string {
  const userShell = process.env.SHELL
  if (userShell && /\/(bash|zsh|sh)$/.test(userShell)) return userShell
  return '/bin/bash'
}

/**
 * Bash binary for tool/worker spawn.
 * Windows: Git Bash only (throws if missing).
 */
export function resolveBashExecutable(): string {
  if (!isWindows) return pickUnixShell()
  const gitBash = findGitBashPath()
  if (!gitBash) {
    throw new Error(
      'Git Bash not found. Install Git for Windows (https://git-scm.com/downloads/win) ' +
        'or set GIT_BASH_PATH (or CLAUDE_CODE_GIT_BASH_PATH) to bash.exe. ' +
        'Alternatively use the PowerShell tool.',
    )
  }
  return gitBash
}

// ── PowerShell ───────────────────────────────────────────────────────────────

let cachedPwsh: string | undefined

/** Prefer pwsh (PS 7+) when on PATH; else Windows PowerShell 5.1. Cached. */
export function resolvePowerShellExecutable(): string {
  if (!isWindows) return 'powershell.exe'
  if (cachedPwsh !== undefined) return cachedPwsh
  try {
    const r = spawnSync('where', ['pwsh'], {
      encoding: 'utf8',
      windowsHide: true,
    })
    const line = r.stdout?.trim().split(/\r?\n/)[0]
    if (line) {
      cachedPwsh = line
      return cachedPwsh
    }
  } catch {
    // ignore
  }
  cachedPwsh = 'powershell.exe'
  return cachedPwsh
}
