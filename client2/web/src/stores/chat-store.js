import { create } from "zustand";

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

  // ── Streaming state ─────────────────────────
  isStreaming: false,
  currentStep: 0,
  abortController: null,

  // ── UI state ────────────────────────────────
  workspace: "",
  sidebarOpen: false,
  theme: localStorage.getItem("coding_agent_theme") || "dark",

  // ── Actions ─────────────────────────────────

  setWorkspace: (workspace) => set({ workspace }),

  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),

  toggleTheme: () => {
    const next = get().theme === "dark" ? "light" : "dark";
    localStorage.setItem("coding_agent_theme", next);
    const dark = document.getElementById("hljs-dark");
    const light = document.getElementById("hljs-light");
    if (dark && light) {
      dark.disabled = next === "light";
      light.disabled = next === "dark";
    }
    set({ theme: next });
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
      const res = await fetch(`/sessions/${id}/messages`);
      if (!res.ok) return;
      const data = await res.json();
      if (data.messages && data.messages.length > 0) {
        set({ messages: data.messages });
      }
    } catch {
      /* session history unavailable */
    }
  },

  clearSession: () => {
    localStorage.removeItem("coding_agent_session_id");
    set({ currentSessionId: null, messages: [] });
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
      const res = await fetch("/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: abortController.signal,
      });

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
          get()._handleSSE(eventType, data);
        }
      }
    } catch (err) {
      if (err.name !== "AbortError") {
        get()._appendPart({ type: "error", message: err.message });
      }
    }

    get()._finalizeAssistant();
    set({ isStreaming: false, abortController: null });
  },

  // ── Internal SSE handlers ───────────────────

  _handleSSE: (event, data) => {
    const store = get();

    if (event.startsWith("subagent_") && event.endsWith("_tool_call")) {
      store._appendPart({ type: "subagent_tool_call", event, ...data });
      return;
    }
    if (event.startsWith("subagent_") && event.endsWith("_tool_result")) {
      store._appendPart({ type: "subagent_tool_result", event, ...data });
      return;
    }
    if (event.startsWith("subagent_") && event.endsWith("_step_start")) {
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
      case "text_delta":
        store._removeThinking();
        store._appendTextDelta(data.delta);
        break;
      case "tool_call":
        store._removeThinking();
        store._appendPart({ type: "tool_call", ...data, startTime: Date.now() });
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
        if (p.type === "tool_call" && p.name === "bash" && p.status !== "done") {
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
