/**
 * Shared shell spawn (aligned with Claude Code `utils/Shell.ts` + providers).
 * Worker `exec` and in-process shell-runner both call this — one wrap/args/cwd story.
 */
import { spawn, type ChildProcess } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  posixPathToWindowsPath,
  resolveBashExecutable,
  resolvePowerShellExecutable,
  windowsPathToPosixPath,
} from './windows-paths.js'
import { forceKillChild, killChild } from '../platform.js'
import { getShellHome } from '../../utils/request-scope.js'
import { WORKER_CWD_FILE_PREFIX } from '../../brand.js'

const isWindows = process.platform === 'win32'

/** Shell used by Bash / PowerShell tools and Worker `fs_op.exec`. */
export type ShellKind = 'bash' | 'powershell'

export type PreparedShellSpawn = {
  shellKind: ShellKind
  command: string
  args: string[]
  env: NodeJS.ProcessEnv
  /** Native path for Node readFileSync / unlinkSync. */
  cwdFileNative: string
}

export type ShellExecResult = {
  stdout: string
  stderr: string
  code: number | null
  cwdAfter?: string
  child: ChildProcess
}

function makeCwdFile(prefix: string): string {
  return path.join(
    os.tmpdir(),
    `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  )
}

function wrapBash(userCmd: string, cwdFileForBash: string): string {
  return `${userCmd}\n__ec=$?\npwd -P > '${cwdFileForBash}' 2>/dev/null\nexit $__ec`
}

function wrapPowerShell(userCmd: string, cwdFileNative: string): string {
  const escaped = cwdFileNative.replace(/'/g, "''")
  return [
    userCmd,
    `$_ec = if ($null -ne $LASTEXITCODE) { $LASTEXITCODE } elseif ($?) { 0 } else { 1 }`,
    `(Get-Location).Path | Out-File -FilePath '${escaped}' -Encoding utf8 -NoNewline`,
    `exit $_ec`,
  ].join('\n')
}

/** Build spawn argv/env; bash on Windows uses POSIX cwd-file path in the trailer. */
export function prepareShellSpawn(opts: {
  shell: ShellKind
  userCommand: string
  cwdFilePrefix?: string
}): PreparedShellSpawn {
  const cwdFileNative = makeCwdFile(opts.cwdFilePrefix ?? 'agent-shell-cwd')

  const agentHome = getShellHome()
  const homeEnv: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: agentHome,
    ...(isWindows ? { USERPROFILE: agentHome } : {}),
  }

  if (opts.shell === 'powershell') {
    return {
      shellKind: 'powershell',
      command: resolvePowerShellExecutable(),
      args: [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        wrapPowerShell(opts.userCommand, cwdFileNative),
      ],
      env: homeEnv,
      cwdFileNative,
    }
  }

  const cwdFileForBash = isWindows
    ? windowsPathToPosixPath(cwdFileNative)
    : cwdFileNative
  return {
    shellKind: 'bash',
    command: resolveBashExecutable(),
    args: isWindows
      ? ['-c', wrapBash(opts.userCommand, cwdFileForBash)]
      : ['-lc', wrapBash(opts.userCommand, cwdFileForBash)],
    env: { ...homeEnv, TERM: 'dumb' },
    cwdFileNative,
  }
}

/** Read cwd trailer; convert bash/MSYS pwd to native on Windows. */
export function readCwdAfter(
  cwdFileNative: string,
  shellKind: ShellKind,
): string | undefined {
  try {
    const tracked = fs.readFileSync(cwdFileNative, 'utf8').trim()
    if (!tracked) return undefined
    if (shellKind !== 'bash' || !isWindows) return tracked
    const native = posixPathToWindowsPath(tracked)
    if (native.startsWith('/') && !/^[A-Za-z]:/.test(native)) {
      return undefined
    }
    return native
  } catch {
    return undefined
  }
}

export function cleanupCwdFile(cwdFileNative: string): void {
  try {
    fs.unlinkSync(cwdFileNative)
  } catch {
    // ignore
  }
}

/** Foreground shell exec for Worker / simple callers. */
export function runShellCommand(opts: {
  shell: ShellKind
  command: string
  cwd: string
  timeoutMs: number
  cwdFilePrefix?: string
}): Promise<Omit<ShellExecResult, 'child'> & { cwdAfter?: string }> {
  let prepared: PreparedShellSpawn
  try {
    prepared = prepareShellSpawn({
      shell: opts.shell,
      userCommand: opts.command,
      cwdFilePrefix: opts.cwdFilePrefix ?? WORKER_CWD_FILE_PREFIX,
    })
  } catch (err) {
    return Promise.reject(err instanceof Error ? err : new Error(String(err)))
  }

  return new Promise((resolve, reject) => {
    const child = spawn(prepared.command, prepared.args, {
      cwd: opts.cwd,
      env: prepared.env,
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    let settled = false

    const timer = setTimeout(() => {
      killChild(child)
      setTimeout(() => {
        forceKillChild(child)
        if (settled) return
        settled = true
        cleanupCwdFile(prepared.cwdFileNative)
        reject(new Error(`exec timed out after ${opts.timeoutMs}ms`))
      }, 3000)
    }, opts.timeoutMs)

    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString('utf8')
    })
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString('utf8')
    })
    child.on('error', err => {
      clearTimeout(timer)
      if (settled) return
      settled = true
      cleanupCwdFile(prepared.cwdFileNative)
      reject(err)
    })
    child.on('close', code => {
      clearTimeout(timer)
      if (settled) return
      settled = true
      const cwdAfter = readCwdAfter(prepared.cwdFileNative, prepared.shellKind)
      cleanupCwdFile(prepared.cwdFileNative)
      resolve({ stdout, stderr, code, cwdAfter })
    })
  })
}
