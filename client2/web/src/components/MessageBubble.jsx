import React, { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import ToolCallCard from "./ToolCallCard.jsx";

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
  pending: "○",
  in_progress: "◉",
  completed: "✓",
  cancelled: "—",
};

function TodoListCard({ part }) {
  const { todos = [] } = part;
  if (todos.length === 0) return null;

  const completed = todos.filter((t) => t.status === "completed").length;
  const cancelled = todos.filter((t) => t.status === "cancelled").length;
  const hasActive = todos.some((t) => t.status === "in_progress" || t.status === "pending");
  const allDone = !hasActive;
  const total = todos.length;
  const pct = total > 0 ? Math.round(((completed + cancelled) / total) * 100) : 0;

  const [manualToggle, setManualToggle] = useState(null);
  const open = manualToggle !== null ? manualToggle : !allDone;

  return (
    <div className={`todo-card ${allDone ? "todo-done" : ""}`}>
      <button className="todo-header" onClick={() => setManualToggle((v) => v === null ? !open : !v)}>
        <div className="todo-header-left">
          <svg
            className={`todo-arrow ${open ? "open" : ""}`}
            width="12" height="12" viewBox="0 0 24 24"
            fill="none" stroke="currentColor" strokeWidth="2.5"
            strokeLinecap="round" strokeLinejoin="round"
          >
            <polyline points="9 6 15 12 9 18" />
          </svg>
          <span className="todo-title">{allDone ? "Tasks completed" : "Task Progress"}</span>
        </div>
        <span className="todo-count">{completed}/{total}</span>
      </button>
      {open && (
        <ul className="todo-list">
          {todos.map((t) => (
            <li key={t.id} className={`todo-item todo-${t.status}`}>
              <span className={`todo-icon todo-icon-${t.status}`}>
                {STATUS_ICONS[t.status] || "○"}
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
            return <ReasoningBlock key={i} part={part} />;
          case "thinking":
            return <ThinkingDots key={i} step={part.step} />;
          case "tool_group":
            return (
              <div className="tool-group" key={i}>
                {part.items.map((item, j) => {
                  if (item.type === "tool_call") {
                    return <ToolCallCard key={j} part={item} />;
                  }
                  return null;
                })}
              </div>
            );
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
