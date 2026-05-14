import React, { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import ToolCallCard from "./ToolCallCard.jsx";
import FileChangeCard from "./FileChangeCard.jsx";
import ReadFileCard from "./ReadFileCard.jsx";
import ListDirCard from "./ListDirCard.jsx";
import BashCard from "./BashCard.jsx";
import WebSearchCard from "./WebSearchCard.jsx";
import SubagentCard from "./SubagentCard.jsx";

// Tool-name → dedicated card component. Subagent dispatch is handled
// separately because `isSubagent` is a flag rather than a fixed name —
// any registered subagent (explore, plan, custom) should route to
// SubagentCard regardless of its tool name.
const TOOL_CARDS = {
  write_file: FileChangeCard,
  edit_file: FileChangeCard,
  read_file: ReadFileCard,
  list_dir: ListDirCard,
  bash: BashCard,
  web_search: WebSearchCard,
};

// Tools that render via a non-tool-card path elsewhere (e.g. TodoListCard
// from the `todo_list` part type). Drop the duplicate tool_call row.
const SUPPRESSED_TOOL_CARDS = new Set(["todo_write"]);

function pickCard(item) {
  if (item.isSubagent) return SubagentCard;
  return TOOL_CARDS[item.name] || ToolCallCard;
}

function ThinkingDots() {
  return (
    <div className="thinking-indicator">
      <div className="dot" /><div className="dot" /><div className="dot" />
      <span>Thinking...</span>
    </div>
  );
}

function ReasoningBlock({ part }) {
  const [open, setOpen] = useState(false);
  const isStreaming = part.status === "streaming";

  const label = isStreaming
    ? "Thinking..."
    : `Thought for ${part.duration ?? 0}s`;

  return (
    <div className={`reasoning-block ${isStreaming ? "streaming" : "done"}`}>
      <button className="reasoning-toggle" onClick={() => setOpen((v) => !v)}>
        <svg
          className={`reasoning-arrow ${open ? "open" : ""}`}
          width="12" height="12" viewBox="0 0 24 24"
          fill="none" stroke="currentColor" strokeWidth="2.5"
          strokeLinecap="round" strokeLinejoin="round"
        >
          <polyline points="9 6 15 12 9 18" />
        </svg>
        <span className="reasoning-label">
          {isStreaming && <span className="reasoning-pulse" />}
          {label}
        </span>
      </button>
      {(open || isStreaming) && part.content && (
        <div className="reasoning-content">
          <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
            {part.content}
          </ReactMarkdown>
        </div>
      )}
    </div>
  );
}

function CompactionNotice({ part }) {
  if (part.type === "compaction_start") {
    return (
      <div className="compaction-notice">
        <div className="dot" /><div className="dot" /><div className="dot" />
        <span>Compacting context ({part.totalMessages} &rarr; {part.keeping} messages)...</span>
      </div>
    );
  }
  return (
    <div className="compaction-notice done">
      <details>
        <summary>&#10003; Context compacted ({part.summaryLength} chars)</summary>
        <pre className="compaction-summary">{part.summary}</pre>
      </details>
    </div>
  );
}

const STATUS_ICONS = {
  pending: "□",
  in_progress: "▸",
  completed: "☑",
  cancelled: "☒",
};

function TodoListCard({ part }) {
  const { todos = [] } = part;
  if (todos.length === 0) return null;

  const completed = todos.filter((t) => t.status === "completed").length;
  const cancelled = todos.filter((t) => t.status === "cancelled").length;
  const inProgress = todos.find((t) => t.status === "in_progress");
  const hasActive = todos.some((t) => t.status === "in_progress" || t.status === "pending");
  const allDone = !hasActive;
  const total = todos.length;
  const done = completed + cancelled;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  const [manualToggle, setManualToggle] = useState(null);
  const open = manualToggle !== null ? manualToggle : !allDone;

  let headerIcon, headerText;
  if (allDone) {
    headerIcon = "☑";
    headerText = `All ${total} tasks complete`;
  } else if (inProgress) {
    headerIcon = "▸";
    headerText = inProgress.content;
  } else {
    headerIcon = "□";
    headerText = "Tasks";
  }

  return (
    <div className={`todo-card ${allDone ? "todo-done" : ""} ${inProgress ? "todo-active" : ""}`}>
      <button
        className="todo-header"
        onClick={() => setManualToggle((v) => (v === null ? !open : !v))}
      >
        <div className="todo-header-left">
          <svg
            className={`todo-arrow ${open ? "open" : ""}`}
            width="12" height="12" viewBox="0 0 24 24"
            fill="none" stroke="currentColor" strokeWidth="2.5"
            strokeLinecap="round" strokeLinejoin="round"
          >
            <polyline points="9 6 15 12 9 18" />
          </svg>
          <span className={`todo-header-icon todo-icon-${allDone ? "completed" : inProgress ? "in_progress" : "pending"}`}>
            {headerIcon}
          </span>
          <span className="todo-title">{headerText}</span>
        </div>
        <span className="todo-count">
          <span className="todo-count-done">{done}</span>
          <span className="todo-count-sep">/</span>
          <span className="todo-count-total">{total}</span>
        </span>
      </button>
      {open && (
        <ul className="todo-list">
          {todos.map((t) => (
            <li key={t.id} className={`todo-item todo-${t.status}`}>
              <span className={`todo-icon todo-icon-${t.status}`}>
                {STATUS_ICONS[t.status] || "□"}
              </span>
              <span className="todo-content">{t.content}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="todo-progress">
        <div className="todo-progress-bar">
          <div className="todo-progress-fill" style={{ width: `${pct}%` }} />
        </div>
      </div>
    </div>
  );
}

function ErrorBlock({ message }) {
  return <p className="error-text">Error: {message}</p>;
}

export default function MessageBubble({ message }) {
  const [lightbox, setLightbox] = useState(null);

  if (message.type === "user") {
    return (
      <div className="msg msg-user">
        {message.images && message.images.length > 0 && (
          <div className="msg-user-images">
            {message.images.map((src, i) => (
              <img key={i} src={src} alt={`Attachment ${i + 1}`} className="msg-user-img" onClick={() => setLightbox(src)} />
            ))}
          </div>
        )}
        {message.content}
        {lightbox && (
          <div className="lightbox" onClick={() => setLightbox(null)}>
            <img src={lightbox} alt="Preview" />
          </div>
        )}
      </div>
    );
  }

  if (message.type !== "assistant") return null;

  const { parts = [] } = message;

  const groupedParts = [];
  let currentToolGroup = null;

  for (const part of parts) {
    if (part.type === "tool_call") {
      if (!currentToolGroup) {
        currentToolGroup = { type: "tool_group", items: [] };
        groupedParts.push(currentToolGroup);
      }
      currentToolGroup.items.push(part);
    } else {
      currentToolGroup = null;
      groupedParts.push(part);
    }
  }

  return (
    <div className="msg msg-assistant">
      {groupedParts.map((part, i) => {
        switch (part.type) {
          case "text":
            return (
              <div className="content" key={i}>
                <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
                  {part.content}
                </ReactMarkdown>
              </div>
            );
          case "reasoning":
            // Skip empty 0-second reasoning blocks — pure noise. We still
            // render them while they're streaming (no duration yet) so the
            // user gets the live "Thinking…" indicator.
            if (
              part.status !== "streaming" &&
              (!part.content || part.content.trim() === "") &&
              (!part.duration || part.duration === 0)
            ) return null;
            return <ReasoningBlock key={i} part={part} />;
          case "thinking":
            return <ThinkingDots key={i} step={part.step} />;
          case "tool_group": {
            const visibleItems = part.items.filter(
              (it) => it.type === "tool_call" && !SUPPRESSED_TOOL_CARDS.has(it.name)
            );
            if (visibleItems.length === 0) return null;
            return (
              <div className="tool-group" key={i}>
                {visibleItems.map((item, j) => {
                  const Card = pickCard(item);
                  return <Card key={j} part={item} />;
                })}
              </div>
            );
          }
          case "todo_list":
            return <TodoListCard key={i} part={part} />;
          case "compaction_start":
          case "compaction_done":
            return <CompactionNotice key={i} part={part} />;
          case "error":
            return <ErrorBlock key={i} message={part.message} />;
          default:
            return null;
        }
      })}
    </div>
  );
}
