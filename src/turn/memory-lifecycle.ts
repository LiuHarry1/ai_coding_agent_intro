/**
 * Turn-host memory side-paths (session-memory + auto-memory).
 * Kept out of runAgent so the loop stays a step machine.
 */
import type {
  AgentLifecycleSnapshot,
  AutoMemoryConfig,
  RunAgentFn,
  SessionMemoryConfig,
} from '../core/types.js'
import type { IProvider } from '../core/llm/types.js'
import { createCacheSafeParams } from '../core/forked-agent.js'
import { extractSessionMemoryInBackground } from '../services/session-memory/index.js'
import { extractAutoMemoriesInBackground } from '../services/auto-memory/index.js'

export function createMemoryLifecycleHooks(opts: {
  sessionMemory?: SessionMemoryConfig
  sessionMemoryModelId?: string
  sessionMemoryProvider?: IProvider
  autoMemory?: AutoMemoryConfig
  autoMemoryModelId?: string
  autoMemoryProvider?: IProvider
  compactionEnabled: boolean
  runAgent: RunAgentFn
}) {
  const {
    sessionMemory,
    sessionMemoryModelId,
    sessionMemoryProvider,
    autoMemory,
    autoMemoryModelId,
    autoMemoryProvider,
    compactionEnabled,
    runAgent,
  } = opts

  return {
    /** After each completed step — fire-and-forget session-memory extract. */
    onAfterStep(snap: AgentLifecycleSnapshot): void {
      if (
        !snap.sessionId ||
        !sessionMemory?.enabled ||
        !compactionEnabled ||
        (sessionMemory.cacheSafe === false && !sessionMemoryModelId)
      ) {
        return
      }
      const cacheSafeParams =
        sessionMemory.cacheSafe !== false
          ? createCacheSafeParams({
              systemPrompt: snap.systemPrompt,
              tools: snap.tools,
              provider: snap.provider,
              model: snap.model,
              messages: snap.messages,
            })
          : undefined
      extractSessionMemoryInBackground({
        messages: snap.messages,
        sessionId: snap.sessionId,
        provider: sessionMemoryProvider ?? snap.provider,
        modelId: sessionMemoryModelId ?? snap.model,
        config: sessionMemory,
        runAgent,
        cwd: snap.cwd ?? process.cwd(),
        cacheSafeParams,
      })
    },

    /** Natural turn end (no more tools) — fire-and-forget auto-memory extract. */
    onTurnEnd(snap: AgentLifecycleSnapshot): void {
      if (
        !snap.sessionId ||
        !autoMemory?.enabled ||
        (autoMemory.cacheSafe === false && !autoMemoryModelId)
      ) {
        return
      }
      const cacheSafeParams =
        autoMemory.cacheSafe !== false
          ? createCacheSafeParams({
              systemPrompt: snap.systemPrompt,
              tools: snap.tools,
              provider: snap.provider,
              model: snap.model,
              messages: snap.messages,
            })
          : undefined
      extractAutoMemoriesInBackground({
        messages: snap.messages,
        sessionId: snap.sessionId,
        provider: autoMemoryProvider ?? snap.provider,
        modelId: autoMemoryModelId ?? snap.model,
        config: autoMemory,
        runAgent,
        cwd: snap.cwd ?? process.cwd(),
        cacheSafeParams,
        trustedDirectory: autoMemory.directory,
      })
    },
  }
}
