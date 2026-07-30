import type {
  PermissionDecision,
} from './runtime-protocol.js'

export type PermissionAsk = {
  requestId: string
  sessionId: string
  tool: string
  input: unknown
  description?: string
  resolve: (decision: PermissionDecision) => void
}

/**
 * Bridges Runtime control_request ↔ user decisions (UI / API).
 */
export class PermissionGateway {
  private pending = new Map<string, PermissionAsk>()

  ask(params: Omit<PermissionAsk, 'resolve'>): Promise<PermissionDecision> {
    return new Promise(resolve => {
      this.pending.set(params.requestId, { ...params, resolve })
    })
  }

  respond(requestId: string, decision: PermissionDecision): boolean {
    const p = this.pending.get(requestId)
    if (!p) return false
    this.pending.delete(requestId)
    p.resolve(decision)
    return true
  }

  listPending(sessionId?: string): Omit<PermissionAsk, 'resolve'>[] {
    return [...this.pending.values()]
      .filter(p => !sessionId || p.sessionId === sessionId)
      .map(({ resolve: _r, ...rest }) => rest)
  }

  cancelSession(sessionId: string): void {
    for (const [id, p] of this.pending) {
      if (p.sessionId === sessionId) {
        this.pending.delete(id)
        p.resolve({ behavior: 'deny', message: 'Session cancelled' })
      }
    }
  }
}
