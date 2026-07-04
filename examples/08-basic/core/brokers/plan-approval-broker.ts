/**
 * Process-wide rendezvous for ExitPlanMode approval — mirrors question-broker.ts.
 * The tool blocks until the client POSTs /plan/approve.
 */

export interface PlanApprovalResult {
  approved: boolean
  targetMode?: 'agent' | 'ask'
  editedPlan?: string
  reason?: string
}

interface PendingApproval {
  id: string
  resolve: (result: PlanApprovalResult) => void
  timer: NodeJS.Timeout
}

const pending = new Map<string, PendingApproval>()

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000

export function registerPlanApproval(
  id: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<PlanApprovalResult> {
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      pending.delete(id)
      resolve({ approved: false, reason: 'timeout' })
    }, timeoutMs)

    pending.set(id, { id, resolve, timer })
  })
}

export function answerPlanApproval(
  id: string,
  result: PlanApprovalResult,
): boolean {
  const entry = pending.get(id)
  if (!entry) return false
  clearTimeout(entry.timer)
  pending.delete(id)
  entry.resolve(result)
  return true
}

export function listPendingPlanApprovalIds(): string[] {
  return [...pending.keys()]
}
