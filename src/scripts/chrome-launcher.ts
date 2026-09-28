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
import { chromePath } from '../browser/chrome-path.js'
import { BRIDGE_EXTENSION_ID } from '../browser/relay/extension-id.js'

export const EXTENSION_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../chrome-extension',
)

export { chromePath }

/** Just enough CDP to install the extension and poke its service worker. */
export class MinimalCdp {
  private ws: WebSocket
  private nextId = 1
  private pending = new Map<
    number,
    {
      resolve: (v: unknown) => void
      reject: (e: Error) => void
      timer: NodeJS.Timeout
    }
  >()

  private constructor(ws: WebSocket) {
    this.ws = ws
    const rejectPending = (reason: Error) => {
      for (const entry of this.pending.values()) {
        clearTimeout(entry.timer)
        entry.reject(reason)
      }
      this.pending.clear()
    }
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
      clearTimeout(entry.timer)
      if (msg.error) entry.reject(new Error(JSON.stringify(msg.error)))
      else entry.resolve(msg.result)
    })
    ws.on('close', () =>
      rejectPending(new Error('Chrome DevTools connection closed')),
    )
    ws.on('error', err => rejectPending(err))
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
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method} timed out`))
      }, 20_000)
      timer.unref?.()
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      })
      try {
        this.ws.send(JSON.stringify({ id, method, params, sessionId }))
      } catch (err) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
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

async function waitForAllocatedDebugPort(
  userDataDir: string,
  timeoutMs = 20_000,
): Promise<number> {
  const activePortFile = path.join(userDataDir, 'DevToolsActivePort')
  const deadline = Date.now() + timeoutMs
  let lastError = 'file was not created'
  while (Date.now() < deadline) {
    try {
      const [line] = fs.readFileSync(activePortFile, 'utf8').split(/\r?\n/)
      const port = Number(line)
      if (Number.isInteger(port) && port > 0 && port <= 65_535) return port
      lastError = `invalid port ${JSON.stringify(line)}`
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
    }
    await new Promise(r => setTimeout(r, 100))
  }
  throw new Error(
    `Chrome did not publish an allocated debug port: ${lastError}`,
  )
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
  /** Omit to let Chrome allocate a free remote-debugging port. */
  debugPort?: number
  headless?: boolean
  /**
   * Drives the extension's own connect page, the same way a user would. Kept
   * on the real path rather than writing storage directly so the dev and e2e
   * runs exercise what ships.
   */
  pair?: { connectUrl: string }
}

function waitForChildExit(
  proc: ChildProcess,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise(resolve => {
    if (proc.exitCode !== null) {
      resolve(true)
      return
    }
    const finish = (exited: boolean) => {
      clearTimeout(timer)
      proc.off('exit', onExit)
      resolve(exited)
    }
    const onExit = () => finish(true)
    const timer = setTimeout(() => finish(false), timeoutMs)
    proc.once('exit', onExit)
  })
}

async function settleWithin(
  promise: Promise<unknown>,
  timeoutMs: number,
): Promise<void> {
  await new Promise(resolve => {
    const timer = setTimeout(resolve, timeoutMs)
    void promise.finally(() => {
      clearTimeout(timer)
      resolve(undefined)
    })
  })
}

async function stopLaunchedChrome(
  proc: ChildProcess,
  cdp?: MinimalCdp,
): Promise<void> {
  if (cdp) {
    await settleWithin(
      cdp.send('Browser.close').catch(() => {}),
      2_000,
    )
    cdp.close()
  }
  if (proc.exitCode !== null) return
  proc.kill('SIGTERM')
  if (!(await waitForChildExit(proc, 5_000))) {
    proc.kill('SIGKILL')
    await waitForChildExit(proc, 2_000)
  }
}

/** Open the extension's connect page and press its Allow button. */
async function approveConnectPage(
  cdp: MinimalCdp,
  connectUrl: string,
): Promise<void> {
  const { targetId } = await cdp.send<{ targetId: string }>(
    'Target.createTarget',
    { url: connectUrl },
  )
  const { sessionId } = await cdp.send<{ sessionId: string }>(
    'Target.attachToTarget',
    { targetId, flatten: true },
  )
  await waitFor('connect page approval', async () => {
    try {
      const res = await cdp.send<{ result?: { value?: boolean } }>(
        'Runtime.evaluate',
        {
          expression:
            "(() => { const b = document.getElementById('allow'); if (!b) return false; b.click(); return true })()",
          returnByValue: true,
        },
        sessionId,
      )
      return res.result?.value === true
    } catch {
      // The document is not there yet.
      return false
    }
  })
}

export async function launchChromeWithExtension(
  opts: LaunchOptions,
): Promise<LaunchedChrome> {
  const requestedDebugPort = opts.debugPort ?? 0
  const proc = spawn(
    chromePath(),
    [
      `--user-data-dir=${opts.userDataDir}`,
      `--remote-debugging-port=${requestedDebugPort}`,
      '--enable-unsafe-extension-debugging',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-search-engine-choice-screen',
      ...(opts.headless ? ['--headless=new'] : []),
      'about:blank',
    ],
    { stdio: 'ignore' },
  )

  let cdp: MinimalCdp | undefined
  try {
    const debugPort =
      requestedDebugPort || (await waitForAllocatedDebugPort(opts.userDataDir))
    cdp = await MinimalCdp.connect(await devToolsUrl(debugPort))

    const { id: extensionId } = await cdp.send<{ id: string }>(
      'Extensions.loadUnpacked',
      { path: EXTENSION_DIR },
    )
    if (!extensionId) throw new Error('Extensions.loadUnpacked returned no id')
    // The whole connect-page scheme depends on the host being able to name the
    // extension before it has ever spoken to it. If the manifest `key` is lost,
    // fail here rather than in a confusing connection timeout.
    if (extensionId !== BRIDGE_EXTENSION_ID) {
      throw new Error(
        `Extension id drifted: loaded "${extensionId}", expected "${BRIDGE_EXTENSION_ID}". ` +
          'Check the "key" field in chrome-extension/manifest.json.',
      )
    }

    // The service worker starts lazily.
    let workerSession = ''
    await waitFor('extension service worker', async () => {
      const { targetInfos } = await cdp!.send<{
        targetInfos: Array<{ targetId: string; type: string; url: string }>
      }>('Target.getTargets')
      const sw = targetInfos.find(
        t => t.type === 'service_worker' && t.url.includes(extensionId),
      )
      if (!sw) return false
      const { sessionId } = await cdp!.send<{ sessionId: string }>(
        'Target.attachToTarget',
        { targetId: sw.targetId, flatten: true },
      )
      workerSession = sessionId
      return true
    })

    if (opts.pair) {
      await approveConnectPage(cdp, opts.pair.connectUrl)
    }

    return {
      process: proc,
      cdp,
      extensionId,
      workerSession,
      close: () => stopLaunchedChrome(proc, cdp),
    }
  } catch (err) {
    await stopLaunchedChrome(proc, cdp).catch(() => {})
    throw err
  }
}
