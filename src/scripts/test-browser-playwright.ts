/**
 * Playwright-engine checks that go beyond the shared dual-backend suite:
 * fill_form readonly handling, wait_for vs click settle, iframe-adjacent refs.
 *
 * Run: npx tsx src/scripts/test-browser-playwright.ts
 * Add --headed to watch it happen.
 */
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createIsolatedBackend } from '../browser/backends/isolated.js'
import {
  closeBrowser,
  setBrowserBackendFactory,
} from '../browser/manager.js'
import {
  clickTool,
  evaluateTool,
  fillFormTool,
  navigateTool,
  snapshotTool,
  typeTool,
  waitForTool,
} from '../tools/BrowserTool/BrowserTool.js'
import type {
  AnyTool,
  DualChannelToolResult,
  ToolContext,
  ToolDefinition,
} from '../core/types.js'
import { startFixtureServer } from './browser-tool-suite.js'

const HEADED = process.argv.includes('--headed')

function toolContext(sessionId: string): ToolContext {
  return {
    eventBus: { emit() {}, on() {}, off() {} } as unknown as ToolContext['eventBus'],
    wire: { emit() {} } as unknown as ToolContext['wire'],
    cwd: process.cwd(),
    sessionId,
  }
}

async function run(
  def: ToolDefinition,
  args: Record<string, unknown>,
  sessionId: string,
): Promise<DualChannelToolResult<Record<string, unknown>> | string> {
  const instance = def.create(process.cwd(), toolContext(sessionId)) as AnyTool & {
    execute: (
      a: unknown,
      o: { toolCallId: string },
    ) => Promise<DualChannelToolResult<Record<string, unknown>> | string>
  }
  return instance.execute(args, { toolCallId: 'pw-1' })
}

function expectData(
  result: DualChannelToolResult<Record<string, unknown>> | string,
): Record<string, unknown> {
  assert.ok(
    typeof result !== 'string',
    `expected structured result, got: ${result}`,
  )
  return result.data
}

function refFor(snapshot: string, role: string, name: string): string {
  const line = snapshot
    .split('\n')
    .find(l => l.includes(`${role} "${name}"`) && l.includes('[ref='))
  assert.ok(line, `no ref for ${role} "${name}" in:\n${snapshot}`)
  return /\[ref=([^\]]+)\]/.exec(line)![1]
}

function refNear(snapshot: string, needle: string): string {
  const line = snapshot
    .split('\n')
    .find(l => l.includes(needle) && l.includes('[ref='))
  assert.ok(line, `no ref near "${needle}" in:\n${snapshot}`)
  return /\[ref=([^\]]+)\]/.exec(line)![1]
}

async function main() {
  const server = await startFixtureServer()
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-browser-pw-'))

  setBrowserBackendFactory(() =>
    createIsolatedBackend({
      userDataDir: profile,
      headless: !HEADED,
      viewport: { width: 1280, height: 800 },
    }),
  )

  try {
    const sessionId = 'browser-pw-test'
    const nav = expectData(
      await run(navigateTool, { url: server.url }, sessionId),
    )
    const snapshot = String(nav.snapshot)
    assert.ok(
      snapshot.includes('[ref='),
      `Playwright AI snapshot must stamp refs:\n${snapshot}`,
    )
    assert.ok(
      snapshot.includes('heading "Dashboard"') ||
        snapshot.includes('heading "Dashboard" [level=1]'),
      snapshot,
    )
    console.log('ok [playwright] ariaSnapshot({ mode: "ai" }) returns refs')
    console.log('\n--- playwright snapshot ---\n' + snapshot + '\n----------------\n')

    const counterRef = refFor(snapshot, 'button', 'Clicked 0 times')
    const clicked = expectData(
      await run(clickTool, { ref: counterRef }, sessionId),
    )
    assert.ok(
      String(clicked.snapshot).includes('Clicked 1 times'),
      `aria-ref click must fire the handler:\n${clicked.snapshot}`,
    )
    console.log('ok [playwright] locator(aria-ref).click() mutates the page')

    const after = expectData(await run(snapshotTool, {}, sessionId))
    const emailRef = refFor(String(after.snapshot), 'textbox', 'Email address')
    const typed = expectData(
      await run(
        typeTool,
        { ref: emailRef, text: 'pw@example.com', submit: true },
        sessionId,
      ),
    )
    assert.ok(
      String(typed.snapshot).includes('Submitted pw@example.com'),
      `aria-ref type+submit failed:\n${typed.snapshot}`,
    )
    console.log('ok [playwright] locator(aria-ref) type + submit')

    const overflow = expectData(
      await run(navigateTool, { url: `${server.url}overflow` }, sessionId),
    )
    const overflowSnap = String(overflow.snapshot)
    assert.ok(
      overflowSnap.includes('Chat dock'),
      `truncated Playwright snapshot must keep the fixed dock:\n${overflowSnap.slice(-600)}`,
    )
    const dockLine = overflowSnap
      .split('\n')
      .find(l => l.includes('Chat dock') && l.includes('[ref='))
    assert.ok(
      dockLine && /\[cursor=pointer\]/.test(dockLine),
      `badge+label must be a clickable parent, not em "1":\n${overflowSnap.slice(-800)}`,
    )
    assert.ok(
      !/emphasis[^\n]*\[ref=[^\]]+\][^\n]*: "1"/.test(overflowSnap) ||
        /Chat dock/.test(dockLine ?? ''),
      `numeric badge should not be the click target:\n${overflowSnap.slice(-800)}`,
    )
    console.log('ok [playwright] truncated snapshot keeps end-of-tree chrome')
    console.log('ok [playwright] badge+label grouped onto a clickable parent')

    const lazy = expectData(
      await run(navigateTool, { url: `${server.url}dialog-lazy` }, sessionId),
    )
    const lazySnap = String(lazy.snapshot)
    assert.ok(
      lazySnap.includes('Hiring home') || lazySnap.includes('有新消息'),
      lazySnap,
    )
    const inboxRef = refNear(lazySnap, '有新消息')
    const opened = expectData(
      await run(clickTool, { ref: inboxRef }, sessionId),
    )
    const openedSnap = String(opened.snapshot)
    assert.ok(
      openedSnap.includes('8月') && openedSnap.includes('蒋先生'),
      `click must wait for the lazy dialog list:\n${openedSnap}`,
    )
    assert.ok(
      openedSnap.includes('我的沟通') && openedSnap.includes('Hiring home'),
      `post-click snapshot is the full page, including the dialog:\n${openedSnap.slice(0, 500)}`,
    )
    console.log('ok [playwright] click waits for lazy dialog content')

    const compact = expectData(
      await run(
        snapshotTool,
        { selector: '[role=dialog]', compact: true },
        sessionId,
      ),
    )
    const compactSnap = String(compact.snapshot)
    assert.ok(
      compactSnap.includes('8月') && compactSnap.includes('蒋先生'),
      `compact selector snapshot must not depth-clip the dialog list:\n${compactSnap}`,
    )
    console.log('ok [playwright] compact selector keeps the dialog subtree')

    const nested = expectData(
      await run(navigateTool, { url: `${server.url}dialog-nested` }, sessionId),
    )
    const listOpened = expectData(
      await run(
        clickTool,
        { ref: refNear(String(nested.snapshot), 'Open inbox') },
        sessionId,
      ),
    )
    const listSnap = String(listOpened.snapshot)
    assert.ok(
      listSnap.includes('Conversations') && listSnap.includes('Ada Reed'),
      `opening the list must show rows on the full page:\n${listSnap}`,
    )
    const threadOpened = expectData(
      await run(
        clickTool,
        { ref: refNear(listSnap, 'Ada Reed') },
        sessionId,
      ),
    )
    const threadSnap = String(threadOpened.snapshot)
    assert.ok(
      threadSnap.includes('Type a message') && threadSnap.includes('Send'),
      `clicking a row must keep the composer on the full-page snapshot, not only the list dialog:\n${threadSnap}`,
    )
    assert.ok(
      threadSnap.includes('Conversations') && threadSnap.includes('Inbox home'),
      `the list and page chrome must still be in the same snapshot:\n${threadSnap.slice(0, 400)}`,
    )
    console.log('ok [playwright] nested dialog click returns full page with composer')

    const waitNav = expectData(
      await run(navigateTool, { url: `${server.url}wait-text` }, sessionId),
    )
    const revealRef = refFor(String(waitNav.snapshot), 'button', 'Reveal')
    const afterReveal = expectData(
      await run(clickTool, { ref: revealRef }, sessionId),
    )
    assert.ok(
      !String(afterReveal.snapshot).includes('Message delivered'),
      `click settle must not wait out a 2s string:\n${afterReveal.snapshot}`,
    )
    const waited = expectData(
      await run(waitForTool, { text: 'Message delivered' }, sessionId),
    )
    assert.ok(
      String(waited.snapshot).includes('Message delivered'),
      `browser_wait_for must return once the text is visible:\n${waited.snapshot}`,
    )
    console.log('ok [playwright] browser_wait_for text')

    const formNav = expectData(
      await run(navigateTool, { url: `${server.url}form` }, sessionId),
    )
    const formSnap = String(formNav.snapshot)
    const filled = expectData(
      await run(
        fillFormTool,
        {
          fields: [
            { ref: refNear(formSnap, 'Merchant'), value: 'Suzhou Hotel' },
            { ref: refNear(formSnap, 'Total'), value: '100.00' },
            { ref: refNear(formSnap, 'Computed tax'), value: '9.99' },
            { ref: refNear(formSnap, 'Billable'), value: 'true' },
            { ref: refNear(formSnap, 'Currency'), value: 'USD' },
          ],
        },
        sessionId,
      ),
    )
    const message = String(filled.message)
    assert.ok(
      message.startsWith('Filled 4/5 fields'),
      `the readonly field must be the only one skipped:\n${message}`,
    )
    assert.ok(
      /Computed tax[^\n]*skipped: field is readonly/.test(message),
      `a readonly field must be reported, not silently dropped:\n${message}`,
    )
    const values = await run(
      evaluateTool,
      {
        expression: `[document.getElementById('merchant').value, document.getElementById('total').value, document.getElementById('tax').value, String(document.getElementById('billable').checked), document.getElementById('currency').value].join('|')`,
      },
      sessionId,
    )
    assert.equal(
      String(expectData(values).value),
      // The app's own change handler computed the tax, which is the point of
      // leaving a readonly field alone rather than writing through it.
      'Suzhou Hotel|100.00|6.00|true|usd',
      `fill_form must replace text, check the box and select the option:\n${message}`,
    )
    console.log('ok [playwright] fill_form writes a whole form and skips readonly')

    console.log('\nall playwright-engine tests passed')
  } finally {
    setBrowserBackendFactory(null)
    await closeBrowser()
    await server.close()
    fs.rmSync(profile, { recursive: true, force: true })
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
