/**
 * Tool descriptions for browser_* tools.
 *
 * Shared operating rules (latest-snapshot refs, screenshot vs snapshot,
 * stop after two failures) live on the Browser Automation agent prompt.
 * Coding agents only see these strings — keep per-tool unique pitfalls here.
 */

export const NAVIGATE_DESCRIPTION = `Navigate to a URL, or go back / forward / reload.

Waits for the document and in-flight XHR/fetch, then returns an **efficient** interactive snapshot (enough refs for the next click). Do not call browser_snapshot immediately after navigate unless you need mode=full. If a list is still empty, ${'`browser_wait_for`'} that text. Session cookies persist across calls.

http(s) only — no file: or javascript: URLs. If a modal is covering the current page, click it — do not navigate away to dismiss it.`

export const SNAPSHOT_DESCRIPTION = `Capture an accessibility snapshot of the current page.

Playwright's AI aria tree. Clickable nodes have \`[ref=eN]\` from this tree — after any action, use the new refs. A bare \`text:\` line is not clickable. Prefer this over ${'`browser_screenshot`'} for deciding what to click.

- \`mode\`: \`efficient\` (default) — interactive controls, ~8k chars, depth 6. \`full\` — wider tree up to ~40k chars. Use full sparingly.
- \`selector\`: CSS for one subtree only (e.g. \`[role=dialog]\`, \`.panel\`). Not snapshot \`[ref=eN]\` — refs are for click/type. Miss → empty; omit selector and re-snapshot the page.
- \`compact\` / \`interactive\`: further shape the tree (efficient sets both by default)
- \`includeDiff\`: only lines that changed since the last snapshot
- \`urls\`: append discovered link destinations

For page **prose**, use ${'`browser_get_text`'} instead of a full snapshot.

**Do not** call this tool multiple times in parallel, or back-to-back with no click/type/navigate between them. Click/type/navigate already return an efficient snapshot — reuse that tree. \`mode=full\` at most once when efficient was truncated; never full→full→full.

If an in-page modal (\`alertdialog\` / Yes / No / OK) is open, the snapshot is that dialog. Click those refs. That is not ${'`browser_handle_dialog`'} (native \`alert\`/\`confirm\` only).

If the snapshot times out, a PDF or iframe likely stalled the tree. Do not retry a full snapshot, screenshot, or wait in a loop — close the viewer or work from whatever partial tree you have, then capture a new snapshot when the page is usable.`

export const GET_TEXT_DESCRIPTION = `Read bounded visible page text for answering questions or extracting copy.

Uses the first match of \`selector\`, otherwise article → main → body. Cap with \`maxChars\` (default/ceiling 40k). Prefer this over ${'`browser_snapshot`'} mode=full or ${'`browser_cdp`'} Runtime.evaluate when you need prose, not clickable refs.`

export const CLICK_DESCRIPTION = `Perform click on a web page.

Use \`ref\` from the latest snapshot. Pass \`element\` with a human-readable description (role or name overlap); if it does not match the resolved ref, the call fails. A stale ref fails; if \`element\` still matches, the tool may recover a different ref once — otherwise snapshot and use the new tree. The click scrolls into view, dismisses blocking dropdowns, and retries with offset when a non-interactive layer blocks the target. Coordinate \`x\`/\`y\` is for canvas widgets only.

Do not wait or navigate instead of clicking.`

export const TYPE_DESCRIPTION = `Type text into editable element (input, textarea, or contenteditable).

Clicks the field, then **replaces** its contents (Playwright \`fill\`). Reports the value that landed; a readonly or disabled field is reported as such. Optional \`element\` must match the resolved ref (same rule as click). \`submit\` presses Enter. \`slowly\` clicks then types at 75ms per character. If the ref points at a non-editable wrapper, capture a new snapshot and use the inner textbox ref.`

export const FILL_FORM_DESCRIPTION = `Fill multiple form fields in one call. Prefer this over one ${'`browser_type`'} per field.

Writes every listed field, then settles and snapshots once. Each field comes back as filled, skipped, or failed. Native \`<select>\` uses the visible label. Custom comboboxes: open them and ${'`browser_click`'} the option ref.

If a field has no snapshot ref (unlabeled input), set it with ${'`browser_cdp`'} Runtime.evaluate — do not guess a click.`

export const SELECT_OPTION_DESCRIPTION = `Select an option in a native \`<select>\` dropdown.

Pass the visible label (Playwright \`selectOption\`). Custom combobox / listbox / calendar widgets are not a select: open the popup and ${'`browser_click`'} the option's ref from a snapshot.`

export const FILE_UPLOAD_DESCRIPTION = `Upload one or multiple files.

Sets \`<input type=file>\` (including hidden inputs in frames). Do not click a visible Upload button — that opens a native OS dialog this tool cannot drive. Pass \`ref\` if you have the input. Empty \`paths\` cancels a pending chooser.

Paths are workspace-relative or absolute.

Returns a snapshot after the files are set. Use that tree for the next click — old refs are stale. A PDF/iframe preview can stall a full snapshot; if it times out, close the viewer and capture a new snapshot. Do not wait_for or screenshot in a loop to remove the preview.`

export const HANDLE_DIALOG_DESCRIPTION = `Handle a native \`window.alert\` / \`confirm\` / \`prompt\` only.

In-page modals (\`role=alertdialog\`, Yes / No) are snapshot nodes — ${'`browser_click`'} them.

Call this BEFORE the click that opens a native dialog. An unarmed confirm/prompt is dismissed and the click is reported as a failure — do not treat that action as successful.`

export const PRESS_KEY_DESCRIPTION = `Press a key on the keyboard.

A single character, or Enter, Tab, Escape, Backspace, Delete, arrows, Home, End, PageUp, PageDown, Space. Optional modifiers: Control, Meta, Shift, Alt.`

export const WAIT_FOR_DESCRIPTION = `Wait for text to appear or disappear, a CSS selector to become visible, a URL, or a specified time to pass.

Avoid wait by default; use only when no reliable UI state exists. Do not use this just to "let the page settle" after click/type — those already wait. \`time\` is capped at 30s.`

export const HOVER_DESCRIPTION = `Hover over element on page. Returns a compact snapshot after the hover (useful for menus).`

export const HIGHLIGHT_DESCRIPTION = `Highlight an element by ref on the page for visual grounding.`

export const GET_BOUNDING_BOX_DESCRIPTION = `Get the viewport bounding box (x, y, width, height) for a snapshot ref.`

export const SCROLL_DESCRIPTION = `Scroll the page or bring an element into view.

Pass ref + \`scrollIntoView\` to bring an element into view. Pass \`direction\` + \`amount\` to wheel. Without ref, scrolls the page.`

export const SCREENSHOT_DESCRIPTION = `Take a screenshot of the page or an element.

Layout, spacing, and visual checks — not for choosing what to click. Pass \`labels: true\` to overlay snapshot refs on the image and return their boxes. The image is downscaled; the full copy is saved to disk. Do not screenshot after a file upload while a PDF/iframe viewer is open — it times out. Use the snapshot from ${'`browser_file_upload`'}, or close the viewer and capture a new snapshot.`

export const CONSOLE_DESCRIPTION = `Read console messages from the page.

Returns errors, warnings, and logs since the last browser action (or since \`clear\`).`

export const NETWORK_DESCRIPTION = `Read network requests from the page.

Returns fetch/XHR metadata since the last browser action (or since \`clear\`). Document navigations and static assets are not included.`

export const TABS_DESCRIPTION = `List, create, close, or select browser tabs.

- \`list\`: tabs this agent owns (opened here, or shared from the extension popup). Empty is normal in extension mode.
- \`new\`: open a tab (optional url)
- \`close\`: close a tab by targetId
- \`select\`: make a tab current`

export const DRAG_DESCRIPTION = `Drag from one snapshot ref to another. Use this, not CDP Input.*.`

export const RESIZE_DESCRIPTION = `Resize the browser viewport.`

export const WAIT_FOR_DOWNLOAD_DESCRIPTION = `Wait for a file download to finish and save it to disk. Pass \`ref\` to click that element first, then wait; omit \`ref\` if a click already started the download.`

export const LOCK_DESCRIPTION = `Take or release control of the current tab.

- \`unlock\`: user takes the page (captcha, 2FA, payment). Do not click or type until they finish.
- \`lock\`: agent resumes driving the page.`

/** Shown in ToolSearch / deferred catalog so coding agents can find evaluate. */
export const CDP_SUMMARY =
  'Send a CDP command; Runtime.evaluate when a control has no snapshot ref'

/**
 * Tool description: Cursor's one-sentence CDP contract, plus Baize runtime
 * notes (Playwright Chrome, not Cursor's Electron MCP host).
 */
export const CDP_DESCRIPTION = `Send a Chrome DevTools Protocol command to the target browser tab. Do not use CDP Input.* methods; use dedicated browser tools for clicks, text input, key presses, scrolling, and drag-and-drop. Browser-wide, storage, cookie, permission, download, target-management, and system-level commands are denied.

Do **not** call DOM.getDocument / DOM.getFlattenedDocument — those always overflow and are not useful for clicks. Use Runtime.evaluate with a small querySelector expression (return a short value or click and return "clicked"), or browser_snapshot / browser_get_text.

Use Runtime.evaluate when a control has no snapshot ref (unlabeled inputs) or dedicated tools cannot reach it. Prefer returnByValue. Prefer ${'`browser_get_text`'} for page prose instead of evaluate that returns large DOM strings. Poll with short evaluate / DOM / snapshot checks rather than one long wait. Large results and Profiler.stop are written to a file under the session browser directory — Grep/Read with offset+limit; do not Bash the whole file into context.`
