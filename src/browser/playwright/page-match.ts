/**
 * Matching a tool-layer tab to a Playwright page.
 *
 * The two sides identify tabs differently — the backend has CDP target ids,
 * Playwright has Page objects — and the only thing they share is a URL. So this
 * is a judgement call, not a lookup, which is why it lives apart from the
 * connection state and is tested on its own: picking `pages[0]` was how the
 * tools used to drive whichever tab happened to be first.
 */

/** No dependencies on purpose: this is decision logic, not plumbing. */
export function isBlankUrl(url: string): boolean {
  return !url || url === 'about:blank' || url.startsWith('chrome://newtab')
}

/** Same origin+path, ignoring hash and query (tracking params churn on SPAs). */
export function urlsRoughlyEqual(a: string, b: string): boolean {
  if (a === b) return true
  try {
    const left = new URL(a)
    const right = new URL(b)
    if (left.origin !== right.origin) return false
    const pathA = left.pathname.replace(/\/+$/, '') || '/'
    const pathB = right.pathname.replace(/\/+$/, '') || '/'
    return pathA === pathB
  } catch {
    return false
  }
}

/**
 * Structural over `Page` so this stays testable without a browser.
 *
 * On a tie the *last* match wins: duplicates of the same URL usually mean the
 * user opened it again, and the newest one is the one they are looking at.
 */
export function pickPageForTab<T extends { url(): string }>(
  pages: T[],
  tabUrl: string,
): T | undefined {
  const live = pages.filter(p => {
    try {
      p.url()
      return true
    } catch {
      return false
    }
  })
  const exact = live.filter(p => urlsRoughlyEqual(p.url(), tabUrl))
  if (exact.length === 1) return exact[0]
  if (exact.length > 1) return exact[exact.length - 1]
  if (isBlankUrl(tabUrl)) {
    const blanks = live.filter(p => isBlankUrl(p.url()))
    if (blanks.length === 1) return blanks[0]
    if (blanks.length > 1) return blanks[blanks.length - 1]
  }
  return undefined
}
