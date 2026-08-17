/**
 * The one contract the tool layer is allowed to see.
 *
 * Two backends implement it: a Chrome we launch ourselves (phase 1) and a
 * loopback relay fronting the user's signed-in Chrome via a MV3 extension
 * (phase 2). Both speak raw CDP. The Playwright engine (`src/browser/pw/`)
 * sits beside this contract: isolated reuses the Page objects it already
 * owns, extension reaches them via connectOverCDP against a synthetic
 * browser target the relay exposes.
 */

export interface BrowserTab {
  /** CDP target id. The only tab handle that crosses this boundary. */
  targetId: string
  url: string
  title: string
}

export interface BrowserBackend {
  readonly kind: 'isolated' | 'extension'
  listTabs(): Promise<BrowserTab[]>
  createTab(url?: string): Promise<BrowserTab>
  closeTab(targetId: string): Promise<void>
  /** Send a CDP command scoped to one page target. */
  send<T = unknown>(
    targetId: string,
    method: string,
    params?: Record<string, unknown>,
  ): Promise<T>
  dispose(): Promise<void>
}

export class BrowserError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BrowserError'
  }
}

/** Thrown when a ref no longer points at what the model expected. */
export class StaleRefError extends BrowserError {
  constructor(message: string) {
    super(message)
    this.name = 'StaleRefError'
  }
}

export interface BrowserConfig {
  /**
   * Which browser the tools drive.
   *   isolated  — a Chrome the agent launches, with its own profile (default)
   *   extension — the user's own Chrome via the paired MV3 extension, so pages
   *               load with their real logged-in sessions
   */
  mode?: 'isolated' | 'extension'
  /**
   * Snapshot and interaction engine.
   *   playwright  — OpenClaw-style `ariaSnapshot({ mode: 'ai' })` + `aria-ref` locators
   *   cdp         — injected accessibility distiller + CDP mouse/key events
   * Default `playwright`. `cdp` remains for the old distiller path and tests.
   */
  engine?: 'cdp' | 'playwright'
  /** Loopback port the extension connects back on. Default 8766. */
  relayPort?: number
  /** Run without a visible window. Default true so automation never steals focus. */
  headless?: boolean
  /** Chrome channel for the isolated backend. Default `chrome` (system install). */
  channel?: string
  viewportWidth?: number
  viewportHeight?: number
  /** Idle minutes before the browser is torn down. Default 30. */
  idleTimeoutMinutes?: number
}
