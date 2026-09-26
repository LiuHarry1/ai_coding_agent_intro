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

import { generatePairingToken, pairingProof, sameProof } from './pairing.js'

const PROTOCOL_VERSION = 2
const GROUP_TITLE = 'Agent'
const KEEPALIVE_ALARM = 'relay-keepalive'
/**
 * How long to keep dialling a relay that will not answer. The endpoint is
 * per-agent-process, so once that process is gone the URL is dead forever and
 * retrying is pure noise — but a service worker restart or a brief hiccup must
 * not lose a connection the user already approved.
 */
const GIVE_UP_AFTER_MS = 2 * 60 * 1000

let socket = null
let reconnectTimer = null
let reconnectDelay = 1000
let firstFailureAt = null
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

/** In-flight attaches, so concurrent commands to a fresh tab share one attach. */
const attaching = new Map()

async function recoverExistingAttachment(tabId) {
  try {
    const targets = await chrome.debugger.getTargets()
    if (!targets.some(target => target.tabId === tabId && target.attached))
      return false
    // A Service Worker restart clears our in-memory Set but Chrome can retain
    // this extension's debugger attachment. A harmless command distinguishes
    // that session from a tab attached by DevTools or another extension.
    await chrome.debugger.sendCommand(
      { tabId },
      'Runtime.evaluate',
      { expression: 'void 0' },
    )
    attached.add(tabId)
    return true
  } catch {
    return false
  }
}

async function ensureAttached(tabId) {
  if (attached.has(tabId)) return
  let pending = attaching.get(tabId)
  if (!pending) {
    pending = (async () => {
      if (await recoverExistingAttachment(tabId)) return
      try {
        await chrome.debugger.attach({ tabId }, '1.3')
        attached.add(tabId)
      } catch (err) {
        if (await recoverExistingAttachment(tabId)) return
        throw err
      }
    })().finally(() => attaching.delete(tabId))
    attaching.set(tabId, pending)
  }
  await pending
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

const REATTACH_DELAY_MS = 150
const REATTACH_COOLDOWN_MS = 3000
/** Tabs re-attached recently, so a user repeatedly dismissing the banner wins. */
const recentReattach = new Set()

/**
 * Come back after an unexpected detach. Commands would recover on their own
 * through `ensureAttached`, but CDP *events* stop the moment the session drops
 * and the Playwright engine on the host side is listening to them, so waiting
 * for the next command is not good enough.
 */
function scheduleReattach(tabId) {
  if (!owned.has(tabId) || recentReattach.has(tabId)) return
  recentReattach.add(tabId)
  setTimeout(() => recentReattach.delete(tabId), REATTACH_COOLDOWN_MS)
  setTimeout(async () => {
    if (!owned.has(tabId) || attached.has(tabId)) return
    if (socket?.readyState !== WebSocket.OPEN) return
    try {
      await ensureAttached(tabId)
    } catch {
      // The tab is gone, or the user refused. Either way, stop here.
    }
  }, REATTACH_DELAY_MS)
}

chrome.debugger.onDetach.addListener(source => {
  // Fires when the user dismisses Chrome's debugging banner, among others.
  if (source.tabId == null) return
  attached.delete(source.tabId)
  scheduleReattach(source.tabId)
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

chrome.tabs.onCreated.addListener(tab => {
  const createdUrl = tab.pendingUrl || tab.url || ''
  if (
    tab.id == null ||
    tab.openerTabId == null ||
    !owned.has(tab.openerTabId) ||
    createdUrl.startsWith(`chrome-extension://${chrome.runtime.id}/`)
  ) {
    return
  }
  void (async () => {
    await addOwned(tab.id)
    try {
      await chrome.tabs.get(tab.id)
    } catch {
      // A popup can close itself before storage/grouping finishes.
      await dropOwned(tab.id)
    }
  })()
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

async function getActiveUserTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab?.id) return null
  return describe(tab)
}

async function focusTab(targetId, level) {
  const tabId = Number(targetId)
  assertOwned(tabId)
  await chrome.tabs.update(tabId, { active: true })
  if (level === 'window') {
    const tab = await chrome.tabs.get(tabId)
    if (tab.windowId != null) {
      await chrome.windows.update(tab.windowId, { focused: true })
    }
  }
}

async function restoreTab(targetId) {
  const tabId = Number(targetId)
  try {
    await chrome.tabs.get(tabId)
  } catch {
    return
  }
  await chrome.tabs.update(tabId, { active: true })
}

// ── downloads ────────────────────────────────────────────

/** Stay under the host's 30s relay request timeout. */
const DOWNLOAD_WAIT_CAP_MS = 25000
const DOWNLOAD_POLL_MS = 250

/** Download ids already handed to the agent, so two waits never share one. */
const claimedDownloads = new Set()

/**
 * The site's own file name per download id. item.filename is the path Chrome
 * finally wrote, which gets " (1)" appended when ~/Downloads already has one.
 */
const suggestedNames = new Map()
const SUGGESTED_NAMES_CAP = 200

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  suggestedNames.set(item.id, item.filename)
  if (suggestedNames.size > SUGGESTED_NAMES_CAP) {
    suggestedNames.delete(suggestedNames.keys().next().value)
  }
  // No argument: keep Chrome's default name and conflict handling.
  suggest()
})

function originOf(url) {
  try {
    return new URL(url).origin
  } catch {
    return ''
  }
}

/**
 * chrome.downloads items carry no tab id, so attribute them by origin: the
 * file URL itself (blob: URLs keep their page origin) or the referrer. With no
 * referrer there is nothing to contradict the match, so it is accepted.
 */
function startedByPage(item, pageOrigin) {
  if (!pageOrigin || pageOrigin === 'null') return true
  if (originOf(item.finalUrl || item.url) === pageOrigin) return true
  return !item.referrer || originOf(item.referrer) === pageOrigin
}

/**
 * Resolve with the first download this tab's page started at or after `since`
 * once Chrome has finished writing it, or null when none finished in time.
 */
async function waitForDownload(targetId, since, timeoutMs) {
  const tabId = Number(targetId)
  assertOwned(tabId)
  const deadline = Date.now() + Math.min(timeoutMs, DOWNLOAD_WAIT_CAP_MS)
  let id = null
  while (Date.now() < deadline) {
    if (id == null) {
      const tab = await chrome.tabs.get(tabId)
      const pageOrigin = originOf(tab.url ?? '')
      const items = await chrome.downloads.search({
        startedAfter: new Date(since).toISOString(),
        orderBy: ['startTime'],
      })
      const hit = items.find(
        item => !claimedDownloads.has(item.id) && startedByPage(item, pageOrigin),
      )
      if (hit) {
        id = hit.id
        claimedDownloads.add(id)
      }
    }
    if (id != null) {
      const [item] = await chrome.downloads.search({ id })
      if (!item) {
        throw new Error(
          "The download was removed from Chrome's download list before it finished.",
        )
      }
      if (item.state === 'complete') {
        const suggestedName = suggestedNames.get(id)
        suggestedNames.delete(id)
        return {
          url: item.finalUrl || item.url,
          filename: item.filename,
          ...(suggestedName ? { suggestedName } : {}),
        }
      }
      if (item.state === 'interrupted') {
        throw new Error(`The download was interrupted: ${item.error ?? 'unknown reason'}.`)
      }
    }
    await new Promise(r => setTimeout(r, DOWNLOAD_POLL_MS))
  }
  return null
}

// ── reflective chrome.* invocation ───────────────────────

/**
 * chrome.* calls the agent may make, and where each one's tab id sits in the
 * positional argument list. Every entry is ownership-checked before it runs,
 * so reflection never widens what the agent can reach: adding a capability is
 * a line here rather than another branch through the whole stack.
 */
const ALLOWED_CHROME_COMMANDS = {
  'chrome.debugger.attach': args => args[0]?.tabId,
  'chrome.debugger.detach': args => args[0]?.tabId,
  'chrome.debugger.sendCommand': args => args[0]?.tabId,
}

/**
 * Methods that cannot be a plain forward. Either they carry the ownership
 * bookkeeping itself (create/close), or they deliberately act on a tab the
 * agent does *not* own (getActiveUserTab, restore — that is the point of
 * handing focus back to the user).
 */
const SEMANTIC_METHODS = [
  'tabs.list',
  'tabs.create',
  'tabs.close',
  'tabs.getActiveUserTab',
  'tabs.focus',
  'tabs.restore',
  'downloads.wait',
]

/** Announced in `hello` so the host can branch at handshake time. */
const CAPABILITIES = [
  ...SEMANTIC_METHODS,
  ...Object.keys(ALLOWED_CHROME_COMMANDS),
]

/** Walk `chrome.a.b.c` down to `{ obj: chrome.a.b, name: 'c' }`. */
function resolveChromeMember(fullMethod) {
  const parts = fullMethod.split('.')
  let obj = chrome
  for (let i = 1; i < parts.length - 1; i++) {
    obj = obj?.[parts[i]]
    if (obj === undefined) {
      throw new Error(`Unknown chrome path: ${parts.slice(0, i + 1).join('.')}`)
    }
  }
  return { obj, name: parts[parts.length - 1] }
}

async function invokeChrome(method, args) {
  const tabIdOf = ALLOWED_CHROME_COMMANDS[method]
  const tabId = tabIdOf(args)
  if (typeof tabId !== 'number') {
    throw new Error(`${method} needs a numeric tab id in its first argument`)
  }
  assertOwned(tabId)
  // Attaching on demand keeps the host from having to track debugger state
  // that only the browser really knows.
  if (method === 'chrome.debugger.sendCommand') await ensureAttached(tabId)

  const { obj, name } = resolveChromeMember(method)
  try {
    const result = await obj[name].apply(obj, args)
    if (method === 'chrome.debugger.attach') attached.add(tabId)
    if (method === 'chrome.debugger.detach') attached.delete(tabId)
    // Commands with an empty reply resolve to undefined; the host expects JSON.
    return result ?? {}
  } catch (err) {
    const message = err?.message ?? String(err)
    if (
      /Detached while handling command|Debugger is not attached/i.test(message)
    ) {
      // A navigation or a dismissed banner can drop the session mid-command.
      attached.delete(tabId)
      scheduleReattach(tabId)
      throw new Error(
        `Lost the debugger session for tab ${tabId} (${message}). Retry the action.`,
      )
    }
    throw new Error(`${method} failed: ${message}`)
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
    case 'tabs.getActiveUserTab':
      return getActiveUserTab()
    case 'tabs.focus':
      return focusTab(req.targetId, req.level)
    case 'tabs.restore':
      return restoreTab(req.targetId)
    case 'downloads.wait':
      return waitForDownload(req.targetId, req.since, req.timeoutMs)
    default:
      if (ALLOWED_CHROME_COMMANDS[req.method]) {
        return invokeChrome(req.method, req.params ?? [])
      }
      throw new Error(`Unknown relay method: ${req.method}`)
  }
}

// ── socket ───────────────────────────────────────────────

function relayHost(relayUrl) {
  try {
    return new URL(relayUrl).host
  } catch {
    return relayUrl
  }
}

const RECOVERABLE_RELAY_URL_KEY = 'recoverableRelayUrl'

/**
 * Keep the live value in session storage, with a private local fallback so an
 * extension or browser restart can reconnect while the same agent is alive.
 * The URL is an unguessable loopback capability private to this extension;
 * a dead fallback is removed by giveUp() after the bounded reconnect window.
 */
async function getRelayUrl() {
  const { relayUrl } = await chrome.storage.session.get('relayUrl')
  if (typeof relayUrl === 'string' && relayUrl) return relayUrl
  const stored = await chrome.storage.local.get(RECOVERABLE_RELAY_URL_KEY)
  const recoverable = stored[RECOVERABLE_RELAY_URL_KEY]
  if (typeof recoverable !== 'string' || !recoverable) return ''
  return recoverable
}

async function rememberRelayUrl(relayUrl) {
  await Promise.all([
    chrome.storage.session.set({ relayUrl }),
    chrome.storage.local.set({ [RECOVERABLE_RELAY_URL_KEY]: relayUrl }),
  ])
}

async function forgetRelayUrl() {
  await Promise.all([
    chrome.storage.session.remove('relayUrl'),
    chrome.storage.local.remove(RECOVERABLE_RELAY_URL_KEY),
  ])
}

// ── auto-connect token ───────────────────────────────────

/**
 * Local storage on purpose, unlike the relay url: this is the standing grant
 * the user copies into the agent's config, so it has to survive restarts.
 * Regenerating it is how the user revokes it.
 */
async function getPairingToken() {
  const { pairingToken } = await chrome.storage.local.get('pairingToken')
  if (typeof pairingToken === 'string' && pairingToken) return pairingToken
  return regeneratePairingToken()
}

async function regeneratePairingToken() {
  const pairingToken = generatePairingToken()
  await chrome.storage.local.set({ pairingToken })
  return pairingToken
}

/**
 * Close the connect tab once it has done its job — unless it is the only tab
 * in its window. That happens when the agent had to start Chrome itself, and
 * closing the last window can take the whole browser down with it.
 */
async function closeConnectTab(tab) {
  if (tab?.id == null) return false
  try {
    const siblings = await chrome.tabs.query({ windowId: tab.windowId })
    if (siblings.length <= 1) return false
    await chrome.tabs.remove(tab.id)
    return true
  } catch {
    return false
  }
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
  if (firstFailureAt === null) firstFailureAt = Date.now()
  if (Date.now() - firstFailureAt > GIVE_UP_AFTER_MS) {
    void giveUp()
    return
  }
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    void connect()
  }, reconnectDelay)
  // Capped low: a loopback connect attempt is nearly free, and the alternative
  // is the user starting the agent and waiting half a minute to see "connected".
  reconnectDelay = Math.min(reconnectDelay * 2, 5_000)
}

async function giveUp() {
  firstFailureAt = null
  reconnectDelay = 1000
  await forgetRelayUrl()
  await setStatus(
    'disconnected',
    'The agent is no longer reachable. Ask it to connect again.',
  )
}

async function connect() {
  const relayUrl = await getRelayUrl()
  if (!relayUrl) {
    await setStatus('disconnected', 'Waiting for the agent to ask for access.')
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
    ws = new WebSocket(relayUrl)
  } catch {
    await setStatus('disconnected', `Cannot reach ${relayHost(relayUrl)}`)
    scheduleReconnect()
    return
  }
  socket = ws

  ws.addEventListener('open', () => {
    ws.send(
      JSON.stringify({
        type: 'hello',
        version: PROTOCOL_VERSION,
        browser: navigator.userAgent,
        capabilities: [...CAPABILITIES],
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
      firstFailureAt = null
      await setStatus('connected', `Agent on ${relayHost(relayUrl)}`)
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
      // The agent refused the handshake itself, which in practice means this
      // build is older than it is. Retrying changes nothing.
      await forgetRelayUrl()
      await setStatus(
        'rejected',
        'The agent rejected this connection. Reload this extension from chrome://extensions.',
      )
      return
    }
    await setStatus('disconnected', `Lost connection to ${relayHost(relayUrl)}`)
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

// The stored relay url *is* the connection request, so writing it — from the
// connect page or anywhere else — is what makes a new one take effect.
chrome.storage.onChanged.addListener((changes, area) => {
  // Only a new value is a request to connect. Clearing the key is how we give
  // up, and reacting to that would immediately overwrite the reason we did.
  if (area !== 'session' || !changes.relayUrl?.newValue) return
  reconnectDelay = 1000
  firstFailureAt = null
  if (socket) {
    socket.close(1000, 'reconnecting to a new agent')
    socket = null
  }
  void connect()
})

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  ;(async () => {
    switch (msg?.type) {
      case 'connect': {
        if (typeof msg.relayUrl !== 'string' || !msg.relayUrl) {
          sendResponse({ ok: false, error: 'No relay url supplied.' })
          return
        }
        // Writing it is enough; the storage listener above opens the socket.
        await rememberRelayUrl(msg.relayUrl)
        sendResponse({ ok: true })
        return
      }
      case 'connect-with-proof': {
        // Verified here rather than in the page so the token never leaves
        // the service worker except to be shown in the popup.
        if (typeof msg.relayUrl !== 'string' || !msg.relayUrl) {
          sendResponse({ ok: false, error: 'No relay url supplied.' })
          return
        }
        const expected = await pairingProof(
          await getPairingToken(),
          msg.relayUrl,
        )
        if (!sameProof(expected, msg.proof)) {
          sendResponse({
            ok: false,
            mismatch: true,
            error:
              "The agent's auto-connect token does not match this browser. " +
              'Copy the token from the extension popup into browser.extensionToken ' +
              '(or AGENT_BROWSER_EXTENSION_TOKEN) and restart the agent.',
          })
          return
        }
        await rememberRelayUrl(msg.relayUrl)
        sendResponse({ ok: true, closed: await closeConnectTab(sender.tab) })
        return
      }
      case 'get-pairing-token': {
        sendResponse({ ok: true, token: await getPairingToken() })
        return
      }
      case 'regenerate-pairing-token': {
        sendResponse({ ok: true, token: await regeneratePairingToken() })
        return
      }
      case 'get-state': {
        const { status, statusDetail, userHasControl } =
          await chrome.storage.local.get([
            'status',
            'statusDetail',
            'userHasControl',
          ])
        sendResponse({
          status: status ?? 'disconnected',
          statusDetail: statusDetail ?? '',
          relayHost: relayHost(await getRelayUrl()),
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
  await getPairingToken()
  await connect()
}

void boot()
