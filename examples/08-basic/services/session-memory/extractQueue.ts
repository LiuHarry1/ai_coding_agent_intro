/**
 * Per-session extract queue (CC `sequential` + latest-wins coalesce).
 *
 * - Only one extract runs per sessionId at a time.
 * - Auto extracts: at most one pending; newer replaces older (`coalesced`).
 * - Manual `/summary` (force): FIFO queue, never dropped.
 */

export type ExtractQueueResult = {
  ok: boolean
  error?: string
  memoryPath?: string
}

type QueueItem<TArgs> = {
  args: TArgs
  run: (args: TArgs) => Promise<ExtractQueueResult>
  resolve: (value: ExtractQueueResult) => void
  reject: (reason?: unknown) => void
}

type SessionQueue<TArgs> = {
  /** Manual `/summary` — FIFO, never coalesced. */
  force: QueueItem<TArgs>[]
  /** Latest auto extract waiting behind the current run (or idle). */
  pendingAuto: QueueItem<TArgs> | null
  busy: boolean
}

const queues = new Map<string, SessionQueue<unknown>>()

function getQueue<TArgs>(sessionId: string): SessionQueue<TArgs> {
  let q = queues.get(sessionId) as SessionQueue<TArgs> | undefined
  if (!q) {
    q = { force: [], pendingAuto: null, busy: false }
    queues.set(sessionId, q as SessionQueue<unknown>)
  }
  return q
}

/**
 * Enqueue an extract. Non-force: latest-wins on the pending slot.
 * Force: append to FIFO (never superseded).
 */
export function enqueueSessionExtract<TArgs extends { sessionId: string }>(
  args: TArgs,
  isForce: boolean,
  run: (args: TArgs) => Promise<ExtractQueueResult>,
): Promise<ExtractQueueResult> {
  const sessionId = args.sessionId
  const q = getQueue<TArgs>(sessionId)

  return new Promise((resolve, reject) => {
    const item: QueueItem<TArgs> = { args, run, resolve, reject }

    if (isForce) {
      q.force.push(item)
    } else if (q.pendingAuto) {
      q.pendingAuto.resolve({ ok: false, error: 'coalesced' })
      console.log(
        `[session-memory] coalesce pending extract session=${sessionId}`,
      )
      q.pendingAuto = item
    } else {
      q.pendingAuto = item
    }

    void drain(sessionId)
  })
}

function takeNext<TArgs>(q: SessionQueue<TArgs>): QueueItem<TArgs> | null {
  if (q.force.length > 0) return q.force.shift() ?? null
  if (q.pendingAuto) {
    const item = q.pendingAuto
    q.pendingAuto = null
    return item
  }
  return null
}

async function drain(sessionId: string): Promise<void> {
  const q = getQueue(sessionId)
  if (q.busy) return
  q.busy = true

  try {
    for (;;) {
      const item = takeNext(q)
      if (!item) break
      try {
        item.resolve(await item.run(item.args))
      } catch (err) {
        item.reject(err)
      }
    }
  } finally {
    q.busy = false
    if (q.force.length > 0 || q.pendingAuto) {
      void drain(sessionId)
    }
  }
}

/** Test helper: drop all queued work (does not abort an in-flight run). */
export function resetExtractQueues(): void {
  queues.clear()
}
