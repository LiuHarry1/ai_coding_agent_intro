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
  getBrowser,
  getCurrentTabId,
  setBrowserBackendFactory,
} from '../browser/manager.js'
import { findInSnapshot } from '../browser/playwright/index.js'
import {
  clickTool,
  cdpTool,
  fileUploadTool,
  fillFormTool,
  handleDialogTool,
  navigateTool,
  selectOptionTool,
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

function yamlFromObserve(out: Record<string, unknown>): string {
  const artifact = out.snapshotArtifactPath
  if (typeof artifact === 'string' && artifact && fs.existsSync(artifact)) {
    return fs.readFileSync(artifact, 'utf8')
  }
  return String(out.snapshot ?? '')
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

    const wrongHint = await run(
      clickTool,
      { ref: counterRef, element: 'Delete Alice' },
      sessionId,
    )
    assert.ok(
      typeof wrongHint === 'string' && /does not match|snapshot/i.test(wrongHint),
      `element hint mismatch must fail:\n${wrongHint}`,
    )
    console.log('ok [playwright] element hint mismatch fails before click')

    const blockedFile = await run(
      navigateTool,
      { url: 'file:///C:/Windows/notepad.exe' },
      sessionId,
    )
    assert.ok(
      typeof blockedFile === 'string' && /file:/i.test(blockedFile),
      `file: navigate must be refused:\n${blockedFile}`,
    )
    console.log('ok [playwright] navigate refuses file: URLs')

    const found = await findInSnapshot(
      await getBrowser(process.cwd(), sessionId),
      getCurrentTabId(sessionId)!,
      'Clicked',
    )
    assert.ok(
      found.text.includes('Clicked'),
      `findInSnapshot must search the last snapshot:\n${found.text}`,
    )
    console.log('ok [playwright] findInSnapshot searches last snapshot')

    const applyRef = refFor(snapshot, 'button', 'Apply changes')
    await run(
      clickTool,
      { ref: refFor(snapshot, 'button', 'Rebuild apply') },
      sessionId,
    )
    const staleApply = await run(clickTool, { ref: applyRef }, sessionId)
    assert.ok(
      typeof staleApply === 'string',
      'stale ref after DOM rebuild must fail',
    )
    assert.ok(/snapshot|not found/i.test(staleApply), staleApply)
    const afterRebuild = String(
      expectData(await run(snapshotTool, {}, sessionId)).snapshot,
    )
    const newApplyRef = refFor(afterRebuild, 'button', 'Apply changes')
    const applied = expectData(
      await run(clickTool, { ref: newApplyRef }, sessionId),
    )
    assert.ok(
      /applied/i.test(String(applied.snapshot)) ||
        /applied/i.test(String(applied.message)),
      `fresh ref should click rebuilt Apply:\n${applied.message}\n${applied.snapshot}`,
    )
    console.log('ok [playwright] stale ref fails then fresh snapshot recovers')

    const diff = expectData(
      await run(snapshotTool, { includeDiff: true }, sessionId),
    )
    assert.ok(
      typeof diff.snapshot === 'string' && String(diff.snapshot).length > 0,
      `includeDiff must return a diff or an empty-change note:\n${diff.snapshot}`,
    )
    console.log('ok [playwright] snapshot includeDiff')

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
    const overflowSnap = yamlFromObserve(overflow)
    assert.ok(
      overflowSnap.includes('Chat dock'),
      `complete Playwright snapshot must keep the fixed dock:\n${overflowSnap.slice(-600)}`,
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
    console.log('ok [playwright] complete snapshot keeps end-of-tree chrome')
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

    const errorNav = expectData(
      await run(navigateTool, { url: `${server.url}error-modal` }, sessionId),
    )
    const saveRef = refFor(String(errorNav.snapshot), 'button', 'Save Expense')
    const afterSave = expectData(
      await run(clickTool, { ref: saveRef }, sessionId),
    )
    const errorSnap = String(afterSave.snapshot)
    assert.ok(
      /alertdialog/.test(errorSnap) &&
        errorSnap.includes('button "Yes"') &&
        errorSnap.includes('make corrections'),
      `Save must return the in-page Error Yes/No box, not a native dialog:\n${errorSnap}`,
    )
    assert.ok(
      /modal dialog is covering the page/i.test(errorSnap),
      `blocking alertdialog should replace the full-page tree:\n${errorSnap.slice(0, 400)}`,
    )
    console.log('ok [playwright] in-page Error modal is snapshotted as alertdialog')

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
    assert.ok(
      message.includes('Suzhou Hotel') && message.includes('100.00'),
      `fill_form must report written values:\n${message}`,
    )
    assert.ok(
      String(filled.snapshot).includes('6.00'),
      `readonly tax must still update from the app handler:\n${filled.snapshot}`,
    )
    console.log('ok [playwright] fill_form writes a whole form and skips readonly')

    const widgets = expectData(
      await run(navigateTool, { url: `${server.url}widgets` }, sessionId),
    )
    const widgetSnap = String(widgets.snapshot)
    const unarmed = await run(
      clickTool,
      { ref: refFor(widgetSnap, 'button', 'Confirm me') },
      sessionId,
    )
    assert.ok(
      typeof unarmed === 'string' && /handle_dialog|not armed/i.test(unarmed),
      `unarmed confirm must fail the click:\n${unarmed}`,
    )
    console.log('ok [playwright] unarmed confirm fails the click')
    const notASelect = await run(
      selectOptionTool,
      { ref: refNear(widgetSnap, 'Fruit'), values: ['Banana'] },
      sessionId,
    )
    assert.ok(
      typeof notASelect === 'string',
      `select_option is native <select> only:\n${notASelect}`,
    )
    await run(
      clickTool,
      { ref: refNear(widgetSnap, 'Fruit') },
      sessionId,
    )
    const openSnap = String(
      expectData(await run(snapshotTool, {}, sessionId)).snapshot,
    )
    const banana = expectData(
      await run(
        clickTool,
        { ref: refFor(openSnap, 'option', 'Banana') },
        sessionId,
      ),
    )
    assert.ok(
      String(banana.snapshot).includes('Banana') ||
        String(banana.message).includes('Banana'),
      `ARIA listbox options are clicked by ref:\n${banana.message}\n${banana.snapshot}`,
    )
    assert.match(
      String(banana.snapshot),
      /Banana/,
      `custom dropdown selection must update page state:\n${banana.snapshot}`,
    )
    console.log('ok [playwright] custom dropdown is snapshot + click, not select_option')

    const armed = expectData(
      await run(handleDialogTool, { accept: true }, sessionId),
    )
    assert.match(
      String(armed.message),
      /Next native dialog will be accepted/,
      `handle_dialog must arm the next confirm:\n${armed.message}`,
    )
    const afterFruit = String(
      expectData(await run(snapshotTool, {}, sessionId)).snapshot,
    )
    const asked = expectData(
      await run(
        clickTool,
        { ref: refFor(afterFruit, 'button', 'Confirm me') },
        sessionId,
      ),
    )
    assert.match(
      String(asked.message),
      /native confirm dialog/,
      `click that opened confirm must mention the dialog:\n${asked.message}`,
    )
    assert.match(
      String(asked.message),
      /accepted/,
      `armed confirm must be accepted:\n${asked.message}`,
    )
    assert.match(
      String(asked.snapshot),
      /accepted/,
      `native confirm must update page state:\n${asked.snapshot}`,
    )
    console.log('ok [playwright] handle_dialog accepts a native confirm')

    const uploadFile = path.join(profile, 'receipt.txt')
    fs.writeFileSync(uploadFile, 'invoice')
    const afterDialog = expectData(await run(snapshotTool, {}, sessionId))
    const uploaded = expectData(
      await run(
        fileUploadTool,
        {
          ref: refNear(String(afterDialog.snapshot), 'Receipt upload'),
          paths: [uploadFile],
        },
        sessionId,
      ),
    )
    assert.match(String(uploaded.message), /Uploaded 1 file/)
    assert.ok(
      String(uploaded.snapshot).includes('Receipt upload'),
      `file_upload must return a snapshot:\n${uploaded.snapshot}`,
    )
    assert.match(
      String(uploaded.snapshot),
      /receipt\.txt/,
      `uploaded file name must appear in page state:\n${uploaded.snapshot}`,
    )
    console.log('ok [playwright] file_upload sets an input type=file')

    const pdfNav = expectData(
      await run(navigateTool, { url: `${server.url}pdf-preview` }, sessionId),
    )
    const pdfSnap = String(pdfNav.snapshot)
    assert.ok(
      pdfSnap.includes('button "Save"') || pdfSnap.includes('Embedded frames omitted'),
      `a hung viewer iframe must not eat the host-page Save button:\n${pdfSnap.slice(0, 500)}`,
    )
    console.log('ok [playwright] hung iframe snapshot still returns the host page')

    expectData(await run(navigateTool, { url: `${server.url}widgets` }, sessionId))
    const interactive = expectData(
      await run(snapshotTool, { interactive: true }, sessionId),
    )
    const interactiveSnap = String(interactive.snapshot)
    assert.ok(
      interactiveSnap.includes('Confirm me') && interactiveSnap.includes('[ref='),
      `interactive snapshot must keep the controls:\n${interactiveSnap}`,
    )
    console.log('ok [playwright] snapshot interactive keeps refs only')

    expectData(
      await run(navigateTool, { url: `${server.url}itemization` }, sessionId),
    )
    const filledRate = expectData(
      await run(
        cdpTool,
        {
          method: 'Runtime.evaluate',
          params: {
            expression: `(() => {
              const label = [...document.querySelectorAll('span')]
                .find(el => (el.textContent || '').trim() === 'Room Rate');
              const input = label && label.nextElementSibling;
              if (!(input instanceof HTMLInputElement)) return { ok: false };
              const setter = Object.getOwnPropertyDescriptor(
                window.HTMLInputElement.prototype, 'value'
              ).set;
              setter.call(input, '188.00');
              input.dispatchEvent(new Event('input', { bubbles: true }));
              return {
                ok: true,
                value: input.value,
                echoed: document.getElementById('out').textContent,
              };
            })()`,
            returnByValue: true,
          },
        },
        sessionId,
      ),
    )
    const rate = JSON.stringify(filledRate.value)
    assert.ok(
      /188\.00/.test(rate) && /"ok":true/.test(rate.replace(/\s/g, '')),
      `evaluate must set Room Rate by visible label:\n${rate}`,
    )
    console.log('ok [playwright] browser_cdp evaluate fills an unlabeled field')

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
