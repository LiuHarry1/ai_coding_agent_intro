import React from "react";
import { useWorkspaceIdeStore } from "../../stores/workspace-ide-store.js";
import { fileName } from "../../lib/utils.js";

export default function EditorTabs() {
  const openFiles = useWorkspaceIdeStore((s) => s.openFiles);
  const activeFile = useWorkspaceIdeStore((s) => s.activeFile);
  const setActiveFile = useWorkspaceIdeStore((s) => s.setActiveFile);
  const closeFile = useWorkspaceIdeStore((s) => s.closeFile);

  if (openFiles.length === 0) return null;

  return (
    <div className="editor-tabs" role="tablist">
      {openFiles.map((p) => (
        <Tab
          key={p}
          path={p}
          isActive={p === activeFile}
          onSelect={() => setActiveFile(p)}
          onClose={() => closeFile(p)}
        />
      ))}
    </div>
  );
}

function Tab({ path, isActive, onSelect, onClose }) {
  // Subscribe to per-file dirty state so unsaved tabs render the • dot
  // even when they're not active.
  const dirty = useWorkspaceIdeStore((s) => Boolean(s.fileContents[path]?.dirty));

  return (
    <div
      role="tab"
      aria-selected={isActive}
      className={`editor-tab ${isActive ? "active" : ""} ${dirty ? "dirty" : ""}`}
      onClick={onSelect}
      title={path}
    >
      <span className="editor-tab-name">
        {dirty && <span className="editor-tab-dot" aria-hidden="true">●</span>}
        {fileName(path)}
      </span>
      <button
        className="editor-tab-close"
        onClick={(e) => { e.stopPropagation(); onClose(); }}
        title={dirty ? "Close (unsaved changes)" : "Close"}
      >
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
  );
}
