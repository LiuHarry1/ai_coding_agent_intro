import { spawn } from 'child_process'
import { buildSshArgs, type ParsedSshHost } from './ssh-config.js'

export class SshExecError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
    readonly stderr: string,
  ) {
    super(message)
    this.name = 'SshExecError'
  }
}

/**
 * Run a remote command via system `ssh` CLI (BatchMode).
 */
export function sshExec(
  host: ParsedSshHost,
  remoteCommand: string,
  opts?: { timeoutMs?: number },
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  const timeoutMs = opts?.timeoutMs ?? 60_000
  const args = buildSshArgs(host)
  args.push(remoteCommand)

  return new Promise((resolve, reject) => {
    const child = spawn('ssh', args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(
        new SshExecError(`SSH timed out after ${timeoutMs}ms`, null, stderr),
      )
    }, timeoutMs)

    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString('utf8')
    })
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString('utf8')
    })
    child.on('error', err => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', code => {
      clearTimeout(timer)
      resolve({ stdout, stderr, code })
    })
  })
}

export async function sshExecOk(
  host: ParsedSshHost,
  remoteCommand: string,
  opts?: { timeoutMs?: number },
): Promise<string> {
  const { stdout, stderr, code } = await sshExec(host, remoteCommand, opts)
  if (code !== 0) {
    throw new SshExecError(
      stderr.trim() || stdout.trim() || `ssh exited ${code}`,
      code,
      stderr,
    )
  }
  return stdout
}

/** Probe connectivity with a trivial remote command. */
export async function sshProbe(host: ParsedSshHost): Promise<void> {
  await sshExecOk(host, 'echo ok', { timeoutMs: 20_000 })
}

/** Escape for single-quoted remote shell string. */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\"'\"'`)}'`
}
