/**
 * Loopback WebSocket server the MV3 extension connects back to.
 *
 * Why the extension dials us rather than the other way round: an MV3 service
 * worker can open a WebSocket but cannot listen on one, and this direction also
 * means no inbound port has to survive the extension being asleep.
 *
 * Why a token: a loopback WebSocket is reachable from any page the user has
 * open, not just from our extension. Without the shared secret, any website
 * could drive the user's signed-in browser. The token is generated once and
 * kept 0600 in the agent's home directory.
 */

import { randomBytes } from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import { WebSocketServer, type WebSocket } from 'ws'
import { getUserAppDir } from '../../utils/app-dir.js'
import { BrowserError } from '../types.js'
import {
  DEFAULT_RELAY_PORT,
  isRelayCdpEvent,
  isRelayHello,
  isRelayResponse,
  isRelayUserControl,
  RELAY_PROTOCOL_VERSION,
  type RelayCdpEvent,
  type RelayRequestBody,
} from './protocol.js'
import { getUserHasControl, setUserHasControl } from '../session-flags.js'

const REQUEST_TIMEOUT_MS = 30_000

export interface RelayServer {
  readonly port: number
  readonly token: string
  isConnected(): boolean
  /** Describes the connected browser, for error messages. */
  peerName(): string | undefined
  waitForExtension(timeoutMs: number): Promise<void>
  request<T>(req: RelayRequestBody): Promise<T>
  /** Subscribe to CDP events the extension forwards. Returns an unsubscribe. */
  onCdpEvent(handler: (event: RelayCdpEvent) => void): () => void
  /** Tell the extension whether the user currently has control. */
  notifyLock(userHasControl: boolean): void
  close(): Promise<void>
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
}

function relayConfigPath(): string {
  return path.join(getUserAppDir(), 'browser', 'relay.json')
}

/**
 * The agent is configured to drive the user's browser and cannot reach it. Both
 * ways out belong in the message: nothing about the running process tells the
 * model whether the user wants to fix the pairing or fall back.
 */
function notConnectedMessage(port: number): string {
  return (
    `No browser extension is connected on 127.0.0.1:${port}. ` +
    'Open Chrome with the agent extension installed and paired (see chrome-extension/README.md), ' +
    'or set browser.mode to "isolated" in .ai-agent/settings.json to use a separate browser instead.'
  )
}

/**
 * Read the pairing token, creating it on first use. Stable across restarts so
 * the user only ever pastes it into the extension once.
 */
export function getPairingToken(): string {
  const file = relayConfigPath()
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      token?: string
    }
    if (typeof parsed.token === 'string' && parsed.token.length >= 16) {
      return parsed.token
    }
  } catch {
    // Missing or corrupt — fall through and mint a new one.
  }

  const token = randomBytes(24).toString('base64url')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ token }, null, 2), { mode: 0o600 })
  return token
}

export async function startRelayServer(
  opts: { port?: number } = {},
): Promise<RelayServer> {
  const requestedPort = opts.port ?? DEFAULT_RELAY_PORT
  const token = getPairingToken()

  let wss: WebSocketServer
  try {
    wss = await new Promise<WebSocketServer>((resolve, reject) => {
      const server = new WebSocketServer({
        host: '127.0.0.1',
        port: requestedPort,
      })
      server.once('listening', () => resolve(server))
      server.once('error', reject)
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new BrowserError(
      `Could not start the browser relay on 127.0.0.1:${requestedPort}: ${message}. ` +
        'Another agent instance may already be running; set browser.relayPort to use a different port.',
    )
  }

  // Report where we actually bound, not what was asked for: with port 0 the OS
  // picks, and every error message quotes this back to the user.
  const address = wss.address()
  const port =
    typeof address === 'object' && address !== null
      ? address.port
      : requestedPort

  let peer: WebSocket | undefined
  let peerName: string | undefined
  let nextId = 1
  const pending = new Map<number, Pending>()
  const waiters: Array<() => void> = []
  const eventHandlers = new Set<(event: RelayCdpEvent) => void>()

  function failAllPending(reason: string): void {
    for (const [, p] of pending) {
      clearTimeout(p.timer)
      p.reject(new BrowserError(reason))
    }
    pending.clear()
  }

  wss.on('connection', socket => {
    let authed = false

    socket.on('message', raw => {
      let msg: unknown
      try {
        msg = JSON.parse(String(raw))
      } catch {
        socket.close(1003, 'malformed json')
        return
      }

      if (!authed) {
        if (!isRelayHello(msg) || msg.token !== token) {
          // Deliberately vague: an unauthorized caller learns nothing about
          // whether the token was wrong or the handshake was malformed.
          socket.close(1008, 'unauthorized')
          return
        }
        authed = true
        peer?.close(1000, 'replaced by a newer connection')
        peer = socket
        peerName = msg.browser
        socket.send(
          JSON.stringify({ type: 'welcome', version: RELAY_PROTOCOL_VERSION }),
        )
        socket.send(
          JSON.stringify({
            type: 'lockState',
            userHasControl: getUserHasControl(),
          }),
        )
        while (waiters.length) waiters.shift()!()
        return
      }

      if (isRelayCdpEvent(msg)) {
        for (const handler of eventHandlers) handler(msg)
        return
      }
      if (isRelayUserControl(msg)) {
        setUserHasControl(msg.hasControl)
        return
      }
      if (!isRelayResponse(msg)) return
      const entry = pending.get(msg.id)
      if (!entry) return
      pending.delete(msg.id)
      clearTimeout(entry.timer)
      if (msg.ok) entry.resolve(msg.result)
      else entry.reject(new BrowserError(msg.error))
    })

    socket.on('close', () => {
      if (peer !== socket) return
      peer = undefined
      peerName = undefined
      failAllPending(
        'The browser extension disconnected. Reopen Chrome or re-enable the extension, then try again.',
      )
    })

    socket.on('error', () => {
      // 'close' always follows; nothing to do beyond not crashing.
    })
  })

  function isConnected(): boolean {
    return peer !== undefined && peer.readyState === peer.OPEN
  }

  return {
    port,
    token,
    isConnected,

    peerName() {
      return peerName
    },

    waitForExtension(timeoutMs: number) {
      if (isConnected()) return Promise.resolve()
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          const idx = waiters.indexOf(onReady)
          if (idx >= 0) waiters.splice(idx, 1)
          reject(new BrowserError(notConnectedMessage(port)))
        }, timeoutMs)
        const onReady = () => {
          clearTimeout(timer)
          resolve()
        }
        waiters.push(onReady)
      })
    },

    request<T>(req: RelayRequestBody): Promise<T> {
      const socket = peer
      if (!socket || socket.readyState !== socket.OPEN) {
        return Promise.reject(new BrowserError(notConnectedMessage(port)))
      }
      const id = nextId++
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(
            new BrowserError(
              `The browser extension did not answer "${req.method}" within ${REQUEST_TIMEOUT_MS / 1000}s.`,
            ),
          )
        }, REQUEST_TIMEOUT_MS)
        pending.set(id, {
          resolve: resolve as (v: unknown) => void,
          reject,
          timer,
        })
        socket.send(JSON.stringify({ ...req, id }))
      })
    },

    onCdpEvent(handler) {
      eventHandlers.add(handler)
      return () => {
        eventHandlers.delete(handler)
      }
    },

    notifyLock(userHasControl: boolean) {
      if (peer && peer.readyState === peer.OPEN) {
        peer.send(JSON.stringify({ type: 'lockState', userHasControl }))
      }
    },

    async close() {
      failAllPending('The browser relay was shut down.')
      // An upgraded socket still counts as an open connection to the underlying
      // http server, so a polite close() would block shutdown until the
      // extension happens to hang up. Drop them.
      for (const client of wss.clients) client.terminate()
      peer = undefined
      await new Promise<void>(resolve => wss.close(() => resolve()))
    },
  }
}
