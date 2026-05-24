/**
 * Unified loader for flat markdown-frontmatter extensions (agents, commands).
 *
 * Skills have their own loader (`skills/from-folders.ts`) because they are *folders*
 * with bundled assets, not flat `.md` files — but both share the project
 * directory walk in `core/app-dir.ts`.
 *
 * Directory layout:
 *
 *   <ancestor>/.ai-agent/agents/*.md
 *   <ancestor>/.ai-agent/commands/*.md
 *
 *   ~/.ai-agent/agents/*.md
 *   ~/.ai-agent/commands/*.md
 *
 * Resolution: deepest project dir wins, project beats user.
 */

import { promises as fs } from "fs";
import * as path from "path";
import matter from "gray-matter";
import {
  getAppDirName,
  getProjectAppDirsUpToHome,
  getUserSubdir,
} from "./app-dir.js";

/** Flat-file kinds. Skills live in folders and use their own loader. */
export type FlatMarkdownKind = "agents" | "commands";

export type ExtensionSource = "user" | "project";

export interface MarkdownFile {
  /** Absolute path to the .md file. */
  filePath: string;
  /** Absolute base directory the file was discovered under. */
  baseDir: string;
  /** Where the file came from — used for priority resolution and UI display. */
  source: ExtensionSource;
  /** Parsed YAML frontmatter (raw — per-kind parsers narrow this). */
  frontmatter: Record<string, unknown>;
  /** Markdown body with the `--- frontmatter ---` block stripped. */
  body: string;
}

async function listMarkdownFiles(dir: string): Promise<string[]> {
  let entries: import("fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (e: unknown) {
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
    console.warn(
      `[markdown-loader] invalid YAML frontmatter in ${filePath}: ${(e as Error).message}`,
    );
    return null;
  }

  return {
    filePath,
    baseDir,
    source,
    frontmatter: (parsed.data ?? {}) as Record<string, unknown>,
    body: parsed.content ?? "",
  };
}

/**
 * Load all `.md` files for a flat extension kind from user + project dirs.
 *
 * Returned order: project files (shallow → deep), then user files. Per-kind
 * parsers fill a Map keyed by `name` from this list — the last write wins,
 * so deeper project paths override shallower ones, which override user files.
 */
export async function loadMarkdownConfigs(
  kind: FlatMarkdownKind,
  cwd: string,
): Promise<MarkdownFile[]> {
  // `getProjectAppDirsUpToHome` returns deepest-first; we want shallow-first
  // here so a later in-Map write from a deeper dir overrides.
  const projectAppDirs = getProjectAppDirsUpToHome(cwd).slice().reverse();
  const userDir = getUserSubdir(kind);

  const projectLoads = await Promise.all(
    projectAppDirs.map(async (appDir) => {
      const kindDir = path.join(appDir, kind);
      const paths = await listMarkdownFiles(kindDir);
      return Promise.all(paths.map((p) => readAndParse(p, kindDir, "project")));
    }),
  );
  const userPaths = await listMarkdownFiles(userDir);
  const userFiles = await Promise.all(
    userPaths.map((p) => readAndParse(p, userDir, "user")),
  );

  return [...projectLoads.flat(), ...userFiles].filter(
    (f): f is MarkdownFile => f !== null,
  );
}

/** Where would a user/project file for `kind` named `name` live? */
export function suggestedPath(
  kind: FlatMarkdownKind,
  scope: ExtensionSource,
  name: string,
  cwd: string,
): string {
  const dir =
    scope === "user"
      ? getUserSubdir(kind)
      : path.join(path.resolve(cwd), getAppDirName(), kind);
  return path.join(dir, `${name}.md`);
}

export { getAppDirName, getUserSubdir, getProjectAppDirsUpToHome } from "./app-dir.js";
