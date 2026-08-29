---
name: verify-in-browser
description: >-
  Verify frontend changes by driving a real browser with the browser_* tools:
  start the dev server, open the page, interact, and check the console. Use
  after changing UI code, when a page renders wrong, when reproducing a
  frontend bug, or when the user asks whether something actually works in
  the browser.
---

# Verifying frontend work in a browser

Changing UI code and reporting success without loading the page is guessing.
Drive the page with `browser_*` the way a user would. Snapshot, refs, and
when to stop retrying are already on those tools (and the Browser Automation
agent) — do not invent a second loop.

## Dev server

Start it with `Bash` and `run_in_background: true`. You will be notified when
it exits; do not poll it.

Then `browser_navigate` to the page. If the page is blank or the snapshot is
empty, the dev server is the first suspect: read its background task output
before touching the browser again.

## What to report

State what you verified and how, not just that you looked:

> Opened `http://localhost:5173/settings`, clicked "Save", the toast rendered
> and the console stayed clean.

If you could not verify something, say which part and why. Console errors
reported alongside an action are usually the real explanation — read them
before trying a different control.
