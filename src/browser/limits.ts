/**
 * Every bound the browser tools wait on or spend, in one place.
 *
 * These were scattered across the Playwright ops and the tool layer, which hid
 * the two relationships that matter:
 *
 * - the per-call budget has to exceed the action plus the observation after it,
 *   or a click that landed gets reported as a failure and the model retries it;
 * - a post-action look at the page is cheaper than one the model asked for, so
 *   routine actions do not spend an explicit snapshot's worth of context.
 */

/** No browser call should outlive a stuck page; the model needs its turn back. */
export const CALL_TIMEOUT_MS = 60_000

/**
 * The observation is bounded on its own, well under CALL_TIMEOUT_MS, so a slow
 * tree cannot turn an action that already succeeded into an error.
 */
export const POST_ACTION_SNAPSHOT_MS = 15_000

/** Snapshot attached to an error path — best effort, so it fails fast. */
export const ERROR_SNAPSHOT_TIMEOUT_MS = 8_000

export const ACTION_TIMEOUT_MS = 8_000
export const SNAPSHOT_TIMEOUT_MS = 8_000

/** Playwright MCP waits ~500ms after an action so late XHR/DOM can land. */
export const ACTION_SETTLE_MS = 500
export const NETWORK_DRAIN_MS = 3_000

export const WAIT_FOR_TIMEOUT_MS = 15_000
export const WAIT_FOR_TIME_CAP_S = 10

export const NAVIGATE_TIMEOUT_MS = 30_000
/** SPAs paint chrome before the main tree; give widgets a beat to mount. */
export const NAVIGATE_SETTLE_MS = 800

/** Ref-bearing nodes in a snapshot the model asked for. */
export const DEFAULT_MAX_NODES = 1500
/** Ref-bearing nodes in the look at the page that follows an action. */
export const POST_ACTION_MAX_NODES = 800
export const DEFAULT_MAX_CHARS = 20_000

/**
 * Depth clip for `compact`. Playwright's AI snapshot already omits most
 * structural wrappers, so what is left to cut on a routine action is depth.
 */
export const COMPACT_DEPTH = 16

/** Screenshots compete with the snapshot for context; cap them hard. */
export const SCREENSHOT_TOKEN_BUDGET = 1500
