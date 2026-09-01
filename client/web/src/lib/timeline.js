/**
 * Shared transcript helpers still used by cards / work-group chrome.
 *
 * Turn folding lives in `bubbles/flat-elements.js` (`buildFlatElements`).
 * Explore / browser coalescing lives in `tool-density.js`.
 */

/**
 * Stable key for a tool_call / explored member.
 */
export function toolPartKey(part, fallback = 'tool') {
  return part?.toolCallId || part?.id || fallback
}

/**
 * Cursor `Q8c` / `g0m`: duration detail as "for Ns" (ceil to whole seconds).
 * @param {number} [ms]
 * @returns {string | undefined}
 */
export function formatWorkedDuration(ms) {
  if (ms == null || !(ms > 0)) return undefined
  const secs = Math.ceil(ms / 1000)
  if (ms < 1000) return 'for 1s'
  if (secs < 60) return `for ${secs}s`
  if (secs >= 3600) {
    const h = Math.floor(secs / 3600)
    const m = Math.floor((secs % 3600) / 60)
    return m > 0 ? `for ${h}h ${m}m` : `for ${h}h`
  }
  const m = Math.floor(secs / 60)
  const s = secs % 60
  return s > 0 ? `for ${m}m ${s}s` : `for ${m}m`
}
