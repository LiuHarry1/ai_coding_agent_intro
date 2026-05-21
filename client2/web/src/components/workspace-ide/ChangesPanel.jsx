import React, { useEffect, useMemo } from "react";
import { useWorkspaceIdeStore } from "../../stores/workspace-ide-store.js";
import { fileName } from "../../lib/utils.js";

/**
 * "Changes" view body: header (branch + summary) + file list grouped by
 * directory. Clicking a row opens a diff tab in the editor area.
 */
export default function ChangesPanel() {
  const changes = useWorkspaceIdeStore((s) => s.changes);
  const refreshChanges = useWorkspaceIdeStore((s) => s.refreshChanges);
  const openDiff = useWorkspaceIdeStore((s) => s.openDiff);
  const activeDiff = useWorkspaceIdeStore((s) => s.activeDiff);
  const activeKind = useWorkspaceIdeStore((s) => s.activeKind);

  useEffect(() => {
    if (!changes.lastFetchedAt && !changes.loading) refreshChanges();
    // We intentionally only fire once on mount; subsequent refreshes are
    // driven by the manual refresh button and chat-store stream-done.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const groups = useMemo(() => groupByDir(changes.entries), [changes.entries]);

  if (changes.loading && changes.entries.length === 0) {
    return <div className="changes-panel-msg">Loading changes…</div>;
  }
  if (changes.error) {
    return (
      <div className="changes-panel-msg changes-panel-msg--error">
        Failed to load: {changes.error}
        <button className="link-btn" onClick={refreshChanges}>Retry</button>
      </div>
    );
  }
  if (!changes.isGitRepo) {
    return (
      <div className="changes-panel-msg">
        <div className="changes-panel-empty-title">Not a git repository</div>
        <div className="changes-panel-empty-hint">
          Initialize git in this workspace to track changes here.
        </div>
      </div>
    );
  }
  if (changes.entries.length === 0) {
    return (
      <div className="changes-panel-msg">
        <div className="changes-panel-empty-title">No changes</div>
        <div className="changes-panel-empty-hint">
          Working tree matches <code>{changes.branch || "HEAD"}</code>.
        </div>
      </div>
    );
  }

  return (
    <div className="changes-panel">
      <div className="changes-panel-head">
        <div className="changes-panel-branch">
          <BranchIcon />
          <span title={changes.branch || ""}>{changes.branch || "(detached)"}</span>
        </div>
        <button
          className="icon-btn"
          onClick={refreshChanges}
          title="Refresh"
          disabled={changes.loading}
        >
          <RefreshIcon />
        </button>
      </div>

      <div className="changes-panel-list">
        {groups.map(({ dir, items }) => (
          <div key={dir} className="changes-group">
            {dir && <div className="changes-group-dir" title={dir}>{dir}</div>}
            {items.map((e) => (
              <ChangeRow
                key={e.path}
                entry={e}
                active={activeKind === "diff" && activeDiff === e.path}
                onOpen={() => openDiff(e.path)}
              />
            ))}
          </div>
        ))}
      </div>

      <div className="changes-panel-foot">
        <span>{changes.totals.files} file{changes.totals.files === 1 ? "" : "s"}</span>
        <span className="changes-foot-sep">·</span>
        <span className="changes-foot-ins">+{changes.totals.insertions}</span>
        <span className="changes-foot-del">−{changes.totals.deletions}</span>
      </div>
    </div>
  );
}

function ChangeRow({ entry, active, onOpen }) {
  const sig = STATUS_META[entry.status] || STATUS_META.modified;
  const label = entry.status === "renamed" && entry.oldPath
    ? `${fileName(entry.oldPath)} → ${fileName(entry.path)}`
    : fileName(entry.path);
  return (
    <button
      type="button"
      className={`change-row ${active ? "active" : ""}`}
      onClick={onOpen}
      title={entry.path}
    >
      <span className={`change-status change-status--${entry.status}`} title={sig.label}>
        {sig.letter}
      </span>
      <span className="change-name">{label}</span>
      <span className="change-meta">
        {entry.isBinary ? (
          <span className="change-binary">bin</span>
        ) : (
          <>
            {entry.insertions > 0 && <span className="change-ins">+{entry.insertions}</span>}
            {entry.deletions > 0 && <span className="change-del">−{entry.deletions}</span>}
          </>
        )}
      </span>
    </button>
  );
}

const STATUS_META = {
  modified:  { letter: "M", label: "Modified" },
  added:     { letter: "A", label: "Added" },
  deleted:   { letter: "D", label: "Deleted" },
  untracked: { letter: "U", label: "Untracked" },
  renamed:   { letter: "R", label: "Renamed" },
};

/** Group entries by their parent directory (relative). Keeps original order. */
function groupByDir(entries) {
  const out = [];
  const byDir = new Map();
  for (const e of entries) {
    const slash = e.path.lastIndexOf("/");
    const dir = slash >= 0 ? e.path.slice(0, slash) : "";
    if (!byDir.has(dir)) {
      byDir.set(dir, []);
      out.push({ dir, items: byDir.get(dir) });
    }
    byDir.get(dir).push(e);
  }
  return out;
}

function BranchIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M9.5 3.25a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.493 2.493 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25Zm-6 0a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Zm8.25-.75a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM4.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z" />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="23 4 23 10 17 10" />
      <polyline points="1 20 1 14 7 14" />
      <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
    </svg>
  );
}
