import React, { useState, useRef, useEffect } from "react";
import DiffViewer from "./DiffViewer.jsx";
import CopyButton from "./CopyButton.jsx";
import { fileName, formatDuration } from "../lib/utils.js";

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

const READ_ONLY_TOOLS = new Set(["read_file", "list_dir", "list_directory", "search", "find", "grep"]);

function isReadOnly(name) {
  if (READ_ONLY_TOOLS.has(name)) return true;
  if (name?.startsWith("read") || name?.startsWith("list")) return true;
  return false;
}

function detectError(name, result) {
  if (!result || typeof result !== "string") return false;
  if (result.startsWith("Error:")) return true;
  const exitMatch = result.match(/\[exit code:\s*(\d+)\]/);
  if (exitMatch && exitMatch[1] !== "0") return true;
  if ((name?.includes("bash") || name?.includes("command") || name?.includes("run")) &&
      /exit code:\s*[1-9]/.test(result)) return true;
  return false;
}

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

function renderToolArgs(name, args) {
  if (!args) return null;
  if (name === "edit_file" && args.old_string != null && args.new_string != null) {
    return <DiffViewer oldStr={args.old_string} newStr={args.new_string} filePath={args.file_path} replaceAll={args.replace_all} />;
  }
  const json = JSON.stringify(args, null, 2);
  return (
    <div className="tool-args-wrap">
      <CopyButton text={json} />
      <pre className="tool-args-json">{json}</pre>
    </div>
  );
}

function LiveTerminal({ output, elapsed, done }) {
  const termRef = useRef(null);

  useEffect(() => {
    if (termRef.current) {
      termRef.current.scrollTop = termRef.current.scrollHeight;
    }
  }, [output]);

  return (
    <div className="live-terminal">
      <div className="live-terminal-header">
        <span className="live-terminal-dot" />
        <span className="live-terminal-title">
          {done ? `Finished in ${elapsed}s` : `Running... ${elapsed}s`}
        </span>
        {!done && <span className="spinner spinner-sm" />}
      </div>
      <pre className="live-terminal-output" ref={termRef}>
        {output || "(waiting for output...)"}
      </pre>
    </div>
  );
}

export default function ToolCallCard({ part }) {
  const hasLiveOutput = part.liveOutput != null;
  const name = part.name || "";
  const args = part.args || {};
  const result = part.result;
  const isError = detectError(name, result);
  const isDone = part.status === "done";
  const duration = formatDuration(part.duration);
  const isExplore = name === "explore";
  const cls = toolIconClass(name);
  const icon = TOOL_ICONS[cls] || TOOL_ICONS.default;

  const defaultExpanded = isExplore || hasLiveOutput || (!isReadOnly(name) && !isDone);
  const [expanded, setExpanded] = useState(defaultExpanded);

  const truncLen = 3000;
  const isLong = result && result.length > truncLen;
  const [showFull, setShowFull] = useState(false);
  const displayResult = isLong && !showFull ? result.slice(0, truncLen) : result;

  const filePath = args.file_path || args.path || null;
  const fName = fileName(filePath);

  useEffect(() => {
    if (hasLiveOutput && !expanded) setExpanded(true);
  }, [hasLiveOutput]);

  return (
    <div className={`tool-card ${expanded ? "open" : ""} ${isExplore ? "tool-card--explore" : ""} ${isError ? "has-error" : ""}`}>
      <div className="tool-card-header" onClick={() => setExpanded(!expanded)}>
        <span className="chevron">{expanded ? "\u25BC" : "\u25B6"}</span>
        <span className={`tool-icon ${cls}`}>{icon}</span>
        <span className="tool-name">{name}</span>
        {fName && <span className="tool-file-badge" title={filePath}>{fName}</span>}
        <span className="tool-args-preview">{!fName ? formatArgs(name, args) : ""}</span>
        <span className="tool-meta">
          {part.liveElapsed && !isDone && (
            <span className="tool-duration tool-duration--live">{part.liveElapsed}s</span>
          )}
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
          {hasLiveOutput && !isDone && (
            <LiveTerminal output={part.liveOutput} elapsed={part.liveElapsed} done={part.liveDone} />
          )}

          <details>
            <summary>Arguments</summary>
            {renderToolArgs(name, args)}
          </details>

          {part.subagentParts && part.subagentParts.length > 0 && (
            <div className="subagent-steps">
              {part.subagentParts.map((sp, i) => (
                <ToolCallCard key={i} part={sp} />
              ))}
            </div>
          )}

          {result != null && (
            <details open={isError} className={isError ? "result-error" : ""}>
              <summary>
                Result
                {isError && <span className="result-error-label">Failed</span>}
                <span className="result-size">
                  {result.length >= 1000
                    ? `${(result.length / 1000).toFixed(1)}k chars`
                    : `${result.length} chars`}
                </span>
              </summary>
              <div className={`tool-result-wrap ${isError ? "tool-result-wrap--error" : ""}`}>
                <CopyButton text={result} />
                <pre className="tool-result-pre">{displayResult}</pre>
                {isLong && (
                  <button className="show-more-btn" onClick={() => setShowFull(!showFull)}>
                    {showFull ? "Show less" : `Show all (${(result.length / 1000).toFixed(1)}k chars)`}
                  </button>
                )}
              </div>
            </details>
          )}
        </div>
      )}
    </div>
  );
}
