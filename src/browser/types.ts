/**
 * The one contract the tool layer is allowed to see.
 *
 * Two backends implement it: a Chrome we launch ourselves (phase 1) and a
 * loopback relay fronting the user's signed-in Chrome via a MV3 extension
 * (phase 2). Both speak raw CDP. The Playwright layer (`src/browser/playwright/`)
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
  /** Active tab in the user's current window before an agent operation. */
  getActiveUserTabId(): Promise<string | null>
  /** L1 activates the tab only; L2 also focuses the window. */
  focusTab(targetId: string, level: 'tab' | 'window'): Promise<void>
  /** Switch back to a tab the user had open (tab level only). */
  restoreTab(targetId: string): Promise<void>
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

/** What a snapshot costs the model, and whether it had to be cut. */
export interface SnapshotResult {
  url: string
  title: string
  text: string
  /** Ref-bearing nodes that survived the budget. */
  nodes: number
  truncated: boolean
}

export type SnapshotMode = 'efficient' | 'full'

export interface SnapshotOpts {
  /** Cap on ref-bearing nodes. Bounds the tree the way the model counts it. */
  maxNodes?: number
  maxChars?: number
  /** CSS selector; snapshot this subtree instead of the whole page. */
  selector?: string
  /** Clip tree depth, for a cheaper post-action look at the page. */
  compact?: boolean
  /** Explicit depth override (efficient default is EFFICIENT_DEPTH). */
  depth?: number
  /** Only keep ref-bearing nodes (and their ancestors). Cheaper for driving actions. */
  interactive?: boolean
  /** Capture an in-page Error/Yes-No modal only — never walk the full tree. */
  dialogOnly?: boolean
  /** Append discovered link hrefs. */
  urls?: boolean
  /** efficient = controls tier; full = wider tree. */
  mode?: SnapshotMode
}

/**
 * An element the way the tool layer talks about it. Deliberately not geometry:
 * Playwright locators do their own hit-testing, so coordinates would be a
 * number nobody acts on.
 */
export interface ResolvedElement {
  ref: string
  role: string
  name: string
  /** Lowercase tag; the one structural fact form filling still branches on. */
  tag: string
  /** What the control holds after a write, when readable. */
  value?: string
  /** Set when the control rejects input, so a no-op write is not a success. */
  readOnly?: boolean
  disabled?: boolean
}

export type FormFieldKind = 'textbox' | 'checkbox' | 'radio' | 'combobox'

export interface FormField {
  ref: string
  /** For a checkbox or radio, "true"/"false"; otherwise the text or option label. */
  value: string
  /** Inferred from the element's role when omitted. */
  kind?: FormFieldKind
}

export interface FilledField {
  ref: string
  role: string
  name: string
  /** What the control holds afterwards, when readable. */
  value?: string
  status: 'filled' | 'skipped' | 'failed'
  reason?: string
}

export interface ConsoleEntry {
  level: string
  text: string
  at: number
}

export interface NetworkEntry {
  id: number
  /** Which API the page used. Only these two are observable without CDP events. */
  kind: 'fetch' | 'xhr'
  method: string
  url: string
  /** 0 while pending, or when the request never reached a server. */
  status: number
  statusText: string
  ok: boolean
  pending: boolean
  /** True when the request never got a response at all (DNS, offline, CORS, abort). */
  failed: boolean
  error: string
  startedAt: number
  durationMs: number
}

export interface BrowserConfig {
  /**
   * When false (default), the default coding agent has no browser_* tools.
   * Set true to restore deferred browser tools on non-browser profiles (CC-style opt-in).
   * The `browser` primary agent always has browser tools regardless of this flag.
   */
  enabled?: boolean
  /**
   * Which browser the tools drive.
   *   isolated  — a Chrome the agent launches, with its own profile (default)
   *   extension — the user's own Chrome via the paired MV3 extension, so pages
   *               load with their real logged-in sessions
   */
  mode?: 'isolated' | 'extension'
  /** Loopback port the extension connects back on. Default 8766. */
  relayPort?: number
  /**
   * Isolated Chrome userDataDir.
   *   fresh   — temp dir, deleted when this chat's browser closes (default)
   *   persist — keep cookies under the agent home, per chat session
   */
  profile?: 'fresh' | 'persist'
  /** Run without a visible window. Default false so the user can watch. */
  headless?: boolean
  /** Chrome channel for the isolated backend. Default `chrome` (system install). */
  channel?: string
  viewportWidth?: number
  viewportHeight?: number
  /** Idle minutes before the browser is torn down. Default 30. */
  idleTimeoutMinutes?: number
  /**
   * Extension mode: after click/type, switch back to the tab the user had open.
   * Default false — the agent does not bounce your tab strip after each action.
   */
  restoreTabAfterInput?: boolean
  /**
   * Extension mode: how long to wait on a slow background load before L1 tab
   * focus during reads. Reserved for future tuning; reads stay L0 (background).
   */
  readBoostTimeoutMs?: number
}
