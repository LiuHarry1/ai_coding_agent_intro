/**
 * Turn-end auto-memory extraction.
 *
 * - Trigger only when last assistant has no tool_calls (caller enforces)
 * - Skip if main agent already wrote memdir since cursor
 * - Throttle every N eligible turns
 * - Queue lock by memdir path (multi-session same repo)
 * - Optional wait if session-memory extract is in-flight
 */
import * as fs from 'fs'
import * as path from 'path'
import type {
  AutoMemoryConfig,
  IProvider,
  Message,
  RunAgentFn,
} from '../../core/types.js'
import { isRoleMessage } from '../../core/types.js'
import {
  createSandboxPolicy,
  type SandboxPolicy,
} from '../../core/sandbox.js'
import {
  resolveToolFilePath,
  runForkedAgent,
  type CacheSafeParams,
  type CanUseToolFn,
} from '../../core/forked-agent.js'
import {
  EDIT_FILE_TOOL_NAME,
  GLOB_TOOL_NAME,
  GREP_TOOL_NAME,
  READ_FILE_TOOL_NAME,
  WRITE_FILE_TOOL_NAME,
} from '../../constants/tool_names.js'
import {
  ensureMessageUuids,
  getMessageUuid,
} from '../session-memory/messageUuid.js'
import { enqueueKeyedExtract } from '../session-memory/extractQueue.js'
import {
  waitForSessionMemoryExtraction,
} from '../session-memory/state.js'
import { buildExistingMemoriesManifest } from './inject.js'
import {
  ensureAutoMemDir,
  getAutoMemPath,
  isAutoMemPath,
  isAutoMemoryDisabledByEnv,
} from './paths.js'
import { buildExtractAutoMemoryPrompt } from './prompts.js'
import {
  ensureIndexEntry,
  readEntrypointRaw,
  scanMemoryFiles,
} from './scan.js'
import { getAutoMemoryState } from './state.js'

const AUTO_MEMORY_MAX_STEPS = 5

function countMessagesSince(
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
    n++
  }
  if (!found) return messages.length
  return n
}

function getWrittenFilePath(block: {
  type: string
  toolName?: string
  input?: Record<string, unknown>
}): string | undefined {
  if (block.type !== 'tool-call') return undefined
  if (
    block.toolName !== EDIT_FILE_TOOL_NAME &&
    block.toolName !== WRITE_FILE_TOOL_NAME
  ) {
    return undefined
  }
  const fp = block.input?.file_path
  return typeof fp === 'string' ? fp : undefined
}

/**
 * True if any assistant tool-call after cursor wrote under memdir.
 */
export function hasMemoryWritesSince(
  messages: Message[],
  sinceUuid: string | undefined,
  memPath: string,
  cwd?: string,
): boolean {
  let foundStart = sinceUuid === undefined
  for (const message of messages) {
    if (!foundStart) {
      if (getMessageUuid(message) === sinceUuid) foundStart = true
      continue
    }
    if (!isRoleMessage(message) || message.role !== 'assistant') continue
    if (!Array.isArray(message.content)) continue
    for (const block of message.content) {
      const filePath = getWrittenFilePath(block)
      if (!filePath) continue
      const abs = resolveToolFilePath(filePath, cwd)
      if (isAutoMemPath(abs, memPath)) return true
    }
  }
  return false
}

function pathAllowedForRead(
  absPath: string,
  workspaceRoot: string,
  memPath: string,
): boolean {
  const resolved = path.resolve(absPath)
  if (isAutoMemPath(resolved, memPath)) return true
  const root = path.resolve(workspaceRoot)
  const rel = path.relative(root, resolved)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/**
 * Allow Read/Grep/Glob (workspace ∪ memdir); Edit/Write only memdir.
 */
export function createAutoMemCanUseTool(
  memoryDir: string,
  workspaceRoot: string,
): CanUseToolFn {
  const memPath = path.resolve(memoryDir)
  const cwd = path.resolve(workspaceRoot)

  return (toolName, input) => {
    if (
      toolName === READ_FILE_TOOL_NAME ||
      toolName === GREP_TOOL_NAME ||
      toolName === GLOB_TOOL_NAME
    ) {
      if (
        typeof input === 'object' &&
        input !== null &&
        'file_path' in input &&
        typeof (input as { file_path: unknown }).file_path === 'string'
      ) {
        const abs = resolveToolFilePath(
          (input as { file_path: string }).file_path,
          cwd,
        )
        if (!pathAllowedForRead(abs, cwd, memPath)) {
          return {
            behavior: 'deny',
            message: `read limited to workspace and ${memPath}`,
          }
        }
      }
      // Glob/Grep may use path/pattern fields — allow; execute still sandboxed.
      return { behavior: 'allow', updatedInput: input }
    }

    if (
      (toolName === EDIT_FILE_TOOL_NAME || toolName === WRITE_FILE_TOOL_NAME) &&
      typeof input === 'object' &&
      input !== null &&
      'file_path' in input &&
      typeof (input as { file_path: unknown }).file_path === 'string'
    ) {
      const abs = resolveToolFilePath(
        (input as { file_path: string }).file_path,
        cwd,
      )
      if (isAutoMemPath(abs, memPath)) {
        return { behavior: 'allow', updatedInput: input }
      }
      return {
        behavior: 'deny',
        message: `only ${EDIT_FILE_TOOL_NAME}/${WRITE_FILE_TOOL_NAME} within ${memPath} are allowed`,
      }
    }

    return {
      behavior: 'deny',
      message: `only ${READ_FILE_TOOL_NAME}, ${GREP_TOOL_NAME}, ${GLOB_TOOL_NAME}, and ${EDIT_FILE_TOOL_NAME}/${WRITE_FILE_TOOL_NAME} within ${memPath} are allowed`,
    }
  }
}

function sandboxWithMemdir(cwd: string, memPath: string): SandboxPolicy {
  const base = createSandboxPolicy(cwd)
  return {
    ...base,
    extraReadRoots: [
      ...base.extraReadRoots,
      path.resolve(memPath),
    ],
    extraWriteRoots: [
      ...(base.extraWriteRoots ?? []),
      path.resolve(memPath),
    ],
  }
}

/**
 * After extract: ensure each topic file has an index line.
 */
export function verifyAndRepairIndex(memPath: string): {
  topics: number
  repaired: number
  indexLines: number
} {
  const files = scanMemoryFiles(memPath)
  let repaired = 0
  for (const f of files) {
    const title = f.name ?? f.relPath.replace(/\.md$/i, '')
    if (ensureIndexEntry(memPath, f.relPath, title, f.description)) {
      repaired++
    }
  }
  const raw = readEntrypointRaw(memPath)
  const indexLines = raw.split('\n').filter(l => l.trim().startsWith('-')).length
  return { topics: files.length, repaired, indexLines }
}

export type ExtractAutoMemoryArgs = {
  messages: Message[]
  sessionId: string
  provider: IProvider
  modelId: string
  config: AutoMemoryConfig
  runAgent: RunAgentFn
  cwd: string
  force?: boolean
  cacheSafeParams?: CacheSafeParams
  trustedDirectory?: string
}

export type ExtractAutoMemoryResult = {
  ok: boolean
  error?: string
  memoryPath?: string
  written?: number
}

function lastMessageUuid(messages: Message[]): string | undefined {
  const last = messages[messages.length - 1]
  return last ? getMessageUuid(last) : undefined
}

function advanceCursor(sessionId: string, messages: Message[]): void {
  const state = getAutoMemoryState(sessionId)
  const uuid = lastMessageUuid(messages)
  if (uuid) state.lastAutoMemoryMessageUuid = uuid
  state.turnsSinceExtract = 0
}

/**
 * Should we run extract this turn-end? Updates turnsSinceExtract when true
 * path is considered (caller must only invoke on eligible turn ends).
 */
export function shouldExtractAutoMemory(
  sessionId: string,
  cfg: AutoMemoryConfig,
  force?: boolean,
): boolean {
  if (force) return true
  const every = Math.max(1, cfg.extractEveryNTurns ?? 1)
  const state = getAutoMemoryState(sessionId)
  state.turnsSinceExtract += 1
  if (state.turnsSinceExtract < every) {
    console.log(
      `[auto-memory] throttle skip turns=${state.turnsSinceExtract}/${every} session=${sessionId}`,
    )
    return false
  }
  return true
}

async function runAutoMemoryExtract(
  args: ExtractAutoMemoryArgs,
): Promise<ExtractAutoMemoryResult> {
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
    trustedDirectory,
  } = args

  const memPath = getAutoMemPath({
    cwd,
    trustedDirectory: trustedDirectory ?? config.directory,
  })
  ensureAutoMemDir(memPath)

  const state = getAutoMemoryState(sessionId)

  if (
    !force &&
    hasMemoryWritesSince(
      messages,
      state.lastAutoMemoryMessageUuid,
      memPath,
      cwd,
    )
  ) {
    advanceCursor(sessionId, messages)
    console.log(
      `[auto-memory] extract skipped (direct write) session=${sessionId}`,
    )
    return { ok: true, memoryPath: memPath, written: 0, error: 'skipped_wrote' }
  }

  // Defer behind session-memory if that extract is mid-flight.
  try {
    await waitForSessionMemoryExtraction(sessionId)
  } catch {
    // ignore
  }

  const beforeScan = scanMemoryFiles(memPath)
  const beforeFiles = new Set(beforeScan.map(f => f.absPath))
  const beforeMtimes = new Map(beforeScan.map(f => [f.absPath, f.mtimeMs]))

  const newMessageCount = countMessagesSince(
    messages,
    state.lastAutoMemoryMessageUuid,
  )
  const existing = buildExistingMemoriesManifest(memPath)
  const userPrompt = buildExtractAutoMemoryPrompt({
    newMessageCount: Math.max(1, newMessageCount),
    existingMemories: existing,
    memoryDir: memPath,
  })

  const canUseTool = createAutoMemCanUseTool(memPath, cwd)
  const sandbox = sandboxWithMemdir(cwd, memPath)
  const forkMessages = messages.slice()
  const useCacheSafe = config.cacheSafe !== false && !!cacheSafeParams

  try {
    if (useCacheSafe && cacheSafeParams) {
      await runForkedAgent({
        prompt: userPrompt,
        runAgent,
        cacheSafeParams: {
          ...cacheSafeParams,
          forkContextMessages: forkMessages,
        },
        canUseTool,
        forkLabel: force ? 'auto_memory_manual' : 'auto_memory',
        maxSteps: AUTO_MEMORY_MAX_STEPS,
        cwd,
        sessionId,
        contextOverrides: { sandbox },
      })
    } else {
      // Restricted: only Read + Edit + Write schemas from parent tools if any.
      const tools = cacheSafeParams?.tools ?? {}
      const restricted: typeof tools = {}
      for (const name of [
        READ_FILE_TOOL_NAME,
        EDIT_FILE_TOOL_NAME,
        WRITE_FILE_TOOL_NAME,
        GREP_TOOL_NAME,
        GLOB_TOOL_NAME,
      ]) {
        if (tools[name]) restricted[name] = tools[name]!
      }
      if (Object.keys(restricted).length === 0) {
        return {
          ok: false,
          error: 'no_tools',
          memoryPath: memPath,
        }
      }
      await runForkedAgent({
        prompt: userPrompt,
        runAgent,
        systemPrompt:
          'You extract durable memories into the auto-memory directory. Follow the user prompt.',
        tools: restricted,
        provider,
        model: modelId,
        forkContextMessages: forkMessages,
        canUseTool,
        forkLabel: force ? 'auto_memory_manual' : 'auto_memory',
        maxSteps: AUTO_MEMORY_MAX_STEPS,
        cwd,
        sessionId,
        contextOverrides: { sandbox },
      })
    }

    const after = scanMemoryFiles(memPath)
    let written = 0
    for (const f of after) {
      if (!beforeFiles.has(f.absPath)) written++
      else {
        try {
          const st = fs.statSync(f.absPath)
          const prev = beforeMtimes.get(f.absPath)
          if (prev != null && st.mtimeMs > prev) written++
        } catch {
          // ignore
        }
      }
    }

    const verify = verifyAndRepairIndex(memPath)
    advanceCursor(sessionId, messages)

    console.log(
      `[auto-memory] extract ran wrote=${written} topics=${verify.topics} ` +
        `indexLines=${verify.indexLines} repaired=${verify.repaired} ` +
        `cacheSafe=${useCacheSafe ? 'yes' : 'no'} session=${sessionId}`,
    )
    return { ok: true, memoryPath: memPath, written }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.warn(`[auto-memory] extract failed: ${msg}`)
    return { ok: false, error: msg, memoryPath: memPath }
  }
}

/**
 * Side-path auto-memory update. Fire-and-forget from turn-end only.
 */
export async function extractAutoMemories(
  args: ExtractAutoMemoryArgs,
): Promise<ExtractAutoMemoryResult> {
  if (!args.config.enabled || isAutoMemoryDisabledByEnv()) {
    return { ok: false, error: 'disabled' }
  }

  ensureMessageUuids(args.messages)
  if (!shouldExtractAutoMemory(args.sessionId, args.config, args.force)) {
    return { ok: false, error: 'throttle' }
  }

  const memPath = getAutoMemPath({
    cwd: args.cwd,
    trustedDirectory: args.trustedDirectory ?? args.config.directory,
  })
  const lockKey = path.resolve(memPath)

  const parked: ExtractAutoMemoryArgs = {
    ...args,
    messages: args.messages.slice(),
    cacheSafeParams: args.cacheSafeParams
      ? {
          ...args.cacheSafeParams,
          forkContextMessages: args.messages.slice(),
        }
      : undefined,
  }

  return enqueueKeyedExtract(
    lockKey,
    parked,
    !!args.force,
    runAutoMemoryExtract,
    'auto-memory',
  )
}

export function extractAutoMemoriesInBackground(
  args: ExtractAutoMemoryArgs,
): void {
  void extractAutoMemories(args).then(result => {
    if (result.error === 'coalesced') {
      console.log(
        `[auto-memory] extract superseded by newer pending memdir=${args.cwd}`,
      )
    }
  })
}