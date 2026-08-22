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

1. Print the pairing details:

   ```bash
   npx tsx src/scripts/browser-pair.ts
   ```

2. Open `chrome://extensions`, turn on **Developer mode**, click **Load
   unpacked**, and select this `chrome-extension/` folder.

3. Open the extension's popup and paste the token. The dot turns green once it
   reaches the agent.

4. Tell the agent to use it, in `.ai-agent/settings.json`:

   ```json
   {
     "browser": {
       "mode": "extension"
     }
   }
   ```

   Without this the agent keeps using its own isolated Chrome. The tools behave
   identically either way.

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

## Settings

| Key                  | Default     | Meaning                                        |
| -------------------- | ----------- | ---------------------------------------------- |
| `browser.mode`       | `isolated`  | `extension` to drive this browser               |
| `browser.relayPort`  | `8766`      | Loopback port the extension connects back on    |

The port in the popup must match `browser.relayPort`.

## Troubleshooting

**Popup says `unpaired`** — no token stored yet. Paste the one from
`browser-pair.ts`.

**Popup says `rejected`** — the token does not match the agent's. The agent
keeps it in `~/.ai-agent/browser/relay.json`; re-run `browser-pair.ts` and paste
again. The extension deliberately stops retrying on a rejection.

**Popup says `disconnected`** — the agent is not running, you are not on the Browser Automation specialist (and `browser.enabled` is not `true`), or it is listening on a different port. Set `browser.mode` to `extension`, switch to the browser agent or set `browser.enabled: true`, then restart the agent.

**The agent says a tab "is not shared"** — it is trying to reach a tab it does
not own. Let it open its own tab, or share the one you mean from the popup.

## Development

`background.js` is intentionally thin: it owns the socket, decides which tabs
are in scope, and forwards everything else to `chrome.debugger`. All the
snapshot, ref and staleness logic lives in the agent and arrives as ordinary CDP
commands, so this folder should rarely need to change.

```bash
npx tsx src/scripts/test-browser-relay.ts   # protocol + tools, simulated extension
npx tsx src/scripts/test-extension-e2e.ts   # this extension, in a real Chrome
```
