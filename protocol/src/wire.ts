import { z } from 'zod'
import { ServerMessageSchema } from './server.js'
import { ClientMessageSchema } from './client.js'
import { ControlResponseSchema } from './control.js'

/**
 * Direction-split aggregate unions, mirroring CC's StdoutMessage /
 * StdinMessage. A transport reads `IncomingMessage` from its input
 * channel and writes `OutgoingMessage` to its output channel.
 *
 *   - OutgoingMessage = everything the engine can send (server messages,
 *     plus control responses to client-initiated control requests).
 *   - IncomingMessage = everything a client can send.
 */

export const OutgoingMessageSchema = z.union([
  ServerMessageSchema,
  ControlResponseSchema,
])
export type OutgoingMessage = z.infer<typeof OutgoingMessageSchema>

export const IncomingMessageSchema = ClientMessageSchema
export type IncomingMessage = z.infer<typeof IncomingMessageSchema>
