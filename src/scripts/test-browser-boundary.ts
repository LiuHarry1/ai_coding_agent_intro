/**
 * Boundary test for the injected console/network path — no Chrome required.
 *
 * Snapshot/click/type go through Playwright and need a real page. This file
 * locks the remaining CDP surface: the page script is installed over
 * Runtime.evaluate, and reading console/network adds no extra CDP methods.
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
import type { BrowserBackend } from '../browser/types.js'
import {
  cdpTool,
  clickTool,
  consoleTool,
  lockTool,
  networkTool,
  tabsTool,
} from '../tools/BrowserTool/BrowserTool.js'
import type {
  AnyTool,
  DualChannelToolResult,
  ToolContext,
  ToolDefinition,
} from '../core/types.js'

/**
 * CDP methods the inject path is allowed to use. Growing this is a
 * deliberate decision rather than something that happens by accident.
 */
const ALLOWED_CDP_METHODS = new Set([
  'Page.enable',
  'Runtime.enable',
  'Page.addScriptToEvaluateOnNewDocument',
  'Runtime.evaluate',
])

interface FakeState {
  calls: Array<{ method: string; params?: Record<string, unknown> }>
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
        const expr = String(params?.expression ?? '')
        if (expr === '1+1') {
          return { result: { type: 'number', value: 2 } } as never
        }
        if (expr === 'huge') {
          return {
            result: { type: 'string', value: 'x'.repeat(26_000) },
          } as never
        }
        return {
          result: { type: 'object', value: evaluate(String(params?.expression)) },
        } as never
      }
      if (method === 'DOM.getDocument') {
        return { root: { nodeId: 1 } } as never
      }
      return {} as never
    },
    async getActiveUserTabId() {
      return null
    },
    async focusTab() {},
    async restoreTab() {},
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
  const state: FakeState = {
    calls: [],
    consoleEntries: [],
    networkEntries: [],
    url: 'http://localhost:5173/',
  }

  setBrowserBackendFactory(async () => createFakeBackend(state))

  state.consoleEntries.push({
    level: 'error',
    text: 'TypeError: cannot read property x of undefined',
    at: Date.now() + 1000,
  })
  const logs = expectData(await run(consoleTool, { level: 'error' }))
  assert.equal((logs.consoleErrors as unknown[]).length, 1)
  assert.equal(logs.snapshot, undefined, 'console tool should not pay for a snapshot')
  assert.ok(
    state.calls.some(c => c.method === 'Page.addScriptToEvaluateOnNewDocument'),
    'script must be registered so console capture survives reload',
  )
  console.log('ok console tool')

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
  const net = expectData(await run(networkTool, {}))
  assert.equal((net.network as unknown[]).length, 1)
  assert.equal(net.snapshot, undefined, 'network tool should not pay for a snapshot')
  const usedSince = state.calls.slice(before).map(c => c.method)
  assert.ok(
    usedSince.every(m => m === 'Runtime.evaluate' || ALLOWED_CDP_METHODS.has(m)),
    `network reading introduced new CDP methods: ${usedSince.join(', ')}`,
  )
  console.log('ok network tool adds no new CDP methods')

  const unlocked = expectData(await run(lockTool, { action: 'unlock' }))
  assert.match(String(unlocked.message), /User has control/)
  const clickBlocked = await run(clickTool, { ref: 'e1' })
  assert.ok(
    typeof clickBlocked === 'string' && /user has control/i.test(clickBlocked),
    `click while user has control must fail:\n${clickBlocked}`,
  )
  expectData(await run(tabsTool, { action: 'list' }))
  const relocked = expectData(await run(lockTool, { action: 'lock' }))
  assert.match(String(relocked.message), /Agent has control/)
  console.log('ok browser_lock handoff')

  const tabs = expectData(await run(tabsTool, { action: 'list' }))
  const tabList = tabs.tabs as Array<{ targetId: string; current: boolean }>
  assert.equal(tabList.length, 1)
  assert.equal(tabList[0].targetId, 'tab-1')
  console.log('ok tabs')

  const used = new Set(state.calls.map(c => c.method))
  for (const method of used) {
    assert.ok(
      ALLOWED_CDP_METHODS.has(method),
      `tool layer used CDP method "${method}" outside the inject-path set`,
    )
  }
  console.log(`ok CDP surface (${used.size} methods, inject path only)`)

  const evaled = expectData(
    await run(cdpTool, {
      method: 'Runtime.evaluate',
      params: { expression: '1+1', returnByValue: true },
    }),
  )
  assert.match(String(evaled.message), /Runtime\.evaluate/)
  assert.equal(
    JSON.stringify(evaled.value),
    JSON.stringify({ result: { type: 'number', value: 2 } }),
  )
  console.log('ok browser_cdp Runtime.evaluate')

  const blockedInput = await run(cdpTool, {
    method: 'Input.dispatchMouseEvent',
    params: { type: 'mousePressed', x: 1, y: 1 },
  })
  assert.ok(
    typeof blockedInput === 'string' && /Input\.\*/.test(blockedInput),
    `Input.* must be denied:\n${blockedInput}`,
  )
  console.log('ok browser_cdp denies Input.*')

  const cookie = await run(cdpTool, { method: 'Network.getCookies' })
  assert.ok(
    typeof cookie === 'string' && /not allowed/.test(cookie),
    `cookies must be denied:\n${cookie}`,
  )
  console.log('ok browser_cdp denies cookie commands')

  expectData(await run(lockTool, { action: 'unlock' }))
  const cdpBlocked = await run(cdpTool, {
    method: 'Runtime.evaluate',
    params: { expression: '1+1' },
  })
  assert.ok(
    typeof cdpBlocked === 'string' && /user has control/i.test(cdpBlocked),
    `cdp while user has control must fail:\n${cdpBlocked}`,
  )
  expectData(await run(lockTool, { action: 'lock' }))
  console.log('ok browser_cdp blocked while user has control')

  const browserDir = path.resolve('src/browser')
  const importsPlaywright = (full: string) =>
    /(?:from|import|require\()\s*['"]playwright/.test(
      fs.readFileSync(full, 'utf8'),
    )
  const offenders: string[] = []
  const allowsPlaywright = (full: string) => {
    const rel = path.relative(browserDir, full)
    if (rel === path.join('backends', 'isolated.ts')) return true
    return rel === 'playwright' || rel.startsWith(`playwright${path.sep}`)
  }
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else if (entry.name.endsWith('.ts')) {
        if (importsPlaywright(full) && !allowsPlaywright(full)) {
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
    'playwright-core may be imported from backends/isolated.ts and src/browser/playwright/',
  )
  console.log('ok playwright confined to isolated launch + playwright/')

  /**
   * The allowlist above is a directory, so it is only as tight as what we keep
   * out of it: it once waved through ~1000 lines that never touched a Page. Both
   * of these are deliberately Playwright-free, and reaching for a Page in either
   * means the code belongs in `playwright/` instead.
   */
  for (const rel of [
    'distill-snapshot.ts',
    'session-flags.ts',
    'snapshot-index.ts',
    'navigate-policy.ts',
    path.join('relay', 'cdp-endpoint.ts'),
  ]) {
    assert.ok(
      !importsPlaywright(path.join(browserDir, rel)),
      `${rel} must stay Playwright-free; move the code into playwright/ instead`,
    )
  }
  console.log('ok pure snapshot text and the relay CDP endpoint stay Playwright-free')

  setBrowserBackendFactory(null)
  await closeBrowser()
  console.log('\nall browser boundary tests passed')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
