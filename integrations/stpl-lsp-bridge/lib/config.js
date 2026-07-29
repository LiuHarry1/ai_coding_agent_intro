import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { log } from './log.js'
import { DEFAULT_JMX_HELPER, resolveHelperPath } from './jmx.js'

/**
 * @typedef {'jmx' | 'wait-for-connect'} StartMode
 *
 * @typedef {object} BridgeConfig
 * @property {StartMode} startMode
 * @property {string | undefined} pid
 * @property {string | undefined} workspacePath
 * @property {boolean} workspaceExplicit  true if JDTLS_WORKSPACE_PATH / status workspace was set
 * @property {boolean} autoDiscover
 * @property {number} listenPort
 * @property {number} connectTimeoutMs
 * @property {string} jmxHelper
 * @property {string} jmxJava
 * @property {string} jmxUser
 * @property {string} extensionVersion
 * @property {boolean} debug
 * @property {string | undefined} statusFile
 */

/** Matches LanguageServerJMXConsole.DEFAULT_EXTENSION_VERSION */
export const DEFAULT_EXTENSION_VERSION = '0.1.0'

/**
 * Normalize start-mode aliases.
 * - jmx: listen, serverInfo check, JMX start(port), then accept (SWC-embedded path)
 * - wait-for-connect: listen and accept only (external process must start LS)
 *   aliases: already-running, no-jmx
 *   Not the same as standalone stplls_start.sh — that is out of scope.
 *
 * @param {string} raw
 * @returns {StartMode}
 */
function normalizeStartMode(raw) {
  const v = raw.toLowerCase()
  if (v === 'jmx') return 'jmx'
  if (
    v === 'wait-for-connect' ||
    v === 'already-running' ||
    v === 'no-jmx'
  ) {
    return 'wait-for-connect'
  }
  throw new ConfigError(
    `STPL_START_MODE must be "jmx" or "wait-for-connect" (aliases: already-running, no-jmx), got "${raw}"`,
  )
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {BridgeConfig}
 */
export function loadConfig(env = process.env) {
  /** @type {Record<string, string | undefined>} */
  const merged = { ...env }

  const statusFileRaw = emptyToUndefined(merged.STPL_STATUS_FILE)
  const statusFile = statusFileRaw
    ? resolveStatusFilePath(statusFileRaw)
    : undefined
  if (statusFile) {
    applyStatusFile(statusFile, merged)
  }

  const startMode = normalizeStartMode(merged.STPL_START_MODE || 'jmx')

  const pid = emptyToUndefined(merged.STPLLS_PID)
  // Explicit = set in process env (not only via status file). Status-file workspace
  // is a hint; SWC serverInfo wins when auto-discovering unless env overrides.
  const workspaceFromEnv = emptyToUndefined(env.JDTLS_WORKSPACE_PATH)
  const workspacePath =
    workspaceFromEnv ||
    emptyToUndefined(merged.JDTLS_WORKSPACE_PATH) ||
    process.cwd()
  const workspaceExplicitFlag = Boolean(workspaceFromEnv)

  const jmxHelperRaw =
    emptyToUndefined(merged.STPL_JMX_HELPER) || DEFAULT_JMX_HELPER
  const jmxHelper = resolveHelperPath(jmxHelperRaw)
  const jmxJava = emptyToUndefined(merged.STPL_JMX_JAVA) || 'java'
  const jmxUser =
    emptyToUndefined(merged.STPL_JMX_USER) ||
    emptyToUndefined(merged.USER) ||
    emptyToUndefined(merged.USERNAME) ||
    'unknown'
  const extensionVersion =
    emptyToUndefined(merged.STPL_EXTENSION_VERSION) ||
    DEFAULT_EXTENSION_VERSION

  // Default ON — discover SWC pid/workspace when not configured or stale
  const autoDiscover =
    merged.STPL_AUTO_DISCOVER == null || merged.STPL_AUTO_DISCOVER === ''
      ? true
      : truthy(merged.STPL_AUTO_DISCOVER)

  if (merged.STPL_CALL_JMX_STOP_ON_EXIT && truthy(merged.STPL_CALL_JMX_STOP_ON_EXIT)) {
    log(
      'STPL_CALL_JMX_STOP_ON_EXIT is ignored: SWC MBean has no stop(); bridge relies on LSP exit',
      'warn',
    )
  }

  const listenPort = parseIntOr(merged.STPL_LSP_PORT, 0)
  if (listenPort < 0 || listenPort > 65535) {
    throw new ConfigError(`STPL_LSP_PORT out of range: ${listenPort}`)
  }

  const connectTimeoutMs = parseIntOr(merged.STPL_CONNECT_TIMEOUT_MS, 60_000)
  if (connectTimeoutMs <= 0) {
    throw new ConfigError(
      `STPL_CONNECT_TIMEOUT_MS must be positive, got ${connectTimeoutMs}`,
    )
  }

  if (startMode === 'jmx' && !pid && !autoDiscover) {
    throw new ConfigError(
      'STPLLS_PID is required when STPL_AUTO_DISCOVER=false (or set STPL_STATUS_FILE with pid)',
    )
  }
  if (startMode === 'jmx' && !existsSync(jmxHelper)) {
    throw new ConfigError(
      `STPL_JMX_HELPER not found: ${jmxHelper} (bundled default is jmx-helper/StplJmxHelper.java)`,
    )
  }
  if (startMode === 'wait-for-connect' && listenPort === 0) {
    throw new ConfigError(
      'STPL_LSP_PORT must be set when STPL_START_MODE=wait-for-connect (external starter must use the same port)',
    )
  }

  return {
    startMode,
    pid,
    workspacePath,
    workspaceExplicit: workspaceExplicitFlag,
    autoDiscover,
    listenPort,
    connectTimeoutMs,
    jmxHelper,
    jmxJava,
    jmxUser,
    extensionVersion,
    debug: truthy(merged.STPL_BRIDGE_DEBUG),
    statusFile,
  }
}

/**
 * Resolve STPL_STATUS_FILE:
 * - absolute path as-is
 * - `~/...` → home directory
 * - otherwise relative to process.cwd() (agent project workspace)
 * @param {string} statusFile
 */
function resolveStatusFilePath(statusFile) {
  if (statusFile.startsWith('~/') || statusFile === '~') {
    return resolve(
      process.env.HOME || process.env.USERPROFILE || '',
      statusFile.slice(2),
    )
  }
  return resolve(statusFile)
}

/**
 * @param {string} statusFile
 * @param {Record<string, string | undefined>} merged
 */
function applyStatusFile(statusFile, merged) {
  const path = statusFile
  if (!existsSync(path)) {
    log(`STPL_STATUS_FILE not found yet (${path}) — will auto-discover if enabled`)
    return
  }
  let parsed
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    throw new ConfigError(
      `Failed to parse STPL_STATUS_FILE ${path}: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new ConfigError(`STPL_STATUS_FILE must contain a JSON object: ${path}`)
  }
  if (parsed.pid != null && !merged.STPLLS_PID) {
    merged.STPLLS_PID = String(parsed.pid)
  }
  if (parsed.workspace != null && !merged.JDTLS_WORKSPACE_PATH) {
    merged.JDTLS_WORKSPACE_PATH = String(parsed.workspace)
  }
  if (parsed.port != null && !merged.STPL_LSP_PORT) {
    merged.STPL_LSP_PORT = String(parsed.port)
  }
  log(`loaded status file ${path}`)
}

/**
 * Normalize paths for comparison (resolve + strip trailing separators).
 * @param {string} p
 */
export function normalizeWorkspacePath(p) {
  let n = resolve(p)
  while (n.length > 1 && (n.endsWith('/') || n.endsWith('\\'))) {
    n = n.slice(0, -1)
  }
  return n
}

/**
 * @param {string | undefined} value
 * @param {number} fallback
 */
function parseIntOr(value, fallback) {
  if (value == null || value === '') return fallback
  const n = Number.parseInt(value, 10)
  if (Number.isNaN(n)) {
    throw new ConfigError(`expected integer, got "${value}"`)
  }
  return n
}

/** @param {string | undefined} value */
function emptyToUndefined(value) {
  if (value == null) return undefined
  const trimmed = value.trim()
  if (!trimmed || trimmed.startsWith('${') || trimmed.startsWith('REPLACE_')) {
    return undefined
  }
  return trimmed
}

/** @param {string | undefined} value */
function truthy(value) {
  if (!value) return false
  const v = value.trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'yes'
}

export class ConfigError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message)
    this.name = 'ConfigError'
  }
}
