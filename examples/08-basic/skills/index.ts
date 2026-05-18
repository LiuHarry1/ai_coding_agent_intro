import type { AgentDefinition, IToolRegistry } from "../core/types.js";
import { loadMarkdownConfigs } from "../core/markdown-config-loader.js";
import { mergeSkills } from "./from-files.js";
import { createSkillTool, SKILL_TOOL_NAME } from "../tools/skill.js";
import type { SkillDefinition } from "./types.js";

export { SKILL_TOOL_NAME };
export type { SkillDefinition };

/**
 * Discover markdown skills under `<cwd>/.skills/*.md` and
 * `~/.myagent/skills/*.md`, then register (or replace) the `skill`
 * dispatcher tool on the registry.
 *
 * If no skill files are found we DO NOT register the tool — the model
 * shouldn't see an empty dispatcher (it would burn tokens on a useless
 * directory). Returns the active skill list so callers can decide what
 * to surface in UI.
 *
 * Mirrors `registerSubagents`: called once per chat request so user edits
 * to skill files take effect on the next turn without a server restart.
 */
export async function registerSkills(
  registry: IToolRegistry,
  cwd: string,
  forkableAgents: readonly AgentDefinition[],
): Promise<{
  activeSkills: SkillDefinition[];
  errors: Array<{ filePath: string; error: string }>;
}> {
  const files = await loadMarkdownConfigs("skills", cwd);
  const { skills, errors } = mergeSkills(files);

  if (skills.length > 0) {
    registry.register(createSkillTool(skills, forkableAgents));
  }

  return { activeSkills: skills, errors };
}
