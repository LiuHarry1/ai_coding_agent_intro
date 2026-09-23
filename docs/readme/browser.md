# Browser Automation Guide

> Installing and pairing for the first time? Start with the [Quick Start](getting-started.md).

Coding Agent can open web pages, click elements, fill in forms, take screenshots, and report what it sees. Typical uses include verifying frontend changes and retrieving data from an admin page.

## Choose one of two modes

|                    | `isolated` (default)                                           | `extension`                                                                |
| ------------------ | -------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Browser            | A Chrome instance started by the agent with a separate profile | **Your own Chrome browser**                                                |
| Signed-in sessions | None; each session starts in a fresh browser                   | All accounts already signed in to your browser are available               |
| Installation       | Nothing required                                               | One local extension, installed once                                        |
| Default visibility | Headless; the browser is not visible                           | Runs in the browser window in front of you                                 |
| Best for           | Verifying localhost and public pages                           | Sites requiring sign-in, intranet admin systems, and sites that block bots |

The choice is simple: **does the page require sign-in?** If not, use `isolated` with no configuration. If it does, use `extension`.

Tool behavior is identical in both modes, so switching modes does not require changing your prompts.

---

## Option 1: `isolated` mode (default, no configuration)

Start the backend:

```bash
npm start
```

Then tell Coding Agent, “Open http://localhost:5173 and check whether the sign-in button renders correctly.”

The browser is **headless** by default, so it is not visible. To watch the agent work, add the following to `.ai-agent/settings.json`:

```json
{
  "browser": {
    "mode": "isolated",
    "headless": false
  }
}
```

**Restart the agent** after making the change. A separate Chrome window will then display the agent's actions.

> This browser uses `~/.ai-agent/browser/profile` and is completely isolated from your everyday Chrome profile. It has none of your cookies, extensions, or history. Sites such as Baidu and Google may therefore present a CAPTCHA because the browser looks like a new automated client. This is not a bug. Switch to `extension` mode when this occurs.

---

## Option 2: `extension` mode (use your own Chrome browser)

Pages load with your actual signed-in session, without requiring a login script.

### 1. Install the extension

Your everyday Chrome browser **does not need to be restarted**:

1. Open `chrome://extensions` and enable **Developer mode** in the upper-right corner.
2. Click **Load unpacked** and select the repository's `chrome-extension/` directory.

> Do not use the adjacent **Pack extension** button. The generated `.crx` cannot be installed by dragging it into modern Chrome because non-store sources are rejected. The generated `.pem` is also a private signing key; do not commit it to the repository (it is already included in `.gitignore`). Use **Load unpacked** to install the local extension.

### 2. Update the configuration

`.ai-agent/settings.json`:

```json
{
  "browser": {
    "mode": "extension"
  }
}
```

### 3. Restart the agent

```bash
npm start
```

**This step is required.** The relay service listens only when the **Browser Automation** expert is selected (or `browser.enabled: true`) and `mode` is `extension` or `auto`. The default Coding Agent does not start the relay. The startup log should contain:

```
[browser] extension relay listening on 127.0.0.1:53417
```

The port is assigned by the operating system and differs on every run, so nothing needs to be configured to match it.

### 4. Approve the connection

There is no token to copy. The first time the agent needs the browser, it opens a tab titled **Connect this browser to the agent?**; press **Allow** and the dot in the extension popup turns green.

That approval covers the running agent process. The address it approved stops working when that process exits, so the next agent run asks again. Nothing durable is stored in the browser, which is why there is no credential to rotate or leak.

If no tab appears, run `npm run browser:pair`. It performs the same exchange in its own process and reports which step failed.

### 5. Verify the connection

Tell Coding Agent, “Open `<a-page-where-you-are-signed-in>` and tell me which
account is currently signed in.” It should identify your account instead of
showing the sign-in page.

---

## What Coding Agent can and cannot see

This access boundary is the most important aspect of `extension` mode:

- **Visible**: tabs opened by the agent and tabs you explicitly share by clicking **Share this tab** in the extension popup
- **Not visible**: all your other tabs. The agent cannot list them or read their content

To let Coding Agent access a page that is already open, share it from the popup first. The popup lists every tab currently shared with the agent, and you can revoke access at any time. Tabs used by the agent are automatically placed in an **Agent** tab group so you can identify them easily.

If you disable the extension or revoke access, the agent immediately loses access.

**It does not take focus from your window.** Extension mode does not call `Page.bringToFront` or use `windows.focus` to bring Chrome to the foreground. Read operations—opening pages, capturing snapshots, and taking screenshots—run entirely in background agent tabs and **do not switch the active tab**. Only write operations such as clicking and typing use `tabs.update({ active: true })` to activate an agent tab (L1), and by default the extension **does not** switch back to your original tab afterward. To return automatically to the previous tab after a sequence of operations, set `restoreTabAfterInput: true` in the settings. If you do not want the active tab to change at all, use **isolated** mode, which runs in a separate Chrome window.

---

## 23 tools

You generally do not need to memorize these tools; describe your goal in natural language. This list helps you understand the tool cards shown in the conversation:

| Tool                        | Purpose                                                                                                                     |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `browser_navigate`          | Open an HTTP(S) URL, or navigate back, forward, or refresh                                                                  |
| `browser_snapshot`          | Capture the page structure; optionally use `includeDiff` / `urls`                                                           |
| `browser_click`             | Click a snapshot ref                                                                                                        |
| `browser_mouse_click_xy`    | Click coordinates from a fresh viewport screenshot for a canvas or visual-only control with no snapshot ref                  |
| `browser_drag`              | Drag one ref to another                                                                                                     |
| `browser_type`              | Enter text, optionally pressing Enter to submit                                                                             |
| `browser_fill_form`         | Fill multiple fields at once—text fields, checkboxes, radio buttons, and selects—and report each result                     |
| `browser_select_option`     | Select a native `<select>` option by visible text; for a custom dropdown, take a snapshot and click the option ref          |
| `browser_file_upload`       | Intercept a file picker and upload a file without opening a system dialog                                                   |
| `browser_handle_dialog`     | Accept or dismiss a native alert, confirm, or prompt dialog                                                                 |
| `browser_press_key`         | Press a key or key combination                                                                                              |
| `browser_wait_for`          | Wait for text to appear or disappear, or wait briefly                                                                       |
| `browser_hover`             | Hover over an element                                                                                                       |
| `browser_scroll`            | Scroll the page or an element                                                                                               |
| `browser_screenshot`        | Capture the full page or one element; `labels` overlays ref annotations                                                     |
| `browser_resize`            | Change the viewport dimensions                                                                                              |
| `browser_wait_for_download` | Wait for the next download and save it                                                                                      |
| `browser_console`           | Read console output and uncaught exceptions                                                                                 |
| `browser_network`           | List fetch/XHR requests made by the page, including status codes and durations                                              |
| `browser_highlight`         | Highlight a ref on the page for visual alignment                                                                            |
| `browser_get_bounding_box`  | Read the viewport bounding box of a ref                                                                                     |
| `browser_tabs`              | List, create, switch, or close tabs                                                                                         |
| `browser_lock`              | Give control to the user (`unlock`) or return it to the agent (`lock`)                                                      |

After the browser starts, a banner appears at the top of the chat. Click **Take control** to pause the agent and operate the page yourself; click **Resume agent** to return control. While paused, the agent can perform only read operations—snapshots, screenshots, console and network inspection, and tab listing. It cannot click or type. The extension-mode popup provides the same controls.

The **Show page structure** button on a tool card expands the snapshot representing what the agent could “see” at that time. Use it to investigate why the agent clicked the wrong element.

### The most useful tool for API debugging

`browser_network` distinguishes two failures that look identical in the interface:

- **The request reached the server but was rejected**—a status code is present, such as `500 POST /api/order/save`.
- **The request was never sent**—the tool displays `never sent` and a reason, such as an incorrect address, an unavailable service, CORS, or cancellation.

These failures require completely different fixes and cannot be distinguished by visually inspecting the page.

You also **do not need to ask explicitly**. If any action—clicking, typing, or navigation—triggers a failed request, its tool card includes that failure automatically, just like a console error. A typical “nothing happened when I clicked” problem can therefore be diagnosed in one pass:

> Clicking “Save” does nothing. Find out why.

After clicking, the agent can see `500 POST /api/order/save`, inspect the page script, and discover that `catch(() => {})` swallowed the error.

Only fetch and XMLHttpRequest traffic is visible. Document navigation and
subresources such as images, scripts, and stylesheets are not visible because
they require a CDP event channel, which the current architecture intentionally
omits.

---

## Configuration

Place all fields under `browser` in `.ai-agent/settings.json`:

| Field                  | Default    | Description                                                                                                                                                                    |
| ---------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `mode`                 | `isolated` | `isolated`, `extension`, or `auto` (use the extension if it is already connected, otherwise fall back to `isolated` without prompting)                                          |
| `enabled`              | `false`    | By default, Coding Agent and other primary agents have no `browser_*` tools; `true` restores deferred availability. The **Browser Automation** expert always has browser tools |
| `headless`             | `true`     | `isolated` mode only; set to `false` to show the window                                                                                                                        |
| `relayPort`            | unset      | `extension` mode only; pins the loopback port instead of letting the operating system assign one. Only needed behind a strict local firewall                                    |
| `channel`              | `chrome`   | `isolated` mode only; specifies the Chrome channel                                                                                                                             |
| `viewportWidth`        | `1280`     | `isolated` mode only                                                                                                                                                           |
| `viewportHeight`       | `800`      | `isolated` mode only                                                                                                                                                           |
| `idleTimeoutMinutes`   | `30`       | Number of idle minutes before the browser closes                                                                                                                               |
| `restoreTabAfterInput` | `false`    | `extension` mode only; whether to return to your previous tab after clicking or typing                                                                                         |

Restart the agent after changing any field.

---

## Troubleshooting

| Symptom                                                 | Cause and resolution                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| “I cannot see it operating my browser”                  | It is probably still using the default headless `isolated` mode. Look for `[browser] extension relay listening` in the startup log; if it is absent, the agent is not in `extension` mode                                                                                                |
| `No browser extension is connected`                     | The consent tab was never approved, or the extension is not installed. Run `npm run browser:pair` to see which                                                                                                                                                                            |
| No consent tab appears when the agent needs the browser | The agent could not find Chrome. Set `CHROME_PATH` to the executable                                                                                                                                                                                                                      |
| The consent tab opens in the wrong Chrome profile       | Chrome opens the URL in whichever profile is already running, and the extension must be installed there. Load it in that profile, or quit Chrome and let the agent start it                                                                                                              |
| Baidu or Google displays a CAPTCHA                      | The empty profile in `isolated` mode looks automated. Switch to `extension` mode to use your real session                                                                                                                                                                                 |
| `Ref e3 is stale`                                       | The page changed and the snapshot expired. Capture a new snapshot; the agent normally handles this automatically                                                                                                                                                                          |
| “It switches to its tab whenever it performs an action” | Write operations in extension mode require L1 activation of the agent tab for input; read operations do not switch tabs. By default, it does not switch back. Set `restoreTabAfterInput: true` to return after about 0.6 seconds without activity. For no disruption, use `isolated` mode |
| `The page is still hidden after being brought to front` | This is legacy behavior; the current extension no longer calls `bringToFront`. If it still occurs, restart the agent and reload the extension                                                                                                                                             |
| The popup says `rejected`                               | The agent refused the handshake, which in practice means the extension is older than the agent. Reload it from `chrome://extensions`                                                                                                                                                     |
| The popup went back to `disconnected` on its own        | Expected when the agent process exits: the address it approved no longer works, so the extension stops retrying and forgets it                                                                                                                                                           |

---

## Related commands

| Command                      | Description                                                                                                                                           |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run browser:pair`       | Run the connect exchange in its own process to check the extension is installed and can reach the agent                                               |
| `npm run browser:dev-chrome` | Start a separate Chrome instance with the extension installed, allowing you to test extension mode without affecting your everyday browser            |
| `npm run test:browser:unit`  | Run browser unit tests; takes about one second and does not require Chrome                                                                            |
| `npm run test:browser`       | Run the complete suite: unit, boundary, isolated backend, relay, and real-extension end-to-end tests                                                  |

## Further reading

- Extension source: `chrome-extension/`
- Architecture overview: [`../architecture/browser.md`](../architecture/browser.md)
- Architecture overview: [`../architecture/browser.md`](../architecture/browser.md)
