/**
 * Tool descriptions for browser_* tools.
 *
 * Keep these short (Cursor-style one-liners). Shared operating rules live on
 * `.ai-agent/agents/browser.md`. BaiX-only tools and behavior diffs from Cursor
 * are called out in the string when the schema alone is not enough.
 */

export const ELEMENT_HINT_DESCRIPTION =
  'Human-readable element description; must match the resolved ref'

/** Cursor: navigate + newTab. BaiX: no newTab on this tool — use browser_tabs. */
export const NAVIGATE_DESCRIPTION =
  'Navigate to a URL. Reuses the current tab; use browser_tabs with action "new" to open another tab first. Omit url and set action for back / forward / reload.'

/** Matches Cursor's one-line snapshot description. Defaults/spill/CSS live in params + browser.md. */
export const SNAPSHOT_DESCRIPTION =
  'Capture accessibility snapshot of the current page, this is better than screenshot'

/** BaiX-only (Cursor has no get_text). */
export const GET_TEXT_DESCRIPTION =
  'Read bounded visible page text (article/main/body or a CSS selector). Prefer this over a full snapshot when you need prose, not clickable refs.'

/**
 * Cursor splits click vs mouse_click_xy. BaiX: one tool with optional x/y.
 * Cursor: "Click an element by ref from browser_snapshot…"
 */
export const CLICK_DESCRIPTION =
  'Click an element by ref from browser_snapshot, or x/y for canvas. Use this instead of CDP Input.* methods.'

/**
 * Cursor has separate browser_type and browser_fill.
 * BaiX browser_type defaults to Playwright fill (replaces contents); slowly types char-by-char.
 */
export const TYPE_DESCRIPTION =
  'Type text into an input, textarea, or contenteditable element by ref. Replaces existing contents (Playwright fill); set slowly for per-character key events.'

/** Cursor registers fill_form in code but MCP catalog is single-field fill. BaiX: multi-field. */
export const FILL_FORM_DESCRIPTION =
  'Fill multiple form fields by ref in one call. Prefer this over repeated browser_type. Each field is reported as filled, skipped, or failed.'

/** Matches Cursor intent; values are visible labels (BaiX/Playwright). */
export const SELECT_OPTION_DESCRIPTION =
  'Select one or more options in a native select element by ref. Custom comboboxes: open and browser_click the option ref.'

/** BaiX-only. */
export const FILE_UPLOAD_DESCRIPTION =
  'Set files on an input[type=file] via paths (including hidden inputs). Do not click a visible Upload control — that opens an OS dialog. Omit ref if unsure; empty paths cancel a pending chooser.'

/** BaiX-only. */
export const HANDLE_DIALOG_DESCRIPTION =
  'Handle a native window.alert/confirm/prompt only. Call before the click that opens it. In-page modals are snapshot nodes — use browser_click.'

/** Matches Cursor. */
export const PRESS_KEY_DESCRIPTION =
  'Press a key in the browser page using DOM keyboard events.'

/** BaiX-only (not in Cursor MCP tool list). */
export const WAIT_FOR_DESCRIPTION =
  'Wait for text, a CSS selector, a URL, or a short time. Avoid for settle after click/type/navigate — those already wait. time is capped at 30s.'

/** Cursor has hover internally; not in the short MCP catalog list. */
export const HOVER_DESCRIPTION =
  'Hover over an element by ref. Returns a compact snapshot (useful for menus).'

/** Matches Cursor. */
export const HIGHLIGHT_DESCRIPTION =
  'Highlight an element by ref in the browser page for visual grounding.'

/** Matches Cursor. */
export const GET_BOUNDING_BOX_DESCRIPTION =
  'Get the viewport bounding box for an element ref.'

/** Matches Cursor. */
export const SCROLL_DESCRIPTION =
  'Scroll the page, a scrollable container, or an element into view. Use this instead of CDP Input.* wheel events.'

/**
 * Cursor: browser_take_screenshot one-liner + no-actions warning.
 * BaiX: also supports element ref and labels overlay (see params).
 */
export const SCREENSHOT_DESCRIPTION =
  "Take a screenshot of the current page or an element. You can't perform actions based on the screenshot, use browser_snapshot for actions."

/** BaiX-only. */
export const CONSOLE_DESCRIPTION =
  'Read page console messages since the last browser action (or since clear).'

/** BaiX-only. fetch/XHR metadata, not full CDP Network. */
export const NETWORK_DESCRIPTION =
  'Read fetch/XHR metadata since the last browser action (or since clear). Navigations and static assets are omitted.'

/**
 * Matches Cursor one-liner. BaiX: tabId is CDP target id; list is ownership-scoped in extension mode.
 */
export const TABS_DESCRIPTION =
  'List, create, close, or select a browser tab'

/**
 * Cursor also allows drop at x/y. BaiX: ref → ref only.
 */
export const DRAG_DESCRIPTION =
  'Drag an element by ref to another ref. Use this instead of CDP Input.* methods.'

/** BaiX-only. */
export const RESIZE_DESCRIPTION = 'Resize the browser viewport.'

/** BaiX-only. */
export const WAIT_FOR_DOWNLOAD_DESCRIPTION =
  'Wait for a download to finish and save it. Pass ref to click first; omit ref if a click already started the download.'

/**
 * Cursor lock is a pane mutex for the whole automation turn.
 * BaiX: human handoff (captcha / 2FA / payment) via unlock then lock.
 */
export const LOCK_DESCRIPTION =
  'Take or release control of the current tab. unlock: user takes the page (captcha, 2FA, payment). lock: agent resumes after they finish.'

/**
 * ToolSearch / deferred catalog. Cursor's loaded schema is CDP_DESCRIPTION;
 * this line matches Cursor CORE WORKFLOW #8 (not "evaluate when no ref").
 */
export const CDP_SUMMARY =
  'Send a CDP command for page inspection, profiling, Runtime.evaluate, DOM/CSS queries, and performance data'

/** Matches Cursor's MCP description (first paragraph). BaiX adds DOM tree denial in runtime policy. */
export const CDP_DESCRIPTION =
  'Send a Chrome DevTools Protocol command to the target browser tab. Do not use CDP Input.* methods; use dedicated browser tools for clicks, text input, key presses, scrolling, and drag-and-drop. Browser-wide, storage, cookie, permission, download, target-management, and system-level commands are denied.'
