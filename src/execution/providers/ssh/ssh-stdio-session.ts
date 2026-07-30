/**
 * Long-lived SSH session with stdio piped to remote Worker.
 */
import { spawn, type ChildProcess } from 'child_process'
import { buildSshArgs, type ParsedSshHost } from './ssh-config.js'
import { remoteWorkerStdioCommand } from './ssh-deploy.js'
import {
  StdioRuntimePort,
  bindStdioRuntime,
} from '../../stdio-runtime-port.js'
import type { RuntimeAuth, RuntimePort, WorkspaceHandle } from '../../types.js'

export async function openSshWorkerRuntime(
  host: ParsedSshHost,
  workspace: WorkspaceHandle,
  version: string,
  _auth: RuntimeAuth,
): Promise<RuntimePort> {
  const args = buildSshArgs(host, [
    // Force remote to allocate no TTY; keep stdin open for NDJSON.
    '-T',
    '-o',
    'ServerAliveInterval=30',
  ])
  args.push(remoteWorkerStdioCommand(version))

  const child: ChildProcess = spawn('ssh', args, {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  if (!child.stdin || !child.stdout) {
    child.kill()
    throw new Error('SSH worker stdio unavailable')
  }

  const port = new StdioRuntimePort({
    workspace,
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr ?? undefined,
    child,
  })

  await bindStdioRuntime(port, workspace, 90_000)
  return port
}
