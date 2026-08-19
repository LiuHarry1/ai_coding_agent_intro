/**
 * Frames that stall Playwright's accessibility snapshot (PDF viewers, blob
 * previews). Pure URL/type check so the snapshot path can hide them first.
 */

export function isHeavyMediaFrame(src: string, type = ''): boolean {
  const s = (src || '').toLowerCase()
  const t = (type || '').toLowerCase()
  if (t.includes('pdf')) return true
  if (s.includes('application/pdf') || /\.pdf(\b|$|\?|#)/.test(s)) return true
  if (s.startsWith('blob:') || s.startsWith('data:application/pdf')) return true
  if (s.includes('pdf.js') || s.includes('/pdfjs/')) return true
  // Chrome's built-in PDF viewer extension.
  if (
    s.startsWith('chrome-extension://') &&
    (s.includes('pdf') || s.includes('mhjfbmdgcfjbbpaeojofohoefgiehjai'))
  ) {
    return true
  }
  return false
}

/** Recovery when ariaSnapshot times out — Playwright getByRole, not evaluate. */
export const SNAPSHOT_STALL_NEXT =
  'A full accessibility snapshot timed out (often a PDF/iframe). Do not retry a full snapshot, screenshot, wait_for, or evaluate. Click with browser_click role + name (Playwright getByRole), e.g. role: "button", name: "OK".'
