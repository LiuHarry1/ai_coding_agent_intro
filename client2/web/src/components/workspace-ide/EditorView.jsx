import React, { useMemo } from "react";
import { useWorkspaceIdeStore } from "../../stores/workspace-ide-store.js";
import { useChatStore } from "../../stores/chat-store.js";
import CopyButton from "../CopyButton.jsx";
import { languageLabel, buildBreadcrumb } from "./helpers.js";

/**
 * Read-only file viewer used inside the WorkspaceIDE. Renders the active
 * file with a breadcrumb, code body with line-number gutter, and a
 * status bar. Handles loading / error / binary / truncated states.
 */
export default function EditorView() {
  const activeFile = useWorkspaceIdeStore((s) => s.activeFile);
  const data = useWorkspaceIdeStore((s) =>
    activeFile ? s.fileContents[activeFile] : null
  );
  const workspace = useChatStore((s) => s.workspace);

  if (!activeFile) return <EmptyState />;
  if (!data || data.loading) return <div className="editor-loading">Loading…</div>;
  if (data.error) return <div className="editor-error">Failed to load: {data.error}</div>;
  if (data.isBinary) {
    return (
      <div className="editor-error">
        Binary file ({data.size.toLocaleString()} bytes) — not previewable.
      </div>
    );
  }

  return <FileBody filePath={activeFile} data={data} workspace={workspace} />;
}

function EmptyState() {
  return (
    <div className="editor-empty">
      <div className="editor-empty-icon">{"\u{1F4C2}"}</div>
      <div className="editor-empty-title">No file open</div>
      <div className="editor-empty-hint">
        Pick a file from the tree on the left to preview it.
      </div>
    </div>
  );
}

function FileBody({ filePath, data, workspace }) {
  const text = data.content || "";

  const { gutter, charCount, lineCount } = useMemo(() => {
    const ls = text.split("\n");
    const lastEmpty = ls.length > 0 && ls[ls.length - 1] === "";
    return {
      gutter: Array.from({ length: ls.length }, (_, i) => i + 1).join("\n"),
      charCount: text.length,
      lineCount: lastEmpty ? ls.length - 1 : ls.length,
    };
  }, [text]);

  const crumbs = useMemo(
    () => buildBreadcrumb(filePath, workspace),
    [filePath, workspace]
  );

  return (
    <div className="editor-body-wrap">
      <Breadcrumb crumbs={crumbs} />
      <div className="editor-body">
        <pre className="editor-gutter" aria-hidden="true">{gutter}</pre>
        <pre className="editor-code">{text}</pre>
      </div>
      <StatusBar
        filePath={filePath}
        text={text}
        lineCount={lineCount}
        charCount={charCount}
        size={data.size}
        truncated={data.truncated}
      />
    </div>
  );
}

function Breadcrumb({ crumbs }) {
  return (
    <div className="editor-breadcrumb">
      {crumbs.map((c, i) => (
        <React.Fragment key={i}>
          {i > 0 && <span className="editor-breadcrumb-sep">›</span>}
          <span className={`editor-breadcrumb-item ${i === crumbs.length - 1 ? "leaf" : ""}`}>{c}</span>
        </React.Fragment>
      ))}
    </div>
  );
}

function StatusBar({ filePath, text, lineCount, charCount, size, truncated }) {
  return (
    <div className="editor-statusbar">
      <span>{lineCount.toLocaleString()} lines</span>
      <span>{charCount.toLocaleString()} chars</span>
      <span className="editor-statusbar-sep">·</span>
      <span>{languageLabel(filePath)}</span>
      <span className="editor-statusbar-sep">·</span>
      <span>UTF-8</span>
      {truncated && (
        <>
          <span className="editor-statusbar-sep">·</span>
          <span className="editor-statusbar-warn">
            truncated ({(size / 1024).toFixed(0)} KB total)
          </span>
        </>
      )}
      <span className="editor-statusbar-spacer" />
      <span className="editor-statusbar-lock">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" />
        </svg>
        Read-only
      </span>
      <CopyButton text={text} label="Copy" inline />
    </div>
  );
}
