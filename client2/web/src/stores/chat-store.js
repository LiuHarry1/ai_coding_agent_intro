import { create } from "zustand";
import { agentApi } from "../lib/api/agent.js";
import { useWorkspaceIdeStore } from "./workspace-ide-store.js";

/**
 * Central state store for the chat UI.
 *
 * Manages: messages, sessions, streaming state, UI state.
 * SSE events update this store; React components subscribe reactively.
 */
export const useChatStore = create((set, get) => ({
  // ── Sessions ────────────────────────────────
  sessions: [],
  currentSessionId: localStorage.getItem("coding_agent_session_id") || null,

  // ── Messages ────────────────────────────────
  messages: [],

  // ── Todos ──────────────────────────────────
  todos: [],

  // ── Streaming state ─────────────────────────
  isStreaming: false,
  currentStep: 0,
  abortController: null,

  // ── UI state ────────────────────────────────
  workspace: "",
  theme: localStorage.getItem("coding_agent_theme") || "dark",

  // ── Actions ─────────────────────────────────

  setWorkspace: (workspace) => set({ workspace }),

  syncHljs: () => {
    const t = get().theme;
    const dark = document.getElementById("hljs-dark");
    const light = document.getElementById("hljs-light");
    if (dark && light) {
      dark.disabled = t === "light";
      light.disabled = t === "dark";
    }
  },

  toggleTheme: () => {
    const next = get().theme === "dark" ? "light" : "dark";
    localStorage.setItem("coding_agent_theme", next);
    set({ theme: next });
    get().syncHljs();
  },

  setSessionId: (id) => {
    if (id) localStorage.setItem("coding_agent_session_id", id);
    else localStorage.removeItem("coding_agent_session_id");
    set({ currentSessionId: id });
  },

  setSessions: (sessions) => set({ sessions }),

  switchSession: async (id) => {
    localStorage.setItem("coding_agent_session_id", id);
    set({ currentSessionId: id, messages: [] });
    if (!id) return;
    try {
      const data = await agentApi.getSessionMessages(id);
      if (data.messages?.length > 0) set({ messages: data.messages });
    } catch {
      /* session history unavailable */
    }
  },

  clearSession: () => {
    localStorage.removeItem("coding_agent_session_id");
    set({ currentSessionId: null, messages: [], todos: [] });
  },

  stopStreaming: () => {
    const { abortController } = get();
    if (abortController) abortController.abort();
    set({ isStreaming: false, abortController: null });
  },

  /**
   * Send a message and process the SSE response stream.
   */
  /**
   * @param {string} text
   * @param {string[]} [images] - array of data URLs (data:image/png;base64,...)
   */
  sendMessage: async (text, images = []) => {
    if (!text.trim() || get().isStreaming) return;

    const abortController = new AbortController();

    set((s) => ({
      isStreaming: true,
      abortController,
      currentStep: 0,
      messages: [
        ...s.messages,
        { type: "user", content: text, images: images.length > 0 ? images : undefined },
        { type: "assistant", parts: [], status: "streaming" },
      ],
    }));

    const body = {
      message: text,
      workspace: get().workspace,
      session_id: get().currentSessionId,
    };
    if (images.length > 0) body.images = images;

    try {
      const res = await agentApi.postChat(body, abortController.signal);

      if (!res.ok) {
        const errText = await res.text();
        get()._appendPart({ type: "error", message: `HTTP ${res.status}: ${errText}` });
        set({ isStreaming: false, abortController: null });
        return;
      }

      const newSid = res.headers.get("x-session-id");
      if (newSid) get().setSessionId(newSid);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop();

        for (const part of parts) {
          let eventType = "message";
          let dataStr = "";
          for (const line of part.split("\n")) {
            if (line.startsWith("event: ")) eventType = line.slice(7);
            else if (line.startsWith("data: ")) dataStr += line.slice(6);
          }
          if (!dataStr) continue;
          let data;
          try { data = JSON.parse(dataStr); } catch { continue; }
          try { get()._handleSSE(eventType, data); } catch (e) { console.error("[SSE] handler error:", eventType, e); }
        }
      }
    } catch (err) {
      if (err.name !== "AbortError") {
        get()._appendPart({ type: "error", message: err.message });
      }
    }

    get()._finalizeAssistant();
    set({ isStreaming: false, abortController: null });
    // Nudge the workspace IDE's git status — the agent likely just
    // wrote / edited / created files, so any open "Changes" view should
    // reflect that without the user clicking refresh. Best-effort; we
    // don't await it and we ignore errors (the store handles its own).
    try {
      const ideStore = useWorkspaceIdeStore.getState();
      if (ideStore.rootPath) ideStore.refreshChanges();
    } catch {
      // store not initialized — ignore
    }
  },

  // ── Internal SSE handlers ───────────────────

  _handleSSE: (event, data) => {
    const store = get();

    if (event.startsWith("subagent_") && event.endsWith("_tool_call")) {
      store._appendSubagentEvent({ type: "tool_call", ...data });
      return;
    }
    if (event.startsWith("subagent_") && event.endsWith("_tool_result")) {
      store._appendSubagentEvent({ type: "tool_result", ...data });
      return;
    }
    if (event.startsWith("subagent_") && event.endsWith("_text_delta")) {
      store._appendSubagentEvent({ type: "text_delta", ...data });
      return;
    }
    if (event.startsWith("subagent_") && (event.endsWith("_step_start") || event.endsWith("_thinking") || event.endsWith("_done"))) {
      return;
    }
    if (event === "tool_timing") {
      store._updateLastToolTiming(data);
      return;
    }
    if (event === "process_output") {
      store._updateProcessOutput(data);
      return;
    }

    switch (event) {
      case "session":
        if (data.session_id) store.setSessionId(data.session_id);
        break;
      case "step_start":
        set({ currentStep: data.step ?? get().currentStep });
        store._setThinking();
        break;
      case "thinking":
        store._setThinking();
        break;
      case "reasoning_start":
        store._removeThinking();
        store._startReasoning();
        break;
      case "reasoning_delta":
        store._appendReasoningDelta(data.delta);
        break;
      case "reasoning_end":
        store._finalizeReasoning();
        break;
      case "text_delta":
        store._removeThinking();
        store._appendTextDelta(data.delta);
        break;
      case "todo_update":
        store._updateTodos(data.todos);
        break;
      case "tool_input_start": {
        store._removeThinking();
        // liveInputStart doubles as the part's overall start time — the
        // tool_call event will eventually upsert duration based on backend
        // timestamps, so a single client-side anchor is enough.
        const t0 = Date.now();
        store._appendPart({
          type: "tool_call",
          name: data.name,
          toolCallId: data.toolCallId,
          args: {},
          status: "streaming-input",
          // Carry isSubagent through from the start so the placeholder card
          // already uses subagent styling/dispatch during the streaming-input
          // window. Without this it briefly renders as a generic tool card,
          // then flips visual style when tool_call lands → ugly flash.
          isSubagent: data.isSubagent === true,
          liveInputBytes: 0,
          liveInputStart: t0,
          startTime: t0,
        });
        break;
      }
      case "tool_input_preview_delta":
        store._appendToolInputPreviewDelta(data);
        break;
      case "tool_input_delta":
        store._appendToolInputDelta(data);
        break;
      case "tool_call":
        store._removeThinking();
        store._upsertToolCall({ ...data, startTime: Date.now() });
        break;
      case "tool_result":
        store._updateToolResult(data);
        break;
      case "compaction_start":
        store._appendPart({ type: "compaction_start", ...data });
        break;
      case "compaction_done":
        store._appendPart({ type: "compaction_done", ...data });
        break;
      case "error":
        store._appendPart({ type: "error", message: data.message });
        break;
      case "done":
        store._removeThinking();
        break;
    }
  },

  /**
   * Set a single thinking indicator, removing any existing ones first.
   */
  _setThinking: () => {
    set((s) => {
      const msgs = [...s.messages];
      const last = msgs[msgs.length - 1];
      if (last?.type !== "assistant") return { messages: msgs };

      const parts = last.parts.filter((p) => p.type !== "thinking");
      parts.push({ type: "thinking" });
      msgs[msgs.length - 1] = { ...last, parts };
      return { messages: msgs };
    });
  },

  /**
   * Remove ALL thinking indicators from the assistant message.
   */
  _removeThinking: () => {
    set((s) => {
      const msgs = [...s.messages];
      const last = msgs[msgs.length - 1];
      if (last?.type !== "assistant") return s;

      const filtered = last.parts.filter((p) => p.type !== "thinking");
      if (filtered.length === last.parts.length) return s;
      msgs[msgs.length - 1] = { ...last, parts: filtered };
      return { messages: msgs };
    });
  },

  _startReasoning: () => {
    set((s) => {
      const msgs = [...s.messages];
      const last = msgs[msgs.length - 1];
      if (last?.type !== "assistant") return s;
      const parts = [...last.parts];
      parts.push({ type: "reasoning", content: "", status: "streaming", startTime: Date.now() });
      msgs[msgs.length - 1] = { ...last, parts };
      return { messages: msgs };
    });
  },

  _appendReasoningDelta: (delta) => {
    set((s) => {
      const msgs = [...s.messages];
      const last = msgs[msgs.length - 1];
      if (last?.type !== "assistant") return s;

      const parts = [...last.parts];
      const lastPart = parts[parts.length - 1];

      if (lastPart?.type === "reasoning" && lastPart.status === "streaming") {
        parts[parts.length - 1] = { ...lastPart, content: lastPart.content + delta };
      }
      msgs[msgs.length - 1] = { ...last, parts };
      return { messages: msgs };
    });
  },

  _finalizeReasoning: () => {
    set((s) => {
      const msgs = [...s.messages];
      const last = msgs[msgs.length - 1];
      if (last?.type !== "assistant") return s;

      const parts = [...last.parts];
      for (let i = parts.length - 1; i >= 0; i--) {
        if (parts[i].type === "reasoning" && parts[i].status === "streaming") {
          const elapsed = Math.round((Date.now() - parts[i].startTime) / 1000);
          parts[i] = { ...parts[i], status: "done", duration: elapsed };
          break;
        }
      }
      msgs[msgs.length - 1] = { ...last, parts };
      return { messages: msgs };
    });
  },

  _updateTodos: (todos) => {
    set((s) => {
      const msgs = [...s.messages];
      const last = msgs[msgs.length - 1];
      if (last?.type !== "assistant") return { todos };

      const parts = [...last.parts];
      let existingIdx = -1;
      for (let i = parts.length - 1; i >= 0; i--) {
        if (parts[i].type === "todo_list") { existingIdx = i; break; }
      }
      if (existingIdx >= 0) {
        parts[existingIdx] = { ...parts[existingIdx], todos };
      } else {
        parts.push({ type: "todo_list", todos });
      }
      msgs[msgs.length - 1] = { ...last, parts };
      return { todos, messages: msgs };
    });
  },

  _appendPart: (part) => {
    set((s) => {
      const msgs = [...s.messages];
      const last = msgs[msgs.length - 1];
      if (last?.type === "assistant") {
        msgs[msgs.length - 1] = { ...last, parts: [...last.parts, part] };
      }
      return { messages: msgs };
    });
  },

  /**
   * Append decoded preview text to the in-progress tool_call card. Server
   * extracts the value of the tool's main string field (e.g. write_file's
   * `content`, edit_file's `new_string`) from the partial JSON args and
   * streams it here so the UI can render the file being typed live.
   */
  _appendToolInputPreviewDelta: (data) => {
    set((s) => {
      const msgs = [...s.messages];
      const last = msgs[msgs.length - 1];
      if (last?.type !== "assistant") return s;

      const parts = [...last.parts];
      for (let i = parts.length - 1; i >= 0; i--) {
        const p = parts[i];
        if (p.type === "tool_call" && p.toolCallId === data.toolCallId && p.status !== "done") {
          parts[i] = { ...p, livePreview: (p.livePreview || "") + (data.delta || "") };
          break;
        }
      }
      msgs[msgs.length - 1] = { ...last, parts };
      return { messages: msgs };
    });
  },

  /**
   * Bump the live byte counter on the in-progress tool_call card matching
   * `toolCallId`. Used to show "Generating arguments… N chars" while the
   * model is streaming the tool's argument JSON.
   */
  _appendToolInputDelta: (data) => {
    set((s) => {
      const msgs = [...s.messages];
      const last = msgs[msgs.length - 1];
      if (last?.type !== "assistant") return s;

      const parts = [...last.parts];
      for (let i = parts.length - 1; i >= 0; i--) {
        const p = parts[i];
        if (p.type === "tool_call" && p.toolCallId === data.toolCallId && p.status !== "done") {
          parts[i] = { ...p, liveInputBytes: (p.liveInputBytes || 0) + (data.bytes || 0) };
          break;
        }
      }
      msgs[msgs.length - 1] = { ...last, parts };
      return { messages: msgs };
    });
  },

  /**
   * Upgrade a streaming-input placeholder (created by tool_input_start) into
   * a fully-populated tool_call once the SDK has parsed the complete args,
   * or just append a new card if no placeholder existed (older SDK paths
   * that skip tool-input-* events).
   */
  _upsertToolCall: (data) => {
    set((s) => {
      const msgs = [...s.messages];
      const last = msgs[msgs.length - 1];
      if (last?.type !== "assistant") return s;

      const parts = [...last.parts];
      for (let i = parts.length - 1; i >= 0; i--) {
        const p = parts[i];
        if (p.type === "tool_call" && p.toolCallId === data.toolCallId) {
          parts[i] = {
            ...p,
            name: data.name,
            args: data.args,
            status: "running",
            // Re-affirm isSubagent on the upsert. The placeholder created by
            // tool_input_start already set it, but if the SDK skipped that
            // event (some providers don't emit tool-input-start) and we land
            // here directly, this is the only place the flag gets recorded.
            // Coalesce instead of overwrite: don't lose `true` if the
            // tool_call payload happens to omit the field.
            isSubagent: data.isSubagent === true || p.isSubagent === true,
            liveInputBytes: undefined,
            liveInputStart: undefined,
          };
          msgs[msgs.length - 1] = { ...last, parts };
          return { messages: msgs };
        }
      }
      parts.push({ type: "tool_call", ...data });
      msgs[msgs.length - 1] = { ...last, parts };
      return { messages: msgs };
    });
  },

  _appendSubagentEvent: (ev) => {
    set((s) => {
      const msgs = [...s.messages];
      const last = msgs[msgs.length - 1];
      if (last?.type !== "assistant") return s;

      const parts = [...last.parts];
      let targetIdx = -1;

      // Prefer explicit routing from backend (parallel subagents of same type).
      if (ev.parentToolCallId) {
        targetIdx = parts.findIndex(
          (p) => p.type === "tool_call" && p.toolCallId === ev.parentToolCallId,
        );
      }

      if (targetIdx === -1) {
        const runningSubagents = parts
          .map((p, i) => ({ p, i }))
          .filter(
            ({ p }) =>
              p.type === "tool_call" &&
              p.isSubagent &&
              p.status !== "done",
          );

        if (runningSubagents.length === 1) {
          targetIdx = runningSubagents[0].i;
        } else if (runningSubagents.length > 1) {
          // Serial subagent runs: prefer the card that already has nested
          // steps (active run). Parallel runs require parentToolCallId.
          const active = runningSubagents.filter(
            ({ p }) => (p.subagentParts?.length ?? 0) > 0,
          );
          targetIdx = (active.length === 1 ? active[0] : runningSubagents[0]).i;
        }
      }

      if (targetIdx === -1) {
        for (let i = parts.length - 1; i >= 0; i--) {
          if (parts[i].type === "tool_call" && parts[i].status !== "done") {
            targetIdx = i;
            break;
          }
        }
      }
      if (targetIdx === -1) {
        for (let i = parts.length - 1; i >= 0; i--) {
          if (parts[i].type === "tool_call" && parts[i].isSubagent) {
            targetIdx = i;
            break;
          }
        }
      }
      if (targetIdx === -1) return s;

      const sub = [...(parts[targetIdx].subagentParts || [])];
      if (ev.type === "tool_call") {
        sub.push({ type: "tool_call", name: ev.name, args: ev.args, toolCallId: ev.toolCallId });
      } else if (ev.type === "tool_result") {
        for (let j = sub.length - 1; j >= 0; j--) {
          if (sub[j].toolCallId === ev.toolCallId) {
            sub[j] = { ...sub[j], result: ev.result, status: "done" };
            break;
          }
        }
      }
      parts[targetIdx] = { ...parts[targetIdx], subagentParts: sub };
      msgs[msgs.length - 1] = { ...last, parts };
      return { messages: msgs };
    });
  },

  _appendTextDelta: (delta) => {
    set((s) => {
      const msgs = [...s.messages];
      const last = msgs[msgs.length - 1];
      if (last?.type !== "assistant") return { messages: msgs };

      const parts = [...last.parts];
      const lastPart = parts[parts.length - 1];

      if (lastPart?.type === "text") {
        parts[parts.length - 1] = { ...lastPart, content: lastPart.content + delta };
      } else {
        parts.push({ type: "text", content: delta });
      }
      msgs[msgs.length - 1] = { ...last, parts };
      return { messages: msgs };
    });
  },

  _updateToolResult: (data) => {
    set((s) => {
      const msgs = [...s.messages];
      const last = msgs[msgs.length - 1];
      if (last?.type !== "assistant") return { messages: msgs };

      const parts = [...last.parts];
      for (let i = parts.length - 1; i >= 0; i--) {
        if (parts[i].type === "tool_call" && parts[i].toolCallId === data.toolCallId) {
          parts[i] = {
            ...parts[i],
            result: data.result,
            status: "done",
            endTime: Date.now(),
          };
          break;
        }
      }
      msgs[msgs.length - 1] = { ...last, parts };
      return { messages: msgs };
    });
  },

  _updateLastToolTiming: (data) => {
    set((s) => {
      const msgs = [...s.messages];
      const last = msgs[msgs.length - 1];
      if (last?.type !== "assistant") return { messages: msgs };

      const parts = [...last.parts];
      for (let i = parts.length - 1; i >= 0; i--) {
        if (parts[i].type === "tool_call" && parts[i].name === data.name && parts[i].status === "done") {
          parts[i] = { ...parts[i], duration: data.duration };
          break;
        }
      }
      msgs[msgs.length - 1] = { ...last, parts };
      return { messages: msgs };
    });
  },

  /**
   * Attach live process output to the last pending bash tool call.
   * Emitted by the bash tool in wait mode — streams output to UI
   * without requiring the LLM to poll.
   */
  _updateProcessOutput: (data) => {
    set((s) => {
      const msgs = [...s.messages];
      const last = msgs[msgs.length - 1];
      if (last?.type !== "assistant") return { messages: msgs };

      const parts = [...last.parts];
      for (let i = parts.length - 1; i >= 0; i--) {
        const p = parts[i];
        if (p.type === "tool_call" && (p.name === "bash" || p.name === "powershell") && p.status !== "done") {
          parts[i] = {
            ...p,
            liveOutput: data.output,
            liveElapsed: data.elapsed,
            liveDone: data.done,
          };
          break;
        }
      }
      msgs[msgs.length - 1] = { ...last, parts };
      return { messages: msgs };
    });
  },

  _finalizeAssistant: () => {
    set((s) => {
      const msgs = [...s.messages];
      const last = msgs[msgs.length - 1];
      if (last?.type === "assistant") {
        msgs[msgs.length - 1] = { ...last, status: "done" };
      }
      return { messages: msgs };
    });
  },
}));
