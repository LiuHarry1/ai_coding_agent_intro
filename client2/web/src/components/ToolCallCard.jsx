import React, { useState } from "react";
import DiffViewer from "./DiffViewer.jsx";

function escapeHtml(str) {
  if (!str) return "";
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function toolIconClass(name) {
  if (name?.includes("edit")) return "write";
  if (name?.includes("read")) return "read";
  if (name?.includes("write")) return "write";
  if (name?.includes("bash") || name?.includes("command") || name?.includes("run")) return "run";
  if (name?.includes("search") || name?.includes("explore")) return "search";
  if (name?.includes("list")) return "list";
  return "default";
}

const TOOL_ICONS = {
  read: "\u{1F4C4}", write: "\u270E", run: "\u25B6", search: "\u{1F50D}", list: "\u{1F4C1}", default: "\u2699",
};

function formatArgs(name, args) {
  if (!args) return "";
  if (args.file_path) return args.file_path;
  if (args.path) return args.path;
  if (args.command) return args.command;
  if (args.task) return args.task.slice(0, 80) + (args.task.length > 80 ? "\u2026" : "");
  if (args.pattern) return args.pattern;
  if (args.directory) return args.directory;
  return JSON.stringify(args).slice(0, 80);
}

function formatDuration(ms) {
  if (!ms) return null;
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function renderToolArgs(name, args) {
  if (!args) return null;
  if (name === "edit_file" && args.old_string != null && args.new_string != null) {
    return <DiffViewer oldStr={args.old_string} newStr={args.new_string} filePath={args.file_path} replaceAll={args.replace_all} />;
  }
  return <pre className="tool-args-json">{JSON.stringify(args, null, 2)}</pre>;
}

export default function ToolCallCard({ part }) {
  const [expanded, setExpanded] = useState(part.name === "explore");
  const name = part.name || "";
  const args = part.args || {};
  const result = part.result;
  const isError = typeof result === "string" && result.startsWith("Error:");
  const isDone = part.status === "done";
  const duration = formatDuration(part.duration);
  const isExplore = name === "explore";
  const cls = toolIconClass(name);
  const icon = TOOL_ICONS[cls] || TOOL_ICONS.default;

  const truncatedResult = result && result.length > 3000
    ? result.slice(0, 3000) + `\n... (${result.length} chars total)`
    : result;

  return (
    <div className={`tool-card ${expanded ? "open" : ""} ${isExplore ? "tool-card--explore" : ""} ${isError ? "has-error" : ""}`}>
      <div className="tool-card-header" onClick={() => setExpanded(!expanded)}>
        <span className="chevron">{expanded ? "\u25BC" : "\u25B6"}</span>
        <span className={`tool-icon ${cls}`}>{icon}</span>
        <span className="tool-name">{name}</span>
        <span className="tool-args-preview">{formatArgs(name, args)}</span>
        <span className="tool-meta">
          {duration && <span className="tool-duration">{duration}</span>}
          {isDone ? (
            isError ? <span className="tool-error-badge">&#10007;</span> : <span className="tool-check">&#10003;</span>
          ) : (
            <span className="spinner" />
          )}
        </span>
      </div>

      {expanded && (
        <div className="tool-card-body">
          <details>
            <summary>Arguments</summary>
            {renderToolArgs(name, args)}
          </details>

          {part.subagentParts && part.subagentParts.length > 0 && (
            <div className="subagent-log">
              {part.subagentParts.map((sp, i) => (
                <div key={i} className="subagent-entry">{JSON.stringify(sp)}</div>
              ))}
            </div>
          )}

          {result != null && (
            <details open={isError} className={isError ? "result-error" : ""}>
              <summary>Result ({result.length} chars)</summary>
              <pre className="tool-result-pre">{truncatedResult}</pre>
            </details>
          )}
        </div>
      )}
    </div>
  );
}
