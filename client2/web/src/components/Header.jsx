import React, { useState, useRef, useEffect, useCallback } from "react";
import { useChatStore } from "../stores/chat-store.js";

export default function Header() {
  const workspace = useChatStore((s) => s.workspace);
  const setWorkspace = useChatStore((s) => s.setWorkspace);
  const toggleSidebar = useChatStore((s) => s.toggleSidebar);
  const toggleTheme = useChatStore((s) => s.toggleTheme);
  const theme = useChatStore((s) => s.theme);
  const clearSession = useChatStore((s) => s.clearSession);

  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [dropdownData, setDropdownData] = useState(null);
  const dropdownRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    fetch("/workspace")
      .then((r) => r.json())
      .then((d) => setWorkspace(d.workspace))
      .catch(() => setWorkspace("."));
  }, [setWorkspace]);

  useEffect(() => {
    const handler = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener("click", handler);
    return () => document.removeEventListener("click", handler);
  }, []);

  const loadDirectory = useCallback(async (dir) => {
    try {
      const res = await fetch(`/workspace/list?dir=${encodeURIComponent(dir)}`);
      const data = await res.json();
      setDropdownData(data);
      setWorkspace(data.dir);
      setDropdownOpen(true);
    } catch {
      setDropdownData(null);
    }
  }, [setWorkspace]);

  const handleBrowse = (e) => {
    e.stopPropagation();
    if (dropdownOpen) {
      setDropdownOpen(false);
    } else {
      loadDirectory(workspace || ".");
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      loadDirectory(workspace);
    }
  };

  return (
    <header className="header">
      <div className="header-left">
        <button className="icon-btn sidebar-toggle" onClick={toggleSidebar} title="Toggle sidebar">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="3" y1="6" x2="21" y2="6" />
            <line x1="3" y1="12" x2="21" y2="12" />
            <line x1="3" y1="18" x2="21" y2="18" />
          </svg>
        </button>
        <div className="logo">
          <div className="logo-icon">&#9670;</div>
          <span className="logo-text">Coding Agent</span>
        </div>
      </div>

      <div className="workspace-bar" ref={dropdownRef}>
        <label className="workspace-label" htmlFor="workspace-input">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
          </svg>
        </label>
        <input
          ref={inputRef}
          id="workspace-input"
          className="workspace-input"
          value={workspace}
          onChange={(e) => setWorkspace(e.target.value)}
          onKeyDown={handleKeyDown}
          spellCheck="false"
          autoComplete="off"
          placeholder="loading..."
        />
        <button className={`workspace-browse-btn ${dropdownOpen ? "open" : ""}`} onClick={handleBrowse} title="Browse directories">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>

        {dropdownOpen && dropdownData && (
          <div className="workspace-dropdown open">
            <div className="ws-dropdown-header">
              {dropdownData.parent !== dropdownData.dir && (
                <button className="ws-parent-btn" onClick={(e) => { e.stopPropagation(); loadDirectory(dropdownData.parent); }}>..</button>
              )}
              <span className="ws-path">{dropdownData.dir}</span>
            </div>
            {dropdownData.entries.filter((e) => e.isDir).length === 0 ? (
              <div className="ws-empty">No subdirectories</div>
            ) : (
              dropdownData.entries.filter((e) => e.isDir).map((entry) => (
                <div className="ws-entry" key={entry.path} onClick={() => loadDirectory(entry.path)}>
                  <span className="ws-entry-icon dir">&#128193;</span>
                  <span className="ws-entry-name">{entry.name}</span>
                  <button className="ws-entry-select" onClick={(e) => { e.stopPropagation(); setWorkspace(entry.path); setDropdownOpen(false); }}>select</button>
                </div>
              ))
            )}
          </div>
        )}
      </div>

      <div className="header-right">
        <button className="icon-btn" onClick={toggleTheme} title="Toggle theme">
          {theme === "dark" ? (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="5" /><line x1="12" y1="1" x2="12" y2="3" /><line x1="12" y1="21" x2="12" y2="23" /><line x1="4.22" y1="4.22" x2="5.64" y2="5.64" /><line x1="18.36" y1="18.36" x2="19.78" y2="19.78" /><line x1="1" y1="12" x2="3" y2="12" /><line x1="21" y1="12" x2="23" y2="12" /><line x1="4.22" y1="19.78" x2="5.64" y2="18.36" /><line x1="18.36" y1="5.64" x2="19.78" y2="4.22" /></svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" /></svg>
          )}
        </button>
        <button className="btn-clear" onClick={clearSession}>Clear</button>
      </div>
    </header>
  );
}
