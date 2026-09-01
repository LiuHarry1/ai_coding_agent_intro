/**
 * Coalesce high-frequency stream deltas / tool mutations into fewer React updates.
 *
 * Text/reasoning: one flush per animation frame.
 * Tools: OpenClaw-style ~80ms throttle — mutate a composed updater, notify once.
 */

/** @typedef {(s: object) => object} StateUpdater */

/**
 * @param {{ flush: (bufs: { text: string, reasoning: string }) => void }} opts
 */
export function createStreamBatcher({ flush }) {
  let textBuf = ''
  let reasoningBuf = ''
  let raf = 0

  const runFlush = () => {
    const text = textBuf
    const reasoning = reasoningBuf
    textBuf = ''
    reasoningBuf = ''
    if (!text && !reasoning) return
    flush({ text, reasoning })
  }

  const schedule = () => {
    if (raf) return
    raf = requestAnimationFrame(() => {
      raf = 0
      runFlush()
    })
  }

  return {
    appendText(delta) {
      if (!delta) return
      textBuf += delta
      schedule()
    },
    appendReasoning(delta) {
      if (!delta) return
      reasoningBuf += delta
      schedule()
    },
    /** Sync flush — cancel pending rAF and push buffers now. */
    flushNow() {
      if (raf) {
        cancelAnimationFrame(raf)
        raf = 0
      }
      runFlush()
    },
  }
}

/** OpenClaw Control UI tool-stream sync interval. */
export const TOOL_STREAM_THROTTLE_MS = 80

/**
 * Compose Zustand updaters and notify at most once per throttle window.
 * `peek()` applies the pending updater on top of `get()` so later tool
 * ops in the same window still see prior cards (callId match, etc.).
 *
 * @param {Function} set
 * @param {Function} get
 * @param {number} [ms]
 */
export function createThrottledSet(set, get, ms = TOOL_STREAM_THROTTLE_MS) {
  /** @type {StateUpdater | null} */
  let queued = null
  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null

  const merge = (base, patch) => {
    if (!patch || patch === base) return base
    return { ...base, ...patch }
  }

  const compose =
    (a, b) =>
    s => {
      const mid = merge(s, a(s))
      return merge(mid, b(mid))
    }

  const flush = () => {
    if (timer != null) {
      clearTimeout(timer)
      timer = null
    }
    const u = queued
    queued = null
    if (u) set(u)
  }

  return {
    /** @param {StateUpdater} updater */
    schedule(updater) {
      queued = queued ? compose(queued, updater) : updater
      if (timer != null) return
      timer = setTimeout(() => {
        timer = null
        const u = queued
        queued = null
        if (u) set(u)
      }, ms)
    },
    flushNow: flush,
    /** Store view including unflushed tool patches. */
    peek() {
      const s = get()
      if (!queued) return s
      return merge(s, queued(s))
    },
    get pending() {
      return queued != null
    },
  }
}
