/**
 * Cursor's browser_cdp deny list, copied from the installed app
 * (`out/main.js` `nx()` / `Tx` / `kx`).
 *
 * Domain blocks: Browser, Input, Storage, SystemInfo, Target, Tethering.
 * Method blocks: cookie/cache, file-input, and CDP navigation/history.
 * Input.* gets a dedicated error so the model is sent back to click/type/fill.
 *
 * Extra BaiX denials: whole-document DOM dumps always overflow the inline
 * budget on real pages and leave a useless 100KB+ JSON file — models then
 * waste turns Bash/Read-ing it instead of using snapshot / evaluate.
 */

export const DENIED_CDP_DOMAINS = new Set([
  'Browser',
  'Input',
  'Storage',
  'SystemInfo',
  'Target',
  'Tethering',
])

export const DENIED_CDP_METHODS = new Set([
  'DOM.setFileInputFiles',
  'Network.clearBrowserCache',
  'Network.clearBrowserCookies',
  'Network.deleteCookies',
  'Network.getAllCookies',
  'Network.getCookies',
  'Network.setCookie',
  'Network.setCookies',
  'Page.getNavigationHistory',
  'Page.navigate',
  'Page.navigateToHistoryEntry',
])

/** Whole-tree DOM dumps — always spill and never help the agent decide a click. */
export const DENIED_DOM_TREE_METHODS = new Set([
  'DOM.getDocument',
  'DOM.getFlattenedDocument',
])

/** Error text when the method is blocked; undefined when it may run. */
export function denyCdpMethod(method: string): string | undefined {
  const name = method.trim()
  const domain = name.split('.', 1)[0]
  if (domain === 'Input') {
    return (
      `CDP method '${name}' is not allowed. Use dedicated browser tools ` +
      `for clicks, text input, key presses, scrolling, and drag-and-drop ` +
      `instead of CDP Input.*.`
    )
  }
  if (DENIED_DOM_TREE_METHODS.has(name)) {
    return (
      `CDP method '${name}' is not allowed — the full DOM tree always exceeds ` +
      `the inline budget and is not useful for automation. Prefer ` +
      `browser_snapshot (refs), browser_get_text (copy), or Runtime.evaluate ` +
      `with a small querySelector/XPath expression that returns a short value ` +
      `(e.g. click a node whose textContent matches, or return {ok:true}).`
    )
  }
  if (DENIED_CDP_DOMAINS.has(domain) || DENIED_CDP_METHODS.has(name)) {
    return `CDP method '${name}' is not allowed`
  }
  return undefined
}
