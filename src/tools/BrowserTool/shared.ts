/**
 * Shared plumbing for the `browser_*` tools: one output shape, one text
 * projection, one error funnel.
 *
 * Projection mode A — the model gets the page observation (snapshot, console,
 * screenshot); the UI card gets the same fields minus the screenshot base64,
 * which zod strips because `BrowserOutputSchema` doesn't declare it. That keeps
 * megabytes of image data out of the wire and the session jsonl while the model
 * still receives a real image block.
 */

import * as fs from 'fs/promises'
import * as path from 'path'
import { z } from 'zod'
import { sinceReport } from '../../browser/page-inspect.js'
import {
  DEFAULT_MAX_CHARS,
  POST_ACTION_MAX_NODES,
  SCREENSHOT_TOKEN_BUDGET,
} from '../../browser/limits.js'
import * as pw from '../../browser/playwright/index.js'
import {
  BrowserError,
  type BrowserBackend,
  type NetworkEntry,
} from '../../browser/types.js'
import { getSessionDataDir } from '../../core/session-paths.js'
import type {
  ImageMediaType,
  ToolResultBlockParam,
  ToolResultContentBlockParam,
} from '../../core/types.js'
import { toolResultImageBlockFromBuffer } from '../../utils/image/resize-buffer.js'

export interface NetworkRow {
  method: string
  url: string
  status: number
  ok: boolean
  pending: boolean
  failed: boolean
  error: string
  durationMs: number
}

export function toNetworkRow(e: NetworkEntry): NetworkRow {
  return {
    method: e.method,
    url: e.url,
    status: e.status,
    ok: e.ok,
    pending: e.pending,
    failed: e.failed,
    error: e.error,
    durationMs: e.durationMs,
  }
}

export interface BrowserToolOutput {
  action: string
  message: string
  url: string
  title: string
  snapshot?: string
  snapshotTruncated?: boolean
  consoleErrors?: Array<{ level: string; text: string }>
  network?: NetworkRow[]
  /** Set when `network` is a filtered view, so the card can say so. */
  networkTotal?: number
  tabs?: Array<{ targetId: string; url: string; title: string; current: boolean }>
  value?: unknown
  screenshotPath?: string
  /** Server-relative URL the UI can load the on-disk screenshot from. */
  screenshotUrl?: string
  /**
   * Intentionally absent from BrowserOutputSchema: the mapper reads it to build
   * the model's image block, then zod drops it before the UI ever sees it.
   */
  screenshotBase64?: string
  screenshotMediaType?: ImageMediaType
}

export const BrowserOutputSchema = z.object({
  action: z.string(),
  message: z.string(),
  url: z.string(),
  title: z.string(),
  snapshot: z.string().optional(),
  snapshotTruncated: z.boolean().optional(),
  consoleErrors: z
    .array(z.object({ level: z.string(), text: z.string() }))
    .optional(),
  network: z
    .array(
      z.object({
        method: z.string(),
        url: z.string(),
        status: z.number(),
        ok: z.boolean(),
        pending: z.boolean(),
        failed: z.boolean(),
        error: z.string(),
        durationMs: z.number(),
      }),
    )
    .optional(),
  networkTotal: z.number().optional(),
  tabs: z
    .array(
      z.object({
        targetId: z.string(),
        url: z.string(),
        title: z.string(),
        current: z.boolean(),
      }),
    )
    .optional(),
  value: z.unknown().optional(),
  screenshotPath: z.string().optional(),
  screenshotUrl: z.string().optional(),
})

/** Per-tab watermark so each action reports only the console output it caused. */
const consoleWatermark = new Map<string, number>()

export function resetConsoleWatermark(targetId: string): void {
  consoleWatermark.delete(targetId)
}

/**
 * Gather everything the model needs to decide its next move: where it ended up,
 * what the page looks like now, and whether the action broke anything.
 */
export async function observe(
  backend: BrowserBackend,
  targetId: string,
  opts: {
    action: string
    message: string
    withSnapshot?: boolean
    maxNodes?: number
    maxChars?: number
    selector?: string
    compact?: boolean
  },
): Promise<BrowserToolOutput> {
  const out: BrowserToolOutput = {
    action: opts.action,
    message: opts.message,
    url: '',
    title: '',
  }

  if (opts.withSnapshot !== false) {
    const snap = await pw.snapshot(backend, targetId, {
      maxNodes: opts.maxNodes ?? POST_ACTION_MAX_NODES,
      maxChars: opts.maxChars ?? DEFAULT_MAX_CHARS,
      selector: opts.selector,
      compact: opts.compact,
    })
    out.url = snap.url
    out.title = snap.title
    out.snapshot = snap.text
    out.snapshotTruncated = snap.truncated
  } else {
    const tabs = await backend.listTabs()
    const tab = tabs.find(t => t.targetId === targetId)
    out.url = tab?.url ?? ''
    out.title = tab?.title ?? ''
  }

  const since = consoleWatermark.get(targetId)
  const report = await sinceReport(backend, targetId, since)
  consoleWatermark.set(targetId, report.now)
  if (report.logs.length) {
    out.consoleErrors = report.logs.map(e => ({ level: e.level, text: e.text }))
  }
  // Only failures land here. A successful request is noise for most actions;
  // browser_network is there when the model wants the full picture.
  if (report.network.length) {
    out.network = report.network.map(toNetworkRow)
  }

  return out
}

export async function attachScreenshot(
  out: BrowserToolOutput,
  shot: { buffer: Buffer; format: 'png' | 'jpeg' },
  sessionId: string | undefined,
  toolCallId: string,
): Promise<void> {
  const mediaType: ImageMediaType =
    shot.format === 'jpeg' ? 'image/jpeg' : 'image/png'

  // Full-fidelity copy on disk for the UI card; the model gets a downsampled
  // one so a 3MB retina PNG can't eat the context window.
  if (sessionId) {
    const dir = path.join(getSessionDataDir(sessionId), 'browser')
    await fs.mkdir(dir, { recursive: true })
    const name = `${toolCallId.replace(/[^a-zA-Z0-9_-]/g, '_')}.${shot.format}`
    await fs.writeFile(path.join(dir, name), shot.buffer)
    out.screenshotPath = path.join(dir, name)
    out.screenshotUrl = `/sessions/${encodeURIComponent(sessionId)}/browser/${name}`
  }

  const block = await toolResultImageBlockFromBuffer(shot.buffer, mediaType, {
    maxTokens: SCREENSHOT_TOKEN_BUDGET,
  })
  out.screenshotBase64 = block.source.data
  out.screenshotMediaType = block.source.media_type
}

/**
 * The distinction worth spending characters on: a request that came back 500
 * reached the server, one that "never sent" did not. They have different fixes.
 */
function renderNetworkRow(r: NetworkRow): string {
  const status = r.pending ? '...' : r.failed ? 'ERR' : String(r.status)
  const head = `${status.padStart(3)}  ${r.method.padEnd(6)}${r.url}`
  if (r.pending) return `${head}  (still pending)`
  if (r.failed) return `${head}  (${r.durationMs}ms) — never sent: ${r.error}`
  return `${head}  (${r.durationMs}ms)`
}

function renderText(out: BrowserToolOutput): string {
  const lines: string[] = [out.message]

  if (out.url) {
    lines.push(`Page: ${out.url}${out.title ? ` — ${out.title}` : ''}`)
  }

  if (out.tabs?.length) {
    lines.push('')
    lines.push('Open tabs:')
    for (const t of out.tabs) {
      lines.push(
        `  ${t.current ? '*' : ' '} ${t.targetId}  ${t.title || '(untitled)'}  ${t.url}`,
      )
    }
  }

  if (out.value !== undefined) {
    lines.push('')
    lines.push(`Result: ${JSON.stringify(out.value, null, 2)}`)
  }

  if (out.consoleErrors?.length) {
    lines.push('')
    lines.push(`Console errors during this action (${out.consoleErrors.length}):`)
    for (const e of out.consoleErrors) lines.push(`  ${e.text}`)
  }

  if (out.network?.length) {
    lines.push('')
    const shown = out.network.length
    lines.push(
      out.networkTotal !== undefined
        ? `Network requests (${shown} of ${out.networkTotal}):`
        : `Failed requests during this action (${shown}):`,
    )
    for (const r of out.network) lines.push(`  ${renderNetworkRow(r)}`)
  }

  if (out.screenshotPath) {
    lines.push('')
    lines.push(`Screenshot saved to ${out.screenshotPath}`)
  }

  if (out.snapshot !== undefined) {
    lines.push('')
    lines.push('Page snapshot:')
    lines.push(out.snapshot || '(no visible content)')
    if (out.snapshotTruncated) {
      lines.push(
        '… snapshot truncated; open dialogs and end-of-tree widgets are kept. Pass selector (e.g. [role=dialog]) to snapshot a subtree, or compact: true to drop wrappers.',
      )
    }
  }

  return lines.join('\n')
}

export function mapBrowserOutput(
  output: unknown,
  toolUseID: string,
): ToolResultBlockParam {
  const out = output as BrowserToolOutput
  const text = renderText(out)

  if (out.screenshotBase64 && out.screenshotMediaType) {
    const content: ToolResultContentBlockParam[] = [
      { type: 'text', text },
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: out.screenshotMediaType,
          data: out.screenshotBase64,
        },
      },
    ]
    return { tool_use_id: toolUseID, type: 'tool_result', content }
  }

  return { tool_use_id: toolUseID, type: 'tool_result', content: text }
}

/**
 * Browser failures are almost always recoverable by re-observing the page, so
 * they come back as tool text rather than thrown errors — but the message has
 * to say what to do next, otherwise the model retries the same click forever.
 */
export function browserErrorText(
  err: unknown,
  action: string,
  freshSnapshot?: string,
): string {
  const head =
    err instanceof BrowserError
      ? `Error: ${err.message}`
      : `Error: ${action} failed: ${err instanceof Error ? err.message : String(err)}`
  if (!freshSnapshot) return head
  return `${head}\n\nCurrent page snapshot (use these refs, the old ones are stale):\n${
    freshSnapshot || '(no visible content)'
  }`
}
