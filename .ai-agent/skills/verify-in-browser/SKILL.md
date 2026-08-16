---
name: verify-in-browser
description: >-
  Verify frontend changes by driving a real browser with the browser_* tools:
  start the dev server, open the page, read the accessibility snapshot, interact,
  and check the console. Use after changing UI code, when a page renders wrong,
  when reproducing a frontend bug, or when the user asks whether something
  actually works in the browser.
---

# Verifying frontend work in a browser

Changing UI code and reporting success without loading the page is guessing.
The `browser_*` tools drive a real Chrome, so verify the change the way a user
would experience it.

## The loop

1. **Start the dev server** with `Bash` and `run_in_background: true`. You will
   be notified when it exits; do not poll it.
2. **Open the page** with `browser_navigate`. It returns an accessibility
   snapshot and any console errors from page load.
3. **Read the snapshot**, not a screenshot. It is text: roles, names and refs.
4. **Interact** with `browser_click` / `browser_type` / `browser_select_option`,
   addressing elements by the `ref` from the latest snapshot. Click/type/press
   wait ~500ms and drain in-flight XHR/fetch before snapshotting.
5. **Check the result** in the snapshot each action returns, and in
   `browser_console` for errors the interaction triggered. If a specific string
   should appear later, `browser_wait_for` with `text` first.

## Snapshot first, screenshot only for looks

`browser_snapshot` is the default. Reach for `browser_screenshot` only to judge
something visual — layout, spacing, alignment, color, whether an element
rendered at all. A screenshot costs far more context than a snapshot and cannot
be searched.

## Refs

A ref identifies an element *and what it meant when you last saw it*. If the
element's role or label changes, the ref stops resolving and you get a
stale-ref error naming the old and new label.

The fix is always the same: take a fresh snapshot and use the new ref. Never
retry the same ref, and never guess an adjacent one.

## Do not go in circles

- If an action fails twice, stop repeating it. Take a snapshot, read the
  console, and form a new hypothesis before acting again.
- If the page is blank or the snapshot is empty, the dev server is the first
  suspect: check its background task output before touching the browser again.
- If four attempts have not moved you forward, stop and report what you
  observed, what blocked you, and the most likely next step.
- Console errors reported alongside an action are usually the real explanation.
  Read them before trying a different selector.

## Which browser you are driving

Usually a Chrome the agent launches, with its own empty profile. If the project
is configured for `browser.mode: "extension"`, the same tools drive the user's
own Chrome instead, so pages load already signed in. That is what makes pages
behind a login readable at all, and reading them when asked is the point — the
caution is about what you *change* on a real account, not about looking.

You cannot see the user's other tabs, only ones you opened or they shared. If a
tool reports a tab "is not shared", open your own with `browser_tabs` action
`new` (same Chrome profile, cookies apply) or ask the user to share a tab from
the extension popup. Do not `select` a guessed id, and do not retry
`browser_navigate` against an unowned tab.

## What to report

State what you verified and how, not just that you looked:

> Opened `http://localhost:5173/settings`, clicked "Save", the toast rendered
> and the console stayed clean.

If you could not verify something, say which part and why.
