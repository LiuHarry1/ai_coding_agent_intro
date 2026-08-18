/**
 * Baize agent browser bridge — service worker.
 *
 * Deliberately thin: it owns the socket, decides *which tabs the agent may
 * touch*, and forwards everything else straight to `chrome.debugger`. All the
 * intelligence (accessibility snapshots, refs, staleness) lives in the agent
 * and arrives as ordinary CDP commands, so this file should almost never need
 * to change.
 *
 * Consent model: the agent can only see and drive tabs it opened itself, plus
 * tabs the user explicitly shares from the popup. It cannot enumerate or read
 * the rest of the browser. Agent tabs are collected into a labelled tab group
 * so it is always visible which ones they are, and Chrome's own "is debugging
 * this browser" banner appears whenever a tab is attached.
 */

const DEFAULT_PORT = 8766
const PROTOCOL_VERSION = 1
const GROUP_TITLE = 'Agent'
const KEEPALIVE_ALARM = 'relay-keepalive'

let socket = null
let reconnectTimer = null
let reconnectDelay = 1000
/** Tab ids with a live chrome.debugger session. */
const attached = new Set()
/** Tab ids the agent is allowed to act on. */
let owned = new Set()
let agentGroupId = null

// ── ownership ────────────────────────────────────────────

async function loadOwned() {
  const { ownedTabs } = await chrome.storage.session.get('ownedTabs')
  owned = new Set(Array.isArray(ownedTabs) ? ownedTabs : [])
}

async function saveOwned() {
  await chrome.storage.session.set({ ownedTabs: [...owned] })
}

async function addOwned(tabId) {
  owned.add(tabId)
  await saveOwned()
  await groupTab(tabId)
}

async function dropOwned(tabId) {
  owned.delete(tabId)
  await saveOwned()
}

function assertOwned(tabId) {
  if (!owned.has(tabId)) {
    throw new Error(
      `Tab ${tabId} is not shared with the agent. Open it with browser_tabs, ` +
        'or share it from the extension popup.',
    )
  }
}

/**
 * Keep agent tabs in one labelled group. Purely a visibility affordance — if
 * grouping fails (e.g. the tab is in a different window) it must not break the
 * operation the user actually asked for.
 */
async function groupTab(tabId) {
  try {
    if (agentGroupId !== null) {
      try {
        await chrome.tabGroups.get(agentGroupId)
      } catch {
        agentGroupId = null
      }
    }
    const groupId = await chrome.tabs.group(
      agentGroupId === null
        ? { tabIds: [tabId] }
        : { tabIds: [tabId], groupId: agentGroupId },
    )
    if (agentGroupId !== groupId) {
      agentGroupId = groupId
      await chrome.tabGroups.update(groupId, {
        title: GROUP_TITLE,
        color: 'orange',
      })
    }
  } catch {
    // Non-fatal.
  }
}

// ── debugger ─────────────────────────────────────────────

async function ensureAttached(tabId) {
  if (attached.has(tabId)) return
  await chrome.debugger.attach({ tabId }, '1.3')
  attached.add(tabId)
}

async function detach(tabId) {
  if (!attached.has(tabId)) return
  attached.delete(tabId)
  try {
    await chrome.debugger.detach({ tabId })
  } catch {
    // Already gone.
  }
}

async function detachAll() {
  await Promise.all([...attached].map(detach))
}

chrome.debugger.onDetach.addListener(source => {
  // Fires when the user dismisses Chrome's debugging banner, among others.
  if (source.tabId != null) attached.delete(source.tabId)
})

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (socket?.readyState !== WebSocket.OPEN || source.tabId == null) return
  socket.send(
    JSON.stringify({
      type: 'cdpEvent',
      targetId: String(source.tabId),
      method,
      params,
      ...(source.sessionId ? { sessionId: source.sessionId } : {}),
    }),
  )
})

chrome.tabs.onRemoved.addListener(tabId => {
  attached.delete(tabId)
  if (owned.delete(tabId)) void saveOwned()
})

// ── request handlers ─────────────────────────────────────

function describe(tab) {
  return {
    targetId: String(tab.id),
    url: tab.url ?? '',
    title: tab.title ?? '',
  }
}

async function listTabs() {
  const out = []
  const stale = []
  for (const tabId of owned) {
    try {
      out.push(describe(await chrome.tabs.get(tabId)))
    } catch {
      stale.push(tabId)
    }
  }
  if (stale.length) {
    for (const id of stale) owned.delete(id)
    await saveOwned()
  }
  return out
}

async function createTab(url) {
  // Background tab: the agent working should never steal the user's focus.
  const tab = await chrome.tabs.create({
    url: url || 'about:blank',
    active: false,
  })
  await addOwned(tab.id)
  if (url) await waitForCommit(tab.id)
  return describe(await chrome.tabs.get(tab.id))
}

/** Resolve once the tab has left about:blank, so callers see a real url. */
async function waitForCommit(tabId, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId)
    if (tab.status === 'complete' || (tab.url && tab.url !== 'about:blank'))
      return
    await new Promise(r => setTimeout(r, 100))
  }
}

async function closeTab(targetId) {
  const tabId = Number(targetId)
  assertOwned(tabId)
  await detach(tabId)
  await dropOwned(tabId)
  await chrome.tabs.remove(tabId)
  return true
}

async function cdp(targetId, cdpMethod, params, sessionId) {
  const tabId = Number(targetId)
  assertOwned(tabId)
  await ensureAttached(tabId)
  try {
    const debuggee = sessionId ? { tabId, sessionId } : { tabId }
    const result = await chrome.debugger.sendCommand(
      debuggee,
      cdpMethod,
      params ?? {},
    )
    // Commands with an empty reply resolve to undefined; the host expects JSON.
    return result ?? {}
  } catch (err) {
    const message = err?.message ?? String(err)
    if (
      /Detached while handling command|Debugger is not attached/i.test(message)
    ) {
      // A navigation or a dismissed banner can drop the session mid-command.
      attached.delete(tabId)
      throw new Error(
        `Lost the debugger session for tab ${tabId} (${message}). Retry the action.`,
      )
    }
    throw new Error(`${cdpMethod} failed: ${message}`)
  }
}

async function handle(req) {
  switch (req.method) {
    case 'tabs.list':
      return listTabs()
    case 'tabs.create':
      return createTab(req.url)
    case 'tabs.close':
      return closeTab(req.targetId)
    case 'cdp':
      return cdp(req.targetId, req.cdpMethod, req.params, req.sessionId)
    default:
      throw new Error(`Unknown relay method: ${req.method}`)
  }
}

// ── socket ───────────────────────────────────────────────

async function getConfig() {
  const { token, port } = await chrome.storage.local.get(['token', 'port'])
  return { token: token || '', port: Number(port) || DEFAULT_PORT }
}

async function setStatus(status, detail) {
  await chrome.storage.local.set({ status, statusDetail: detail ?? '' })
  try {
    await chrome.action.setBadgeText({
      text: status === 'connected' ? '\u25CF' : '',
    })
    await chrome.action.setBadgeBackgroundColor({ color: '#2ea043' })
  } catch {
    // Badge is cosmetic.
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    void connect()
  }, reconnectDelay)
  // Capped low: a loopback connect attempt is nearly free, and the alternative
  // is the user starting the agent and waiting half a minute to see "connected".
  reconnectDelay = Math.min(reconnectDelay * 2, 5_000)
}

async function connect() {
  const { token, port } = await getConfig()
  if (!token) {
    await setStatus('unpaired', 'Paste the pairing token below.')
    return
  }
  if (
    socket &&
    (socket.readyState === WebSocket.OPEN ||
      socket.readyState === WebSocket.CONNECTING)
  ) {
    return
  }

  let ws
  try {
    ws = new WebSocket(`ws://127.0.0.1:${port}`)
  } catch {
    await setStatus('disconnected', `Cannot reach 127.0.0.1:${port}`)
    scheduleReconnect()
    return
  }
  socket = ws

  ws.addEventListener('open', () => {
    ws.send(
      JSON.stringify({
        type: 'hello',
        token,
        version: PROTOCOL_VERSION,
        browser: navigator.userAgent,
      }),
    )
  })

  ws.addEventListener('message', async event => {
    let msg
    try {
      msg = JSON.parse(event.data)
    } catch {
      return
    }

    if (msg.type === 'welcome') {
      reconnectDelay = 1000
      await setStatus('connected', `Agent on port ${port}`)
      return
    }
    if (msg.type === 'lockState') {
      await chrome.storage.local.set({
        userHasControl: Boolean(msg.userHasControl),
      })
      return
    }
    if (typeof msg.id !== 'number') return

    try {
      const result = await handle(msg)
      ws.send(JSON.stringify({ id: msg.id, ok: true, result }))
    } catch (err) {
      ws.send(
        JSON.stringify({
          id: msg.id,
          ok: false,
          error: err?.message ?? String(err),
        }),
      )
    }
  })

  ws.addEventListener('close', async event => {
    if (socket === ws) socket = null
    await detachAll()
    if (event.code === 1008) {
      await setStatus('rejected', 'Pairing token was rejected.')
      return // Reconnecting with a bad token would just loop.
    }
    await setStatus('disconnected', `Lost connection to 127.0.0.1:${port}`)
    scheduleReconnect()
  })

  ws.addEventListener('error', () => {
    // 'close' follows and handles state.
  })
}

// MV3 terminates idle service workers. Socket traffic resets that timer, and
// the alarm covers the gaps between agent requests.
chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.4 })
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name !== KEEPALIVE_ALARM) return
  if (socket?.readyState === WebSocket.OPEN)
    socket.send(JSON.stringify({ type: 'ping' }))
  else void connect()
})

chrome.runtime.onStartup.addListener(() => void boot())
chrome.runtime.onInstalled.addListener(() => void boot())

// Pairing is expressed purely as stored credentials, so writing them — from the
// popup or anywhere else — is what makes a new pairing take effect.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || (!changes.token && !changes.port)) return
  reconnectDelay = 1000
  if (socket) {
    socket.close(1000, 're-pairing')
    socket = null
  }
  void connect()
})

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  ;(async () => {
    switch (msg?.type) {
      case 'get-state': {
        const { status, statusDetail, token, port, userHasControl } =
          await chrome.storage.local.get([
            'status',
            'statusDetail',
            'token',
            'port',
            'userHasControl',
          ])
        sendResponse({
          status: status ?? 'disconnected',
          statusDetail: statusDetail ?? '',
          hasToken: Boolean(token),
          port: Number(port) || DEFAULT_PORT,
          tabs: await listTabs(),
          userHasControl: Boolean(userHasControl),
        })
        return
      }
      case 'share-active-tab': {
        const [tab] = await chrome.tabs.query({
          active: true,
          currentWindow: true,
        })
        if (!tab?.id) {
          sendResponse({ ok: false, error: 'No active tab.' })
          return
        }
        await addOwned(tab.id)
        sendResponse({ ok: true, tab: describe(tab) })
        return
      }
      case 'unshare': {
        const tabId = Number(msg.targetId)
        await detach(tabId)
        await dropOwned(tabId)
        sendResponse({ ok: true })
        return
      }
      case 'set-user-control': {
        const hasControl = Boolean(msg.hasControl)
        await chrome.storage.local.set({ userHasControl: hasControl })
        if (socket?.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: 'userControl', hasControl }))
        }
        sendResponse({ ok: true, userHasControl: hasControl })
        return
      }
      default:
        sendResponse({ ok: false, error: 'unknown message' })
    }
  })()
  return true // async sendResponse
})

async function boot() {
  await loadOwned()
  await connect()
}

void boot()
