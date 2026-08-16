/**
 * Boundary test for the browser tools — no Chrome required.
 *
 * The point is phase 2: the extension relay will implement `BrowserBackend` by
 * forwarding `chrome.debugger.sendCommand`, so it can only work if the tool
 * layer speaks nothing but CDP commands. This drives the whole tool surface
 * against a fake backend and fails if that stops being true.
 *
 * Run: npx tsx src/scripts/test-browser-boundary.ts
 */
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  closeBrowser,
  setBrowserBackendFactory,
} from '../browser/manager.js'
import { setBrowserEngine, unlockBrowserEngine } from '../browser/engine.js'
import type { BrowserBackend } from '../browser/types.js'
import {
  clickTool,
  consoleTool,
  navigateTool,
  networkTool,
  screenshotTool,
  snapshotTool,
  tabsTool,
  typeTool,
} from '../tools/BrowserTool/BrowserTool.js'
import type {
  AnyTool,
  DualChannelToolResult,
  ToolContext,
  ToolDefinition,
  ToolResultContentBlockParam,
} from '../core/types.js'
import { toolResultBlocksToText } from '../utils/tool-result-content.js'

const ONE_PX_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

/**
 * Every CDP method the tools are allowed to use. The phase-2 relay has to
 * support exactly this list, so growing it is a deliberate decision rather
 * than something that happens by accident.
 */
const ALLOWED_CDP_METHODS = new Set([
  'Page.enable',
  'Runtime.enable',
  'Page.addScriptToEvaluateOnNewDocument',
  'Runtime.evaluate',
  'Page.navigate',
  'Page.getNavigationHistory',
  'Page.navigateToHistoryEntry',
  'Page.captureScreenshot',
  // Required before input: Chrome drops Input.* aimed at a hidden tab.
  'Page.bringToFront',
  'Input.dispatchMouseEvent',
  'Input.dispatchKeyEvent',
  'Input.insertText',
  'Target.getTargetInfo',
])

interface FakeState {
  calls: Array<{ method: string; params?: Record<string, unknown> }>
  refs: Record<
    string,
    {
      role: string
      name: string
      editable?: boolean
      blockingType?: string
      interceptedBy?: string
    }
  >
  staleRefs: Set<string>
  consoleEntries: Array<{ level: string; text: string; at: number }>
  networkEntries: Array<{
    id: number
    kind: string
    method: string
    url: string
    status: number
    statusText: string
    ok: boolean
    pending: boolean
    failed: boolean
    error: string
    startedAt: number
    durationMs: number
  }>
  url: string
}

function createFakeBackend(state: FakeState): BrowserBackend {
  function evaluate(expression: string): unknown {
    if (expression.includes('__agentBrowser.version')) return true
    if (expression.includes('document.visibilityState')) return 'visible'

    if (expression.startsWith('window.__agentBrowser.snapshot(')) {
      return {
        url: state.url,
        title: 'Fake Page',
        text: '- heading "Fake Page" [level=1]\n- button "Save" [ref=e1]\n- textbox "Email" [ref=e2]',
        nodes: 3,
        truncated: false,
      }
    }

    if (expression.startsWith('window.__agentBrowser.waitStable(')) {
      return { reason: 'quiet', waitedMs: 1, readyState: 'complete' }
    }

    if (expression.startsWith('window.__agentBrowser.consoleLogs(')) {
      const level = /"level":"(\w+)"/.exec(expression)?.[1]
      const entries = level
        ? state.consoleEntries.filter(e => e.level === level)
        : state.consoleEntries
      return { entries, total: entries.length, now: Date.now() }
    }

    if (expression.startsWith('window.__agentBrowser.networkRequests(')) {
      const failedOnly = expression.includes('"failedOnly":true')
      const entries = failedOnly
        ? state.networkEntries.filter(e => e.failed || e.status >= 400)
        : state.networkEntries
      return { entries, total: entries.length, now: Date.now() }
    }

    if (expression.startsWith('window.__agentBrowser.sinceReport(')) {
      return {
        logs: state.consoleEntries.filter(e => e.level === 'error'),
        network: state.networkEntries.filter(e => e.failed || e.status >= 400),
        now: Date.now(),
      }
    }

    if (expression.startsWith('window.__agentBrowser.resolveRef(')) {
      const ref = /resolveRef\("([^"]+)"/.exec(expression)?.[1] ?? ''
      if (state.staleRefs.has(ref)) {
        return {
          error: 'stale',
          message: `Ref ${ref} now points at link "Something else" but you targeted button "Save". The page changed; take a fresh snapshot.`,
        }
      }
      const meta = state.refs[ref]
      if (!meta) {
        return { error: 'unknown', message: `No element for ref ${ref}. Take a fresh snapshot.` }
      }
      return {
        ok: true,
        ref,
        role: meta.role,
        name: meta.name,
        x: 100,
        y: 200,
        pageX: 100,
        pageY: 250,
        width: 80,
        height: 30,
        tag: meta.editable ? 'input' : 'button',
        isEditable: meta.editable === true,
        ...(meta.blockingType
          ? { blockingType: meta.blockingType, interceptedBy: meta.interceptedBy }
          : {}),
      }
    }

    return null
  }

  return {
    kind: 'isolated',
    async listTabs() {
      return [{ targetId: 'tab-1', url: state.url, title: 'Fake Page' }]
    },
    async createTab(url) {
      if (url) state.url = url
      return { targetId: 'tab-1', url: state.url, title: 'Fake Page' }
    },
    async closeTab() {},
    async send(_targetId, method, params) {
      state.calls.push({ method, params })
      if (method === 'Runtime.evaluate') {
        return {
          result: { type: 'object', value: evaluate(String(params?.expression)) },
        } as never
      }
      if (method === 'Page.captureScreenshot') {
        return { data: ONE_PX_PNG } as never
      }
      if (method === 'Page.navigate') {
        return {} as never
      }
      return {} as never
    },
    async dispose() {},
  }
}

function fakeContext(): ToolContext {
  return {
    eventBus: { emit() {}, on() {}, off() {} } as unknown as ToolContext['eventBus'],
    wire: { emit() {} } as unknown as ToolContext['wire'],
    cwd: process.cwd(),
  }
}

async function run(
  def: ToolDefinition,
  args: Record<string, unknown>,
  toolCallId = 'call-1',
): Promise<DualChannelToolResult<Record<string, unknown>> | string> {
  const instance = def.create(process.cwd(), fakeContext()) as AnyTool & {
    execute: (
      a: unknown,
      o: { toolCallId: string },
    ) => Promise<DualChannelToolResult<Record<string, unknown>> | string>
  }
  return instance.execute(args, { toolCallId })
}

function mappedText(content: string | ToolResultContentBlockParam[]): string {
  return typeof content === 'string' ? content : toolResultBlocksToText(content)
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

async function main() {
  setBrowserEngine('cdp', true)
  const state: FakeState = {
    calls: [],
    refs: {
      e1: { role: 'button', name: 'Save' },
      e2: { role: 'textbox', name: 'Email', editable: true },
      e3: {
        role: 'button',
        name: 'Confirm',
        blockingType: 'modal',
        interceptedBy: 'div.cookie-overlay "We use cookies"',
      },
    },
    staleRefs: new Set(['e9']),
    consoleEntries: [],
    networkEntries: [],
    url: 'http://localhost:5173/',
  }

  setBrowserBackendFactory(async () => createFakeBackend(state))

  // ── navigate ──────────────────────────────────────────
  const nav = expectData(
    await run(navigateTool, { url: 'http://localhost:5173/' }),
  )
  assert.equal(nav.action, 'navigate')
  assert.ok(String(nav.snapshot).includes('button "Save" [ref=e1]'))
  assert.ok(
    state.calls.some(c => c.method === 'Page.addScriptToEvaluateOnNewDocument'),
    'script must be registered before navigating so console capture survives reload',
  )
  console.log('ok navigate')

  // ── snapshot ──────────────────────────────────────────
  const snap = expectData(await run(snapshotTool, {}))
  assert.equal(snap.title, 'Fake Page')
  assert.ok(String(snap.snapshot).includes('textbox "Email"'))
  console.log('ok snapshot')

  // ── click dispatches trusted input at the resolved point ──
  state.calls.length = 0
  const click = expectData(await run(clickTool, { ref: 'e1' }))
  assert.equal(click.message, 'Clicked button "Save"')
  const mouse = state.calls.filter(c => c.method === 'Input.dispatchMouseEvent')
  assert.ok(
    mouse.some(c => c.params?.type === 'mousePressed' && c.params?.x === 100),
    'click must dispatch a real mouse press at the element centre',
  )
  console.log('ok click')

  // Chrome discards input aimed at a hidden tab, and activating it reflows the
  // viewport, so the order here is the whole fix: activate, then measure.
  const activateAt = state.calls.findIndex(c => c.method === 'Page.bringToFront')
  const measureAt = state.calls.findIndex(c =>
    String(c.params?.expression).startsWith('window.__agentBrowser.resolveRef('),
  )
  assert.ok(activateAt >= 0, 'click must bring the tab to front before input')
  assert.ok(
    activateAt < measureAt,
    'the tab must be activated before coordinates are measured',
  )
  console.log('ok click activates the tab before measuring')

  // ── a click blocked by an overlay is refused, not dispatched ──
  state.calls.length = 0
  const blocked = await run(clickTool, { ref: 'e3' })
  assert.ok(typeof blocked === 'string', 'occluded click must come back as text')
  assert.ok(blocked.startsWith('Error:'))
  assert.ok(blocked.includes('modal'), 'error must name the kind of blocker')
  assert.ok(
    blocked.includes('cookie-overlay'),
    'error must name the specific blocking element',
  )
  assert.ok(
    !state.calls.some(
      c => c.method === 'Input.dispatchMouseEvent' && c.params?.type === 'mousePressed',
    ),
    'a blocked click must not dispatch a real press',
  )
  console.log('ok occluded click is refused before dispatch')

  // ── type ──────────────────────────────────────────────
  state.calls.length = 0
  const typed = expectData(
    await run(typeTool, { ref: 'e2', text: 'a@b.com', submit: true }),
  )
  assert.equal(typed.message, 'Typed into textbox "Email" and pressed Enter')
  assert.ok(state.calls.some(c => c.method === 'Input.insertText'))
  assert.ok(
    state.calls.some(
      c => c.method === 'Input.dispatchKeyEvent' && c.params?.key === 'Enter',
    ),
  )
  console.log('ok type')

  // ── typing into a non-editable ref is refused, not attempted ──
  const wrongTarget = await run(typeTool, { ref: 'e1', text: 'x' })
  assert.ok(typeof wrongTarget === 'string' && wrongTarget.startsWith('Error:'))
  assert.ok(wrongTarget.includes('browser_click'), 'error must name the way out')
  console.log('ok type rejects non-editable ref')

  // ── stale ref comes back as recoverable text, not a throw ──
  const stale = await run(clickTool, { ref: 'e9' })
  assert.ok(typeof stale === 'string', 'stale ref must not throw')
  assert.ok(stale.startsWith('Error:'))
  assert.ok(
    stale.includes('fresh snapshot'),
    'stale ref message must tell the model to re-snapshot',
  )
  console.log('ok stale ref')

  // ── console errors ride along with the action that caused them ──
  state.consoleEntries.push({
    level: 'error',
    text: 'TypeError: cannot read property x of undefined',
    at: Date.now() + 1000,
  })
  const afterError = expectData(await run(clickTool, { ref: 'e1' }))
  const errors = afterError.consoleErrors as Array<{ text: string }>
  assert.equal(errors?.length, 1)
  assert.ok(errors[0].text.includes('TypeError'))
  console.log('ok console errors surface on the causing action')

  const logs = expectData(await run(consoleTool, { level: 'error' }))
  assert.equal((logs.consoleErrors as unknown[]).length, 1)
  assert.equal(logs.snapshot, undefined, 'console tool should not pay for a snapshot')
  console.log('ok console tool')

  // ── network rides the same evaluate channel ───────────
  const before = state.calls.length
  state.networkEntries.push({
    id: 1,
    kind: 'fetch',
    method: 'POST',
    url: 'http://localhost:5173/api/checkout',
    status: 500,
    statusText: 'Internal Server Error',
    ok: false,
    pending: false,
    failed: false,
    error: '',
    startedAt: Date.now(),
    durationMs: 42,
  })
  const afterBadRequest = expectData(await run(clickTool, { ref: 'e1' }))
  const caused = afterBadRequest.network as Array<{ status: number }>
  assert.equal(caused?.length, 1)
  assert.equal(caused[0].status, 500)
  console.log('ok failed requests surface on the causing action')

  const net = expectData(await run(networkTool, {}))
  assert.equal((net.network as unknown[]).length, 1)
  assert.equal(net.snapshot, undefined, 'network tool should not pay for a snapshot')
  // The point of the whole exercise: reading the network added no CDP surface,
  // so the relay needs no new capability to support it.
  const usedSince = state.calls.slice(before).map(c => c.method)
  assert.ok(
    usedSince.every(m => m === 'Runtime.evaluate' || ALLOWED_CDP_METHODS.has(m)),
    `network reading introduced new CDP methods: ${usedSince.join(', ')}`,
  )
  console.log('ok network tool adds no new CDP methods')

  // ── tabs ──────────────────────────────────────────────
  const tabs = expectData(await run(tabsTool, { action: 'list' }))
  const tabList = tabs.tabs as Array<{ targetId: string; current: boolean }>
  assert.equal(tabList.length, 1)
  assert.equal(tabList[0].targetId, 'tab-1')
  console.log('ok tabs')

  // ── screenshot: model gets an image block, UI copy gets a path ──
  const shot = expectData(await run(screenshotTool, {}, 'call-shot'))
  assert.ok(shot.screenshotBase64, 'model-facing payload must carry the image')

  const mapped = screenshotTool.mapToolResultToToolResultBlockParam!(
    shot,
    'call-shot',
  )
  assert.ok(Array.isArray(mapped.content), 'screenshot must map to content blocks')
  const blocks = mapped.content as ToolResultContentBlockParam[]
  assert.equal(blocks.filter(b => b.type === 'image').length, 1)
  assert.ok(mappedText(mapped.content).includes('Screenshot of viewport'))

  const parsed = screenshotTool.outputSchema!.safeParse(shot)
  assert.equal(parsed.success, true)
  assert.equal(
    (parsed.data as Record<string, unknown>).screenshotBase64,
    undefined,
    'outputSchema must strip base64 so it never reaches the wire or session jsonl',
  )
  console.log('ok screenshot dual channel')

  // ── the backend only ever saw CDP commands ────────────
  const used = new Set(state.calls.map(c => c.method))
  for (const method of used) {
    assert.ok(
      ALLOWED_CDP_METHODS.has(method),
      `tool layer used CDP method "${method}" outside the relay-supported set`,
    )
  }
  console.log(`ok CDP surface (${used.size} methods, all relay-supported)`)

  // ── playwright lives in isolated launch + the pw/ engine ──
  const browserDir = path.resolve('src/browser')
  const offenders: string[] = []
  const allowsPlaywright = (full: string) => {
    const rel = path.relative(browserDir, full)
    if (rel === path.join('backends', 'isolated.ts')) return true
    if (rel.startsWith(`pw${path.sep}`) || rel.startsWith('pw/')) return true
    return false
  }
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else if (entry.name.endsWith('.ts')) {
        const imports = /(?:from|import|require\()\s*['"]playwright/.test(
          fs.readFileSync(full, 'utf8'),
        )
        if (imports && !allowsPlaywright(full)) {
          offenders.push(full)
        }
      }
    }
  }
  walk(browserDir)
  walk(path.resolve('src/tools/BrowserTool'))
  assert.deepEqual(
    offenders,
    [],
    'playwright-core may be imported from backends/isolated.ts and src/browser/pw/',
  )
  console.log('ok playwright confined to isolated launch + pw/ engine')

  setBrowserBackendFactory(null)
  unlockBrowserEngine()
  await closeBrowser()
  console.log('\nall browser boundary tests passed')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
