/**
 * Conformance suite against the extension backend, over a real WebSocket relay.
 *
 * The extension is simulated by a Node client that speaks the relay protocol
 * and services requests from a real Chrome — the same thing `background.js`
 * does, with `chrome.debugger.sendCommand` swapped for a CDP session. That
 * leaves only the Chrome extension APIs untested, and covers everything that
 * could realistically differ between the two backends: the wire protocol, the
 * ownership model, correlation, error propagation, and all browser tools.
 *
 * Run: npx tsx src/scripts/test-browser-relay.ts
 */
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { WebSocket } from 'ws'
import { createExtensionBackend } from '../browser/backends/extension.js'
import {
  createIsolatedBackend,
  onIsolatedCdpEvent,
} from '../browser/backends/isolated.js'
import { BRIDGE_EXTENSION_ORIGIN } from '../browser/relay/extension-id.js'
import { startRelayServer } from '../browser/relay/server.js'
import type { BrowserBackend } from '../browser/types.js'
import {
  runBrowserToolSuite,
  startFixtureServer,
} from './browser-tool-suite.js'

const HEADED = process.argv.includes('--headed')

interface FakeExtension {
  close: () => Promise<void>
  /** CDP methods the simulated extension was asked to forward. */
  seenMethods: Set<string>
  deniedCount: number
}

/**
 * Mirrors chrome-extension/background.js: only tabs the agent opened (or that were
 * explicitly shared) may be listed or driven.
 */
async function startFakeExtension(
  wsUrl: string,
  chrome: BrowserBackend,
): Promise<FakeExtension> {
  const owned = new Set<number>()
  const seenMethods = new Set<string>()
  let deniedCount = 0

  // Chrome tab ids are numbers, and the reflective protocol puts them on the
  // wire inside a debuggee object, so the fake has to hand out numbers too —
  // the CDP target strings underneath are a detail the host never sees.
  const toTabId = new Map<string, number>()
  const toCdpTarget = new Map<number, string>()
  let nextTabId = 1

  function tabIdFor(cdpTarget: string): number {
    let id = toTabId.get(cdpTarget)
    if (id === undefined) {
      id = nextTabId++
      toTabId.set(cdpTarget, id)
      toCdpTarget.set(id, cdpTarget)
    }
    return id
  }

  const ws = new WebSocket(wsUrl, { origin: BRIDGE_EXTENSION_ORIGIN })

  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => {
      ws.send(
        JSON.stringify({
          type: 'hello',
          version: 2,
          browser: 'FakeChrome/1.0',
          capabilities: [
            'tabs.list',
            'tabs.create',
            'tabs.close',
            'tabs.getActiveUserTab',
            'tabs.focus',
            'tabs.restore',
            'chrome.debugger.attach',
            'chrome.debugger.detach',
            'chrome.debugger.sendCommand',
          ],
        }),
      )
    })
    ws.once('error', reject)
    ws.on('message', function onMsg(raw) {
      const msg = JSON.parse(String(raw))
      if (msg.type === 'welcome') {
        ws.off('message', onMsg)
        resolve()
      }
    })
  })

  function assertOwned(tabId: number): string {
    const cdpTarget = owned.has(tabId) ? toCdpTarget.get(tabId) : undefined
    if (!cdpTarget) {
      deniedCount++
      throw new Error(
        `Tab ${tabId} is not shared with the agent. Open it with browser_tabs, ` +
          'or share it from the extension popup.',
      )
    }
    return cdpTarget
  }

  // Mirrors chrome.debugger.onEvent: Playwright on the host waits on these
  // (lifecycle, execution contexts), so without them every navigate hangs.
  const forwarding = new Set<number>()
  function forwardEvents(tabId: number, cdpTarget: string): void {
    if (forwarding.has(tabId)) return
    forwarding.add(tabId)
    onIsolatedCdpEvent(chrome, cdpTarget, (method, params) => {
      if (ws.readyState !== WebSocket.OPEN) return
      ws.send(
        JSON.stringify({ type: 'cdpEvent', targetId: String(tabId), method, params }),
      )
    })
  }

  async function handle(msg: Record<string, unknown>): Promise<unknown> {
    switch (msg.method) {
      case 'tabs.list': {
        const tabs = await chrome.listTabs()
        return tabs
          .filter(t => owned.has(tabIdFor(t.targetId)))
          .map(t => ({ ...t, targetId: String(tabIdFor(t.targetId)) }))
      }
      case 'tabs.create': {
        const tab = await chrome.createTab(msg.url as string | undefined)
        const tabId = tabIdFor(tab.targetId)
        owned.add(tabId)
        return { ...tab, targetId: String(tabId) }
      }
      case 'tabs.close': {
        const tabId = Number(msg.targetId)
        const cdpTarget = assertOwned(tabId)
        owned.delete(tabId)
        await chrome.closeTab(cdpTarget)
        return true
      }
      case 'tabs.getActiveUserTab': {
        const tabs = await chrome.listTabs()
        const tab = tabs[0]
        if (!tab) return null
        return { ...tab, targetId: String(tabIdFor(tab.targetId)) }
      }
      case 'tabs.focus':
      case 'tabs.restore':
        return true
      // Mirrors the extension's reflective path: the tab id comes out of the
      // debuggee argument and is ownership-checked before anything runs.
      case 'chrome.debugger.sendCommand': {
        const [debuggee, cdpMethod, params] = msg.params as [
          { tabId: number },
          string,
          Record<string, unknown>,
        ]
        const cdpTarget = assertOwned(debuggee.tabId)
        forwardEvents(debuggee.tabId, cdpTarget)
        seenMethods.add(cdpMethod)
        return (await chrome.send(cdpTarget, cdpMethod, params)) ?? {}
      }
      default:
        throw new Error(`Unknown relay method: ${String(msg.method)}`)
    }
  }

  ws.on('message', async raw => {
    const msg = JSON.parse(String(raw))
    if (typeof msg.id !== 'number') return
    try {
      ws.send(
        JSON.stringify({ id: msg.id, ok: true, result: await handle(msg) }),
      )
    } catch (err) {
      ws.send(
        JSON.stringify({
          id: msg.id,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        }),
      )
    }
  })

  return {
    seenMethods,
    get deniedCount() {
      return deniedCount
    },
    close: () =>
      new Promise<void>(resolve => {
        if (ws.readyState === WebSocket.CLOSED) return resolve()
        ws.once('close', () => resolve())
        ws.close()
      }),
  }
}

/** The handshake must fail before a socket opens, never after. */
async function expectHandshakeRejected(
  wsUrl: string,
  opts: { origin?: string },
): Promise<void> {
  const ws = new WebSocket(wsUrl, opts)
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => reject(new Error('the relay accepted the socket')))
    ws.once('error', () => resolve())
    ws.once('close', () => resolve())
  })
  ws.terminate()
}

/**
 * Origin is written by the browser and cannot be forged from a page, so it is
 * what stops any local process — or any site running JavaScript — from
 * driving the agent's browser if it ever guesses the url.
 */
async function testRejectsBadOrigin(relayUrl: string): Promise<void> {
  await expectHandshakeRejected(relayUrl, {
    origin: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  })
  await expectHandshakeRejected(relayUrl, { origin: 'https://evil.example' })
  await expectHandshakeRejected(relayUrl, {})
  console.log('ok [relay] rejects a handshake from any other origin')
}

/** The path holds the per-process uuid; without it the url is not a credential. */
async function testRejectsBadPath(relayUrl: string): Promise<void> {
  const wrong = new URL(relayUrl)
  wrong.pathname = '/relay/00000000-0000-0000-0000-000000000000'
  await expectHandshakeRejected(wrong.toString(), {
    origin: BRIDGE_EXTENSION_ORIGIN,
  })

  const root = new URL(relayUrl)
  root.pathname = '/'
  await expectHandshakeRejected(root.toString(), {
    origin: BRIDGE_EXTENSION_ORIGIN,
  })
  console.log('ok [relay] rejects a handshake on any other path')
}

async function main() {
  const server = await startFixtureServer()
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-browser-relay-'))

  const relay = await startRelayServer()
  assert.ok(relay.port > 0, 'the OS must have assigned a port')
  assert.match(relay.wsUrl, /^ws:\/\/127\.0\.0\.1:\d+\/relay\/[0-9a-f-]{36}$/)
  console.log(`ok [relay] listening on 127.0.0.1:${relay.port}`)

  await testRejectsBadOrigin(relay.wsUrl)
  await testRejectsBadPath(relay.wsUrl)

  // Stands in for the user's signed-in Chrome.
  const chrome = await createIsolatedBackend({
    userDataDir: profile,
    headless: !HEADED,
    viewport: { width: 1280, height: 800 },
  })
  const extension = await startFakeExtension(relay.wsUrl, chrome)
  assert.equal(relay.isConnected(), true)
  assert.match(String(relay.peerName()), /FakeChrome/)
  assert.ok(
    relay.capabilities().has('chrome.debugger.sendCommand'),
    'the handshake must carry what the extension can do',
  )
  console.log('ok [relay] extension connected and handshook')

  try {
    await runBrowserToolSuite({
      label: 'extension',
      baseUrl: server.url,
      sessionId: 'browser-relay-test',
      backendFactory: () => createExtensionBackend({ relay }),
    })

    // The consent model held. Exactly one denial is expected: the suite ends by
    // deliberately closing an already-closed tab. Any other count means the
    // tool layer reached for a tab the agent does not own.
    const deniedDuringSuite = extension.deniedCount
    assert.equal(
      deniedDuringSuite,
      1,
      'suite should only touch agent-owned tabs, apart from the deliberate dead-tab close',
    )
    // And the relay really did carry the whole CDP surface.
    for (const required of [
      'Runtime.evaluate',
      'Page.addScriptToEvaluateOnNewDocument',
    ]) {
      assert.ok(
        extension.seenMethods.has(required),
        `expected ${required} to be forwarded over the relay`,
      )
    }
    console.log(
      `ok [relay] forwarded ${extension.seenMethods.size} distinct CDP methods`,
    )

    // Reflective forwarding must not become a way around the ownership model.
    // The tab id travels inside the debuggee argument now, so that is exactly
    // where the check has to happen.
    for (const attempt of [
      {
        what: 'a tab the agent never opened',
        req: {
          method: 'chrome.debugger.sendCommand' as const,
          params: [{ tabId: 999_999 }, 'Runtime.evaluate', { expression: '1' }],
        },
      },
      {
        what: 'closing a tab the agent never opened',
        req: { method: 'tabs.close' as const, targetId: '999999' },
      },
    ]) {
      const denied = await relay
        .request(attempt.req)
        .then(() => 'allowed')
        .catch((err: Error) => err.message)
      assert.match(
        String(denied),
        /is not shared with the agent/,
        `the extension must refuse ${attempt.what}`,
      )
    }
    assert.equal(
      extension.deniedCount,
      deniedDuringSuite + 2,
      'both over-reach attempts must have been counted as denials',
    )
    console.log('ok [relay] reflective calls cannot reach unowned tabs')

    // A disconnected extension must fail loudly rather than hang.
    await extension.close()
    await new Promise(r => setTimeout(r, 100))
    assert.equal(relay.isConnected(), false)
    const orphaned = await createExtensionBackend({
      relay,
      connectTimeoutMs: 300,
    })
      .then(() => 'connected')
      .catch((err: Error) => err.message)
    // Assert on what makes the message useful, not its exact prose: it must say
    // what is wrong, and offer both ways out.
    assert.match(String(orphaned), /No browser extension is connected/)
    assert.match(String(orphaned), /extension\/README/)
    assert.match(String(orphaned), /"isolated"/)
    console.log('ok [relay] missing extension produces an actionable error')

    console.log('\nall extension-backend tests passed')
  } finally {
    await extension.close().catch(() => {})
    await chrome.dispose().catch(() => {})
    await relay.close()
    await server.close()
    fs.rmSync(profile, { recursive: true, force: true })
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
