/**
 * Unit checks for the browser stack — no Chrome, no page, ~1s to run.
 *
 * The other three browser suites all need a real browser, which makes them slow
 * and makes a failure ambiguous: was it the protocol, the tool layer, or the
 * page? These cover the parts that are pure logic, so a break points straight at
 * the cause.
 *
 *   npx tsx src/scripts/test-browser-unit.ts
 */
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { WebSocket } from 'ws'
import { createExtensionBackend } from '../browser/backends/extension.js'
import {
  isRelayCdpEvent,
  isRelayHello,
  isRelayResponse,
  type RelayRequestBody,
} from '../browser/relay/protocol.js'
import {
  getPairingToken,
  startRelayServer,
  type RelayServer,
} from '../browser/relay/server.js'
import {
  resetSettingsCache,
  resolveSettings,
} from '../core/settings-manager.js'
import {
  BrowserOutputSchema,
  browserErrorText,
  mapBrowserOutput,
  type BrowserToolOutput,
} from '../tools/BrowserTool/shared.js'
import { PAGE_SCRIPT, PAGE_SCRIPT_VERSION } from '../browser/page-script.js'
import { BrowserError } from '../browser/types.js'
import { normalizeRef } from '../browser/playwright/index.js'
import {
  countRefs,
  groupBadgeLabels,
  prioritizeAriaSnapshot,
} from '../browser/distill-snapshot.js'
import {
  pickPageForTab,
  urlsRoughlyEqual,
} from '../browser/playwright/page-match.js'
import { initBrowserLifecycle } from '../browser/manager.js'

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`FAILED: ${msg}`)
}

function eq<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) {
    throw new Error(
      `FAILED: ${msg}\n  expected: ${expected}\n  actual:   ${actual}`,
    )
  }
}

const ok = (msg: string) => console.log(`ok ${msg}`)

// ── injected page script: console + network, nothing else ─

{
  eq(PAGE_SCRIPT_VERSION, 11, 'page script bump')
  assert(
    PAGE_SCRIPT.includes(`var VERSION = ${PAGE_SCRIPT_VERSION}`),
    'injected VERSION must match PAGE_SCRIPT_VERSION or pages keep the old script',
  )

  for (const entry of ['consoleLogs', 'networkRequests', 'sinceReport']) {
    assert(PAGE_SCRIPT.includes(entry), `page script must expose ${entry}`)
  }
  assert(PAGE_SCRIPT.includes('window.fetch'), 'fetch is patched')
  assert(PAGE_SCRIPT.includes('XMLHttpRequest'), 'xhr is patched')
  assert(
    PAGE_SCRIPT.includes('unhandledrejection'),
    'uncaught rejections reach the console buffer',
  )

  // Snapshot, ref resolution and input all live in Playwright now. Any of this
  // reappearing in the page means we are back to two engines that disagree.
  for (const gone of [
    'resolveRef',
    'setValue',
    'setChecked',
    'selectOption',
    'waitStable',
    'NAME_FROM_CONTENT',
    'isPointerLabelGroup',
    'collectOverlayClickables',
    'elementFromPoint',
  ]) {
    assert(
      !PAGE_SCRIPT.includes(gone),
      `the injected script must not grow a second engine: found ${gone}`,
    )
  }
  ok('injected script v11 is the console/network buffer and nothing more')
}

// ── protocol guards ──────────────────────────────────────

{
  assert(
    isRelayResponse({ id: 1, ok: true, result: {} }),
    'success is a response',
  )
  assert(
    isRelayResponse({ id: 1, ok: false, error: 'x' }),
    'failure is a response',
  )
  assert(!isRelayResponse({ id: 'a', ok: true }), 'id must be a number')
  assert(!isRelayResponse({ id: 1 }), 'ok is required')
  assert(!isRelayResponse(null), 'null is not a response')
  assert(!isRelayResponse('{"id":1,"ok":true}'), 'a string is not a response')

  assert(isRelayHello({ type: 'hello', token: 't', version: 1 }), 'hello')
  assert(!isRelayHello({ type: 'welcome' }), 'welcome is not hello')
  assert(!isRelayHello(undefined), 'undefined is not hello')
  assert(
    isRelayCdpEvent({
      type: 'cdpEvent',
      targetId: '1',
      method: 'Runtime.executionContextCreated',
      params: {},
    }),
    'cdpEvent is an unsolicited frame',
  )
  assert(
    !isRelayCdpEvent({ type: 'cdpEvent', method: 'x' }),
    'cdpEvent requires targetId',
  )
  ok('protocol guards reject malformed frames')
}

// ── pairing token ────────────────────────────────────────

{
  const first = getPairingToken()
  const second = getPairingToken()
  eq(second, first, 'token must be stable so pairing survives restarts')
  assert(first.length >= 16, 'token must be long enough to not be guessable')

  const file = path.join(os.homedir(), '.ai-agent', 'browser', 'relay.json')
  // NTFS has no POSIX mode bits — Node reports 0666 there whatever we chmod.
  if (fs.existsSync(file) && process.platform !== 'win32') {
    const mode = fs.statSync(file).mode & 0o777
    eq(mode, 0o600, 'the token file must not be readable by other users')
  }
  ok('pairing token is stable and stored 0600')
}

// ── relay harness ────────────────────────────────────────

/** A client that speaks the protocol but answers with canned results. */
interface FakePeer {
  socket: WebSocket
  seen: RelayRequestBody[]
  /** Set to reply with an error instead of a result. */
  failWith?: string
  /** Set to never answer, to exercise timeouts and drops. */
  silent?: boolean
  close: () => Promise<void>
}

async function connectPeer(
  relay: RelayServer,
  opts: { token?: string; delayMs?: number } = {},
): Promise<FakePeer> {
  const socket = new WebSocket(`ws://127.0.0.1:${relay.port}`)
  const peer: FakePeer = {
    socket,
    seen: [],
    close: () =>
      new Promise<void>(resolve => {
        if (socket.readyState === WebSocket.CLOSED) return resolve()
        socket.once('close', () => resolve())
        socket.close()
      }),
  }

  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => {
      socket.send(
        JSON.stringify({
          type: 'hello',
          token: opts.token ?? relay.token,
          version: 1,
          browser: 'FakePeer/1.0',
        }),
      )
    })
    socket.once('error', reject)
    socket.on('message', function onMsg(raw) {
      const msg = JSON.parse(String(raw))
      if (msg.type !== 'welcome') return
      socket.off('message', onMsg)
      resolve()
    })
  })

  socket.on('message', async raw => {
    const msg = JSON.parse(String(raw))
    if (typeof msg.id !== 'number') return
    peer.seen.push(msg)
    if (peer.silent) return
    if (opts.delayMs) await new Promise(r => setTimeout(r, opts.delayMs))
    socket.send(
      JSON.stringify(
        peer.failWith
          ? { id: msg.id, ok: false, error: peer.failWith }
          : { id: msg.id, ok: true, result: { echo: msg.method } },
      ),
    )
  })

  return peer
}

/** Raw connection that never completes the handshake, to test rejection. */
function expectRejected(
  port: number,
  firstFrame: string | undefined,
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`)
    socket.once('open', () => {
      if (firstFrame !== undefined) socket.send(firstFrame)
    })
    socket.once('close', code => resolve(code))
    socket.once('error', reject)
  })
}

async function withRelay(
  fn: (relay: RelayServer) => Promise<void>,
): Promise<void> {
  const relay = await startRelayServer({ port: 0 })
  try {
    await fn(relay)
  } finally {
    await relay.close()
  }
}

// ── relay: bound port ────────────────────────────────────

await withRelay(async relay => {
  assert(relay.port > 0, 'relay must report the port it actually bound')
  eq(relay.isConnected(), false, 'no peer yet')
  eq(relay.peerName(), undefined, 'no peer name yet')
  ok('relay reports its real bound port')
})

// ── relay: handshake ─────────────────────────────────────

await withRelay(async relay => {
  eq(
    await expectRejected(
      relay.port,
      JSON.stringify({
        type: 'hello',
        token: 'wrong',
        version: 1,
      }),
    ),
    1008,
    'a wrong token must be rejected',
  )

  eq(
    await expectRejected(relay.port, 'not json at all'),
    1003,
    'malformed json must be rejected',
  )

  eq(
    await expectRejected(
      relay.port,
      JSON.stringify({ id: 1, ok: true, result: {} }),
    ),
    1008,
    'a response before the handshake must be rejected',
  )

  eq(relay.isConnected(), false, 'rejected clients must not count as connected')
  ok('relay rejects wrong tokens, junk, and skipped handshakes')
})

// ── relay: happy path + correlation ──────────────────────

await withRelay(async relay => {
  const peer = await connectPeer(relay, { delayMs: 15 })
  eq(relay.isConnected(), true, 'peer connected')
  assert(
    /FakePeer/.test(String(relay.peerName())),
    'peer name comes from hello',
  )

  // Concurrent, deliberately answered out of order by the delay.
  const [a, b, c] = await Promise.all([
    relay.request<{ echo: string }>({ method: 'tabs.list' }),
    relay.request<{ echo: string }>({ method: 'tabs.create', url: 'x' }),
    relay.request<{ echo: string }>({
      method: 'cdp',
      targetId: '1',
      cdpMethod: 'Runtime.evaluate',
    }),
  ])
  eq(a.echo, 'tabs.list', 'reply a matched its request')
  eq(b.echo, 'tabs.create', 'reply b matched its request')
  eq(c.echo, 'cdp', 'reply c matched its request')
  eq(peer.seen.length, 3, 'peer saw three requests')

  // Ids must be distinct, or replies could cross.
  const ids = new Set(peer.seen.map(r => (r as unknown as { id: number }).id))
  eq(ids.size, 3, 'each request gets its own id')

  // A stray reply for an unknown id must not throw.
  peer.socket.send(JSON.stringify({ id: 9999, ok: true, result: {} }))
  await new Promise(r => setTimeout(r, 50))
  eq(relay.isConnected(), true, 'a stray reply must not kill the connection')

  await peer.close()
  ok('relay correlates concurrent requests and ignores stray replies')
})

// ── relay: error propagation ─────────────────────────────

await withRelay(async relay => {
  const peer = await connectPeer(relay)
  peer.failWith = 'Tab 7 is not shared with the agent.'
  const err = await relay
    .request({ method: 'cdp', targetId: '7', cdpMethod: 'Runtime.evaluate' })
    .then(() => null)
    .catch((e: Error) => e)
  assert(err instanceof BrowserError, 'peer errors arrive as BrowserError')
  eq(
    err.message,
    'Tab 7 is not shared with the agent.',
    'message preserved verbatim',
  )
  await peer.close()
  ok('relay propagates peer errors without mangling them')
})

// ── relay: not connected ─────────────────────────────────

await withRelay(async relay => {
  const err = await relay
    .request({ method: 'tabs.list' })
    .then(() => 'resolved')
    .catch((e: Error) => e.message)
  const msg = String(err)
  assert(msg.includes(String(relay.port)), 'error names the port')
  assert(msg.includes('chrome-extension/README.md'), 'error says how to pair')
  assert(msg.includes('"isolated"'), 'error offers the fallback')
  ok('requesting with no peer explains both ways out')
})

// ── relay: a drop fails pending work ─────────────────────

await withRelay(async relay => {
  const peer = await connectPeer(relay)
  peer.silent = true
  const pending = relay.request({ method: 'tabs.list' })
  await new Promise(r => setTimeout(r, 30))
  await peer.close()

  const err = await pending
    .then(() => 'resolved')
    .catch((e: Error) => e.message)
  assert(
    String(err).includes('disconnected'),
    `a dropped socket must fail pending work, got: ${err}`,
  )
  eq(relay.isConnected(), false, 'relay knows the peer is gone')
  ok('a dropped extension fails in-flight requests instead of hanging')
})

// ── relay: reconnect replaces the old peer ───────────────

await withRelay(async relay => {
  const first = await connectPeer(relay)
  const firstClosed = new Promise<number>(resolve =>
    first.socket.once('close', code => resolve(code)),
  )
  const second = await connectPeer(relay)

  eq(await firstClosed, 1000, 'the stale connection is closed cleanly')
  eq(relay.isConnected(), true, 'the new peer serves requests')
  const res = await relay.request<{ echo: string }>({ method: 'tabs.list' })
  eq(res.echo, 'tabs.list', 'the new peer answered')
  eq(second.seen.length, 1, 'the new peer, not the old one, got the request')
  eq(first.seen.length, 0, 'the replaced peer got nothing')
  await second.close()
  ok('a reconnecting extension replaces the previous connection')
})

// ── relay: close does not hang on a live peer ────────────

{
  const relay = await startRelayServer({ port: 0 })
  const peer = await connectPeer(relay)
  peer.silent = true
  const pending = relay.request({ method: 'tabs.list' })

  const closed = await Promise.race([
    relay.close().then(() => 'closed'),
    new Promise(r => setTimeout(() => r('timeout'), 3000)),
  ])
  eq(closed, 'closed', 'close() must not wait for the peer to hang up')
  const err = await pending
    .then(() => 'resolved')
    .catch((e: Error) => e.message)
  assert(String(err).includes('shut down'), 'pending work fails on shutdown')
  await peer.close()
  ok('relay shutdown never blocks on a connected extension')
}

// ── relay: waitForExtension ──────────────────────────────

await withRelay(async relay => {
  const err = await relay
    .waitForExtension(150)
    .then(() => 'connected')
    .catch((e: Error) => e.message)
  assert(String(err).includes('No browser extension is connected'), 'times out')

  const waiting = relay.waitForExtension(3000)
  const peer = await connectPeer(relay)
  await waiting // resolves once the peer handshakes, rather than polling
  eq(relay.isConnected(), true, 'connected after the wait resolved')
  await peer.close()
  ok('waitForExtension resolves on pairing and times out with guidance')
})

// ── extension backend: wire contract ─────────────────────

{
  const calls: RelayRequestBody[] = []
  const fakeRelay: RelayServer = {
    port: 1234,
    token: 'tok',
    isConnected: () => true,
    peerName: () => 'FakeChrome',
    waitForExtension: async () => {},
    request: async <T>(req: RelayRequestBody): Promise<T> => {
      calls.push(req)
      if (req.method === 'tabs.list') {
        return [{ targetId: '7', url: 'http://a/', title: 'A' }] as T
      }
      if (req.method === 'tabs.create') {
        return { targetId: '8', url: 'http://b/', title: 'B' } as T
      }
      return { ok: 1 } as T
    },
    onCdpEvent: () => () => {},
    close: async () => {},
  }

  const backend = await createExtensionBackend({ relay: fakeRelay })
  eq(backend.kind, 'extension', 'backend identifies itself')

  const tabs = await backend.listTabs()
  eq(tabs.length, 1, 'one tab')
  eq(tabs[0].targetId, '7', 'targetId passes through')
  eq(tabs[0].title, 'A', 'title passes through')

  const created = await backend.createTab('http://b/')
  eq(created.targetId, '8', 'created tab returned')

  await backend.closeTab('8')
  await backend.send('7', 'Runtime.evaluate', { expression: '1' })

  // The wire shape is a contract with background.js; assert it exactly.
  eq(
    JSON.stringify(calls[1]),
    '{"method":"tabs.create","url":"http://b/"}',
    'create',
  )
  eq(
    JSON.stringify(calls[2]),
    '{"method":"tabs.close","targetId":"8"}',
    'close',
  )
  eq(
    JSON.stringify(calls[3]),
    '{"method":"cdp","targetId":"7","cdpMethod":"Runtime.evaluate","params":{"expression":"1"}}',
    'cdp forwards method under cdpMethod, not method',
  )

  // Disposing must never try to close the user's browser.
  await backend.dispose()
  eq(calls.length, 4, 'dispose sends nothing')
  ok('extension backend maps every operation onto the documented wire shape')
}

// ── screenshot dual channel ──────────────────────────────

{
  const out: BrowserToolOutput = {
    action: 'screenshot',
    message: 'Screenshot of full page',
    url: 'http://localhost:5173/',
    title: 'App',
    screenshotPath: '/tmp/s/shot.png',
    screenshotUrl: '/sessions/abc/browser/shot.png',
    screenshotBase64: 'AAAABBBBCCCC',
    screenshotMediaType: 'image/png',
  }

  const mapped = mapBrowserOutput(out, 'call-1')
  assert(
    Array.isArray(mapped.content),
    'a screenshot must produce content blocks',
  )
  const blocks = mapped.content as Array<{
    type: string
    source?: { data: string }
  }>
  eq(blocks.length, 2, 'text plus image')
  eq(blocks[0].type, 'text', 'text first')
  eq(blocks[1].type, 'image', 'image second')
  eq(
    blocks[1].source?.data,
    'AAAABBBBCCCC',
    'the model receives the image bytes',
  )

  const forUi = BrowserOutputSchema.parse(out) as Record<string, unknown>
  eq(
    forUi.screenshotBase64,
    undefined,
    'base64 must never reach the UI or the log',
  )
  eq(
    forUi.screenshotUrl,
    '/sessions/abc/browser/shot.png',
    'the UI gets a URL instead',
  )
  eq(forUi.screenshotPath, '/tmp/s/shot.png', 'path is kept for the card')
  ok('screenshots go to the model as an image and to the UI as a URL')
}

{
  // Without a screenshot the result stays a plain string, so nothing downstream
  // has to handle an image block it never asked for.
  const mapped = mapBrowserOutput(
    {
      action: 'click',
      message: 'Clicked button "Save"',
      url: 'http://x/',
      title: 'X',
      snapshot: '- button "Save" [ref=e1]',
      consoleErrors: [{ level: 'error', text: 'boom' }],
    } satisfies BrowserToolOutput,
    'call-2',
  )
  eq(typeof mapped.content, 'string', 'no image means plain text')
  const text = mapped.content as string
  assert(text.startsWith('Clicked button "Save"'), 'message leads')
  assert(text.includes('Page: http://x/ — X'), 'location included')
  assert(
    text.includes('Console errors during this action (1)'),
    'errors surfaced',
  )
  assert(text.includes('boom'), 'error text included')
  assert(text.includes('- button "Save" [ref=e1]'), 'snapshot included')
  assert(
    text.indexOf('boom') < text.indexOf('- button "Save"'),
    'console errors come before the snapshot, where they will be read',
  )
  ok('text projection puts the message, errors, then snapshot in that order')
}

// ── error funnel ─────────────────────────────────────────

{
  eq(
    browserErrorText(new BrowserError('Ref e3 is stale.'), 'click'),
    'Error: Ref e3 is stale.',
    'BrowserError messages are already actionable and pass through',
  )
  eq(
    browserErrorText(new Error('socket hang up'), 'click'),
    'Error: click failed: socket hang up',
    'unexpected errors name the action that failed',
  )
  eq(
    browserErrorText('weird', 'scroll'),
    'Error: scroll failed: weird',
    'non-Error throws are still reported',
  )
  ok('error funnel keeps messages actionable')
}

// ── settings: the browser block is actually applied ──────

{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-settings-'))
  fs.mkdirSync(path.join(tmp, '.ai-agent'), { recursive: true })
  fs.writeFileSync(
    path.join(tmp, '.ai-agent', 'settings.json'),
    JSON.stringify({
      browser: { mode: 'extension', relayPort: 9999, headless: false },
    }),
  )
  resetSettingsCache()
  const browser = resolveSettings(tmp).config.browser
  assert(browser, 'the browser block must survive settings merging')
  eq(browser.mode, 'extension', 'mode applied')
  eq(browser.relayPort, 9999, 'relayPort applied')
  eq(browser.headless, false, 'headless applied')

  // Regression: an empty project block must not wipe defaults or throw.
  fs.writeFileSync(
    path.join(tmp, '.ai-agent', 'settings.json'),
    JSON.stringify({ browser: {} }),
  )
  resetSettingsCache()
  assert(
    resolveSettings(tmp).config.browser,
    'an empty browser block is harmless',
  )

  fs.rmSync(tmp, { recursive: true, force: true })
  resetSettingsCache()
  ok('browser settings survive the merge (regression: they used to be dropped)')
}

{
  eq(normalizeRef('e12'), 'e12', 'bare ref')
  eq(normalizeRef('@e12'), 'e12', 'openclaw @ prefix')
  eq(normalizeRef('ref=e12'), 'e12', 'ref= prefix')
  ok('playwright ref locator accepts eN / @eN / ref=eN')
}

{
  const jobs = Array.from({ length: 80 }, (_, i) =>
    [
      `              - listitem [ref=e${100 + i}]:`,
      `                - link "Job ${i} 【 Shanghai 】 50-70k" [ref=e${200 + i}] [cursor=pointer]`,
      `                - generic [ref=e${300 + i}]: Recruiter ${i}`,
    ].join('\n'),
  ).join('\n')
  const yaml = [
    '- generic [ref=e1]:',
    '  - banner [ref=e5]:',
    '    - navigation [ref=e6]:',
    '      - link "Home" [ref=e11] [cursor=pointer]',
    '  - generic [ref=e30]:',
    '    - list [ref=e65]:',
    jobs,
    '  - generic [ref=e1363]:',
    '    - emphasis [ref=e1369] [cursor=pointer]: "1"',
    '    - generic [ref=e1370]: 有新消息',
    '  - dialog [ref=e1374]:',
    '    - generic [ref=e1383]: 我的沟通',
    '    - generic [ref=e1430] [cursor=pointer]:',
    '      - generic [ref=e1432]: 蒋先生',
    '      - paragraph [ref=e1438]: 不错过TA的回复，开启微信通知',
    '    - generic [ref=e1593] [cursor=pointer]:',
    '      - generic [ref=e1594]: 毛先生顾问',
    '      - paragraph [ref=e1595]: 驻场广州汇丰',
  ].join('\n')

  const grouped = groupBadgeLabels(yaml)
  assert(
    /generic \[ref=e1363\] \[cursor=pointer\]: 有新消息/.test(grouped),
    `badge+label must promote the parent ref:\n${grouped}`,
  )
  assert(
    !/emphasis \[ref=e1369\]/.test(grouped),
    `numeric badge must not keep a clickable ref:\n${grouped}`,
  )
  assert(grouped.includes('我的沟通'), 'grouping must not drop the dialog')

  const dock = [
    '- generic [ref=e40]:',
    '  - img [ref=e41]',
    '  - generic [cursor=pointer] [ref=e42]: "1"',
    '  - generic: Chat dock',
  ].join('\n')
  const dockGrouped = groupBadgeLabels(dock)
  assert(
    /generic \[ref=e40\] \[cursor=pointer\]: Chat dock/.test(dockGrouped),
    `icon+badge+label must still group onto the parent:\n${dockGrouped}`,
  )
  assert(
    !/\[ref=e42\]/.test(dockGrouped),
    `badge child must not stay clickable:\n${dockGrouped}`,
  )
  const dockPw = [
    '- generic [ref=f1e404]:',
    '  - img [ref=f1e405] [cursor=pointer]',
    '  - text: 1 Chat dock',
  ].join('\n')
  const dockPwGrouped = groupBadgeLabels(dockPw)
  assert(
    /generic \[ref=f1e404\] \[cursor=pointer\]: Chat dock/.test(dockPwGrouped),
    `Playwright "1 Chat dock" text must promote onto the parent:\n${dockPwGrouped}`,
  )
  assert(
    !/\[ref=f1e405\]/.test(dockPwGrouped),
    `pointer icon must not stay the click target:\n${dockPwGrouped}`,
  )
  ok('playwright yaml groups numeric badges onto the labelled parent')

  const small = prioritizeAriaSnapshot(yaml, { maxChars: yaml.length + 10 })
  eq(small.truncated, false, 'under-budget snapshot is not truncated')
  eq(small.text, grouped, 'under-budget text is the grouped yaml')

  const clipped = prioritizeAriaSnapshot(yaml, { maxChars: 2_400 })
  assert(clipped.truncated, 'over-budget snapshot is marked truncated')
  assert(
    clipped.text.length <= 2_400,
    `prioritized snapshot must fit the budget, got ${clipped.text.length}`,
  )
  assert(
    clipped.text.includes('我的沟通') && clipped.text.includes('蒋先生'),
    `dialog must survive a head-only budget:\n${clipped.text}`,
  )
  assert(
    clipped.text.includes('有新消息') || clipped.text.includes('Chat dock'),
    `end-of-tree launcher must survive truncation:\n${clipped.text.slice(-400)}`,
  )
  assert(
    !clipped.text.includes('Job 70'),
    'the middle of a long job list is what the budget should drop',
  )
  ok('playwright snapshot keeps dialogs and end chrome when truncated')

  // Regression: maxNodes was accepted and silently ignored, so browser_snapshot
  // advertised a budget knob to the model that did nothing.
  const capped = prioritizeAriaSnapshot(yaml, {
    maxChars: 200_000,
    maxNodes: 12,
  })
  assert(capped.truncated, 'a node cap below the tree marks the result truncated')
  assert(
    countRefs(capped.text) <= 12,
    `node cap must bound ref-bearing nodes, got ${countRefs(capped.text)}`,
  )
  assert(
    capped.text.includes('我的沟通'),
    `a tight node cap must still spend itself on the dialog:\n${capped.text}`,
  )
  const uncapped = prioritizeAriaSnapshot(yaml, { maxChars: 200_000 })
  eq(uncapped.truncated, false, 'no node cap, no truncation at a huge char budget')
  ok('snapshot node cap bounds refs and keeps the dialog')
}

{
  const jobs = Array.from({ length: 80 }, (_, i) =>
    [
      `        - listitem [ref=f2e${100 + i}]:`,
      `          - link "Job ${i}" [ref=f2e${200 + i}] [cursor=pointer]`,
    ].join('\n'),
  ).join('\n')
  const yaml = [
    '- generic [active] [ref=f2e1]:',
    '  - banner [ref=f2e5]:',
    '    - link "Home" [ref=f2e11] [cursor=pointer]',
    '  - generic [ref=f2e30]:',
    '    - list [ref=f2e65]:',
    jobs,
    '  - generic [ref=f2e1335] [cursor=pointer]: 有新消息',
    '    - emphasis: "1"',
    '  - generic [ref=f3e1]:',
    '    - paragraph [ref=f3e74]: Copyright footer that must not steal the tail',
    '    - link "京公网安备" [ref=f3e75] [cursor=pointer]',
  ].join('\n')
  const clipped = prioritizeAriaSnapshot(yaml, { maxChars: 2_400 })
  assert(clipped.truncated, 'footer-iframe page is truncated')
  assert(
    clipped.text.includes('有新消息'),
    `primary-frame dock must survive a footer iframe tail:\n${clipped.text.slice(-500)}`,
  )
  assert(
    !clipped.text.includes('京公网安备'),
    'footer iframe must not consume the end-of-tree budget',
  )
  ok('playwright snapshot keeps primary-frame dock, not footer iframe')
}

// ── Playwright page matching: never pages[0] ─────────────

{
  assert(urlsRoughlyEqual('https://www.example.com/a', 'https://www.example.com/a?utm=1'), 'ignore query')
  assert(urlsRoughlyEqual('https://www.example.com/a#x', 'https://www.example.com/a'), 'ignore hash')
  assert(
    !urlsRoughlyEqual('https://www.example.com/', 'https://www.example.com/other'),
    'different paths are not the same tab',
  )

  const stale = { url: () => 'https://www.example.com/unrelated' }
  const blank = { url: () => 'about:blank' }
  const home = { url: () => 'https://www.example.com/' }

  eq(
    pickPageForTab([stale], 'https://www.example.com/'),
    undefined,
    'must not fall back to the only Playwright page when the URL does not match',
  )
  eq(
    pickPageForTab([stale, home], 'https://www.example.com/?from=nav'),
    home,
    'match origin+path ignoring tracking query',
  )
  eq(
    pickPageForTab([stale, blank], 'about:blank'),
    blank,
    'a newly created tab may still be about:blank',
  )
  eq(
    pickPageForTab([stale, blank], 'https://www.example.com/'),
    undefined,
    'blank leftover is not a match for a real URL',
  )
  ok('findPage matching ignores stale pages[0]')
}

{
  const prev = process.env.AUTH_ENABLED
  process.env.AUTH_ENABLED = 'true'
  try {
    initBrowserLifecycle()
    ok('initBrowserLifecycle does not throw under AUTH without request scope')
  } finally {
    if (prev === undefined) delete process.env.AUTH_ENABLED
    else process.env.AUTH_ENABLED = prev
  }
}

console.log('\nall browser unit tests passed')
