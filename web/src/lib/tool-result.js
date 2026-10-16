/**
 * Dual-channel helpers for tool cards.
 *
 * Channels:
 *   - args / livePreview / liveOutput — running
 *   - toolUseResult (TUR) — done success body (prefer this)
 *   - result — model text; errors / fallback only
 */

/** @param {{ toolUseResult?: unknown }} part */
export function getTur(part) {
  const tur = part?.toolUseResult
  if (tur && typeof tur === 'object') return tur
  return null
}

/**
 * Prefer TUR field, then fallback.
 * @param {{ toolUseResult?: unknown, result?: unknown }} part
 * @param {string} key
 * @param {unknown} [fallback]
 */
export function turField(part, key, fallback = undefined) {
  const tur = getTur(part)
  if (tur && key in tur && tur[key] != null) return tur[key]
  return fallback
}
