/**
 * Session-memory extraction via forked agent (Claude Code–aligned).
 *
 * Default (`cacheSafe: true`): same model/system/tools schema as the main
 * loop (`CacheSafeParams`) for prompt-cache sharing; Edit is path-locked via
 * `canUseTool` + sandbox-free execute override for `.sessions/`.
 *
 * Fallback (`cacheSafe: false`): restricted Edit-only tools + `modelTier`.
 */
import * as fs from 'fs'
import * as path from 'path'
import type {
  IProvider,
  Message,
  RunAgentFn,
  SessionMemoryConfig,
} from '../../core/types.js'
import { isRoleMessage } from '../../core/types.js'
import {
  createPathScopedEditCanUseTool,
  overrideToolExecute,
  runForkedAgent,
  type CacheSafeParams,
} from '../../core/forked-agent.js'
import { EDIT_FILE_TOOL_NAME } from '../../constants/tool_names.js'
import { tokenCountWithEstimation } from '../compact/tokens.js'
import {
  ensureMessageUuids,
  getMessageUuid,
} from './messageUuid.js'
import { createMemoryFileEditTool } from './memoryEditTool.js'
import { getSessionMemoryDir, getSessionMemoryPath } from './paths.js'
import {
  buildSessionMemoryUpdatePrompt,
  loadSessionMemoryTemplate,
  SESSION_MEMORY_FORK_SYSTEM_PROMPT,
} from './prompts.js'
import {
  beginExtraction,
  bumpNotesGeneration,
  endExtraction,
  getSessionMemoryState,
} from './state.js'
import { validateSessionMemoryStructure } from './template.js'

/** Cap fork agent turns (CC session memory typically finishes in 1–2 rounds). */
const SESSION_MEMORY_MAX_STEPS = 5

function countToolCallsSince(
  messages: Message[],
  sinceUuid: string | undefined,
): number {
  let n = 0
  let found = sinceUuid === undefined
  for (const message of messages) {
    if (!found) {
      if (getMessageUuid(message) === sinceUuid) found = true
      continue
    }
    if (!isRoleMessage(message) || message.role !== 'assistant') continue
    for (const block of message.content) {
      if (block.type === 'tool-call') n++
    }
  }
  return n
}

function lastAssistantHasToolCalls(messages: Message[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (!isRoleMessage(m) || m.role !== 'assistant') continue
    return m.content.some(b => b.type === 'tool-call')
  }
  return false
}

export function shouldExtractSessionMemory(
  messages: Message[],
  sessionId: string,
  cfg: SessionMemoryConfig,
): boolean {
  const state = getSessionMemoryState(sessionId)
  const total = tokenCountWithEstimation(messages).total

  if (!state.initialized) {
    if (total < cfg.minimumTokensToInit) return false
    state.initialized = true
  }

  const growth = total - state.tokensAtLastExtraction
  if (growth < cfg.minimumTokensBetweenUpdate) return false

  const toolCalls = countToolCallsSince(messages, state.lastTriggerMessageId)
  const naturalBreak = !lastAssistantHasToolCalls(messages)
  const should =
    toolCalls >= cfg.toolCallsBetweenUpdates || naturalBreak

  if (should) {
    // CC updates lastMemoryMessageUuid when deciding to extract (before async).
    const last = messages[messages.length - 1]
    const lastUuid = last ? getMessageUuid(last) : undefined
    if (lastUuid) state.lastTriggerMessageId = lastUuid
  }

  return should
}

async function ensureSessionMemoryFile(
  sessionId: string,
  cwd?: string,
): Promise<{ memoryPath: string; current: string }> {
  const dir = getSessionMemoryDir(sessionId)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const memoryPath = getSessionMemoryPath(sessionId)
  if (!fs.existsSync(memoryPath)) {
    const template = loadSessionMemoryTemplate(cwd)
    fs.writeFileSync(
      memoryPath,
      template.endsWith('\n') ? template : template + '\n',
      { encoding: 'utf-8', mode: 0o600 },
    )
  }
  const current = fs.readFileSync(memoryPath, 'utf-8')
  return { memoryPath, current }
}

export type ExtractSessionMemoryArgs = {
  messages: Message[]
  sessionId: string
  provider: IProvider
  modelId: string
  config: SessionMemoryConfig
  /** Fork runner (main agent loop). Required for Edit-only extract. */
  runAgent: RunAgentFn
  /** Workspace cwd (custom template/prompt discovery). */
  cwd?: string
  /** Skip threshold checks (e.g. /summary). */
  force?: boolean
  /**
   * When set (and config.cacheSafe), reuse main-loop system/tools/model for
   * prompt-cache sharing. `forkContextMessages` is refreshed from `messages`.
   */
  cacheSafeParams?: CacheSafeParams
}

/**
 * Side-path session-memory update via Edit-only forked agent.
 * Fire-and-forget from the main agent loop — do not await on the hot path.
 */
export async function extractSessionMemory(
  args: ExtractSessionMemoryArgs,
): Promise<{ ok: boolean; error?: string; memoryPath?: string }> {
  const {
    messages,
    sessionId,
    provider,
    modelId,
    config,
    runAgent,
    cwd,
    force,
    cacheSafeParams,
  } = args
  if (!config.enabled) return { ok: false, error: 'disabled' }

  const state = getSessionMemoryState(sessionId)
  if (state.inFlight) return { ok: false, error: 'in_flight' }

  // Fill missing uuids on the live session (idempotent) so keep-cursors resolve.
  // Messages are normally stamped at creation; this only backfills gaps.
  ensureMessageUuids(messages)
  if (!force && !shouldExtractSessionMemory(messages, sessionId, config)) {
    return { ok: false, error: 'threshold' }
  }

  if (force) {
    const last = messages[messages.length - 1]
    const lastUuid = last ? getMessageUuid(last) : undefined
    if (lastUuid) state.lastTriggerMessageId = lastUuid
  }

  const epoch = beginExtraction(sessionId)
  try {
    const { memoryPath, current } = await ensureSessionMemoryFile(
      sessionId,
      cwd,
    )
    const userPrompt = buildSessionMemoryUpdatePrompt({
      notesPath: memoryPath,
      currentNotes: current,
      cwd,
    })

    const editTool = createMemoryFileEditTool(memoryPath)
    const editExecute = (
      editTool as {
        execute: (args: unknown, options?: unknown) => Promise<unknown>
      }
    ).execute.bind(editTool)
    // Shallow copy so fork appends don't mutate the parent array.
    const forkMessages = messages.slice()
    const useCacheSafe = config.cacheSafe !== false && !!cacheSafeParams
    const canUseTool = createPathScopedEditCanUseTool(
      EDIT_FILE_TOOL_NAME,
      memoryPath,
    )

    if (useCacheSafe && cacheSafeParams) {
      // Keep parent tool schemas (cache key); only swap Edit execute so
      // writes under `.sessions/` bypass workspace sandbox.
      const tools = overrideToolExecute(
        cacheSafeParams.tools,
        EDIT_FILE_TOOL_NAME,
        editExecute,
      )
      await runForkedAgent({
        prompt: userPrompt,
        runAgent,
        cacheSafeParams: {
          ...cacheSafeParams,
          tools,
          forkContextMessages: forkMessages,
        },
        canUseTool,
        forkLabel: force ? 'session_memory_manual' : 'session_memory',
        maxSteps: SESSION_MEMORY_MAX_STEPS,
        cwd: cwd ?? process.cwd(),
        sessionId,
      })
    } else {
      await runForkedAgent({
        prompt: userPrompt,
        runAgent,
        systemPrompt: SESSION_MEMORY_FORK_SYSTEM_PROMPT,
        tools: { [EDIT_FILE_TOOL_NAME]: editTool },
        provider,
        model: modelId,
        forkContextMessages: forkMessages,
        canUseTool,
        forkLabel: force ? 'session_memory_manual' : 'session_memory',
        maxSteps: SESSION_MEMORY_MAX_STEPS,
        cwd: cwd ?? process.cwd(),
        sessionId,
      })
    }

    const after = fs.readFileSync(memoryPath, 'utf-8')
    if (!validateSessionMemoryStructure(after)) {
      console.warn(
        '[session-memory] extract warning: notes file missing required section headers after Edit',
      )
    } else {
      bumpNotesGeneration(sessionId)
    }

    const total = tokenCountWithEstimation(messages).total
    state.tokensAtLastExtraction = total
    if (!lastAssistantHasToolCalls(messages)) {
      const last = messages[messages.length - 1]
      const lastUuid = last ? getMessageUuid(last) : undefined
      if (lastUuid) state.lastSummarizedMessageId = lastUuid
    }

    console.log(
      `[session-memory] forked Edit update ${path.basename(memoryPath)} ` +
        `(~${after.length} chars, cacheSafe=${useCacheSafe ? 'yes' : 'no'})`,
    )
    return { ok: true, memoryPath }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.warn(`[session-memory] extract failed: ${msg}`)
    return { ok: false, error: msg }
  } finally {
    endExtraction(sessionId, epoch)
  }
}

/** Non-blocking wrapper for the agent loop. */
export function extractSessionMemoryInBackground(
  args: ExtractSessionMemoryArgs,
): void {
  void extractSessionMemory(args)
}
