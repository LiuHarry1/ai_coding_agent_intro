import type {
  AgentContext,
  PermissionOption,
  RequestPermissionResponse,
  SessionNotification,
} from '@agentclientprotocol/sdk'
import { methods } from '@agentclientprotocol/sdk'
import type { ControlRequest } from '../../../protocol/src/control.js'
import { answerPlanApproval } from '../core/brokers/plan-approval-broker.js'
import { answerQuestion } from '../core/brokers/question-broker.js'

const DEFAULT_OPTIONS: PermissionOption[] = [
  { optionId: 'allow-once', name: 'Allow', kind: 'allow_once' },
  { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
]

function outcomeApproved(response: RequestPermissionResponse): boolean {
  const outcome = response.outcome
  if (outcome.outcome === 'cancelled') return false
  if ('optionId' in outcome) {
    return (
      outcome.optionId === 'allow-once' ||
      outcome.optionId === 'allow-always' ||
      outcome.optionId.startsWith('answer-') ||
      outcome.optionId.startsWith('approve-')
    )
  }
  return false
}

function selectedOptionId(response: RequestPermissionResponse): string | undefined {
  const outcome = response.outcome
  if (outcome.outcome === 'cancelled') return undefined
  if ('optionId' in outcome) return outcome.optionId
  return undefined
}

/** Route engine `control_request` messages to ACP `session/request_permission`. */
export async function handleControlRequest(
  client: AgentContext,
  sessionId: string,
  msg: ControlRequest,
): Promise<void> {
  const inner = msg.request
  const requestId = msg.request_id

  if (inner.subtype === 'ask_user_question') {
    const questions = inner.questions as Array<{
      question?: string
      options?: Array<{ label?: string }>
    }>
    const summary =
      questions
        .map((q, i) => `${i + 1}. ${q.question ?? 'Question'}`)
        .join('\n') || 'Answer agent questions'

    const options: PermissionOption[] =
      questions.length === 1 && questions[0]?.options?.length
        ? questions[0].options.map((opt, i) => ({
            optionId: `answer-${i}`,
            name: opt.label ?? `Option ${i + 1}`,
            kind: 'allow_once' as const,
          }))
        : DEFAULT_OPTIONS

    options.push({
      optionId: 'reject-once',
      name: 'Cancel',
      kind: 'reject_once',
    })

    const response = await client.request(
      methods.client.session.requestPermission,
      {
        sessionId,
        toolCall: {
          toolCallId: requestId,
          title: 'Answer questions',
          kind: 'other',
          status: 'pending',
          content: [{ type: 'content', content: { type: 'text', text: summary } }],
        },
        options,
      },
    )

    if (!outcomeApproved(response)) {
      return
    }

    const optionId = selectedOptionId(response)
    const answers: Record<string, string> = {}
    for (const q of questions) {
      const qText = q.question ?? 'Question'
      if (optionId?.startsWith('answer-') && q.options?.length) {
        const idx = Number.parseInt(optionId.slice('answer-'.length), 10)
        answers[qText] = q.options[idx]?.label ?? q.options[0]?.label ?? 'Yes'
      } else {
        answers[qText] = q.options?.[0]?.label ?? 'Approved'
      }
    }
    answerQuestion(requestId, { answers })
    return
  }

  if (inner.subtype === 'approve_plan') {
    const response = await client.request(
      methods.client.session.requestPermission,
      {
        sessionId,
        toolCall: {
          toolCallId: requestId,
          title: 'Approve plan',
          kind: 'other',
          status: 'pending',
          content: [
            {
              type: 'content',
              content: { type: 'text', text: inner.plan },
            },
          ],
        },
        options: [
          { optionId: 'approve-agent', name: 'Approve (Agent)', kind: 'allow_once' },
          { optionId: 'approve-ask', name: 'Approve (Ask)', kind: 'allow_once' },
          { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
        ],
      },
    )

    if (!outcomeApproved(response)) {
      answerPlanApproval(requestId, { approved: false, reason: 'rejected' })
      return
    }

    const optionId = selectedOptionId(response)
    answerPlanApproval(requestId, {
      approved: true,
      targetMode: optionId === 'approve-ask' ? 'ask' : 'agent',
    })
    return
  }

  if (inner.subtype === 'can_use_tool') {
    const response = await client.request(
      methods.client.session.requestPermission,
      {
        sessionId,
        toolCall: {
          toolCallId: inner.tool_use_id,
          title: inner.title ?? inner.tool_name,
          kind: 'other',
          status: 'pending',
          content: inner.description
            ? [
                {
                  type: 'content',
                  content: { type: 'text', text: inner.description },
                },
              ]
            : undefined,
        },
        options: DEFAULT_OPTIONS,
      },
    )

    if (outcomeApproved(response)) {
      // Reserved for future engine-side can_use_tool gating.
    }
  }
}

export function controlRequestToNotifications(
  sessionId: string,
  msg: ControlRequest,
): SessionNotification[] {
  if (msg.request.subtype !== 'can_use_tool') return []
  const inner = msg.request
  return [
    {
      sessionId,
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: inner.tool_use_id,
        title: inner.title ?? inner.tool_name,
        kind: 'other',
        status: 'pending',
        rawInput: inner.input,
      },
    },
  ]
}
