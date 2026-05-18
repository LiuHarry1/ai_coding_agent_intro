/**
 * Slash-command dispatcher.
 *
 * Responsibility: take the raw user message, detect a leading `/<name> [args]`
 * pattern, look up the command, and return the expanded user message that
 * should be sent to the agent. Returns `null` if the input isn't a slash
 * command — the router just forwards the original message in that case.
 *
 * Built-in commands (`/help`, `/commands`) are handled here too: their
 * output gets sent back to the user verbatim (no LLM round-trip) by
 * returning `{ kind: "reply", text }`. This mirrors Claude Code's slash
 * commands that produce immediate UI output instead of prompt rewrites.
 */

import { loadMarkdownConfigs } from "../core/markdown-config-loader.js";
import { mergeCommands } from "./from-files.js";
import { substituteArguments } from "./argument-substitution.js";
import { expandInlineDirectives } from "./prompt-expansion.js";
import type { SlashCommand } from "./types.js";

/** Parse `/foo bar baz` → { name: "foo", args: "bar baz" }. */
function splitSlashLine(message: string): { name: string; args: string } | null {
  if (!message.startsWith("/")) return null;
  const trimmed = message.trimEnd();
  // Allow newlines after args (`/cmd arg\n\nadditional context`).
  const match = trimmed.match(/^\/([a-z0-9][a-z0-9_-]*)(?:[ \t]+([\s\S]*))?$/i);
  if (!match) return null;
  return { name: match[1]!, args: (match[2] ?? "").trim() };
}

export type CommandDispatchResult =
  /** Not a slash command; forward original message unchanged. */
  | { kind: "passthrough" }
  /** Expanded prompt to send as the user message to the agent. */
  | { kind: "expanded"; text: string; command: SlashCommand }
  /** Immediate text reply — skip the LLM, show to user verbatim. */
  | { kind: "reply"; text: string }
  /** Slash command shape but unknown name. */
  | { kind: "unknown"; name: string; available: string[] };

export interface DispatcherDeps {
  cwd: string;
}

export async function loadCommands(cwd: string): Promise<SlashCommand[]> {
  const files = await loadMarkdownConfigs("commands", cwd);
  return mergeCommands(files).commands;
}

function formatHelp(commands: SlashCommand[]): string {
  const builtIns = [
    { name: "help", description: "List all available slash commands.", argumentHint: undefined },
    { name: "commands", description: "Alias for /help.", argumentHint: undefined },
  ];
  const rows = [
    ...builtIns,
    ...commands.map((c) => ({
      name: c.name,
      description: c.description,
      argumentHint: c.argumentHint,
    })),
  ];
  if (commands.length === 0) {
    return [
      "**Available slash commands** (built-in only):",
      "",
      ...rows.map((r) => `  /${r.name}${r.argumentHint ? ` ${r.argumentHint}` : ""} — ${r.description}`),
      "",
      "Drop `.md` files into `<cwd>/.commands/` or `~/.myagent/commands/` to add more.",
    ].join("\n");
  }
  return [
    `**Available slash commands** (${commands.length} user-defined):`,
    "",
    ...rows.map((r) => `  /${r.name}${r.argumentHint ? ` ${r.argumentHint}` : ""} — ${r.description}`),
  ].join("\n");
}

export async function dispatchSlashCommand(
  message: string,
  deps: DispatcherDeps,
): Promise<CommandDispatchResult> {
  const parsed = splitSlashLine(message);
  if (!parsed) return { kind: "passthrough" };

  const { name, args } = parsed;
  const commands = await loadCommands(deps.cwd);

  // ── Built-in: /help, /commands ──
  if (name === "help" || name === "commands") {
    return { kind: "reply", text: formatHelp(commands) };
  }

  const cmd = commands.find((c) => c.name === name);
  if (!cmd) {
    return {
      kind: "unknown",
      name,
      available: ["help", "commands", ...commands.map((c) => c.name)],
    };
  }

  // 1. Sub args into the template ($ARGUMENTS / $1 / $name).
  const substituted = substituteArguments(cmd.body, args, cmd.argumentNames);
  // 2. Expand inline !`shell` and @file directives.
  const expanded = await expandInlineDirectives(substituted, deps.cwd);

  return { kind: "expanded", text: expanded, command: cmd };
}
