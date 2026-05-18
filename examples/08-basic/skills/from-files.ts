/**
 * Parse user/project markdown skill files into `SkillDefinition`.
 *
 * Frontmatter schema (subset of CC's skill frontmatter):
 *
 *   ---
 *   name: pr-author                       # required
 *   description: Draft a PR body...       # required
 *   context: inline                       # optional, "inline" (default) or "fork"
 *   agent: general_purpose                # optional, used when context: fork
 *   arguments: "ticket"                   # optional, enables $ticket
 *   ---
 *
 *   Body uses $ARGUMENTS / $1 / $name plus !`shell` and @file directives,
 *   same as slash commands. Reuses commands/argument-substitution.ts and
 *   commands/prompt-expansion.ts at runtime — the parser only structures
 *   the data here.
 */

import path from "path";
import type { SkillDefinition, SkillContextMode } from "./types.js";
import type { MarkdownFile } from "../core/markdown-config-loader.js";
import {
  parseArgumentNames,
  parseString,
  parseIdentifier,
} from "../core/frontmatter-helpers.js";

export interface SkillParseResult {
  skill: SkillDefinition | null;
  filePath: string;
  error?: string;
}

function parseContextMode(value: unknown): SkillContextMode | null {
  if (value === undefined || value === null) return "inline";
  const v = parseString(value);
  if (v === "inline" || v === "fork") return v;
  return null;
}

export function parseSkillFromMarkdown(file: MarkdownFile): SkillParseResult {
  const fm = file.frontmatter;

  // Skill name: prefer `name:` frontmatter, fall back to filename. CC
  // requires `name:` explicitly — we're slightly looser so users can
  // rename via filename without editing frontmatter.
  const name =
    parseIdentifier(fm.name) ?? path.basename(file.filePath, ".md");
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(name)) {
    return {
      skill: null,
      filePath: file.filePath,
      error: `skill: invalid name '${name}' (must match [a-z0-9][a-z0-9_-]*)`,
    };
  }

  const description = parseString(fm.description);
  if (!description) {
    return {
      skill: null,
      filePath: file.filePath,
      error: `skill '${name}': missing or empty 'description' in frontmatter`,
    };
  }

  if (!file.body.trim()) {
    return {
      skill: null,
      filePath: file.filePath,
      error: `skill '${name}': markdown body is empty`,
    };
  }

  const ctx = parseContextMode(fm.context);
  if (ctx === null) {
    return {
      skill: null,
      filePath: file.filePath,
      error: `skill '${name}': invalid 'context' value (must be 'inline' or 'fork')`,
    };
  }

  return {
    skill: {
      name,
      description,
      source: file.source,
      filePath: file.filePath,
      context: ctx,
      agent: parseString(fm.agent),
      argumentNames: parseArgumentNames(fm.arguments),
      body: file.body,
    },
    filePath: file.filePath,
  };
}

export function mergeSkills(
  files: readonly MarkdownFile[],
): { skills: SkillDefinition[]; errors: Array<{ filePath: string; error: string }> } {
  const errors: Array<{ filePath: string; error: string }> = [];

  const ordered = [...files].sort((a, b) => {
    const rank = (s: typeof a.source) => (s === "user" ? 0 : 1);
    return rank(a.source) - rank(b.source);
  });

  const byName = new Map<string, SkillDefinition>();
  for (const f of ordered) {
    const { skill, error, filePath } = parseSkillFromMarkdown(f);
    if (error) {
      errors.push({ filePath, error });
      console.warn(`[skills] ${error} (${filePath})`);
    }
    if (skill) {
      if (byName.has(skill.name)) {
        console.log(`[skills] overriding '${skill.name}' from ${f.filePath}`);
      }
      byName.set(skill.name, skill);
    }
  }

  return { skills: [...byName.values()], errors };
}
