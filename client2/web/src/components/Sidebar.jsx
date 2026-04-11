import React, { useEffect } from "react";
import { useChatStore } from "../stores/chat-store.js";

export default function Sidebar() {
  const sessions = useChatStore((s) => s.sessions);
  const currentSessionId = useChatStore((s) => s.currentSessionId);
  const switchSession = useChatStore((s) => s.switchSession);
  const setSessions = useChatStore((s) => s.setSessions);
  const toggleSidebar = useChatStore((s) => s.toggleSidebar);

  useEffect(() => {
    fetch("/sessions")
      .then((r) => r.json())
      .then((d) => setSessions(d.sessions || []))
      .catch(() => {});
  }, [setSessions]);

  const handleNewSession = async () => {
    try {
      const res = await fetch("/sessions", { method: "POST" });
      const data = await res.json();
      switchSession(data.session_id);
      const listRes = await fetch("/sessions");
      const listData = await listRes.json();
      setSessions(listData.sessions || []);
    } catch {}
  };

  const handleDelete = async (id, e) => {
    e.stopPropagation();
    try {
      await fetch(`/sessions/${id}`, { method: "DELETE" });
      const res = await fetch("/sessions");
      const data = await res.json();
      setSessions(data.sessions || []);
      if (currentSessionId === id) {
        switchSession(null);
      }
    } catch {}
  };

  const formatDate = (ts) => {
    if (!ts) return "";
    const d = new Date(ts);
    return d.toLocaleDateString() + " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
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
                <span className="sidebar-item-id">{s.id.slice(0, 8)}</span>
                <button className="sidebar-item-delete" onClick={(e) => handleDelete(s.id, e)} title="Delete">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                  </svg>
                </button>
              </div>
              <div className="sidebar-item-meta">
                <span>{s.messageCount} msgs</span>
                <span>{formatDate(s.createdAt)}</span>
              </div>
            </div>
          ))
        )}
      </div>
    </aside>
  );
}
