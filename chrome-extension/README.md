# Baize Agent Browser Bridge

Lets the agent drive tabs in **your** Chrome instead of a separate one it
launches. Pages then load with your real cookies and sessions, so the agent can
verify anything behind a login without you scripting a sign-in.

## Why an extension

Attaching to a running Chrome over `--remote-debugging-port` requires
restarting it, and since Chrome 136 a profile launched that way refuses to
attach to your normal user data dir. `chrome.debugger` is the extension's own
capability, so no restart, no flags, and no security prompt.

## Install

1. Open `chrome://extensions`, turn on **Developer mode**, click **Load
   unpacked**, and select this `chrome-extension/` folder.

2. Tell the agent to use it, in `.ai-agent/settings.json`:

   ```json
   {
     "browser": {
       "mode": "extension"
     }
   }
   ```

   Without this the agent keeps using its own isolated Chrome. The tools behave
   identically either way.

That is the whole setup. There is nothing to copy and no port to configure:
the first time the agent needs the browser it opens a tab asking for access,
and you press **Allow**.

## How the connection works

The agent listens on a loopback port the OS picks for it, at a URL containing
a one-time id, and passes that URL to Chrome on the command line as a page
inside this extension. So the address is only ever known to the extension, and
the extension only dials it after you approve the prompt.

Two things follow from that, both deliberate:

- **The connection belongs to one agent process.** When that process exits, the
  address stops working and the extension forgets it. Nothing long-lived is
  left in the browser, and there is no credential to leak or rotate.
- **Only this extension can connect.** The agent checks the `Origin` of the
  handshake, which Chrome writes itself and a web page cannot forge. Its id is
  pinned to `fpajgihelhfenahgncmdjadkhpcmmbac` by the `key` in `manifest.json`.

## What the agent can and cannot see

The agent only sees tabs it opened itself, plus any tab you explicitly share
from the popup. It cannot enumerate or read the rest of your browsing.

Its tabs are collected into an orange **Agent** tab group so they are easy to
spot, and Chrome shows its own "is debugging this browser" banner on any tab
that is attached. Closing that banner detaches the agent from that tab.

While the agent is driving a tab, **Take control** in the popup (and the same
button in the chat banner) pauses it so you can type, pass a captcha, or finish
a payment. **Resume agent** hands the page back.

To revoke everything, either hit **Stop** next to a tab in the popup, or disable
the extension.

## Hide the debugging banner

When the extension attaches to a tab, Chrome shows a top infobar: *"Baize Agent
Browser Bridge has started debugging this browser"*. The extension cannot
suppress it — it is a browser security notice. Other tools that use
`chrome.debugger` (OpenClaw, Codex, etc.) show the same banner; they only avoid
Chrome's separate blocking **Allow remote debugging?** modal.

To hide the infobar, launch Chrome with Chromium's
`--silent-debugger-extension-api` flag:

1. Quit Chrome completely (on Windows, check Task Manager for stray
   `chrome.exe` processes).
2. Edit your Chrome shortcut's **Target** field and append the flag (note the
   leading space):

   ```text
   "C:\Program Files\Google\Chrome\Application\chrome.exe" --silent-debugger-extension-api
   ```

3. Open Chrome only through that shortcut from now on. Launches from the
   taskbar, Start menu, or another shortcut will not include the flag and the
   banner will return.

Clicking **Cancel** on the banner still detaches the agent from that tab.

## Settings

| Key                 | Default    | Meaning                                                         |
| ------------------- | ---------- | --------------------------------------------------------------- |
| `browser.mode`      | `isolated` | `extension` to drive this browser; `auto` to use it only if already connected |
| `browser.relayPort` | unset      | Pin the loopback port. Only needed behind a strict local firewall |

`auto` never opens the consent tab: it uses this browser if a connection is
already live and quietly falls back to the isolated Chrome otherwise. Use
`npx tsx src/scripts/browser-pair.ts` to offer the browser by hand.

## Troubleshooting

Run `npx tsx src/scripts/browser-pair.ts` first. It performs the same exchange
in its own process and says which step failed.

**No tab appeared when the agent wanted the browser** — it could not find
Chrome. Set `CHROME_PATH` to the executable.

**The tab appeared in the wrong Chrome profile** — Chrome opens the URL in
whichever profile is already running, and the extension has to be installed
there. Load it in that profile, or quit Chrome and let the agent start it.

**Popup says `disconnected`** — nobody has asked for access yet. That is the
resting state. If the agent should have asked: check `browser.mode` is
`extension`, and that you are on the Browser Automation specialist or have set
`browser.enabled: true`.

**Popup says `rejected`** — the agent refused the handshake, which in practice
means the extension is older than the agent. Reload it from
`chrome://extensions`.

**The agent says a tab "is not shared"** — it is trying to reach a tab it does
not own. Let it open its own tab, or share the one you mean from the popup.

## Development

`background.js` is intentionally thin: it owns the socket, decides which tabs
are in scope, and forwards everything else to `chrome.debugger`. All the
snapshot, ref and staleness logic lives in the agent and arrives as ordinary CDP
commands, so this folder should rarely need to change.

`chrome.*` calls arrive by name and are dispatched reflectively against
`ALLOWED_CHROME_COMMANDS`, whose entries also say where each call's tab id
sits so ownership can be checked before anything runs. Only the handful of
methods that carry ownership bookkeeping, or that deliberately act on a tab the
agent does *not* own, are written out by hand.

The handshake reports what this build supports, so an extension older than the
agent degrades with one warning at connect time rather than failing mid-task.
Reload it from `chrome://extensions` after pulling changes to this folder.

Do not remove `"key"` from `manifest.json`. It is the public half of a keypair,
and Chrome derives the extension id from it, which is what lets the agent name
the connect page and check the handshake `Origin` before the extension has ever
spoken to it. `test-extension-e2e.ts` fails loudly if the id ever moves.

The private half was not kept. Loading unpacked does not use it; it would only
be needed to sign a self-hosted `.crx` carrying this same id. If we ever go
that way, generate a fresh keypair, replace `key`, and update
`BRIDGE_EXTENSION_ID` — the id will change and everyone reloads once.

`connect.html` is deliberately **not** in `web_accessible_resources`. Chrome
blocks navigation to an extension page from a web origin unless it is listed
there, which is what stops a website from opening the consent prompt and
pointing it at a relay of its own. Chrome opening the URL from the command
line is not a web origin, so the real path still works.

```bash
npx tsx src/scripts/test-browser-relay.ts   # protocol + tools, simulated extension
npx tsx src/scripts/test-extension-e2e.ts   # this extension, in a real Chrome
```
