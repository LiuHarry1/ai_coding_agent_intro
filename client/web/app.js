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

btnClear.addEventListener("click", () => {
  messagesEl.innerHTML = "";
  messagesEl.appendChild(welcomeEl);
  welcomeEl.style.display = "flex";
});

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
  if (name.includes("read")) return "read";
  if (name.includes("write")) return "write";
  if (name.includes("command") || name.includes("run")) return "run";
  if (name.includes("search")) return "search";
  if (name.includes("list")) return "list";
  return "default";
}

function toolIconChar(name) {
  if (name.includes("read")) return "&#128196;";
  if (name.includes("write")) return "&#9998;";
  if (name.includes("command") || name.includes("run")) return "&#9654;";
  if (name.includes("search")) return "&#128269;";
  if (name.includes("list")) return "&#128193;";
  return "&#9881;";
}

function formatArgs(name, args) {
  if (!args) return "";
  if (args.path) return args.path;
  if (args.command) return args.command;
  if (args.pattern) return args.pattern;
  if (args.directory) return args.directory;
  return JSON.stringify(args).slice(0, 80);
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

  function showThinking() {
    removeThinking();
    thinkingEl = document.createElement("div");
    thinkingEl.className = "thinking";
    thinkingEl.innerHTML = `
      <div class="dots"><div class="dot"></div><div class="dot"></div><div class="dot"></div></div>
      <span>Thinking...</span>
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

  // SSE
  try {
    const res = await fetch("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text, workspace: workspaceInput.value.trim() }),
    });

    if (!res.ok) {
      const errText = await res.text();
      ensureContentEl();
      contentEl.innerHTML = `<p style="color:var(--red)">Error: HTTP ${res.status} — ${errText}</p>`;
      isStreaming = false;
      sendBtn.disabled = false;
      return;
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

        switch (eventType) {
          case "thinking":
            showThinking();
            break;

          case "text_delta":
            removeThinking();
            textBuffer += data.delta;
            ensureContentEl();
            renderMarkdown();
            break;

          case "tool_call": {
            removeThinking();
            contentEl = null;
            textBuffer = "";

            const toolEl = document.createElement("div");
            toolEl.className = "tool-call";
            toolEl.innerHTML = `
              <div class="tool-header" onclick="this.parentElement.classList.toggle('open')">
                <span class="chevron">&#9654;</span>
                <span class="tool-icon ${toolIconClass(data.name)}">${toolIconChar(data.name)}</span>
                <span class="tool-name">${data.name}</span>
                <span class="tool-args">${escapeHtml(formatArgs(data.name, data.args))}</span>
                <span class="tool-status"><div class="spinner"></div></span>
              </div>
              <div class="tool-body">
                <details open>
                  <summary style="padding:6px 14px;font-size:11px;color:var(--text-muted);cursor:pointer;">Arguments</summary>
                  <pre>${escapeHtml(JSON.stringify(data.args, null, 2))}</pre>
                </details>
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
            currentToolEl = toolEl;
            scrollToBottom();
            break;
          }

          case "tool_result": {
            if (currentToolEl) {
              const statusEl = currentToolEl.querySelector(".tool-status");
              statusEl.innerHTML = `<span class="check">&#10003;</span>`;

              const resultSlot = currentToolEl.querySelector(".tool-result-slot");
              const raw = data.result ?? "";
              const resultStr = typeof raw === "string" ? raw : JSON.stringify(raw, null, 2) ?? "(empty)";
              const truncated = resultStr.length > 2000
                ? resultStr.slice(0, 2000) + `\n... (${resultStr.length} chars total)`
                : resultStr;
              resultSlot.innerHTML = `
                <details>
                  <summary style="padding:6px 14px;font-size:11px;color:var(--text-muted);cursor:pointer;border-top:1px solid var(--border);">Result (${resultStr.length} chars)</summary>
                  <pre>${escapeHtml(truncated)}</pre>
                </details>
              `;
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
