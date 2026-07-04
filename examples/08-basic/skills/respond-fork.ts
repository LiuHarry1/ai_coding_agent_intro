/**
 * Glue between `runSkillFork` and an HTTP transport (SSE or buffered JSON).
 *
 * Both `/chat` (slash `/skill-name` with `context: fork`) and
 * `/skills/:name/invoke` end up doing the same dance: spin up a subagent,
 * stream its events if the caller wants SSE, otherwise wait and emit a
 * single JSON blob. That logic lives here so the two endpoints stay thin.
 */

import type { ServerResponse } from 'http'
import { EventBus } from '../core/event-bus.js'
import { configManager } from '../core/config-manager.js'
import { createSSETransport } from '../server/sse-transport.js'
import { registerSubagents } from '../tools/AgentTool/index.js'
import { defaultRegistry } from '../tools/index.js'
import type { RunAgentFn } from '../core/types.js'
import { runSkillFork } from './run-fork.js'
import type { SkillDefinition } from './types.js'

export interface RespondSkillForkOptions {
  res: ServerResponse
  skill: SkillDefinition
  /** Already-expanded skill body (`expandSkillBody` output). */
  combined: string
  cwd: string
  runAgent: RunAgentFn
  wantsStream: boolean
  /** Extra HTTP headers to attach to the SSE response. */
  sseHeaders?: Record<string, string>
  /** Extra fields merged into the JSON response on success. */
  jsonMeta?: Record<string, unknown>
}

function sendJSON(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(data))
}

/**
 * Resolves the fork target agent (lazily reloading subagent definitions so
 * project-level `.agents/` edits land without a restart), runs the skill,
 * and writes the response in whichever transport the caller asked for.
 */
export async function respondSkillFork(
  opts: RespondSkillForkOptions,
): Promise<void> {
  const {
    res,
    skill,
    combined,
    cwd,
    runAgent,
    wantsStream,
    sseHeaders,
    jsonMeta,
  } = opts

  const { activeAgents } = await registerSubagents(defaultRegistry, cwd)
  const targetAgentType = skill.agent ?? 'general_purpose'
  const targetAgent = activeAgents.find(a => a.agentType === targetAgentType)
  if (!targetAgent) {
    sendJSON(res, 400, {
      error: `Skill '${skill.name}' fork target '${targetAgentType}' not found`,
      available: activeAgents.map(a => a.agentType),
    })
    return
  }

  const eventBus = new EventBus()
  const { disabledTools } = configManager.getAll()
  const toolEnablement = { disabledTools }

  const runOpts = {
    skill,
    combined,
    cwd,
    runAgent,
    registry: defaultRegistry,
    activeAgents,
    eventBus,
    toolEnablement,
  }

  if (wantsStream) {
    const transport = createSSETransport(res, eventBus, sseHeaders)
    transport.send('skill_start', {
      skill: skill.name,
      agentType: targetAgent.agentType,
      workspace: cwd,
    })
    try {
      const result = await runSkillFork(runOpts)
      transport.send('text_delta', { delta: result })
      transport.send('finish', { reason: 'skill_fork', skill: skill.name })
    } catch (e) {
      transport.send('error', { message: (e as Error).message })
    } finally {
      transport.end()
    }
    return
  }

  try {
    const result = await runSkillFork(runOpts)
    sendJSON(res, 200, {
      skill: skill.name,
      context: 'fork',
      agentType: targetAgent.agentType,
      workspace: cwd,
      result,
      ...jsonMeta,
    })
  } catch (e) {
    sendJSON(res, 500, { error: (e as Error).message, ...jsonMeta })
  }
}
