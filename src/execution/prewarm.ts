/**
 * Worker prewarm — CC `prewarmModifiers()` shape: guarded, fire-and-forget,
 * swallows its own errors, never blocks the caller.
 *
 * Spawning the Worker Runtime on the first `/chat` puts a process launch on
 * the critical path of the user's first message. `RuntimeBroker` keys runtimes
 * by `environmentId::cwd`, so a runtime opened here is reused verbatim by the
 * first turn — as long as we prewarm the cwd that turn will actually use.
 */
import { getExecutionPlane } from './bootstrap.js'
import type { WorkspaceHandle } from './types.js'

const inFlight = new Set<string>()

function handleKey(handle: WorkspaceHandle): string {
  return `${handle.environmentId}::${handle.cwd}`
}

/**
 * Open the Worker Runtime for `handle` in the background.
 * Repeated calls for the same workspace are collapsed.
 */
export function prewarmRuntime(handle: WorkspaceHandle): void {
  const key = handleKey(handle)
  if (inFlight.has(key)) return
  inFlight.add(key)

  void (async () => {
    const started = Date.now()
    try {
      const plane = getExecutionPlane()
      await plane.runtimes.getOrCreate(handle, 'prewarm')
      console.log(
        `[execution] prewarmed worker for ${key} in ${Date.now() - started}ms`,
      )
    } catch (err) {
      console.warn(
        `[execution] worker prewarm failed for ${key}: ` +
          `${err instanceof Error ? err.message : err}`,
      )
    } finally {
      inFlight.delete(key)
    }
  })()
}

/** Prewarm the local Worker Runtime for `cwd`. */
export function prewarmLocalRuntime(cwd: string): void {
  prewarmRuntime({ environmentId: 'local', cwd })
}
