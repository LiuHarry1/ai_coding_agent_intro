# Coding Agent Quick Start

Coding Agent is a **browser automation assistant**: tell it what to do, and it can open web pages, click buttons, fill in forms, and report what it sees on the page. It also provides programming assistance such as reading and writing code and running commands.

This guide is for **first-time users**. Getting started from scratch takes about 15–30 minutes.

> To debug the Web UI locally, see [Local Development](development.md). For
> the complete feature index, see the [documentation home](../index.md).

---

## Prerequisites

| Item                                            | Requirement                                                        |
| ----------------------------------------------- | ------------------------------------------------------------------ |
| Computer                                        | Windows 10/11, macOS, or Linux                                     |
| [Node.js](https://nodejs.org/)                  | **Version 20 or later** (select “Add to PATH” during installation) |
| [Google Chrome](https://www.google.com/chrome/) | Required only when using your own browser's signed-in session      |
| LLM API                                         | Ask your team for the API endpoint and key                         |

### Open a terminal

- **Windows**: press `Win + R`, enter `cmd`, and press Enter.
- **macOS**: open the Terminal app.

Verify that Node.js is installed:

```bash
node -v
npm -v
```

If the commands display versions such as `v20.x.x` and `10.x.x`, respectively, the environment is ready.

---

## Step 1: Download the code

### Option A — Use Git (recommended)

```bash
git clone <your-repository-url>
cd coding-agent
```

### Option B — Download a ZIP file

1. Open the GitHub repository page.
2. Click the green **Code** button, then **Download ZIP**.
3. Extract it to a location such as `C:\Users\your-name\coding-agent`.
4. Navigate to that folder in the terminal:

```bash
cd C:\Users\your-name\coding-agent
```

---

## Step 2: Install dependencies

Run the following commands from the project root, waiting for each command to finish before running the next:

```bash
npm install
```

```bash
cd client/web && npm install && cd ../..
```

**Success indicator**: no red `ERROR` appears, and the terminal ends in the project root.

---

## Step 3: Configure the LLM

Model configuration belongs in `.ai-agent/settings.json`, not `.env`.

1. If `settings.json` does not exist, copy the example file:

```bash
cp .ai-agent/settings.example.json .ai-agent/settings.json
```

If `cp` is unavailable on Windows, use File Explorer to copy `.ai-agent/settings.example.json` manually and rename it to `settings.json`.

2. Open `.ai-agent/settings.json` in Notepad or VS Code.
3. Replace `baseURL`, `apiKey`, and `model` with the values provided by your team.

Save the file.

| Configuration                                     | Location                                           |
| ------------------------------------------------- | -------------------------------------------------- |
| LLM API (`baseURL`, `apiKey`, and `model`)        | `.ai-agent/settings.json`                          |
| Port, workspace path, and other optional settings | `.env` in the repository root                      |
| Browser mode                                      | The `browser` section of `.ai-agent/settings.json` |

---

## Step 4: Start the desktop app

Run this command from the project root:

```bash
npm run desktop:dev
```

The first launch may take longer because it builds the interface.

**Success indicator**: a desktop window opens with the Coding Agent chat interface.

> The desktop app starts the agent automatically in the background. You generally **do not need** to run `npm start` separately.

---

## Step 5: Try browser automation (no extension required)

1. In the chat interface, select the **Browser Automation** expert.
2. Enter a request directly, for example:

   > Open https://example.com and tell me the page title.

The default **isolated** mode opens a separate Chrome instance for the agent. Sites that **do not require sign-in** work immediately with **no configuration**.

---

## Step 6 (optional): Use your own Chrome session

If a task requires an **already signed-in account**—for example, an admin console, email account, or intranet—complete the following setup once. **Pairing is required only once.**

### 6.1 Update the configuration

Edit `.ai-agent/settings.json` and ensure it contains:

```json
{
  "browser": {
    "mode": "extension"
  }
}
```

If the file already contains other fields, change only the `browser` section and preserve everything else.

### 6.2 Restart the desktop app

Close the Electron window, then run:

```bash
npm run desktop:dev
```

### 6.3 Get the pairing token

**Keep the desktop app running**, open a new terminal, and run this command from the project root:

```bash
npm run browser:pair
```

The terminal prints a **Port** and **Token**. Copy the token for the next step.

### 6.4 Install the Chrome extension (one time only)

1. Enter `chrome://extensions` in the Chrome address bar.
2. Enable **Developer mode** in the upper-right corner.
3. Click **Load unpacked**.
4. Select the project's `chrome-extension` folder, not the repository root.

### 6.5 Pair the extension

1. Click the Coding Agent extension icon in the Chrome toolbar.
2. Paste the **Token** from the previous step.
3. Click **Pair**.

**Success indicator**: the dot beside the extension icon turns **green**.

### 6.6 Verify the connection

Tell the agent:

> Open a site where I am already signed in and tell me which account is currently signed in.

It should identify your account instead of showing the sign-in page.

For complete instructions, see the [Browser Automation Guide](browser.md).

---

## Everyday use

| Goal                               | Action                                                                                                                       |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Open the desktop app               | From the project root, run `npm run desktop:dev`                                                                             |
| Use public websites or local pages | No extension is needed; enter your request directly                                                                          |
| Use sites that require sign-in     | Ensure the extension is paired (green dot). If necessary, click **Share this tab** in the extension to share the current tab |
| View the pairing code again        | Run `npm run browser:pair` (the token normally does not change)                                                              |

---

## Troubleshooting

| Symptom                                                     | Resolution                                                                              |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `node` is not recognized as an internal or external command | Reinstall Node.js, select Add to PATH, and restart the terminal                         |
| The desktop app does not open or shows a blank screen       | Confirm that you ran `npm install` both in the project root and under `client/web`      |
| The agent does not respond                                  | Verify the API configuration in `.ai-agent/settings.json`                               |
| Clicking Pair in the extension does nothing                 | Confirm that `browser.mode` is `extension` and that you **restarted** the desktop app   |
| `No browser extension is connected`                         | The extension is not installed or paired, or the agent is not running in extension mode |
| Baidu or Google displays a CAPTCHA                          | Switch to extension mode and use your own signed-in Chrome session                      |

---

## Next steps

- [Documentation home](../index.md) — feature and architecture index
- [Browser Automation Guide](browser.md) — Both modes, tool reference, and troubleshooting
- [Local Development](development.md) — Web UI hot reload and prompt trace debugging
