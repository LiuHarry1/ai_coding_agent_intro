import type { AgentDefinition, IToolRegistry } from "../core/types.js";
import { loadSkillsFromDisk, filterSkillsByPaths } from "./from-folders.js";
import { createSkillTool, SKILL_TOOL_NAME } from "../tools/skill.js";
import type { SkillDefinition } from "./types.js";

export { SKILL_TOOL_NAME, filterSkillsByPaths };
export type { SkillDefinition };

// ── Skill listing for <system-reminder> injection ────────────────────────

const DEFAULT_LISTING_BUDGET = 8_000;
const BUDGET_CONTEXT_PERCENT = 0.01;

function getCharBudget(contextWindowTokens?: number): number {
  if (!contextWindowTokens) return DEFAULT_LISTING_BUDGET;
  return Math.max(2_000, Math.floor(contextWindowTokens * BUDGET_CONTEXT_PERCENT));
}

function truncateDesc(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 1) + "\u2026";
}

/**
 * Format a skill listing suitable for `<system-reminder>` injection.
 * Budget-aware: if all descriptions exceed the budget, they are truncated.
 */
export function formatSkillListing(
  skills: readonly SkillDefinition[],
  contextWindowTokens?: number,
): string {
  if (skills.length === 0) return "";

  const budget = getCharBudget(contextWindowTokens);
  const lines = skills.map(
    (s) => `- ${s.name} (${s.context}): ${s.description}`,
  );
  const full = lines.join("\n");

  if (full.length <= budget) return full;

  const nameOverhead = skills.reduce(
    (sum, s) => sum + s.name.length + s.context.length + 8,
    0,
  );
  const available = budget - nameOverhead;
  const maxDesc = Math.max(30, Math.floor(available / skills.length));

  return skills
    .map((s) => `- ${s.name} (${s.context}): ${truncateDesc(s.description, maxDesc)}`)
    .join("\n");
}

export interface RegisterSkillsOptions {
  /**
   * File paths to evaluate `paths:` frontmatter against. Skills whose
   * `paths` patterns match at least one of these become active for this
   * chat turn; non-matching conditional skills stay hidden. Pass the
   * files mentioned in the user's current message, recently edited
   * files, or `git ls-files` output — whatever signal best represents
   * "what's relevant right now".
   *
   * Omit (or pass `undefined`) to keep conditional skills hidden.
   * Pass an empty array to explicitly say "we checked, nothing matched"
   * (same effect: conditional skills hidden, unconditional still active).
   * Skills WITHOUT `paths:` are always active regardless of this option.
   */
  candidateFiles?: readonly string[];
}

/**
 * Discover folder-based skills under `<ancestor>/.ai-agent/skills/<name>/SKILL.md`
 * (walked up from cwd to home) and `~/.ai-agent/skills/<name>/SKILL.md`,
 * then register (or replace) the `skill` dispatcher tool on the registry.
 *
 * If no skill folders are found we DO NOT register the tool — the model
 * shouldn't see an empty dispatcher (it would burn tokens on a useless
 * directory). Returns the active skill list so callers can decide what
 * to surface in UI.
 *
 * Mirrors `registerSubagents`: called once per chat request so user edits
 * to SKILL.md files take effect on the next turn without a server restart.
 */
export async function registerSkills(
  registry: IToolRegistry,
  cwd: string,
  forkableAgents: readonly AgentDefinition[],
  options: RegisterSkillsOptions = {},
): Promise<{
  /** All discovered skills, including conditional ones not active this turn. */
  allSkills: SkillDefinition[];
  /** Skills exposed to the model this turn (after `paths:` filtering). */
  activeSkills: SkillDefinition[];
  errors: Array<{ filePath: string; error: string }>;
}> {
  const { skills, errors } = await loadSkillsFromDisk(cwd);
  const activeSkills = filterSkillsByPaths(
    skills,
    options.candidateFiles,
    cwd,
  );

  if (activeSkills.length > 0) {
    registry.register(createSkillTool(activeSkills, forkableAgents));
  }

  return { allSkills: skills, activeSkills, errors };
}
