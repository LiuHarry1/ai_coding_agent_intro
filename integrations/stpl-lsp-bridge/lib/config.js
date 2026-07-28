import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { log } from './log.js'

/**
 * @typedef {'jmx' | 'already-running'} StartMode
 *
 * @typedef {object} BridgeConfig
 * @property {StartMode} startMode
 * @property {string | undefined} pid
 * @property {string | undefined} workspacePath
 * @property {number} listenPort
 * @property {number} connectTimeoutMs
 * @property {string | undefined} jmxHelper
 * @property {string} jmxJava
 * @property {boolean} callJmxStopOnExit
 * @property {boolean} debug
 * @property {string | undefined} statusFile
 */

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {BridgeConfig}
 */
export function loadConfig(env = process.env) {
  /** @type {Record<string, string | undefined>} */
  const merged = { ...env }

  const statusFile = emptyToUndefined(merged.STPL_STATUS_FILE)
  if (statusFile) {
    applyStatusFile(statusFile, merged)
  }

  const startModeRaw = (merged.STPL_START_MODE || 'jmx').toLowerCase()
  if (startModeRaw !== 'jmx' && startModeRaw !== 'already-running') {
    throw new ConfigError(
      `STPL_START_MODE must be "jmx" or "already-running", got "${startModeRaw}"`,
    )
  }
  /** @type {StartMode} */
  const startMode = startModeRaw

  const pid = emptyToUndefined(merged.STPLLS_PID)
  // Prefer explicit env; otherwise use spawn cwd (agent sets cwd = workspaceFolder).
  const workspacePath =
    emptyToUndefined(merged.JDTLS_WORKSPACE_PATH) || process.cwd()
  const jmxHelper = emptyToUndefined(merged.STPL_JMX_HELPER)
  const jmxJava = emptyToUndefined(merged.STPL_JMX_JAVA) || 'java'

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

  if (startMode === 'jmx' && !pid) {
    throw new ConfigError(
      'STPLLS_PID is required when STPL_START_MODE=jmx (or set STPL_STATUS_FILE with pid)',
    )
  }
  if (startMode === 'jmx' && !jmxHelper) {
    throw new ConfigError(
      'STPL_JMX_HELPER is required when STPL_START_MODE=jmx (path to StpllsJmxOperations.java or wrapper)',
    )
  }
  if (startMode === 'already-running' && listenPort === 0) {
    throw new ConfigError(
      'STPL_LSP_PORT must be set when STPL_START_MODE=already-running (LS must connect to a known port)',
    )
  }

  return {
    startMode,
    pid,
    workspacePath,
    listenPort,
    connectTimeoutMs,
    jmxHelper,
    jmxJava,
    callJmxStopOnExit: truthy(merged.STPL_CALL_JMX_STOP_ON_EXIT),
    debug: truthy(merged.STPL_BRIDGE_DEBUG),
    statusFile,
  }
}

/**
 * @param {string} statusFile
 * @param {Record<string, string | undefined>} merged
 */
function applyStatusFile(statusFile, merged) {
  const path = resolve(statusFile)
  if (!existsSync(path)) {
    throw new ConfigError(`STPL_STATUS_FILE not found: ${path}`)
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
  if (!trimmed || trimmed.startsWith('${')) return undefined
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
