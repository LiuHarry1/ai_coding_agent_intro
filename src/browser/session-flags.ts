/**
 * Snapshot memory is keyed by tab id. User-control lock is keyed by chat
 * session so two conversations cannot steal each other's Take Control state.
 */

import {
  parseRefMeta,
  type RefMeta,
} from './snapshot-index.js'
import {
  abortBlockedBrowserTools,
  abortBlockedBrowserToolsEverywhere,
} from './active-browser-tools.js'

export const DEFAULT_BROWSER_SESSION_KEY = 'default'

const snapshotDegraded = new Map<string, boolean>()
const lastSnapshot = new Map<string, string>()
const refMetaByTarget = new Map<string, Map<string, RefMeta>>()
const controlBySession = new Map<string, boolean>()
let globalControl = false
const lockListeners = new Set<(userHasControl: boolean) => void>()

function lockKey(sessionId?: string): string {
  return sessionId && sessionId.length > 0
    ? sessionId
    : DEFAULT_BROWSER_SESSION_KEY
}

function notifyLockListeners(): void {
  const value = anyUserHasControl()
  for (const fn of lockListeners) fn(value)
}

export function setSnapshotDegraded(targetId: string, degraded: boolean): void {
  if (!targetId) return
  if (degraded) snapshotDegraded.set(targetId, true)
  else snapshotDegraded.delete(targetId)
}

export function isSnapshotDegraded(targetId: string): boolean {
  return snapshotDegraded.get(targetId) === true
}

export function rememberSnapshot(targetId: string, yaml: string): void {
  if (!targetId || !yaml) return
  lastSnapshot.set(targetId, yaml)
  let map = refMetaByTarget.get(targetId)
  if (!map) {
    map = new Map()
    refMetaByTarget.set(targetId, map)
  }
  for (const meta of parseRefMeta(yaml)) {
    if (!map.has(meta.ref)) map.set(meta.ref, meta)
  }
}

export function getLastSnapshot(targetId: string): string | undefined {
  return lastSnapshot.get(targetId)
}

export function getRefMeta(
  targetId: string,
  ref: string,
): RefMeta | undefined {
  return refMetaByTarget.get(targetId)?.get(ref)
}

/** Snapshot refs for labeled screenshots. */
export function listRefMeta(
  targetId: string,
): Record<string, { role: string; name?: string }> {
  const map = refMetaByTarget.get(targetId)
  const out: Record<string, { role: string; name?: string }> = {}
  if (!map) return out
  for (const [ref, meta] of map) {
    out[ref] = { role: meta.role, ...(meta.name ? { name: meta.name } : {}) }
  }
  return out
}

export function clearTabMemory(targetId: string): void {
  snapshotDegraded.delete(targetId)
  lastSnapshot.delete(targetId)
  refMetaByTarget.delete(targetId)
}

export function setUserHasControl(
  value: boolean,
  sessionId?: string,
): void {
  const key = lockKey(sessionId)
  const prev = controlBySession.get(key) === true
  if (prev === value) return
  if (value) controlBySession.set(key, true)
  else controlBySession.delete(key)
  if (value) abortBlockedBrowserTools(key)
  notifyLockListeners()
}

export function setUserHasControlEverywhere(value: boolean): void {
  const was = anyUserHasControl()
  globalControl = value
  if (!value) controlBySession.clear()
  if (value && !was) abortBlockedBrowserToolsEverywhere()
  notifyLockListeners()
}

export function getUserHasControl(sessionId?: string): boolean {
  if (globalControl) return true
  return controlBySession.get(lockKey(sessionId)) === true
}

export function anyUserHasControl(): boolean {
  if (globalControl) return true
  for (const value of controlBySession.values()) {
    if (value) return true
  }
  return false
}

export function onUserControlChange(
  fn: (userHasControl: boolean) => void,
): () => void {
  lockListeners.add(fn)
  return () => lockListeners.delete(fn)
}

export function resetSessionFlags(sessionId?: string): void {
  if (sessionId) {
    controlBySession.delete(lockKey(sessionId))
    notifyLockListeners()
    return
  }
  snapshotDegraded.clear()
  lastSnapshot.clear()
  refMetaByTarget.clear()
  controlBySession.clear()
  globalControl = false
  for (const fn of lockListeners) fn(false)
}
