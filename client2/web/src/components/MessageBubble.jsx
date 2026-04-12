import React, { useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import ToolCallCard from "./ToolCallCard.jsx";
import DiffViewer from "./DiffViewer.jsx";

function escapeHtml(str) {
  if (!str) return "";
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function ThinkingDots() {
  return (
    <div className="thinking-indicator">
      <div className="dot" /><div className="dot" /><div className="dot" />
      <span>Thinking...</span>
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
    if (part.type === "tool_call" || part.type === "subagent_tool_call" || part.type === "subagent_tool_result" || part.type === "subagent_status") {
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
                <ReactMarkdown rehypePlugins={[rehypeHighlight]}>
                  {part.content}
                </ReactMarkdown>
              </div>
            );
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
