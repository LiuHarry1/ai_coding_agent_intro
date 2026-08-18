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
    `Native ${note.type} dialog ${JSON.stringify(note.message)} was dismissed because browser_handle_dialog was not armed. Call it with accept: true BEFORE retrying the click. Do not treat the previous action as successful.`,
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

async function fileInputOn(root: Page): Promise<Locator | null> {
  for (const frame of root.frames()) {
    const preferred = frame.locator(FILE_PREFERRED)
    if ((await preferred.count().catch(() => 0)) > 0) return preferred.last()
    const any = frame.locator(FILE_ANY)
    if ((await any.count().catch(() => 0)) > 0) return any.last()
  }
  return null
}

export async function uploadFiles(
  page: Page,
  opts: { paths: string[]; ref?: string },
): Promise<{ files: string[]; cancelled: boolean }> {
  if (opts.ref) {
    const loc = refLocator(page, opts.ref)
    await loc.setInputFiles(opts.paths, { timeout: ACTION_TIMEOUT_MS })
    await loc
      .evaluate(el => {
        el.dispatchEvent(new Event('input', { bubbles: true }))
        el.dispatchEvent(new Event('change', { bubbles: true }))
      })
      .catch(() => {})
    return { files: opts.paths, cancelled: opts.paths.length === 0 }
  }

  // Prefer the hidden <input type=file>, including those in child frames.
  // Clicking a visible Upload button often opens a real OS picker that no
  // browser_* tool can drive, and the page stays frozen until Cancel.
  let fileInput = await fileInputOn(page)
  if (!fileInput) {
    await new Promise(r => setTimeout(r, 400))
    fileInput = await fileInputOn(page)
  }
  if (fileInput) {
    await fileInput.setInputFiles(opts.paths, { timeout: ACTION_TIMEOUT_MS })
    await fileInput
      .evaluate(el => {
        el.dispatchEvent(new Event('input', { bubbles: true }))
        el.dispatchEvent(new Event('change', { bubbles: true }))
      })
      .catch(() => {})
    return { files: opts.paths, cancelled: opts.paths.length === 0 }
  }

  const chooser = pendingChooser.get(page)
  if (chooser) {
    pendingChooser.delete(page)
    await chooser.setFiles(opts.paths)
    return { files: opts.paths, cancelled: opts.paths.length === 0 }
  }

  armedFiles.set(page, opts.paths)
  throw new BrowserError(
    'No <input type=file> on this page (checked frames). Do not click Upload — that opens an OS dialog we cannot drive. Call browser_file_upload again after the drop zone is visible. If a Windows Open dialog is already on screen, Cancel it first.',
  )
}
