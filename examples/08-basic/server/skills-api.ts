/**
 * HTTP API for skill / agent discovery + direct skill invocation.
 *
 * Designed for "other internal projects" to call this agent backend as
 * a service:
 *
 *   GET  /skills                  — list all skills discoverable for a cwd
 *   GET  /agents                  — list all subagents (built-in + .agents/)
 *   POST /skills/:name/invoke     — directly run a skill, bypassing the
 *                                   model's choice. For inline skills this
 *                                   is an LLM-free template expansion;
 *                                   for fork skills it spins up a subagent
 *                                   run and returns its final text (JSON)
 *                                   or streams progress (SSE).
 *
 * `workspace` is resolved per-request (matches `/chat`'s semantics), so a
 * single agent backend can serve many projects from different host paths.
 * Falls back to the server's default workspace (CLI `--workspace`, env
 * `WORKSPACE`, or `process.cwd()`) when the caller omits it.
 *
 * Multi-tenant note: when the SSO auth gate is on (`AUTH_ENABLED=true`),
 * the router has already pinned `req.userWorkspace`. In that mode every
 * endpoint here IGNORES the client-supplied `workspace` and uses the pinned
 * directory instead — mirroring `/chat` — so an authenticated user can't
 * list or invoke another user's skills via `?workspace=`. Without auth the
 * module keeps its legacy behavior (trusted internal callers choose the cwd).
 */

import type { IncomingMessage, ServerResponse } from 'http'
import {
  loadSkillsFromDisk,
  filterSkillsByPaths,
} from '../skills/loadSkillsDir.js'
import {
  expandSkillBody,
  normalizeSkillArguments,
  SkillExpansionError,
} from '../skills/expand.js'
import { respondSkillFork } from '../skills/respond-fork.js'
import { registerSubagents, BUILTIN_AGENTS } from '../tools/AgentTool/index.js'
import { defaultRegistry } from '../tools/index.js'
import type { AgentDefinition, RunAgentFn } from '../core/types.js'
import type { SkillDefinition } from '../skills/types.js'
import { resolveRequestCwd } from './request-cwd.js'
import { resolveSettings } from '../core/settings-manager.js'
import { buildProvider } from '../core/llm/index.js'

function sendJSON(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(data))
}

const MAX_BODY = 4 * 1024 * 1024 // 4MB — generous for arguments, no images

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY) {
        req.destroy()
        reject(new Error('Body too large'))
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}'))
      } catch {
        reject(new Error('Invalid JSON'))
      }
    })
    req.on('error', reject)
  })
}

function resolveRequestWorkspace(
  req: IncomingMessage,
  clientWorkspace: unknown,
): string {
  return resolveRequestCwd(req, clientWorkspace)
}

/** Public-friendly view of a SkillDefinition. */
interface SkillSummary {
  name: string
  description: string
  context: SkillDefinition['context']
  agent?: string
  argumentNames: string[]
  paths?: string[]
  source: SkillDefinition['source']
  filePath?: string
  baseDir?: string
  /**
   * `true` when this skill has no `paths:` filter (always active) — so
   * callers can tell at-a-glance which skills are unconditionally
   * available. Conditional skills (with `paths:`) report `false` here
   * because GET /skills doesn't see per-message file hints; they can
   * still be invoked directly via /skills/:name/invoke regardless.
   */
  active: boolean
}

function toSummary(skill: SkillDefinition, active: boolean): SkillSummary {
  return {
    name: skill.name,
    description: skill.description,
    context: skill.context,
    agent: skill.agent,
    argumentNames: skill.argumentNames,
    paths: skill.paths,
    source: skill.source,
    filePath: skill.filePath,
    baseDir: skill.baseDir,
    active,
  }
}

interface AgentSummary {
  agentType: string
  whenToUse: string
  description: string
  tools?: string[]
  disallowedTools?: string[]
  maxSteps?: number
  model?: string
}

function toAgentSummary(a: AgentDefinition): AgentSummary {
  return {
    agentType: a.agentType,
    whenToUse: a.whenToUse,
    description: a.description,
    tools: a.tools,
    disallowedTools: a.disallowedTools,
    maxSteps: a.maxSteps,
    model: a.model,
  }
}

interface SkillsApiOptions {
  runAgent: RunAgentFn
}

/**
 * Returns a request handler that owns the `/skills*` and `/agents*` URL
 * space. Returns `true` iff it handled the request — the caller (router)
 * uses that signal to fall through to other handlers.
 */
export function createSkillsApi({ runAgent }: SkillsApiOptions) {
  return async function handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<boolean> {
    const { method, url } = req
    if (!url) return false

    const [pathOnly, queryString] = url.split('?')
    const query = new URLSearchParams(queryString ?? '')

    // GET /skills?workspace=/path  (workspace ignored when auth-pinned)
    if (method === 'GET' && pathOnly === '/skills') {
      const cwd = resolveRequestWorkspace(req, query.get('workspace'))
      try {
        const { skills, errors } = await loadSkillsFromDisk(cwd)
        const unconditional = new Set(
          filterSkillsByPaths(skills, undefined, cwd).map(s => s.name),
        )
        sendJSON(res, 200, {
          workspace: cwd,
          skills: skills.map(s => toSummary(s, unconditional.has(s.name))),
          errors,
        })
      } catch (e) {
        sendJSON(res, 500, { error: (e as Error).message })
      }
      return true
    }

    // GET /agents?workspace=/path  (workspace ignored when auth-pinned)
    if (method === 'GET' && pathOnly === '/agents') {
      const cwd = resolveRequestWorkspace(req, query.get('workspace'))
      try {
        // registerSubagents replaces the `task` tool as a side effect.
        // Acceptable here because /agents is rarely-called metadata —
        // callers that pump traffic at it should debounce.
        const { activeAgents, errors } = await registerSubagents(
          defaultRegistry,
          cwd,
        )
        sendJSON(res, 200, {
          workspace: cwd,
          agents: activeAgents.map(a => toAgentSummary(a)),
          builtin: BUILTIN_AGENTS.map(a => a.agentType),
          errors,
        })
      } catch (e) {
        sendJSON(res, 500, { error: (e as Error).message })
      }
      return true
    }

    // POST /skills/:name/invoke[?stream=false]
    const invokeMatch = pathOnly?.match(/^\/skills\/([^/]+)\/invoke$/)
    if (method === 'POST' && invokeMatch) {
      const skillName = decodeURIComponent(invokeMatch[1]!)
      let body: Record<string, unknown>
      try {
        body = await readBody(req)
      } catch (e) {
        sendJSON(res, 400, { error: (e as Error).message })
        return true
      }
      const wantsStream =
        query.get('stream') !== 'false' && body.stream !== false
      await handleSkillInvoke({
        req,
        res,
        skillName,
        body,
        runAgent,
        wantsStream,
      })
      return true
    }

    return false
  }
}

async function handleSkillInvoke(args: {
  req: IncomingMessage
  res: ServerResponse
  skillName: string
  body: Record<string, unknown>
  runAgent: RunAgentFn
  wantsStream: boolean
}): Promise<void> {
  const { req, res, skillName, body, runAgent, wantsStream } = args
  const cwd = resolveRequestWorkspace(req, body.workspace)
  const resolvedSettings = resolveSettings(cwd)
  const provider = buildProvider(resolvedSettings.config.provider)

  const { skills } = await loadSkillsFromDisk(cwd)
  const skill = skills.find(s => s.name === skillName)
  if (!skill) {
    sendJSON(res, 404, {
      error: `Unknown skill '${skillName}'`,
      available: skills.map(s => s.name),
      workspace: cwd,
    })
    return
  }

  const rawArgs = normalizeSkillArguments(
    body.arguments as
      string | Record<string, string | number | boolean> | undefined,
  )

  let combined: string
  try {
    ;({ combined } = await expandSkillBody(skill, rawArgs, cwd))
  } catch (e) {
    if (e instanceof SkillExpansionError) {
      sendJSON(res, 400, { error: e.message, code: e.code })
      return
    }
    sendJSON(res, 500, { error: (e as Error).message })
    return
  }

  // ── inline ── pure template expansion, no LLM round-trip needed.
  // Always JSON regardless of `stream` — inline skills have no progress
  // events to stream, just one shot of text.
  if (skill.context === 'inline') {
    sendJSON(res, 200, {
      skill: skillName,
      context: 'inline',
      workspace: cwd,
      result: combined,
    })
    return
  }

  // ── fork ── delegate to the shared helper used by /chat too.
  await respondSkillFork({
    res,
    skill,
    combined,
    cwd,
    runAgent,
    provider,
    config: resolvedSettings.config,
    wantsStream,
    sseHeaders: { 'X-Skill': skillName },
  })
}
