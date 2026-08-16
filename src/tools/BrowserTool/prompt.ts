/**
 * Tool descriptions. These are the only place the model learns the ref
 * workflow, so they carry the loop-avoidance rules too — a tool that fails
 * without telling the model what to do instead is how agents end up clicking
 * the same dead element ten times.
 */

export const SNAPSHOT_PRIMER = `Elements are addressed by \`ref\` (e.g. \`e12\`) taken from the most recent snapshot. Refs stay valid while the element lives, and are re-checked against what the snapshot showed you — if the page rewrote that element you get a stale-ref error, and the fix is always to take a fresh snapshot rather than retry.`

export const LOOP_GUARD = `If the same action fails twice, stop and change approach: take a snapshot, read the console, or report what is blocking you. Do not retry a failing interaction more than once without new evidence.`

export const NAVIGATE_DESCRIPTION = `Navigate the browser to a URL and return a snapshot of the resulting page.

Use this to verify frontend work: start the dev server with a background Bash task, then navigate to it and inspect the result.

- Waits for the document to load and the DOM to settle before snapshotting
- Reports any console errors produced during load
- Reuses one browser instance across calls, so the session keeps cookies and localStorage between navigations

${SNAPSHOT_PRIMER}`

export const SNAPSHOT_DESCRIPTION = `Capture an accessibility snapshot of the current page: a structured tree of roles, names and refs.

Prefer this over ${'`browser_screenshot`'} for understanding page structure and finding things to interact with — it is text, so it is cheaper and more precise than an image. Use a screenshot when you need to judge visual appearance (layout, spacing, color).

The tree comes from Playwright's AI accessibility snapshot (ariaSnapshot mode "ai") when \`browser.engine\` is \`playwright\`, otherwise from the injected distiller. Either way, clickable nodes carry \`[ref=eN]\`. Click those refs; do not invent inbox/chat URLs because a label has no ref.

Click the named control (the node whose accessible name matches the button/link), not a numeric badge sitting next to it. After a click, use the new snapshot's refs — never reuse a ref from before the click.

Click, type, navigate and wait_for return an updated full-page snapshot. Pass \`selector\` only when you want one subtree (a unique panel). Do not assume an open dialog is the whole result — a page can have several. Pass \`compact: true\` to drop structural wrappers; compact does not clip a selected subtree. A truncated snapshot keeps open dialogs and end-of-tree widgets (chat docks); the long middle of the page is what gets dropped.

${SNAPSHOT_PRIMER}`

export const CLICK_DESCRIPTION = `Click an element identified by its ref from the latest snapshot.

Dispatches a real trusted mouse event, so pages cannot tell it apart from a user click. After the click, waits ~500ms and drains in-flight XHR/fetch (same as Playwright MCP), then returns a full-page snapshot plus any console errors the click triggered.

Read that tree for new refs. Pass \`selector\` only to zoom into one subtree. For content that appears later than the settle, use \`browser_wait_for\`.

${SNAPSHOT_PRIMER}
${LOOP_GUARD}`

export const TYPE_DESCRIPTION = `Type text into a text field identified by its ref.

- Clicks the field first, then inserts the text
- Set \`submit\` to press Enter afterwards (search boxes, login forms)
- Set \`slowly\` to send per-character key events — needed by autocomplete and combobox widgets that react to keydown, but slower
- After typing (and optional Enter), waits ~500ms and drains in-flight XHR/fetch, then returns a snapshot

To replace existing content rather than append, use \`browser_evaluate\` to clear it first, or select-all with \`browser_press_key\`. After sending a message, call \`browser_wait_for\` with the exact text, then read the snapshot — the wait matches the string anywhere, including the field you just typed into.

${SNAPSHOT_PRIMER}`

export const SELECT_OPTION_DESCRIPTION = `Choose one or more options in a \`<select>\` element. Match by option value or visible label. Lists the available options when nothing matches.`

export const PRESS_KEY_DESCRIPTION = `Press a key on the focused element. Accepts a single character, or one of: Enter, Tab, Escape, Backspace, Delete, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Home, End, PageUp, PageDown, Space. Combine with modifiers (Control, Meta, Shift, Alt) for shortcuts.

After the key, waits ~500ms and drains in-flight XHR/fetch, then returns a snapshot. For a specific string that appears later (a sent-message bubble, a toast), use \`browser_wait_for\`.`

export const WAIT_FOR_DESCRIPTION = `Wait for text to appear or disappear, or for a number of seconds to pass, then return a snapshot.

Use this when click/type/press already returned but the thing you care about is not in that snapshot yet — a toast, a sent-message bubble, a list that loads after the request.

- \`text\`: wait until this string is visible on the page (substring match anywhere, including a still-filled composer)
- \`textGone\`: wait until this string is no longer visible
- \`time\`: wait this many seconds (capped at 10)
- Provide at least one of the three

Click, type and press already wait ~500ms and drain in-flight XHR/fetch. Do not call this just to "let the page settle" after those — only when you need a specific string or a longer pause.

${SNAPSHOT_PRIMER}`

export const HOVER_DESCRIPTION = `Hover the mouse over an element. Use to reveal menus, tooltips and other hover-only UI before interacting with it.`

export const SCROLL_DESCRIPTION = `Scroll the page or a scrollable element with a real wheel event. Positive \`deltaY\` scrolls down.

When \`ref\` is set, the target is scrolled into view and the wheel is applied to its nearest overflow container — not the window. Use that for lists inside a dialog or dock. Snapshots cover the whole document, so scroll mainly for lazy-loaded content and for positioning before a screenshot.`

export const SCREENSHOT_DESCRIPTION = `Take a screenshot of the page or of a single element.

Use for visual judgement — layout, spacing, colors, whether something rendered correctly. For finding and interacting with elements, use \`browser_snapshot\` instead: it is text and far cheaper.

The image is downscaled before it reaches you; the full-resolution copy is written to disk and its path is reported.`

export const CONSOLE_DESCRIPTION = `Read messages the page logged to the console, including uncaught errors and unhandled promise rejections.

Capture starts as soon as the page loads, so this reports errors that happened before you looked. Interaction tools already surface errors they caused — use this to review the full log or non-error levels.`

export const NETWORK_DESCRIPTION = `List HTTP requests the page made with fetch or XMLHttpRequest, with method, URL, status and duration.

Use this to tell apart the two failures that look identical in the UI: a request that reached the server and came back 4xx/5xx, and one that never left the browser at all (reported as \`never sent\` — wrong URL, server down, CORS, or aborted). Requests still in flight show as pending, which is the signature of a hung call.

Capture starts when the page loads. Interaction tools already report failed requests they caused, so reach for this to see successful traffic too, to confirm a call fired at all, or to review what happened before you looked.

Only fetch and XHR are visible — not document navigation, images, scripts or stylesheets.`

export const TABS_DESCRIPTION = `List, select, open or close browser tabs.

- \`list\` shows tabs the agent owns (ones it opened, or that the user shared from the extension popup). An empty list is expected in extension mode — you cannot see the user's other tabs.
- Do not \`select\` a guessed id such as \`"0"\` when the list is empty. That tab is not shared.
- \`new\` opens a tab in the same Chrome profile (cookies and login apply) and selects it. Prefer this when the list is empty.
- \`select\` switches which owned tab subsequent tools act on
- \`close\` closes a tab`

export const EVALUATE_DESCRIPTION = `Evaluate a JavaScript expression in the page and return its value.

The expression is awaited, so \`fetch(...)\` and other promises work. Use for reading application state, clearing inputs, or assertions that a snapshot cannot express — not as a substitute for real clicks and typing, which exercise the code paths a user would.`
