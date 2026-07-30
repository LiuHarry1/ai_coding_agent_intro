/**
 * Resolve path to the bundled Agent Worker entry.
 */
import * as fs from 'fs'
import * as path from 'path'
import { createRequire } from 'module'
import { fileURLToPath } from 'url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

/** Repo root: src/execution → ../.. */
export function getRepoRoot(): string {
  return path.resolve(HERE, '../..')
}

export function getWorkerBundlePath(): string {
  const cjs = path.join(getRepoRoot(), 'dist', 'worker', 'baix-worker.cjs')
  if (fs.existsSync(cjs)) return cjs
  return path.join(getRepoRoot(), 'dist', 'worker', 'baix-worker.js')
}

export function getWorkerVersionPath(): string {
  return path.join(getRepoRoot(), 'dist', 'worker', 'version.json')
}

export function readWorkerVersion(): string {
  try {
    const raw = fs.readFileSync(getWorkerVersionPath(), 'utf8')
    const j = JSON.parse(raw) as { version?: string }
    if (j.version) return j.version
  } catch {
    /* fall through */
  }
  return (
    process.env.BAIX_WORKER_VERSION ??
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
  mode: 'bundle' | 'tsx-dev'
}

/**
 * Prefer dist/worker/baix-worker.js; fall back to tsx for local dev.
 */
export function resolveWorkerLaunch(): WorkerLaunch {
  const root = getRepoRoot()
  const bundle = getWorkerBundlePath()
  const version = readWorkerVersion()
  if (fs.existsSync(bundle)) {
    return {
      command: process.execPath,
      args: [bundle, '--stdio'],
      cwd: root,
      artifactPath: bundle,
      version,
      mode: 'bundle',
    }
  }
  const entry = path.join(root, 'src', 'worker', 'main.ts')
  if (!fs.existsSync(entry)) {
    throw new Error(
      `Agent Worker not found. Run "npm run build:worker" (expected ${bundle}).`,
    )
  }
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
