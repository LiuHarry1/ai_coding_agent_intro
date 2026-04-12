import React, { useEffect } from "react";
import { useChatStore } from "./stores/chat-store.js";
import Header from "./components/Header.jsx";
import Sidebar from "./components/Sidebar.jsx";
import ChatView from "./components/ChatView.jsx";
import InputArea from "./components/InputArea.jsx";

export default function App() {
  const sidebarOpen = useChatStore((s) => s.sidebarOpen);
  const theme = useChatStore((s) => s.theme);
  const syncHljs = useChatStore((s) => s.syncHljs);
  const currentSessionId = useChatStore((s) => s.currentSessionId);
  const switchSession = useChatStore((s) => s.switchSession);

  useEffect(() => { syncHljs(); }, [theme]);

  useEffect(() => {
    if (currentSessionId) switchSession(currentSessionId);
  }, []);

  return (
    <div className={`app ${theme}`} data-theme={theme}>
      {sidebarOpen && <Sidebar />}
      <div className="main-panel">
        <Header />
        <ChatView />
        <InputArea />
      </div>
    </div>
  );
}
