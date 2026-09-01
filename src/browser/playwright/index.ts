/**
 * What the tool layer may use from this folder.
 *
 * Playwright drives the same tab the `BrowserBackend` owns — isolated reuses the
 * Page objects it already has, extension reaches them via connectOverCDP against
 * the relay's synthetic browser target. Everything the model "sees" and every
 * control it touches comes through here; `page-inspect.ts` covers the rest.
 *
 * Every file in this folder needs a Playwright Page, and only this folder plus
 * `backends/isolated.ts` may import playwright-core — a boundary test enforces
 * it, so pure logic (URL matching, snapshot text) lives outside.
 */

export {
  click,
  drag,
  handleNativeDialog,
  hover,
  navigate,
  activateTab,
  peekNativeDialog,
  pressKey,
  screenshot,
  scroll,
  scrollIntoView,
  resizeViewport,
  selectOption,
  typeText,
  uploadFilesToPage,
} from './actions.js'
export { fillForm } from './forms.js'
export { normalizeRef } from './locator.js'
export { snapshot, waitFor, findInSnapshot, ensureSnapshotFresh } from './snapshot.js'
export { getPageText } from './page-text.js'
export { screenshotWithLabels } from './screenshot-labels.js'
export { waitForDownload, downloadByRef } from './downloads.js'
export { highlightElement, getElementBoundingBox } from './visual.js'
