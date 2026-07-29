/**
 * Per-session / per-memdir extract queue (sequential + latest-wins).
 *
 * - Only one extract runs per lockKey at a time.
 * - Auto extracts: at most one pending; newer replaces older (`coalesced`).
 * - Force (manual): FIFO queue, never dropped.
 */

export type ExtractQueueResult = {
  ok: boolean
  error?: string
  memoryPath?: string
  written?: number
}

type QueueItem<TArgs> = {
  args: TArgs
  run: (args: TArgs) => Promise<ExtractQueueResult>
  resolve: (value: ExtractQueueResult) => void
  reject: (reason?: unknown) => void
}

type KeyedQueue<TArgs> = {
  force: QueueItem<TArgs>[]
  pendingAuto: QueueItem<TArgs> | null
  busy: boolean
}

const queues = new Map<string, KeyedQueue<unknown>>()

function getQueue<TArgs>(lockKey: string): KeyedQueue<TArgs> {
  let q = queues.get(lockKey) as KeyedQueue<TArgs> | undefined
  if (!q) {
    q = { force: [], pendingAuto: null, busy: false }
    queues.set(lockKey, q as KeyedQueue<unknown>)
  }
  return q
}

/**
 * Enqueue an extract under an arbitrary lock key (sessionId or memdir path).
 */
export function enqueueKeyedExtract<TArgs>(
  lockKey: string,
  args: TArgs,
  isForce: boolean,
  run: (args: TArgs) => Promise<ExtractQueueResult>,
  logLabel = 'extract-queue',
): Promise<ExtractQueueResult> {
  const q = getQueue<TArgs>(lockKey)

  return new Promise((resolve, reject) => {
    const item: QueueItem<TArgs> = { args, run, resolve, reject }

    if (isForce) {
      q.force.push(item)
    } else if (q.pendingAuto) {
      q.pendingAuto.resolve({ ok: false, error: 'coalesced' })
      console.log(`[${logLabel}] coalesce pending extract key=${lockKey}`)
      q.pendingAuto = item
    } else {
      q.pendingAuto = item
    }

    void drain(lockKey, logLabel)
  })
}

function takeNext<TArgs>(q: KeyedQueue<TArgs>): QueueItem<TArgs> | null {
  if (q.force.length > 0) return q.force.shift() ?? null
  if (q.pendingAuto) {
    const item = q.pendingAuto
    q.pendingAuto = null
    return item
  }
  return null
}

async function drain(lockKey: string, logLabel: string): Promise<void> {
  const q = getQueue(lockKey)
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
      void drain(lockKey, logLabel)
    }
  }
}

/** Test helper: drop all queued work (does not abort an in-flight run). */
export function resetExtractQueues(): void {
  queues.clear()
}

/**
 * Session-memory wrapper — lock key = sessionId.
 */
export function enqueueSessionExtract<TArgs extends { sessionId: string }>(
  args: TArgs,
  isForce: boolean,
  run: (args: TArgs) => Promise<ExtractQueueResult>,
): Promise<ExtractQueueResult> {
  return enqueueKeyedExtract(
    args.sessionId,
    args,
    isForce,
    run,
    'session-memory',
  )
}
