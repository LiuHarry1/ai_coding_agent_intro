/**
 * Hand the relay URL to the extension by opening the extension's own page.
 *
 * Passing a `chrome-extension://` URL on Chrome's command line is the whole
 * trick: if Chrome is already running this just opens a tab in that instance,
 * and if it is not, it starts with the user's normal profile. Either way the
 * credential travels through a channel only the extension can read, so nothing
 * has to be typed, stored, or kept in sync.
 */
import { spawn } from 'node:child_process'
import { chromePath } from '../chrome-path.js'
import { BrowserError, type BrowserConfig } from '../types.js'
import type { RelayServer } from './server.js'

export const EXTENSION_TOKEN_ENV = 'AGENT_BROWSER_EXTENSION_TOKEN'

/** The extension's auto-connect token, if the user configured one. */
export function resolveExtensionToken(
  config: Pick<BrowserConfig, 'extensionToken'>,
): string | undefined {
  const token =
    process.env[EXTENSION_TOKEN_ENV]?.trim() || config.extensionToken?.trim()
  return token || undefined
}

export interface OpenConnectPageOptions {
  /** Shown on the page as the thing asking for access. */
  clientName?: string
  /** Passed through as `--profile-directory` when the user runs several. */
  profileDirectory?: string
  /** The extension's auto-connect token; skips the Allow prompt when it matches. */
  pairingToken?: string
}

export function openConnectPage(
  relay: RelayServer,
  opts: OpenConnectPageOptions = {},
): void {
  const connectUrl = relay.connectUrl(opts.clientName, opts.pairingToken)
  let executable: string
  try {
    executable = chromePath()
  } catch (err) {
    throw new BrowserError(
      `${err instanceof Error ? err.message : String(err)}\n` +
        'Alternatively open this URL in the browser that has the extension:\n  ' +
        connectUrl,
    )
  }

  const args: string[] = []
  if (opts.profileDirectory)
    args.push(`--profile-directory=${opts.profileDirectory}`)
  args.push(connectUrl)

  // Detached: the tab outlives this call, and the agent must not hold a handle
  // on the user's browser.
  const child = spawn(executable, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.unref()
}
