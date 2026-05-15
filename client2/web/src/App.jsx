import React, { useEffect } from "react";
import { useChatStore } from "./stores/chat-store.js";
import { useWorkspaceIdeStore } from "./stores/workspace-ide-store.js";
import Header from "./components/Header.jsx";
import ChatView from "./components/ChatView.jsx";
import InputArea from "./components/InputArea.jsx";
import WorkspaceIDE from "./components/workspace-ide/index.js";

export default function App() {
  const theme = useChatStore((s) => s.theme);
  const syncHljs = useChatStore((s) => s.syncHljs);
  const currentSessionId = useChatStore((s) => s.currentSessionId);
  const switchSession = useChatStore((s) => s.switchSession);
  const workspaceIdeOpen = useWorkspaceIdeStore((s) => s.open);

  useEffect(() => { syncHljs(); }, [theme]);

  useEffect(() => {
    if (currentSessionId) switchSession(currentSessionId);
  }, []);

  return (
    <div className={`app ${theme}`} data-theme={theme}>
      <WorkspaceIDE />
      <div className={`main-panel ${workspaceIdeOpen ? "with-ide" : ""}`}>
        <Header />
        <ChatView />
        <InputArea />
      </div>
    </div>
  );
}
