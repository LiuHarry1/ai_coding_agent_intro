import type { AgentOptions, Message } from '../types.js'

/** Reason the query loop stopped (CC-aligned). */
export type QueryStopReason =
  | 'completed'
  | 'aborted'
  | 'max_steps'
  | 'error'

export type QueryResult = {
  finalText: string
  messages: Message[]
  reason: QueryStopReason
}

/**
 * Options for `query()` — same as AgentOptions with messages already seeded
 * (user message / attachments appended by the caller when needed).
 */
export type QueryOptions = AgentOptions & {
  messages: Message[]
}
