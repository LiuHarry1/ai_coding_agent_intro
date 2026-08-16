/**
 * Synthetic CDP browser endpoint so Playwright can `connectOverCDP` to the
 * extension backend — the same pattern OpenClaw and Playwright MCP use.
 *
 * Chrome's debugger API is tab-scoped and has no `/json/version`. This server
 * pretends to be one: HTTP discovery plus a WebSocket that synthesizes
 * Target.setAutoAttach / attachedToTarget, then forwards page-session CDP
 * through the existing relay.
 */

import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { WebSocketServer, type WebSocket } from 'ws'
import { BrowserError, type BrowserBackend } from '../types.js'
import type { RelayServer } from '../relay/server.js'
import type { RelayCdpEvent } from '../relay/protocol.js'

const BROWSER_CONTEXT_ID = 'agent-extension-context'
const BROWSER_TARGET_ID = 'agent-extension-relay'

export interface CdpEndpoint {
  readonly httpUrl: string
  readonly port: number
  /** Attach any tabs Playwright does not yet know about (after tabs.create). */
  syncTabs(): Promise<void>
  close(): Promise<void>
}

interface CdpRequest {
  id: number
  method: string
  params?: Record<string, unknown>
  sessionId?: string
}

interface TabSession {
  targetId: string
  sessionId: string
  chromeTargetId: string
  url: string
  title: string
  childSessions: Set<string>
}

export async function startCdpEndpoint(opts: {
  backend: BrowserBackend
  relay: RelayServer
}): Promise<CdpEndpoint> {
  const { backend, relay } = opts
  const browserGuid = randomUUID()

  const tabSessions = new Map<string, TabSession>()
  const sessionById = new Map<string, TabSession>()
  let nextSession = 1
  const clients = new Set<WebSocket>()

  function emit(payload: Record<string, unknown>): void {
    const raw = JSON.stringify(payload)
    for (const client of clients) {
      if (client.readyState === client.OPEN) client.send(raw)
    }
  }

  function respond(
    socket: WebSocket,
    request: CdpRequest,
    result: unknown,
  ): void {
    socket.send(
      JSON.stringify({
        id: request.id,
        ...(request.sessionId ? { sessionId: request.sessionId } : {}),
        result,
      }),
    )
  }

  function respondError(
    socket: WebSocket,
    request: CdpRequest,
    message: string,
    code = -32601,
  ): void {
    socket.send(
      JSON.stringify({
        id: request.id,
        ...(request.sessionId ? { sessionId: request.sessionId } : {}),
        error: { code, message },
      }),
    )
  }

  function targetInfo(tab: TabSession): Record<string, unknown> {
    return {
      targetId: tab.chromeTargetId,
      type: 'page',
      title: tab.title,
      url: tab.url,
      attached: true,
      canAccessOpener: false,
      browserContextId: BROWSER_CONTEXT_ID,
    }
  }

  async function ensureAttached(targetId: string): Promise<TabSession> {
    const existing = tabSessions.get(targetId)
    if (existing) return existing

    const tabs = await backend.listTabs()
    const tab = tabs.find(t => t.targetId === targetId)
    if (!tab) {
      throw new BrowserError(`No open tab with id "${targetId}"`)
    }

    let chromeTargetId = `tab-${targetId}`
    try {
      const info = await backend.send<{
        targetInfo?: { targetId?: string }
      }>(targetId, 'Target.getTargetInfo')
      if (typeof info?.targetInfo?.targetId === 'string') {
        chromeTargetId = info.targetInfo.targetId
      }
    } catch {
      // chrome.debugger sometimes cannot answer this; a stable fallback is fine.
    }

    const session: TabSession = {
      targetId,
      sessionId: `pw-tab-${nextSession++}`,
      chromeTargetId,
      url: tab.url,
      title: tab.title,
      childSessions: new Set(),
    }
    tabSessions.set(targetId, session)
    sessionById.set(session.sessionId, session)
    return session
  }

  function announce(tab: TabSession): void {
    emit({
      method: 'Target.attachedToTarget',
      params: {
        sessionId: tab.sessionId,
        targetInfo: targetInfo(tab),
        waitingForDebugger: false,
      },
    })
  }

  async function enableAutoAttach(): Promise<void> {
    const tabs = await backend.listTabs()
    const live = new Set(tabs.map(t => t.targetId))
    for (const [id, session] of tabSessions) {
      if (live.has(id)) continue
      tabSessions.delete(id)
      sessionById.delete(session.sessionId)
      emit({
        method: 'Target.detachedFromTarget',
        params: {
          sessionId: session.sessionId,
          targetId: session.chromeTargetId,
        },
      })
    }
    for (const tab of tabs) {
      const already = tabSessions.has(tab.targetId)
      try {
        const session = await ensureAttached(tab.targetId)
        session.url = tab.url
        session.title = tab.title
        if (!already) announce(session)
      } catch {
        // A tab the extension no longer owns — skip.
      }
    }
  }

  function tabForSession(sessionId: string | undefined): TabSession | undefined {
    if (!sessionId) return undefined
    const direct = sessionById.get(sessionId)
    if (direct) return direct
    for (const tab of tabSessions.values()) {
      if (tab.childSessions.has(sessionId)) return tab
    }
    return undefined
  }

  const unsub = relay.onCdpEvent((event: RelayCdpEvent) => {
    const tab = tabSessions.get(event.targetId)
    if (!tab) return
    if (event.method === 'Target.attachedToTarget' && event.params) {
      const child = (event.params as { sessionId?: unknown }).sessionId
      if (typeof child === 'string') tab.childSessions.add(child)
    } else if (event.method === 'Target.detachedFromTarget' && event.params) {
      const child = (event.params as { sessionId?: unknown }).sessionId
      if (typeof child === 'string') tab.childSessions.delete(child)
    }
    const sessionId = event.sessionId || tab.sessionId
    emit({
      sessionId,
      method: event.method,
      params: event.params ?? {},
    })
  })

  async function handleRoot(
    socket: WebSocket,
    request: CdpRequest,
  ): Promise<void> {
    switch (request.method) {
      case 'Browser.getVersion': {
        respond(socket, request, {
          protocolVersion: '1.3',
          product: 'Chrome/extension-relay',
          revision: 'agent-extension-relay',
          userAgent: relay.peerName() ?? 'Chrome',
          jsVersion: '',
        })
        return
      }
      case 'Browser.close': {
        respond(socket, request, {})
        socket.close(1000, 'Browser.close')
        return
      }
      case 'Browser.setDownloadBehavior':
      case 'Target.setDiscoverTargets': {
        respond(socket, request, {})
        return
      }
      case 'Target.getBrowserContexts': {
        respond(socket, request, { browserContextIds: [] })
        return
      }
      case 'Target.getTargetInfo': {
        const targetId = request.params?.targetId as string | undefined
        if (!targetId || targetId === BROWSER_TARGET_ID) {
          respond(socket, request, {
            targetInfo: {
              targetId: BROWSER_TARGET_ID,
              type: 'browser',
              title: 'Agent Extension Relay',
              url: '',
              attached: true,
              canAccessOpener: false,
            },
          })
          return
        }
        const found =
          [...tabSessions.values()].find(
            t => t.chromeTargetId === targetId || t.targetId === targetId,
          ) ?? null
        if (!found) {
          respondError(
            socket,
            request,
            `No target with given id found: ${targetId}`,
            -32602,
          )
          return
        }
        respond(socket, request, { targetInfo: targetInfo(found) })
        return
      }
      case 'Target.getTargets': {
        respond(socket, request, {
          targetInfos: [...tabSessions.values()].map(targetInfo),
        })
        return
      }
      case 'Target.setAutoAttach': {
        if (request.params?.autoAttach !== false) {
          await enableAutoAttach()
        }
        respond(socket, request, {})
        return
      }
      case 'Target.attachToTarget': {
        const targetId = request.params?.targetId as string | undefined
        const found = targetId
          ? [...tabSessions.values()].find(
              t => t.chromeTargetId === targetId || t.targetId === targetId,
            )
          : undefined
        if (!found && targetId) {
          // A tab we have not auto-attached yet — try by our own id.
          try {
            const session = await ensureAttached(targetId)
            announce(session)
            respond(socket, request, { sessionId: session.sessionId })
            return
          } catch {
            respondError(
              socket,
              request,
              `No target with given id found: ${targetId}`,
              -32602,
            )
            return
          }
        }
        if (!found) {
          respondError(socket, request, 'targetId is required', -32602)
          return
        }
        respond(socket, request, { sessionId: found.sessionId })
        return
      }
      case 'Target.createTarget': {
        const url =
          typeof request.params?.url === 'string'
            ? request.params.url
            : 'about:blank'
        const created = await backend.createTab(url)
        const session = await ensureAttached(created.targetId)
        session.url = created.url
        session.title = created.title
        announce(session)
        respond(socket, request, { targetId: session.chromeTargetId })
        return
      }
      case 'Target.closeTarget': {
        const targetId = request.params?.targetId as string | undefined
        const found = targetId
          ? [...tabSessions.values()].find(
              t => t.chromeTargetId === targetId || t.targetId === targetId,
            )
          : undefined
        if (!found) {
          respondError(
            socket,
            request,
            `No target with given id found: ${String(targetId)}`,
            -32602,
          )
          return
        }
        await backend.closeTab(found.targetId)
        tabSessions.delete(found.targetId)
        sessionById.delete(found.sessionId)
        emit({
          method: 'Target.detachedFromTarget',
          params: {
            sessionId: found.sessionId,
            targetId: found.chromeTargetId,
          },
        })
        respond(socket, request, { success: true })
        return
      }
      case 'Target.activateTarget': {
        const targetId = request.params?.targetId as string | undefined
        const found = targetId
          ? [...tabSessions.values()].find(
              t => t.chromeTargetId === targetId || t.targetId === targetId,
            )
          : undefined
        if (found) {
          await backend.send(found.targetId, 'Page.bringToFront').catch(() => {})
        }
        respond(socket, request, {})
        return
      }
      case 'Target.detachFromTarget': {
        respond(socket, request, {})
        return
      }
      default: {
        respondError(
          socket,
          request,
          `'${request.method}' wasn't found`,
          -32601,
        )
      }
    }
  }

  async function handleSession(
    socket: WebSocket,
    request: CdpRequest,
  ): Promise<void> {
    const tab = tabForSession(request.sessionId)
    if (!tab) {
      respondError(
        socket,
        request,
        `Session not found: ${String(request.sessionId)}`,
        -32001,
      )
      return
    }

    if (request.method === 'Target.getTargetInfo' && !request.params?.targetId) {
      respond(socket, request, { targetInfo: targetInfo(tab) })
      return
    }

    const child =
      request.sessionId && tab.childSessions.has(request.sessionId)
        ? request.sessionId
        : undefined

    try {
      const result = await relay.request({
        method: 'cdp',
        targetId: tab.targetId,
        cdpMethod: request.method,
        params: request.params,
        ...(child ? { sessionId: child } : {}),
      })
      respond(socket, request, result ?? {})
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      respondError(socket, request, message, -32000)
    }
  }

  const httpServer = http.createServer((req, res) => {
    const url = req.url ?? '/'
    if (url.startsWith('/json/version')) {
      const address = httpServer.address()
      const port =
        typeof address === 'object' && address !== null ? address.port : 0
      res.setHeader('content-type', 'application/json')
      res.end(
        JSON.stringify({
          Browser: 'Chrome/extension-relay',
          'Protocol-Version': '1.3',
          'User-Agent': relay.peerName() ?? 'Chrome',
          webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/${browserGuid}`,
        }),
      )
      return
    }
    if (url.startsWith('/json/list') || url === '/json') {
      res.setHeader('content-type', 'application/json')
      res.end(
        JSON.stringify(
          [...tabSessions.values()].map(tab => ({
            id: tab.chromeTargetId,
            type: 'page',
            title: tab.title,
            url: tab.url,
          })),
        ),
      )
      return
    }
    res.statusCode = 404
    res.end()
  })

  const wss = new WebSocketServer({ noServer: true })
  httpServer.on('upgrade', (req, socket, head) => {
    const url = req.url ?? ''
    if (
      !url.startsWith('/devtools/browser/') &&
      url !== '/cdp' &&
      !url.startsWith('/cdp?')
    ) {
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, ws => {
      wss.emit('connection', ws, req)
    })
  })

  wss.on('connection', ws => {
    clients.add(ws)
    ws.on('message', raw => {
      let request: CdpRequest
      try {
        request = JSON.parse(String(raw)) as CdpRequest
      } catch {
        return
      }
      if (typeof request.id !== 'number' || typeof request.method !== 'string') {
        return
      }
      const handle = request.sessionId
        ? handleSession(ws, request)
        : handleRoot(ws, request)
      void handle.catch(err => {
        respondError(
          ws,
          request,
          err instanceof Error ? err.message : String(err),
          -32000,
        )
      })
    })
    ws.on('close', () => {
      clients.delete(ws)
    })
  })

  await new Promise<void>((resolve, reject) => {
    httpServer.listen(0, '127.0.0.1', () => resolve())
    httpServer.once('error', reject)
  })

  const address = httpServer.address()
  const port =
    typeof address === 'object' && address !== null ? address.port : 0

  return {
    port,
    httpUrl: `http://127.0.0.1:${port}`,
    syncTabs: enableAutoAttach,
    async close() {
      unsub()
      for (const client of clients) client.close()
      clients.clear()
      await new Promise<void>(resolve => wss.close(() => resolve()))
      await new Promise<void>((resolve, reject) => {
        httpServer.close(err => (err ? reject(err) : resolve()))
      })
    },
  }
}
