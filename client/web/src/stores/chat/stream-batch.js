/**
 * Coalesce high-frequency stream deltas into one React update per frame.
 * Tool / control events should call flushNow() first so order stays correct.
 */

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
