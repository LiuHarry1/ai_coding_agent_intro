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
import { createIsolatedBackend } from '../browser/backends/isolated.js'
import { startRelayServer } from '../browser/relay/server.js'
import type { BrowserBackend } from '../browser/types.js'
import {
  runBrowserToolSuite,
  startFixtureServer,
} from './browser-tool-suite.js'

const HEADED = process.argv.includes('--headed')
const RELAY_PORT = 8899

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
  port: number,
  token: string,
  chrome: BrowserBackend,
): Promise<FakeExtension> {
  const owned = new Set<string>()
  const seenMethods = new Set<string>()
  let deniedCount = 0

  const ws = new WebSocket(`ws://127.0.0.1:${port}`)

  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => {
      ws.send(
        JSON.stringify({
          type: 'hello',
          token,
          version: 1,
          browser: 'FakeChrome/1.0',
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

  function assertOwned(targetId: string): void {
    if (!owned.has(targetId)) {
      deniedCount++
      throw new Error(
        `Tab ${targetId} is not shared with the agent. Open it with browser_tabs, ` +
          'or share it from the extension popup.',
      )
    }
  }

  async function handle(msg: Record<string, unknown>): Promise<unknown> {
    switch (msg.method) {
      case 'tabs.list': {
        const tabs = await chrome.listTabs()
        return tabs.filter(t => owned.has(t.targetId))
      }
      case 'tabs.create': {
        const tab = await chrome.createTab(msg.url as string | undefined)
        owned.add(tab.targetId)
        return tab
      }
      case 'tabs.close': {
        const id = msg.targetId as string
        assertOwned(id)
        owned.delete(id)
        await chrome.closeTab(id)
        return true
      }
      case 'cdp': {
        const id = msg.targetId as string
        assertOwned(id)
        seenMethods.add(msg.cdpMethod as string)
        return (
          (await chrome.send(
            id,
            msg.cdpMethod as string,
            msg.params as Record<string, unknown>,
          )) ?? {}
        )
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

async function testRejectsBadToken(port: number): Promise<void> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`)
  const code = await new Promise<number>((resolve, reject) => {
    ws.once('open', () => {
      ws.send(
        JSON.stringify({ type: 'hello', token: 'not-the-token', version: 1 }),
      )
    })
    ws.once('close', c => resolve(c))
    ws.once('error', reject)
  })
  assert.equal(code, 1008, 'relay must reject an unpaired client')
  console.log('ok [relay] rejects a bad pairing token')
}

async function main() {
  const server = await startFixtureServer()
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-browser-relay-'))

  const relay = await startRelayServer({ port: RELAY_PORT })
  console.log(`ok [relay] listening on 127.0.0.1:${relay.port}`)

  await testRejectsBadToken(relay.port)

  // Stands in for the user's signed-in Chrome.
  const chrome = await createIsolatedBackend({
    userDataDir: profile,
    headless: !HEADED,
    viewport: { width: 1280, height: 800 },
  })
  const extension = await startFakeExtension(relay.port, relay.token, chrome)
  assert.equal(relay.isConnected(), true)
  assert.match(String(relay.peerName()), /FakeChrome/)
  console.log('ok [relay] extension paired and handshook')

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
    assert.equal(
      extension.deniedCount,
      1,
      'suite should only touch agent-owned tabs, apart from the deliberate dead-tab close',
    )
    // And the relay really did carry the whole CDP surface.
    for (const required of [
      'Runtime.evaluate',
      'Page.navigate',
      'Page.addScriptToEvaluateOnNewDocument',
      'Page.captureScreenshot',
      'Input.dispatchMouseEvent',
      'Input.dispatchKeyEvent',
      'Input.insertText',
    ]) {
      assert.ok(
        extension.seenMethods.has(required),
        `expected ${required} to be forwarded over the relay`,
      )
    }
    console.log(
      `ok [relay] forwarded ${extension.seenMethods.size} distinct CDP methods`,
    )

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
