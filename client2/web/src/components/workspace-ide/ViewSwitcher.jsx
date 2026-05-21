import React from "react";
import { useWorkspaceIdeStore } from "../../stores/workspace-ide-store.js";

/**
 * Segmented control at the top of the WorkspaceIDE side panel that swaps
 * between the file Explorer and the git Changes view. Mimics the
 * VSCode activity bar — one button per panel, count badge on Changes.
 */
export default function ViewSwitcher() {
  const activeView = useWorkspaceIdeStore((s) => s.activeView);
  const setActiveView = useWorkspaceIdeStore((s) => s.setActiveView);
  const changeCount = useWorkspaceIdeStore((s) => s.changes.entries.length);

  return (
    <div className="ws-view-switcher" role="tablist" aria-label="Workspace view">
      <button
        role="tab"
        aria-selected={activeView === "explorer"}
        className={`ws-view-tab ${activeView === "explorer" ? "active" : ""}`}
        onClick={() => setActiveView("explorer")}
      >
        Explorer
      </button>
      <button
        role="tab"
        aria-selected={activeView === "changes"}
        className={`ws-view-tab ${activeView === "changes" ? "active" : ""}`}
        onClick={() => setActiveView("changes")}
      >
        Changes
        {changeCount > 0 && <span className="ws-view-badge">{changeCount}</span>}
      </button>
    </div>
  );
}
