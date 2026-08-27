/**
 * Resolve bundled agent/worker artifact paths and spawn commands.
 */
import * as fs from 'fs'
import * as path from 'path'
import { createRequire } from 'module'
import { fileURLToPath } from 'url'
import {
  AGENT_BUNDLE_NAME,
  WORKER_BUNDLE_NAME,
  agentNativeFileName,
} from '../brand.js'

declare const __dirname: string | undefined
declare const __filename: string | undefined

function moduleDir(): string {
  if (typeof __dirname === 'string') {
    return __dirname
  }
  return path.dirname(fileURLToPath(import.meta.url))
}

function moduleRequire(): NodeRequire {
  if (typeof __filename === 'string') {
    return createRequire(__filename)
  }
  return createRequire(import.meta.url)
}

/** Repo / install root. Packaged desktop sets AGENT_ROOT to the app directory. */
export function getRepoRoot(): string {
  if (process.env.AGENT_ROOT) {
    return path.resolve(process.env.AGENT_ROOT)
  }
  return path.resolve(moduleDir(), '../..')
}

export function getAgentBundlePath(): string {
  return path.join(getRepoRoot(), 'dist', 'agent', AGENT_BUNDLE_NAME)
}

export function getAgentNativePath(
  platform: NodeJS.Platform = process.platform,
): string {
  return path.join(
    getRepoRoot(),
    'dist',
    'agent',
    agentNativeFileName(platform),
  )
}

export function getAgentVersionPath(): string {
  return path.join(getRepoRoot(), 'dist', 'agent', 'version.json')
}

export function readAgentVersion(): string {
  try {
    const raw = fs.readFileSync(getAgentVersionPath(), 'utf8')
    const j = JSON.parse(raw) as { version?: string }
    if (j.version) return j.version
  } catch {
    /* fall through */
  }
  return (
    process.env.WORKER_VERSION ??
    process.env.npm_package_version ??
    '1.0.0'
  )
}

export function getWorkerBundlePath(): string {
  const cjs = path.join(getRepoRoot(), 'dist', 'worker', WORKER_BUNDLE_NAME)
  if (fs.existsSync(cjs)) return cjs
  return path.join(
    getRepoRoot(),
    'dist',
    'worker',
    WORKER_BUNDLE_NAME.replace(/\.cjs$/, '.js'),
  )
}

export function getWorkerVersionPath(): string {
  return path.join(getRepoRoot(), 'dist', 'worker', 'version.json')
}

export function readWorkerVersion(): string {
  if (fs.existsSync(getAgentVersionPath())) {
    return readAgentVersion()
  }
  try {
    const raw = fs.readFileSync(getWorkerVersionPath(), 'utf8')
    const j = JSON.parse(raw) as { version?: string }
    if (j.version) return j.version
  } catch {
    /* fall through */
  }
  return (
    process.env.WORKER_VERSION ??
    process.env.npm_package_version ??
    '1.0.0'
  )
}

export type WorkerLaunch = {
  command: string
  args: string[]
  cwd: string
  artifactPath: string
  version: string
  mode: 'agent-native' | 'agent-bundle' | 'worker-bundle' | 'tsx-dev'
}

function runtimeNodeModulesFor(appRoot: string): string {
  return path.join(appRoot, 'dist', 'agent', 'runtime', 'node_modules')
}

function resolveNodePath(
  appRoot: string,
  existing?: string,
): string | undefined {
  const runtimeModules = runtimeNodeModulesFor(appRoot)
  if (!fs.existsSync(runtimeModules)) {
    return existing?.trim() || undefined
  }
  const sep = path.delimiter
  const base = existing?.trim()
  return base ? `${runtimeModules}${sep}${base}` : runtimeModules
}

/** Set NODE_PATH for bundled externals (sharp, playwright-core) before they load. */
export function applyRuntimeModulePath(appRoot?: string): void {
  if (process.env.NODE_PATH) return
  const root = appRoot ? path.resolve(appRoot) : getRepoRoot()
  const nodePath = resolveNodePath(root)
  if (nodePath) process.env.NODE_PATH = nodePath
}

/**
 * Local execution-plane worker: slim worker.cjs first, then unified agent, then native.
 */
export function resolveWorkerLaunch(): WorkerLaunch {
  const root = getRepoRoot()
  const version = readWorkerVersion()

  const workerBundle = getWorkerBundlePath()
  if (fs.existsSync(workerBundle)) {
    return {
      command: process.execPath,
      args: [workerBundle, '--stdio'],
      cwd: root,
      artifactPath: workerBundle,
      version,
      mode: 'worker-bundle',
    }
  }

  const agentBundle = getAgentBundlePath()
  if (fs.existsSync(agentBundle)) {
    return {
      command: process.execPath,
      args: [agentBundle, '--worker-stdio'],
      cwd: root,
      artifactPath: agentBundle,
      version,
      mode: 'agent-bundle',
    }
  }

  const native = getAgentNativePath()
  if (fs.existsSync(native)) {
    return {
      command: native,
      args: ['--worker-stdio'],
      cwd: root,
      artifactPath: native,
      version,
      mode: 'agent-native',
    }
  }

  const entry = path.join(root, 'src', 'worker', 'entry.ts')
  if (!fs.existsSync(entry)) {
    throw new Error(
      `Agent worker not found. Run "npm run build:worker" or "npm run build:agent".`,
    )
  }
  const require = moduleRequire()
  let tsxCli: string
  try {
    tsxCli = require.resolve('tsx/dist/cli.mjs')
  } catch {
    try {
      tsxCli = require.resolve('tsx/cli')
    } catch {
      throw new Error(
        'tsx not found for Worker dev mode. Run: npm run build:worker',
      )
    }
  }
  return {
    command: process.execPath,
    args: [tsxCli, entry, '--stdio'],
    cwd: root,
    artifactPath: entry,
    version,
    mode: 'tsx-dev',
  }
}

/** SSH remote deploy: always prefer the slim worker bundle (~200KB). */
export function resolveRemoteWorkerLaunch(): WorkerLaunch {
  const root = getRepoRoot()
  const version = readWorkerVersion()
  const workerBundle = getWorkerBundlePath()
  if (fs.existsSync(workerBundle)) {
    return {
      command: process.execPath,
      args: [workerBundle, '--stdio'],
      cwd: root,
      artifactPath: workerBundle,
      version,
      mode: 'worker-bundle',
    }
  }

  const agentBundle = getAgentBundlePath()
  if (fs.existsSync(agentBundle)) {
    return {
      command: process.execPath,
      args: [agentBundle, '--worker-stdio'],
      cwd: root,
      artifactPath: agentBundle,
      version,
      mode: 'agent-bundle',
    }
  }

  throw new Error(
    'Remote worker deploy requires a bundled artifact. Run: npm run build:worker',
  )
}

export function workerStdioArgs(launch: WorkerLaunch): string[] {
  return launch.args
}

export function remoteWorkerBundleFileName(launch: WorkerLaunch): string {
  return path.basename(launch.artifactPath)
}

export function buildAgentSpawnEnv(
  base: NodeJS.ProcessEnv,
  appRoot: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...base,
    AGENT_ROOT: appRoot,
  }
  const nodePath = resolveNodePath(appRoot, env.NODE_PATH)
  if (nodePath) {
    env.NODE_PATH = nodePath
  }
  return env
}
