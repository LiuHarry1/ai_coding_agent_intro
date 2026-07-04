/**
 * In-process registry of pending user questions raised by the
 * `ask_user_question` tool.
 *
 * The tool's `execute()` runs inside the per-request agent loop, but the
 * user's answer arrives via a separate HTTP request to the server router.
 * Those two contexts cannot share the per-request EventBus (it dies with
 * the request), so this module provides a process-wide rendezvous:
 * `registerQuestion` parks a Promise keyed by id; `answerQuestion`
 * resolves it from the HTTP handler.
 *
 * Answer shape: a `{ question: string -> answer: string }` map
 * (multi-select answers are comma-separated by the client), plus optional
 * per-question annotations (preview/notes).
 */

export interface QuestionAnnotation {
  preview?: string
  notes?: string
}

export interface QuestionAnswer {
  answers: Record<string, string>
  annotations?: Record<string, QuestionAnnotation>
}

interface PendingQuestion {
  id: string
  resolve: (answer: QuestionAnswer) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
}

const pending = new Map<string, PendingQuestion>()

export type RegisterResult =
  | { answered: true; value: QuestionAnswer }
  | { answered: false; reason: 'timeout' | 'cancelled' }

export function registerQuestion(
  id: string,
  timeoutMs: number,
): Promise<RegisterResult> {
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      pending.delete(id)
      resolve({ answered: false, reason: 'timeout' })
    }, timeoutMs)

    pending.set(id, {
      id,
      resolve: value => {
        clearTimeout(timer)
        pending.delete(id)
        resolve({ answered: true, value })
      },
      reject: () => {
        clearTimeout(timer)
        pending.delete(id)
        resolve({ answered: false, reason: 'cancelled' })
      },
      timer,
    })
  })
}

export function answerQuestion(id: string, value: QuestionAnswer): boolean {
  const q = pending.get(id)
  if (!q) return false
  q.resolve(value)
  return true
}

export function rejectQuestion(id: string, err: Error): boolean {
  const q = pending.get(id)
  if (!q) return false
  q.reject(err)
  return true
}

export function listPendingQuestionIds(): string[] {
  return [...pending.keys()]
}
