/**
 * Wire protocol version. Bump on any breaking change to the message
 * shapes. The engine advertises this in the `system/init` handshake so a
 * GUI can refuse / adapt when it speaks a different major version.
 *
 * Mirrors Claude Code's habit of pinning a protocol version on the init
 * message rather than relying on the package version.
 */
export const PROTOCOL_VERSION = "1" as const;
export type ProtocolVersion = typeof PROTOCOL_VERSION;
