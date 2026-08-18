/**
 * Session-scoped flags the tool layer and Playwright ops share.
 * Snapshot degradation, last tree (for find / stale relocate), user control.
 */

import {
  parseRefMeta,
  type RefMeta,
} from './snapshot-index.js'

const snapshotDegraded = new Map<string, boolean>()
const lastSnapshot = new Map<string, string>()
const refMetaByTarget = new Map<string, Map<string, RefMeta>>()
let userHasControl = false
const lockListeners = new Set<(userHasControl: boolean) => void>()

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

export function clearTabMemory(targetId: string): void {
  snapshotDegraded.delete(targetId)
  lastSnapshot.delete(targetId)
  refMetaByTarget.delete(targetId)
}

export function setUserHasControl(value: boolean): void {
  if (userHasControl === value) return
  userHasControl = value
  for (const fn of lockListeners) fn(value)
}

export function getUserHasControl(): boolean {
  return userHasControl
}

export function onUserControlChange(
  fn: (userHasControl: boolean) => void,
): () => void {
  lockListeners.add(fn)
  return () => lockListeners.delete(fn)
}

export function resetSessionFlags(): void {
  snapshotDegraded.clear()
  lastSnapshot.clear()
  refMetaByTarget.clear()
  userHasControl = false
  for (const fn of lockListeners) fn(false)
}
