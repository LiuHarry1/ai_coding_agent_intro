/**
 * Single source of truth for "what counts as noise" in file searches.
 * Aligned with claude-code-rev exclusion patterns + workspace walk ignores.
 */

export const VCS_DIRECTORIES = [
  ".git",
  ".svn",
  ".hg",
  ".bzr",
  ".jj",
  ".sl",
] as const;

export const DEPENDENCY_DIRECTORIES = [
  // JS/TS
  "node_modules",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  "dist",
  "build",
  // Python
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  // JVM
  "target",
  ".gradle",
  // Project-specific / misc
  ".sessions",
  "coverage",
  "vendor",
] as const;

export const EXCLUDED_DIR_NAMES: ReadonlySet<string> = new Set([
  ...VCS_DIRECTORIES,
  ...DEPENDENCY_DIRECTORIES,
]);

/** Directories skipped when walking the workspace for @-mention search. */
export const WALK_IGNORE_DIR_NAMES = EXCLUDED_DIR_NAMES;

export function isInsideExcludedDir(relPath: string): boolean {
  return relPath.split("/").some((seg) => EXCLUDED_DIR_NAMES.has(seg));
}

export function hasDotSegment(relPath: string): boolean {
  return relPath.split("/").some((seg) => seg.startsWith("."));
}

export type ExcludeScope = "vcs" | "vcs+deps";

export function buildRgExcludeGlobs(scope: ExcludeScope = "vcs+deps"): string[] {
  const dirs =
    scope === "vcs"
      ? VCS_DIRECTORIES
      : [...VCS_DIRECTORIES, ...DEPENDENCY_DIRECTORIES];

  const args: string[] = [];
  for (const dir of dirs) {
    args.push("--glob", `!${dir}`);
    args.push("--glob", `!${dir}/**`);
    args.push("--glob", `!**/${dir}/**`);
  }
  return args;
}

export function envBool(
  value: string | undefined,
  defaultIfUnset: boolean,
): boolean {
  if (value === undefined) return defaultIfUnset;
  const cleaned = value
    .replace(/\s*#.*$/, "")
    .trim()
    .toLowerCase();
  if (cleaned === "") return defaultIfUnset;
  return (
    cleaned === "1" || cleaned === "true" || cleaned === "yes" || cleaned === "on"
  );
}
