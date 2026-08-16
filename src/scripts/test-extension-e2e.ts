/**
 * End-to-end test of the real MV3 extension in a real Chrome.
 *
 * The relay suite simulates the extension, so this covers the one thing it
 * cannot: that `background.js` actually boots as a service worker, pairs from
 * stored credentials, enforces tab ownership, and forwards CDP through
 * `chrome.debugger`.
 *
 * Runs against a throwaway profile — it never touches the user's Chrome.
 *
 * Run: npx tsx src/scripts/test-extension-e2e.ts [--headed]
 */
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createExtensionBackend } from '../browser/backends/extension.js'
import { startRelayServer } from '../browser/relay/server.js'
import { setBrowserBackendFactory, closeBrowser } from '../browser/manager.js'
import { setBrowserEngine, unlockBrowserEngine } from '../browser/engine.js'
import {
  clickTool,
  navigateTool,
  screenshotTool,
  tabsTool,
} from '../tools/BrowserTool/BrowserTool.js'
import type {
  AnyTool,
  DualChannelToolResult,
  ToolContext,
  ToolDefinition,
} from '../core/types.js'
import { startFixtureServer } from './browser-tool-suite.js'
import { launchChromeWithExtension, waitFor } from './chrome-launcher.js'

const HEADED = process.argv.includes('--headed')
const RELAY_PORT = 8901
const DEBUG_PORT = 9333

function toolContext(): ToolContext {
  return {
    eventBus: {
      emit() {},
      on() {},
      off() {},
    } as unknown as ToolContext['eventBus'],
    wire: { emit() {} } as unknown as ToolContext['wire'],
    cwd: process.cwd(),
    sessionId: 'extension-e2e',
  }
}

async function run(
  def: ToolDefinition,
  args: Record<string, unknown>,
  toolCallId = `call-${Math.random().toString(36).slice(2, 8)}`,
): Promise<DualChannelToolResult<Record<string, unknown>> | string> {
  const tool = def.create(process.cwd(), toolContext()) as AnyTool & {
    execute: (
      a: unknown,
      o: { toolCallId: string },
    ) => Promise<DualChannelToolResult<Record<string, unknown>> | string>
  }
  return tool.execute(args, { toolCallId })
}

function expectData(
  result: DualChannelToolResult<Record<string, unknown>> | string,
): Record<string, unknown> {
  assert.ok(typeof result !== 'string', `expected success, got: ${result}`)
  return result.data
}

function refFor(snapshot: string, role: string, name: string): string {
  const line = snapshot
    .split('\n')
    .find(l => l.includes(`${role} "${name}"`) && l.includes('[ref='))
  assert.ok(line, `no ref for ${role} "${name}" in:\n${snapshot}`)
  return /\[ref=([^\]]+)\]/.exec(line)![1]
}

async function main() {
  setBrowserEngine('cdp', true)
  const fixture = await startFixtureServer()
  const relay = await startRelayServer({ port: RELAY_PORT })
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-ext-e2e-'))

  const chrome = await launchChromeWithExtension({
    userDataDir: profile,
    debugPort: DEBUG_PORT,
    headless: !HEADED,
    pair: { token: relay.token, port: RELAY_PORT },
  })
  console.log(`ok [e2e] extension loaded into chrome (${chrome.extensionId})`)

  /** Real tabs in the browser, ignoring extension pages. */
  async function countUserPages(): Promise<number> {
    const { targetInfos } = await chrome.cdp.send<{
      targetInfos: Array<{ type: string; url: string }>
    }>('Target.getTargets')
    return targetInfos.filter(
      t => t.type === 'page' && !t.url.startsWith('chrome-extension://'),
    ).length
  }

  try {
    await waitFor('extension to pair', () => relay.isConnected())
    assert.match(String(relay.peerName()), /Chrome/)
    console.log('ok [e2e] paired from stored credentials, no user action')

    // ── drive the real extension through the tool layer ──
    setBrowserBackendFactory(() => createExtensionBackend({ relay }))

    const nav = expectData(await run(navigateTool, { url: fixture.url }))
    assert.equal(nav.title, 'Verify Loop Fixture')
    const snapshot = String(nav.snapshot)
    assert.ok(snapshot.includes('heading "Dashboard"'), snapshot)
    console.log('ok [e2e] navigate + snapshot through chrome.debugger')

    const counter = refFor(snapshot, 'button', 'Clicked 0 times')
    const clicked = expectData(await run(clickTool, { ref: counter }))
    assert.ok(String(clicked.snapshot).includes('Clicked 1 times'))
    console.log('ok [e2e] click through chrome.debugger')

    const shot = expectData(await run(screenshotTool, {}, 'e2e-shot'))
    assert.ok(fs.existsSync(String(shot.screenshotPath)))
    assert.ok(fs.statSync(String(shot.screenshotPath)).size > 1000)
    console.log('ok [e2e] screenshot through chrome.debugger')

    const stale = await run(clickTool, { ref: counter })
    assert.ok(
      typeof stale === 'string' && stale.includes('Clicked 1 times'),
      'stale refs must behave the same as on the isolated backend',
    )
    console.log('ok [e2e] stale ref detection matches the isolated backend')

    // ── the consent model, on the real extension ─────────
    assert.ok(
      (await countUserPages()) >= 2,
      'expected the original about:blank plus the agent tab',
    )

    const backend = await createExtensionBackend({ relay })
    const visible = await backend.listTabs()
    assert.equal(
      visible.length,
      1,
      `agent should only see the tab it opened, saw: ${JSON.stringify(visible)}`,
    )
    console.log("ok [e2e] agent cannot enumerate the user's other tabs")

    // Filtering the list is not enough — driving an unowned tab must be refused
    // too. Chrome tab ids are small integers, so probe a neighbouring one.
    const ownedId = Number(visible[0].targetId)
    const denied = await backend
      .send(String(ownedId === 1 ? 2 : 1), 'Runtime.evaluate', {
        expression: '1',
      })
      .then(() => 'allowed')
      .catch((err: Error) => err.message)
    assert.match(
      String(denied),
      /not shared with the agent/,
      `driving an unshared tab must be refused, got: ${denied}`,
    )
    console.log('ok [e2e] driving an unshared tab is refused')

    // ── tabs really open and close in the user's browser ──
    const pagesBefore = await countUserPages()
    const opened = expectData(
      await run(tabsTool, { action: 'new', url: fixture.url }),
    )
    assert.equal((opened.tabs as unknown[]).length, 2)
    assert.equal(await countUserPages(), pagesBefore + 1)

    const newTabId = (
      opened.tabs as Array<{ targetId: string; current?: boolean }>
    ).find(t => t.current)!.targetId
    const afterClose = expectData(
      await run(tabsTool, { action: 'close', tabId: newTabId }),
    )
    assert.equal((afterClose.tabs as unknown[]).length, 1)
    assert.equal(
      await countUserPages(),
      pagesBefore,
      'closing a tab must actually remove it from Chrome',
    )
    console.log('ok [e2e] tab open/close round-trips through chrome.tabs')

    const groups = await chrome.cdp.send<{ result: { value: unknown } }>(
      'Runtime.evaluate',
      {
        expression: 'chrome.tabGroups.query({ title: "Agent" })',
        awaitPromise: true,
        returnByValue: true,
      },
      chrome.workerSession,
    )
    const found = groups.result.value as Array<{ color: string }>
    assert.equal(
      found.length,
      1,
      'agent tabs should live in one labelled group',
    )
    assert.equal(found[0].color, 'orange')
    console.log('ok [e2e] agent tabs collected into a labelled tab group')

    // ── the popup, actually clicked ──────────────────────
    // Opened as an ordinary tab so its buttons can be driven; it is the same
    // document and the same messaging path as the real popup.
    const popup = await chrome.cdp.send<{ targetId: string }>(
      'Target.createTarget',
      { url: `chrome-extension://${chrome.extensionId}/popup.html` },
    )
    const { sessionId: popupSession } = await chrome.cdp.send<{
      sessionId: string
    }>('Target.attachToTarget', { targetId: popup.targetId, flatten: true })

    const readPopup = async () => {
      const res = await chrome.cdp.send<{ result: { value: unknown } }>(
        'Runtime.evaluate',
        {
          // Null-safe: the popup document may not have parsed yet.
          expression: `(() => {
            const status = document.getElementById('status');
            if (!status) return null;
            return {
              status: status.textContent,
              pairingVisible: document.getElementById('pairing').style.display !== 'none',
              tabCount: document.querySelectorAll('#tabs li:not(.empty)').length,
            };
          })()`,
          returnByValue: true,
        },
        popupSession,
      )
      return res.result.value as {
        status: string
        pairingVisible: boolean
        tabCount: number
      } | null
    }

    await waitFor('popup to render connected state', async () => {
      const state = await readPopup()
      return state?.status === 'connected' && state.tabCount === 1
    })
    const popupState = await readPopup()
    assert.equal(
      popupState?.pairingVisible,
      false,
      'the token field should be hidden once paired',
    )
    console.log('ok [e2e] popup shows connected and lists the shared tab')

    await chrome.cdp.send(
      'Runtime.evaluate',
      { expression: `document.querySelector('#tabs li button').click()` },
      popupSession,
    )
    await waitFor('agent to lose the tab', async () => {
      return (await backend.listTabs()).length === 0
    })
    const afterRevoke = await backend
      .send(visible[0].targetId, 'Runtime.evaluate', { expression: '1' })
      .then(() => 'allowed')
      .catch((err: Error) => err.message)
    assert.match(
      String(afterRevoke),
      /not shared with the agent/,
      `revoking from the popup must actually revoke access, got: ${afterRevoke}`,
    )
    console.log('ok [e2e] revoking a tab from the popup cuts the agent off')

    // Owned list is empty. navigate must open a new owned tab at the requested
    // URL — not bind some other page still sitting in the user's Chrome.
    const emptyNav = expectData(
      await run(navigateTool, { url: `${fixture.url}dialog-lazy` }),
    )
    assert.match(
      String(emptyNav.url),
      /dialog-lazy/,
      `empty owned list must create+navigate a new tab, got url=${emptyNav.url}`,
    )
    const ownedAgain = await backend.listTabs()
    assert.equal(
      ownedAgain.length,
      1,
      `expected one newly owned tab, saw: ${JSON.stringify(ownedAgain)}`,
    )
    assert.match(ownedAgain[0].url, /dialog-lazy/)
    assert.ok(
      String(emptyNav.snapshot).includes('Hiring home') ||
        String(emptyNav.snapshot).includes('有新消息'),
      `new tab snapshot must be the fixture, not another page:\n${String(emptyNav.snapshot).slice(0, 400)}`,
    )
    console.log('ok [e2e] empty owned list → navigate opens a new owned tab')

    // ── the extension survives the agent going away ──────
    await relay.close()
    await waitFor('extension to notice the drop', async () => {
      const status = await chrome.cdp.send<{ result: { value: unknown } }>(
        'Runtime.evaluate',
        {
          expression: 'chrome.storage.local.get("status")',
          awaitPromise: true,
          returnByValue: true,
        },
        chrome.workerSession,
      )
      return (
        (status.result.value as { status?: string })?.status === 'disconnected'
      )
    })
    console.log('ok [e2e] extension reports disconnect and stays alive')

    console.log('\nall real-extension end-to-end tests passed')
  } finally {
    unlockBrowserEngine()
    setBrowserBackendFactory(null)
    await closeBrowser().catch(() => {})
    await chrome.close()
    await relay.close().catch(() => {})
    await fixture.close()
    fs.rmSync(profile, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200,
    })
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
