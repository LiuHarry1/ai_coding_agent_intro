/**
 * @ai-agent/protocol — the single source of truth for the wire format
 * spoken between the coding-agent engine and any GUI.
 *
 * Layout:
 *   - version   — PROTOCOL_VERSION
 *   - common    — shared primitives (envelope, todo, mode, usage)
 *   - control   — bidirectional control_request / response / cancel
 *   - server    — engine → client messages (ServerMessage)
 *   - client    — client → engine messages (ClientMessage)
 *   - wire      — direction-split aggregates (Outgoing / Incoming)
 *
 * Consumers (backend transports, web frontend, CLI, future ACP adapter)
 * import from here and nowhere else.
 */
export * from './version.js'
export * from './common.js'
export * from './control.js'
export * from './server.js'
export * from './client.js'
export * from './wire.js'
