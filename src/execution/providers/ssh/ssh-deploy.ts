/**
 * Deploy baix-worker + integrations (stpl-lsp-bridge) to remote.
 */
import { spawn } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import type { ParsedSshHost } from './ssh-config.js'
import { shQuote, sshExecOk } from './ssh-exec.js'
import {
  getRepoRoot,
  getWorkerBundlePath,
  readWorkerVersion,
  resolveWorkerLaunch,
} from '../../worker-paths.js'
import type { WorkerInstallInfo } from '../../types.js'

function buildScpArgs(host: ParsedSshHost): string[] {
  const args: string[] = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15']
  if (host.port) args.push('-P', String(host.port))
  if (host.identityFile) args.push('-i', host.identityFile)
  if (host.proxyJump) args.push('-o', `ProxyJump=${host.proxyJump}`)
  return args
}

function scpUpload(
  host: ParsedSshHost,
  localPath: string,
  remoteRelPath: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const dest = host.user
      ? `${host.user}@${host.hostName}:${remoteRelPath}`
      : `${host.hostName}:${remoteRelPath}`
    const args = [...buildScpArgs(host), localPath, dest]
    const child = spawn('scp', args, { windowsHide: true, stdio: 'pipe' })
    let stderr = ''
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString('utf8')
    })
    child.on('error', reject)
    child.on('close', code => {
      if (code === 0) resolve()
      else
        reject(
          new Error(stderr.trim() || `scp exited ${code} uploading worker`),
        )
    })
  })
}

function scpUploadRecursive(
  host: ParsedSshHost,
  localDir: string,
  remoteRelDir: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const dest = host.user
      ? `${host.user}@${host.hostName}:${remoteRelDir}`
      : `${host.hostName}:${remoteRelDir}`
    const args = [...buildScpArgs(host), '-r', localDir, dest]
    const child = spawn('scp', args, { windowsHide: true, stdio: 'pipe' })
    let stderr = ''
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString('utf8')
    })
    child.on('error', reject)
    child.on('close', code => {
      if (code === 0) resolve()
      else
        reject(
          new Error(stderr.trim() || `scp -r exited ${code} uploading integrations`),
        )
    })
  })
}

/**
 * Ensure remote worker binary + STPL bridge match local build.
 */
export async function ensureRemoteWorker(
  host: ParsedSshHost,
  desiredVersion?: string,
): Promise<WorkerInstallInfo> {
  const version = desiredVersion ?? readWorkerVersion()
  const launch = resolveWorkerLaunch()
  if (launch.mode !== 'bundle') {
    throw new Error(
      'Remote Worker deploy requires a bundled artifact. Run: npm run build:worker',
    )
  }
  const localBundle = getWorkerBundlePath()
  if (!fs.existsSync(localBundle)) {
    throw new Error(`Missing worker bundle at ${localBundle}`)
  }

  const probe = await sshExecOk(
    host,
    `d="$HOME/.baix-agent-worker/${version}"; if [ -f "$d/.installed" ] && [ -f "$d/baix-worker.cjs" ]; then cat "$d/.installed"; else echo MISSING; fi`,
    { timeoutMs: 20_000 },
  )
  const installed = probe.trim().split(/\r?\n/)[0]
  const needUpload = installed !== version

  if (needUpload) {
    await sshExecOk(
      host,
      `mkdir -p "$HOME/.baix-agent-worker/${version}"`,
      { timeoutMs: 20_000 },
    )
    await scpUpload(
      host,
      localBundle,
      `.baix-agent-worker/${version}/baix-worker.cjs`,
    )
    const verLocal = path.join(path.dirname(localBundle), 'version.json')
    if (fs.existsSync(verLocal)) {
      await scpUpload(
        host,
        verLocal,
        `.baix-agent-worker/${version}/version.json`,
      )
    }

    // Ship STPL bridge + helpers so relative lspServers args resolve on remote.
    const bridgeSrc = path.join(
      getRepoRoot(),
      'integrations',
      'stpl-lsp-bridge',
    )
    if (fs.existsSync(bridgeSrc)) {
      await sshExecOk(
        host,
        `mkdir -p "$HOME/.baix-agent-worker/${version}/integrations"`,
        { timeoutMs: 15_000 },
      )
      await scpUploadRecursive(
        host,
        bridgeSrc,
        `.baix-agent-worker/${version}/integrations/stpl-lsp-bridge`,
      )
    }

    await sshExecOk(
      host,
      `printf '%s' ${shQuote(version)} > "$HOME/.baix-agent-worker/${version}/.installed"`,
      { timeoutMs: 15_000 },
    )
  }

  await sshExecOk(
    host,
    `test -f "$HOME/.baix-agent-worker/${version}/baix-worker.cjs"`,
    { timeoutMs: 15_000 },
  )

  return {
    version,
    path: `~/.baix-agent-worker/${version}/baix-worker.cjs`,
    freshlyInstalled: needUpload,
  }
}

/** Remote command that starts worker on stdio with BAIX_AGENT_ROOT set. */
export function remoteWorkerStdioCommand(version: string): string {
  return `export BAIX_AGENT_ROOT="$HOME/.baix-agent-worker/${version}"; export BAIX_WORKER_VERSION=${shQuote(version)}; node "$BAIX_AGENT_ROOT/baix-worker.cjs" --stdio`
}
