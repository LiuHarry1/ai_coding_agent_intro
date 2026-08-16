/**
 * Launch a Chrome with the bridge extension installed and paired.
 *
 * Chrome 137 removed `--load-extension` from branded builds, so the extension
 * is installed at runtime through the `Extensions.loadUnpacked` CDP command —
 * that is what `--enable-unsafe-extension-debugging` unlocks. Shared by the
 * end-to-end test and the `browser:dev-chrome` helper.
 *
 * Only ever used against a throwaway or dedicated profile. Pairing the
 * extension in the user's everyday Chrome is a manual, one-time step by design.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'

export const EXTENSION_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../chrome-extension',
)

export function chromePath(): string {
  const fromEnv = process.env.CHROME_PATH
  if (fromEnv) return fromEnv
  const candidates =
    process.platform === 'darwin'
      ? [
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          '/Applications/Chromium.app/Contents/MacOS/Chromium',
        ]
      : [
          '/usr/bin/google-chrome',
          '/usr/bin/chromium',
          '/usr/bin/chromium-browser',
        ]
  const found = candidates.find(p => fs.existsSync(p))
  if (!found) {
    throw new Error(
      `Could not find Chrome. Set CHROME_PATH. Looked in:\n  ${candidates.join('\n  ')}`,
    )
  }
  return found
}

/** Just enough CDP to install the extension and poke its service worker. */
export class MinimalCdp {
  private ws: WebSocket
  private nextId = 1
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >()

  private constructor(ws: WebSocket) {
    this.ws = ws
    ws.on('message', raw => {
      const msg = JSON.parse(String(raw)) as {
        id?: number
        error?: unknown
        result?: unknown
      }
      if (typeof msg.id !== 'number') return
      const entry = this.pending.get(msg.id)
      if (!entry) return
      this.pending.delete(msg.id)
      if (msg.error) entry.reject(new Error(JSON.stringify(msg.error)))
      else entry.resolve(msg.result)
    })
  }

  static async connect(url: string): Promise<MinimalCdp> {
    const ws = new WebSocket(url, { maxPayload: 256 * 1024 * 1024 })
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve())
      ws.once('error', reject)
    })
    return new MinimalCdp(ws)
  }

  send<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<T> {
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
      })
      this.ws.send(JSON.stringify({ id, method, params, sessionId }))
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method} timed out`))
      }, 20_000)
    })
  }

  close(): void {
    this.ws.close()
  }
}

export async function waitFor(
  label: string,
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise(r => setTimeout(r, 150))
  }
  throw new Error(`Timed out waiting for ${label}`)
}

async function devToolsUrl(port: number, timeoutMs = 20_000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  let lastError = 'never responded'
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`)
      const body = (await res.json()) as { webSocketDebuggerUrl?: string }
      if (body.webSocketDebuggerUrl) return body.webSocketDebuggerUrl
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
    }
    await new Promise(r => setTimeout(r, 200))
  }
  throw new Error(`Chrome DevTools endpoint never came up: ${lastError}`)
}

export interface LaunchedChrome {
  process: ChildProcess
  cdp: MinimalCdp
  extensionId: string
  /** CDP session attached to the extension's service worker. */
  workerSession: string
  close: () => Promise<void>
}

export interface LaunchOptions {
  userDataDir: string
  debugPort: number
  headless?: boolean
  /** Writes these into extension storage, which is what triggers pairing. */
  pair?: { token: string; port: number }
}

export async function launchChromeWithExtension(
  opts: LaunchOptions,
): Promise<LaunchedChrome> {
  const proc = spawn(
    chromePath(),
    [
      `--user-data-dir=${opts.userDataDir}`,
      `--remote-debugging-port=${opts.debugPort}`,
      '--enable-unsafe-extension-debugging',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-search-engine-choice-screen',
      ...(opts.headless ? ['--headless=new'] : []),
      'about:blank',
    ],
    { stdio: 'ignore' },
  )

  const cdp = await MinimalCdp.connect(await devToolsUrl(opts.debugPort))

  const { id: extensionId } = await cdp.send<{ id: string }>(
    'Extensions.loadUnpacked',
    { path: EXTENSION_DIR },
  )
  if (!extensionId) throw new Error('Extensions.loadUnpacked returned no id')

  // The service worker starts lazily.
  let workerSession = ''
  await waitFor('extension service worker', async () => {
    const { targetInfos } = await cdp.send<{
      targetInfos: Array<{ targetId: string; type: string; url: string }>
    }>('Target.getTargets')
    const sw = targetInfos.find(
      t => t.type === 'service_worker' && t.url.includes(extensionId),
    )
    if (!sw) return false
    const { sessionId } = await cdp.send<{ sessionId: string }>(
      'Target.attachToTarget',
      { targetId: sw.targetId, flatten: true },
    )
    workerSession = sessionId
    return true
  })

  if (opts.pair) {
    await cdp.send(
      'Runtime.evaluate',
      {
        expression: `chrome.storage.local.set(${JSON.stringify({
          token: opts.pair.token,
          port: opts.pair.port,
        })})`,
        awaitPromise: true,
      },
      workerSession,
    )
  }

  return {
    process: proc,
    cdp,
    extensionId,
    workerSession,
    close: async () => {
      cdp.close()
      if (proc.exitCode !== null) return
      // Chrome keeps writing its profile briefly after SIGTERM; callers that
      // delete the directory need it to be really gone first.
      const exited = new Promise<void>(resolve =>
        proc.once('exit', () => resolve()),
      )
      proc.kill()
      await Promise.race([exited, new Promise(r => setTimeout(r, 5000))])
    },
  }
}
