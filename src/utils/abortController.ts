import { setMaxListeners } from 'events'

const DEFAULT_MAX_LISTENERS = 50

/** AbortController with a higher listener limit (many tools may attach). */
export function createAbortController(
  maxListeners: number = DEFAULT_MAX_LISTENERS,
): AbortController {
  const controller = new AbortController()
  setMaxListeners(maxListeners, controller.signal)
  return controller
}

/**
 * Child AbortController that aborts when `parent` aborts.
 * Aborting the child does NOT abort the parent (CC createChildAbortController).
 */
export function createChildAbortController(
  parent: AbortController | AbortSignal,
  maxListeners?: number,
): AbortController {
  const parentSignal = 'signal' in parent ? parent.signal : parent
  const child = createAbortController(maxListeners)

  if (parentSignal.aborted) {
    child.abort(parentSignal.reason)
    return child
  }

  const onParentAbort = () => child.abort(parentSignal.reason)
  parentSignal.addEventListener('abort', onParentAbort, { once: true })
  child.signal.addEventListener(
    'abort',
    () => parentSignal.removeEventListener('abort', onParentAbort),
    { once: true },
  )

  return child
}
