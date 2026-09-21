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

  // The handshake says what this build can do, so a stale extension is one
  // warning at connect time instead of a surprise failure mid-task.
  const capabilities = relay.capabilities()
  const canFocus =
    capabilities.has('tabs.focus') && capabilities.has('tabs.getActiveUserTab')
  if (!canFocus) {
    console.warn(
      '[browser] Extension is missing focus relay methods (tabs.getActiveUserTab / tabs.focus). ' +
        'Reload the unpacked extension from chrome://extensions. ' +
        'Until then extension clicks may fail silently on background tabs.',
    )
  }

  function toTab(tab: RelayTab): BrowserTab {
    return { targetId: tab.targetId, url: tab.url, title: tab.title }
  }

  /**
   * In this backend a targetId is a Chrome tab id, and the extension checks
   * ownership against the number inside the debuggee. Anything else is a bug
   * on our side, so say that rather than sending `{ tabId: null }`.
   */
  function tabIdOf(targetId: string): number {
    const tabId = Number(targetId)
    if (!Number.isInteger(tabId)) {
      throw new BrowserError(
        `"${targetId}" is not a Chrome tab id. The extension backend cannot ` +
          'drive a target that did not come from it.',
      )
    }
    return tabId
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
        method: 'chrome.debugger.sendCommand',
        params: [{ tabId: tabIdOf(targetId) }, method, params ?? {}],
      })
    },

    async getActiveUserTabId() {
      if (!canFocus) return null
      const tab = await relay.request<RelayTab | null>({
        method: 'tabs.getActiveUserTab',
      })
      return tab?.targetId ?? null
    },

    async focusTab(targetId, level) {
      if (!canFocus) return
      await relay.request({
        method: 'tabs.focus',
        targetId,
        level: level === 'window' ? 'tab' : level,
      })
    },

    async restoreTab(targetId) {
      if (!canFocus) return
      await relay.request({ method: 'tabs.restore', targetId })
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
