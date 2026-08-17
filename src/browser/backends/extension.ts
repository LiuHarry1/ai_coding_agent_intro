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
