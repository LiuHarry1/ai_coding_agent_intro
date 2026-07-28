#!/usr/bin/env node
/**
 * stpl-lsp-bridge — stdio ↔ SmarTest STPL Language Server (TCP reverse-connect)
 *
 * Agent sees a normal stdio LSP server (command/args in lspServers).
 * Bridge listens on 127.0.0.1, optionally starts LS via JMX, accepts one
 * reverse connection from SmarTest, then pipes LSP frames transparently.
 *
 * Exit codes:
 *   0 — clean shutdown
 *   1 — config / JMX failure
 *   2 — accept timeout
 *   3 — socket disconnected during pipe
 */

import { loadConfig, ConfigError } from './lib/config.js'
import { jmxInvoke } from './lib/jmx.js'
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

  if (config.startMode === 'jmx') {
    try {
      await jmxInvoke({
        java: config.jmxJava,
        helper: /** @type {string} */ (config.jmxHelper),
        pid: /** @type {string} */ (config.pid),
        action: 'start',
        port,
      })
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
      `already-running mode: waiting for STPL LS to connect to 127.0.0.1:${port}`,
    )
  }

  let socket
  try {
    socket = await acceptOne(server, config.connectTimeoutMs)
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

  const { socket, server, config, port } = state
  try {
    if (socket && !socket.destroyed) socket.destroy()
  } catch {
    // ignore
  }
  await closeServer(server)

  if (
    config?.callJmxStopOnExit &&
    config.startMode === 'jmx' &&
    config.jmxHelper &&
    config.pid &&
    port != null
  ) {
    try {
      await jmxInvoke({
        java: config.jmxJava,
        helper: config.jmxHelper,
        pid: config.pid,
        action: 'stop',
        port,
      })
    } catch (err) {
      log(
        `JMX stop failed (ignored): ${err instanceof Error ? err.message : String(err)}`,
        'warn',
      )
    }
  }
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
