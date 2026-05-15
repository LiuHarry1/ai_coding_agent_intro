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
        <div
          key={p}
          role="tab"
          aria-selected={p === activeFile}
          className={`editor-tab ${p === activeFile ? "active" : ""}`}
          onClick={() => setActiveFile(p)}
          title={p}
        >
          <span className="editor-tab-name">{fileName(p)}</span>
          <button
            className="editor-tab-close"
            onClick={(e) => { e.stopPropagation(); closeFile(p); }}
            title="Close"
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      ))}
    </div>
  );
}
