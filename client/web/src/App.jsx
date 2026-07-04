import React, { useEffect } from 'react'
import { useChatStore } from './stores/chat-store.js'
import { useWorkspaceIdeStore } from './stores/workspace-ide-store.js'
import Header from './components/Header.jsx'
import ChatView from './components/ChatView.jsx'
import InputArea from './components/InputArea.jsx'
import WorkspaceIDE from './components/workspace-ide/index.js'

export default function App() {
  const theme = useChatStore(s => s.theme)
  const syncHljs = useChatStore(s => s.syncHljs)
  const currentSessionId = useChatStore(s => s.currentSessionId)
  const switchSession = useChatStore(s => s.switchSession)
  const chatWorkspace = useChatStore(s => s.workspace)
  const workspaceIdeOpen = useWorkspaceIdeStore(s => s.open)
  const setIdeRootPath = useWorkspaceIdeStore(s => s.setRootPath)

  useEffect(() => {
    syncHljs()
  }, [theme])

  useEffect(() => {
    if (currentSessionId) switchSession(currentSessionId)
  }, [])

  // Bridge: chat owns "current cwd", IDE just needs *some* root to display.
  // The IDE module never imports chat-store; this is the one place that
  // knows about both.
  useEffect(() => {
    setIdeRootPath(chatWorkspace)
  }, [chatWorkspace, setIdeRootPath])

  // Warn before unload if any open file has unsaved edits. Reads the
  // store imperatively (no re-render needed for this side-effect-only listener).
  useEffect(() => {
    const handler = e => {
      const { fileContents } = useWorkspaceIdeStore.getState()
      const hasDirty = Object.values(fileContents).some(f => f && f.dirty)
      if (hasDirty) {
        e.preventDefault()
        e.returnValue = ''
      }
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [])

  return (
    <div className={`app ${theme}`} data-theme={theme}>
      <WorkspaceIDE />
      <div className={`main-panel ${workspaceIdeOpen ? 'with-ide' : ''}`}>
        <Header />
        <ChatView />
        <InputArea />
      </div>
    </div>
  )
}
