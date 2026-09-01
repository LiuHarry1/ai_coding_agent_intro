/**
 * Thinking / reasoning transcript mutators (bubble store).
 * @param {Function} set
 * @param {Function} get
 */
import { newId } from '../../lib/utils.js'
import {
  appendBubble,
  patchBubble,
  removeBubble,
  thinkingBubbleId,
  reasoningBubbleId,
} from '../../lib/bubbles/messages-to-bubbles.js'

function requireTurn(s) {
  const turnId = s.activeTurnId
  if (!turnId) return null
  return turnId
}

export function createReasoningMutators(set, get) {
  return {
    _setThinking: () => {
      set(s => {
        const turnId = requireTurn(s)
        if (!turnId) return s
        const id = thinkingBubbleId(turnId)
        // Drop existing thinking then append (unique placeholder).
        let next = removeBubble(s, id)
        next = appendBubble(next, { id, kind: 'thinking', turnId })
        return {
          bubbleOrder: next.bubbleOrder,
          bubblesById: next.bubblesById,
        }
      })
    },

    _removeThinking: () => {
      set(s => {
        const turnId = requireTurn(s)
        if (!turnId) return s
        const id = thinkingBubbleId(turnId)
        if (!s.bubblesById[id]) return s
        const next = removeBubble(s, id)
        return {
          bubbleOrder: next.bubbleOrder,
          bubblesById: next.bubblesById,
        }
      })
    },

    _replaceThinkingWithReasoning: () => {
      set(s => {
        const turnId = requireTurn(s)
        if (!turnId) return s
        const tid = thinkingBubbleId(turnId)
        let next = removeBubble(s, tid)
        const rid = newId()
        next = appendBubble(next, {
          id: reasoningBubbleId(rid),
          kind: 'reasoning',
          turnId,
          reasoningId: rid,
          content: '',
          status: 'streaming',
          startTime: Date.now(),
        })
        return {
          bubbleOrder: next.bubbleOrder,
          bubblesById: next.bubblesById,
        }
      })
    },

    _startReasoning: () => {
      set(s => {
        const turnId = requireTurn(s)
        if (!turnId) return s
        const rid = newId()
        const next = appendBubble(s, {
          id: reasoningBubbleId(rid),
          kind: 'reasoning',
          turnId,
          reasoningId: rid,
          content: '',
          status: 'streaming',
          startTime: Date.now(),
        })
        return {
          bubbleOrder: next.bubbleOrder,
          bubblesById: next.bubblesById,
        }
      })
    },

    _appendReasoningDelta: delta => {
      set(s => {
        const turnId = requireTurn(s)
        if (!turnId || !delta) return s
        // Find last streaming reasoning for this turn
        for (let i = s.bubbleOrder.length - 1; i >= 0; i--) {
          const b = s.bubblesById[s.bubbleOrder[i]]
          if (
            b?.kind === 'reasoning' &&
            b.turnId === turnId &&
            b.status === 'streaming'
          ) {
            return patchBubble(s, b.id, {
              content: (b.content || '') + delta,
            })
          }
        }
        return s
      })
    },

    _finalizeReasoning: () => {
      set(s => {
        const turnId = requireTurn(s)
        if (!turnId) return s
        for (let i = s.bubbleOrder.length - 1; i >= 0; i--) {
          const b = s.bubblesById[s.bubbleOrder[i]]
          if (
            b?.kind === 'reasoning' &&
            b.turnId === turnId &&
            b.status === 'streaming'
          ) {
            const elapsed = Math.round((Date.now() - (b.startTime || Date.now())) / 1000)
            return patchBubble(s, b.id, { status: 'done', duration: elapsed })
          }
        }
        return s
      })
    },
  }
}
