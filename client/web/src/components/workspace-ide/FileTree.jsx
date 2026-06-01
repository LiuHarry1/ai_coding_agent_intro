import React, { useEffect, useRef, useState } from "react";
import { useWorkspaceIdeStore } from "../../stores/workspace-ide-store.js";
import { fileName } from "../../lib/utils.js";
import { FolderIcon, FileIcon, NewFileIcon, NewFolderIcon } from "./icons.jsx";

/**
 * Lazy-loading recursive file tree. Each directory's entries are fetched
 * on first expand and cached in `dirCache`. Files are clickable; clicking
 * opens them in the editor tabs.
 *
 * Directories also expose hover actions (+File / +Folder) that trigger an
 * inline input row inside the directory. The actual filesystem write goes
 * through `workspaceApi.createFile / createFolder` from the store.
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
  const beginCreate = useWorkspaceIdeStore((s) => s.beginCreate);
  const pendingNew = useWorkspaceIdeStore((s) => s.pendingNew);

  const name = fileName(dirPath) || dirPath;
  const showInlineRow = pendingNew && pendingNew.parentDir === dirPath;

  const handleAction = (kind) => (e) => {
    e.stopPropagation();
    beginCreate(dirPath, kind);
  };

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
        <span className="tree-actions">
          <button
            className="tree-action-btn"
            onClick={handleAction("file")}
            title="New file"
            tabIndex={-1}
          >
            <NewFileIcon size={12} />
          </button>
          <button
            className="tree-action-btn"
            onClick={handleAction("folder")}
            title="New folder"
            tabIndex={-1}
          >
            <NewFolderIcon size={12} />
          </button>
        </span>
      </div>

      {isExpanded && showInlineRow && (
        <NewEntryRow depth={depth + 1} kind={pendingNew.kind} error={pendingNew.error} />
      )}

      {isExpanded && data && (
        data.entries.length === 0 && !showInlineRow ? (
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
  const isDirty = useWorkspaceIdeStore((s) => Boolean(s.fileContents[entry.path]?.dirty));
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
      <span className="tree-name">
        {isDirty && <span className="tree-dirty-dot" aria-hidden="true">●</span>}
        {entry.name}
      </span>
    </div>
  );
}

/**
 * Inline editable row used for "New File" / "New Folder". The store owns
 * the validation + commit; this component is just an autofocused input
 * with Enter/Esc handlers.
 */
function NewEntryRow({ depth, kind, error }) {
  const commitCreate = useWorkspaceIdeStore((s) => s.commitCreate);
  const cancelCreate = useWorkspaceIdeStore((s) => s.cancelCreate);
  const inputRef = useRef(null);
  const [value, setValue] = useState("");

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const submit = () => {
    if (!value.trim()) { cancelCreate(); return; }
    commitCreate(value);
  };

  return (
    <div
      className={`tree-row tree-new ${error ? "tree-new--error" : ""}`}
      style={{ paddingLeft: 8 + depth * 14 + 12 }}
    >
      <span className="tree-icon tree-icon--file">
        {kind === "folder" ? <FolderIcon /> : <FileIcon />}
      </span>
      <input
        ref={inputRef}
        className="tree-new-input"
        value={value}
        placeholder={kind === "folder" ? "folder name" : "file name"}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); submit(); }
          else if (e.key === "Escape") { e.preventDefault(); cancelCreate(); }
        }}
        onBlur={() => {
          // Blur cancels; committing is Enter-only. Avoids surprise saves
          // when the user clicks elsewhere.
          if (!error) cancelCreate();
        }}
      />
      {error && <span className="tree-new-error" title={error}>{error}</span>}
    </div>
  );
}
