/**
 * Loopback WebSocket server the MV3 extension connects back to.
 *
 * Why the extension dials us rather than the other way round: an MV3 service
 * worker can open a WebSocket but cannot listen on one, and this direction also
 * means no inbound port has to survive the extension being asleep.
 *
 * Authentication is the URL itself. The server binds an OS-assigned port and
 * serves a single path containing a per-process uuid, so knowing where to
 * connect *is* the capability. The host hands that URL to the extension by
 * opening the extension's own connect page (see `open-connect-page.ts`), which
 * is a channel no other local process or web page can read. On top of that the
 * handshake only accepts an `Origin` of our extension — a header the browser
 * writes itself, so a page cannot forge it.
 */

import { createHmac, randomUUID } from 'crypto'
import http from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import { BrowserError } from '../types.js'
import { BRIDGE_EXTENSION_ID, BRIDGE_EXTENSION_ORIGIN } from './extension-id.js'
import {
  isRelayCdpEvent,
  isRelayHello,
  isRelayResponse,
  isRelayUserControl,
  RELAY_PROTOCOL_VERSION,
  type RelayCdpEvent,
  type RelayRequestBody,
} from './protocol.js'
import {
  anyUserHasControl,
  setUserHasControlEverywhere,
} from '../session-flags.js'

const REQUEST_TIMEOUT_MS = 30_000

export const DEFAULT_CLIENT_NAME = 'Baize Agent'

export interface RelayServer {
  readonly port: number
  /** `ws://127.0.0.1:<port>/relay/<uuid>` — the credential the extension needs. */
  readonly wsUrl: string
  /**
   * The extension page that hands `wsUrl` to the service worker. With the
   * extension's auto-connect token it carries a proof instead of asking.
   */
  connectUrl(clientName?: string, pairingToken?: string): string
  isConnected(): boolean
  /** Describes the connected browser, for error messages. */
  peerName(): string | undefined
  /** What the extension told us it can do, once connected. */
  capabilities(): ReadonlySet<string>
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

/**
 * The agent is configured to drive the user's browser and cannot reach it.
 * Both ways out belong in the message: nothing about the running process tells
 * the model whether the user wants to finish the connect prompt or fall back.
 */
function notConnectedMessage(): string {
  return (
    'No browser extension is connected. A tab should have opened asking to connect the agent to ' +
    'this browser — approve it there, or install the extension first (see chrome-extension/README.md). ' +
    'Set browser.mode to "isolated" in .ai-agent/settings.json to use a separate browser instead.'
  )
}

/**
 * What the connect page checks against the extension's auto-connect token.
 * Must match `pairingProof` in chrome-extension/pairing.js. Bound to one relay
 * url, so it cannot be replayed against another agent process.
 */
export function pairingProof(token: string, relayUrl: string): string {
  return createHmac('sha256', token).update(relayUrl).digest('hex')
}

export async function startRelayServer(
  opts: { port?: number } = {},
): Promise<RelayServer> {
  // Port 0 by default: two agent processes must not fight over a well-known
  // port, and nothing needs to guess this one now that the URL is handed over
  // rather than typed in.
  const requestedPort = opts.port ?? 0
  const path = `/relay/${randomUUID()}`

  const httpServer = http.createServer((_req, res) => {
    res.statusCode = 404
    res.end()
  })

  const wss = new WebSocketServer({ noServer: true })

  httpServer.on('upgrade', (req, socket, head) => {
    // Reject before the handshake completes: an unauthorized caller should not
    // get an open socket, and it learns nothing about which check it failed.
    if (req.url !== path || req.headers.origin !== BRIDGE_EXTENSION_ORIGIN) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, ws => {
      wss.emit('connection', ws, req)
    })
  })

  try {
    await new Promise<void>((resolve, reject) => {
      httpServer.once('error', reject)
      httpServer.listen(requestedPort, '127.0.0.1', () => resolve())
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new BrowserError(
      `Could not start the browser relay on 127.0.0.1:${requestedPort}: ${message}.` +
        (requestedPort === 0
          ? ''
          : ' Unset browser.relayPort to let the OS pick a free port.'),
    )
  }

  // Report where we actually bound, not what was asked for: with port 0 the OS
  // picks, and the connect URL quotes this back to the extension.
  const address = httpServer.address()
  const port =
    typeof address === 'object' && address !== null
      ? address.port
      : requestedPort
  const wsUrl = `ws://127.0.0.1:${port}${path}`

  let peer: WebSocket | undefined
  let peerName: string | undefined
  let peerCapabilities: ReadonlySet<string> = new Set()
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
        // The URL already proved who this is; `hello` only carries the
        // extension's self-description.
        if (!isRelayHello(msg)) {
          socket.close(1008, 'expected hello')
          return
        }
        if (msg.version !== RELAY_PROTOCOL_VERSION) {
          // Surfaces in the popup as "rejected", which tells the user to
          // reload the extension — the only fix.
          socket.close(1008, 'protocol version mismatch')
          return
        }
        authed = true
        peer?.close(1000, 'replaced by a newer connection')
        peer = socket
        peerName = msg.browser
        peerCapabilities = new Set(msg.capabilities ?? [])
        socket.send(
          JSON.stringify({ type: 'welcome', version: RELAY_PROTOCOL_VERSION }),
        )
        socket.send(
          JSON.stringify({
            type: 'lockState',
            userHasControl: anyUserHasControl(),
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
        setUserHasControlEverywhere(msg.hasControl)
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
      peerCapabilities = new Set()
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
    wsUrl,

    connectUrl(clientName = DEFAULT_CLIENT_NAME, pairingToken) {
      const url = new URL(
        `chrome-extension://${BRIDGE_EXTENSION_ID}/connect.html`,
      )
      url.searchParams.set('relayUrl', wsUrl)
      url.searchParams.set('client', clientName)
      url.searchParams.set('protocolVersion', String(RELAY_PROTOCOL_VERSION))
      if (pairingToken)
        url.searchParams.set('proof', pairingProof(pairingToken, wsUrl))
      return url.toString()
    },

    isConnected,

    peerName() {
      return peerName
    },

    capabilities() {
      return peerCapabilities
    },

    waitForExtension(timeoutMs: number) {
      if (isConnected()) return Promise.resolve()
      return new Promise<void>((resolve, reject) => {
        // timeoutMs <= 0 means "wait indefinitely": the user has been shown a
        // prompt and may well walk away before approving it.
        const timer =
          timeoutMs > 0
            ? setTimeout(() => {
                const idx = waiters.indexOf(onReady)
                if (idx >= 0) waiters.splice(idx, 1)
                reject(new BrowserError(notConnectedMessage()))
              }, timeoutMs)
            : undefined
        const onReady = () => {
          if (timer) clearTimeout(timer)
          resolve()
        }
        waiters.push(onReady)
      })
    },

    request<T>(req: RelayRequestBody): Promise<T> {
      const socket = peer
      if (!socket || socket.readyState !== socket.OPEN) {
        return Promise.reject(new BrowserError(notConnectedMessage()))
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
      await new Promise<void>(resolve => httpServer.close(() => resolve()))
    },
  }
}
