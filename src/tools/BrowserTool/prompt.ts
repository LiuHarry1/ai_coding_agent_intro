/**
 * Tool descriptions. Aligned with Playwright MCP (short verbs, snapshot-first)
 * and Cursor (do not act from screenshots; stop after repeated failures).
 */

export const SNAPSHOT_PRIMER = `Elements are addressed by \`ref\` (e.g. \`e12\`) from the latest snapshot. After any action, use the new tree — do not reuse old refs.`

export const LOOP_GUARD = `If the same action fails twice, stop and change approach. If a snapshot timed out, do not retry ${'`browser_snapshot`'} / ${'`browser_screenshot`'} / ${'`browser_wait_for`'} — ${'`browser_click`'} with \`role\` + \`name\`.`

export const NAVIGATE_DESCRIPTION = `Navigate to a URL, or go back / forward / reload.

Waits for the document and in-flight XHR/fetch, then snapshots. If a list is still empty, ${'`browser_wait_for`'} that text. Session cookies persist across calls.

http(s) only — no file: or javascript: URLs. If a modal is covering the current page, click it — do not navigate away to dismiss it.

${SNAPSHOT_PRIMER}`

export const SNAPSHOT_DESCRIPTION = `Capture accessibility snapshot of the current page, this is better than screenshot.

The tree is Playwright's AI aria snapshot. Clickable nodes have \`[ref=eN]\`. Click those refs. A bare \`text:\` line is not clickable. Prefer this over ${'`browser_screenshot`'} for deciding what to click — you can't perform actions based on a screenshot.

- \`selector\`: one subtree
- \`compact\`: clip depth (Playwright MCP \`depth\`)
- \`interactive\`: only ref-bearing controls
- \`includeDiff\`: only lines that changed since the last snapshot

If an in-page modal (\`alertdialog\` / Yes / No / OK) is open, the snapshot is that dialog. Click those refs. That is not ${'`browser_handle_dialog`'} (native \`alert\`/\`confirm\` only).

If the snapshot times out, a PDF or iframe likely stalled the tree. Do not retry a full snapshot, screenshot, wait, or evaluate. Click with ${'`browser_click`'} \`role\` + \`name\` (Playwright \`getByRole\`).

${SNAPSHOT_PRIMER}`

export const CLICK_DESCRIPTION = `Perform click on a web page.

Prefer \`ref\` from the latest snapshot. Optional \`element\` is checked against the live node (Cursor stale-ref). \`role\` + \`name\` is only allowed after a snapshot timeout. After a detached ref, the engine relocates by the last known role+name when it is unique. Coordinate \`x\`/\`y\` is for canvas widgets only.

Do not ${'`browser_evaluate`'} a click, do not wait, do not navigate.

${SNAPSHOT_PRIMER}
${LOOP_GUARD}`

export const TYPE_DESCRIPTION = `Type text into editable element.

Clicks the field, then **replaces** its contents (Playwright \`fill\`). Reports the value that landed; a readonly or disabled field is reported as such. \`submit\` presses Enter. \`slowly\` clicks then types at 75ms per character.

${SNAPSHOT_PRIMER}`

export const FILL_FORM_DESCRIPTION = `Fill multiple form fields in one call (Playwright MCP \`browser_fill_form\`). Prefer this over one ${'`browser_type`'} per field.

Writes every listed field, then settles and snapshots once. Each field comes back as filled, skipped, or failed. Native \`<select>\` uses the visible label. Custom comboboxes: open them and ${'`browser_click`'} the option ref — do not ${'`browser_evaluate`'} the value.

${SNAPSHOT_PRIMER}`

export const SELECT_OPTION_DESCRIPTION = `Select an option in a native \`<select>\` dropdown.

Pass the visible label (Playwright \`selectOption\`). Custom combobox / listbox / calendar widgets are not a select: open the popup and ${'`browser_click`'} the option's ref from a snapshot.`

export const FILE_UPLOAD_DESCRIPTION = `Upload one or multiple files.

Sets \`<input type=file>\` (including hidden inputs in frames). Do not click a visible Upload button — that opens a native OS dialog this tool cannot drive. Pass \`ref\` if you have the input. Empty \`paths\` cancels a pending chooser.

Paths are workspace-relative or absolute.

Returns a snapshot after the files are set (same as Playwright MCP). Use that tree for the next click — old refs are stale. A PDF/iframe preview can stall a full snapshot; if it times out or says frames were omitted, ${'`browser_click`'} with \`role\` + \`name\`. Do not wait_for, screenshot, or evaluate to remove the preview.`

export const HANDLE_DIALOG_DESCRIPTION = `Handle a native \`window.alert\` / \`confirm\` / \`prompt\` only.

In-page modals (\`role=alertdialog\`, Yes / No) are snapshot nodes — ${'`browser_click`'} them.

Call this BEFORE the click that opens a native dialog. An unarmed confirm/prompt is dismissed and the click is reported as a failure — do not treat that action as successful.`

export const PRESS_KEY_DESCRIPTION = `Press a key on the keyboard.

A single character, or Enter, Tab, Escape, Backspace, Delete, arrows, Home, End, PageUp, PageDown, Space. Optional modifiers: Control, Meta, Shift, Alt.`

export const WAIT_FOR_DESCRIPTION = `Wait for text to appear or disappear, a CSS selector to become visible, a URL, or a specified time to pass.

Use when the last action's snapshot does not yet contain the result (toast, sent message, list). \`time\` is capped at 30s. Do not use this just to "let the page settle" after click/type — those already wait.

${SNAPSHOT_PRIMER}`

export const HOVER_DESCRIPTION = `Hover over element on page.`

export const SCROLL_DESCRIPTION = `Scroll the page or bring an element into view.

With \`ref\`, Playwright \`scrollIntoViewIfNeeded\` then optional wheel deltas. Without \`ref\`, \`page.mouse.wheel\`.`

export const SCREENSHOT_DESCRIPTION = `Take a screenshot of the current page. You can't perform actions based on the screenshot, use ${'`browser_snapshot`'} for actions.

Use for layout, spacing, and visual checks. The image is downscaled; the full copy is saved to disk. Do not screenshot after a file upload while a PDF/iframe viewer is open — it times out. Use the snapshot from ${'`browser_file_upload`'}, or ${'`browser_click`'} with \`role\` + \`name\`.`

export const CONSOLE_DESCRIPTION = `Returns console messages, including uncaught errors.

Capture starts when the page loads. Interaction tools already attach errors they caused.`

export const NETWORK_DESCRIPTION = `Returns network requests since loading the page (fetch and XHR).

Use to tell a 4xx/5xx that reached the server from a call that never left the browser (\`never sent\`). Pending means still in flight. Document navigation and static assets are not listed.`

export const TABS_DESCRIPTION = `Manage tabs.

- \`list\`: tabs this agent owns (opened here, or shared from the extension popup). Empty is normal in extension mode.
- \`new\`: open a tab in the same Chrome profile
- \`select\` / \`close\`: by tab id from list — do not guess \`"0"\`
- If no tab is selected, ${'`browser_navigate`'} the start URL (opens a tab). Do not pick a leftover tab from a previous task.`

export const EVALUATE_DESCRIPTION = `Evaluate JavaScript on the page (OpenClaw \`evaluate\`).

Awaited, so \`fetch(...)\` and DOM queries work. Optional \`ref\` runs the function on that snapshot node (\`el => el.textContent\`). Prefer ${'`browser_click`'} / ${'`browser_type`'} / ${'`browser_fill_form`'} for driving the page so the app's own handlers run.`

export const LOCK_DESCRIPTION = `Take or release control of the browser.

- \`unlock\`: the user is taking over. Do not click, type, navigate, or fill until they finish.
- \`lock\`: the user is done; resume driving the page.

While the user has control you may still snapshot, screenshot, read console/network, list tabs, wait, find, or evaluate.`

export const FIND_DESCRIPTION = `Search the last accessibility snapshot for a substring (Claude Code find). Cheaper than a new full snapshot. Take a snapshot first if none exists.`

export const DRAG_DESCRIPTION = `Drag one snapshot ref onto another (Playwright dragTo). Use for sliders, kanban cards, and sortable lists.`

export const MOUSE_CLICK_XY_DESCRIPTION = `Click at viewport coordinates. Do not use this when a snapshot ref exists — it is for canvas / map widgets that have no accessibility node.`
