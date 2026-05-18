/**
 * Unified loader for markdown-frontmatter extension files.
 *
 * Mirrors Claude Code's `src/utils/markdownConfigLoader.ts` — one function
 * (`loadMarkdownFilesForSubdir`) drives discovery for *every* kind of
 * markdown extension (agents, skills, commands, output-styles, …). Per-kind
 * parsers then convert the returned `MarkdownFile[]` into their typed
 * definitions.
 *
 * Directory layout (per CC convention, scoped under `.<dir>` instead of
 * `.claude/<dir>` so we don't squat on the Claude Code namespace):
 *
 *   <cwd>/.agents/*.md         project agents
 *   <cwd>/.skills/*.md         project skills
 *   <cwd>/.commands/*.md       project slash commands
 *
 *   ~/.<APP_DIR_NAME>/agents/*.md     user-scoped equivalents
 *   ~/.<APP_DIR_NAME>/skills/*.md
 *   ~/.<APP_DIR_NAME>/commands/*.md
 *
 * Priority on duplicate `name`: project > user (project closer to cwd wins,
 * same as CC's `getActiveAgentsFromList` semantics). Built-in entries are
 * registered separately and overridden by either of the above.
 */

import { promises as fs } from "fs";
import * as path from "path";
import * as os from "os";
import matter from "gray-matter";

export const APP_DIR_NAME = "myagent";

export type MarkdownConfigKind = "agents" | "skills" | "commands";

export type ExtensionSource = "user" | "project";

export interface MarkdownFile {
  /** Absolute path to the .md file. */
  filePath: string;
  /** Absolute base directory the file was discovered under (for nested support later). */
  baseDir: string;
  /** Where the file came from — used for priority resolution and UI display. */
  source: ExtensionSource;
  /** Parsed YAML frontmatter (raw — per-kind parsers narrow this). */
  frontmatter: Record<string, unknown>;
  /** Markdown body with the `--- frontmatter ---` block stripped. */
  body: string;
}

function userDirFor(kind: MarkdownConfigKind): string {
  return path.join(os.homedir(), `.${APP_DIR_NAME}`, kind);
}

function projectDirFor(kind: MarkdownConfigKind, cwd: string): string {
  return path.join(cwd, `.${kind}`);
}

async function listMarkdownFiles(dir: string): Promise<string[]> {
  let entries: import("fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (e: unknown) {
    // ENOENT / EACCES → silently skip. Anything else we surface.
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "EACCES" || code === "ENOTDIR") return [];
    throw e;
  }
  return entries
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".md"))
    .map((e) => path.join(dir, e.name));
}

async function readAndParse(
  filePath: string,
  baseDir: string,
  source: ExtensionSource,
): Promise<MarkdownFile | null> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf-8");
  } catch (e: unknown) {
    console.warn(`[markdown-loader] failed to read ${filePath}: ${(e as Error).message}`);
    return null;
  }

  let parsed: matter.GrayMatterFile<string>;
  try {
    parsed = matter(raw);
  } catch (e: unknown) {
    console.warn(`[markdown-loader] invalid YAML frontmatter in ${filePath}: ${(e as Error).message}`);
    return null;
  }

  // gray-matter returns `data: {}` even when there's no frontmatter — we
  // keep it (caller decides whether absence of `name` means skip).
  return {
    filePath,
    baseDir,
    source,
    frontmatter: (parsed.data ?? {}) as Record<string, unknown>,
    body: parsed.content ?? "",
  };
}

/**
 * Load all `.md` files for a given extension kind from user + project dirs.
 *
 * Returned order: project files FIRST, then user files. Per-kind parsers
 * push them into a Map keyed by `name` — the LAST write wins, so callers
 * should iterate in REVERSE-priority order (low → high) when filling the
 * Map. This matches `getActiveAgentsFromList` in CC.
 *
 * NOTE on perf: scans are unmemoized intentionally. The router calls this
 * once per chat request (so a user editing an agent .md sees the change
 * on the next message without restarting). Costs ~1ms for tens of files.
 * If you ever have hundreds of extension files, wrap in a memo + chokidar
 * invalidation, mirroring CC's `memoize(loadMarkdownFilesForSubdir, …)`.
 */
export async function loadMarkdownConfigs(
  kind: MarkdownConfigKind,
  cwd: string,
): Promise<MarkdownFile[]> {
  const projectDir = projectDirFor(kind, cwd);
  const userDir = userDirFor(kind);

  const [projectPaths, userPaths] = await Promise.all([
    listMarkdownFiles(projectDir),
    listMarkdownFiles(userDir),
  ]);

  const projectFiles = await Promise.all(
    projectPaths.map((p) => readAndParse(p, projectDir, "project")),
  );
  const userFiles = await Promise.all(
    userPaths.map((p) => readAndParse(p, userDir, "user")),
  );

  return [...projectFiles, ...userFiles].filter(
    (f): f is MarkdownFile => f !== null,
  );
}

/** Convenience: where would a user/project file for `kind` named `name` live? */
export function suggestedPath(
  kind: MarkdownConfigKind,
  scope: ExtensionSource,
  name: string,
  cwd: string,
): string {
  const dir = scope === "user" ? userDirFor(kind) : projectDirFor(kind, cwd);
  return path.join(dir, `${name}.md`);
}
