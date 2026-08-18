/**
 * Owns the single browser instance shared by every `browser_*` tool call, plus
 * the "current tab" the model operates on when it doesn't name one.
 *
 * Launching Chrome costs ~1s, so the instance is process-wide and torn down on
 * idle rather than per tool call — mirroring how MCP servers are pooled in
 * core/mcp-lifecycle.ts.
 */

import * as path from 'path'
import { resolveSettings } from '../core/settings-manager.js'
import { getUserAppDir } from '../utils/app-dir.js'
import { createExtensionBackend, getExtensionRelay } from './backends/extension.js'
import { createIsolatedBackend } from './backends/isolated.js'
import {
  attachExtensionPlaywright,
  detachPlaywright,
} from './playwright/connect.js'
import { startRelayServer, type RelayServer } from './relay/server.js'
import { DEFAULT_RELAY_PORT } from './relay/protocol.js'
import { onUserControlChange, resetSessionFlags } from './session-flags.js'
import { BrowserError, type BrowserBackend, type BrowserTab } from './types.js'

const IDLE_TTL_MS = 30 * 60 * 1000

interface Live {
  backend: BrowserBackend
  currentTargetId?: string
  lastUsed: number
}

let live: Live | null = null
let starting: Promise<Live> | null = null
let idleTimer: NodeJS.Timeout | null = null

/** Test seam: swap in a fake backend without launching Chrome. */
let backendFactory: (() => Promise<BrowserBackend>) | null = null

export function isBrowserLive(): boolean {
  return live != null
}

export function setBrowserBackendFactory(
  factory: (() => Promise<BrowserBackend>) | null,
): void {
  backendFactory = factory
}

function profileDir(): string {
  return path.join(getUserAppDir(), 'browser', 'profile')
}

function scheduleIdleSweep(ttlMs: number): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => {
    idleTimer = null
    if (!live) return
    if (Date.now() - live.lastUsed < ttlMs) {
      scheduleIdleSweep(ttlMs)
      return
    }
    void closeBrowser()
  }, ttlMs)
  idleTimer.unref?.()
}

/**
 * The relay outlives individual browser sessions: the extension reconnects on
 * its own schedule, and tearing the server down on idle would drop a pairing
 * the user already completed.
 */
let relay: RelayServer | null = null
let relayStarting: Promise<RelayServer> | null = null

onUserControlChange(hasControl => {
  relay?.notifyLock(hasControl)
})

export async function getRelay(port: number): Promise<RelayServer> {
  if (relay) return relay
  if (!relayStarting) {
    relayStarting = startRelayServer({ port }).finally(() => {
      relayStarting = null
    })
  }
  relay = await relayStarting
  return relay
}

async function createConfiguredBackend(cwd: string): Promise<BrowserBackend> {
  const config = resolveSettings(cwd).config.browser ?? {}

  if (config.mode === 'extension') {
    return createExtensionBackend({
      relay: await getRelay(config.relayPort ?? DEFAULT_RELAY_PORT),
    })
  }

  return createIsolatedBackend({
    userDataDir: profileDir(),
    headless: config.headless ?? true,
    channel: config.channel,
    viewport: {
      width: config.viewportWidth ?? 1280,
      height: config.viewportHeight ?? 800,
    },
  })
}

async function start(cwd: string): Promise<Live> {
  const config = resolveSettings(cwd).config.browser ?? {}

  const backend = backendFactory
    ? await backendFactory()
    : await createConfiguredBackend(cwd)

  if (backend.kind === 'extension') {
    const relay =
      getExtensionRelay(backend) ??
      (await getRelay(config.relayPort ?? DEFAULT_RELAY_PORT))
    await attachExtensionPlaywright(backend, relay)
  }

  const ttl = (config.idleTimeoutMinutes ?? 30) * 60 * 1000
  scheduleIdleSweep(Number.isFinite(ttl) && ttl > 0 ? ttl : IDLE_TTL_MS)

  return { backend, lastUsed: Date.now() }
}

export async function getBrowser(cwd: string): Promise<BrowserBackend> {
  if (live) {
    live.lastUsed = Date.now()
    return live.backend
  }
  // Concurrent first calls must not race two Chrome launches.
  if (!starting) {
    starting = start(cwd).finally(() => {
      starting = null
    })
  }
  live = await starting
  return live.backend
}

export async function closeBrowser(): Promise<void> {
  const current = live
  live = null
  if (idleTimer) {
    clearTimeout(idleTimer)
    idleTimer = null
  }
  if (current) {
    await detachPlaywright(current.backend).catch(() => {})
    await current.backend.dispose().catch(() => {})
  }
  resetSessionFlags()
}

/**
 * Resolve the tab a tool should act on: an explicit id, else the last tab the
 * model touched, else the only open tab. Opening one implicitly is deliberate —
 * the first `browser_navigate` of a session shouldn't need a separate call.
 */
export async function resolveTab(
  cwd: string,
  explicitTargetId?: string,
): Promise<{ backend: BrowserBackend; targetId: string }> {
  const backend = await getBrowser(cwd)
  const tabs = await backend.listTabs()

  if (explicitTargetId) {
    if (!tabs.some(t => t.targetId === explicitTargetId)) {
      throw new BrowserError(
        `No open tab with id "${explicitTargetId}". Use browser_tabs to list open tabs.`,
      )
    }
    setCurrentTab(explicitTargetId)
    return { backend, targetId: explicitTargetId }
  }

  const current = live?.currentTargetId
  if (current && tabs.some(t => t.targetId === current)) {
    return { backend, targetId: current }
  }

  if (tabs.length === 1) {
    setCurrentTab(tabs[0].targetId)
    return { backend, targetId: tabs[0].targetId }
  }

  if (tabs.length === 0) {
    const tab = await backend.createTab()
    setCurrentTab(tab.targetId)
    return { backend, targetId: tab.targetId }
  }

  // A leftover about:blank next to one real page is the usual leftover of
  // "create a tab, then the user shared another". Don't deadlock every tool
  // (including browser_tabs itself) behind a selection the model cannot make.
  const real = tabs.filter(t => t.url && t.url !== 'about:blank')
  if (real.length === 1) {
    setCurrentTab(real[0].targetId)
    return { backend, targetId: real[0].targetId }
  }

  throw new BrowserError(
    'No current tab. Call browser_navigate to the start URL — it opens a fresh tab. Do not select a leftover tab from a previous task.',
  )
}

export function setCurrentTab(targetId: string): void {
  if (live) {
    live.currentTargetId = targetId
    live.lastUsed = Date.now()
  }
}

export function getCurrentTabId(): string | undefined {
  return live?.currentTargetId
}

export async function openTab(cwd: string, url?: string): Promise<BrowserTab> {
  const backend = await getBrowser(cwd)
  const tab = await backend.createTab(url)
  setCurrentTab(tab.targetId)
  return tab
}

export function initBrowserLifecycle(cwd: string = process.cwd()): void {
  process.on('exit', () => {
    void closeBrowser()
    void relay?.close()
  })

  // In extension mode the relay comes up with the agent rather than on first
  // tool call: pairing is something the user checks in the popup before asking
  // for anything, and a relay that only exists mid-request reads as broken.
  //
  // AUTH_ENABLED boot has no request scope — resolveSettings → getAgentHome()
  // throws. Skip eager relay; getBrowser() still starts the backend on first
  // tool call (SSO does not use extension mode).
  let config: { mode?: string; relayPort?: number } = {}
  try {
    config = resolveSettings(cwd).config.browser ?? {}
  } catch (err) {
    console.warn(
      `[browser] skip eager relay start: ${err instanceof Error ? err.message : err}`,
    )
    return
  }
  if (config.mode === 'extension') {
    const port = config.relayPort ?? DEFAULT_RELAY_PORT
    void getRelay(port)
      .then(() => {
        console.log(`[browser] extension relay listening on 127.0.0.1:${port}`)
      })
      .catch((err: Error) => {
        console.error(`[browser] ${err.message}`)
      })
  }
}
