/**
 * Native dialogs and file choosers freeze the page until something answers
 * them. Playwright auto-dismisses both unless a listener is installed; once
 * one is, the triggering action never returns until accept/dismiss / setFiles.
 *
 * So a native dialog cannot be "click, then handle" across two tool calls —
 * the click is still waiting. This layer arms the next dialog (or dismisses
 * it by default) inside the listener, and records what happened so the
 * observation can mention it. File choosers do not block JS the same way:
 * click can return with a pending chooser, and `browser_file_upload` drains it.
 * A snapshot `ref` is only a hint: if it is not a file input, we look next to
 * it, then drain a pending chooser, then search hidden inputs across frames.
 */

import type { Dialog, FileChooser, Locator, Page } from 'playwright-core'
import { BrowserError } from '../types.js'
import { ACTION_TIMEOUT_MS } from '../limits.js'
import { refLocator } from './locator.js'

export interface DialogNote {
  type: string
  message: string
  accepted: boolean
  pending?: boolean
  /** True when nothing called handle_dialog before this dialog opened. */
  unarmed?: boolean
}

interface DialogIntent {
  accept: boolean
  promptText?: string
}

const watched = new WeakSet<Page>()
const pendingDialog = new WeakMap<Page, Dialog>()
const pendingChooser = new WeakMap<Page, FileChooser>()
const armedFiles = new WeakMap<Page, string[]>()
const nextIntent = new WeakMap<Page, DialogIntent>()
const lastNote = new WeakMap<Page, DialogNote>()

async function settleDialog(page: Page, dialog: Dialog): Promise<void> {
  const armed = nextIntent.get(page)
  nextIntent.delete(page)
  const kind = dialog.type()
  // alert is informational — accept so the page unfreezes.
  // confirm/prompt/beforeunload without a prior handle_dialog: dismiss so
  // the click can return, then the action fails (see throwIfUnarmedDestructiveDialog).
  const accept = armed ? armed.accept : kind === 'alert'
  lastNote.set(page, {
    type: kind,
    message: dialog.message(),
    accepted: accept,
    unarmed: !armed,
  })
  if (accept) await dialog.accept(armed?.promptText)
  else await dialog.dismiss()
}

/**
 * Playwright must answer a native dialog in the event handler or the click
 * never returns. Unarmed confirm/prompt is therefore dismissed — then this
 * turns the action into a failure so the model does not treat it as success.
 */
export function throwIfUnarmedDestructiveDialog(page: Page): void {
  const note = lastNote.get(page)
  if (!note?.unarmed) return
  if (note.type === 'alert') return
  lastNote.delete(page)
  throw new BrowserError(
    `Native ${note.type} dialog ${JSON.stringify(note.message)} was dismissed because browser_handle_dialog was not armed. Call it with accept: true BEFORE retrying the click. Do not treat the previous action as successful.\nRecovery action: browser_handle_dialog with accept: true, then retry the click`,
  )
}

export function watchPage(page: Page): Page {
  if (watched.has(page)) return page
  watched.add(page)
  page.on('dialog', dialog =>
    // Must accept/dismiss here or the click that opened it never returns.
    settleDialog(page, dialog).catch(() => {
      pendingDialog.set(page, dialog)
    }),
  )
  page.on('filechooser', chooser => {
    const armed = armedFiles.get(page)
    if (armed) {
      armedFiles.delete(page)
      void chooser.setFiles(armed)
      return
    }
    pendingChooser.set(page, chooser)
  })
  page.on('close', () => {
    pendingDialog.delete(page)
    pendingChooser.delete(page)
    armedFiles.delete(page)
    nextIntent.delete(page)
    lastNote.delete(page)
    watched.delete(page)
  })
  return page
}

export function peekDialog(page: Page): DialogNote | undefined {
  const dialog = pendingDialog.get(page)
  if (dialog) {
    return {
      type: dialog.type(),
      message: dialog.message(),
      accepted: false,
      pending: true,
    }
  }
  const note = lastNote.get(page)
  if (note) {
    lastNote.delete(page)
    return note
  }
  return undefined
}

export async function handleDialog(
  page: Page,
  opts: { accept: boolean; promptText?: string },
): Promise<DialogNote & { armed?: boolean }> {
  const dialog = pendingDialog.get(page)
  if (dialog) {
    pendingDialog.delete(page)
    if (opts.accept) await dialog.accept(opts.promptText)
    else await dialog.dismiss()
    const note: DialogNote = {
      type: dialog.type(),
      message: dialog.message(),
      accepted: opts.accept,
    }
    lastNote.delete(page)
    return note
  }
  nextIntent.set(page, opts)
  return {
    type: 'none',
    message: '',
    accepted: opts.accept,
    armed: true,
  }
}

const FILE_PREFERRED =
  'input[type="file"].upload-file, input[type="file"][class*="upload"]'
const FILE_ANY = 'input[type="file"]'
const FILE_WIDGET_MAX_DEPTH = 8

const NO_FILE_INPUT_ERROR =
  'No <input type=file> on this page (checked frames). Do not click a visible Upload — that opens an OS dialog we cannot drive. Call browser_file_upload with paths only (omit ref). If a Windows Open dialog is already on screen, Cancel it first.\nRecovery action: browser_file_upload with paths only (omit ref)'

async function fileInputOn(root: Page): Promise<Locator | null> {
  for (const frame of root.frames()) {
    const preferred = frame.locator(FILE_PREFERRED)
    if ((await preferred.count().catch(() => 0)) > 0) return preferred.last()
    const any = frame.locator(FILE_ANY)
    if ((await any.count().catch(() => 0)) > 0) return any.last()
  }
  return null
}

async function locatorCount(loc: Locator): Promise<number> {
  return loc.count().catch(() => 0)
}

async function isFileInput(loc: Locator): Promise<boolean> {
  if ((await locatorCount(loc)) === 0) return false
  return loc
    .evaluate(
      el => el instanceof HTMLInputElement && el.type === 'file',
    )
    .catch(() => false)
}

async function fileInputById(page: Page, id: string): Promise<Locator | null> {
  if (!id) return null
  const sel = `input[type="file"]#${CSS.escape(id)}`
  for (const frame of page.frames()) {
    const loc = frame.locator(sel)
    if ((await locatorCount(loc)) > 0) return loc.first()
  }
  return null
}

/**
 * `ref` is a hint, not a hard target. Sites hide the real <input type=file>
 * behind a paperclip / "Upload" control that is not itself a file input —
 * Playwright MCP only drains a pending chooser (no ref); Cursor's IDE browser
 * has no upload tool. We resolve the actual file input so a wrong visible
 * ref still uploads instead of timing out on setInputFiles.
 *
 * Do not click the trigger: that opens a native OS dialog we cannot drive.
 */
async function fileInputFromRef(
  page: Page,
  ref: string,
): Promise<Locator | null> {
  const loc = refLocator(page, ref)
  if ((await locatorCount(loc)) === 0) return null
  if (await isFileInput(loc)) return loc

  const nested = loc.locator(FILE_ANY)
  if ((await locatorCount(nested)) > 0) return nested.last()

  for (let depth = 1; depth <= FILE_WIDGET_MAX_DEPTH; depth++) {
    const parent = loc.locator(`xpath=ancestor::*[${depth}]`)
    const tag = await parent
      .evaluate(el => (el instanceof HTMLElement ? el.tagName : ''))
      .catch(() => '')
    if (!tag || tag === 'BODY' || tag === 'HTML') break
    const found = parent.locator(FILE_ANY)
    if ((await locatorCount(found)) > 0) return found.last()
  }

  const forId = await loc
    .evaluate(el => {
      const label =
        el instanceof HTMLLabelElement
          ? el
          : el instanceof Element
            ? el.closest('label')
            : null
      return label ? String(label.htmlFor || '') : ''
    })
    .catch(() => '')
  return fileInputById(page, forId)
}

async function setFilesOnInput(
  loc: Locator,
  paths: string[],
): Promise<void> {
  await loc.setInputFiles(paths, { timeout: ACTION_TIMEOUT_MS })
  await loc
    .evaluate(el => {
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
    })
    .catch(() => {})
}

async function drainChooser(
  page: Page,
  paths: string[],
): Promise<{ files: string[]; cancelled: boolean } | null> {
  const chooser = pendingChooser.get(page)
  if (!chooser) return null
  pendingChooser.delete(page)
  await chooser.setFiles(paths)
  return { files: paths, cancelled: paths.length === 0 }
}

export async function uploadFiles(
  page: Page,
  opts: { paths: string[]; ref?: string },
): Promise<{ files: string[]; cancelled: boolean }> {
  // 1. Snapshot ref that is (or sits next to) a file input.
  if (opts.ref) {
    const fromRef = await fileInputFromRef(page, opts.ref)
    if (fromRef) {
      await setFilesOnInput(fromRef, opts.paths)
      return { files: opts.paths, cancelled: opts.paths.length === 0 }
    }
  }

  // 2. Playwright MCP path: a prior click already opened a FileChooser.
  const fromChooser = await drainChooser(page, opts.paths)
  if (fromChooser) return fromChooser

  // 3. Hidden inputs anywhere, including child frames. Clicking a visible
  // Upload often opens a real OS picker that no browser_* tool can drive.
  let fileInput = await fileInputOn(page)
  if (!fileInput) {
    await new Promise(r => setTimeout(r, 400))
    fileInput = await fileInputOn(page)
  }
  if (fileInput) {
    await setFilesOnInput(fileInput, opts.paths)
    return { files: opts.paths, cancelled: opts.paths.length === 0 }
  }

  armedFiles.set(page, opts.paths)
  throw new BrowserError(NO_FILE_INPUT_ERROR)
}
