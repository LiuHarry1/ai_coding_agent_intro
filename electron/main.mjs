/**
 * Electron main process — starts the agent HTTP server as a child process,
 * then opens a BrowserWindow pointed at the same origin the web build uses
 * in production (http://127.0.0.1:<PORT>).
 */
import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..')
const DEFAULT_PORT = 4567
const EXAMPLE = '08-basic'

let agentProc = null
let mainWindow = null
let agentPort = DEFAULT_PORT

function getAppRoot() {
  return app.isPackaged ? app.getAppPath() : REPO_ROOT
}

function getWebDistDir() {
  return path.join(getAppRoot(), 'client', 'web', 'dist')
}

function getAgentUrl() {
  return `http://127.0.0.1:${agentPort}`
}

function pipeAgentLogs(proc) {
  proc.stdout?.on('data', chunk => process.stdout.write(`[agent] ${chunk}`))
  proc.stderr?.on('data', chunk => process.stderr.write(`[agent] ${chunk}`))
}

function startAgent() {
  const appRoot = getAppRoot()
  const env = {
    ...process.env,
    PORT: String(agentPort),
  }

  if (app.isPackaged) {
    const tsxCli = path.join(appRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs')
    const startScript = path.join(appRoot, 'start.js')
    agentProc = spawn(process.execPath, [tsxCli, startScript, EXAMPLE], {
      cwd: appRoot,
      env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: 'pipe',
      windowsHide: true,
    })
  } else {
    const tsxCli = path.join(
      REPO_ROOT,
      'node_modules',
      'tsx',
      'dist',
      'cli.mjs',
    )
    const startScript = path.join(REPO_ROOT, 'start.js')
    agentProc = spawn(process.execPath, [tsxCli, startScript, EXAMPLE], {
      cwd: REPO_ROOT,
      env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: 'pipe',
      windowsHide: true,
    })
  }

  pipeAgentLogs(agentProc)

  agentProc.on('exit', (code, signal) => {
    if (!app.isQuitting && code !== 0 && code !== null) {
      dialog.showErrorBox(
        'Agent stopped',
        `The coding agent server exited unexpectedly (code ${code ?? signal}).`,
      )
      app.quit()
    }
  })
}

function stopAgent() {
  if (!agentProc || agentProc.killed) return
  agentProc.kill('SIGTERM')
  agentProc = null
}

function waitForHealth(timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs
  const url = `${getAgentUrl()}/health`

  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = http.get(url, res => {
        res.resume()
        if (res.statusCode === 200) {
          resolve()
          return
        }
        schedule()
      })
      req.on('error', schedule)
      req.setTimeout(2_000, () => {
        req.destroy()
        schedule()
      })
    }

    const schedule = () => {
      if (Date.now() >= deadline) {
        reject(new Error(`Agent did not become healthy at ${url}`))
        return
      }
      setTimeout(attempt, 300)
    }

    attempt()
  })
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: 'Baize',
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  mainWindow.loadURL(getAgentUrl())

  if (!app.isPackaged && process.env.DESKTOP_DEVTOOLS === '1') {
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

async function ensureWebBuild() {
  const indexHtml = path.join(getWebDistDir(), 'index.html')
  if (fs.existsSync(indexHtml)) return

  const { response } = await dialog.showMessageBox({
    type: 'warning',
    buttons: ['Quit', 'Continue anyway'],
    defaultId: 0,
    title: 'Web build missing',
    message: 'client/web/dist was not found.',
    detail:
      'Run `npm run build:web` first so the agent can serve the UI.\n\n' +
      'You can still use the API at /health, but the window will be blank.',
  })

  if (response === 0) {
    app.quit()
  }
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(async () => {
    agentPort = Number.parseInt(process.env.PORT || String(DEFAULT_PORT), 10)

    await ensureWebBuild()
    startAgent()

    try {
      await waitForHealth()
    } catch (err) {
      stopAgent()
      dialog.showErrorBox(
        'Failed to start',
        `${err.message}\n\nIf port ${agentPort} is in use, run \`npm run server:stop\` or set PORT.`,
      )
      app.quit()
      return
    }

    createWindow()
  })

  app.on('before-quit', () => {
    app.isQuitting = true
    stopAgent()
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && agentProc) {
      createWindow()
    }
  })
}

ipcMain.handle('pick-workspace', async () => {
  const win = BrowserWindow.getFocusedWindow() ?? mainWindow
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    properties: ['openDirectory', 'createDirectory'],
  })
  return canceled ? null : (filePaths[0] ?? null)
})

ipcMain.handle('get-agent-url', () => getAgentUrl())
