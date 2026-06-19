/**
 * Discover skills from `<dir>/<skill-name>/SKILL.md` folders.
 *
 * A skill is a *directory* (not a flat `.md` file). Each skill folder MUST
 * contain a `SKILL.md`; it MAY also contain additional files / sub-folders
 * (scripts, prompts, sample inputs). The folder path is exposed to the model
 * as `baseDir` so the skill body can reference its own bundled assets via
 * `${SKILL_DIR}` substitution in `tools/skill.ts`.
 *
 * Layout:
 *
 *   <ancestor>/.ai-agent/skills/<skill-name>/SKILL.md   # project-scope
 *   ~/.ai-agent/skills/<skill-name>/SKILL.md             # user-scope
 *
 * Precedence on duplicate skill name (highest wins): deepest project dir →
 * shallower project dirs → user dir.
 *
 * Frontmatter:
 *
 *   ---
 *   description: Draft a PR body...       # required
 *   context: inline                       # optional, "inline" (default) or "fork"
 *   agent: general_purpose                # optional, used when context: fork
 *   arguments: "ticket"                   # optional, enables $ticket
 *   paths: "src/**\/*.py, tests/**"       # optional, gitignore-style; skill stays
 *                                          # hidden unless a matching file exists
 *   ---
 *
 * The skill name comes from the folder name. An optional
 * `name:` frontmatter override is intentionally NOT supported — the folder
 * name is the source of truth.
 *
 * Performance notes:
 * - Frontmatter is parsed from the first ~16 KB of `SKILL.md`. Full body
 *   is NOT loaded at scan time; it's read on demand via `loadBody()` when
 *   the model actually invokes the skill (see types.ts). This keeps
 *   startup cheap when a project has dozens of long SKILL.md files.
 * - All file IO across dirs runs in parallel (`Promise.all`).
 */

import { promises as fs } from "fs";
import * as path from "path";
import matter from "gray-matter";
import ignore from "ignore";
import type { SkillDefinition, SkillContextMode } from "./types.js";
import type { ExtensionSource } from "../utils/markdownConfigLoader.js";
import {
  getProjectAppDirsUpToHome,
  getUserSubdir,
} from "../utils/app-dir.js";
import {
  parseArgumentNames,
  parseString,
} from "../utils/frontmatterParser.js";

export interface SkillLoadResult {
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

/**
 * Skill folders are restricted to a safe identifier shape so callers can
 * use the name verbatim in tool inputs / URLs without escaping.
 */
function isValidSkillFolderName(name: string): boolean {
  return /^[a-z0-9][a-z0-9_-]*$/i.test(name);
}

/**
 * Parse `paths:` frontmatter into a clean pattern list. Returns undefined
 * if no patterns are present or they're all match-all (which is the same
 * as "no filter"). Strips trailing `/**` because the `ignore` library
 * already treats a bare path as matching both the path and everything
 * inside it — trailing `/**` is stripped for consistency with gitignore-style matching.
 */
function parseSkillPaths(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;

  let raw: string[];
  if (Array.isArray(value)) {
    raw = value.filter((v): v is string => typeof v === "string");
  } else if (typeof value === "string") {
    raw = value.split(",");
  } else {
    return undefined;
  }

  const patterns = raw
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((p) => (p.endsWith("/**") ? p.slice(0, -3) : p));

  if (patterns.length === 0 || patterns.every((p) => p === "**")) {
    return undefined;
  }
  return patterns;
}

/**
 * Read just enough of a file to extract its YAML frontmatter. Using a
 * single positional read avoids streaming up to EOF for SKILL.md bodies
 * that may be tens of KB. 16 KB is well over typical frontmatter size in
 * size in practice; if we ever undershoot, the caller falls back to a
 * full read so the skill still loads correctly.
 */
async function readFrontmatterChunk(
  filePath: string,
  maxBytes = 16 * 1024,
): Promise<string> {
  const fh = await fs.open(filePath, "r");
  try {
    const buf = Buffer.alloc(maxBytes);
    const { bytesRead } = await fh.read(buf, 0, maxBytes, 0);
    return buf.subarray(0, bytesRead).toString("utf-8");
  } finally {
    await fh.close();
  }
}

/**
 * Returns true if the chunk we read appears to contain a complete
 * frontmatter block (opening `---` plus a matching closing `---`). If
 * false the caller re-reads the full file before parsing — handles the
 * pathological case where someone wrote a >16KB YAML header.
 */
function chunkContainsCompleteFrontmatter(text: string): boolean {
  if (!text.startsWith("---")) {
    // No frontmatter at all is "complete" — gray-matter handles it.
    return true;
  }
  // Look for a second `---` on its own line after position 3.
  return /\n---\s*(\r?\n|$)/.test(text.slice(3));
}

/**
 * Build the lazy body loader for one skill. We re-read the file on first
 * call (rather than holding the body in memory after scan), and cache the
 * result for the lifetime of this SkillDefinition. Re-reads if the load
 * promise rejected so a transient failure doesn't poison subsequent calls.
 */
function makeBodyLoader(filePath: string): () => Promise<string> {
  let cached: Promise<string> | null = null;
  return () => {
    if (cached !== null) return cached;
    cached = (async () => {
      try {
        const raw = await fs.readFile(filePath, "utf-8");
        return matter(raw).content ?? "";
      } catch (e) {
        cached = null; // allow retry next call
        throw e;
      }
    })();
    return cached;
  };
}

/**
 * Load every `<entry>/SKILL.md` directly under `basePath`. Returns one
 * result per skill folder — including errored ones (so the caller can
 * surface them) and excluding entries that don't have a `SKILL.md` at all
 * (those aren't skills, just sibling folders).
 */
export async function loadSkillsFromDir(
  basePath: string,
  source: ExtensionSource,
): Promise<SkillLoadResult[]> {
  let entries: import("fs").Dirent[];
  try {
    entries = await fs.readdir(basePath, { withFileTypes: true });
  } catch (e: unknown) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "EACCES" || code === "ENOTDIR") return [];
    throw e;
  }

  const results = await Promise.all(
    entries.map(async (entry): Promise<SkillLoadResult | null> => {
      // Only folders (or symlinks pointing at folders) are skills — flat
      // .md files directly under `.ai-agent/skills/` are intentionally ignored.
      if (!entry.isDirectory() && !entry.isSymbolicLink()) return null;

      const skillDir = path.join(basePath, entry.name);
      const skillFile = path.join(skillDir, "SKILL.md");

      // Bounded read for frontmatter; full body deferred until invocation.
      let chunk: string;
      try {
        chunk = await readFrontmatterChunk(skillFile);
      } catch (e: unknown) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") {
          console.warn(
            `[skills] failed to read ${skillFile}: ${(e as Error).message}`,
          );
        }
        return null;
      }

      // Fallback for pathologically large headers — re-read whole file.
      // Common case (header fits in 16 KB) avoids ever reading the body.
      let frontmatterSource = chunk;
      if (!chunkContainsCompleteFrontmatter(chunk)) {
        try {
          frontmatterSource = await fs.readFile(skillFile, "utf-8");
        } catch (e) {
          console.warn(
            `[skills] failed to re-read ${skillFile} for oversized frontmatter: ${(e as Error).message}`,
          );
          return null;
        }
      }

      const skillName = entry.name;
      if (!isValidSkillFolderName(skillName)) {
        return {
          skill: null,
          filePath: skillFile,
          error: `skill: invalid folder name '${skillName}' (must match [a-z0-9][a-z0-9_-]*)`,
        };
      }

      let parsed: matter.GrayMatterFile<string>;
      try {
        parsed = matter(frontmatterSource);
      } catch (e: unknown) {
        return {
          skill: null,
          filePath: skillFile,
          error: `skill '${skillName}': invalid YAML frontmatter: ${(e as Error).message}`,
        };
      }

      const fm = (parsed.data ?? {}) as Record<string, unknown>;

      const description = parseString(fm.description);
      if (!description) {
        return {
          skill: null,
          filePath: skillFile,
          error: `skill '${skillName}': missing or empty 'description' in frontmatter`,
        };
      }

      const ctx = parseContextMode(fm.context);
      if (ctx === null) {
        return {
          skill: null,
          filePath: skillFile,
          error: `skill '${skillName}': invalid 'context' value (must be 'inline' or 'fork')`,
        };
      }

      // Body emptiness is checked lazily on first invocation — we don't
      // read it here. That means an all-empty SKILL.md will surface as an
      // error at invoke time instead of scan time. Acceptable trade-off
      // for not paying the body read for every skill on every chat turn.

      return {
        skill: {
          name: skillName,
          description,
          source,
          filePath: skillFile,
          baseDir: skillDir,
          context: ctx,
          agent: parseString(fm.agent),
          argumentNames: parseArgumentNames(fm.arguments),
          paths: parseSkillPaths(fm.paths),
          loadBody: makeBodyLoader(skillFile),
        },
        filePath: skillFile,
      };
    }),
  );

  return results.filter((r): r is SkillLoadResult => r !== null);
}

/**
 * Walk from `cwd` upward, collecting every `.ai-agent/skills/` we find,
 * stopping at the home directory (exclusive — home is treated as the
 * user-skills scope, not a project scope). Order: deepest first.
 *
 */
function getProjectSkillsDirsUpToHome(cwd: string): string[] {
  return getProjectAppDirsUpToHome(cwd).map((appDir) =>
    path.join(appDir, "skills"),
  );
}

/**
 * Scan user + project skill directories for skill folders.
 *
 * Precedence (highest wins on duplicate name):
 *   1. `<cwd>/.ai-agent/skills/` and ancestors up to home (workspace/project)
 *   2. `~/.ai-agent/skills/` (user / root-level baked config)
 *
 * This is intentionally unmemoized — the router calls it per chat request
 * so a user editing a SKILL.md sees the change on the next message
 * without restarting the server. Frontmatter-only reads keep the per-call
 * cost low even with dozens of skills.
 */
export async function loadSkillsFromDisk(cwd: string): Promise<{
  skills: SkillDefinition[];
  errors: Array<{ filePath: string; error: string }>;
}> {
  const userDir = getUserSubdir("skills");
  const projectDirs = getProjectSkillsDirsUpToHome(cwd);

  const [userResults, ...projectResultsByDir] = await Promise.all([
    loadSkillsFromDir(userDir, "user"),
    ...projectDirs.map((d) => loadSkillsFromDir(d, "project")),
  ]);

  const errors: Array<{ filePath: string; error: string }> = [];

  // Fill order: user first (lowest priority), then project dirs SHALLOWEST
  // → DEEPEST so the deepest dir overwrites everything. `projectDirs` is
  // already deepest-first (see getProjectSkillsDirsUpToHome), so iterate
  // it in reverse here.
  const orderedResults = [
    ...userResults,
    ...projectResultsByDir.slice().reverse().flat(),
  ];

  const byName = new Map<string, SkillDefinition>();
  for (const r of orderedResults) {
    if (r.error) {
      errors.push({ filePath: r.filePath, error: r.error });
      console.warn(`[skills] ${r.error} (${r.filePath})`);
    }
    if (r.skill) {
      if (byName.has(r.skill.name)) {
        console.log(
          `[skills] overriding '${r.skill.name}' from ${r.filePath}`,
        );
      }
      byName.set(r.skill.name, r.skill);
    }
  }

  return { skills: [...byName.values()], errors };
}

/**
 * Merge skill lists by name. Inputs are ordered LOWEST priority first, so
 * later lists override earlier ones on duplicate names. Used to layer disk
 * skills (`.ai-agent/skills/`) on top of plugin-contributed skills.
 */
export function mergeSkillsByName(
  ...lists: ReadonlyArray<readonly SkillDefinition[]>
): SkillDefinition[] {
  const byName = new Map<string, SkillDefinition>();
  for (const list of lists) {
    for (const skill of list) {
      if (byName.has(skill.name)) {
        console.log(`[skills] overriding '${skill.name}' from ${skill.filePath ?? skill.baseDir}`);
      }
      byName.set(skill.name, skill);
    }
  }
  return [...byName.values()];
}

/**
 * Filter a skill list by conditional `paths:` matching. Skills without
 * `paths` (the common case) always pass through. Skills WITH `paths` only
 * survive if at least one entry in `candidateFiles` matches their
 * pattern set under gitignore semantics.
 *
 * Patterns are matched against cwd-relative paths so users can write
 * `src/**\/*.py` without worrying about absolute paths. Files outside cwd
 * are skipped (gitignore patterns can't match `../foo` anyway).
 *
 * chat request against a snapshot of files
 * call dynamic activation). For our architecture this is the right
 * granularity — registerSkills already runs once per chat turn.
 *
 * If `candidateFiles` is undefined, conditional skills are dropped
 * (failsafe: a skill that says "use me only with Python projects"
 * shouldn't appear when we have no way to verify). Pass an empty array
 * to express "we checked and found nothing".
 */
export function filterSkillsByPaths(
  skills: readonly SkillDefinition[],
  candidateFiles: readonly string[] | undefined,
  cwd: string,
): SkillDefinition[] {
  if (skills.every((s) => !s.paths || s.paths.length === 0)) {
    // Hot path: no conditional skills at all — skip ignore() construction.
    return [...skills];
  }

  if (candidateFiles === undefined) {
    return skills.filter((s) => !s.paths || s.paths.length === 0);
  }

  const cwdResolved = path.resolve(cwd);
  // Pre-normalize candidate files to cwd-relative POSIX paths. ignore()
  // expects forward slashes on every OS.
  const relCandidates = candidateFiles
    .map((f) => {
      const abs = path.isAbsolute(f) ? f : path.resolve(cwdResolved, f);
      const rel = path.relative(cwdResolved, abs);
      if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
      return rel.split(path.sep).join("/");
    })
    .filter((p): p is string => p !== null);

  return skills.filter((skill) => {
    if (!skill.paths || skill.paths.length === 0) return true;
    if (relCandidates.length === 0) return false;
    const matcher = ignore().add(skill.paths);
    return relCandidates.some((f) => matcher.ignores(f));
  });
}
