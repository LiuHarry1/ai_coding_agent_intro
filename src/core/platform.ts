import * as path from 'path'
import { spawn, spawnSync, type ChildProcess } from 'child_process'
import { findGitBashPath } from './shell/git-bash.js'

export const isWindows = process.platform === 'win32'

// ── Shell configurations ──
//
// `bash` is always available; on Windows `powershell` is added too.
// Default shell for prompts / `!` expansion is bash (Git Bash on Windows).
// Both share `tools/shell-runner.ts`; only spawn config + descriptions differ.

export interface ShellConfig {
  name: string
  /** Path/name of the shell binary to spawn. */
  command: string
  /** Build the args array for `spawn(command, args)`. The arg passed in
   *  here is the full wrapped command string (user command + cwd-tracking +
   *  exit-code propagation). */
  buildArgs(wrappedCmd: string): string[]
  /** Env overrides merged into the child process. */
  spawnEnv(): NodeJS.ProcessEnv
  /**
   * Wrap the user's raw command so it: (1) runs the user command, (2) writes
   * the post-command working directory into `cwdFile`, (3) exits with the
   * user command's exit code (NOT the trailer's). The shell-runner reads
   * `cwdFile` after the child closes to persist `cd` across calls.
   */
  wrapCommand(userCmd: string, cwdFile: string): string
}

// On Unix, prefer the user's $SHELL so login-shell rc files (.zprofile for
// zsh, .bash_profile / .profile for bash) are sourced, picking up PATH /
// homebrew / asdf / nvm / volta entries the user actually configured.
// Falls back to /bin/bash, present on every Unix-like system. NB: -l
// (login) sources profile files but NOT .bashrc / .zshrc — those are
// interactive-only. We trade off a bit of completeness for safety (no
// $PS1 emission, no `bind` errors).
function pickUnixShell(): string {
  const userShell = process.env.SHELL
  if (userShell && /\/(bash|zsh|sh)$/.test(userShell)) return userShell
  return '/bin/bash'
}

const unixShellPath = isWindows ? '' : pickUnixShell()

function resolveBashCommand(): string {
  if (!isWindows) return unixShellPath
  return findGitBashPath() ?? 'bash'
}

/** Prefer pwsh (PS 7+) when on PATH; else Windows PowerShell 5.1. */
function resolvePowerShellCommand(): string {
  if (!isWindows) return 'powershell.exe'
  try {
    const r = spawnSync('where', ['pwsh'], {
      encoding: 'utf8',
      windowsHide: true,
    })
    const line = r.stdout?.trim().split(/\r?\n/)[0]
    if (line) return line
  } catch {}
  return 'powershell.exe'
}

export const bashShell: ShellConfig = {
  name: 'bash',
  command: resolveBashCommand(),
  // -l: login shell — sources .bash_profile / .profile / .zprofile so
  //     the model sees the user's PATH, not the bare /usr/bin spawn PATH.
  // -c: run the command string that follows.
  // Order matters: `-lc` is portable across bash/zsh/sh.
  buildArgs: cmd => ['-lc', cmd],
  // TERM=dumb suppresses ANSI color codes that would clutter the SSE stream
  // and confuse downstream tools that read the captured output as text.
  spawnEnv: () => ({ ...process.env, TERM: 'dumb' }),
  wrapCommand: (userCmd, cwdFile) =>
    // The trailer runs whether `userCmd` succeeded or failed (no `&&`).
    // `__ec=$?` snapshots the user command's exit code BEFORE the pwd write
    // can clobber it, then `exit $__ec` propagates it as the shell's exit.
    // Single-quote the cwdFile path so spaces / `$` survive (path is our
    // own tmpdir name, but defensive quoting costs nothing).
    `${userCmd}\n__ec=$?\npwd -P > '${cwdFile}' 2>/dev/null\nexit $__ec`,
}

export const powershellShell: ShellConfig = {
  name: 'powershell',
  command: resolvePowerShellCommand(),
  // -NoProfile: skip $PROFILE (can be slow + emits prompt junk).
  // -NonInteractive: refuse Read-Host / Get-Credential prompts (would hang).
  // -ExecutionPolicy Bypass: allow inline -Command script blocks on
  //   locked-down systems where the default Restricted policy applies.
  buildArgs: cmd => [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    cmd,
  ],
  spawnEnv: () => ({ ...process.env }),
  wrapCommand: (userCmd, cwdFile) => {
    // Escape single quotes in the cwdFile path for PS literal-string syntax.
    // PS escapes `'` as `''` inside a single-quoted string.
    const escaped = cwdFile.replace(/'/g, "''")
    // Exit-code rule:
    //   prefer $LASTEXITCODE when a native exe ran (covers the PS 5.1
    //   bug where `git push 2>&1` sets $? = $false even on exit 0);
    //   else fall back to $? for cmdlet-only pipelines;
    //   else 1 (cmdlet failed without setting $LASTEXITCODE).
    return [
      userCmd,
      `$_ec = if ($null -ne $LASTEXITCODE) { $LASTEXITCODE } elseif ($?) { 0 } else { 1 }`,
      `(Get-Location).Path | Out-File -FilePath '${escaped}' -Encoding utf8 -NoNewline`,
      `exit $_ec`,
    ].join('\n')
  },
}

/** One-line platform summary for system prompts. Intentionally shell-agnostic;
 *  the registered shell tool's name conveys which shell is in use. */
export const platformLabel = `${process.platform} (${process.arch})`

// ── Process management ──
//
// killChild / forceKillChild are platform-specific (taskkill vs SIGTERM),
// not shell-specific. Both bash and powershell spawned children go through
// the same node `child_process` API and share these helpers.

export function killChild(child: ChildProcess): void {
  if (isWindows) {
    try {
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
      })
    } catch {}
  } else {
    child.kill('SIGTERM')
    setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {}
    }, 3000)
  }
}

export function forceKillChild(child: ChildProcess): void {
  if (isWindows) {
    try {
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
      })
    } catch {}
  } else {
    try {
      child.kill('SIGKILL')
    } catch {}
  }
}

// ── Path handling ──

/** Normalize a path for case-insensitive comparison on Windows. */
export function normalizePathForCompare(p: string): string {
  const resolved = path.resolve(p)
  return isWindows ? resolved.toLowerCase() : resolved
}

/**
 * Normalize git output paths to OS convention.
 * Git on Windows returns forward-slash paths (C:/Users/...);
 * this converts to the OS-native format.
 */
export function normalizeGitPath(gitPath: string): string {
  return path.resolve(gitPath)
}
