import React, { useEffect } from "react";
import { useWorkspaceIdeStore } from "../../stores/workspace-ide-store.js";
import { FolderIcon, FileIcon } from "./icons.jsx";

/**
 * Lazy-loading recursive file tree. Each directory's entries are fetched
 * on first expand and cached in `dirCache`. Files are clickable; clicking
 * opens them in the editor tabs.
 */
export default function FileTree({ rootPath }) {
  const expandDir = useWorkspaceIdeStore((s) => s.expandDir);

  useEffect(() => {
    if (rootPath) expandDir(rootPath);
  }, [rootPath, expandDir]);

  if (!rootPath) return <div className="file-tree-empty">No workspace</div>;

  return (
    <div className="file-tree">
      <DirNode dirPath={rootPath} depth={0} />
    </div>
  );
}

function DirNode({ dirPath, depth }) {
  const data = useWorkspaceIdeStore((s) => s.dirCache[dirPath]);
  const isExpanded = useWorkspaceIdeStore((s) => s.expandedDirs.has(dirPath));
  const toggleDir = useWorkspaceIdeStore((s) => s.toggleDir);

  const name = dirPath.split("/").filter(Boolean).pop() || dirPath;

  return (
    <>
      <div
        className="tree-row tree-dir"
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={() => toggleDir(dirPath)}
      >
        <svg
          className={`tree-chevron ${isExpanded ? "open" : ""}`}
          width="10" height="10" viewBox="0 0 24 24"
          fill="none" stroke="currentColor" strokeWidth="2.5"
          strokeLinecap="round" strokeLinejoin="round"
        >
          <polyline points="9 6 15 12 9 18" />
        </svg>
        <span className="tree-icon tree-icon--dir">
          <FolderIcon open={isExpanded} />
        </span>
        <span className="tree-name">{name}</span>
      </div>

      {isExpanded && data && (
        data.entries.length === 0 ? (
          <div className="tree-row tree-empty" style={{ paddingLeft: 8 + (depth + 1) * 14 }}>
            (empty)
          </div>
        ) : (
          data.entries.map((entry) =>
            entry.isDir ? (
              <DirNode key={entry.path} dirPath={entry.path} depth={depth + 1} />
            ) : (
              <FileRow key={entry.path} entry={entry} depth={depth + 1} />
            )
          )
        )
      )}
      {isExpanded && !data && (
        <div className="tree-row tree-loading" style={{ paddingLeft: 8 + (depth + 1) * 14 }}>
          Loading…
        </div>
      )}
    </>
  );
}

function FileRow({ entry, depth }) {
  const isActive = useWorkspaceIdeStore((s) => s.activeFile === entry.path);
  const openFile = useWorkspaceIdeStore((s) => s.openFile);

  return (
    <div
      className={`tree-row tree-file ${isActive ? "active" : ""}`}
      style={{ paddingLeft: 8 + depth * 14 + 12 /* chevron gutter */ }}
      onClick={() => openFile(entry.path)}
      title={entry.path}
    >
      <span className="tree-icon tree-icon--file">
        <FileIcon />
      </span>
      <span className="tree-name">{entry.name}</span>
    </div>
  );
}
