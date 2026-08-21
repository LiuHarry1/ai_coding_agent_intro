import { create } from 'zustand'
import { agentApi } from '../lib/api/agent.js'
import { useWorkspaceIdeStore } from './workspace-ide-store.js'
import { newId } from '../lib/utils.js'

/** Find a tool_call part (top-level or nested in a subagent) by id. */
function findToolCallInAssistant(assistantMsg, toolCallId) {
  if (assistantMsg?.type !== 'assistant' || !toolCallId) return null
  for (let i = assistantMsg.parts.length - 1; i >= 0; i--) {
    const p = assistantMsg.parts[i]
    if (p.type !== 'tool_call') continue
    if (p.toolCallId === toolCallId) return p
    for (const sub of p.subagentParts || []) {
      if (sub.toolCallId === toolCallId) return sub
    }
  }
  return null
}

function notifyIdeFilesystemFromTool(toolName, args, result) {
  try {
    useWorkspaceIdeStore
      .getState()
      .onAgentToolFilesystemChange(toolName, args, result)
  } catch {
    // workspace IDE store not initialized — ignore
  }
}

function refreshIdeAfterAgentTurn() {
  try {
    const ideStore = useWorkspaceIdeStore.getState()
    if (!ideStore.rootPath) return
    ideStore.refreshChanges()
    ideStore.refreshTree()
  } catch {
    // store not initialized — ignore
  }
}

/**
 * Central state store for the chat UI.
 *
 * Manages: messages, sessions, streaming state, UI state.
 * SSE events update this store; React components subscribe reactively.
 */
export const useChatStore = create((set, get) => ({
  // ── Sessions ────────────────────────────────
  sessions: [],
  currentSessionId: localStorage.getItem('coding_agent_session_id') || null,
  /** Display label e.g. `atsrws0049:/home/...` when using execution environments. */
  workspaceLabel: null,
  /** Bound WorkspaceHandle from execution plane. */
  workspaceHandle: null,

  // ── Messages ────────────────────────────────
  messages: [],

  // ── Todos ──────────────────────────────────
  todos: [],

  // ── Streaming state ─────────────────────────
  isStreaming: false,
  currentStep: 0,
  abortController: null,

  // ── UI state ────────────────────────────────
  workspace: '',
  theme: localStorage.getItem('coding_agent_theme') || 'dark',

  // ── Agent mode (Agent / Ask / Plan) ─────────
  agentMode: localStorage.getItem('coding_agent_mode') || 'agent',
  /** Main-thread primary agent profile (null = default Agent). */
  agentType: localStorage.getItem('coding_agent_type') || null,
  planState: {
    status: 'idle',
    content: '',
    filePath: null,
  },
  isAwaitingInteraction: false,

  // ── Actions ─────────────────────────────────

  setWorkspace: workspace => set({ workspace }),

  setAgentMode: mode => {
    localStorage.setItem('coding_agent_mode', mode)
    // Selecting a permission mode clears the specialist (Ask/Plan server-side;
    // Agent explicitly resets to default profile).
    localStorage.removeItem('coding_agent_type')
    set({ agentMode: mode, agentType: null })
    const { currentSessionId, workspace } = get()
    if (currentSessionId) {
      agentApi
        .setSessionMode({
          session_id: currentSessionId,
          mode,
          workspace: workspace || undefined,
        })
        .catch(() => {})
      if (mode === 'agent') {
        agentApi
          .setSessionAgent({
            session_id: currentSessionId,
            agentType: null,
            workspace: workspace || undefined,
          })
          .catch(() => {})
      }
    }
  },

  setAgentType: agentType => {
    const next = agentType || null
    if (next) {
      localStorage.setItem('coding_agent_type', next)
      localStorage.setItem('coding_agent_mode', 'agent')
      set({ agentType: next, agentMode: 'agent' })
    } else {
      localStorage.removeItem('coding_agent_type')
      set({ agentType: null })
    }
    const { currentSessionId, workspace } = get()
    if (currentSessionId) {
      agentApi
        .setSessionAgent({
          session_id: currentSessionId,
          agentType: next,
          workspace: workspace || undefined,
        })
        .catch(() => {})
    }
  },

  cycleAgentMode: () => {
    const order = ['agent', 'ask', 'plan']
    const idx = order.indexOf(get().agentMode)
    const next = order[(idx + 1) % order.length]
    get().setAgentMode(next)
  },

  answerQuestion: async (id, answers, extra) => {
    const annotations = extra?.notes
      ? Object.fromEntries(
          Object.keys(answers).map(q => [q, { notes: extra.notes }]),
        )
      : undefined
    await agentApi.answerQuestion({ id, answers, annotations })
    set(s => {
      const msgs = [...s.messages]
      const last = msgs[msgs.length - 1]
      if (last?.type !== 'assistant') return { isAwaitingInteraction: false }
      const parts = last.parts.map(p =>
        p.type === 'ask_user_question' && p.id === id
          ? { ...p, status: 'answered', answers }
          : p,
      )
      msgs[msgs.length - 1] = { ...last, parts }
      return { messages: msgs, isAwaitingInteraction: false }
    })
  },

  approvePlan: async (requestId, opts) => {
    await agentApi.approvePlan({
      request_id: requestId,
      approved: opts.approved,
      edited_plan: opts.editedPlan,
      target_mode: opts.targetMode,
      reason: opts.reason,
    })
    if (opts.approved) {
      set({
        planState: {
          status: 'building',
          content: opts.editedPlan ?? '',
          filePath: null,
        },
      })
      // Agent loop continues on the same SSE stream; show activity while implementing.
      if (!get().isStreaming) {
        set({ isStreaming: true })
      }
      get()._setThinking()
    }
    set(s => {
      const msgs = [...s.messages]
      const last = msgs[msgs.length - 1]
      if (last?.type !== 'assistant') return { isAwaitingInteraction: false }
      const parts = last.parts.map(p =>
        p.type === 'plan_approval' && p.requestId === requestId
          ? { ...p, status: 'answered', approved: opts.approved }
          : p,
      )
      msgs[msgs.length - 1] = { ...last, parts }
      return { messages: msgs, isAwaitingInteraction: false }
    })
  },

  syncHljs: () => {
    const t = get().theme
    const dark = document.getElementById('hljs-dark')
    const light = document.getElementById('hljs-light')
    if (dark && light) {
      dark.disabled = t === 'light'
      light.disabled = t === 'dark'
    }
  },

  toggleTheme: () => {
    const next = get().theme === 'dark' ? 'light' : 'dark'
    localStorage.setItem('coding_agent_theme', next)
    set({ theme: next })
    get().syncHljs()
  },

  setSessionId: id => {
    if (id) localStorage.setItem('coding_agent_session_id', id)
    else localStorage.removeItem('coding_agent_session_id')
    set({ currentSessionId: id })
  },

  setSessions: sessions => set({ sessions }),

  switchSession: async id => {
    localStorage.setItem('coding_agent_session_id', id)
    set({ currentSessionId: id, messages: [] })
    if (!id) return
    try {
      const data = await agentApi.getSessionMessages(id)
      const msgs = (data.messages || []).map(m =>
        m.id ? m : { ...m, id: newId() },
      )
      set({ messages: msgs })
    } catch (err) {
      // Agent restart drops in-memory sessions; drop stale localStorage id.
      if (
        err.status === 404 ||
        String(err.message).includes('Session not found')
      ) {
        get().clearSession()
      } else {
        console.warn('[chat] failed to load session messages', id, err)
      }
    }
  },

  clearSession: () => {
    localStorage.removeItem('coding_agent_session_id')
    set({ currentSessionId: null, messages: [], todos: [] })
  },

  stopStreaming: async () => {
    const { abortController, currentSessionId } = get()
    // Prefer server cancel so SSE can still deliver pairing repairs / done.
    // Fall back to aborting the fetch if cancel is unavailable.
    let cancelled = false
    if (currentSessionId) {
      try {
        const data = await agentApi.cancelChat(currentSessionId)
        cancelled = data?.ok === true
      } catch (err) {
        console.warn('[chat] cancelChat failed', err)
      }
    }
    if (!cancelled && abortController) {
      abortController.abort()
      set({ isStreaming: false, abortController: null })
      get()._finalizeAssistant()
      return
    }
    // Safety net: if the server never ends the stream after cancel, drop it.
    if (cancelled && abortController) {
      const ac = abortController
      setTimeout(() => {
        if (get().abortController !== ac) return
        ac.abort()
        set({ isStreaming: false, abortController: null })
        get()._finalizeAssistant()
      }, 15_000)
    }
  },

  /**
   * Stop a single in-flight subagent (Agent tool) without aborting the turn.
   * Marks the card as stopping; the server emits tool_result when abort lands.
   */
  stopSubagent: async toolCallId => {
    if (!toolCallId) return
    const sessionId = get().currentSessionId
    if (!sessionId) return

    set(s => {
      const msgs = [...s.messages]
      const last = msgs[msgs.length - 1]
      if (last?.type !== 'assistant') return s
      const parts = last.parts.map(p =>
        p.type === 'tool_call' &&
        p.toolCallId === toolCallId &&
        p.status !== 'done'
          ? { ...p, stopping: true, liveTask: 'Stopping…' }
          : p,
      )
      msgs[msgs.length - 1] = { ...last, parts }
      return { messages: msgs }
    })

    try {
      await agentApi.abortTool({
        session_id: sessionId,
        tool_use_id: toolCallId,
      })
    } catch (err) {
      console.warn('[chat] abortTool failed', err)
      set(s => {
        const msgs = [...s.messages]
        const last = msgs[msgs.length - 1]
        if (last?.type !== 'assistant') return s
        const parts = last.parts.map(p =>
          p.type === 'tool_call' && p.toolCallId === toolCallId
            ? { ...p, stopping: false, liveTask: undefined }
            : p,
        )
        msgs[msgs.length - 1] = { ...last, parts }
        return { messages: msgs }
      })
    }
  },

  /**
   * Send a message and process the SSE response stream.
   */
  /**
   * @param {string} text
   * @param {string[]} [images] - array of data URLs (data:image/png;base64,...)
   */
  sendMessage: async (text, images = []) => {
    if (!text.trim() || get().isStreaming) return

    const abortController = new AbortController()

    set(s => ({
      isStreaming: true,
      abortController,
      currentStep: 0,
      messages: [
        ...s.messages,
        {
          id: newId(),
          type: 'user',
          content: text,
          images: images.length > 0 ? images : undefined,
        },
        {
          id: newId(),
          type: 'assistant',
          parts: [],
          status: 'streaming',
        },
      ],
    }))

    const body = {
      message: text,
      workspace: get().workspaceHandle?.cwd || get().workspace,
      session_id: get().currentSessionId,
      mode: get().agentMode,
      agentType: get().agentType,
      environmentId: get().workspaceHandle?.environmentId || 'local',
    }
    if (images.length > 0) body.images = images

    const postChat = sessionId =>
      agentApi.postChat(
        { ...body, session_id: sessionId },
        abortController.signal,
      )

    try {
      let res = await postChat(get().currentSessionId)

      if (!res.ok && res.status === 404) {
        const errText = await res.text()
        if (errText.includes('Session not found')) {
          get().setSessionId(null)
          set(s => ({
            messages: s.messages.slice(0, -2),
            isStreaming: true,
            abortController,
          }))
          res = await postChat(null)
        } else {
          get()._appendPart({
            type: 'error',
            message: `HTTP ${res.status}: ${errText}`,
          })
          set({ isStreaming: false, abortController: null })
          return
        }
      }

      if (!res.ok) {
        const errText = await res.text()
        // Server error bodies are JSON ({ error: "..." }) — show the human
        // message, not the raw payload. 409 = a previous turn (possibly a
        // slow context compaction) is still running for this session.
        let friendly = errText
        try {
          const parsed = JSON.parse(errText)
          if (parsed?.error) friendly = parsed.error
        } catch {
          /* not JSON — show as-is */
        }
        get()._appendPart({
          type: 'error',
          message:
            res.status === 409 ? friendly : `HTTP ${res.status}: ${friendly}`,
        })
        set({ isStreaming: false, abortController: null })
        return
      }

      const newSid = res.headers.get('x-session-id')
      if (newSid) get().setSessionId(newSid)
      const headerMode = res.headers.get('x-permission-mode')
      if (headerMode && ['agent', 'ask', 'plan'].includes(headerMode)) {
        localStorage.setItem('coding_agent_mode', headerMode)
        set({ agentMode: headerMode })
      }
      const headerAgent = res.headers.get('x-agent-type')
      if (headerAgent !== null) {
        const nextType = headerAgent || null
        if (nextType) localStorage.setItem('coding_agent_type', nextType)
        else localStorage.removeItem('coding_agent_type')
        set({ agentType: nextType })
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const parts = buffer.split('\n\n')
        buffer = parts.pop()

        for (const part of parts) {
          let eventType = 'message'
          let dataStr = ''
          for (const line of part.split('\n')) {
            if (line.startsWith('event: ')) eventType = line.slice(7)
            else if (line.startsWith('data: ')) dataStr += line.slice(6)
          }
          if (!dataStr) continue
          let data
          try {
            data = JSON.parse(dataStr)
          } catch {
            continue
          }
          try {
            get()._handleSSE(eventType, data)
          } catch (e) {
            console.error('[SSE] handler error:', eventType, e)
          }
        }
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        get()._appendPart({ type: 'error', message: err.message })
      }
    }

    get()._finalizeAssistant()
    set({ isStreaming: false, abortController: null })
    // Agent likely wrote / edited files — refresh git status and the
    // explorer tree without requiring a manual click.
    refreshIdeAfterAgentTurn()
  },

  // ── Internal SSE handlers ───────────────────

  _handleSSE: (_event, data) => {
    const store = get()
    const toolUseId = d => d.tool_use_id ?? d.toolCallId
    const parentId = data.parent_tool_use_id ?? data.parentToolCallId

    if (parentId) {
      if (data.type === 'tool_call') {
        store._appendSubagentEvent({
          type: 'tool_call',
          name: data.name,
          args: data.args,
          toolCallId: toolUseId(data),
          parentToolCallId: parentId,
        })
        return
      }
      if (data.type === 'tool_result') {
        store._appendSubagentEvent({
          type: 'tool_result',
          result: data.result,
          toolUseResult: data.tool_use_result,
          isError: data.is_error === true,
          toolCallId: toolUseId(data),
          parentToolCallId: parentId,
        })
        return
      }
      if (data.type === 'stream_event' && data.delta?.kind === 'text') {
        store._appendSubagentEvent({
          type: 'text_delta',
          delta: data.delta.text,
          parentToolCallId: parentId,
        })
        return
      }
      if (data.type === 'system') {
        if (data.subtype === 'step_start') {
          store._appendSubagentEvent({
            type: 'step_start',
            task: data.task,
            label: data.label,
            parentToolCallId: parentId,
          })
        } else if (data.subtype === 'tool_input_start') {
          store._appendSubagentEvent({
            type: 'tool_input_start',
            name: data.name,
            toolCallId: toolUseId(data),
            parentToolCallId: parentId,
          })
        }
      }
      return
    }

    if (data.type === 'tool_progress') {
      store._updateProcessOutput({ output: data.output, done: false })
      return
    }

    switch (data.type) {
      case 'system':
        switch (data.subtype) {
          case 'init':
            if (data.session_id) store.setSessionId(data.session_id)
            if (data.permission_mode) {
              localStorage.setItem('coding_agent_mode', data.permission_mode)
              set({ agentMode: data.permission_mode })
            }
            if (data.agent_type !== undefined) {
              const nextType = data.agent_type || null
              if (nextType) localStorage.setItem('coding_agent_type', nextType)
              else localStorage.removeItem('coding_agent_type')
              set({ agentType: nextType })
            }
            break
          case 'mode_changed':
            if (data.mode) {
              localStorage.setItem('coding_agent_mode', data.mode)
              const patch = { agentMode: data.mode }
              if (data.mode === 'ask' || data.mode === 'plan') {
                localStorage.removeItem('coding_agent_type')
                patch.agentType = null
              }
              set(patch)
            }
            break
          case 'reasoning_start':
            // Single set: drop placeholder + start reasoning (avoid WorkGroup
            // remount gap from removeThinking then _startReasoning).
            store._replaceThinkingWithReasoning()
            break
          case 'reasoning_end':
            store._finalizeReasoning()
            break
          case 'step_start':
            set({ currentStep: data.step ?? get().currentStep })
            store._setThinking()
            break
          case 'thinking':
            store._setThinking()
            break
          case 'todo_update':
            store._updateTodos(data.todos)
            break
          case 'tool_input_start':
            store._beginToolCall({
              type: 'tool_call',
              name: data.name,
              toolCallId: toolUseId(data),
              args: {},
              status: 'streaming-input',
              isSubagent: data.is_subagent === true,
              liveInputBytes: 0,
              liveInputStart: Date.now(),
              startTime: Date.now(),
            })
            break
          case 'tool_input_preview_delta':
            store._appendToolInputPreviewDelta({
              toolCallId: toolUseId(data),
              delta: data.delta,
            })
            break
          case 'tool_input_delta':
            store._appendToolInputDelta({
              toolCallId: toolUseId(data),
              bytes: data.bytes,
            })
            break
          case 'plan_ready':
            set({
              planState: {
                status: data.approved ? 'building' : 'idle',
                content: data.plan ?? '',
                filePath: data.file_path ?? null,
              },
            })
            if (data.approved) store._setThinking()
            break
          case 'compaction_start':
            // Spread first: the wire message carries type:'system', which
            // must not clobber the part's own type discriminant.
            store._appendPart({ ...data, type: 'compaction_start' })
            break
          case 'compaction_done': {
            const status = data.status ?? 'ok'
            store._resolveCompactionPart(status)
            // noop/error left the transcript untouched — nothing to refetch.
            if (status === 'ok') void get()._refetchTranscriptAfterCompaction()
            break
          }
          case 'tool_timing':
            store._updateLastToolTiming(data)
            break
          case 'interrupted':
            store._onInterrupted(data)
            break
        }
        break
      case 'stream_event':
        if (data.delta?.kind === 'reasoning') {
          store._appendReasoningDelta(data.delta.text)
        } else if (data.delta?.kind === 'text') {
          store._removeThinking()
          store._appendTextDelta(data.delta.text)
        }
        break
      case 'tool_call':
        store._removeThinking()
        store._upsertToolCall({
          name: data.name,
          toolCallId: toolUseId(data),
          args: data.args,
          isSubagent: data.is_subagent === true,
          startTime: Date.now(),
        })
        break
      case 'tool_result':
        store._updateToolResult({
          toolCallId: toolUseId(data),
          result: data.result,
          toolUseResult: data.tool_use_result,
          isError: data.is_error === true,
        })
        break
      case 'control_request':
        if (data.request?.subtype === 'ask_user_question') {
          store._appendPart({
            type: 'ask_user_question',
            id: data.request.question_id,
            questions: data.request.questions,
            status: 'pending',
          })
          set({ isAwaitingInteraction: true })
        } else if (data.request?.subtype === 'approve_plan') {
          store._appendPlanApprovalPart({
            requestId: data.request_id,
            plan: data.request.plan,
          })
        }
        break
      case 'result':
        if (data.subtype === 'error') {
          store._appendPart({ type: 'error', message: data.error })
        } else if (data.subtype === 'success' && data.reason === 'done') {
          store._removeThinking()
        }
        break
    }
  },

  /**
   * Set a single thinking indicator, removing any existing ones first.
   */
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

  /**
   * Remove ALL thinking indicators from the assistant message.
   */
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

  /** Drop Thinking... placeholder and start a reasoning block in one update. */
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
      if (last?.type === 'interrupted') return s
      msgs.push({
        id: newId(),
        type: 'interrupted',
        toolUse: data?.tool_use === true,
        text: data?.text,
      })
      return { messages: msgs }
    })
  },
}))

// Dev-only: browser / CDP harness can inject transcript fixtures.
if (import.meta.env.DEV && typeof window !== 'undefined') {
  window.__BAIZE_CHAT_STORE__ = useChatStore
}