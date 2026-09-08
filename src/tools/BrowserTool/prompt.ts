/**
 * Tool descriptions for browser_* tools.
 *
 * Shared operating rules (latest-snapshot refs, screenshot vs snapshot,
 * stop after two failures) live on the Browser Automation agent prompt.
 * Coding agents only see these strings — keep per-tool unique pitfalls here.
 */

export const NAVIGATE_DESCRIPTION = `Navigate to a URL, or go back / forward / reload. Returns a snapshot after the document loads (not in-flight XHR). http(s) only.`

export const SNAPSHOT_DESCRIPTION = `Capture an accessibility snapshot of the current page, this is better than screenshot. Default mode=full, maxDepth 30; large trees spill to a file (Read it). selector is CSS, not a ref.`

export const GET_TEXT_DESCRIPTION = `Read bounded visible page text. Defaults to article → main → body. Cap 40k. selector is CSS, not a ref.`

export const CLICK_DESCRIPTION = `Click an element by snapshot ref, or x/y for canvas. Use this, not CDP Input.*`

export const TYPE_DESCRIPTION = `Type text into an input, textarea, or contenteditable by ref. Replaces existing contents; slowly types character by character.`

export const FILL_FORM_DESCRIPTION = `Fill multiple form fields in one call. Prefer this over one ${'`browser_type`'} per field. Each field reports filled, skipped, or failed.`

export const SELECT_OPTION_DESCRIPTION = `Select one or more options in a native \`<select>\` by ref. Custom comboboxes: click the option's snapshot ref.`

export const FILE_UPLOAD_DESCRIPTION = `Set \`<input type=file>\` (including hidden inputs). Do not click a visible Upload — that opens a native OS dialog. Empty paths cancels a pending chooser.`

export const HANDLE_DIALOG_DESCRIPTION = `Handle a native \`window.alert\` / \`confirm\` / \`prompt\` only. Call before the click that opens it. In-page Yes/No: click snapshot refs.`

export const PRESS_KEY_DESCRIPTION = `Press a key on the focused element. Optional modifiers: Control, Meta, Shift, Alt.`

export const WAIT_FOR_DESCRIPTION = `Wait for text, a CSS selector, a URL, or time (max 30s). Do not use this to settle after click/type.`

export const HOVER_DESCRIPTION = `Hover an element by snapshot ref. Returns a compact snapshot (menus).`

export const HIGHLIGHT_DESCRIPTION = `Highlight an element by ref on the page for visual grounding.`

export const GET_BOUNDING_BOX_DESCRIPTION = `Get the viewport bounding box (x, y, width, height) for a snapshot ref.`

export const SCROLL_DESCRIPTION = `Scroll the page or bring an element into view. Use this, not CDP Input.*`

export const SCREENSHOT_DESCRIPTION = `Take a screenshot of the page or an element. Not for choosing clicks — use snapshot refs. labels overlays refs on the image.`

export const CONSOLE_DESCRIPTION = `Read console messages from the page.`

export const NETWORK_DESCRIPTION = `Read fetch/XHR from the page. Not document navigations or static assets.`

export const TABS_DESCRIPTION = `List, create, close, or select browser tabs. select/close use tabId from list, not an index.`

export const DRAG_DESCRIPTION = `Drag from one snapshot ref to another. Use this, not CDP Input.*.`

export const RESIZE_DESCRIPTION = `Resize the browser viewport.`

export const WAIT_FOR_DOWNLOAD_DESCRIPTION = `Wait for a file download and save it. Optional ref clicks that element first.`

export const LOCK_DESCRIPTION = `unlock: user takes the page (captcha, 2FA, payment). lock: agent resumes. Do not click or type while unlocked.`

/** Shown in ToolSearch / deferred catalog so coding agents can find evaluate. */
export const CDP_SUMMARY =
  'Send a CDP command; Runtime.evaluate when a control has no snapshot ref'

export const CDP_DESCRIPTION = `Send a CDP command. Do not use Input.* or DOM.getDocument — use dedicated click/type/key/scroll/drag tools. Cookie, storage, download, and target-management methods are denied. Runtime.evaluate for unlabeled controls; browser_get_text for page prose. Large results save to a file.`
