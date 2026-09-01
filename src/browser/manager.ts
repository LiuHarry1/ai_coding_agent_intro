/**
 * Owns Chrome instances used by `browser_*` tools, plus the current tab when
 * the model does not name one.
 *
 * Isolated Chrome is one process per chat session. Extension mode shares the
 * user's Chrome (and the relay) but keeps current-tab and lock per session.
 * Launching Chrome costs ~1s, so each bucket is torn down on idle rather than
 * per tool call.
 */

import { createHash } from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import { resolveSettings } from '../core/settings-manager.js'
import { getUserAppDir } from '../utils/app-dir.js'
import { createExtensionBackend, getExtensionRelay } from './backends/extension.js'
import { createIsolatedBackend } from './backends/isolated.js'
import { isSafePathSegment } from './fs-safe/safe-path-segment.js'
import { freshIsolatedProfileDir } from './paths.js'
import {
  attachExtensionPlaywright,
  detachPlaywright,
} from './playwright/connect.js'
import { applyFocusConfig, flushTabRestore } from './playwright/focus.js'
import { startRelayServer, type RelayServer } from './relay/server.js'
import { DEFAULT_RELAY_PORT } from './relay/protocol.js'
import {
  clearTabMemory,
  DEFAULT_BROWSER_SESSION_KEY,
  onUserControlChange,
  resetSessionFlags,
} from './session-flags.js'
import { BrowserError, type BrowserBackend, type BrowserTab } from './types.js'

const IDLE_TTL_MS = 30 * 60 * 1000

export interface BrowserHandoff {
  targetId: string
  url: string
  title: string
}

interface Live {
  key: string
  backend: BrowserBackend
  currentTargetId?: string
  lastUsed: number
  lastUrl?: string
  lastTitle?: string
  ephemeralProfileDir?: string
  ownsBackend: boolean
  idleTimer: NodeJS.Timeout | null
  idleTtlMs: number
}

const lives = new Map<string, Live>()
const starting = new Map<string, Promise<Live>>()

interface SharedExtension {
  backend: BrowserBackend
  users: Set<string>
}

let sharedExtension: SharedExtension | null = null
let sharedExtensionStarting: Promise<BrowserBackend> | null = null

/** Test seam: swap in a fake backend without launching Chrome. */
let backendFactory: (() => Promise<BrowserBackend>) | null = null

export function browserSessionKey(sessionId?: string): string {
  return sessionId && sessionId.length > 0
    ? sessionId
    : DEFAULT_BROWSER_SESSION_KEY
}

function persistProfileDir(sessionKey: string): string {
  return path.join(getUserAppDir(), 'browser', 'profiles', profileSegment(sessionKey))
}

function profileSegment(sessionKey: string): string {
  if (isSafePathSegment(sessionKey)) return sessionKey
  return createHash('sha256').update(sessionKey).digest('hex').slice(0, 16)
}

export function isBrowserLive(sessionId?: string): boolean {
  if (sessionId) return lives.has(browserSessionKey(sessionId))
  return lives.size > 0
}

export function setBrowserBackendFactory(
  factory: (() => Promise<BrowserBackend>) | null,
): void {
  backendFactory = factory
}

function scheduleIdleSweep(live: Live): void {
  if (live.idleTimer) clearTimeout(live.idleTimer)
  live.idleTimer = setTimeout(() => {
    live.idleTimer = null
    if (Date.now() - live.lastUsed < live.idleTtlMs) {
      scheduleIdleSweep(live)
      return
    }
    void closeBrowser(live.key)
  }, live.idleTtlMs)
  live.idleTimer.unref?.()
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

async function createIsolatedConfigured(
  cwd: string,
  sessionKey: string,
): Promise<{ backend: BrowserBackend; ephemeralProfileDir?: string }> {
  const config = resolveSettings(cwd).config.browser ?? {}
  const persist = config.profile === 'persist'
  const userDataDir = persist
    ? persistProfileDir(sessionKey)
    : freshIsolatedProfileDir(profileSegment(sessionKey))
  fs.mkdirSync(userDataDir, { recursive: true })
  const backend = await createIsolatedBackend({
    userDataDir,
    headless: config.headless ?? false,
    channel: config.channel,
    viewport: {
      width: config.viewportWidth ?? 1280,
      height: config.viewportHeight ?? 800,
    },
  })
  return {
    backend,
    ephemeralProfileDir: persist ? undefined : userDataDir,
  }
}

async function getSharedExtensionBackend(cwd: string): Promise<BrowserBackend> {
  if (sharedExtension) return sharedExtension.backend
  if (!sharedExtensionStarting) {
    sharedExtensionStarting = (async () => {
      const config = resolveSettings(cwd).config.browser ?? {}
      const backend = await createExtensionBackend({
        relay: await getRelay(config.relayPort ?? DEFAULT_RELAY_PORT),
      })
      const relayInst =
        getExtensionRelay(backend) ??
        (await getRelay(config.relayPort ?? DEFAULT_RELAY_PORT))
      await attachExtensionPlaywright(backend, relayInst)
      if (!sharedExtension) sharedExtension = { backend, users: new Set() }
      return backend
    })().finally(() => {
      sharedExtensionStarting = null
    })
  }
  return sharedExtensionStarting
}

async function start(cwd: string, key: string): Promise<Live> {
  const config = resolveSettings(cwd).config.browser ?? {}
  const ttl = (config.idleTimeoutMinutes ?? 30) * 60 * 1000
  const idleTtlMs = Number.isFinite(ttl) && ttl > 0 ? ttl : IDLE_TTL_MS

  if (backendFactory) {
    const backend = await backendFactory()
    if (backend.kind === 'extension') {
      const relayInst =
        getExtensionRelay(backend) ??
        (await getRelay(config.relayPort ?? DEFAULT_RELAY_PORT))
      await attachExtensionPlaywright(backend, relayInst)
    }
    return {
      key,
      backend,
      lastUsed: Date.now(),
      ownsBackend: true,
      idleTimer: null,
      idleTtlMs,
    }
  }

  if (config.mode === 'extension') {
    const backend = await getSharedExtensionBackend(cwd)
    sharedExtension?.users.add(key)
    return {
      key,
      backend,
      lastUsed: Date.now(),
      ownsBackend: false,
      idleTimer: null,
      idleTtlMs,
    }
  }

  const isolated = await createIsolatedConfigured(cwd, key)
  return {
    key,
    backend: isolated.backend,
    lastUsed: Date.now(),
    ephemeralProfileDir: isolated.ephemeralProfileDir,
    ownsBackend: true,
    idleTimer: null,
    idleTtlMs,
  }
}

export async function getBrowser(
  cwd: string,
  sessionId?: string,
): Promise<BrowserBackend> {
  const key = browserSessionKey(sessionId)
  const existing = lives.get(key)
  if (existing) {
    existing.lastUsed = Date.now()
    return existing.backend
  }
  let pending = starting.get(key)
  if (!pending) {
    pending = start(cwd, key).finally(() => {
      starting.delete(key)
    })
    starting.set(key, pending)
  }
  const live = await pending
  lives.set(key, live)
  scheduleIdleSweep(live)
  const config = resolveSettings(cwd).config.browser ?? {}
  applyFocusConfig({
    restoreTabAfterInput: config.restoreTabAfterInput === true,
  })
  return live.backend
}

async function disposeLive(live: Live): Promise<void> {
  await flushTabRestore().catch(() => {})
  if (live.idleTimer) {
    clearTimeout(live.idleTimer)
    live.idleTimer = null
  }
  if (live.currentTargetId) clearTabMemory(live.currentTargetId)
  resetSessionFlags(live.key)

  if (live.ownsBackend) {
    await detachPlaywright(live.backend).catch(() => {})
    await live.backend.dispose().catch(() => {})
  } else if (sharedExtension) {
    sharedExtension.users.delete(live.key)
    if (sharedExtension.users.size === 0) {
      const backend = sharedExtension.backend
      sharedExtension = null
      await detachPlaywright(backend).catch(() => {})
      await backend.dispose().catch(() => {})
    }
  }

  if (live.ephemeralProfileDir) {
    fs.rmSync(live.ephemeralProfileDir, { recursive: true, force: true })
  }
}

/**
 * Close one chat's browser, or every bucket when sessionId is omitted
 * (process exit and tests).
 */
export async function closeBrowser(sessionId?: string): Promise<void> {
  if (sessionId) {
    const key = browserSessionKey(sessionId)
    const live = lives.get(key)
    lives.delete(key)
    if (live) await disposeLive(live)
    return
  }

  const all = [...lives.values()]
  lives.clear()
  starting.clear()
  for (const live of all) {
    await disposeLive(live)
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
  sessionId?: string,
): Promise<{ backend: BrowserBackend; targetId: string }> {
  const key = browserSessionKey(sessionId)
  const backend = await getBrowser(cwd, sessionId)
  const live = lives.get(key)
  const tabs = await backend.listTabs()

  if (explicitTargetId) {
    if (!tabs.some(t => t.targetId === explicitTargetId)) {
      throw new BrowserError(
        `No open tab with id "${explicitTargetId}". Use browser_tabs to list open tabs.`,
      )
    }
    setCurrentTab(explicitTargetId, sessionId)
    return { backend, targetId: explicitTargetId }
  }

  const current = live?.currentTargetId
  if (current && tabs.some(t => t.targetId === current)) {
    return { backend, targetId: current }
  }

  if (tabs.length === 1) {
    setCurrentTab(tabs[0].targetId, sessionId)
    recordHandoff(sessionId, tabs[0])
    return { backend, targetId: tabs[0].targetId }
  }

  if (tabs.length === 0) {
    const tab = await backend.createTab()
    setCurrentTab(tab.targetId, sessionId)
    recordHandoff(sessionId, tab)
    return { backend, targetId: tab.targetId }
  }

  // A leftover about:blank next to one real page is the usual leftover of
  // "create a tab, then the user shared another". Don't deadlock every tool
  // (including browser_tabs itself) behind a selection the model cannot make.
  const real = tabs.filter(t => t.url && t.url !== 'about:blank')
  if (real.length === 1) {
    setCurrentTab(real[0].targetId, sessionId)
    recordHandoff(sessionId, real[0])
    return { backend, targetId: real[0].targetId }
  }

  throw new BrowserError(
    'No current tab. Call browser_navigate to the start URL — it opens a fresh tab. Do not select a leftover tab from a previous task.',
  )
}

export function setCurrentTab(targetId: string, sessionId?: string): void {
  const live = lives.get(browserSessionKey(sessionId))
  if (live) {
    live.currentTargetId = targetId
    live.lastUsed = Date.now()
  }
}

export function getCurrentTabId(sessionId?: string): string | undefined {
  return lives.get(browserSessionKey(sessionId))?.currentTargetId
}

export function recordHandoff(
  sessionId: string | undefined,
  tab: { targetId?: string; url?: string; title?: string },
): void {
  const live = lives.get(browserSessionKey(sessionId))
  if (!live) return
  if (tab.targetId) live.currentTargetId = tab.targetId
  if (tab.url) live.lastUrl = tab.url
  if (tab.title !== undefined) live.lastTitle = tab.title
  live.lastUsed = Date.now()
}

export function getBrowserHandoff(sessionId?: string): BrowserHandoff | null {
  const live = lives.get(browserSessionKey(sessionId))
  if (!live?.currentTargetId || !live.lastUrl) return null
  return {
    targetId: live.currentTargetId,
    url: live.lastUrl,
    title: live.lastTitle ?? '',
  }
}

export async function openTab(
  cwd: string,
  url?: string,
  sessionId?: string,
): Promise<BrowserTab> {
  const backend = await getBrowser(cwd, sessionId)
  const tab = await backend.createTab(url)
  setCurrentTab(tab.targetId, sessionId)
  recordHandoff(sessionId, tab)
  return tab
}

export function initBrowserLifecycle(cwd: string = process.cwd()): void {
  process.on('exit', () => {
    void closeBrowser()
    void relay?.close()
  })

  // Extension mode starts the relay at boot. First tool call also lazy-starts
  // via getRelay(); the `browser` primary agent warms it per turn as well.
  warmExtensionRelay(cwd)
}

/** Start the extension relay if extension mode is configured. */
export function warmExtensionRelay(cwd: string): void {
  let config: { mode?: string; relayPort?: number; enabled?: boolean } = {}
  try {
    config = resolveSettings(cwd).config.browser ?? {}
  } catch (err) {
    console.warn(
      `[browser] skip eager relay start: ${err instanceof Error ? err.message : err}`,
    )
    return
  }
  if (config.mode !== 'extension') return
  const port = config.relayPort ?? DEFAULT_RELAY_PORT
  void getRelay(port)
    .then(() => {
      console.log(`[browser] extension relay listening on 127.0.0.1:${port}`)
    })
    .catch((err: Error) => {
      console.error(`[browser] ${err.message}`)
    })
}
