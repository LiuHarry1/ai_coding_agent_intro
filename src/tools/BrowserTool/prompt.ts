/**
 * Tool descriptions for browser_* tools.
 */

export const SNAPSHOT_PRIMER = `Elements are addressed by \`ref\` (e.g. \`e12\`) from the latest snapshot. After any action, use the new tree — do not reuse old refs.`

export const LOOP_GUARD = `If the same action fails twice, stop and change approach. If a ref is stale, capture a new snapshot and use the updated refs.`

export const NAVIGATE_DESCRIPTION = `Navigate to a URL, or go back / forward / reload.

Waits for the document and in-flight XHR/fetch, then snapshots. If a list is still empty, ${'`browser_wait_for`'} that text. Session cookies persist across calls.

http(s) only — no file: or javascript: URLs. If a modal is covering the current page, click it — do not navigate away to dismiss it.

${SNAPSHOT_PRIMER}`

export const SNAPSHOT_DESCRIPTION = `Capture accessibility snapshot of the current page, this is better than screenshot.

The tree is Playwright's AI aria snapshot. Clickable nodes have \`[ref=eN]\`. Click those refs. A bare \`text:\` line is not clickable. Prefer this over ${'`browser_screenshot`'} for deciding what to click — you can't perform actions based on a screenshot.

- \`selector\`: one subtree
- \`compact\`: clip depth
- \`interactive\`: only ref-bearing controls
- \`includeDiff\`: only lines that changed since the last snapshot
- \`urls\`: append discovered link destinations

If an in-page modal (\`alertdialog\` / Yes / No / OK) is open, the snapshot is that dialog. Click those refs. That is not ${'`browser_handle_dialog`'} (native \`alert\`/\`confirm\` only).

If the snapshot times out, a PDF or iframe likely stalled the tree. Do not retry a full snapshot, screenshot, or wait in a loop — close the viewer or work from whatever partial tree you have, then capture a new snapshot when the page is usable.

${SNAPSHOT_PRIMER}`

export const CLICK_DESCRIPTION = `Perform click on a web page.

Use \`ref\` from the latest snapshot. Pass \`element\` with a human-readable description (role or name overlap); if it does not match the resolved ref, the call fails. Stale refs are recovered by role/name when possible. The click scrolls into view, dismisses blocking dropdowns, and retries with offset when a non-interactive layer blocks the target. Coordinate \`x\`/\`y\` is for canvas widgets only.

Do not wait or navigate instead of clicking.

${SNAPSHOT_PRIMER}
${LOOP_GUARD}`

export const TYPE_DESCRIPTION = `Type text into editable element (input, textarea, or contenteditable).

Clicks the field, then **replaces** its contents (Playwright \`fill\`). Reports the value that landed; a readonly or disabled field is reported as such. Optional \`element\` must match the resolved ref (same rule as click). \`submit\` presses Enter. \`slowly\` clicks then types at 75ms per character. If the ref points at a non-editable wrapper, capture a new snapshot and use the inner textbox ref.

${SNAPSHOT_PRIMER}`

export const FILL_FORM_DESCRIPTION = `Fill multiple form fields in one call. Prefer this over one ${'`browser_type`'} per field.

Writes every listed field, then settles and snapshots once. Each field comes back as filled, skipped, or failed. Native \`<select>\` uses the visible label. Custom comboboxes: open them and ${'`browser_click`'} the option ref.

${SNAPSHOT_PRIMER}`

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

Avoid wait by default; use only when no reliable UI state exists. Do not use this just to "let the page settle" after click/type — those already wait. \`time\` is capped at 30s.

${SNAPSHOT_PRIMER}`

export const HOVER_DESCRIPTION = `Hover over element on page. Returns a compact snapshot after the hover (useful for menus).`

export const HIGHLIGHT_DESCRIPTION = `Highlight an element by ref on the page for visual grounding.`

export const GET_BOUNDING_BOX_DESCRIPTION = `Get the viewport bounding box (x, y, width, height) for a snapshot ref.`

export const SCROLL_DESCRIPTION = `Scroll the page or bring an element into view.

Pass ref + \`scrollIntoView\` to bring an element into view. Pass \`direction\` + \`amount\` to wheel. Without ref, scrolls the page.`

export const SCREENSHOT_DESCRIPTION = `Take a screenshot of the page or an element.

Use for layout, spacing, and visual checks. Pass \`labels: true\` to overlay snapshot refs on the image and return their boxes. The image is downscaled; the full copy is saved to disk. Do not screenshot after a file upload while a PDF/iframe viewer is open — it times out. Use the snapshot from ${'`browser_file_upload`'}, or close the viewer and capture a new snapshot.`

export const CONSOLE_DESCRIPTION = `Read console messages from the page.

Returns errors, warnings, and logs since the last browser action (or since \`clear\`).`

export const NETWORK_DESCRIPTION = `Read network requests from the page.

Returns fetch/XHR metadata since the last browser action (or since \`clear\`). Document navigations and static assets are not included.`

export const TABS_DESCRIPTION = `List, create, close, or select browser tabs.

- \`list\`: tabs this agent owns (opened here, or shared from the extension popup). Empty is normal in extension mode.
- \`new\`: open a tab (optional url)
- \`close\`: close a tab by targetId
- \`select\`: make a tab current`

export const DRAG_DESCRIPTION = `Drag from one element to another by ref.`

export const RESIZE_DESCRIPTION = `Resize the browser viewport.`

export const WAIT_FOR_DOWNLOAD_DESCRIPTION = `Wait for a file download to finish and save it to disk.`

export const LOCK_DESCRIPTION = `Pause or resume the agent on the current browser tab.

When paused, the user can interact with the page freely (captcha, payment, etc.). Resume hands control back to the agent.`
