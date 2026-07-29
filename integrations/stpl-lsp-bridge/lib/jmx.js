import { spawn } from 'node:child_process'
import { basename, extname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { existsSync } from 'node:fs'
import { log } from './log.js'

const BRIDGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
/** Agent package root (`ai_coding_agent_intro/`) — parent of `integrations/` */
const AGENT_ROOT = resolve(BRIDGE_ROOT, '../..')
export const DEFAULT_JMX_HELPER = join(
  BRIDGE_ROOT,
  'jmx-helper',
  'StplJmxHelper.java',
)

/**
 * Resolve helper path: absolute as-is; else try bridge root, agent package root, cwd.
 * @param {string} helper
 * @returns {string}
 */
export function resolveHelperPath(helper) {
  if (isAbsolute(helper)) return helper
  const candidates = [
    resolve(BRIDGE_ROOT, helper),
    resolve(AGENT_ROOT, helper),
    resolve(process.cwd(), helper),
    // allow "jmx-helper/StplJmxHelper.java" from settings
    resolve(BRIDGE_ROOT, helper.replace(/^integrations\/stpl-lsp-bridge\//, '')),
  ]
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  // Prefer agent-root relative path for error messages matching settings
  return resolve(AGENT_ROOT, helper)
}

/**
 * Invoke bundled / external STPL JMX helper.
 *
 * CLI contract:
 *   java <helper.java> <pid> start <port>
 *   java <helper.java> <pid> serverInfo [user] [extensionVersion]
 *   java <helper.java> discover [user] [extensionVersion]
 *   <helper> <pid> start <port>   (non-.java wrapper)
 *
 * MBean has no stop — action "stop" is rejected by the bundled helper.
 *
 * @param {object} opts
 * @param {string} opts.java
 * @param {string} opts.helper
 * @param {string} [opts.pid]
 * @param {'start' | 'serverInfo' | 'stop' | 'discover'} opts.action
 * @param {number} [opts.port]
 * @param {string} [opts.user]
 * @param {string} [opts.extensionVersion]
 * @returns {Promise<string>} stdout (trimmed); empty string if none
 */
export function jmxInvoke({
  java,
  helper,
  pid,
  action,
  port,
  user,
  extensionVersion,
}) {
  const resolved = resolveHelperPath(helper)
  const { command, args } = buildCommand({
    java,
    helper: resolved,
    pid,
    action,
    port,
    user,
    extensionVersion,
  })
  log(`jmx ${action}: ${command} ${args.join(' ')}`)

  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: process.platform === 'win32',
    })

    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr?.on('data', (chunk) => {
      const text = String(chunk)
      stderr += text
      const trimmed = text.trim()
      if (trimmed) log(`jmx stderr: ${trimmed}`, 'warn')
    })
    child.on('error', (err) => {
      reject(
        new Error(
          `failed to spawn JMX helper (${command}): ${err.message}`,
        ),
      )
    })
    child.on('exit', (code) => {
      const out = stdout.trim()
      if (out && action !== 'serverInfo' && action !== 'discover') {
        log(`jmx stdout: ${out}`)
      }
      if (code === 0) {
        log(`jmx ${action} succeeded`)
        resolvePromise(out)
        return
      }
      reject(
        new Error(
          `JMX helper exited with code ${code}${stderr ? `: ${stderr.trim()}` : ''}`,
        ),
      )
    })
  })
}

/**
 * Discover SWC JVMs that expose the STPL JMX console.
 *
 * @param {object} opts
 * @param {string} opts.java
 * @param {string} opts.helper
 * @param {string} [opts.user]
 * @param {string} [opts.extensionVersion]
 * @returns {Promise<Array<{ pid: string, displayName: string, running: boolean, version: string, workspace: string }>>}
 */
export async function jmxDiscover(opts) {
  const raw = await jmxInvoke({
    ...opts,
    action: 'discover',
  })
  let parsed
  try {
    parsed = JSON.parse(raw || '[]')
  } catch (err) {
    throw new Error(
      `discover returned invalid JSON: ${err instanceof Error ? err.message : String(err)} (${raw})`,
    )
  }
  if (!Array.isArray(parsed)) {
    throw new Error('discover must return a JSON array')
  }
  /** @type {Array<{ pid: string, displayName: string, running: boolean, version: string, workspace: string }>} */
  const out = []
  for (const row of parsed) {
    if (!row || row.pid == null) continue
    const info = parseServerInfo(String(row.info || ''))
    if (!info) continue
    out.push({
      pid: String(row.pid),
      displayName: String(row.displayName || ''),
      running: info.running,
      version: info.version,
      workspace: info.workspace,
    })
  }
  return out
}

/**
 * @param {object} opts
 * @param {string} opts.java
 * @param {string} opts.helper
 * @param {string} [opts.pid]
 * @param {'start' | 'serverInfo' | 'stop' | 'discover'} opts.action
 * @param {number} [opts.port]
 * @param {string} [opts.user]
 * @param {string} [opts.extensionVersion]
 */
function buildCommand({
  java,
  helper,
  pid,
  action,
  port,
  user,
  extensionVersion,
}) {
  /** @type {string[]} */
  let cliArgs
  if (action === 'discover') {
    cliArgs = ['discover']
    if (user) cliArgs.push(user)
    if (extensionVersion) cliArgs.push(extensionVersion)
  } else if (action === 'start') {
    if (pid == null) throw new Error('jmx start requires pid')
    if (port == null) throw new Error('jmx start requires port')
    cliArgs = [pid, action, String(port)]
  } else if (action === 'serverInfo') {
    if (pid == null) throw new Error('jmx serverInfo requires pid')
    cliArgs = [pid, action]
    if (user) cliArgs.push(user)
    if (extensionVersion) cliArgs.push(extensionVersion)
  } else if (action === 'stop') {
    if (pid == null) throw new Error('jmx stop requires pid')
    cliArgs = [pid, action]
  } else {
    throw new Error(`unknown jmx action: ${action}`)
  }

  const ext = extname(helper).toLowerCase()
  if (ext === '.java' || basename(helper).endsWith('.java')) {
    return {
      command: java,
      args: [helper, ...cliArgs],
    }
  }
  return {
    command: helper,
    args: cliArgs,
  }
}

/**
 * Parse MBean serverInfo payload: running:swcVersion:workspacePath
 * Workspace path may contain colons on Windows — split into 3 parts max from left.
 *
 * @param {string} raw
 * @returns {{ running: boolean, version: string, workspace: string } | null}
 */
export function parseServerInfo(raw) {
  if (!raw || !raw.trim()) return null
  const text = raw.trim()
  const first = text.indexOf(':')
  if (first < 0) return null
  const second = text.indexOf(':', first + 1)
  if (second < 0) return null
  const runningStr = text.slice(0, first)
  const version = text.slice(first + 1, second)
  const workspace = text.slice(second + 1)
  return {
    running: runningStr === 'true',
    version,
    workspace,
  }
}
