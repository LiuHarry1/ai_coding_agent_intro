/**
 * Single source of truth for the user/project config directory name.
 *
 * Mirrors Claude Code's `.claude/` layout — all extension types live under
 * one dot-folder:
 *
 *   ~/.ai-agent/config.json
 *   ~/.ai-agent/agents/*.md
 *   ~/.ai-agent/commands/*.md
 *   ~/.ai-agent/skills/<name>/SKILL.md
 *
 *   <ancestor>/.ai-agent/agents/*.md
 *   <ancestor>/.ai-agent/commands/*.md
 *   <ancestor>/.ai-agent/skills/<name>/SKILL.md
 *
 * Override the directory basename at runtime with the `AI_AGENT_DIR` env var
 * (e.g. `AI_AGENT_DIR=.my-agent`). Values without a leading dot get one
 * added automatically.
 */

import * as os from "os";
import * as path from "path";

/** Default basename — change here if the product name ever moves off `.ai-agent`. */
export const DEFAULT_APP_DIR_NAME = ".ai-agent";

export const CONFIG_FILE_NAME = "config.json";

export type AppSubdir = "agents" | "skills" | "commands";

/**
 * Resolved app-directory basename (includes leading dot).
 * Set `AI_AGENT_DIR` to override without touching code.
 */
export function getAppDirName(): string {
  const raw = process.env.AI_AGENT_DIR?.trim();
  if (!raw) return DEFAULT_APP_DIR_NAME;
  return raw.startsWith(".") ? raw : `.${raw}`;
}

/** User-scope root: `~/.ai-agent` (or whatever `getAppDirName()` returns). */
export function getUserAppDir(): string {
  return path.join(os.homedir(), getAppDirName());
}

export function getUserConfigPath(): string {
  return path.join(getUserAppDir(), CONFIG_FILE_NAME);
}

/** User-scope subdir, e.g. `~/.ai-agent/skills`. */
export function getUserSubdir(kind: AppSubdir): string {
  return path.join(getUserAppDir(), kind);
}

/** Project-scope app dir at a single ancestor: `<dir>/.ai-agent`. */
export function getProjectAppDir(dir: string): string {
  return path.join(path.resolve(dir), getAppDirName());
}

/** Project-scope subdir at a single ancestor, e.g. `<dir>/.ai-agent/agents`. */
export function getProjectSubdir(kind: AppSubdir, dir: string): string {
  return path.join(getProjectAppDir(dir), kind);
}

/**
 * Walk from `cwd` upward, collecting every project app dir, **deepest first**
 * (same order as CC's `getProjectDirsUpToHome`). Stops at the home directory
 * (exclusive — home is user-scope, not project-scope).
 */
export function getProjectAppDirsUpToHome(cwd: string): string[] {
  const home = os.homedir();
  const dirs: string[] = [];

  let current = path.resolve(cwd);
  while (true) {
    if (current === home) break;

    dirs.push(getProjectAppDir(current));

    const parent = path.dirname(current);
    if (parent === current) break;
    if (parent === home) break;
    current = parent;
  }

  return dirs;
}
