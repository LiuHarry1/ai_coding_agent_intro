/**
 * In-process registry of pending filesystem permission prompts
 * (`control_request` subtype `can_use_tool`).
 *
 * Same rendezvous pattern as `question-broker`: the tool loop parks a
 * Promise; HTTP / stdio / ACP resolve it.
 */
export type PermissionAnswer = {
  behavior: 'allow' | 'always' | 'deny'
}

export type RegisterPermissionResult =
  | { answered: true; value: PermissionAnswer }
  | { answered: false; reason: 'timeout' | 'cancelled' }

interface PendingPermission {
  id: string
  resolve: (result: RegisterPermissionResult) => void
  timer: NodeJS.Timeout
  onAbort?: () => void
}

const pending = new Map<string, PendingPermission>()

export function registerPermission(
  id: string,
  timeoutMs: number,
  abortSignal?: AbortSignal,
): Promise<RegisterPermissionResult> {
  return new Promise(resolve => {
    if (abortSignal?.aborted) {
      resolve({ answered: false, reason: 'cancelled' })
      return
    }

    const timer = setTimeout(() => {
      pending.delete(id)
      abortSignal?.removeEventListener('abort', onAbort)
      resolve({ answered: false, reason: 'timeout' })
    }, timeoutMs)

    const onAbort = () => {
      const p = pending.get(id)
      if (!p) return
      clearTimeout(p.timer)
      pending.delete(id)
      abortSignal?.removeEventListener('abort', onAbort)
      p.resolve({ answered: false, reason: 'cancelled' })
    }

    if (abortSignal) {
      abortSignal.addEventListener('abort', onAbort, { once: true })
    }

    pending.set(id, {
      id,
      resolve: value => {
        clearTimeout(timer)
        pending.delete(id)
        abortSignal?.removeEventListener('abort', onAbort)
        resolve(value)
      },
      timer,
      onAbort,
    })
  })
}

export function answerPermission(
  id: string,
  value: PermissionAnswer,
): boolean {
  const p = pending.get(id)
  if (!p) return false
  p.resolve({ answered: true, value })
  return true
}

export function rejectPermission(id: string): boolean {
  const p = pending.get(id)
  if (!p) return false
  p.resolve({ answered: false, reason: 'cancelled' })
  return true
}

export function listPendingPermissionIds(): string[] {
  return [...pending.keys()]
}
