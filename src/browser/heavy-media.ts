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

/** Recovery when ariaSnapshot times out. */
export const SNAPSHOT_STALL_NEXT =
  'A full accessibility snapshot timed out (often a PDF/iframe receipt preview). Do not retry full snapshot, screenshot, or wait_for in a loop. If the main form is still usable (e.g. View Receipt / Save visible), keep filling it with click/type/fill-form — do not try to "close the PDF viewer". Only take a fresh snapshot after the next form action returns refs, or if the overlay truly blocks the controls you need.'
