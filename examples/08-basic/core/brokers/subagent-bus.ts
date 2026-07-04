import type { EventHandler, IEventBus } from '../types.js'

/**
 * Scoped event bus for a single subagent invocation. Every emitted payload
 * includes `parentToolCallId` so the frontend can route nested tool events
 * to the correct SubagentCard when multiple subagents run in one turn.
 */
export function createSubagentEventBus(
  parent: IEventBus,
  parentToolCallId: string,
  scopeLabel: string,
): IEventBus {
  const scoped = parent.scoped(scopeLabel)

  const withParent = (data?: unknown): Record<string, unknown> => {
    if (data != null && typeof data === 'object' && !Array.isArray(data)) {
      return { ...(data as Record<string, unknown>), parentToolCallId }
    }
    if (data === undefined) return { parentToolCallId }
    return { parentToolCallId, value: data }
  }

  return {
    emit(event: string, data?: unknown) {
      scoped.emit(event, withParent(data))
    },
    on(event: string, handler: EventHandler) {
      return scoped.on(event, handler)
    },
    off(event: string, handler: EventHandler) {
      scoped.off(event, handler)
    },
    scoped(childPrefix: string) {
      return createSubagentEventBus(
        parent,
        parentToolCallId,
        `${scopeLabel}_${childPrefix}`,
      )
    },
    removeAllListeners() {
      scoped.removeAllListeners()
    },
  }
}
