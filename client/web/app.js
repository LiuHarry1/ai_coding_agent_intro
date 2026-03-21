const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

const messagesEl = $("#messages");
const welcomeEl = $("#welcome");
const inputEl = $("#input");
const sendBtn = $("#send-btn");
const btnClear = $("#btn-clear");
const workspaceInput = $("#workspace-input");
const workspaceBrowseBtn = $("#workspace-browse");
const workspaceDropdown = $("#workspace-dropdown");

let isStreaming = false;
let sessionId = localStorage.getItem("coding_agent_session_id") || null;
let currentStep = 0;


// ── Load default workspace ──────────────────────
fetch("/workspace")
  .then((r) => r.json())
  .then((d) => { workspaceInput.value = d.workspace; })
  .catch(() => { workspaceInput.value = "."; });


// ── Workspace browser ───────────────────────────
let wsDropdownOpen = false;

function toggleDropdown() {
  wsDropdownOpen = !wsDropdownOpen;
  workspaceDropdown.classList.toggle("open", wsDropdownOpen);
  workspaceBrowseBtn.classList.toggle("open", wsDropdownOpen);
  if (wsDropdownOpen) loadDirectory(workspaceInput.value.trim() || ".");
}

function closeDropdown() {
  wsDropdownOpen = false;
  workspaceDropdown.classList.remove("open");
  workspaceBrowseBtn.classList.remove("open");
}

workspaceBrowseBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  toggleDropdown();
});

document.addEventListener("click", (e) => {
  if (wsDropdownOpen && !e.target.closest("#workspace-bar")) {
    closeDropdown();
  }
});

workspaceInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    closeDropdown();
    loadDirectory(workspaceInput.value.trim());
  }
});

async function loadDirectory(dir) {
  try {
    const res = await fetch(`/workspace/list?dir=${encodeURIComponent(dir)}`);
    const data = await res.json();
    renderDropdown(data);
  } catch {
    workspaceDropdown.innerHTML = `<div class="ws-empty">Failed to load directory</div>`;
  }
}

function selectWorkspace(dirPath) {
  workspaceInput.value = dirPath;
  closeDropdown();
  workspaceInput.focus();
}

function renderDropdown(data) {
  const { dir, parent, entries } = data;
  workspaceInput.value = dir;

  const dirs = entries.filter((e) => e.isDir);

  let html = `
    <div class="ws-dropdown-header">
      ${parent !== dir ? `<button class="ws-parent-btn" data-nav="${escapeHtml(parent)}">..</button>` : ""}
      <span class="ws-path">${escapeHtml(dir)}</span>
    </div>
  `;

  if (dirs.length === 0) {
    html += `<div class="ws-empty">No subdirectories</div>`;
  } else {
    for (const entry of dirs) {
      html += `
        <div class="ws-entry" data-path="${escapeHtml(entry.path)}">
          <span class="ws-entry-icon dir">&#128193;</span>
          <span class="ws-entry-name">${escapeHtml(entry.name)}</span>
          <button class="ws-entry-select" data-select="${escapeHtml(entry.path)}">select</button>
        </div>
      `;
    }
  }

  workspaceDropdown.innerHTML = html;
  wsDropdownOpen = true;
  workspaceDropdown.classList.add("open");
  workspaceBrowseBtn.classList.add("open");

  workspaceDropdown.querySelectorAll("[data-nav]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      loadDirectory(btn.dataset.nav);
    });
  });

  workspaceDropdown.querySelectorAll(".ws-entry").forEach((el) => {
    el.addEventListener("click", (e) => {
      if (e.target.closest(".ws-entry-select")) return;
      loadDirectory(el.dataset.path);
    });
  });

  workspaceDropdown.querySelectorAll("[data-select]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      selectWorkspace(btn.dataset.select);
    });
  });
}

// ── Marked config ──────────────────────────────
marked.setOptions({ breaks: false, gfm: true });

// ── Auto-resize textarea ───────────────────────
inputEl.addEventListener("input", () => {
  inputEl.style.height = "auto";
  inputEl.style.height = Math.min(inputEl.scrollHeight, 150) + "px";
});

// ── Keyboard shortcuts ─────────────────────────
inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

sendBtn.addEventListener("click", sendMessage);

btnClear.addEventListener("click", async () => {
  messagesEl.innerHTML = "";
  messagesEl.appendChild(welcomeEl);
  welcomeEl.style.display = "flex";

  sessionId = null;
  localStorage.removeItem("coding_agent_session_id");
  updateSessionBadge();
});

function updateSessionBadge() {
  let badge = document.getElementById("session-badge");
  if (!sessionId) {
    if (badge) badge.remove();
    return;
  }
  if (!badge) {
    badge = document.createElement("span");
    badge.id = "session-badge";
    badge.className = "session-badge";
    document.querySelector("header .controls").prepend(badge);
  }
  badge.textContent = `session: ${sessionId.slice(0, 6)}`;
  badge.title = sessionId;
}

if (sessionId) updateSessionBadge();

$$(".hint").forEach((el) => {
  el.addEventListener("click", () => {
    inputEl.value = el.dataset.hint;
    inputEl.dispatchEvent(new Event("input"));
    sendMessage();
  });
});

// ── Scroll helper ──────────────────────────────
function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

// ── Tool icon helper ───────────────────────────
function toolIconClass(name) {
  if (name.includes("edit")) return "write";
  if (name.includes("read")) return "read";
  if (name.includes("write")) return "write";
  if (name.includes("bash") || name.includes("command") || name.includes("run")) return "run";
  if (name.includes("search") || name.includes("explore")) return "search";
  if (name.includes("list")) return "list";
  return "default";
}

function toolIconChar(name) {
  if (name.includes("edit")) return "&#9998;";
  if (name.includes("read")) return "&#128196;";
  if (name.includes("write")) return "&#9998;";
  if (name.includes("bash") || name.includes("command") || name.includes("run")) return "&#9654;";
  if (name.includes("search") || name.includes("explore")) return "&#128269;";
  if (name.includes("list")) return "&#128193;";
  return "&#9881;";
}

function formatArgs(name, args) {
  if (!args) return "";
  if (args.file_path) return args.file_path;
  if (args.path) return args.path;
  if (args.command) return args.command;
  if (args.task) return args.task.slice(0, 60) + (args.task.length > 60 ? "…" : "");
  if (args.pattern) return args.pattern;
  if (args.directory) return args.directory;
  return JSON.stringify(args).slice(0, 80);
}

/** Nested tools: browsers may auto-open <details> when parent becomes visible — force closed like primary agent. */
function sealNestedToolDetails(toolEl) {
  if (
    !toolEl?.classList.contains("tool-call--nested") &&
    !toolEl?.classList.contains("tool-call--nested-orphan")
  ) {
    return;
  }
  toolEl.querySelectorAll("details").forEach((d) => {
    if (d.classList.contains("result-error")) return;
    d.removeAttribute("open");
  });
}

function renderToolArgs(name, args) {
  if (!args) return "";
  if (name === "edit_file" && args.old_string != null && args.new_string != null) {
    return `<div class="edit-diff">
      <div class="diff-del"><span class="diff-label">-</span><pre>${escapeHtml(args.old_string)}</pre></div>
      <div class="diff-add"><span class="diff-label">+</span><pre>${escapeHtml(args.new_string)}</pre></div>
      ${args.file_path ? `<div class="diff-meta">${escapeHtml(args.file_path)}${args.replace_all ? " (replace all)" : ""}</div>` : ""}
    </div>`;
  }
  return `<pre>${escapeHtml(JSON.stringify(args, null, 2))}</pre>`;
}

/** Subagent tools: same DOM + classes as primary `tool-call`, collapsed by default (no .open). */
function appendSubagentToolCallRow(logEl, data) {
  const name = data.name || data.toolName || "";
  const args = data.args ?? data.input ?? {};
  const callId = data.toolCallId || "";

  const wrap = document.createElement("div");
  wrap.className = "tool-call tool-call--nested";
  if (callId) wrap.dataset.toolCallId = callId;

  wrap.innerHTML = `
    <div class="tool-header" onclick="this.parentElement.classList.toggle('open')">
      <span class="chevron">&#9654;</span>
      <span class="tool-icon ${toolIconClass(name)}">${toolIconChar(name)}</span>
      <span class="tool-name">${escapeHtml(name)}</span>
      <span class="tool-args">${escapeHtml(formatArgs(name, args))}</span>
      <span class="tool-status"><div class="spinner"></div></span>
    </div>
    <div class="tool-body">
      <details>
        <summary>Arguments</summary>
        ${renderToolArgs(name, args)}
      </details>
      <div class="tool-result-slot"></div>
    </div>
  `;

  logEl.appendChild(wrap);
  queueMicrotask(() => sealNestedToolDetails(wrap));
}

function appendSubagentToolResultBlock(logEl, data) {
  const name = data.name || data.toolName || "";
  const raw = data.result ?? "";
  const resultStr = typeof raw === "string" ? raw : JSON.stringify(raw, null, 2) ?? "(empty)";
  const isError = resultStr.startsWith("Error:");
  const truncated = resultStr.length > 2000
    ? resultStr.slice(0, 2000) + `\n... (${resultStr.length} chars total)`
    : resultStr;
  const id = data.toolCallId || "";

  const safeId = id && typeof CSS !== "undefined" && CSS.escape ? CSS.escape(id) : id;
  let toolEl =
    (id && logEl.querySelector(`.tool-call--nested[data-tool-call-id="${safeId}"]`)) || null;
  if (!toolEl) {
    const pending = logEl.querySelector(".tool-call--nested:not(.tool-call--nested-done)");
    toolEl = pending || logEl.querySelector(".tool-call--nested:last-of-type");
  }
  if (!toolEl || !toolEl.classList.contains("tool-call")) {
    toolEl = document.createElement("div");
    toolEl.className = "tool-call tool-call--nested tool-call--nested-orphan";
    toolEl.innerHTML = `
      <div class="tool-body">
        <div class="tool-result-slot"></div>
      </div>`;
    logEl.appendChild(toolEl);
  }

  const statusEl = toolEl.querySelector(".tool-status");
  if (statusEl) {
    statusEl.innerHTML = isError
      ? `<span class="tool-error-badge">&#10007;</span>`
      : `<span class="check">&#10003;</span>`;
  }

  const resultSlot = toolEl.querySelector(".tool-result-slot");
  if (resultSlot) {
    resultSlot.innerHTML = `
      <details${isError ? " open" : ""} class="${isError ? "result-error" : ""}">
        <summary>Result (${resultStr.length} chars)</summary>
        <pre>${escapeHtml(truncated)}</pre>
      </details>`;
  }
  if (isError) toolEl.classList.add("has-error");
  toolEl.classList.add("tool-call--nested-done");
  queueMicrotask(() => sealNestedToolDetails(toolEl));
}


// ── Send message ───────────────────────────────
async function sendMessage() {
  const text = inputEl.value.trim();
  if (!text || isStreaming) return;

  welcomeEl.style.display = "none";
  isStreaming = true;
  sendBtn.disabled = true;
  inputEl.value = "";
  inputEl.style.height = "auto";

  // User message
  const userMsg = document.createElement("div");
  userMsg.className = "msg msg-user";
  userMsg.textContent = text;
  messagesEl.appendChild(userMsg);
  scrollToBottom();

  // Assistant message container
  const assistantMsg = document.createElement("div");
  assistantMsg.className = "msg msg-assistant";
  messagesEl.appendChild(assistantMsg);

  // State tracking
  let textBuffer = "";
  let contentEl = null;
  let thinkingEl = null;
  let currentToolEl = null;
  currentStep = 0;

  function showThinking() {
    removeThinking();
    thinkingEl = document.createElement("div");
    thinkingEl.className = "thinking";
    thinkingEl.innerHTML = `
      <div class="dots"><div class="dot"></div><div class="dot"></div><div class="dot"></div></div>
      <span>Step ${currentStep + 1}...</span>
    `;
    assistantMsg.appendChild(thinkingEl);
    scrollToBottom();
  }

  function removeThinking() {
    if (thinkingEl) {
      thinkingEl.remove();
      thinkingEl = null;
    }
  }

  function ensureContentEl() {
    if (!contentEl) {
      removeThinking();
      contentEl = document.createElement("div");
      contentEl.className = "content";
      assistantMsg.appendChild(contentEl);
    }
    return contentEl;
  }

  function renderMarkdown() {
    if (!contentEl || !textBuffer) return;
    contentEl.innerHTML = marked.parse(textBuffer);
    contentEl.querySelectorAll("pre code").forEach((block) => {
      hljs.highlightElement(block);
    });
    scrollToBottom();
  }

  /** Persist streamed assistant text before the first tool in a step (previously tool_call wiped the buffer and dropped this text). */
  function flushReasoningBeforeTool() {
    if (!textBuffer.trim()) return false;
    removeThinking();
    if (contentEl) {
      contentEl.classList.remove("content");
      contentEl.classList.add("reasoning");
      contentEl = null;
    } else {
      const reasoningEl = document.createElement("div");
      reasoningEl.className = "reasoning";
      reasoningEl.innerHTML = marked.parse(textBuffer);
      reasoningEl.querySelectorAll("pre code").forEach((block) => {
        hljs.highlightElement(block);
      });
      assistantMsg.appendChild(reasoningEl);
    }
    textBuffer = "";
    scrollToBottom();
    return true;
  }

  // SSE
  try {
    const res = await fetch("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: text,
        workspace: workspaceInput.value.trim(),
        session_id: sessionId,
      }),
    });


    if (!res.ok) {
      const errText = await res.text();
      ensureContentEl();
      contentEl.innerHTML = `<p style="color:var(--red)">Error: HTTP ${res.status} — ${errText}</p>`;
      isStreaming = false;
      sendBtn.disabled = false;
      return;
    }

    // capture session id if server returns it
    const newSid = res.headers.get("x-session-id");
    if (newSid) {
      sessionId = newSid;
      localStorage.setItem("coding_agent_session_id", sessionId);
    }

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

        // Handle subagent events generically (subagent_*_tool_call, subagent_*_tool_result)
        if (eventType.startsWith("subagent_") && eventType.endsWith("_tool_call")) {
          if (currentToolEl) {
            const logEl = currentToolEl.querySelector(".subagent-log");
            if (logEl) appendSubagentToolCallRow(logEl, data);
          }
          scrollToBottom();
          continue;
        }

        if (eventType.startsWith("subagent_") && eventType.endsWith("_tool_result")) {
          if (currentToolEl && data.result != null) {
            const logEl = currentToolEl.querySelector(".subagent-log");
            if (logEl) appendSubagentToolResultBlock(logEl, data);
          }
          scrollToBottom();
          continue;
        }

        // Handle subagent status events (subagent_*)
        if (eventType.startsWith("subagent_") && !eventType.includes("_tool_")) {
          if (currentToolEl && data.label) {
            const logEl = currentToolEl.querySelector(".subagent-log");
            if (logEl && data.step === 0) {
              const header = document.createElement("div");
              header.className = "subagent-log-banner";
              header.innerHTML = `<span class="subagent-log-banner-pulse"></span><span>${escapeHtml(data.label)}</span>`;
              logEl.appendChild(header);
            }
          }
          scrollToBottom();
          continue;
        }

        switch (eventType) {
          case "session": {
            if (data.session_id) {
              sessionId = data.session_id;
              localStorage.setItem("coding_agent_session_id", sessionId);
              updateSessionBadge();
            }
            break;
          }

          case "step_start":
            currentStep = data.step ?? currentStep;
            showThinking();
            break;

          case "thinking":
            showThinking();
            break;

          case "text_delta":
            removeThinking();
            textBuffer += data.delta;
            ensureContentEl();
            renderMarkdown();
            break;

          case "compaction_start": {
            removeThinking();
            const compactEl = document.createElement("div");
            compactEl.className = "compaction-notice";
            compactEl.id = "compaction-active";
            compactEl.innerHTML = `
              <div class="dots"><div class="dot"></div><div class="dot"></div><div class="dot"></div></div>
              <span>Compacting context (${data.totalMessages} → ${data.keeping} messages)...</span>
            `;
            assistantMsg.appendChild(compactEl);
            scrollToBottom();
            break;
          }

          case "compaction_done": {
            const activeEl = document.getElementById("compaction-active");
            if (activeEl) {
              activeEl.className = "compaction-notice done";
              const summaryPreview = data.summary
                ? `<details><summary>&#10003; Context compacted (${data.summaryLength} chars) — click to view summary</summary><pre class="compaction-summary">${escapeHtml(data.summary)}</pre></details>`
                : `<span>&#10003; Context compacted (summary: ${data.summaryLength} chars)</span>`;
              activeEl.innerHTML = summaryPreview;
            }
            scrollToBottom();
            break;
          }

          case "tool_call": {
            const hadPreface = flushReasoningBeforeTool();
            removeThinking();
            if (!hadPreface && data.name === "explore") {
              const fb = document.createElement("div");
              fb.className = "reasoning reasoning-fallback";
              fb.innerHTML =
                "<p>Exploring the codebase to understand structure and relevant files before changing anything.</p>";
              assistantMsg.appendChild(fb);
              scrollToBottom();
            }

            const toolEl = document.createElement("div");
            const isExplore = data.name === "explore";
            const exArgs = data.args || {};
            const taskLine = (exArgs.task || formatArgs(data.name, exArgs) || "").trim();
            const taskShow = taskLine.length > 220 ? `${taskLine.slice(0, 220)}…` : taskLine;

            toolEl.className = isExplore ? "tool-call tool-call--explore" : "tool-call";
            toolEl.innerHTML = isExplore
              ? `
              <div class="tool-header" onclick="this.parentElement.classList.toggle('open')">
                <span class="chevron">&#9654;</span>
                <span class="tool-icon ${toolIconClass(data.name)}">${toolIconChar(data.name)}</span>
                <span class="tool-name">${escapeHtml(data.name)}</span>
                <span class="tool-args explore-header-preview">${escapeHtml(formatArgs(data.name, data.args))}</span>
                <span class="tool-status"><div class="spinner"></div></span>
              </div>
              <div class="tool-body tool-body--explore">
                <div class="explore-lead">
                  <span class="explore-lead-label">Subagent</span>
                  <p class="explore-lead-text">${escapeHtml(taskShow || "Codebase exploration")}</p>
                </div>
                <div class="subagent-log"></div>
                <div class="tool-result-slot tool-result-slot--explore"></div>
              </div>
            `
              : `
              <div class="tool-header" onclick="this.parentElement.classList.toggle('open')">
                <span class="chevron">&#9654;</span>
                <span class="tool-icon ${toolIconClass(data.name)}">${toolIconChar(data.name)}</span>
                <span class="tool-name">${escapeHtml(data.name)}</span>
                <span class="tool-args">${escapeHtml(formatArgs(data.name, data.args))}</span>
                <span class="tool-status"><div class="spinner"></div></span>
              </div>
              <div class="tool-body">
                <details>
                  <summary>Arguments</summary>
                  ${renderToolArgs(data.name, data.args)}
                </details>
                <div class="subagent-log"></div>
                <div class="tool-result-slot"></div>
              </div>
            `;

            let toolGroup = assistantMsg.querySelector(".tool-group:last-child");
            if (!toolGroup || assistantMsg.lastElementChild !== toolGroup) {
              toolGroup = document.createElement("div");
              toolGroup.className = "tool-group";
              assistantMsg.appendChild(toolGroup);
            }
            toolGroup.appendChild(toolEl);
            if (isExplore) toolEl.classList.add("open");
            currentToolEl = toolEl;
            scrollToBottom();
            break;
          }

          case "tool_result": {
            if (currentToolEl) {
              const raw = data.result ?? "";
              const resultStr = typeof raw === "string" ? raw : JSON.stringify(raw, null, 2) ?? "(empty)";
              const isError = resultStr.startsWith("Error:");
              const truncated = resultStr.length > 2000
                ? resultStr.slice(0, 2000) + `\n... (${resultStr.length} chars total)`
                : resultStr;

              const statusEl = currentToolEl.querySelector(".tool-status");
              statusEl.innerHTML = isError
                ? `<span class="tool-error-badge">&#10007;</span>`
                : `<span class="check">&#10003;</span>`;

              const resultSlot = currentToolEl.querySelector(".tool-result-slot");
              resultSlot.innerHTML = `
                <details${isError ? " open" : ""} class="${isError ? "result-error" : ""}">
                  <summary>Result (${resultStr.length} chars)</summary>
                  <pre>${escapeHtml(truncated)}</pre>
                </details>`;

              if (isError) {
                currentToolEl.classList.add("has-error");
              }
            }
            scrollToBottom();
            break;
          }

          case "error":
            removeThinking();
            ensureContentEl();
            contentEl.innerHTML += `<p style="color:var(--red)">Error: ${escapeHtml(data.message)}</p>`;
            scrollToBottom();
            break;

          case "done":
            removeThinking();
            renderMarkdown();
            updateSessionBadge();
            break;
        }
      }
    }
  } catch (err) {
    removeThinking();
    ensureContentEl();
    contentEl.innerHTML = `<p style="color:var(--red)">Connection error: ${escapeHtml(err.message)}</p>`;
  }

  renderMarkdown();
  isStreaming = false;
  sendBtn.disabled = false;
  inputEl.focus();
  scrollToBottom();
}

function escapeHtml(str) {
  if (!str) return "";
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
