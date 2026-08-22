/**
 * The `browser_*` tool family.
 *
 * Every tool goes through `defineBrowserTool`, which resolves the active tab,
 * bounds the call, funnels failures into recoverable tool text, and returns the
 * same observation shape. Nothing here knows which backend it is driving — it
 * only ever sees `BrowserBackend` — which is what lets the same tools point at
 * the user's own Chrome once the extension relay lands.
 */

import { randomUUID } from 'crypto'
import * as path from 'path'
import { tool } from 'ai'
import { z } from 'zod'
import * as inspect from '../../browser/page-inspect.js'
import * as pw from '../../browser/playwright/index.js'
import {
  CALL_TIMEOUT_MS,
  DEFAULT_MAX_NODES,
  ERROR_SNAPSHOT_TIMEOUT_MS,
  POST_ACTION_MAX_NODES,
  POST_ACTION_SNAPSHOT_MS,
} from '../../browser/limits.js'
import { SNAPSHOT_STALL_NEXT } from '../../browser/heavy-media.js'
import {
  getBrowser,
  getCurrentTabId,
  openTab,
  recordHandoff,
  resolveTab,
  setCurrentTab,
} from '../../browser/manager.js'
import { BrowserError, type BrowserBackend } from '../../browser/types.js'
import { getUserHasControl, setUserHasControl } from '../../browser/session-flags.js'
import {
  trackActiveBrowserTool,
  untrackActiveBrowserTool,
} from '../../browser/active-browser-tools.js'
import {
  BROWSER_CLICK_TOOL_NAME,
  BROWSER_CONSOLE_TOOL_NAME,
  BROWSER_FILE_UPLOAD_TOOL_NAME,
  BROWSER_FILL_FORM_TOOL_NAME,
  BROWSER_GET_BOUNDING_BOX_TOOL_NAME,
  BROWSER_HANDLE_DIALOG_TOOL_NAME,
  BROWSER_HIGHLIGHT_TOOL_NAME,
  BROWSER_HOVER_TOOL_NAME,
  BROWSER_LOCK_TOOL_NAME,
  BROWSER_DRAG_TOOL_NAME,
  BROWSER_NAVIGATE_TOOL_NAME,
  BROWSER_NETWORK_TOOL_NAME,
  BROWSER_PRESS_KEY_TOOL_NAME,
  BROWSER_RESIZE_TOOL_NAME,
  BROWSER_SCREENSHOT_TOOL_NAME,
  BROWSER_SCROLL_TOOL_NAME,
  BROWSER_SELECT_OPTION_TOOL_NAME,
  BROWSER_SNAPSHOT_TOOL_NAME,
  BROWSER_TABS_TOOL_NAME,
  BROWSER_TYPE_TOOL_NAME,
  BROWSER_WAIT_FOR_TOOL_NAME,
  BROWSER_WAIT_FOR_DOWNLOAD_TOOL_NAME,
} from '../../constants/tool_names.js'
import type {
  DualChannelToolResult,
  ToolContext,
  ToolDefinition,
} from '../../core/types.js'
import * as prompt from './prompt.js'
import {
  attachScreenshot,
  browserErrorText,
  BrowserOutputSchema,
  mapBrowserOutput,
  observe,
  resetConsoleWatermark,
  toNetworkRow,
  type BrowserToolOutput,
} from './shared.js'

interface RunContext {
  backend: BrowserBackend
  targetId: string
  cwd: string
  sessionId?: string
  toolCallId: string
}

async function observeAfterAction(
  backend: BrowserBackend,
  targetId: string,
  opts: Parameters<typeof observe>[2] & { screenshotAfterwards?: boolean },
  ctx?: Pick<RunContext, 'sessionId' | 'toolCallId'>,
): Promise<BrowserToolOutput> {
  const skipIfDegraded = opts.skipIfDegraded !== false
  const snapshotMs =
    opts.withSnapshot === false ? 5_000 : POST_ACTION_SNAPSHOT_MS
  try {
    const out = await withTimeout(
      observe(backend, targetId, { ...opts, skipIfDegraded }),
      'snapshot',
      snapshotMs,
    )
    if (opts.screenshotAfterwards && ctx) {
      try {
        const shot = await pw.screenshot(backend, targetId, { format: 'jpeg' })
        await attachScreenshot(out, shot, ctx.sessionId, ctx.toolCallId)
      } catch {
        out.message = `${out.message} (screenshot afterwards failed)`
      }
    }
    return out
  } catch {
    try {
      const snap = await withTimeout(
        pw.snapshot(backend, targetId, { dialogOnly: true, maxNodes: 60 }),
        'dialog-snapshot',
        5_000,
      )
      if (snap.nodes > 0 || (snap.text && !/^No blocking in-page dialog/.test(snap.text))) {
        return {
          action: opts.action,
          message: `${opts.message} (full snapshot timed out; showing the open dialog — click it, do not wait or navigate)`,
          url: snap.url,
          title: snap.title,
          snapshot: snap.text,
          snapshotTruncated: snap.truncated,
        }
      }
    } catch {
      /* dialog-only look failed too */
    }
    return {
      action: opts.action,
      message: `${opts.message} (snapshot timed out. ${SNAPSHOT_STALL_NEXT})`,
      url: '',
      title: '',
      snapshot: SNAPSHOT_STALL_NEXT,
    }
  }
}

function withTimeout<T>(
  promise: Promise<T>,
  action: string,
  ms: number = CALL_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new BrowserError(`${action} interrupted by user`))
      return
    }
    const timer = setTimeout(() => {
      reject(
        new BrowserError(
          `${action} timed out after ${ms / 1000}s. The page may be stuck loading; check the dev server or try browser_console.`,
        ),
      )
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new BrowserError(`${action} interrupted by user`))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    promise.then(
      value => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        resolve(value)
      },
      err => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        reject(err)
      },
    )
  })
}

/**
 * Best-effort current snapshot for an error path. Never throws: if the page is
 * so broken we can't even snapshot it, the underlying error is the story and a
 * missing tree shouldn't bury it.
 */
async function freshSnapshotText(
  backend: BrowserBackend,
  targetId: string,
): Promise<string | undefined> {
  try {
    const snap = await withTimeout(
      pw.snapshot(backend, targetId, {
        maxNodes: POST_ACTION_MAX_NODES,
        compact: true,
      }),
      'snapshot',
      ERROR_SNAPSHOT_TIMEOUT_MS,
    )
    return snap.text
  } catch {
    return undefined
  }
}

const USER_CONTROL_ALLOWED = new Set([
  BROWSER_LOCK_TOOL_NAME,
  BROWSER_SNAPSHOT_TOOL_NAME,
  BROWSER_SCREENSHOT_TOOL_NAME,
  BROWSER_CONSOLE_TOOL_NAME,
  BROWSER_NETWORK_TOOL_NAME,
  BROWSER_TABS_TOOL_NAME,
  BROWSER_WAIT_FOR_TOOL_NAME,
  BROWSER_HIGHLIGHT_TOOL_NAME,
  BROWSER_GET_BOUNDING_BOX_TOOL_NAME,
])

const screenshotAfterwardsSchema = z
  .boolean()
  .optional()
  .describe('When true, capture a screenshot after the action completes')

function assertAgentMayAct(
  toolName: string,
  args: unknown,
  sessionId?: string,
): void {
  if (!getUserHasControl(sessionId)) return
  if (toolName === BROWSER_TABS_TOOL_NAME) {
    const action = (args as { action?: string } | undefined)?.action
    if (!action || action === 'list') return
    throw new BrowserError(
      'The user has control of the browser. Only browser_tabs action "list" is allowed until you call browser_lock with action "lock".',
    )
  }
  if (USER_CONTROL_ALLOWED.has(toolName)) return
  throw new BrowserError(
    'The user has control of the browser. Call browser_lock with action "lock" after they finish, then continue. Do not click or type while they are using it.',
  )
}

function defineBrowserTool<S extends z.ZodTypeAny>(cfg: {
  name: string
  summary: string
  description: string
  inputSchema: S
  /** False for tab list/select, which must work before a current tab exists. */
  requireTab?: boolean
  run: (args: z.infer<S>, ctx: RunContext) => Promise<BrowserToolOutput>
}): ToolDefinition {
  return {
    name: cfg.name,
    description: cfg.summary,
    shouldDefer: true,
    outputSchema: BrowserOutputSchema,
    mapToolResultToToolResultBlockParam: mapBrowserOutput,
    create(cwd: string, context: ToolContext) {
      return tool({
        description: cfg.description,
        inputSchema: cfg.inputSchema,
        execute: async (
          args: z.infer<S>,
          options?: { toolCallId?: string; abortSignal?: AbortSignal },
        ): Promise<DualChannelToolResult<BrowserToolOutput> | string> => {
          const toolCallId = options?.toolCallId ?? randomUUID()
          const abortSignal = options?.abortSignal
          const sessionId = context.sessionId
          trackActiveBrowserTool(sessionId, toolCallId, cfg.name, args)
          try {
            if (abortSignal?.aborted) {
              return browserErrorText(
                new BrowserError('interrupted by user'),
                cfg.name,
              )
            }
            let resolved: { backend: BrowserBackend; targetId: string } | undefined
            try {
              const cwdNow = context.cwd ?? cwd
              if (cfg.requireTab === false) {
                const backend = await withTimeout(
                  getBrowser(cwdNow, sessionId),
                  cfg.name,
                  CALL_TIMEOUT_MS,
                  abortSignal,
                )
                resolved = {
                  backend,
                  targetId: getCurrentTabId(sessionId) ?? '',
                }
              } else {
                resolved = await withTimeout(
                  resolveTab(cwdNow, undefined, sessionId),
                  cfg.name,
                  CALL_TIMEOUT_MS,
                  abortSignal,
                )
              }
              assertAgentMayAct(cfg.name, args, sessionId)
              const data = await withTimeout(
                cfg.run(args, {
                  backend: resolved.backend,
                  targetId: resolved.targetId,
                  cwd: cwdNow,
                  sessionId,
                  toolCallId,
                }),
                cfg.name,
                CALL_TIMEOUT_MS,
                abortSignal,
              )
              if (data.url || data.title) {
                recordHandoff(sessionId, {
                  targetId:
                    (getCurrentTabId(sessionId) ?? resolved.targetId) ||
                    undefined,
                  url: data.url,
                  title: data.title,
                })
              }
              return { data }
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err)
              const skipTree = /timed out|Snapshot skipped|PDF\/media/i.test(msg)
              const fresh =
                resolved && !skipTree
                  ? await freshSnapshotText(resolved.backend, resolved.targetId)
                  : undefined
              return browserErrorText(err, cfg.name, fresh)
            }
          } finally {
            untrackActiveBrowserTool(sessionId, toolCallId)
          }
        },
      })
    },
  }
}

const refSchema = z
  .string()
  .describe('Element ref from the latest snapshot, e.g. "e12"')

export const navigateTool = defineBrowserTool({
  name: BROWSER_NAVIGATE_TOOL_NAME,
  summary: 'Open a URL, or go back / forward / reload',
  description: prompt.NAVIGATE_DESCRIPTION,
  requireTab: false,
  inputSchema: z.object({
    url: z
      .string()
      .optional()
      .describe('Absolute http(s) URL, e.g. http://localhost:3000'),
    action: z
      .enum(['back', 'forward', 'reload'])
      .optional()
      .describe('History action when url is omitted'),
  }),
  async run({ url, action }, ctx) {
    let targetId = ctx.targetId
    if (!targetId) {
      const tab = await openTab(ctx.cwd, undefined, ctx.sessionId)
      targetId = tab.targetId
    }
    resetConsoleWatermark(targetId)
    await pw.navigate(ctx.backend, targetId, { url, action })
    const message = action
      ? action === 'reload'
        ? 'Reloaded the page'
        : `Navigated ${action}`
      : `Navigated to ${url}`
    return observe(ctx.backend, targetId, {
      action: 'navigate',
      message,
      maxNodes: DEFAULT_MAX_NODES,
    })
  },
})

export const snapshotTool = defineBrowserTool({
  name: BROWSER_SNAPSHOT_TOOL_NAME,
  summary: 'Capture an accessibility snapshot of the current page',
  description: prompt.SNAPSHOT_DESCRIPTION,
  inputSchema: z.object({
    maxNodes: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        `Cap on ref-bearing nodes; open dialogs and end-of-tree widgets are kept first (default ${DEFAULT_MAX_NODES})`,
      ),
    selector: z
      .string()
      .optional()
      .describe(
        'CSS selector; snapshot only this subtree (e.g. the chat panel)',
      ),
    compact: z
      .boolean()
      .optional()
      .describe(
        'Clip tree depth for a cheaper look at the page; nested content is dropped',
      ),
    interactive: z
      .boolean()
      .optional()
      .describe(
        'Keep only ref-bearing controls and their ancestors; cheaper for driving a form',
      ),
    includeDiff: z
      .boolean()
      .optional()
      .describe(
        'Return only added/removed lines since the last snapshot',
      ),
    urls: z
      .boolean()
      .optional()
      .describe(
        'Append discovered link hrefs',
      ),
  }),
  async run({ maxNodes, selector, compact, interactive, includeDiff, urls }, ctx) {
    return observe(ctx.backend, ctx.targetId, {
      action: 'snapshot',
      message: includeDiff ? 'Page snapshot (diff)' : 'Page snapshot',
      maxNodes: maxNodes ?? DEFAULT_MAX_NODES,
      selector,
      compact,
      interactive,
      includeDiff,
      urls,
      skipIfDegraded: false,
    })
  },
})

export const clickTool = defineBrowserTool({
  name: BROWSER_CLICK_TOOL_NAME,
  summary: 'Click an element by ref',
  description: prompt.CLICK_DESCRIPTION,
  inputSchema: z.object({
    ref: refSchema
      .optional()
      .describe('Exact target element reference from the page snapshot'),
    element: z
      .string()
      .optional()
      .describe(
        'Human-readable element description used to obtain permission to interact with the element; must match the resolved ref',
      ),
    doubleClick: z.boolean().optional().describe('Send a double click'),
    button: z
      .enum(['left', 'right', 'middle'])
      .optional()
      .describe('Mouse button (default left)'),
    modifiers: z
      .array(z.enum(['Alt', 'Control', 'Meta', 'Shift']))
      .optional()
      .describe('Modifier keys held during the click'),
    x: z
      .number()
      .optional()
      .describe('Viewport X for a coordinate click (canvas / no ref)'),
    y: z
      .number()
      .optional()
      .describe('Viewport Y for a coordinate click'),
    offsetX: z
      .number()
      .optional()
      .describe('Click offset from the element left edge (pixels)'),
    offsetY: z
      .number()
      .optional()
      .describe('Click offset from the element top edge (pixels)'),
    screenshotAfterwards: screenshotAfterwardsSchema,
    force: z
      .boolean()
      .optional()
      .describe('Skip Playwright actionability checks'),
  }),
  async run(args, ctx) {
    const el = await pw.click(ctx.backend, ctx.targetId, {
      ref: args.ref,
      element: args.element,
      doubleClick: args.doubleClick,
      button: args.button,
      modifiers: args.modifiers,
      x: args.x,
      y: args.y,
      force: args.force,
      offsetX: args.offsetX,
      offsetY: args.offsetY,
    })
    const label = args.element ? ` (${args.element})` : ''
    return observeAfterAction(
      ctx.backend,
      ctx.targetId,
      {
        action: 'click',
        message: `${args.doubleClick ? 'Double-clicked' : 'Clicked'} ${el.role} "${el.name}"${label}`,
        compact: true,
        screenshotAfterwards: args.screenshotAfterwards,
      },
      ctx,
    )
  },
})

export const typeTool = defineBrowserTool({
  name: BROWSER_TYPE_TOOL_NAME,
  summary: 'Type text into a field by ref',
  description: prompt.TYPE_DESCRIPTION,
  inputSchema: z.object({
    ref: refSchema,
    text: z.string().describe('Text to type'),
    element: z
      .string()
      .optional()
      .describe(
        'Human-readable element description; must match the resolved ref',
      ),
    submit: z.boolean().optional().describe('Press Enter after typing'),
    slowly: z
      .boolean()
      .optional()
      .describe('Send per-character key events for widgets that need keydown'),
    screenshotAfterwards: screenshotAfterwardsSchema,
  }),
  async run(args, ctx) {
    const el = await pw.typeText(ctx.backend, ctx.targetId, {
      ref: args.ref,
      text: args.text,
      element: args.element,
      submit: args.submit,
      slowly: args.slowly,
    })
    // An action that returned is not an action that worked: report what the
    // field actually holds so a silently rejected type is visible.
    const valueNote = el.readOnly
      ? ' — nothing typed: the field is readonly. Some apps compute it from other fields, or unlock it from another control.'
      : el.disabled
        ? ' — nothing typed: the field is disabled.'
        : el.value == null
          ? ''
          : el.value !== ''
            ? ` (value: ${JSON.stringify(el.value)})`
            : ' (value still empty — the field did not accept the text)'
    return observeAfterAction(
      ctx.backend,
      ctx.targetId,
      {
        action: 'type',
        message: `Typed ${JSON.stringify(args.text)} into ${el.role} "${el.name}"${args.submit ? ' and pressed Enter' : ''}${valueNote}`,
        compact: true,
        screenshotAfterwards: args.screenshotAfterwards,
      },
      ctx,
    )
  },
})

export const fillFormTool = defineBrowserTool({
  name: BROWSER_FILL_FORM_TOOL_NAME,
  summary: 'Fill multiple form fields in one call',
  description: prompt.FILL_FORM_DESCRIPTION,
  inputSchema: z.object({
    fields: z
      .array(
        z.object({
          ref: refSchema,
          value: z
            .string()
            .describe(
              'Text, option label, or "true"/"false" for a checkbox or radio',
            ),
          kind: z
            .enum(['textbox', 'checkbox', 'radio', 'combobox'])
            .optional()
            .describe('Control type (inferred from the element when omitted)'),
        }),
      )
      .min(1)
      .describe('Fields to fill, in the order they should be written'),
    screenshotAfterwards: screenshotAfterwardsSchema,
  }),
  async run(args, ctx) {
    const filled = await pw.fillForm(ctx.backend, ctx.targetId, args.fields)
    const ok = filled.filter(f => f.status === 'filled').length
    // Per-field lines, because a batch that "succeeded" can still have dropped
    // half its values, and only the page knows which half.
    const lines = filled.map(f =>
      f.status === 'filled'
        ? `- ${f.ref} ${f.role} "${f.name}" = ${JSON.stringify(f.value ?? '')}`
        : `- ${f.ref} ${f.role} "${f.name}" ${f.status}: ${f.reason ?? 'unknown reason'}`,
    )
    return observeAfterAction(
      ctx.backend,
      ctx.targetId,
      {
        action: 'fill_form',
        message: `Filled ${ok}/${filled.length} fields\n${lines.join('\n')}`,
        compact: true,
        screenshotAfterwards: args.screenshotAfterwards,
      },
      ctx,
    )
  },
})

export const selectOptionTool = defineBrowserTool({
  name: BROWSER_SELECT_OPTION_TOOL_NAME,
  summary: 'Select an option in a native <select>',
  description: prompt.SELECT_OPTION_DESCRIPTION,
  inputSchema: z.object({
    ref: refSchema,
    values: z
      .union([z.array(z.string()).min(1), z.string().min(1)])
      .transform(v =>
        (Array.isArray(v) ? v : [v])
          .map(s => s.replace(/\s+/g, ' ').trim())
          .filter(Boolean),
      )
      .pipe(z.array(z.string()).min(1))
      .describe('Visible labels (or native option values) to select'),
    element: z
      .string()
      .optional()
      .describe('Human-readable element description; must match the resolved ref'),
    screenshotAfterwards: screenshotAfterwardsSchema,
  }),
  async run(args, ctx) {
    const res = await pw.selectOption(
      ctx.backend,
      ctx.targetId,
      args.ref,
      args.values,
      args.element,
    )
    return observeAfterAction(
      ctx.backend,
      ctx.targetId,
      {
        action: 'select_option',
        message: `Selected ${res.selected.map(s => `"${s}"`).join(', ')}`,
        compact: true,
        screenshotAfterwards: args.screenshotAfterwards,
      },
      ctx,
    )
  },
})

export const fileUploadTool = defineBrowserTool({
  name: BROWSER_FILE_UPLOAD_TOOL_NAME,
  summary: 'Upload files through the page file chooser',
  description: prompt.FILE_UPLOAD_DESCRIPTION,
  inputSchema: z.object({
    paths: z
      .array(z.string())
      .describe(
        'File paths to upload (workspace-relative or absolute). Empty list cancels the chooser',
      ),
    ref: refSchema.optional().describe('<input type=file> ref, if you have one'),
  }),
  async run(args, ctx) {
    const paths = args.paths.map(p =>
      path.isAbsolute(p) ? p : path.resolve(ctx.cwd, p),
    )
    const res = await pw.uploadFilesToPage(ctx.backend, ctx.targetId, {
      paths,
      ref: args.ref,
    })
    const n = res.files.length
    return observeAfterAction(ctx.backend, ctx.targetId, {
      action: 'file_upload',
      message: res.cancelled
        ? 'Cancelled the file chooser'
        : `Uploaded ${n} file${n === 1 ? '' : 's'}`,
      compact: true,
    })
  },
})

export const handleDialogTool = defineBrowserTool({
  name: BROWSER_HANDLE_DIALOG_TOOL_NAME,
  summary: 'Accept or dismiss a native alert/confirm/prompt',
  description: prompt.HANDLE_DIALOG_DESCRIPTION,
  inputSchema: z.object({
    accept: z
      .boolean()
      .describe('true to accept / OK, false to dismiss / Cancel'),
    promptText: z
      .string()
      .optional()
      .describe('Text to type into a prompt before accepting'),
  }),
  async run(args, ctx) {
    const res = await pw.handleNativeDialog(ctx.backend, ctx.targetId, {
      accept: args.accept,
      promptText: args.promptText,
    })
    const message = res.armed
      ? `Next native dialog will be ${res.accepted ? 'accepted' : 'dismissed'}`
      : `${res.accepted ? 'Accepted' : 'Dismissed'} ${res.type} ${JSON.stringify(res.message)}`
    return observeAfterAction(ctx.backend, ctx.targetId, {
      action: 'handle_dialog',
      message,
      compact: true,
    })
  },
})

export const pressKeyTool = defineBrowserTool({
  name: BROWSER_PRESS_KEY_TOOL_NAME,
  summary: 'Press a key on the focused element',
  description: prompt.PRESS_KEY_DESCRIPTION,
  inputSchema: z.object({
    key: z.string().describe('Key name, e.g. "Enter", "Escape", "a"'),
    modifiers: z
      .array(z.enum(['Alt', 'Control', 'Meta', 'Shift']))
      .optional()
      .describe('Modifier keys held down'),
    screenshotAfterwards: screenshotAfterwardsSchema,
  }),
  async run(args, ctx) {
    await pw.pressKey(ctx.backend, ctx.targetId, args.key, args.modifiers)
    const combo = [...(args.modifiers ?? []), args.key].join('+')
    return observeAfterAction(
      ctx.backend,
      ctx.targetId,
      {
        action: 'press_key',
        message: `Pressed ${combo}`,
        compact: true,
        screenshotAfterwards: args.screenshotAfterwards,
      },
      ctx,
    )
  },
})

export const waitForTool = defineBrowserTool({
  name: BROWSER_WAIT_FOR_TOOL_NAME,
  summary: 'Wait for text to appear or disappear, or for time to pass',
  description: prompt.WAIT_FOR_DESCRIPTION,
  inputSchema: z.object({
    time: z
      .number()
      .optional()
      .describe('Time to wait in seconds (capped at 30)'),
    text: z.string().optional().describe('Text to wait for to appear'),
    textGone: z
      .string()
      .optional()
      .describe('Text to wait for to disappear'),
    selector: z
      .string()
      .optional()
      .describe('CSS selector to wait until visible'),
    url: z
      .string()
      .optional()
      .describe('URL glob to wait for (Playwright waitForURL)'),
  }),
  async run(args, ctx) {
    await pw.waitFor(ctx.backend, ctx.targetId, {
      time: args.time,
      text: args.text,
      textGone: args.textGone,
      selector: args.selector,
      url: args.url,
    })
    const parts: string[] = []
    if (args.time != null) parts.push(`waited ${args.time}s`)
    if (args.text) parts.push(`text ${JSON.stringify(args.text)} appeared`)
    if (args.textGone) {
      parts.push(`text ${JSON.stringify(args.textGone)} disappeared`)
    }
    if (args.selector) parts.push(`selector ${JSON.stringify(args.selector)} visible`)
    if (args.url) parts.push(`url ${JSON.stringify(args.url)}`)
    return observeAfterAction(ctx.backend, ctx.targetId, {
      action: 'wait_for',
      message: parts.length ? parts.join('; ') : 'Waited',
      compact: true,
    })
  },
})

export const hoverTool = defineBrowserTool({
  name: BROWSER_HOVER_TOOL_NAME,
  summary: 'Hover the mouse over an element by ref',
  description: prompt.HOVER_DESCRIPTION,
  inputSchema: z.object({
    ref: refSchema,
    element: z
      .string()
      .optional()
      .describe(
        'Human-readable element description; must match the resolved ref',
      ),
    screenshotAfterwards: screenshotAfterwardsSchema,
  }),
  async run(args, ctx) {
    const el = await pw.hover(ctx.backend, ctx.targetId, {
      ref: args.ref,
      element: args.element,
    })
    return observeAfterAction(
      ctx.backend,
      ctx.targetId,
      {
        action: 'hover',
        message: `Hovered ${el.role} "${el.name}"`,
        compact: true,
        screenshotAfterwards: args.screenshotAfterwards,
      },
      ctx,
    )
  },
})

export const scrollTool = defineBrowserTool({
  name: BROWSER_SCROLL_TOOL_NAME,
  summary: 'Scroll the page or an element',
  description: prompt.SCROLL_DESCRIPTION,
  inputSchema: z.object({
    deltaY: z
      .number()
      .optional()
      .describe('Vertical scroll in pixels; positive scrolls down'),
    deltaX: z.number().optional().describe('Horizontal scroll in pixels'),
    ref: z
      .string()
      .optional()
      .describe('Scroll over this element instead of the page center'),
    element: z
      .string()
      .optional()
      .describe('Human-readable element description; must match the resolved ref'),
    scrollIntoView: z
      .boolean()
      .optional()
      .describe('Bring the ref into view'),
    direction: z
      .enum(['up', 'down', 'left', 'right'])
      .optional()
      .describe('Scroll direction'),
    amount: z
      .number()
      .optional()
      .describe('Pixels for direction (default 300)'),
    screenshotAfterwards: screenshotAfterwardsSchema,
  }),
  async run(args, ctx) {
    await pw.scroll(ctx.backend, ctx.targetId, {
      deltaX: args.deltaX,
      deltaY: args.deltaY,
      ref: args.ref,
      element: args.element,
      scrollIntoView: args.scrollIntoView,
      direction: args.direction,
      amount: args.amount,
    })
    return observeAfterAction(
      ctx.backend,
      ctx.targetId,
      {
        action: 'scroll',
        message: 'Scrolled',
        compact: true,
        screenshotAfterwards: args.screenshotAfterwards,
      },
      ctx,
    )
  },
})

export const screenshotTool = defineBrowserTool({
  name: BROWSER_SCREENSHOT_TOOL_NAME,
  summary: 'Screenshot the page or a single element',
  description: prompt.SCREENSHOT_DESCRIPTION,
  inputSchema: z.object({
    ref: z
      .string()
      .optional()
      .describe('Screenshot just this element instead of the viewport'),
    fullPage: z
      .boolean()
      .optional()
      .describe('Capture the entire scrollable page, not just the viewport'),
    format: z
      .enum(['png', 'jpeg'])
      .optional()
      .describe('Image format (default png)'),
    labels: z
      .boolean()
      .optional()
      .describe(
        'Overlay snapshot refs on the screenshot and return their boxes',
      ),
  }),
  async run(args, ctx) {
    const format = args.format ?? 'png'
    const shot = args.labels
      ? await pw.screenshotWithLabels(ctx.backend, ctx.targetId, {
          ref: args.ref,
          fullPage: args.fullPage,
          type: format,
        })
      : await pw.screenshot(ctx.backend, ctx.targetId, {
          ref: args.ref,
          fullPage: args.fullPage,
          format,
        })
    const scope = args.ref
      ? `element ${args.ref}`
      : args.fullPage
        ? 'full page'
        : 'viewport'
    const out = await observe(ctx.backend, ctx.targetId, {
      action: 'screenshot',
      message: args.labels
        ? `Screenshot of ${scope} with ${shot.labels} labels (${shot.skipped} skipped)`
        : `Screenshot of ${scope}`,
      withSnapshot: false,
    })
    if (args.labels && 'annotations' in shot) {
      out.annotations = shot.annotations
    }
    await attachScreenshot(out, { buffer: shot.buffer, format }, ctx.sessionId, ctx.toolCallId)
    return out
  },
})

export const consoleTool = defineBrowserTool({
  name: BROWSER_CONSOLE_TOOL_NAME,
  summary: 'Read console output and uncaught errors from the page',
  description: prompt.CONSOLE_DESCRIPTION,
  inputSchema: z.object({
    level: z
      .enum(['log', 'info', 'warn', 'error', 'debug'])
      .optional()
      .describe('Only return this level'),
    limit: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Max entries to return (default 100)'),
  }),
  async run(args, ctx) {
    const logs = await inspect.consoleLogs(ctx.backend, ctx.targetId, {
      level: args.level,
      limit: args.limit,
    })
    const out = await observe(ctx.backend, ctx.targetId, {
      action: 'console',
      message: logs.entries.length
        ? `${logs.entries.length} console ${args.level ?? 'message'}${logs.entries.length === 1 ? '' : 's'}`
        : 'No console output',
      withSnapshot: false,
    })
    // Full listing at the requested level, not just errors from this call.
    out.consoleErrors = logs.entries.map(e => ({ level: e.level, text: e.text }))
    return out
  },
})

export const networkTool = defineBrowserTool({
  name: BROWSER_NETWORK_TOOL_NAME,
  summary: 'List fetch/XHR requests the page made, with status and timing',
  description: prompt.NETWORK_DESCRIPTION,
  inputSchema: z.object({
    failedOnly: z
      .boolean()
      .optional()
      .describe('Only requests that failed or returned status >= 400'),
    urlContains: z
      .string()
      .optional()
      .describe('Only requests whose URL contains this substring'),
    limit: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Max entries to return (default 50)'),
  }),
  async run(args, ctx) {
    const net = await inspect.networkRequests(ctx.backend, ctx.targetId, {
      failedOnly: args.failedOnly,
      urlContains: args.urlContains,
      limit: args.limit,
    })
    const out = await observe(ctx.backend, ctx.targetId, {
      action: 'network',
      message: net.entries.length
        ? `${net.entries.length} request${net.entries.length === 1 ? '' : 's'}`
        : 'No matching requests',
      withSnapshot: false,
    })
    // Replace the automatic failures-only view with the requested listing.
    out.network = net.entries.map(toNetworkRow)
    out.networkTotal = net.total
    return out
  },
})

export const tabsTool = defineBrowserTool({
  name: BROWSER_TABS_TOOL_NAME,
  summary: 'List, select, open or close browser tabs',
  description: prompt.TABS_DESCRIPTION,
  requireTab: false,
  inputSchema: z.object({
    action: z.enum(['list', 'select', 'new', 'close']).describe('What to do'),
    tabId: z
      .string()
      .optional()
      .describe('Tab id from `list`; required for select and close'),
    url: z.string().optional().describe('URL to open with `new`'),
  }),
  async run(args, ctx) {
    let message: string

    switch (args.action) {
      case 'new': {
        const tab = await openTab(ctx.cwd, args.url, ctx.sessionId)
        message = args.url ? `Opened ${args.url} in a new tab` : 'Opened a new tab'
        setCurrentTab(tab.targetId, ctx.sessionId)
        break
      }
      case 'select': {
        if (!args.tabId) throw new BrowserError('select requires a tabId.')
        const tabs = await ctx.backend.listTabs()
        if (!tabs.some(t => t.targetId === args.tabId)) {
          throw new BrowserError(
            `No open tab with id "${args.tabId}". Run browser_tabs with action "list".`,
          )
        }
        setCurrentTab(args.tabId, ctx.sessionId)
        await pw.activateTab(ctx.backend, args.tabId)
        message = `Selected tab ${args.tabId}`
        break
      }
      case 'close': {
        if (!args.tabId) throw new BrowserError('close requires a tabId.')
        await ctx.backend.closeTab(args.tabId)
        message = `Closed tab ${args.tabId}`
        break
      }
      default:
        message = 'Open tabs'
    }

    const tabs = await ctx.backend.listTabs()
    const current = getCurrentTabId(ctx.sessionId)
    const out: BrowserToolOutput = {
      action: 'tabs',
      message,
      url: tabs.find(t => t.targetId === current)?.url ?? '',
      title: tabs.find(t => t.targetId === current)?.title ?? '',
      tabs: tabs.map(t => ({ ...t, current: t.targetId === current })),
    }
    return out
  },
})

export const dragTool = defineBrowserTool({
  name: BROWSER_DRAG_TOOL_NAME,
  summary: 'Drag from one element to another',
  description: prompt.DRAG_DESCRIPTION,
  inputSchema: z.object({
    startRef: refSchema.describe('Element to drag'),
    endRef: refSchema.describe('Drop target'),
  }),
  async run(args, ctx) {
    await pw.drag(ctx.backend, ctx.targetId, {
      startRef: args.startRef,
      endRef: args.endRef,
    })
    return observeAfterAction(ctx.backend, ctx.targetId, {
      action: 'drag',
      message: `Dragged ${args.startRef} to ${args.endRef}`,
      compact: true,
    })
  },
})

export const resizeTool = defineBrowserTool({
  name: BROWSER_RESIZE_TOOL_NAME,
  summary: 'Resize the browser viewport',
  description: prompt.RESIZE_DESCRIPTION,
  inputSchema: z.object({
    width: z.number().int().positive().describe('Viewport width in CSS pixels'),
    height: z
      .number()
      .int()
      .positive()
      .describe('Viewport height in CSS pixels'),
    screenshotAfterwards: screenshotAfterwardsSchema,
  }),
  async run(args, ctx) {
    await pw.resizeViewport(ctx.backend, ctx.targetId, args.width, args.height)
    return observeAfterAction(
      ctx.backend,
      ctx.targetId,
      {
        action: 'resize',
        message: `Resized viewport to ${args.width}x${args.height}`,
        compact: true,
        screenshotAfterwards: args.screenshotAfterwards,
      },
      ctx,
    )
  },
})

export const waitForDownloadTool = defineBrowserTool({
  name: BROWSER_WAIT_FOR_DOWNLOAD_TOOL_NAME,
  summary: 'Wait for the next browser download and save it',
  description: prompt.WAIT_FOR_DOWNLOAD_DESCRIPTION,
  inputSchema: z.object({
    path: z
      .string()
      .optional()
      .describe('Optional destination path under the agent downloads directory'),
    ref: z
      .string()
      .optional()
      .describe('If set, click this ref then wait for the download'),
  }),
  async run(args, ctx) {
    const dest = args.path
      ? path.isAbsolute(args.path)
        ? args.path
        : path.resolve(ctx.cwd, args.path)
      : undefined
    const result = args.ref
      ? await pw.downloadByRef(ctx.backend, ctx.targetId, {
          ref: args.ref,
          path: dest,
        })
      : await pw.waitForDownload(ctx.backend, ctx.targetId, { path: dest })
    const out = await observeAfterAction(ctx.backend, ctx.targetId, {
      action: 'wait_for_download',
      message: `Saved download ${JSON.stringify(result.suggestedFilename)}`,
      compact: true,
    })
    out.downloadPath = result.path
    return out
  },
})

export const highlightTool = defineBrowserTool({
  name: BROWSER_HIGHLIGHT_TOOL_NAME,
  summary: 'Highlight an element on the page for visual grounding',
  description: prompt.HIGHLIGHT_DESCRIPTION,
  inputSchema: z.object({
    ref: refSchema,
    element: z
      .string()
      .optional()
      .describe('Human-readable element description; must match the resolved ref'),
    durationMs: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Highlight duration in milliseconds (default 2000)'),
  }),
  async run(args, ctx) {
    const el = await pw.highlightElement(ctx.backend, ctx.targetId, {
      ref: args.ref,
      element: args.element,
      durationMs: args.durationMs,
    })
    return observe(ctx.backend, ctx.targetId, {
      action: 'highlight',
      message: `Highlighted ${el.role} "${el.name}"`,
      compact: true,
    })
  },
})

export const getBoundingBoxTool = defineBrowserTool({
  name: BROWSER_GET_BOUNDING_BOX_TOOL_NAME,
  summary: 'Get the viewport bounding box for a snapshot ref',
  description: prompt.GET_BOUNDING_BOX_DESCRIPTION,
  inputSchema: z.object({
    ref: refSchema,
    element: z
      .string()
      .optional()
      .describe('Human-readable element description; must match the resolved ref'),
  }),
  async run(args, ctx) {
    const box = await pw.getElementBoundingBox(ctx.backend, ctx.targetId, {
      ref: args.ref,
      element: args.element,
    })
    const out = await observe(ctx.backend, ctx.targetId, {
      action: 'get_bounding_box',
      message: `Bounding box for ${args.ref}: x=${Math.round(box.x)}, y=${Math.round(box.y)}, width=${Math.round(box.width)}, height=${Math.round(box.height)}`,
      withSnapshot: false,
    })
    out.value = box
    return out
  },
})

export const lockTool = defineBrowserTool({
  name: BROWSER_LOCK_TOOL_NAME,
  summary: 'Take or release control of the browser',
  description: prompt.LOCK_DESCRIPTION,
  requireTab: false,
  inputSchema: z.object({
    action: z
      .enum(['lock', 'unlock'])
      .describe(
        'lock: agent resumes driving the page; unlock: user takes over',
      ),
  }),
  async run({ action }, ctx) {
    if (action === 'unlock') {
      setUserHasControl(true, ctx.sessionId)
      return {
        action: 'lock',
        message:
          'User has control. Do not click, type, navigate, or fill. Call browser_lock with action "lock" when they are done.',
        url: '',
        title: '',
      }
    }
    setUserHasControl(false, ctx.sessionId)
    const tabs = ctx.targetId
      ? await ctx.backend.listTabs().catch(() => [])
      : []
    const current = tabs.find(t => t.targetId === ctx.targetId)
    return {
      action: 'lock',
      message: 'Agent has control of the browser.',
      url: current?.url ?? '',
      title: current?.title ?? '',
    }
  },
})

export const browserToolDefinitions: ToolDefinition[] = [
  navigateTool,
  snapshotTool,
  clickTool,
  typeTool,
  fillFormTool,
  selectOptionTool,
  fileUploadTool,
  handleDialogTool,
  pressKeyTool,
  waitForTool,
  hoverTool,
  scrollTool,
  screenshotTool,
  consoleTool,
  networkTool,
  tabsTool,
  dragTool,
  resizeTool,
  waitForDownloadTool,
  highlightTool,
  getBoundingBoxTool,
  lockTool,
]
