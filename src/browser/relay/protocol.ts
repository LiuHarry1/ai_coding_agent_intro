/**
 * Wire protocol between the agent (host) and the MV3 extension.
 *
 * The tool path is request/response: a few tab methods that carry the
 * ownership model, plus `chrome.*` calls forwarded by name. The Playwright
 * engine additionally consumes unsolicited `cdpEvent` frames so
 * `connectOverCDP` can see execution contexts and frames.
 *
 * The extension reports its `capabilities` in the handshake, so a build older
 * than the host degrades at connect time rather than failing mid-task. Bump
 * RELAY_PROTOCOL_VERSION only for changes that make the two incompatible.
 */

export const RELAY_PROTOCOL_VERSION = 2

export interface RelayTab {
  /** Chrome tab id, stringified. This is the `targetId` the tool layer sees. */
  targetId: string
  url: string
  title: string
}

/**
 * `chrome.*` calls the extension forwards reflectively. The extension holds
 * the matching allow-list and ownership-checks the tab id in the first
 * argument, so widening this type alone grants nothing.
 */
export type ChromeCommand =
  | 'chrome.debugger.attach'
  | 'chrome.debugger.detach'
  | 'chrome.debugger.sendCommand'

/** CDP debuggee, optionally scoped to a flattened child session. */
export interface ChromeDebuggee {
  tabId: number
  /** Flattened CDP child session (iframes/workers). */
  sessionId?: string
}

export type RelayRequest =
  | { id: number; method: 'tabs.list' }
  | { id: number; method: 'tabs.create'; url?: string }
  | { id: number; method: 'tabs.close'; targetId: string }
  | { id: number; method: 'tabs.getActiveUserTab' }
  | {
      id: number
      method: 'tabs.focus'
      targetId: string
      level: 'tab' | 'window'
    }
  | { id: number; method: 'tabs.restore'; targetId: string }
  | { id: number; method: ChromeCommand; params: unknown[] }

/** `Omit` over a union keeps only the shared keys; this preserves each variant. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never

/** A request as callers build it, before the relay assigns a correlation id. */
export type RelayRequestBody = DistributiveOmit<RelayRequest, 'id'>

export type RelayResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string }

/**
 * First frame the extension sends. It carries no secret — the connect URL
 * already proved the caller's identity — only what this build can do, so the
 * host can branch at handshake time instead of probing with failed calls.
 */
export interface RelayHello {
  type: 'hello'
  version: number
  browser?: string
  capabilities?: string[]
}

export interface RelayWelcome {
  type: 'welcome'
  version: number
}

/** Unsolicited CDP event the extension forwards from chrome.debugger.onEvent. */
export interface RelayCdpEvent {
  type: 'cdpEvent'
  targetId: string
  method: string
  params?: unknown
  sessionId?: string
}

export function isRelayResponse(msg: unknown): msg is RelayResponse {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    typeof (msg as { id?: unknown }).id === 'number' &&
    typeof (msg as { ok?: unknown }).ok === 'boolean'
  )
}

export function isRelayHello(msg: unknown): msg is RelayHello {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    (msg as { type?: unknown }).type === 'hello' &&
    typeof (msg as { version?: unknown }).version === 'number'
  )
}

export function isRelayCdpEvent(msg: unknown): msg is RelayCdpEvent {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    (msg as { type?: unknown }).type === 'cdpEvent' &&
    typeof (msg as { targetId?: unknown }).targetId === 'string' &&
    typeof (msg as { method?: unknown }).method === 'string'
  )
}

export interface RelayUserControl {
  type: 'userControl'
  hasControl: boolean
}

export function isRelayUserControl(msg: unknown): msg is RelayUserControl {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    (msg as { type?: unknown }).type === 'userControl' &&
    typeof (msg as { hasControl?: unknown }).hasControl === 'boolean'
  )
}
