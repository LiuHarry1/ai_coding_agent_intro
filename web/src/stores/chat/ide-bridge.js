/**
 * Chat → workspace-IDE side effects.
 * Kept out of the SSE mutators so transcript reduce stays free of IDE imports
 * except through this narrow bridge.
 */
import { useWorkspaceIdeStore } from '../workspace-ide-store.js'

export function notifyIdeFilesystemFromTool(toolName, args, result) {
  try {
    useWorkspaceIdeStore
      .getState()
      .onAgentToolFilesystemChange(toolName, args, result)
  } catch {
    // workspace IDE store not initialized — ignore
  }
}

export function refreshIdeAfterAgentTurn() {
  try {
    const ideStore = useWorkspaceIdeStore.getState()
    if (!ideStore.rootPath) return
    ideStore.refreshChanges()
    ideStore.refreshTree()
  } catch {
    // store not initialized — ignore
  }
}
