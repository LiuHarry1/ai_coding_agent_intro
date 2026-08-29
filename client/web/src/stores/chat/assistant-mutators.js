/**
 * Assistant transcript mutators (Zustand set/get closures).
 * Pure-ish message/part updates — no HTTP. IDE FS notifies go through ide-bridge.
 *
 * Split helpers:
 *   find-tool-call.js · reasoning-mutators.js
 */
import { newId } from '../../lib/utils.js'
import { agentApi } from '../../lib/api/agent.js'
import { notifyIdeFilesystemFromTool } from './ide-bridge.js'
import { createStreamBatcher } from './stream-batch.js'
import { findToolCallInAssistant } from './find-tool-call.js'
import { createReasoningMutators } from './reasoning-mutators.js'

export { findToolCallInAssistant } from './find-tool-call.js'

/**
 * @param {Function} set
 * @param {Function} get
 */
export function createAssistantMutators(set, get) {
  const mutators = {
  ...createReasoningMutators(set),

  /** Drop Thinking... and append a tool_call in one update (no fold remount gap). */
  _beginToolCall: part => {
    set(s => {
      const msgs = [...s.messages]
      const last = msgs[msgs.length - 1]
      if (last?.type !== 'assistant') return s
      const parts = last.parts.filter(p => p.type !== 'thinking')
      // Dedup: a repeated tool_input_start for the same id must not leave a
      // second card spinning after tool_result only updates one of them.
      if (part.toolCallId) {
        const idx = parts.findIndex(
          p => p.type === 'tool_call' && p.toolCallId === part.toolCallId,
        )
        if (idx >= 0) {
          const existing = parts[idx]
          if (existing.status === 'done') {
            msgs[msgs.length - 1] = { ...last, parts }
            return { messages: msgs }
          }
          parts[idx] = { ...existing, ...part }
          msgs[msgs.length - 1] = { ...last, parts }
          return { messages: msgs }
        }
      }
      parts.push(part)
      msgs[msgs.length - 1] = { ...last, parts }
      return { messages: msgs }
    })
  },

  _updateTodos: todos => {
    set(s => {
      const msgs = [...s.messages]
      const last = msgs[msgs.length - 1]
      if (last?.type !== 'assistant') return { todos }

      const parts = [...last.parts]
      let existingIdx = -1
      for (let i = parts.length - 1; i >= 0; i--) {
        if (parts[i].type === 'todo_list') {
          existingIdx = i
          break
        }
      }
      if (existingIdx >= 0) {
        parts[existingIdx] = { ...parts[existingIdx], todos }
      } else {
        parts.push({ type: 'todo_list', todos })
      }
      msgs[msgs.length - 1] = { ...last, parts }
      return { todos, messages: msgs }
    })
  },

  _appendPart: part => {
    set(s => {
      const msgs = [...s.messages]
      const last = msgs[msgs.length - 1]
      if (last?.type === 'assistant') {
        msgs[msgs.length - 1] = { ...last, parts: [...last.parts, part] }
      }
      return { messages: msgs }
    })
  },

  /**
   * Settle the in-progress compaction row when compaction_done arrives.
   * ok/error → the running `compaction_start` part becomes a settled
   * `compaction_done` part (instant feedback, before any refetch).
   * noop → the row is dropped entirely; nothing happened worth showing.
   *
   * The settled part is only a transitional frame: after the transcript
   * refetch the canonical `compact_boundary` message replaces it.
   */
  _resolveCompactionPart: status => {
    set(s => {
      const msgs = [...s.messages]
      const last = msgs[msgs.length - 1]
      if (last?.type !== 'assistant') return s

      let parts
      if (status === 'noop') {
        parts = last.parts.filter(p => p.type !== 'compaction_start')
      } else {
        parts = [...last.parts]
        for (let i = parts.length - 1; i >= 0; i--) {
          if (parts[i].type === 'compaction_start') {
            parts[i] = { type: 'compaction_done', status }
            break
          }
        }
      }
      msgs[msgs.length - 1] = { ...last, parts }
      return { messages: msgs }
    })
  },

  /**
   * Full compact updates agent memory but JSONL keeps the complete transcript.
   * Refetch from the server instead of truncating local UI.
   */
  _refetchTranscriptAfterCompaction: async () => {
    const id = get().currentSessionId
    if (!id) return

    const s = get()
    const last = s.messages[s.messages.length - 1]
    let streamingAssistant = null
    if (s.isStreaming && last?.type === 'assistant') {
      // Drop the transitional compaction parts: the refetched transcript
      // carries the canonical compact_boundary marker instead.
      const parts = last.parts.filter(
        p =>
          p.type !== 'compaction_start' &&
          p.type !== 'compaction_done' &&
          p.type !== 'thinking',
      )
      streamingAssistant = { ...last, parts }
    }

    try {
      const data = await agentApi.getSessionMessages(id)
      if (get().currentSessionId !== id) return
      let msgs = data.messages ?? []
      if (streamingAssistant?.status === 'streaming') {
        const tail = msgs[msgs.length - 1]
        if (tail?.type === 'assistant') {
          msgs = msgs.slice(0, -1)
        }
        msgs.push(streamingAssistant)
      }
      if (msgs.length > 0) set({ messages: msgs })
    } catch (err) {
      console.error('[chat] transcript refetch after compact failed', err)
    }
  },

  /** ExitPlanMode — show plan card only when user approval is requested. */
  _appendPlanApprovalPart: data => {
    set(s => {
      const msgs = [...s.messages]
      const last = msgs[msgs.length - 1]
      if (last?.type !== 'assistant') return s

      const parts = last.parts.filter(p => p.type !== 'plan_approval')
      parts.push({
        type: 'plan_approval',
        requestId: data.requestId,
        plan: data.plan ?? '',
        filePath: data.filePath,
        status: 'pending',
      })

      msgs[msgs.length - 1] = { ...last, parts }
      return {
        messages: msgs,
        isAwaitingInteraction: true,
        planState: {
          status: 'awaiting_approval',
          content: data.plan ?? '',
          filePath: data.filePath ?? null,
        },
      }
    })
  },

  /**
   * Append decoded preview text to the in-progress tool_call card. Server
   * extracts the value of the tool's main string field (e.g. write_file's
   * `content`, edit_file's `new_string`) from the partial JSON args and
   * streams it here so the UI can render the file being typed live.
   */
  _appendToolInputPreviewDelta: data => {
    set(s => {
      const msgs = [...s.messages]
      const last = msgs[msgs.length - 1]
      if (last?.type !== 'assistant') return s

      const parts = [...last.parts]
      for (let i = parts.length - 1; i >= 0; i--) {
        const p = parts[i]
        if (
          p.type === 'tool_call' &&
          p.toolCallId === data.toolCallId &&
          p.status !== 'done'
        ) {
          parts[i] = {
            ...p,
            livePreview: (p.livePreview || '') + (data.delta || ''),
          }
          break
        }
      }
      msgs[msgs.length - 1] = { ...last, parts }
      return { messages: msgs }
    })
  },

  /**
   * Bump the live byte counter on the in-progress tool_call card matching
   * `toolCallId`. Used to show "Generating arguments… N chars" while the
   * model is streaming the tool's argument JSON.
   */
  _appendToolInputDelta: data => {
    set(s => {
      const msgs = [...s.messages]
      const last = msgs[msgs.length - 1]
      if (last?.type !== 'assistant') return s

      const parts = [...last.parts]
      for (let i = parts.length - 1; i >= 0; i--) {
        const p = parts[i]
        if (
          p.type === 'tool_call' &&
          p.toolCallId === data.toolCallId &&
          p.status !== 'done'
        ) {
          parts[i] = {
            ...p,
            liveInputBytes: (p.liveInputBytes || 0) + (data.bytes || 0),
          }
          break
        }
      }
      msgs[msgs.length - 1] = { ...last, parts }
      return { messages: msgs }
    })
  },

  /**
   * Upgrade a streaming-input placeholder (created by tool_input_start) into
   * a fully-populated tool_call once the SDK has parsed the complete args,
   * or just append a new card if no placeholder existed (older SDK paths
   * that skip tool-input-* events).
   */
  _upsertToolCall: data => {
    set(s => {
      const msgs = [...s.messages]
      const last = msgs[msgs.length - 1]
      if (last?.type !== 'assistant') return s

      const parts = [...last.parts]
      for (let i = parts.length - 1; i >= 0; i--) {
        const p = parts[i]
        if (p.type === 'tool_call' && p.toolCallId === data.toolCallId) {
          // Never demote a finished card back to running — a late/duplicate
          // tool_call after tool_result left Pause→Resume rows spinning forever.
          if (p.status === 'done') {
            parts[i] = {
              ...p,
              name: data.name ?? p.name,
              args: data.args ?? p.args,
              isSubagent: data.isSubagent === true || p.isSubagent === true,
            }
          } else {
            parts[i] = {
              ...p,
              name: data.name,
              args: data.args,
              status: 'running',
              // Re-affirm isSubagent on the upsert. The placeholder created by
              // tool_input_start already set it, but if the SDK skipped that
              // event (some providers don't emit tool-input-start) and we land
              // here directly, this is the only place the flag gets recorded.
              // Coalesce instead of overwrite: don't lose `true` if the
              // tool_call payload happens to omit the field.
              isSubagent: data.isSubagent === true || p.isSubagent === true,
              liveInputBytes: undefined,
              liveInputStart: undefined,
            }
          }
          msgs[msgs.length - 1] = { ...last, parts }
          return { messages: msgs }
        }
      }
      parts.push({ type: 'tool_call', ...data })
      msgs[msgs.length - 1] = { ...last, parts }
      return { messages: msgs }
    })
  },

  _appendSubagentEvent: ev => {
    set(s => {
      const msgs = [...s.messages]
      const last = msgs[msgs.length - 1]
      if (last?.type !== 'assistant') return s

      const parts = [...last.parts]
      let targetIdx = -1

      // Prefer explicit routing from backend (parallel subagents of same type).
      if (ev.parentToolCallId) {
        targetIdx = parts.findIndex(
          p => p.type === 'tool_call' && p.toolCallId === ev.parentToolCallId,
        )
      }

      if (targetIdx === -1) {
        const runningSubagents = parts
          .map((p, i) => ({ p, i }))
          .filter(
            ({ p }) =>
              p.type === 'tool_call' && p.isSubagent && p.status !== 'done',
          )

        if (runningSubagents.length === 1) {
          targetIdx = runningSubagents[0].i
        } else if (runningSubagents.length > 1) {
          // Serial subagent runs: prefer the card that already has nested
          // steps (active run). Parallel runs require parentToolCallId.
          const active = runningSubagents.filter(
            ({ p }) => (p.subagentParts?.length ?? 0) > 0,
          )
          targetIdx = (active.length === 1 ? active[0] : runningSubagents[0]).i
        }
      }

      if (targetIdx === -1) {
        for (let i = parts.length - 1; i >= 0; i--) {
          if (parts[i].type === 'tool_call' && parts[i].status !== 'done') {
            targetIdx = i
            break
          }
        }
      }
      if (targetIdx === -1) {
        for (let i = parts.length - 1; i >= 0; i--) {
          if (parts[i].type === 'tool_call' && parts[i].isSubagent) {
            targetIdx = i
            break
          }
        }
      }
      if (targetIdx === -1) return s

      const parent = parts[targetIdx]
      const sub = [...(parent.subagentParts || [])]

      if (ev.type === 'step_start') {
        parts[targetIdx] = {
          ...parent,
          liveTask: ev.task || parent.liveTask,
          liveLabel: ev.label || parent.liveLabel,
        }
        msgs[msgs.length - 1] = { ...last, parts }
        return { messages: msgs }
      }

      if (ev.type === 'tool_input_start') {
        const exists = sub.some(s => s.toolCallId === ev.toolCallId)
        if (!exists) {
          sub.push({
            type: 'tool_call',
            name: ev.name,
            args: {},
            toolCallId: ev.toolCallId,
            status: 'streaming-input',
          })
        }
        parts[targetIdx] = { ...parent, subagentParts: sub }
        msgs[msgs.length - 1] = { ...last, parts }
        return { messages: msgs }
      }

      if (ev.type === 'tool_call') {
        const idx = sub.findIndex(s => s.toolCallId === ev.toolCallId)
        if (idx >= 0) {
          sub[idx] = {
            ...sub[idx],
            name: ev.name,
            args: ev.args,
            ...(sub[idx].status === 'done' ? {} : { status: 'running' }),
          }
        } else {
          sub.push({
            type: 'tool_call',
            name: ev.name,
            args: ev.args,
            toolCallId: ev.toolCallId,
            status: 'running',
          })
        }
      } else if (ev.type === 'tool_result') {
        for (let j = sub.length - 1; j >= 0; j--) {
          if (sub[j].toolCallId === ev.toolCallId) {
            sub[j] = {
              ...sub[j],
              result: ev.result,
              ...(ev.toolUseResult !== undefined
                ? { toolUseResult: ev.toolUseResult }
                : {}),
              ...(ev.isError ? { isError: true } : {}),
              status: 'done',
            }
            notifyIdeFilesystemFromTool(sub[j].name, sub[j].args, ev.result)
            break
          }
        }
      }
      // text_delta is accepted for nesting but not rendered as a part yet
      parts[targetIdx] = { ...parent, subagentParts: sub }
      msgs[msgs.length - 1] = { ...last, parts }
      return { messages: msgs }
    })
  },

  _appendTextDelta: delta => {
    set(s => {
      const msgs = [...s.messages]
      const last = msgs[msgs.length - 1]
      if (last?.type !== 'assistant') return { messages: msgs }

      const parts = [...last.parts]
      const lastPart = parts[parts.length - 1]

      if (lastPart?.type === 'text') {
        parts[parts.length - 1] = {
          ...lastPart,
          content: lastPart.content + delta,
        }
      } else {
        parts.push({ type: 'text', content: delta })
      }
      msgs[msgs.length - 1] = { ...last, parts }
      return { messages: msgs }
    })
  },

  _updateToolResult: data => {
    const toolCallId = data.tool_use_id ?? data.toolCallId
    const last = get().messages[get().messages.length - 1]
    const matched = findToolCallInAssistant(last, toolCallId)

    set(s => {
      const msgs = [...s.messages]
      const lastMsg = msgs[msgs.length - 1]
      if (lastMsg?.type !== 'assistant') return { messages: msgs }

      const patch = p => ({
        ...p,
        result: data.result,
        ...(data.toolUseResult !== undefined
          ? { toolUseResult: data.toolUseResult }
          : {}),
        ...(data.isError ? { isError: true } : {}),
        status: 'done',
        endTime: Date.now(),
        stopping: false,
        liveTask: undefined,
      })

      const parts = lastMsg.parts.map(p => {
        if (p.type === 'tool_call' && p.toolCallId === toolCallId) {
          return patch(p)
        }
        if (p.type === 'tool_call' && Array.isArray(p.subagentParts)) {
          let changed = false
          const sub = p.subagentParts.map(sp => {
            if (sp.type === 'tool_call' && sp.toolCallId === toolCallId) {
              changed = true
              return patch(sp)
            }
            return sp
          })
          return changed ? { ...p, subagentParts: sub } : p
        }
        return p
      })
      msgs[msgs.length - 1] = { ...lastMsg, parts }
      return { messages: msgs }
    })

    if (matched) {
      notifyIdeFilesystemFromTool(matched.name, matched.args, data.result)
    }
  },

  /**
   * Attach execute() wall time from middleware.
   * Prefer `tool_use_id` — name-only matching mis-attributes parallel Bash.
   * Timing is emitted from middleware afterTool, which runs BEFORE tool_result
   * is wired — so match by id even while status is still running.
   */
  _updateLastToolTiming: data => {
    const toolCallId = data.tool_use_id ?? data.toolCallId
    set(s => {
      const msgs = [...s.messages]
      const last = msgs[msgs.length - 1]
      if (last?.type !== 'assistant') return { messages: msgs }

      const parts = [...last.parts]
      let target = -1
      if (toolCallId) {
        target = parts.findIndex(
          p => p.type === 'tool_call' && p.toolCallId === toolCallId,
        )
      } else if (data.name) {
        // Legacy (no id): FIFO among same-name cards still missing duration.
        target = parts.findIndex(
          p =>
            p.type === 'tool_call' &&
            p.name === data.name &&
            p.duration == null,
        )
        if (target < 0) {
          for (let i = parts.length - 1; i >= 0; i--) {
            if (parts[i].type === 'tool_call' && parts[i].name === data.name) {
              target = i
              break
            }
          }
        }
      }
      if (target < 0 || typeof data.duration !== 'number') {
        return { messages: msgs }
      }
      parts[target] = { ...parts[target], duration: data.duration }
      msgs[msgs.length - 1] = { ...last, parts }
      return { messages: msgs }
    })
  },

  /**
   * Attach live process output to the last pending bash tool call.
   * Emitted by the bash tool in wait mode — streams output to UI
   * without requiring the LLM to poll.
   */
  _updateProcessOutput: data => {
    set(s => {
      const msgs = [...s.messages]
      const last = msgs[msgs.length - 1]
      if (last?.type !== 'assistant') return { messages: msgs }

      const parts = [...last.parts]
      for (let i = parts.length - 1; i >= 0; i--) {
        const p = parts[i]
        if (
          p.type === 'tool_call' &&
          (p.name === 'Bash' || p.name === 'PowerShell') &&
          p.status !== 'done'
        ) {
          parts[i] = {
            ...p,
            liveOutput: data.output,
            liveElapsed: data.elapsed,
            liveDone: data.done,
          }
          break
        }
      }
      msgs[msgs.length - 1] = { ...last, parts }
      return { messages: msgs }
    })
  },

  _finalizeAssistant: () => {
    set(s => {
      const msgs = [...s.messages]
      const last = msgs[msgs.length - 1]
      if (last?.type === 'assistant') {
        const settle = p => {
          if (p.type !== 'tool_call') return p
          let next = p
          if (Array.isArray(p.subagentParts)) {
            next = {
              ...next,
              subagentParts: p.subagentParts.map(settle),
            }
          }
          if (next.status === 'done') return next
          return {
            ...next,
            status: 'done',
            isError: true,
            result: next.result ?? 'Interrupted by user',
            stopping: false,
            liveTask: undefined,
            endTime: Date.now(),
          }
        }
        const parts = last.parts.map(settle)
        msgs[msgs.length - 1] = { ...last, parts, status: 'done' }
      }
      return { messages: msgs }
    })
  },

  /** CC Esc/Stop — settle the assistant turn and show Interrupted. */
  _onInterrupted: data => {
    get()._finalizeAssistant()
    set(s => {
      const msgs = [...s.messages]
      const last = msgs[msgs.length - 1]
      if (last?.type === 'interrupted') {
        return { isAwaitingInteraction: false }
      }
      msgs.push({
        id: newId(),
        type: 'interrupted',
        toolUse: data?.tool_use === true,
        text: data?.text,
      })
      return { messages: msgs, isAwaitingInteraction: false }
    })
  },
  }

  // Text/reasoning tokens arrive many times per frame — coalesce into one set().
  // Any other mutator flushes first so tool cards / finalize stay ordered.
  const batcher = createStreamBatcher({
    flush: ({ text, reasoning }) => {
      if (reasoning) mutators._appendReasoningDelta(reasoning)
      if (text) mutators._appendTextDelta(text)
    },
  })

  /** @type {typeof mutators & { _flushStreamBatch: () => void }} */
  const out = {
    _flushStreamBatch: () => batcher.flushNow(),
  }
  for (const key of Object.keys(mutators)) {
    const fn = mutators[key]
    if (key === '_appendTextDelta') {
      out[key] = delta => batcher.appendText(delta)
    } else if (key === '_appendReasoningDelta') {
      out[key] = delta => batcher.appendReasoning(delta)
    } else if (typeof fn === 'function') {
      out[key] = (...args) => {
        batcher.flushNow()
        return fn(...args)
      }
    } else {
      out[key] = fn
    }
  }
  return out
}
