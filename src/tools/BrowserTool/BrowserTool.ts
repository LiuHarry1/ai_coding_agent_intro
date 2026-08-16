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
import { tool } from 'ai'
import { z } from 'zod'
import * as ops from '../../browser/page-ops.js'
import {
  getBrowser,
  getCurrentTabId,
  openTab,
  resolveTab,
  setCurrentTab,
} from '../../browser/manager.js'
import { BrowserError, type BrowserBackend } from '../../browser/types.js'
import {
  BROWSER_CLICK_TOOL_NAME,
  BROWSER_CONSOLE_TOOL_NAME,
  BROWSER_EVALUATE_TOOL_NAME,
  BROWSER_HOVER_TOOL_NAME,
  BROWSER_NAVIGATE_TOOL_NAME,
  BROWSER_NETWORK_TOOL_NAME,
  BROWSER_PRESS_KEY_TOOL_NAME,
  BROWSER_SCREENSHOT_TOOL_NAME,
  BROWSER_SCROLL_TOOL_NAME,
  BROWSER_SELECT_OPTION_TOOL_NAME,
  BROWSER_SNAPSHOT_TOOL_NAME,
  BROWSER_TABS_TOOL_NAME,
  BROWSER_TYPE_TOOL_NAME,
  BROWSER_WAIT_FOR_TOOL_NAME,
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
  DEFAULT_MAX_NODES,
  mapBrowserOutput,
  observe,
  resetConsoleWatermark,
  toNetworkRow,
  type BrowserToolOutput,
} from './shared.js'

/** No browser call should outlive a stuck page; the model needs its turn back. */
const CALL_TIMEOUT_MS = 60_000

interface RunContext {
  backend: BrowserBackend
  targetId: string
  cwd: string
  sessionId?: string
  toolCallId: string
}

function withTimeout<T>(promise: Promise<T>, action: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new BrowserError(
          `${action} timed out after ${CALL_TIMEOUT_MS / 1000}s. The page may be stuck loading; check the dev server or try browser_console.`,
        ),
      )
    }, CALL_TIMEOUT_MS)
    promise.then(
      value => {
        clearTimeout(timer)
        resolve(value)
      },
      err => {
        clearTimeout(timer)
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
      ops.snapshot(backend, targetId, { maxNodes: DEFAULT_MAX_NODES }),
      'snapshot',
    )
    return snap.text
  } catch {
    return undefined
  }
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
          options?: { toolCallId?: string },
        ): Promise<DualChannelToolResult<BrowserToolOutput> | string> => {
          const toolCallId = options?.toolCallId ?? randomUUID()
          let resolved: { backend: BrowserBackend; targetId: string } | undefined
          try {
            const cwdNow = context.cwd ?? cwd
            if (cfg.requireTab === false) {
              const backend = await withTimeout(getBrowser(cwdNow), cfg.name)
              resolved = { backend, targetId: getCurrentTabId() ?? '' }
            } else {
              resolved = await withTimeout(resolveTab(cwdNow), cfg.name)
            }
            const data = await withTimeout(
              cfg.run(args, {
                backend: resolved.backend,
                targetId: resolved.targetId,
                cwd: cwdNow,
                sessionId: context.sessionId,
                toolCallId,
              }),
              cfg.name,
            )
            return { data }
          } catch (err) {
            // A failed action leaves the model's snapshot one render stale, which
            // is what makes it retry the same doomed ref. Hand back the current
            // tree with the error so its next move is grounded in reality.
            const fresh = resolved
              ? await freshSnapshotText(resolved.backend, resolved.targetId)
              : undefined
            return browserErrorText(err, cfg.name, fresh)
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
  summary: 'Open a URL in the browser and return a snapshot of the page',
  description: prompt.NAVIGATE_DESCRIPTION,
  inputSchema: z.object({
    url: z.string().describe('Absolute URL to open, e.g. http://localhost:3000'),
  }),
  async run({ url }, ctx) {
    // A fresh page means a fresh console; without this the first observation
    // would replay errors from whatever was loaded before.
    resetConsoleWatermark(ctx.targetId)
    await ops.navigate(ctx.backend, ctx.targetId, url)
    return observe(ctx.backend, ctx.targetId, {
      action: 'navigate',
      message: `Navigated to ${url}`,
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
      .describe(`Cap on snapshot nodes (default ${DEFAULT_MAX_NODES})`),
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
        'Drop structural wrappers (generic/group/list/…) that are not clickable',
      ),
  }),
  async run({ maxNodes, selector, compact }, ctx) {
    return observe(ctx.backend, ctx.targetId, {
      action: 'snapshot',
      message: 'Page snapshot',
      maxNodes: maxNodes ?? DEFAULT_MAX_NODES,
      selector,
      compact,
    })
  },
})

export const clickTool = defineBrowserTool({
  name: BROWSER_CLICK_TOOL_NAME,
  summary: 'Click an element by ref',
  description: prompt.CLICK_DESCRIPTION,
  inputSchema: z.object({
    ref: refSchema,
    doubleClick: z.boolean().optional().describe('Send a double click'),
    button: z
      .enum(['left', 'right', 'middle'])
      .optional()
      .describe('Mouse button (default left)'),
    modifiers: z
      .array(z.enum(['Alt', 'Control', 'Meta', 'Shift']))
      .optional()
      .describe('Modifier keys held during the click'),
  }),
  async run(args, ctx) {
    const el = await ops.click(ctx.backend, ctx.targetId, {
      ref: args.ref,
      doubleClick: args.doubleClick,
      button: args.button,
      modifiers: args.modifiers,
    })
    return observe(ctx.backend, ctx.targetId, {
      action: 'click',
      message: `${args.doubleClick ? 'Double-clicked' : 'Clicked'} ${el.role} "${el.name}"`,
    })
  },
})

export const typeTool = defineBrowserTool({
  name: BROWSER_TYPE_TOOL_NAME,
  summary: 'Type text into a field by ref',
  description: prompt.TYPE_DESCRIPTION,
  inputSchema: z.object({
    ref: refSchema,
    text: z.string().describe('Text to type'),
    submit: z.boolean().optional().describe('Press Enter after typing'),
    slowly: z
      .boolean()
      .optional()
      .describe('Send per-character key events for widgets that need keydown'),
  }),
  async run(args, ctx) {
    const el = await ops.typeText(ctx.backend, ctx.targetId, {
      ref: args.ref,
      text: args.text,
      submit: args.submit,
      slowly: args.slowly,
    })
    return observe(ctx.backend, ctx.targetId, {
      action: 'type',
      message: `Typed into ${el.role} "${el.name}"${args.submit ? ' and pressed Enter' : ''}`,
    })
  },
})

export const selectOptionTool = defineBrowserTool({
  name: BROWSER_SELECT_OPTION_TOOL_NAME,
  summary: 'Select options in a <select> element',
  description: prompt.SELECT_OPTION_DESCRIPTION,
  inputSchema: z.object({
    ref: refSchema,
    values: z
      .array(z.string())
      .min(1)
      .describe('Option values or visible labels to select'),
  }),
  async run(args, ctx) {
    const res = await ops.selectOption(
      ctx.backend,
      ctx.targetId,
      args.ref,
      args.values,
    )
    return observe(ctx.backend, ctx.targetId, {
      action: 'select_option',
      message: `Selected ${res.selected.map(s => `"${s}"`).join(', ')}`,
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
  }),
  async run(args, ctx) {
    await ops.pressKey(ctx.backend, ctx.targetId, args.key, args.modifiers)
    const combo = [...(args.modifiers ?? []), args.key].join('+')
    return observe(ctx.backend, ctx.targetId, {
      action: 'press_key',
      message: `Pressed ${combo}`,
    })
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
      .describe('Time to wait in seconds (capped at 10)'),
    text: z.string().optional().describe('Text to wait for to appear'),
    textGone: z
      .string()
      .optional()
      .describe('Text to wait for to disappear'),
  }),
  async run(args, ctx) {
    await ops.waitFor(ctx.backend, ctx.targetId, {
      time: args.time,
      text: args.text,
      textGone: args.textGone,
    })
    const parts: string[] = []
    if (args.time != null) parts.push(`waited ${args.time}s`)
    if (args.text) parts.push(`text ${JSON.stringify(args.text)} appeared`)
    if (args.textGone) {
      parts.push(`text ${JSON.stringify(args.textGone)} disappeared`)
    }
    return observe(ctx.backend, ctx.targetId, {
      action: 'wait_for',
      message: parts.length ? parts.join('; ') : 'Waited',
    })
  },
})

export const hoverTool = defineBrowserTool({
  name: BROWSER_HOVER_TOOL_NAME,
  summary: 'Hover the mouse over an element by ref',
  description: prompt.HOVER_DESCRIPTION,
  inputSchema: z.object({ ref: refSchema }),
  async run(args, ctx) {
    const el = await ops.hover(ctx.backend, ctx.targetId, { ref: args.ref })
    return observe(ctx.backend, ctx.targetId, {
      action: 'hover',
      message: `Hovered ${el.role} "${el.name}"`,
    })
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
  }),
  async run(args, ctx) {
    await ops.scroll(ctx.backend, ctx.targetId, {
      deltaX: args.deltaX,
      deltaY: args.deltaY ?? (args.deltaX ? 0 : 500),
      ref: args.ref,
    })
    return observe(ctx.backend, ctx.targetId, {
      action: 'scroll',
      message: 'Scrolled',
    })
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
  }),
  async run(args, ctx) {
    const shot = await ops.screenshot(ctx.backend, ctx.targetId, {
      ref: args.ref,
      fullPage: args.fullPage,
      format: args.format,
    })
    const scope = args.ref
      ? `element ${args.ref}`
      : args.fullPage
        ? 'full page'
        : 'viewport'
    const out = await observe(ctx.backend, ctx.targetId, {
      action: 'screenshot',
      message: `Screenshot of ${scope}`,
      // The image is the answer here; a snapshot alongside it is noise.
      withSnapshot: false,
    })
    await attachScreenshot(out, shot, ctx.sessionId, ctx.toolCallId)
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
    const logs = await ops.consoleLogs(ctx.backend, ctx.targetId, {
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
    const net = await ops.networkRequests(ctx.backend, ctx.targetId, {
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
        const tab = await openTab(ctx.cwd, args.url)
        message = args.url ? `Opened ${args.url} in a new tab` : 'Opened a new tab'
        setCurrentTab(tab.targetId)
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
        setCurrentTab(args.tabId)
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
    const current = getCurrentTabId()
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

export const evaluateTool = defineBrowserTool({
  name: BROWSER_EVALUATE_TOOL_NAME,
  summary: 'Evaluate a JavaScript expression in the page',
  description: prompt.EVALUATE_DESCRIPTION,
  inputSchema: z.object({
    expression: z
      .string()
      .describe('JavaScript expression, e.g. `document.title` or `fetch("/api").then(r => r.status)`'),
  }),
  async run(args, ctx) {
    const value = await ops.evaluateExpression(
      ctx.backend,
      ctx.targetId,
      args.expression,
    )
    const out = await observe(ctx.backend, ctx.targetId, {
      action: 'evaluate',
      message: 'Evaluated expression',
      withSnapshot: false,
    })
    out.value = value ?? null
    return out
  },
})

export const browserToolDefinitions: ToolDefinition[] = [
  navigateTool,
  snapshotTool,
  clickTool,
  typeTool,
  selectOptionTool,
  pressKeyTool,
  waitForTool,
  hoverTool,
  scrollTool,
  screenshotTool,
  consoleTool,
  networkTool,
  tabsTool,
  evaluateTool,
]
