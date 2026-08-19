/**
 * How the model sees the page: Playwright's own AI aria snapshot, with `eN`
 * refs stamped on the live DOM, then spent against a budget by priority.
 */

import type { Frame, Page } from 'playwright-core'
import {
  COMPACT_DEPTH,
  DEFAULT_MAX_CHARS,
  SNAPSHOT_TIMEOUT_MS,
  WAIT_FOR_TIMEOUT_MS,
  WAIT_FOR_TIME_CAP_S,
} from '../limits.js'
import {
  BrowserError,
  type BrowserBackend,
  type SnapshotOpts,
  type SnapshotResult,
} from '../types.js'
import {
  countRefs,
  isBlockingMessageBox,
  prioritizeAriaSnapshot,
} from '../distill-snapshot.js'
import { isHeavyMediaFrame, SNAPSHOT_STALL_NEXT } from '../heavy-media.js'
import {
  getLastSnapshot,
  rememberSnapshot,
  setSnapshotDegraded,
} from '../session-flags.js'
import { filterSnapshotLines } from '../snapshot-index.js'
import { getPageForTarget } from './connect.js'
import { appendSnapshotUrls, type SnapshotUrlEntry } from '../snapshot-urls.js'

const DIALOG_SNAPSHOT_MS = 2_000
const DIALOG_SEARCH_MS = 3_500
const FRAME_QUERY_MS = 800
const DIALOG_PREFIX =
  'A modal dialog is covering the page. Click a control on this dialog before the page underneath.\n\n'
const DIALOG_NO_REF_PREFIX = `A modal is open but refs could not be stamped (PDF/iframe stalled the tree). ${SNAPSHOT_STALL_NEXT}\n`

async function richestLocatorSnapshot(
  page: Page,
  selector: string,
  timeout: number,
): Promise<string> {
  const loc = page.locator(selector)
  const n = await loc.count().catch(() => 0)
  if (n === 0) return ''
  if (n === 1) {
    return loc.ariaSnapshot({ mode: 'ai', timeout })
  }
  let best = ''
  let bestRefs = -1
  for (let i = 0; i < n; i++) {
    const yaml = await loc
      .nth(i)
      .ariaSnapshot({ mode: 'ai', timeout })
      .catch(() => '')
    const refs = countRefs(yaml)
    if (refs > bestRefs) {
      bestRefs = refs
      best = yaml
    }
  }
  return best
}

function raceMs<T>(ms: number, work: Promise<T>, fallback: T): Promise<T> {
  return new Promise(resolve => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      resolve(fallback)
    }, ms)
    work.then(
      value => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(value)
      },
      () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(fallback)
      },
    )
  })
}

const EMBEDDED_FRAME_OMIT_MS = 4_000
const HIDE_EVAL_MS = 1_500
const FRAMES_OMITTED_PREFIX =
  'Embedded frames omitted (they stalled the accessibility tree). Click controls on this page with role + name.\n\n'

async function hideByAttr(page: Page, attr: string, all: boolean): Promise<void> {
  await raceMs(
    HIDE_EVAL_MS,
    page
      .evaluate(
        ({ attr, all }) => {
          const nodes = document.querySelectorAll('iframe, embed, object')
          for (let i = 0; i < nodes.length; i++) {
            const el = nodes[i] as HTMLElement
            const src =
              el.getAttribute('src') || el.getAttribute('data') || ''
            const type = el.getAttribute('type') || ''
            const label = `${el.getAttribute('title') || ''} ${el.getAttribute('name') || ''} ${el.getAttribute('aria-label') || ''}`
            const s = src.toLowerCase()
            const t = type.toLowerCase()
            const heavy =
              all ||
              t.includes('pdf') ||
              s.includes('application/pdf') ||
              /\.pdf(\b|$|\?|#)/.test(s) ||
              s.startsWith('blob:') ||
              s.startsWith('data:application/pdf') ||
              s.includes('pdf.js') ||
              (s.startsWith('chrome-extension://') &&
                (s.includes('pdf') ||
                  s.includes('mhjfbmdgcfjbbpaeojofohoefgiehjai'))) ||
              ((s === '' || s === 'about:blank') &&
                /pdf|preview|viewer|document/i.test(label))
            if (!heavy) continue
            el.setAttribute(attr, '1')
            el.style.setProperty('display', 'none', 'important')
          }
        },
        { attr, all },
      )
      .then(() => undefined),
    undefined,
  )
}

async function unhideByAttr(page: Page, attr: string): Promise<void> {
  await raceMs(
    HIDE_EVAL_MS,
    page
      .evaluate(attr => {
        const nodes = document.querySelectorAll(`[${attr}]`)
        for (let i = 0; i < nodes.length; i++) {
          const el = nodes[i] as HTMLElement
          el.removeAttribute(attr)
          el.style.removeProperty('display')
        }
      }, attr)
      .then(() => undefined),
    undefined,
  )
}

export async function withHeavyMediaHidden<T>(
  page: Page,
  run: () => Promise<T>,
): Promise<T> {
  await hideByAttr(page, 'data-snap-hide', false).catch(() => {})
  try {
    return await run()
  } finally {
    await unhideByAttr(page, 'data-snap-hide').catch(() => {})
  }
}

/** Last-resort snapshot: skip every iframe/embed so a hung viewer cannot stall the tree. */
async function withEmbeddedFramesOmitted<T>(
  page: Page,
  run: () => Promise<T>,
): Promise<T> {
  await hideByAttr(page, 'data-snap-omit', true).catch(() => {})
  try {
    return await run()
  } finally {
    await unhideByAttr(page, 'data-snap-omit').catch(() => {})
  }
}

async function ariaSnapshotPage(
  page: Page,
  timeout: number,
  depth?: number,
): Promise<string> {
  return page.ariaSnapshot({
    mode: 'ai',
    timeout,
    ...(depth !== undefined ? { depth } : {}),
  })
}

/**
 * In-page Error / Yes-No / OK box. Not `window.alert` (that is
 * `browser_handle_dialog`), and not every `role=dialog` (nav panels, inbox
 * sheets, "Please wait" overlays).
 *
 * PDF/blob frames are skipped and every locator is time-capped: a hung
 * receipt viewer used to block this for the full 60s call budget, so the
 * model never saw the Yes/No box sitting on top of the form.
 */
async function snapshotDialogInFrame(frame: Frame): Promise<string | null> {
  const alerts = frame.locator('[role="alertdialog"]')
  const n = await raceMs(
    FRAME_QUERY_MS,
    alerts.count().catch(() => 0),
    0,
  )
  for (let i = 0; i < n; i++) {
    const item = alerts.nth(i)
    const visible = await raceMs(
      FRAME_QUERY_MS,
      item.isVisible().catch(() => false),
      false,
    )
    if (!visible) continue
    const yaml = await raceMs(
      DIALOG_SNAPSHOT_MS,
      item.ariaSnapshot({ mode: 'ai', timeout: DIALOG_SNAPSHOT_MS }).catch(() => ''),
      '',
    )
    if (yaml && countRefs(yaml) > 0) return yaml
    if (yaml) return DIALOG_NO_REF_PREFIX
  }

  const yes = frame.getByRole('button', { name: /^Yes$/i })
  const yesVisible = await raceMs(
    FRAME_QUERY_MS,
    yes.first().isVisible().catch(() => false),
    false,
  )
  if (!yesVisible) return null
  const no = frame.getByRole('button', { name: /^No$/i })
  const hasNo = await raceMs(
    FRAME_QUERY_MS,
    no.first().isVisible().catch(() => false),
    false,
  )
  if (!hasNo) return null
  const box = yes
    .first()
    .locator(
      'xpath=ancestor::*[@role="dialog" or @role="alertdialog" or @aria-modal="true"][1]',
    )
  const yaml = await raceMs(
    DIALOG_SNAPSHOT_MS,
    box.ariaSnapshot({ mode: 'ai', timeout: DIALOG_SNAPSHOT_MS }).catch(() => ''),
    '',
  )
  if (yaml && isBlockingMessageBox(yaml)) return yaml
  const yesYaml = await raceMs(
    DIALOG_SNAPSHOT_MS,
    yes.first().ariaSnapshot({ mode: 'ai', timeout: DIALOG_SNAPSHOT_MS }).catch(() => ''),
    '',
  )
  return yesYaml && countRefs(yesYaml) > 0 ? yesYaml : null
}

async function snapshotBlockingDialog(page: Page): Promise<string | null> {
  return raceMs(
    DIALOG_SEARCH_MS,
    (async () => {
      const frames: Frame[] = []
      const seen = new Set<Frame>()
      const consider = (frame: Frame) => {
        if (seen.has(frame)) return
        seen.add(frame)
        if (isHeavyMediaFrame(frame.url())) return
        frames.push(frame)
      }
      consider(page.mainFrame())
      for (const frame of page.frames()) consider(frame)

      for (const frame of frames) {
        const yaml = await snapshotDialogInFrame(frame)
        if (yaml) return yaml
      }
      return null
    })(),
    null,
  )
}

async function collectSnapshotUrls(page: Page): Promise<SnapshotUrlEntry[]> {
  // collectSnapshotUrls
  const urls = await page
    .evaluate(() => {
      const seen = new Set<string>()
      const out: SnapshotUrlEntry[] = []
      for (const anchor of Array.from(document.querySelectorAll('a[href]'))) {
        const href = anchor instanceof HTMLAnchorElement ? anchor.href : ''
        if (!href || seen.has(href)) {
          continue
        }
        const text =
          (anchor.textContent || anchor.getAttribute('aria-label') || '')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 121) || href
        seen.add(href)
        out.push({ text, url: href })
        if (out.length >= 100) {
          break
        }
      }
      return out
    })
    .catch(() => [])
  return Array.isArray(urls)
    ? urls.map(entry => {
        entry.text = entry.text.slice(0, 120) || entry.url
        return entry
      })
    : []
}

function recordSnapshotHealth(targetId: string, text: string): void {
  const degraded =
    text.includes(SNAPSHOT_STALL_NEXT) ||
    /Embedded frames omitted/i.test(text) ||
    text.startsWith('A modal is open but refs could not be stamped')
  if (degraded) {
    setSnapshotDegraded(targetId, true)
    return
  }
  if (/\[ref=/i.test(text)) {
    setSnapshotDegraded(targetId, false)
    rememberSnapshot(targetId, text)
  }
}

export async function snapshot(
  backend: BrowserBackend,
  targetId: string,
  opts: SnapshotOpts = {},
): Promise<SnapshotResult> {
  const page = await getPageForTarget(backend, targetId)
  const finish = (result: SnapshotResult): SnapshotResult => {
    recordSnapshotHealth(targetId, result.text)
    return result
  }
  const pack = async (raw: string, prefix = ''): Promise<SnapshotResult> => {
    const { text, truncated } = prioritizeAriaSnapshot(raw, {
      maxChars: opts.maxChars ?? DEFAULT_MAX_CHARS,
      maxNodes: opts.maxNodes,
      interactive: opts.interactive,
    })
    let body = prefix + text
    if (opts.urls) {
      body = appendSnapshotUrls(body, await collectSnapshotUrls(page))
    }
    return {
      url: page.url(),
      title: await page.title().catch(() => ''),
      text: body,
      nodes: countRefs(text),
      truncated,
    }
  }
  const packDialog = async (dialog: string): Promise<SnapshotResult> => {
    if (dialog.startsWith('A modal is open')) {
      return {
        url: page.url(),
        title: await page.title().catch(() => ''),
        text: dialog,
        nodes: 1,
        truncated: true,
      }
    }
    return pack(dialog, DIALOG_PREFIX)
  }
  const emptyDialogPack = async (): Promise<SnapshotResult> => ({
    url: page.url(),
    title: await page.title().catch(() => ''),
    text: 'No blocking in-page dialog is open.',
    nodes: 0,
    truncated: false,
  })
  try {
    if (opts.dialogOnly) {
      const dialog = await snapshotBlockingDialog(page)
      if (dialog) return finish(await packDialog(dialog))
      return finish(await emptyDialogPack())
    }
    if (!opts.selector) {
      const dialog = await snapshotBlockingDialog(page)
      if (dialog) return finish(await packDialog(dialog))
    }
    // compact on a subtree must not clip depth: that is what turned an open
    // dialog into Close + title. A selector-scoped snapshot is already narrow.
    const depth = opts.compact && !opts.selector ? COMPACT_DEPTH : undefined
    let raw = opts.selector
      ? await richestLocatorSnapshot(page, opts.selector, SNAPSHOT_TIMEOUT_MS)
      : await raceMs(
          SNAPSHOT_TIMEOUT_MS + 500,
          withHeavyMediaHidden(page, () =>
            ariaSnapshotPage(page, SNAPSHOT_TIMEOUT_MS, depth),
          ),
          '',
        )
    let omittedFrames = false
    if (!raw && !opts.selector) {
      // A hung PDF/viewer iframe can stall the whole tree.
      // frame never returns. Omit embeds and snapshot the host page.
      omittedFrames = true
      raw = await raceMs(
        EMBEDDED_FRAME_OMIT_MS,
        withEmbeddedFramesOmitted(page, () =>
          ariaSnapshotPage(page, EMBEDDED_FRAME_OMIT_MS, depth),
        ),
        '',
      )
    }
    if (opts.selector && !raw) {
      return finish({
        url: page.url(),
        title: await page.title().catch(() => ''),
        text: `No nodes matched selector ${JSON.stringify(opts.selector)}. That is not a PDF skip — use the last full snapshot, or omit selector.`,
        nodes: 0,
        truncated: false,
      })
    }
    if (!raw) {
      return finish({
        url: page.url(),
        title: await page.title().catch(() => ''),
        text: `Full-page snapshot timed out. ${SNAPSHOT_STALL_NEXT}`,
        nodes: 1,
        truncated: true,
      })
    }
    return finish(await pack(raw, omittedFrames ? FRAMES_OMITTED_PREFIX : ''))
  } catch {
    const dialog = await snapshotBlockingDialog(page)
    if (dialog) return finish(await packDialog(dialog))
    if (opts.selector) {
      return finish({
        url: page.url(),
        title: await page.title().catch(() => ''),
        text: `Snapshot of ${JSON.stringify(opts.selector)} failed. Do not treat this as a PDF skip — omit selector or click the last refs.`,
        nodes: 0,
        truncated: false,
      })
    }
    return finish({
      url: page.url(),
      title: await page.title().catch(() => ''),
      text: `Full-page snapshot timed out. ${SNAPSHOT_STALL_NEXT}`,
      nodes: 1,
      truncated: true,
    })
  }
}

export async function waitFor(
  backend: BrowserBackend,
  targetId: string,
  opts: {
    time?: number
    text?: string
    textGone?: string
    selector?: string
    url?: string
  },
): Promise<void> {
  if (
    !opts.text &&
    !opts.textGone &&
    opts.time == null &&
    !opts.selector &&
    !opts.url
  ) {
    throw new BrowserError('Either time, text, textGone, selector or url must be provided')
  }
  const page = await getPageForTarget(backend, targetId)
  try {
    if (opts.time != null) {
      const ms = Math.min(WAIT_FOR_TIME_CAP_S, Math.max(0, opts.time)) * 1000
      await new Promise<void>(r => setTimeout(r, ms))
    }
    if (opts.textGone) {
      await page
        .getByText(opts.textGone)
        .first()
        .waitFor({ state: 'hidden', timeout: WAIT_FOR_TIMEOUT_MS })
    }
    if (opts.text) {
      await page
        .getByText(opts.text)
        .first()
        .waitFor({ state: 'visible', timeout: WAIT_FOR_TIMEOUT_MS })
    }
    if (opts.selector) {
      await page
        .locator(opts.selector)
        .first()
        .waitFor({ state: 'visible', timeout: WAIT_FOR_TIMEOUT_MS })
    }
    if (opts.url) {
      await page.waitForURL(opts.url, { timeout: WAIT_FOR_TIMEOUT_MS })
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const what = opts.text
      ? `text ${JSON.stringify(opts.text)} to appear`
      : opts.textGone
        ? `text ${JSON.stringify(opts.textGone)} to disappear`
        : opts.selector
          ? `selector ${JSON.stringify(opts.selector)}`
          : opts.url
            ? `url ${JSON.stringify(opts.url)}`
            : 'condition'
    throw new BrowserError(
      /Timeout/i.test(message) ? `Timed out waiting for ${what}.` : message,
    )
  }
}

export async function findInSnapshot(
  backend: BrowserBackend,
  targetId: string,
  query: string,
): Promise<{ text: string; fromCache: boolean }> {
  const q = (query || '').trim()
  if (!q) throw new BrowserError('find requires a query string')
  let fromCache = true
  let yaml = getLastSnapshot(targetId)
  if (!yaml) {
    fromCache = false
    yaml = (await snapshot(backend, targetId, { interactive: true })).text
  }
  const hits = filterSnapshotLines(yaml, q)
  if (!hits) {
    return {
      text: `No snapshot lines matched ${JSON.stringify(q)}.`,
      fromCache,
    }
  }
  return { text: hits, fromCache }
}
