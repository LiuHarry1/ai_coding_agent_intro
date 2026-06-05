/**
 * Single source of truth for everything reachable via `/<name>`:
 * built-ins, file-loaded slash commands, and skill folders.
 *
 * On duplicate `name`, **skill > command > built-in** (skill files always win).
 *
 * Consumers:
 *   - `commands/dispatcher.ts`  — parse `/x` and route
 *   - `server/router.ts`         — GET /slash-commands for UI autocomplete
 *   - `formatHelp()`             — text reply for `/help`
 */

import { loadMarkdownConfigs, getAppDirName } from "../utils/markdownConfigLoader.js";
import { loadSkillsFromDisk } from "../skills/loadSkillsDir.js";
import { mergeCommands } from "./loadCommandsFromFiles.js";
import type { SlashCommand } from "./types.js";
import type { SkillDefinition } from "../skills/types.js";

/**
 * Unified slash menu entry. Discriminated by `kind`:
 *   - `built-in`: handled in-dispatcher (e.g. `/help`)
 *   - `command`:  body comes from a `.md` template
 *   - `skill`:    folder-based; may run inline OR fork a subagent
 *
 * `command` and `skill` carry their underlying def by reference so callers
 * don't have to look up again. Built-ins have no def.
 */
export type SlashEntry =
  | { kind: "built-in"; name: string; description: string; argumentHint?: string }
  | {
      kind: "command";
      name: string;
      description: string;
      argumentHint?: string;
      def: SlashCommand;
    }
  | {
      kind: "skill";
      name: string;
      description: string;
      argumentHint?: string;
      /** "inline" → expand into prompt; "fork" → run isolated subagent. */
      context: SkillDefinition["context"];
      def: SkillDefinition;
    };

/** Built-ins exposed in every workspace. Kept here so help/autocomplete agree. */
export const BUILTIN_SLASH_ENTRIES: SlashEntry[] = [
  {
    kind: "built-in",
    name: "help",
    description: "List all available slash commands and skills.",
  },
  {
    kind: "built-in",
    name: "commands",
    description: "Alias for /help.",
  },
  {
    kind: "built-in",
    name: "plan",
    description: "Enter or view plan mode. Use /plan open for the plan file path.",
    argumentHint: "[open|<description>]",
  },
];

const BUILTIN_NAMES = new Set(BUILTIN_SLASH_ENTRIES.map((e) => e.name));

function skillArgumentHint(skill: SkillDefinition): string | undefined {
  if (skill.argumentNames.length === 0) return undefined;
  return "[" + skill.argumentNames.join(" ") + "]";
}

/**
 * Discover everything `/`-invokable for `cwd`.
 *
 * Returns the merged list (sorted by name) plus the raw collections — the
 * dispatcher needs both: the merged map for "what name resolves to what",
 * and the originals for `/help` source attribution if we ever add it.
 */
export async function loadSlashRegistry(cwd: string): Promise<{
  entries: SlashEntry[];
  commands: SlashCommand[];
  skills: SkillDefinition[];
}> {
  const [commandFiles, { skills }] = await Promise.all([
    loadMarkdownConfigs("commands", cwd),
    loadSkillsFromDisk(cwd),
  ]);
  const commands = mergeCommands(commandFiles).commands;

  const byName = new Map<string, SlashEntry>();

  for (const e of BUILTIN_SLASH_ENTRIES) byName.set(e.name, e);

  for (const c of commands) {
    if (BUILTIN_NAMES.has(c.name)) {
      console.warn(`[slash] command '/${c.name}' shadowed by built-in; ignored`);
      continue;
    }
    byName.set(c.name, {
      kind: "command",
      name: c.name,
      description: c.description,
      argumentHint: c.argumentHint,
      def: c,
    });
  }

  // Skill overrides command on duplicate name; built-ins are
  // protected.
  for (const s of skills) {
    if (BUILTIN_NAMES.has(s.name)) {
      console.warn(`[slash] skill '/${s.name}' shadowed by built-in; ignored`);
      continue;
    }
    byName.set(s.name, {
      kind: "skill",
      name: s.name,
      description: s.description,
      argumentHint: skillArgumentHint(s),
      context: s.context,
      def: s,
    });
  }

  const entries = [...byName.values()].sort((a, b) =>
    a.name.localeCompare(b.name),
  );

  return { entries, commands, skills };
}

/** Stripped view for HTTP/UI — never leaks the underlying def. */
export interface PublicSlashEntry {
  name: string;
  description: string;
  kind: SlashEntry["kind"];
  argumentHint?: string;
  context?: SkillDefinition["context"];
}

export function toPublicEntry(e: SlashEntry): PublicSlashEntry {
  if (e.kind === "skill") {
    return {
      name: e.name,
      description: e.description,
      kind: e.kind,
      argumentHint: e.argumentHint,
      context: e.context,
    };
  }
  if (e.kind === "command") {
    return {
      name: e.name,
      description: e.description,
      kind: e.kind,
      argumentHint: e.argumentHint,
    };
  }
  return { name: e.name, description: e.description, kind: e.kind };
}

export function lookupSlash(
  entries: readonly SlashEntry[],
  name: string,
): SlashEntry | undefined {
  return entries.find((e) => e.name === name);
}

/** Markdown reply for `/help`. */
export function formatHelp(entries: readonly SlashEntry[]): string {
  const userDefined = entries.filter((e) => e.kind !== "built-in").length;
  const header =
    userDefined === 0
      ? "**Available slash commands & skills** (built-in only):"
      : `**Available slash commands & skills** (${userDefined} user-defined):`;

  const lines = entries.map((e) => {
    const hint =
      e.kind !== "built-in" && e.argumentHint ? ` ${e.argumentHint}` : "";
    const badge =
      e.kind === "skill"
        ? e.context === "fork"
          ? " · skill/fork"
          : " · skill"
        : e.kind === "command"
          ? " · command"
          : "";
    return `  /${e.name}${hint} — ${e.description}${badge}`;
  });

  const footer =
    userDefined === 0
      ? `\nDrop commands into \`<cwd>/${getAppDirName()}/commands/\` or skills into \`<cwd>/${getAppDirName()}/skills/<name>/SKILL.md\`.`
      : "";

  return [header, "", ...lines, footer].join("\n").trimEnd();
}
