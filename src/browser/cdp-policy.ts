/**
 * Cursor's browser_cdp deny list, copied from the installed app
 * (`out/main.js` `nx()` / `Tx` / `kx`).
 *
 * Domain blocks: Browser, Input, Storage, SystemInfo, Target, Tethering.
 * Method blocks: cookie/cache, file-input, and CDP navigation/history.
 * Input.* gets a dedicated error so the model is sent back to click/type/fill.
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
  if (DENIED_CDP_DOMAINS.has(domain) || DENIED_CDP_METHODS.has(name)) {
    return `CDP method '${name}' is not allowed`
  }
  return undefined
}
