/**
 * Wire protocol between the agent (host) and the MV3 extension.
 *
 * The CDP tool path is still request/response: list/open/close tabs plus one
 * `cdp` command. The Playwright engine additionally consumes unsolicited
 * `cdpEvent` frames so `connectOverCDP` can see execution contexts and frames.
 * Keep the extension side in sync when changing anything here.
 */

export const RELAY_PROTOCOL_VERSION = 1
export const DEFAULT_RELAY_PORT = 8766

export interface RelayTab {
  /** Chrome tab id, stringified. This is the `targetId` the tool layer sees. */
  targetId: string
  url: string
  title: string
}

export type RelayRequest =
  | { id: number; method: 'tabs.list' }
  | { id: number; method: 'tabs.create'; url?: string }
  | { id: number; method: 'tabs.close'; targetId: string }
  | {
      id: number
      method: 'cdp'
      targetId: string
      cdpMethod: string
      params?: Record<string, unknown>
      /** Flattened CDP child session (iframes/workers). */
      sessionId?: string
    }

/** `Omit` over a union keeps only the shared keys; this preserves each variant. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never

/** A request as callers build it, before the relay assigns a correlation id. */
export type RelayRequestBody = DistributiveOmit<RelayRequest, 'id'>

export type RelayResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string }

/** First frame the extension sends; the host closes the socket if it fails. */
export interface RelayHello {
  type: 'hello'
  token: string
  version: number
  browser?: string
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
    (msg as { type?: unknown }).type === 'hello'
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
