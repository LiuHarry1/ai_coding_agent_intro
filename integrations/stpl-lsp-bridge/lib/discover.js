import { writeFileSync } from 'node:fs'
import { log } from './log.js'
import { jmxDiscover, jmxInvoke, parseServerInfo } from './jmx.js'
import { normalizeWorkspacePath } from './config.js'

/**
 * @typedef {object} DiscoveredSwc
 * @property {string} pid
 * @property {string} displayName
 * @property {boolean} running
 * @property {string} version
 * @property {string} workspace
 */

/**
 * Resolve SWC pid + workspace for JMX mode.
 * Priority:
 *   1. Explicit STPLLS_PID (config.pid) — validate via serverInfo when possible
 *   2. Auto-discover JVMs exposing the STPL MBean
 * Prefer candidates whose workspace matches preferredWorkspace / cwd.
 *
 * @param {import('./config.js').BridgeConfig} config
 * @returns {Promise<{ pid: string, workspacePath: string, source: string }>}
 */
export async function resolveSwcTarget(config) {
  const preferred = config.workspacePath
    ? normalizeWorkspacePath(config.workspacePath)
    : undefined

  if (config.pid) {
    try {
      const raw = await jmxInvoke({
        java: config.jmxJava,
        helper: config.jmxHelper,
        pid: config.pid,
        action: 'serverInfo',
        user: config.jmxUser,
        extensionVersion: config.extensionVersion,
      })
      const info = parseServerInfo(raw)
      if (info) {
        const workspacePath = pickWorkspace(preferred, info.workspace, config.workspaceExplicit)
        persistStatus(config, config.pid, workspacePath)
        return { pid: config.pid, workspacePath, source: 'configured-pid' }
      }
      log(
        `configured pid ${config.pid} has no usable serverInfo — falling back to discover`,
        'warn',
      )
    } catch (err) {
      log(
        `configured pid ${config.pid} unreachable (${err instanceof Error ? err.message : String(err)}) — falling back to discover`,
        'warn',
      )
    }
  }

  if (!config.autoDiscover) {
    throw new Error(
      'STPLLS_PID is missing/unreachable and STPL_AUTO_DISCOVER=false',
    )
  }

  const found = await jmxDiscover({
    java: config.jmxJava,
    helper: config.jmxHelper,
    user: config.jmxUser,
    extensionVersion: config.extensionVersion,
  })
  if (found.length === 0) {
    throw new Error(
      'No SWC JVM found with MBean com.advantest.stpl:type=basic,name=console. ' +
        'Start the host IDE (fully past Choose Workspace) from a build that includes lsp.stpl.',
    )
  }

  const chosen = pickCandidate(found, preferred)
  const workspacePath = pickWorkspace(
    preferred,
    chosen.workspace,
    config.workspaceExplicit,
  )
  log(
    `auto-discovered SWC pid=${chosen.pid} workspace=${workspacePath} ` +
      `(${found.length} candidate(s); source=${chosen._pickReason})`,
  )
  persistStatus(config, chosen.pid, workspacePath)
  return { pid: chosen.pid, workspacePath, source: 'auto-discover' }
}

/**
 * @param {DiscoveredSwc[]} found
 * @param {string | undefined} preferred
 */
function pickCandidate(found, preferred) {
  if (preferred) {
    const matches = found.filter(
      (c) => normalizeWorkspacePath(c.workspace) === preferred,
    )
    if (matches.length === 1) {
      return { ...matches[0], _pickReason: 'workspace-match' }
    }
    if (matches.length > 1) {
      const idle = matches.find((c) => !c.running)
      if (idle) return { ...idle, _pickReason: 'workspace-match-idle' }
      throw new Error(
        `Multiple SWC JVMs share workspace ${preferred}: ` +
          matches.map((c) => c.pid).join(', ') +
          '. Set STPLLS_PID explicitly.',
      )
    }
  }

  if (found.length === 1) {
    return { ...found[0], _pickReason: 'only-candidate' }
  }

  const idle = found.filter((c) => !c.running)
  if (idle.length === 1) {
    return { ...idle[0], _pickReason: 'only-idle' }
  }

  // Prefer PDE / SWC product command lines
  const ranked = [...found].sort((a, b) => scoreDisplay(b) - scoreDisplay(a))
  if (scoreDisplay(ranked[0]) > scoreDisplay(ranked[1])) {
    return { ...ranked[0], _pickReason: 'best-displayName' }
  }

  throw new Error(
    'Multiple SWC JVMs found; cannot choose automatically:\n' +
      found
        .map(
          (c) =>
            `  pid=${c.pid} running=${c.running} workspace=${c.workspace}`,
        )
        .join('\n') +
      '\nSet STPLLS_PID or open the agent on the SWC workspace path.',
  )
}

/** @param {DiscoveredSwc} c */
function scoreDisplay(c) {
  const d = (c.displayName || '').toLowerCase()
  let s = 0
  if (d.includes('ewcproduct') || d.includes('swc.ide')) s += 3
  if (d.includes('pde.launch') || d.includes('runtime-ewc')) s += 2
  if (!c.running) s += 1
  return s
}

/**
 * @param {string | undefined} preferred
 * @param {string} swcWorkspace
 * @param {boolean} workspaceExplicit
 */
function pickWorkspace(preferred, swcWorkspace, workspaceExplicit) {
  const actual = normalizeWorkspacePath(swcWorkspace)
  if (!preferred) return actual
  const expected = normalizeWorkspacePath(preferred)
  if (expected === actual) return actual
  if (workspaceExplicit) {
    throw new Error(
      `workspace mismatch: JDTLS_WORKSPACE_PATH/agent is "${expected}" but SWC reports "${actual}"`,
    )
  }
  log(
    `adopting SWC workspace "${actual}" (agent cwd was "${expected}")`,
    'warn',
  )
  return actual
}

/**
 * @param {import('./config.js').BridgeConfig} config
 * @param {string} pid
 * @param {string} workspacePath
 */
function persistStatus(config, pid, workspacePath) {
  if (!config.statusFile) return
  try {
    const path = config.statusFile
    writeFileSync(
      path,
      JSON.stringify({ pid: Number(pid) || pid, workspace: workspacePath }, null, 2) +
        '\n',
      'utf8',
    )
    log(`updated status file ${path}`)
  } catch (err) {
    log(
      `failed to write STPL_STATUS_FILE: ${err instanceof Error ? err.message : String(err)}`,
      'warn',
    )
  }
}
