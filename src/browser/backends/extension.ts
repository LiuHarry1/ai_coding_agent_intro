/**
 * Phase-2 backend: the user's own Chrome, reached through the MV3 extension.
 *
 * This is where the phase-1 abstraction pays off — the whole backend is a
 * forwarder. Every page operation, the snapshot script, the ref machinery and
 * all browser tools are shared verbatim with the isolated backend, because they
 * were written against `BrowserBackend` and nothing else.
 *
 * Two properties that the isolated backend cannot offer:
 *  - pages load with the user's real cookies and sessions, so anything behind
 *    a login just works
 *  - `chrome.debugger` is the extension's own capability, so Chrome never shows
 *    the "Allow remote debugging?" modal that blocks attaching to a running
 *    browser over a remote-debugging port
 */

import { BrowserError, type BrowserBackend, type BrowserTab } from '../types.js'
import type { RelayServer } from '../relay/server.js'
import type { RelayTab } from '../relay/protocol.js'

const relays = new WeakMap<BrowserBackend, RelayServer>()

function isUnknownRelayMethod(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /Unknown relay method/i.test(msg)
}

export interface ExtensionBackendOptions {
  relay: RelayServer
  /** How long to wait for the extension to show up before giving up. */
  connectTimeoutMs?: number
}

/** The relay a given extension backend is speaking through, if any. */
export function getExtensionRelay(backend: BrowserBackend): RelayServer | undefined {
  return relays.get(backend)
}

export async function createExtensionBackend(
  opts: ExtensionBackendOptions,
): Promise<BrowserBackend> {
  const { relay } = opts
  await relay.waitForExtension(opts.connectTimeoutMs ?? 20_000)

  /** Old extension builds lack tabs.focus / tabs.restore / tabs.getActiveUserTab. */
  let legacyFocusRelay = false
  let legacyFocusWarned = false

  function warnLegacyFocusOnce(): void {
    if (legacyFocusWarned) return
    legacyFocusWarned = true
    console.warn(
      '[browser] Extension is missing focus relay methods (tabs.getActiveUserTab / tabs.focus). ' +
        'Reload the unpacked extension from chrome://extensions. ' +
        'Until then extension clicks may fail silently on background tabs.',
    )
  }

  function toTab(tab: RelayTab): BrowserTab {
    return { targetId: tab.targetId, url: tab.url, title: tab.title }
  }

  const backend: BrowserBackend = {
    kind: 'extension',

    async listTabs() {
      const tabs = await relay.request<RelayTab[]>({ method: 'tabs.list' })
      return tabs.map(toTab)
    },

    async createTab(url) {
      const tab = await relay.request<RelayTab>({ method: 'tabs.create', url })
      return toTab(tab)
    },

    async closeTab(targetId) {
      await relay.request({ method: 'tabs.close', targetId })
    },

    async send(targetId, method, params) {
      return relay.request({
        method: 'cdp',
        targetId,
        cdpMethod: method,
        params,
      })
    },

    async getActiveUserTabId() {
      if (legacyFocusRelay) return null
      try {
        const tab = await relay.request<RelayTab | null>({
          method: 'tabs.getActiveUserTab',
        })
        return tab?.targetId ?? null
      } catch (err) {
        if (!isUnknownRelayMethod(err)) throw err
        legacyFocusRelay = true
        warnLegacyFocusOnce()
        return null
      }
    },

    async focusTab(targetId, level) {
      if (legacyFocusRelay) {
        warnLegacyFocusOnce()
        return
      }
      try {
        await relay.request({
          method: 'tabs.focus',
          targetId,
          level: level === 'window' ? 'tab' : level,
        })
      } catch (err) {
        if (!isUnknownRelayMethod(err)) throw err
        legacyFocusRelay = true
        warnLegacyFocusOnce()
      }
    },

    async restoreTab(targetId) {
      if (legacyFocusRelay) return
      try {
        await relay.request({ method: 'tabs.restore', targetId })
      } catch (err) {
        if (!isUnknownRelayMethod(err)) throw err
        legacyFocusRelay = true
        warnLegacyFocusOnce()
      }
    },

    async dispose() {
      // Nothing to tear down, and deliberately so: the browser belongs to the
      // user, and the tabs may be mid-task. The extension detaches its debugger
      // sessions when the socket drops, which is the only cleanup we own.
    },
  }
  relays.set(backend, relay)
  return backend
}

export { BrowserError }
