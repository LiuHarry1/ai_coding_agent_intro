/**
 * Desktop agent spawn helpers (mirrors src/execution/worker-paths.ts for Electron).
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

export function agentNativePath(appRoot, slug) {
  const ext = process.platform === 'win32' ? '.exe' : ''
  return path.join(appRoot, 'dist', 'agent', `${slug}-agent${ext}`)
}

export function agentBundlePath(appRoot, slug) {
  return path.join(appRoot, 'dist', 'agent', `${slug}-agent.cjs`)
}

export function runtimeNodeModulesPath(appRoot) {
  return path.join(appRoot, 'dist', 'agent', 'runtime', 'node_modules')
}

/**
 * Packaged: resources/workspace-seed next to the app.
 * Dev: repo deploy/desktop/workspace-seed.
 */
export function resolveWorkspaceSeedDir(
  appRoot,
  { packaged = false, resourcesPath } = {},
) {
  if (packaged && resourcesPath) {
    const packed = path.join(resourcesPath, 'workspace-seed')
    if (fs.existsSync(packed)) return packed
  }
  const dev = path.join(appRoot, 'deploy', 'desktop', 'workspace-seed')
  if (fs.existsSync(dev)) return dev
  return null
}

export function buildAgentSpawnEnv(
  appRoot,
  port,
  baseEnv = process.env,
  { packaged = false, resourcesPath } = {},
) {
  const env = {
    ...baseEnv,
    PORT: String(port),
    AGENT_ROOT: appRoot,
  }
  const seedDir = resolveWorkspaceSeedDir(appRoot, { packaged, resourcesPath })
  if (seedDir && env.WORKSPACE_SEED_DIR == null) {
    env.WORKSPACE_SEED_DIR = seedDir
  }
  const runtimeModules = runtimeNodeModulesPath(appRoot)
  if (!fs.existsSync(runtimeModules)) {
    return env
  }
  const sep = path.delimiter
  const existing = env.NODE_PATH?.trim()
  env.NODE_PATH = existing
    ? `${runtimeModules}${sep}${existing}`
    : runtimeModules
  return env
}

export function resolveTsxCli(appRoot) {
  return path.join(appRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs')
}

/** HTTP/ACP agent: packaged → native → CJS bundle; dev → tsx (same as npm start). */
export function resolveAgentLaunch(appRoot, slug, { packaged = false } = {}) {
  if (!packaged) {
    const tsxCli = resolveTsxCli(appRoot)
    const startScript = path.join(appRoot, 'start.js')
    if (fs.existsSync(tsxCli) && fs.existsSync(startScript)) {
      return { kind: 'tsx', tsxCli, startScript }
    }
  }

  const native = agentNativePath(appRoot, slug)
  if (fs.existsSync(native)) {
    return { kind: 'native', entry: native }
  }

  const bundled = agentBundlePath(appRoot, slug)
  if (packaged || fs.existsSync(bundled)) {
    if (!fs.existsSync(bundled)) {
      return {
        kind: 'error',
        message:
          `Missing bundled agent:\n${bundled}\n\n` +
          'Rebuild with: npm run build:desktop && npm run desktop:pack:win',
      }
    }
    return { kind: 'bundle', entry: bundled }
  }

  const tsxCli = resolveTsxCli(appRoot)
  const startScript = path.join(appRoot, 'start.js')
  if (!fs.existsSync(tsxCli)) {
    return {
      kind: 'error',
      message:
        `Missing dev runtime:\n${tsxCli}\n\n` +
        'Run `npm install`, or build the bundled agent with `npm run build:agent`.',
    }
  }
  return { kind: 'tsx', tsxCli, startScript }
}
