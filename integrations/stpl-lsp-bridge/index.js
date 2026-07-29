#!/usr/bin/env node
/**
 * stpl-lsp-bridge — stdio ↔ STPL Language Server (TCP reverse-connect)
 *
 * Agent sees a normal stdio LSP server (command/args in lspServers).
 * Bridge listens on 127.0.0.1, checks SWC via JMX serverInfo, starts LS via
 * JMX start(port), accepts one reverse connection, then pipes LSP frames.
 *
 * Exit codes:
 *   0 — clean shutdown
 *   1 — config / JMX failure
 *   2 — accept timeout
 *   3 — socket disconnected during pipe
 */

import {
  loadConfig,
  normalizeWorkspacePath,
} from './lib/config.js'
import { resolveSwcTarget } from './lib/discover.js'
import { jmxInvoke, parseServerInfo } from './lib/jmx.js'
import { listenLocal, acceptOne } from './lib/listen.js'
import { pipeStdioToSocket } from './lib/pipe.js'
import { log } from './lib/log.js'

const EXIT_OK = 0
const EXIT_CONFIG = 1
const EXIT_ACCEPT = 2
const EXIT_PIPE = 3

/** @type {{ server?: import('node:net').Server, socket?: import('node:net').Socket, config?: import('./lib/config.js').BridgeConfig, port?: number }} */
const state = {}

async function main() {
  let config
  try {
    config = loadConfig()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log(message, 'error')
    process.exit(EXIT_CONFIG)
  }
  state.config = config

  if (config.startMode === 'jmx') {
    try {
      const target = await resolveSwcTarget(config)
      config.pid = target.pid
      config.workspacePath = target.workspacePath
      log(`SWC target: pid=${target.pid} workspace=${target.workspacePath} (${target.source})`)
    } catch (err) {
      log(
        `SWC discover/resolve failed: ${err instanceof Error ? err.message : String(err)}`,
        'error',
      )
      process.exit(EXIT_CONFIG)
    }
  }

  if (config.workspacePath) {
    log(`workspace: ${config.workspacePath}`)
  }
  log(`start mode: ${config.startMode}`)

  let server
  let port
  try {
    ;({ server, port } = await listenLocal(config.listenPort))
  } catch (err) {
    log(
      `listen failed: ${err instanceof Error ? err.message : String(err)}`,
      'error',
    )
    process.exit(EXIT_CONFIG)
  }
  state.server = server
  state.port = port

  // Register accept BEFORE JMX start — the LS may connect immediately after
  // start(port), and a late 'connection' listener would miss that socket.
  const acceptPromise = acceptOne(server, config.connectTimeoutMs)

  if (config.startMode === 'jmx') {
    try {
      await jmxPreflightAndStart(config, port)
    } catch (err) {
      log(
        `JMX start failed: ${err instanceof Error ? err.message : String(err)}`,
        'error',
      )
      await closeServer(server)
      process.exit(EXIT_CONFIG)
    }
  } else {
    log(
      `wait-for-connect mode (no JMX): waiting for STPL LS to connect to 127.0.0.1:${port}`,
    )
  }

  let socket
  try {
    socket = await acceptPromise
  } catch (err) {
    log(
      `accept failed: ${err instanceof Error ? err.message : String(err)}`,
      'error',
    )
    await closeServer(server)
    process.exit(EXIT_ACCEPT)
  }
  state.socket = socket

  installSignalHandlers()

  const { reason } = await pipeStdioToSocket(socket, { debug: config.debug })
  await shutdown('pipe ended: ' + reason)

  if (reason.startsWith('socket')) {
    process.exit(EXIT_PIPE)
  }
  process.exit(EXIT_OK)
}

/**
 * serverInfo → validate → start(port)
 * @param {import('./lib/config.js').BridgeConfig} config
 * @param {number} port
 */
async function jmxPreflightAndStart(config, port) {
  const pid = /** @type {string} */ (config.pid)
  const helper = config.jmxHelper

  const rawInfo = await jmxInvoke({
    java: config.jmxJava,
    helper,
    pid,
    action: 'serverInfo',
    user: config.jmxUser,
    extensionVersion: config.extensionVersion,
  })

  const info = parseServerInfo(rawInfo)
  if (!info) {
    throw new Error(
      'SWC serverInfo returned empty — MBean not registered, user mismatch, ' +
        'extension version incompatible, or SWC was not restarted with com.advantest.itee.lsp.stpl. ' +
        `Tried user=${config.jmxUser} extensionVersion=${config.extensionVersion} pid=${pid}`,
    )
  }

  log(
    `SWC serverInfo: running=${info.running} version=${info.version} workspace=${info.workspace}`,
  )

  if (info.running) {
    throw new Error(
      'STPL language server is already running in this SWC (one client at a time). ' +
        'Close External IDE / another bridge session first.',
    )
  }

  const expected = normalizeWorkspacePath(
    /** @type {string} */ (config.workspacePath),
  )
  const actual = normalizeWorkspacePath(info.workspace)
  if (expected !== actual) {
    throw new Error(
      `workspace mismatch: agent/cwd is "${expected}" but SWC reports "${actual}". ` +
        'Start the agent with cwd = the same Eclipse workspace path.',
    )
  }

  await jmxInvoke({
    java: config.jmxJava,
    helper,
    pid,
    action: 'start',
    port,
  })
}

function installSignalHandlers() {
  const onSignal = (signal) => {
    log(`received ${signal}`)
    void shutdown(signal).then(() => process.exit(EXIT_OK))
  }
  process.on('SIGINT', () => onSignal('SIGINT'))
  process.on('SIGTERM', () => onSignal('SIGTERM'))
}

let shuttingDown = false

/**
 * @param {string} reason
 */
async function shutdown(reason) {
  if (shuttingDown) return
  shuttingDown = true
  log(`shutting down (${reason})`)

  const { socket, server } = state
  try {
    if (socket && !socket.destroyed) socket.destroy()
  } catch {
    // ignore
  }
  await closeServer(server)
  // No JMX stop — SWC MBean has no stop(); LSP exit handles LS lifecycle.
}

/**
 * @param {import('node:net').Server | undefined} server
 */
function closeServer(server) {
  return new Promise((resolve) => {
    if (!server) {
      resolve()
      return
    }
    try {
      server.close(() => resolve())
    } catch {
      resolve()
    }
  })
}

main().catch((err) => {
  log(
    `fatal: ${err instanceof Error ? err.stack || err.message : String(err)}`,
    'error',
  )
  process.exit(EXIT_CONFIG)
})
