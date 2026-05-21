import React from "react";
import DiffViewer from "../DiffViewer.jsx";
import { useWorkspaceIdeStore } from "../../stores/workspace-ide-store.js";
import { fileName } from "../../lib/utils.js";

/**
 * Right-side body when the active editor tab is a `diff`. Pulls
 * old/new content from the store's diff cache and delegates to the
 * shared <DiffViewer>.
 */
export default function DiffView() {
  const relPath = useWorkspaceIdeStore((s) => s.activeDiff);
  const diff = useWorkspaceIdeStore((s) => (relPath ? s.diffs[relPath] : null));
  const openFile = useWorkspaceIdeStore((s) => s.openFile);
  const rootPath = useWorkspaceIdeStore((s) => s.rootPath);

  if (!relPath) return null;
  if (!diff || diff.loading) return <div className="editor-loading">Loading diff…</div>;
  if (diff.error) {
    return <div className="editor-error">Failed to load diff: {diff.error}</div>;
  }
  if (diff.isBinary) {
    return (
      <div className="editor-error">
        Binary file changed — content not previewable.
      </div>
    );
  }

  const name = fileName(relPath);
  const absPath = rootPath ? `${rootPath.replace(/\/$/, "")}/${relPath}` : null;
  const stats = computeStats(diff.oldContent, diff.newContent);

  return (
    <div className="diff-view-wrap">
      <div className="diff-view-head">
        <span className="diff-view-status" data-status={diff.status}>{statusLetter(diff.status)}</span>
        <span className="diff-view-name" title={relPath}>{name}</span>
        <span className="diff-view-path" title={relPath}>{relPath}</span>
        <span className="diff-view-spacer" />
        {stats.ins > 0 && <span className="diff-view-ins">+{stats.ins}</span>}
        {stats.del > 0 && <span className="diff-view-del">−{stats.del}</span>}
        {diff.truncated && <span className="diff-view-warn">truncated</span>}
        {absPath && diff.status !== "deleted" && (
          <button
            className="link-btn"
            onClick={() => openFile(absPath)}
            title="Open the current working-tree version in an editor tab"
          >
            Open file
          </button>
        )}
      </div>
      <div className="diff-view-body">
        <DiffViewer
          oldStr={diff.oldContent || ""}
          newStr={diff.newContent || ""}
          filePath={relPath}
          embedded
        />
      </div>
    </div>
  );
}

function statusLetter(s) {
  switch (s) {
    case "added": return "A";
    case "deleted": return "D";
    case "untracked": return "U";
    case "renamed": return "R";
    default: return "M";
  }
}

function computeStats(oldStr, newStr) {
  // Cheap line-count delta — the diff library does its own LCS for the
  // actual highlight; here we just want a header summary.
  const a = (oldStr || "").split("\n").length;
  const b = (newStr || "").split("\n").length;
  if (b >= a) return { ins: b - a, del: 0 };
  return { ins: 0, del: a - b };
}
