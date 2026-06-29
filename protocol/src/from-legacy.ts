import type { ServerMessage } from "./server.js";
import type { ControlRequest } from "./control.js";
import { PROTOCOL_VERSION } from "./version.js";
import { PermissionModeSchema, type PermissionMode } from "./common.js";

/**
 * Bridge: current backend `eventBus` events → protocol `ServerMessage`s.
 *
 * The engine today emits loosely-typed `(name, data)` pairs (see
 * examples/08-basic — `text_delta`, `tool_call`, `done`, …). Rather than
 * rewrite the core to emit protocol messages directly (a later phase),
 * this adapter translates on the way out so a transport can speak the
 * new protocol *now*.
 *
 * Events that aren't part of the stable public contract (compaction,
 * token usage, tool-input previews, step markers) return `null` — they
 * stay internal, exactly like CC keeps most internal events off the SDK
 * stream. GUIs therefore only ever see contract messages.
 */

interface LegacyContext {
  session_id: string;
  /** Current permission mode, used to fill the init handshake. */
  mode?: string;
}

function asMode(value: unknown, fallback: PermissionMode = "agent"): PermissionMode {
  const parsed = PermissionModeSchema.safeParse(value);
  return parsed.success ? parsed.data : fallback;
}

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export function mapLegacyEvent(
  event: string,
  data: unknown,
  ctx: LegacyContext,
): ServerMessage | null {
  const d = (data ?? {}) as Record<string, unknown>;
  const session_id = str(d.session_id, ctx.session_id);

  switch (event) {
    // ── handshake ──────────────────────────────────
    case "session":
      return {
        type: "system",
        subtype: "init",
        protocol_version: PROTOCOL_VERSION,
        permission_mode: asMode(d.mode, asMode(ctx.mode)),
        session_id,
      };

    // ── streaming output ───────────────────────────
    case "text_delta":
      return {
        type: "stream_event",
        delta: { kind: "text", text: str(d.delta) },
        session_id,
      };
    case "reasoning_delta":
      return {
        type: "stream_event",
        delta: { kind: "reasoning", text: str(d.delta) },
        session_id,
      };

    // ── tool activity ──────────────────────────────
    case "tool_call":
      return {
        type: "tool_call",
        tool_use_id: str(d.toolCallId),
        name: str(d.name),
        args: d.args,
        session_id,
      };
    case "tool_result":
      return {
        type: "tool_result",
        tool_use_id: str(d.toolCallId),
        result: str(d.result),
        session_id,
      };

    // ── system/<subtype> progress ──────────────────
    case "todo_update":
      return {
        type: "system",
        subtype: "todo_update",
        todos: Array.isArray(d.todos) ? (d.todos as never) : [],
        session_id,
      };
    case "skill_start":
      return {
        type: "system",
        subtype: "skill_start",
        skill: str(d.skill),
        agent_type: str(d.agentType) || undefined,
        workspace: str(d.workspace) || undefined,
        session_id,
      };
    case "mode_changed":
      return {
        type: "system",
        subtype: "mode_changed",
        mode: asMode(d.mode, asMode(ctx.mode)),
        session_id,
      };

    // ── interactive control requests (engine → client) ──
    case "ask_user_question": {
      const requestId = str(d.id);
      const req: ControlRequest = {
        type: "control_request",
        request_id: requestId,
        request: {
          subtype: "ask_user_question",
          question_id: requestId,
          questions: Array.isArray(d.questions) ? d.questions : [],
        },
      };
      return req;
    }
    case "plan_approval_request": {
      const requestId = str(d.requestId);
      const req: ControlRequest = {
        type: "control_request",
        request_id: requestId,
        request: {
          subtype: "approve_plan",
          request_id: requestId,
          plan: str(d.plan),
        },
      };
      return req;
    }

    // ── terminal ───────────────────────────────────
    case "finish":
      return {
        type: "result",
        subtype: "success",
        reason: str(d.reason, "finish"),
        text: typeof d.text === "string" ? d.text : undefined,
        session_id,
      };
    case "done":
      return {
        type: "result",
        subtype: "success",
        reason: "done",
        session_id,
      };
    case "error":
      return {
        type: "result",
        subtype: "error",
        error: str(d.message, "unknown error"),
        session_id,
      };

    // ── internal-only: not part of the public contract ──
    // reasoning_start/end, tool_input_*, step_start, thinking,
    // tools_discovered, usage, process_output, compaction_*,
    // tool_timing, transient_retry, plan_ready, …
    default:
      return null;
  }
}
