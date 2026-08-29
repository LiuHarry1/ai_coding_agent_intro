/**
 * Thinking / reasoning transcript mutators.
 * @param {Function} set
 */
import { newId } from '../../lib/utils.js'

export function createReasoningMutators(set) {
  return {
    _setThinking: () => {
      set(s => {
        const msgs = [...s.messages]
        const last = msgs[msgs.length - 1]
        if (last?.type !== 'assistant') return { messages: msgs }

        const parts = last.parts.filter(p => p.type !== 'thinking')
        parts.push({ type: 'thinking' })
        msgs[msgs.length - 1] = { ...last, parts }
        return { messages: msgs }
      })
    },

    _removeThinking: () => {
      set(s => {
        const msgs = [...s.messages]
        const last = msgs[msgs.length - 1]
        if (last?.type !== 'assistant') return s

        const filtered = last.parts.filter(p => p.type !== 'thinking')
        if (filtered.length === last.parts.length) return s
        msgs[msgs.length - 1] = { ...last, parts: filtered }
        return { messages: msgs }
      })
    },

    _replaceThinkingWithReasoning: () => {
      set(s => {
        const msgs = [...s.messages]
        const last = msgs[msgs.length - 1]
        if (last?.type !== 'assistant') return s
        const parts = last.parts.filter(p => p.type !== 'thinking')
        parts.push({
          id: newId(),
          type: 'reasoning',
          content: '',
          status: 'streaming',
          startTime: Date.now(),
        })
        msgs[msgs.length - 1] = { ...last, parts }
        return { messages: msgs }
      })
    },

    _startReasoning: () => {
      set(s => {
        const msgs = [...s.messages]
        const last = msgs[msgs.length - 1]
        if (last?.type !== 'assistant') return s
        const parts = [...last.parts]
        parts.push({
          id: newId(),
          type: 'reasoning',
          content: '',
          status: 'streaming',
          startTime: Date.now(),
        })
        msgs[msgs.length - 1] = { ...last, parts }
        return { messages: msgs }
      })
    },

    _appendReasoningDelta: delta => {
      set(s => {
        const msgs = [...s.messages]
        const last = msgs[msgs.length - 1]
        if (last?.type !== 'assistant') return s

        const parts = [...last.parts]
        const lastPart = parts[parts.length - 1]

        if (lastPart?.type === 'reasoning' && lastPart.status === 'streaming') {
          parts[parts.length - 1] = {
            ...lastPart,
            content: lastPart.content + delta,
          }
        }
        msgs[msgs.length - 1] = { ...last, parts }
        return { messages: msgs }
      })
    },

    _finalizeReasoning: () => {
      set(s => {
        const msgs = [...s.messages]
        const last = msgs[msgs.length - 1]
        if (last?.type !== 'assistant') return s

        const parts = [...last.parts]
        for (let i = parts.length - 1; i >= 0; i--) {
          if (parts[i].type === 'reasoning' && parts[i].status === 'streaming') {
            const elapsed = Math.round((Date.now() - parts[i].startTime) / 1000)
            parts[i] = { ...parts[i], status: 'done', duration: elapsed }
            break
          }
        }
        msgs[msgs.length - 1] = { ...last, parts }
        return { messages: msgs }
      })
    },
  }
}
