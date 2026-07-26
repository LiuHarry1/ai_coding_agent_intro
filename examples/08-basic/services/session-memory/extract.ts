/**
 * Session-memory extraction via forked agent (Claude Code–aligned).
 *
 * Default (`cacheSafe: true`): same model/system/tools schema as the main
 * loop (`CacheSafeParams`) for prompt-cache sharing; Edit is path-locked via
 * `canUseTool` + sandbox-free execute override for `.sessions/`.
 *
 * Fallback (`cacheSafe: false`): restricted Edit-only tools + `modelTier`.
 *
 * Concurrency: per-session queue (CC `sequential`) with latest-wins coalesce
 * for auto extracts — never drop the freshest snapshot on `inFlight`.
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
import { enqueueSessionExtract } from './extractQueue.js'

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

export type ExtractSessionMemoryResult = {
  ok: boolean
  error?: string
  memoryPath?: string
}

/**
 * Run one extract body. Threshold must already have been checked by the
 * caller — queued/coalesced jobs must not re-check (tokensAtLastExtraction
 * advances when the previous run finishes).
 */
async function runSessionMemoryExtract(
  args: ExtractSessionMemoryArgs,
): Promise<ExtractSessionMemoryResult> {
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

  const state = getSessionMemoryState(sessionId)
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
    // Snapshot at run time (freshest for coalesced jobs).
    const forkMessages = messages.slice()
    const useCacheSafe = config.cacheSafe !== false && !!cacheSafeParams
    const canUseTool = createPathScopedEditCanUseTool(
      EDIT_FILE_TOOL_NAME,
      memoryPath,
    )

    if (useCacheSafe && cacheSafeParams) {
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

/**
 * Side-path session-memory update via forked agent.
 * Fire-and-forget from the main agent loop — do not await on the hot path.
 *
 * Serialized per session (CC sequential). Auto extracts coalesce to latest.
 */
export async function extractSessionMemory(
  args: ExtractSessionMemoryArgs,
): Promise<ExtractSessionMemoryResult> {
  const { messages, sessionId, config, force } = args
  if (!config.enabled) return { ok: false, error: 'disabled' }

  // Fill missing uuids on the live session (idempotent) so keep-cursors resolve.
  ensureMessageUuids(messages)
  if (!force && !shouldExtractSessionMemory(messages, sessionId, config)) {
    return { ok: false, error: 'threshold' }
  }

  if (force) {
    const last = messages[messages.length - 1]
    const lastUuid = last ? getMessageUuid(last) : undefined
    const state = getSessionMemoryState(sessionId)
    if (lastUuid) state.lastTriggerMessageId = lastUuid
  }

  // Snapshot messages now — the array may keep growing on the main thread.
  // Coalesced re-runs still see this parked snapshot (latest parked wins).
  const parked: ExtractSessionMemoryArgs = {
    ...args,
    messages: messages.slice(),
    cacheSafeParams: args.cacheSafeParams
      ? {
          ...args.cacheSafeParams,
          forkContextMessages: messages.slice(),
        }
      : undefined,
  }

  return enqueueSessionExtract(parked, !!force, runSessionMemoryExtract)
}

/** Non-blocking wrapper for the agent loop. */
export function extractSessionMemoryInBackground(
  args: ExtractSessionMemoryArgs,
): void {
  void extractSessionMemory(args).then(result => {
    if (result.error === 'coalesced') {
      console.log(
        `[session-memory] extract superseded by newer pending session=${args.sessionId}`,
      )
    }
  })
}
