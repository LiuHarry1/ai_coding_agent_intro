/**
 * One conformance suite, run against every backend.
 *
 * The claim phase 2 rests on is that the extension backend is interchangeable
 * with the isolated one. Asserting that in prose is worthless; running the same
 * tool suite through both is the proof. Any behaviour that only works on
 * one backend shows up here as a failure.
 */
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as http from 'node:http'
import { setBrowserBackendFactory, closeBrowser } from '../browser/manager.js'
import type { BrowserBackend } from '../browser/types.js'
import {
  clickTool,
  consoleTool,
  networkTool,
  hoverTool,
  fillFormTool,
  navigateTool,
  pressKeyTool,
  screenshotTool,
  scrollTool,
  selectOptionTool,
  snapshotTool,
  tabsTool,
  typeTool,
  waitForTool,
} from '../tools/BrowserTool/BrowserTool.js'
import type {
  AnyTool,
  DualChannelToolResult,
  ToolContext,
  ToolDefinition,
} from '../core/types.js'

const PAGE = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Verify Loop Fixture</title></head>
<body>
  <h1>Dashboard</h1>
  <p>Signed out.</p>

  <button id="counter">Clicked 0 times</button>

  <form id="login" onsubmit="event.preventDefault(); document.getElementById('status').textContent = 'Submitted ' + document.getElementById('email').value;">
    <label for="email">Email address</label>
    <input id="email" name="email" type="email" placeholder="you@example.com">
    <button type="submit">Sign in</button>
  </form>
  <p id="status">Not submitted</p>

  <label for="env">Environment</label>
  <select id="env">
    <option value="dev">Development</option>
    <option value="prod">Production</option>
  </select>

  <button id="hover-target">Hover me</button>
  <p id="hover-state">Not hovered</p>

  <p id="last-key">Last key: none</p>

  <ul id="rows">
    <li><button class="del" data-id="1">Delete Alice</button></li>
  </ul>
  <button id="recycle">Recycle row</button>

  <!-- Replaced wholesale by an identical node: the old ref detaches, but the
       thing it meant still exists, so a fresh snapshot should recover it. -->
  <div id="apply-host"><button class="apply">Apply changes</button></div>
  <button id="rebuild-apply">Rebuild apply</button>
  <p id="applied">not applied</p>

  <!-- A real modal sitting on top of a live button: the click must be refused
       with the blocker named, not dispatched into the void. -->
  <span style="position:relative;display:inline-block">
    <button id="under">Confirm order</button>
    <div role="dialog" aria-modal="true"
         style="position:absolute;inset:0;background:rgba(0,0,0,.5);color:#fff">Please wait…</div>
  </span>

  <button id="call-ok">Call ok</button>
  <button id="call-boom">Call boom</button>
  <button id="call-dead">Call dead host</button>
  <button id="call-xhr">Call xhr</button>

  <a href="/other">Go to other page</a>

  <!-- Role-less clickable nodes. Playwright emits these as generic + ref +
       [cursor=pointer], not as forged buttons. -->
  <p id="fab-state">fab closed</p>
  <div id="fab-direct" style="position:fixed;bottom:16px;right:16px;cursor:pointer;padding:8px 12px;background:#08f;color:#fff;z-index:20">有新消息</div>
  <div id="fab-wrap" style="position:fixed;bottom:16px;right:140px;cursor:pointer;padding:8px 12px;background:#08f;color:#fff;z-index:20"><span>我的沟通</span></div>
  <p>Inbox: <span id="fab-inline" style="cursor:pointer;color:#08f">打开消息</span></p>

  <!-- CSS pointer on a child, label on a sibling. The grouping parent is the
       click target (Playwright keeps the group; we put the ref on it). -->
  <p id="launcher-state">launcher closed</p>
  <p id="silent-state">silent closed</p>
  <div id="silent-dock" style="position:fixed;bottom:16px;left:280px;z-index:30;background:#333;color:#fff;padding:8px 12px">Alerts</div>
  <div id="launcher" style="position:fixed;bottom:16px;left:16px;z-index:30">
    <svg width="16" height="16" style="cursor:pointer" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="#fff"/></svg>
    <div id="launcher-chip" style="cursor:pointer;display:inline-block;padding:4px 8px;background:#f44;color:#fff">1</div>
    <span>Messages</span>
  </div>

  <!-- Wrapper roles must not quote the concatenated subtree as their name. -->
  <ul id="jobs">
    <li aria-label="Staff Engineer Remote $200k Long preview text that must stay a child and not become the listitem accessible name because that truncates the rest of the snapshot">
      <a href="/jobs/1">Staff Engineer</a>
      <span>Remote · $200k</span>
      <span>Long preview text that must stay a child and not become the listitem accessible name because that truncates the rest of the snapshot</span>
    </li>
  </ul>

  <div style="height: 2000px"></div>
  <div id="bottom">Bottom marker</div>

  <script>
    let n = 0;
    document.getElementById('counter').addEventListener('click', () => {
      n += 1;
      document.getElementById('counter').textContent = 'Clicked ' + n + ' times';
    });
    document.addEventListener('keydown', e => {
      const mods = [e.ctrlKey && 'Control', e.shiftKey && 'Shift'].filter(Boolean);
      document.getElementById('last-key').textContent =
        'Last key: ' + [...mods, e.key].join('+');
    });
    document.getElementById('hover-target').addEventListener('mouseover', () => {
      document.getElementById('hover-state').textContent = 'Hovered';
    });
    // Reuses the same DOM node for a different record -- the exact situation a
    // ref must not silently follow.
    document.getElementById('recycle').addEventListener('click', () => {
      const btn = document.querySelector('.del');
      btn.dataset.id = '2';
      btn.textContent = 'Delete Bob';
    });
    function wireApply() {
      document.querySelector('.apply').addEventListener('click', () => {
        document.getElementById('applied').textContent = 'applied';
      });
    }
    wireApply();
    document.getElementById('rebuild-apply').addEventListener('click', () => {
      // Same label, brand-new DOM node -> old ref is now detached.
      document.getElementById('apply-host').innerHTML =
        '<button class="apply">Apply changes</button>';
      wireApply();
    });
    document.getElementById('fab-direct').addEventListener('click', () => {
      document.getElementById('fab-state').textContent = 'fab opened';
    });
    document.getElementById('fab-wrap').addEventListener('click', () => {
      document.getElementById('fab-state').textContent = 'chat opened';
    });
    document.getElementById('fab-inline').addEventListener('click', () => {
      document.getElementById('fab-state').textContent = 'inline opened';
    });
    document.getElementById('launcher').addEventListener('click', () => {
      document.getElementById('launcher-state').textContent = 'launcher opened';
    });
    document.getElementById('silent-dock').addEventListener('click', () => {
      document.getElementById('silent-state').textContent = 'silent opened';
    });
    // Three shapes the network tool has to tell apart: a request that worked,
    // one the server rejected, and one that never reached a server at all.
    document.getElementById('call-ok').addEventListener('click', () => {
      fetch('/api/ok').catch(() => {});
    });
    document.getElementById('call-boom').addEventListener('click', () => {
      fetch('/api/boom', { method: 'POST' }).catch(() => {});
    });
    document.getElementById('call-dead').addEventListener('click', () => {
      // Port 1 refuses instantly, so the fetch rejects without a response.
      fetch('http://127.0.0.1:1/never').catch(() => {});
    });
    document.getElementById('call-xhr').addEventListener('click', () => {
      const x = new XMLHttpRequest();
      x.open('GET', '/api/ok?via=xhr');
      x.send();
    });
    console.error('boot failure: widget service unreachable');
  </script>
</body>
</html>`

const OTHER_PAGE = `<!doctype html>
<html><head><title>Other</title></head><body><h1>Other page</h1></body></html>`

function nestedRows(count: number): string {
  const rows: string[] = []
  for (let i = 0; i < count; i++) {
    rows.push(
      `<div class="row" style="cursor:pointer;padding:8px">` +
        `<div><div><div><div>` +
        `<img alt="avatar ${i}" width="24" height="24">` +
        `<span>Candidate ${i} hello this is a long preview that used to become the generic name</span>` +
        `<span>删除</span>` +
        `</div></div></div></div></div>`,
    )
  }
  return rows.join('')
}

const NESTED_PAGE = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Nested Wrappers</title></head>
<body>
  <h1>Inbox</h1>
  <div id="chat-panel">
    <div id="msg-a" style="cursor:pointer;padding:8px">Alice: latest note</div>
    <div id="msg-b" style="cursor:pointer;padding:8px">Bob: another note</div>
  </div>
  <div id="noise">
    <p>Sidebar clutter that selector must not include.</p>
    <button id="noise-btn">Ignore me</button>
  </div>
  <div id="thread">${nestedRows(50)}</div>
</body>
</html>`

function overflowCopy(): string {
  const paras: string[] = []
  for (let i = 0; i < 400; i++) {
    paras.push(
      `<p>Filler paragraph ${i} so a document-order char budget would drop the fixed dock at the end of the body.</p>`,
    )
  }
  return paras.join('')
}

const OVERFLOW_PAGE = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Overflow Chrome</title></head>
<body>
  <h1>Feed</h1>
  <div id="feed">${overflowCopy()}</div>
  <div id="chat-dock" style="position:fixed;bottom:12px;right:12px;z-index:40;background:#08f;color:#fff;padding:8px">
    <svg width="14" height="14" style="cursor:pointer" viewBox="0 0 14 14"><circle cx="7" cy="7" r="5" fill="#fff"/></svg>
    <span style="cursor:pointer">1</span>
    <span>Chat dock</span>
  </div>
</body>
</html>`

function dialogLazyRows(): string {
  const rows: string[] = []
  for (let i = 1; i <= 20; i++) {
    rows.push(`<li>蒋先生 8月${i}日 不错过TA的回复 ${i}</li>`)
  }
  return rows.join('')
}

const DIALOG_NESTED_PAGE = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Nested Dialogs</title></head>
<body>
  <h1>Inbox home</h1>
  <p id="state">closed</p>
  <button id="open-list" type="button">Open inbox</button>
  <script>
    document.getElementById('open-list').addEventListener('click', function () {
      var list = document.createElement('div');
      list.setAttribute('role', 'dialog');
      list.setAttribute('aria-label', 'Conversations');
      list.style.cssText = 'position:fixed;inset:24px auto 16px 16px;width:280px;background:#fff;z-index:40;border:1px solid #ccc;padding:12px';
      var rows = '<li><button type="button" class="row">Ada Reed</button></li>';
      for (var i = 2; i <= 24; i++) rows += '<li><button type="button" class="row">Person ' + i + '</button></li>';
      list.innerHTML = '<h2>Conversations</h2><ul>' + rows + '</ul>';
      document.body.appendChild(list);
      list.addEventListener('click', function (ev) {
        var btn = ev.target.closest('.row');
        if (!btn) return;
        var existing = document.getElementById('thread');
        if (existing) existing.remove();
        var thread = document.createElement('div');
        thread.id = 'thread';
        thread.setAttribute('role', 'dialog');
        thread.setAttribute('aria-label', 'Thread');
        thread.style.cssText = 'position:fixed;inset:24px 16px 16px auto;width:360px;background:#fff;z-index:50;border:1px solid #ccc;padding:12px';
        thread.innerHTML = '<h2>' + btn.textContent + '</h2><p>Earlier message</p><textarea placeholder="Type a message"></textarea><button type="button">Send</button>';
        setTimeout(function () {
          document.body.appendChild(thread);
          document.getElementById('state').textContent = 'thread open';
        }, 400);
      });
    });
  </script>
</body>
</html>`

const DIALOG_LAZY_PAGE = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Dialog Lazy</title></head>
<body>
  <h1>Hiring home</h1>
  <div id="feed">${overflowCopy()}</div>
  <p id="inbox-state">inbox closed</p>
  <div id="open-inbox" style="position:fixed;bottom:16px;right:16px;cursor:pointer;z-index:20;background:#08f;color:#fff;padding:8px 12px">有新消息</div>
  <script>
    document.getElementById('open-inbox').addEventListener('click', function () {
      setTimeout(function () {
        var d = document.createElement('div');
        d.setAttribute('role', 'dialog');
        d.setAttribute('aria-modal', 'true');
        d.style.cssText = 'position:fixed;inset:24px 16px 16px auto;width:360px;overflow:auto;background:#fff;z-index:50;border:1px solid #ccc;padding:12px';
        d.innerHTML = '<h2>我的沟通</h2><button type="button">Close</button><ul>${dialogLazyRows()}</ul>';
        document.body.appendChild(d);
        document.getElementById('inbox-state').textContent = 'inbox open';
      }, 350);
    });
  </script>
</body>
</html>`

const ERROR_MODAL_PAGE = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Error Modal</title></head>
<body>
  <h1>Expense form</h1>
  <p>Merchant Name field</p>
  <button type="button" id="save">Save Expense</button>
  <script>
    document.getElementById('save').addEventListener('click', function () {
      var d = document.createElement('div');
      d.setAttribute('role', 'alertdialog');
      d.setAttribute('aria-modal', 'true');
      d.innerHTML = '<h2>Error</h2><p>This expense has been saved, but it is missing required information. Would you like to make corrections now?</p><button type="button">Yes</button><button type="button">No</button>';
      document.body.appendChild(d);
    });
  </script>
</body>
</html>`

const WAIT_TEXT_PAGE = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Wait Text</title></head>
<body>
  <h1>Wait fixture</h1>
  <p id="status">waiting</p>
  <p id="banner">Loading now</p>
  <button id="reveal" type="button">Reveal</button>
  <script>
    document.getElementById('reveal').addEventListener('click', function () {
      setTimeout(function () {
        document.getElementById('status').textContent = 'Message delivered';
        document.getElementById('banner').remove();
      }, 2000);
    });
  </script>
</body>
</html>`

/** Every control kind browser_fill_form claims to handle, plus one it must refuse. */
const FORM_PAGE = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Form</title></head>
<body>
  <h1>Expense form</h1>
  <form id="expense">
    <label>Merchant <input id="merchant" name="merchant" type="text" value="old merchant"></label>
    <label>Total <input id="total" name="total" type="text"></label>
    <label>Computed tax <input id="tax" name="tax" type="text" value="0.00" readonly></label>
    <label>Billable <input id="billable" name="billable" type="checkbox"></label>
    <label>Personal <input id="personal" type="radio" name="kind" value="personal"></label>
    <label>Currency
      <select id="currency" name="currency">
        <option value="cny">CNY</option>
        <option value="usd">USD</option>
      </select>
    </label>
  </form>
  <p id="tax-state">tax untouched</p>
  <script>
    // Stands in for an app that computes a readonly field from the others.
    document.getElementById('total').addEventListener('change', function (e) {
      var n = parseFloat(e.target.value || '0');
      document.getElementById('tax').value = (n * 0.06).toFixed(2);
      document.getElementById('tax-state').textContent = 'tax computed';
    });
  </script>
</body>
</html>`

const COMBOBOX_PAGE = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Combobox</title></head>
<body>
  <h1>Pickers</h1>
  <label>Fruit
    <div id="fruit-combo" role="combobox" aria-label="Fruit" aria-expanded="false">
      <input id="fruit" type="text" aria-label="Fruit">
    </div>
  </label>
  <ul id="fruit-list" role="listbox" hidden></ul>
  <p id="fruit-state">none</p>
  <button id="ask" type="button">Confirm me</button>
  <p id="dialog-state">waiting</p>
  <input id="receipt" type="file" aria-label="Receipt upload">
  <p id="file-state">none</p>
  <script>
    var fruits = ['Apple', 'Banana', 'Cherry'];
    var combo = document.getElementById('fruit-combo');
    var input = document.getElementById('fruit');
    var list = document.getElementById('fruit-list');
    function render(filter) {
      list.innerHTML = '';
      var q = (filter || '').toLowerCase();
      fruits.filter(function (r) { return !q || r.toLowerCase().indexOf(q) !== -1; }).forEach(function (r) {
        var li = document.createElement('li');
        li.setAttribute('role', 'option');
        li.textContent = r;
        li.addEventListener('click', function () {
          input.value = r;
          document.getElementById('fruit-state').textContent = r;
          list.hidden = true;
          combo.setAttribute('aria-expanded', 'false');
        });
        list.appendChild(li);
      });
    }
    function open() {
      combo.setAttribute('aria-expanded', 'true');
      list.hidden = false;
      render(input.value);
    }
    combo.addEventListener('click', open);
    input.addEventListener('focus', open);
    input.addEventListener('input', function () { render(input.value); });
    document.getElementById('ask').addEventListener('click', function () {
      var ok = window.confirm('Delete this expense?');
      document.getElementById('dialog-state').textContent = ok ? 'accepted' : 'dismissed';
    });
    document.getElementById('receipt').addEventListener('change', function () {
      document.getElementById('file-state').textContent = this.files[0] ? this.files[0].name : 'none';
    });
  </script>
</body>
</html>`

const PDF_PREVIEW_PAGE = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>PDF Preview</title></head>
<body>
  <h1>Expense form</h1>
  <button type="button" id="save">Save</button>
  <input id="receipt" type="file" aria-label="Receipt upload">
  <iframe src="/hang-frame" title="Document preview" width="400" height="300"></iframe>
</body>
</html>`

const ITEMIZATION_PAGE = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Itemization</title></head>
<body>
  <span>Room Rate</span>
  <input id="room-rate" type="text">
  <p id="out"></p>
  <script>
    document.getElementById('room-rate').addEventListener('input', function () {
      document.getElementById('out').textContent = this.value;
    });
  </script>
</body>
</html>`

export function startFixtureServer(): Promise<{
  url: string
  close: () => Promise<void>
}> {
  const server = http.createServer((req, res) => {
    const route = (req.url ?? '/').split('?')[0]
    if (route === '/api/ok') {
      res.setHeader('content-type', 'application/json')
      res.end('{"ok":true}')
      return
    }
    if (route === '/api/boom') {
      res.statusCode = 500
      res.setHeader('content-type', 'application/json')
      res.end('{"error":"kaboom"}')
      return
    }
    res.setHeader('content-type', 'text/html; charset=utf-8')
    if (route === '/other') {
      res.end(OTHER_PAGE)
      return
    }
    if (route === '/nested') {
      res.end(NESTED_PAGE)
      return
    }
    if (route === '/overflow') {
      res.end(OVERFLOW_PAGE)
      return
    }
    if (route === '/dialog-lazy') {
      res.end(DIALOG_LAZY_PAGE)
      return
    }
    if (route === '/dialog-nested') {
      res.end(DIALOG_NESTED_PAGE)
      return
    }
    if (route === '/wait-text') {
      res.end(WAIT_TEXT_PAGE)
      return
    }
    if (route === '/error-modal') {
      res.end(ERROR_MODAL_PAGE)
      return
    }
    if (route === '/form') {
      res.end(FORM_PAGE)
      return
    }
    if (route === '/widgets') {
      res.end(COMBOBOX_PAGE)
      return
    }
    if (route === '/pdf-preview') {
      res.end(PDF_PREVIEW_PAGE)
      return
    }
    if (route === '/itemization') {
      res.end(ITEMIZATION_PAGE)
      return
    }
    if (route === '/hang-frame') {
      return
    }
    res.end(PAGE)
  })
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number }
      resolve({
        url: `http://127.0.0.1:${addr.port}/`,
        close: () =>
          new Promise<void>(done => {
            // Chrome holds keep-alive sockets; without this, close() waits for
            // them and the test process never exits.
            server.closeAllConnections()
            server.close(() => done())
          }),
      })
    })
  })
}

function toolContext(sessionId: string): ToolContext {
  return {
    eventBus: {
      emit() {},
      on() {},
      off() {},
    } as unknown as ToolContext['eventBus'],
    wire: { emit() {} } as unknown as ToolContext['wire'],
    cwd: process.cwd(),
    sessionId,
  }
}

async function run(
  def: ToolDefinition,
  args: Record<string, unknown>,
  sessionId: string,
  toolCallId = `call-${Math.random().toString(36).slice(2, 8)}`,
): Promise<DualChannelToolResult<Record<string, unknown>> | string> {
  const instance = def.create(
    process.cwd(),
    toolContext(sessionId),
  ) as AnyTool & {
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
  assert.ok(typeof result !== 'string', `expected success, got: ${result}`)
  return result.data
}

/** Pull the ref for a snapshot line matching `role "name"`. */
function refFor(snapshot: string, role: string, name: string): string {
  const line = snapshot
    .split('\n')
    .find(l => l.includes(`${role} "${name}"`) && l.includes('[ref='))
  assert.ok(
    line,
    `no ref found for ${role} "${name}" in snapshot:\n${snapshot}`,
  )
  return /\[ref=([^\]]+)\]/.exec(line)![1]
}

function refNear(snapshot: string, needle: string): string {
  const line = snapshot
    .split('\n')
    .find(l => l.includes(needle) && l.includes('[ref='))
  assert.ok(line, `no ref near "${needle}" in snapshot:\n${snapshot}`)
  return /\[ref=([^\]]+)\]/.exec(line)![1]
}

/**
 * Clickable generics do not quote their subtree as an accessible name. Playwright
 * attaches the label inline on the node's own line
 * (`generic [ref=e30] [cursor=pointer]: Messages`), so look for that, for a
 * quoted name, or for a `text:` child that mentions `label`.
 */
function refForGeneric(snapshot: string, label: string): string {
  const lines = snapshot.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line.includes('generic') || !line.includes('[ref=')) continue
    if (line.includes(`"${label}"`) || line.includes(`: ${label}`)) {
      return /\[ref=([^\]]+)\]/.exec(line)![1]
    }
    const indent = /^\s*/.exec(line)![0].length
    for (let j = i + 1; j < lines.length; j++) {
      const child = lines[j]
      const childIndent = /^\s*/.exec(child)![0].length
      if (childIndent <= indent) break
      if (child.includes('text:') && child.includes(label)) {
        return /\[ref=([^\]]+)\]/.exec(line)![1]
      }
    }
  }
  assert.ok(false, `no generic ref for "${label}" in snapshot:\n${snapshot}`)
  return ''
}

export interface SuiteOptions {
  label: string
  backendFactory: () => Promise<BrowserBackend>
  baseUrl: string
  sessionId: string
  /** Print the first snapshot; useful when eyeballing a new backend. */
  showSnapshot?: boolean
}

export async function runBrowserToolSuite(opts: SuiteOptions): Promise<void> {
  const { label, baseUrl, sessionId } = opts
  const ok = (msg: string) => console.log(`ok [${label}] ${msg}`)

  setBrowserBackendFactory(opts.backendFactory)

  try {
    // ── navigate ──────────────────────────────────────────
    const nav = expectData(await run(navigateTool, { url: baseUrl }, sessionId))
    assert.equal(nav.title, 'Verify Loop Fixture')
    const snapshot = String(nav.snapshot)
    assert.ok(snapshot.includes('heading "Dashboard"'), snapshot)
    assert.ok(snapshot.includes('[level=1]'), snapshot)
    assert.ok(snapshot.includes('link "Go to other page"'), snapshot)
    assert.ok(snapshot.includes('/url: /other'), snapshot)
    ok('navigate + accessibility snapshot')
    if (opts.showSnapshot) {
      console.log('\n--- snapshot ---\n' + snapshot + '\n----------------\n')
    }

    // ── console capture starts before page scripts run ────
    const bootErrors = nav.consoleErrors as Array<{ text: string }> | undefined
    assert.ok(
      bootErrors?.some(e => e.text.includes('widget service unreachable')),
      'console errors logged during page load must be captured',
    )
    ok('console capture survives navigation')

    // ── role-less clickable nodes: Playwright generic + cursor=pointer ──
    assert.ok(
      !snapshot.includes('button "有新消息"'),
      'must not forge a button role for a pointer div',
    )
    assert.ok(
      !/generic "有新消息"/.test(snapshot),
      'generic must not take its name from subtree text',
    )
    assert.ok(
      /- generic \[ref=\S+\] \[cursor=pointer\]: 有新消息/.test(snapshot),
      `pointer FAB must carry its label on the clickable node's own line:\n${snapshot}`,
    )
    const fabDirect = refForGeneric(snapshot, '有新消息')
    const fabWrap = refForGeneric(snapshot, '我的沟通')
    /**
     * Known boundary: an inline `<span style="cursor:pointer">` has no ARIA
     * role, so Playwright folds it into the paragraph's text and never mints a
     * ref for it. That tree cannot click the span as its own control.
     *
     * Written as a branch rather than skipped, so that if a future Playwright
     * starts surfacing these, the ref still has to be clickable.
     */
    const fabInline = /- generic \[ref=\S+\][^\n]*打开消息/.test(snapshot)
      ? refForGeneric(snapshot, '打开消息')
      : ''
    const fabDirectLine = snapshot
      .split('\n')
      .find(l => l.includes(`[ref=${fabDirect}]`))
    assert.ok(
      fabDirectLine && fabDirectLine.includes('[cursor=pointer]'),
      `pointer FAB must be generic with cursor=pointer:\n${snapshot}`,
    )
    const fabWrapLine = snapshot
      .split('\n')
      .find(l => l.includes(`[ref=${fabWrap}]`))
    assert.ok(
      fabWrapLine && fabWrapLine.includes('[cursor=pointer]'),
      `wrapped FAB must be generic with cursor=pointer:\n${snapshot}`,
    )
    assert.equal(
      snapshot.split('\n').filter(l => l.includes(`[ref=${fabWrap}]`)).length,
      1,
      'must not nest a second generic on the inner span',
    )
    if (fabInline) {
      const inlineLines = snapshot.split('\n')
      const inlineIdx = inlineLines.findIndex(l =>
        l.includes(`[ref=${fabInline}]`),
      )
      const inlineIndent = /^\s*/.exec(inlineLines[inlineIdx])![0].length
      const inlineChildren: string[] = []
      for (let j = inlineIdx + 1; j < inlineLines.length; j++) {
        const ind = /^\s*/.exec(inlineLines[j])![0].length
        if (ind <= inlineIndent) break
        inlineChildren.push(inlineLines[j])
      }
      assert.ok(
        !inlineChildren.some(l => l.includes('Inbox:')),
        `an inline pointer must not absorb the surrounding sentence:\n${snapshot}`,
      )
    }
    const openedFab = expectData(
      await run(clickTool, { ref: fabDirect }, sessionId),
    )
    assert.ok(
      String(openedFab.snapshot).includes('fab opened'),
      `clicking the role-less FAB must fire its handler:\n${openedFab.snapshot}`,
    )
    const openedChat = expectData(
      await run(clickTool, { ref: fabWrap }, sessionId),
    )
    assert.ok(
      String(openedChat.snapshot).includes('chat opened'),
      `clicking the wrapped FAB must fire its handler:\n${openedChat.snapshot}`,
    )
    if (fabInline) {
      const openedInline = expectData(
        await run(clickTool, { ref: fabInline }, sessionId),
      )
      assert.ok(
        String(openedInline.snapshot).includes('inline opened'),
        `clicking an inline pointer span must fire its handler:\n${openedInline.snapshot}`,
      )
    } else {
      assert.ok(
        snapshot.includes('打开消息'),
        `inline pointer span has no ref; label must still appear in snapshot:\n${snapshot}`,
      )
    }
    ok('role-less clickable generic gets a ref and is clickable')

    // ── pointer child + sibling label: ref belongs to the group ──
    const launcherRef = refForGeneric(snapshot, 'Messages')
    const launcherLine = snapshot
      .split('\n')
      .find(l => l.includes(`[ref=${launcherRef}]`))
    assert.ok(
      launcherLine && launcherLine.includes('[cursor=pointer]'),
      `label-group must be a clickable generic:\n${snapshot}`,
    )
    assert.ok(
      launcherLine.includes(': Messages'),
      `the group's label must be on the clickable line, not only on a child:\n${snapshot}`,
    )
    const compactIndex = expectData(
      await run(snapshotTool, { compact: true }, sessionId),
    )
    const compactLauncher = refForGeneric(String(compactIndex.snapshot), 'Messages')
    assert.ok(
      compactLauncher,
      `compact must keep the pointer+label group:\n${compactIndex.snapshot}`,
    )
    const openedLauncher = expectData(
      await run(clickTool, { ref: launcherRef }, sessionId),
    )
    assert.ok(
      String(openedLauncher.snapshot).includes('launcher opened'),
      `clicking the grouping generic must fire the parent handler:\n${openedLauncher.snapshot}`,
    )
    ok('pointer+label group puts the ref on the parent')

    const silentRef = refForGeneric(snapshot, 'Alerts')
    const openedSilent = expectData(
      await run(clickTool, { ref: silentRef }, sessionId),
    )
    assert.ok(
      String(openedSilent.snapshot).includes('silent opened'),
      `fixed overlay without cursor:pointer must still be clickable:\n${openedSilent.snapshot}`,
    )
    ok('overlay widget without pointer cursor gets a ref')

    // ── wrapper roles do not swallow child names ──
    assert.ok(
      snapshot.includes('link "Staff Engineer"'),
      `job-card link must keep its own name:\n${snapshot}`,
    )
    assert.ok(
      !/listitem "[^"]{80,}/.test(snapshot),
      `listitem must not quote the concatenated card:\n${snapshot}`,
    )
    ok('listitem name does not swallow children')

    // ── click mutates the page and the snapshot reflects it ──
    const counterRef = refFor(snapshot, 'button', 'Clicked 0 times')
    const clicked = expectData(
      await run(clickTool, { ref: counterRef }, sessionId),
    )
    assert.equal(clicked.message, 'Clicked button "Clicked 0 times"')
    assert.ok(
      String(clicked.snapshot).includes('Clicked 1 times'),
      'post-action snapshot must show the result of the click',
    )
    ok('click dispatches trusted input')

    // ── a changed label rotates the ref, old one stops working ──
    const staleCounter = await run(clickTool, { ref: counterRef }, sessionId)
    assert.ok(
      typeof staleCounter === 'string',
      'a ref captured before the label changed must not resolve',
    )
    assert.ok(staleCounter.includes('Clicked 1 times'), staleCounter)
    const newCounterRef = refFor(
      String(clicked.snapshot),
      'button',
      'Clicked 1 times',
    )
    assert.notEqual(newCounterRef, counterRef)
    assert.ok(
      String(
        expectData(await run(clickTool, { ref: newCounterRef }, sessionId))
          .snapshot,
      ).includes('Clicked 2 times'),
    )
    ok('ref rotates when an element changes meaning')

    // ── refs stay stable for elements that did not change ──
    const fresh = String(
      expectData(await run(snapshotTool, {}, sessionId)).snapshot,
    )
    assert.equal(
      refFor(fresh, 'textbox', 'Email address'),
      refFor(snapshot, 'textbox', 'Email address'),
      'an untouched element must keep its ref across snapshots',
    )
    ok('ref stable across snapshots for unchanged elements')

    // ── type + submit ─────────────────────────────────────
    const emailRef = refFor(fresh, 'textbox', 'Email address')
    const typed = expectData(
      await run(
        typeTool,
        { ref: emailRef, text: 'harry@example.com', submit: true },
        sessionId,
      ),
    )
    assert.ok(
      String(typed.snapshot).includes('Submitted harry@example.com'),
      `form submit did not take effect:\n${typed.snapshot}`,
    )
    ok('type + submit')

    // ── select ────────────────────────────────────────────
    const selectRef = refFor(fresh, 'combobox', 'Environment')
    const selected = expectData(
      await run(
        selectOptionTool,
        { ref: selectRef, values: ['Production'] },
        sessionId,
      ),
    )
    assert.equal(selected.message, 'Selected "Production"')
    assert.match(
      String(selected.snapshot),
      /Production/,
      `select_option must update page state:\n${selected.snapshot}`,
    )
    ok('select_option')

    // ── fill_form ─────
    const formNav = expectData(
      await run(navigateTool, { url: `${baseUrl}form` }, sessionId),
    )
    const formSnap = String(formNav.snapshot)
    const formFilled = expectData(
      await run(
        fillFormTool,
        {
          fields: [
            { ref: refNear(formSnap, 'Merchant'), value: 'Suzhou Hotel' },
            { ref: refNear(formSnap, 'Total'), value: '100.00' },
            { ref: refNear(formSnap, 'Billable'), value: 'true', kind: 'checkbox' },
            { ref: refNear(formSnap, 'Currency'), value: 'USD', kind: 'combobox' },
          ],
        },
        sessionId,
      ),
    )
    assert.ok(
      String(formFilled.message).startsWith('Filled 4/4 fields'),
      `fill_form must write every control kind in one call:\n${formFilled.message}`,
    )
    assert.ok(
      String(formFilled.message).includes('Suzhou Hotel') &&
        String(formFilled.message).includes('100.00'),
      `fill_form must report written values:\n${formFilled.message}`,
    )
    assert.ok(
      String(formFilled.snapshot).includes('6.00'),
      `readonly tax must still update from the app handler:\n${formFilled.snapshot}`,
    )
    const readonlyField = expectData(
      await run(
        fillFormTool,
        { fields: [{ ref: refNear(formSnap, 'Computed tax'), value: '9.99' }] },
        sessionId,
      ),
    )
    assert.ok(
      /failed|skipped/.test(String(readonlyField.message)),
      `a readonly field must be reported, not silently dropped:\n${readonlyField.message}`,
    )
    ok('fill_form writes text, checkbox and select in one call')
    await run(navigateTool, { url: baseUrl }, sessionId)

    // ── stale ref detection ───────────────────────────────
    const withRow = String(
      expectData(await run(snapshotTool, {}, sessionId)).snapshot,
    )
    const deleteRef = refFor(withRow, 'button', 'Delete Alice')
    const recycleRef = refFor(withRow, 'button', 'Recycle row')
    await run(clickTool, { ref: recycleRef }, sessionId)

    const staleClick = await run(clickTool, { ref: deleteRef }, sessionId)
    assert.ok(
      typeof staleClick === 'string',
      'clicking a recycled row must fail rather than delete the wrong record',
    )
    assert.ok(staleClick.includes('Delete Bob'), staleClick)
    assert.ok(/new snapshot/i.test(staleClick), staleClick)
    ok('stale ref caught after DOM recycling')

    const rebuilt = String(
      expectData(await run(snapshotTool, {}, sessionId)).snapshot,
    )
    const bobRef = refFor(rebuilt, 'button', 'Delete Bob')
    assert.ok(expectData(await run(clickTool, { ref: bobRef }, sessionId)))
    ok('re-snapshot recovers the ref')

    // Playwright MCP: stale ref fails fast; model re-snapshots for a new ref.
    const applyHost = String(
      expectData(await run(snapshotTool, {}, sessionId)).snapshot,
    )
    await run(clickTool, { ref: refFor(applyHost, 'button', 'Rebuild apply') }, sessionId)
    const staleApply = await run(
      clickTool,
      { ref: refFor(applyHost, 'button', 'Apply changes') },
      sessionId,
    )
    assert.ok(
      typeof staleApply === 'string',
      'stale ref after DOM rebuild must fail rather than click the wrong node',
    )
    assert.ok(
      /snapshot|not found/i.test(staleApply),
      `stale ref error should point at a new snapshot:\n${staleApply}`,
    )
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
    ok('stale ref fails then fresh snapshot recovers')

    // ── occlusion: a click under a modal is refused, not lost ──
    const afterApply = String(
      expectData(await run(snapshotTool, {}, sessionId)).snapshot,
    )
    const underRef = refFor(afterApply, 'button', 'Confirm order')
    const covered = await run(clickTool, { ref: underRef }, sessionId)
    assert.ok(
      typeof covered === 'string',
      'a click blocked by a modal must come back as a recoverable error',
    )
    assert.ok(
      /modal|intercept|timeout|not visible|obscur|interactable|covered/i.test(covered),
      `blocker must be visible in the error:\n${covered}`,
    )
    ok('occluded click is refused with the blocker named')

    // ── hover ─────────────────────────────────────────────
    const hovered = expectData(
      await run(
        hoverTool,
        { ref: refFor(rebuilt, 'button', 'Hover me') },
        sessionId,
      ),
    )
    assert.equal(hovered.message, 'Hovered button "Hover me"')
    assert.ok(
      String(hovered.snapshot).includes('Hovered'),
      `mouseover did not fire:\n${hovered.snapshot}`,
    )
    ok('hover')

    // ── press_key ─────────────────────────────────────────
    const escaped = expectData(
      await run(pressKeyTool, { key: 'Escape' }, sessionId),
    )
    assert.equal(escaped.message, 'Pressed Escape')
    assert.ok(
      String(escaped.snapshot).includes('Last key: Escape'),
      `keydown did not reach the page:\n${escaped.snapshot}`,
    )
    const combo = expectData(
      await run(pressKeyTool, { key: 'k', modifiers: ['Control'] }, sessionId),
    )
    assert.equal(combo.message, 'Pressed Control+k')
    assert.ok(
      String(combo.snapshot).includes('Last key: Control+k'),
      `modifier was not applied:\n${combo.snapshot}`,
    )
    ok('press_key, with and without modifiers')

    // ── scroll ────────────────────────────────────────────
    const beforeScroll = String(
      expectData(await run(snapshotTool, {}, sessionId)).snapshot,
    )
    const bottomRef = refNear(beforeScroll, 'Bottom marker')
    await run(scrollTool, { ref: bottomRef, scrollIntoView: true }, sessionId)
    const afterScroll = String(
      expectData(await run(snapshotTool, {}, sessionId)).snapshot,
    )
    assert.ok(
      afterScroll.includes('Bottom marker'),
      `scrollIntoView must bring the bottom marker into the tree:\n${afterScroll}`,
    )
    await run(scrollTool, { deltaY: -2000 }, sessionId)
    ok('scroll')

    // ── screenshot ────────────────────────────────────────
    const shot = expectData(
      await run(screenshotTool, {}, sessionId, `${sessionId}-shot`),
    )
    assert.ok(shot.screenshotBase64, 'model must receive image data')
    const shotPath = String(shot.screenshotPath)
    assert.ok(fs.existsSync(shotPath), `screenshot not written to ${shotPath}`)
    assert.ok(fs.statSync(shotPath).size > 1000, 'screenshot looks empty')
    ok(`screenshot (${fs.statSync(shotPath).size} bytes)`)

    const elementShot = expectData(
      await run(
        screenshotTool,
        { ref: refFor(rebuilt, 'button', 'Recycle row') },
        sessionId,
        `${sessionId}-shot-el`,
      ),
    )
    assert.ok(elementShot.screenshotBase64)
    ok('element screenshot')

    // ── console tool ──────────────────────────────────────
    const logs = expectData(
      await run(consoleTool, { level: 'error' }, sessionId),
    )
    const entries = logs.consoleErrors as Array<{ text: string }>
    assert.ok(entries.some(e => e.text.includes('widget service unreachable')))
    ok('console tool')

    // ── network ───────────────────────────────────────────
    // The distinction that matters when debugging: reached the server and was
    // rejected, versus never left the browser.
    const netSnap = expectData(await run(snapshotTool, {}, sessionId))
    const page = String(netSnap.snapshot)

    await run(clickTool, { ref: refFor(page, 'button', 'Call ok') }, sessionId)
    await run(clickTool, { ref: refFor(page, 'button', 'Call xhr') }, sessionId)

    const all = expectData(await run(networkTool, {}, sessionId))
    const rows = all.network as Array<{
      method: string
      url: string
      status: number
      failed: boolean
      pending: boolean
    }>
    const okRow = rows.find(r => r.url.includes('/api/ok') && !r.url.includes('xhr'))
    assert.ok(okRow, `no fetch row for /api/ok in ${JSON.stringify(rows)}`)
    assert.equal(okRow.status, 200)
    assert.equal(okRow.method, 'GET')
    const xhrRow = rows.find(r => r.url.includes('via=xhr'))
    assert.ok(xhrRow, 'XHR requests must be captured too')
    assert.equal(xhrRow.status, 200)
    ok('network: fetch and XHR captured with status')

    // A 500 surfaces on the click that caused it, without asking separately.
    const boomClick = expectData(
      await run(
        clickTool,
        { ref: refFor(page, 'button', 'Call boom') },
        sessionId,
      ),
    )
    const onClick = (boomClick.network ?? []) as Array<{
      status: number
      method: string
      url: string
    }>
    assert.ok(
      onClick.some(r => r.status === 500 && r.method === 'POST'),
      `click should report the 500 it caused, got ${JSON.stringify(onClick)}`,
    )
    ok('network: failed request surfaces on the action that caused it')

    const deadClick = expectData(
      await run(
        clickTool,
        { ref: refFor(page, 'button', 'Call dead host') },
        sessionId,
      ),
    )
    const dead = ((deadClick.network ?? []) as Array<{
      failed: boolean
      status: number
      error: string
      url: string
    }>).find(r => r.url.includes('127.0.0.1:1'))
    assert.ok(dead, 'a request to a dead host must be reported')
    assert.equal(dead.failed, true)
    assert.equal(dead.status, 0, 'never-sent requests have no status')
    assert.ok(dead.error.length > 0, 'a failure needs a reason')
    ok('network: never-sent is distinguished from a server error')

    const onlyBad = expectData(
      await run(networkTool, { failedOnly: true }, sessionId),
    )
    const bad = onlyBad.network as Array<{ status: number; failed: boolean }>
    assert.ok(bad.length >= 2, 'failedOnly should keep the 500 and the dead host')
    assert.ok(
      bad.every(r => r.failed || r.status >= 400),
      'failedOnly must not return successful requests',
    )
    const filtered = expectData(
      await run(networkTool, { urlContains: 'via=xhr' }, sessionId),
    )
    assert.equal((filtered.network as unknown[]).length, 1)
    ok('network: failedOnly and urlContains filters')

    // ── navigating away resets refs ───────────────────────
    const other = expectData(
      await run(navigateTool, { url: `${baseUrl}other` }, sessionId),
    )
    assert.equal(other.title, 'Other')
    assert.ok(String(other.snapshot).includes('heading "Other page"'))
    const afterNav = await run(clickTool, { ref: counterRef }, sessionId)
    assert.ok(
      typeof afterNav === 'string' && afterNav.includes('snapshot'),
      'refs from the previous page must not resolve after navigation',
    )
    ok('navigation invalidates old refs')

    // ── distiller: wrappers collapse, selector, compact, scale ──
    const nested = expectData(
      await run(navigateTool, { url: `${baseUrl}nested` }, sessionId),
    )
    const nestedSnap = String(nested.snapshot)
    assert.ok(nestedSnap.includes('heading "Inbox"'), nestedSnap)
    assert.ok(
      !/generic "[^"]{80,}/.test(nestedSnap),
      `generic must not quote a long subtree name:\n${nestedSnap.slice(0, 1500)}`,
    )
    const genericRefs = nestedSnap
      .split('\n')
      .filter(l => l.includes('generic') && l.includes('[ref='))
    assert.ok(
      genericRefs.length <= 60,
      `wrapper chain must collapse; got ${genericRefs.length} generic refs`,
    )
    const alice = refForGeneric(nestedSnap, 'Alice: latest note')
    expectData(await run(clickTool, { ref: alice }, sessionId))
    ok('wrapper chain collapses to one generic ref per row')

    const panel = expectData(
      await run(
        snapshotTool,
        { selector: '#chat-panel' },
        sessionId,
      ),
    )
    const panelText = String(panel.snapshot)
    assert.ok(panelText.includes('Alice: latest note'), panelText)
    assert.ok(
      !panelText.includes('Ignore me'),
      `selector must not include the sidebar:\n${panelText}`,
    )
    assert.ok(
      !panelText.includes('heading "Inbox"'),
      `selector must start at the panel, not the page:\n${panelText}`,
    )
    ok('selector snapshots a subtree')

    const compact = expectData(
      await run(snapshotTool, { compact: true }, sessionId),
    )
    const compactText = String(compact.snapshot)
    const compactLines = compactText.split('\n').filter(Boolean)
    const fullLines = nestedSnap.split('\n').filter(Boolean)
    assert.ok(
      compactLines.length <= fullLines.length,
      `compact should not grow the tree (${compactLines.length} vs ${fullLines.length})`,
    )
    assert.ok(
      compactText.includes('[ref=') && compactText.includes('Alice: latest note'),
      `compact must keep the clickable row:\n${compactText.slice(0, 800)}`,
    )
    ok('compact drops structural wrappers')

    assert.ok(
      nestedSnap.length < 25_000,
      `50 nested rows must stay well under the char budget, got ${nestedSnap.length}`,
    )
    ok('distiller keeps a 50-row nested list small')

    const overflow = expectData(
      await run(navigateTool, { url: `${baseUrl}overflow` }, sessionId),
    )
    const overflowSnap = String(overflow.snapshot)
    assert.ok(
      overflow.snapshotTruncated === true || overflowSnap.length >= 15_000,
      `overflow page should fill the budget, got ${overflowSnap.length} truncated=${overflow.snapshotTruncated}`,
    )
    const dockRef = refForGeneric(overflowSnap, 'Chat dock')
    assert.ok(
      dockRef,
      `fixed chrome must survive truncation:\n${overflowSnap.slice(-800)}`,
    )
    ok('fixed overlay chrome is kept after a truncated snapshot')

    // ── tab lifecycle ─────────────────────────────────────
    // On the extension backend this is the path that creates and destroys tabs
    // in the user's real browser, so open/select/close all need to round-trip.
    type TabRow = { targetId: string; url: string; current?: boolean }
    const listed = expectData(
      await run(tabsTool, { action: 'list' }, sessionId),
    )
    const firstTabs = listed.tabs as TabRow[]
    assert.equal(firstTabs.length, 1, JSON.stringify(firstTabs))
    assert.ok(firstTabs[0].current, 'the only tab should be the current one')
    const originalId = firstTabs[0].targetId

    const opened = expectData(
      await run(tabsTool, { action: 'new', url: baseUrl }, sessionId),
    )
    const afterOpen = opened.tabs as TabRow[]
    assert.equal(afterOpen.length, 2, JSON.stringify(afterOpen))
    const newTab = afterOpen.find(t => t.targetId !== originalId)!
    assert.ok(newTab.current, 'a newly opened tab should become current')
    assert.ok(
      String(
        expectData(await run(snapshotTool, {}, sessionId)).snapshot,
      ).includes('heading "Dashboard"'),
      'snapshot should come from the newly opened tab',
    )
    ok('tabs: open a new tab and switch to it')

    const reselected = expectData(
      await run(tabsTool, { action: 'select', tabId: originalId }, sessionId),
    )
    assert.equal(reselected.message, `Selected tab ${originalId}`)
    assert.ok(
      (reselected.tabs as TabRow[]).find(t => t.targetId === originalId)
        ?.current,
    )
    ok('tabs: select')

    // ── input still lands after the tab has been backgrounded ──
    // Chrome drops Input.* aimed at a hidden tab, and opening the tab above
    // pushed this one behind it. That is also the state the extension backend
    // leaves every tab in, so this is the shape of the real-world failure: the
    // dispatch reports success and the page never hears about it.
    const revisited = expectData(
      await run(navigateTool, { url: baseUrl }, sessionId),
    )
    const bgRef = refFor(String(revisited.snapshot), 'button', 'Clicked 0 times')
    const bgClicked = expectData(await run(clickTool, { ref: bgRef }, sessionId))
    assert.ok(
      String(bgClicked.snapshot).includes('Clicked 1 times'),
      'a click on a backgrounded tab must still reach the page',
    )
    ok('input reaches a backgrounded tab')

    // ── wait_for (time / text / textGone) ──
    const waitNav = expectData(
      await run(navigateTool, { url: `${baseUrl}wait-text` }, sessionId),
    )
    const revealRef = refFor(String(waitNav.snapshot), 'button', 'Reveal')
    const afterReveal = expectData(
      await run(clickTool, { ref: revealRef }, sessionId),
    )
    assert.ok(
      !String(afterReveal.snapshot).includes('Message delivered'),
      `click settle (~500ms) must not wait out a 2s string:\n${afterReveal.snapshot}`,
    )
    const waited = expectData(
      await run(waitForTool, { text: 'Message delivered' }, sessionId),
    )
    assert.ok(
      String(waited.snapshot).includes('Message delivered'),
      `browser_wait_for text must snapshot once the string is visible:\n${waited.snapshot}`,
    )
    ok('wait_for text appears after click settle')

    const goneNav = expectData(
      await run(navigateTool, { url: `${baseUrl}wait-text` }, sessionId),
    )
    const goneRef = refFor(String(goneNav.snapshot), 'button', 'Reveal')
    await run(clickTool, { ref: goneRef }, sessionId)
    const gone = expectData(
      await run(waitForTool, { textGone: 'Loading now' }, sessionId),
    )
    assert.ok(
      !String(gone.snapshot).includes('Loading now'),
      `browser_wait_for textGone must snapshot after the string leaves:\n${gone.snapshot}`,
    )
    ok('wait_for textGone')

    const timed = expectData(
      await run(waitForTool, { time: 0.2 }, sessionId),
    )
    assert.ok(
      String(timed.snapshot).includes('Wait fixture'),
      `time-only wait_for must still return a snapshot:\n${timed.snapshot}`,
    )
    ok('wait_for time')

    const closed = expectData(
      await run(
        tabsTool,
        { action: 'close', tabId: newTab.targetId },
        sessionId,
      ),
    )
    const afterClose = closed.tabs as TabRow[]
    assert.equal(afterClose.length, 1, JSON.stringify(afterClose))
    assert.equal(afterClose[0].targetId, originalId)
    ok('tabs: close')

    const closeMissing = await run(
      tabsTool,
      { action: 'close', tabId: newTab.targetId },
      sessionId,
    )
    assert.ok(
      typeof closeMissing === 'string',
      'closing an already-closed tab must report an error, not succeed silently',
    )
    ok('tabs: closing a dead tab fails cleanly')
  } finally {
    setBrowserBackendFactory(null)
    await closeBrowser()
  }
}
