/**
 * Snapshot / get_text `selector` is Playwright CSS. Models often paste
 * `[ref=eN]` from the YAML; that is not a DOM attribute and matches nothing.
 */

export function isAriaRefCssSelector(selector: string): boolean {
  const s = selector.trim()
  if (!s) return false
  return (
    /^\[ref=/i.test(s) ||
    /^ref=/i.test(s) ||
    /^aria-ref=/i.test(s) ||
    /\[ref=[^\]]+\]/i.test(s)
  )
}

export function ariaRefCssSelectorMessage(selector: string): string {
  return (
    `selector is CSS, not a snapshot ref. ${JSON.stringify(selector)} matches nothing in the DOM. ` +
    `Omit selector to capture the page tree, or Read the spilled snapshot file. ` +
    `To click or type, pass ref= on browser_click / browser_type — do not snapshot with [ref=eN].`
  )
}
