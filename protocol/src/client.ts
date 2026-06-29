import { z } from "zod";
import {
  ControlRequestSchema,
  ControlResponseSchema,
  ControlCancelRequestSchema,
} from "./control.js";

/**
 * Messages flowing from a GUI / client to the agent engine.
 *
 * Mirrors CC's `StdinMessage`: a user turn plus the client side of the
 * control sub-protocol (the client both *initiates* requests — e.g.
 * interrupt — and *responds* to engine requests — e.g. a permission
 * decision).
 */

// A user turn (CC's `user` message). `text` + optional inline images.
export const UserMessageSchema = z.object({
  type: z.literal("user"),
  text: z.string(),
  /** data: URLs, same as the current /chat `images` field. */
  images: z.array(z.string()).optional(),
  /** Omit to start a fresh session; the engine replies with init. */
  session_id: z.string().optional(),
});
export type UserMessage = z.infer<typeof UserMessageSchema>;

export const ClientMessageSchema = z.union([
  UserMessageSchema,
  ControlRequestSchema, // client-initiated: interrupt, set_permission_mode
  ControlResponseSchema, // client reply: can_use_tool / approve_plan decision
  ControlCancelRequestSchema,
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;
