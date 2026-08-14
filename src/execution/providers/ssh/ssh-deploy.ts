/**
 * Deploy agent worker + integrations (stpl-lsp-bridge) to remote.
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
import {
  WORKER_BUNDLE_NAME,
  WORKER_HOME_DIRNAME,
} from '../../../brand.js'

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

function localBridgeSrc(): string | null {
  const src = path.join(getRepoRoot(), 'integrations', 'stpl-lsp-bridge')
  return fs.existsSync(path.join(src, 'index.js')) ? src : null
}

/**
 * Ship STPL bridge so relative lspServers args resolve on remote.
 * Runs even when the worker version stamp already matches (repair path).
 */
async function ensureRemoteBridge(
  host: ParsedSshHost,
  homeDir: string,
  version: string,
): Promise<boolean> {
  const bridgeSrc = localBridgeSrc()
  if (!bridgeSrc) return false

  const probe = await sshExecOk(
    host,
    `d="$HOME/${homeDir}/${version}"; if [ -f "$d/integrations/stpl-lsp-bridge/index.js" ]; then echo OK; else echo MISSING; fi`,
    { timeoutMs: 15_000 },
  )
  if (probe.trim().split(/\r?\n/)[0] === 'OK') return false

  await sshExecOk(
    host,
    `rm -rf "$HOME/${homeDir}/${version}/integrations/stpl-lsp-bridge" && mkdir -p "$HOME/${homeDir}/${version}/integrations"`,
    { timeoutMs: 15_000 },
  )
  // Upload into integrations/ so the local folder name becomes stpl-lsp-bridge/
  // (scp -r to .../stpl-lsp-bridge nests when that path already exists).
  await scpUploadRecursive(
    host,
    bridgeSrc,
    `${homeDir}/${version}/integrations`,
  )
  await sshExecOk(
    host,
    `test -f "$HOME/${homeDir}/${version}/integrations/stpl-lsp-bridge/index.js"`,
    { timeoutMs: 15_000 },
  )
  return true
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

  const homeDir = WORKER_HOME_DIRNAME
  const bundleName = WORKER_BUNDLE_NAME

  const probe = await sshExecOk(
    host,
    `d="$HOME/${homeDir}/${version}"; if [ -f "$d/.installed" ] && [ -f "$d/${bundleName}" ]; then cat "$d/.installed"; else echo MISSING; fi`,
    { timeoutMs: 20_000 },
  )
  const installed = probe.trim().split(/\r?\n/)[0]
  const needUpload = installed !== version

  if (needUpload) {
    await sshExecOk(
      host,
      `mkdir -p "$HOME/${homeDir}/${version}"`,
      { timeoutMs: 20_000 },
    )
    await scpUpload(
      host,
      localBundle,
      `${homeDir}/${version}/${bundleName}`,
    )
    const verLocal = path.join(path.dirname(localBundle), 'version.json')
    if (fs.existsSync(verLocal)) {
      await scpUpload(
        host,
        verLocal,
        `${homeDir}/${version}/version.json`,
      )
    }

    await sshExecOk(
      host,
      `printf '%s' ${shQuote(version)} > "$HOME/${homeDir}/${version}/.installed"`,
      { timeoutMs: 15_000 },
    )
  }

  // Bridge is independent of worker version stamp: older installs / Electron
  // packs without integrations/ left AGENT_ROOT with no index.js.
  const bridgeUploaded = await ensureRemoteBridge(host, homeDir, version)

  await sshExecOk(
    host,
    `test -f "$HOME/${homeDir}/${version}/${bundleName}"`,
    { timeoutMs: 15_000 },
  )

  return {
    version,
    path: `~/${homeDir}/${version}/${bundleName}`,
    freshlyInstalled: needUpload || bridgeUploaded,
  }
}

/** Remote command that starts worker on stdio with AGENT_ROOT set. */
export function remoteWorkerStdioCommand(version: string): string {
  const homeDir = WORKER_HOME_DIRNAME
  const bundleName = WORKER_BUNDLE_NAME
  return `export AGENT_ROOT="$HOME/${homeDir}/${version}"; export WORKER_VERSION=${shQuote(version)}; node "$AGENT_ROOT/${bundleName}" --stdio`
}
