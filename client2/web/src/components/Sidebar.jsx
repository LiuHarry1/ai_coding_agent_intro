import React, { useEffect } from "react";
import { useChatStore } from "../stores/chat-store.js";
import { api } from "../lib/api.js";
import { relativeTime } from "../lib/utils.js";

export default function Sidebar() {
  const sessions = useChatStore((s) => s.sessions);
  const currentSessionId = useChatStore((s) => s.currentSessionId);
  const switchSession = useChatStore((s) => s.switchSession);
  const setSessions = useChatStore((s) => s.setSessions);
  const toggleSidebar = useChatStore((s) => s.toggleSidebar);

  useEffect(() => {
    api.listSessions()
      .then((d) => setSessions(d.sessions || []))
      .catch(() => {});
  }, [setSessions]);

  const refreshList = async () => {
    try {
      const data = await api.listSessions();
      setSessions(data.sessions || []);
    } catch {}
  };

  const handleNewSession = async () => {
    try {
      const data = await api.createSession();
      switchSession(data.session_id);
      await refreshList();
    } catch {}
  };

  const handleDelete = async (id, e) => {
    e.stopPropagation();
    try {
      await api.deleteSession(id);
      await refreshList();
      if (currentSessionId === id) switchSession(null);
    } catch {}
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <span className="sidebar-title">Sessions</span>
        <button className="icon-btn" onClick={toggleSidebar} title="Close sidebar">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      <button className="sidebar-new-btn" onClick={handleNewSession}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
        </svg>
        New session
      </button>

      <div className="sidebar-list">
        {sessions.length === 0 ? (
          <div className="sidebar-empty">No sessions yet</div>
        ) : (
          sessions.map((s) => (
            <div
              key={s.id}
              className={`sidebar-item ${s.id === currentSessionId ? "active" : ""}`}
              onClick={() => switchSession(s.id)}
            >
              <div className="sidebar-item-top">
                <span className={`sidebar-item-title ${!s.preview ? "sidebar-item-title--empty" : ""}`} title={s.preview || "New Chat"}>
                  {s.preview || "New Chat"}
                </span>
                <button className="sidebar-item-delete" onClick={(e) => handleDelete(s.id, e)} title="Delete">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                  </svg>
                </button>
              </div>
              <div className="sidebar-item-meta">
                <span className="sidebar-item-msgs">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                  </svg>
                  {s.messageCount}
                </span>
                <span className="sidebar-item-time">{relativeTime(s.createdAt)}</span>
              </div>
            </div>
          ))
        )}
      </div>
    </aside>
  );
}
