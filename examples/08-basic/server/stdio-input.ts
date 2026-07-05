import * as readline from 'readline'
import type { ClientMessage } from '../../../protocol/src/client.js'
import { ClientMessageSchema } from '../../../protocol/src/client.js'
import type { ControlResponse } from '../../../protocol/src/control.js'
import { answerQuestion } from '../core/brokers/question-broker.js'
import { answerPlanApproval } from '../core/brokers/plan-approval-broker.js'

export type UserTurnMessage = Extract<ClientMessage, { type: 'user' }>

/** Route a client control_response to in-process brokers (questions, plan approval). */
export function dispatchControlResponse(msg: ControlResponse): boolean {
  const inner = msg.response
  if (inner.subtype === 'error') return false

  const requestId = inner.request_id
  const payload = inner.response ?? {}

  if (typeof payload.approved === 'boolean') {
    return answerPlanApproval(requestId, {
      approved: payload.approved,
      editedPlan:
        typeof payload.edited_plan === 'string'
          ? payload.edited_plan
          : undefined,
      targetMode:
        payload.target_mode === 'ask' || payload.target_mode === 'agent'
          ? payload.target_mode
          : undefined,
      reason: typeof payload.reason === 'string' ? payload.reason : undefined,
    })
  }

  if (payload.answers && typeof payload.answers === 'object') {
    return answerQuestion(requestId, {
      answers: payload.answers as Record<string, string>,
      annotations: payload.annotations as
        | Record<string, { preview?: string; notes?: string }>
        | undefined,
    })
  }

  return false
}

function parseLine(line: string): ClientMessage | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  try {
    const parsed = JSON.parse(trimmed) as unknown
    const result = ClientMessageSchema.safeParse(parsed)
    return result.success ? result.data : null
  } catch {
    return null
  }
}

/**
 * Read NDJSON ClientMessages from stdin. Control responses are dispatched
 * immediately; user turns are yielded to the caller.
 */
export async function* readStdioClientMessages(): AsyncGenerator<UserTurnMessage> {
  const rl = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  })

  try {
    for await (const line of rl) {
      const msg = parseLine(line)
      if (!msg) continue

      if (msg.type === 'control_response') {
        dispatchControlResponse(msg)
        continue
      }
      if (msg.type === 'control_cancel_request') {
        continue
      }
      if (msg.type === 'control_request') {
        continue
      }
      if (msg.type === 'user') {
        yield msg
      }
    }
  } finally {
    rl.close()
  }
}
