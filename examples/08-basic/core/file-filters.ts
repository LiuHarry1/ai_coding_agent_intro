/**
 * Single source of truth for "what counts as noise" in file searches.
 *
 * Why this file exists:
 *   Before this, exclusion lists were duplicated across `tools/glob.ts`,
 *   `tools/grep.ts`, `utils/glob.ts`, and `utils/ripgrep-fallback.ts`.
 *   Adding a new noise dir (say `.terraform`) meant grep'ing the repo
 *   for every existing entry and updating each one. This module collects
 *   them in one place; every other module consumes them by import.
 *
 * Two separate groups:
 *   - VCS_DIRECTORIES        — version-control metadata. Always excluded.
 *   - DEPENDENCY_DIRECTORIES — installed deps + build artifacts. Excluded
 *     in glob (where they totally swamp the result set), but NOT in grep
 *     (if the user wants to grep inside node_modules they can opt in via
 *     the `path` arg).
 *
 * Two consumer shapes:
 *   - In-process predicates  (`isInsideExcludedDir`, `hasDotSegment`)
 *     for post-filtering arrays of relative paths.
 *   - Ripgrep arg builders   (`buildRgExcludeGlobs`) for pushing
 *     `--glob !X` pairs into a child-process arg vector.
 *
 * Plus one cross-cutting helper that landed here because it's used by
 * the same set of files: `envBool` — a more forgiving version of
 * `Boolean(process.env.X)` that tolerates `tsx`'s habit of leaving
 * trailing `# comments` in env values.
 */

/**
 * Version control system metadata directories. Always excluded — these
 * are tooling artifacts, never source.
 *
 * Consumers:
 *   - tools/grep.ts            via `buildRgExcludeGlobs("vcs")`
 *   - tools/glob.ts            via `isInsideExcludedDir` (post-filter)
 *   - utils/glob.ts            via `buildRgExcludeGlobs("vcs+deps")`
 *   - utils/ripgrep-fallback.ts as part of the full-walk `ignore` list
 */
export const VCS_DIRECTORIES = [
  ".git",
  ".svn",
  ".hg",
  ".bzr",
  ".jj",
  ".sl",
] as const;

/**
 * Dependency and build-artifact directories. Reproducible from source
 * and almost never what an agent is actually looking for — they exist
 * as gigabytes of noise that drowns out the real codebase.
 *
 * Add new entries here as you encounter ecosystems we don't yet cover
 * (e.g. `.terraform`, `.bazel-out`, `coverage`, `htmlcov`).
 *
 * Consumers:
 *   - tools/glob.ts            via `isInsideExcludedDir` (post-filter)
 *   - utils/glob.ts            via `buildRgExcludeGlobs("vcs+deps")`
 *   - utils/ripgrep-fallback.ts as part of the full-walk `ignore` list
 *   (NOT used by tools/grep.ts — grep stays scoped to VCS only.)
 */
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
] as const;

/**
 * Union set, for predicate-style filtering of in-memory path lists.
 * A Set so the per-segment lookup in `isInsideExcludedDir` is O(1).
 *
 * Consumer: `isInsideExcludedDir` (in this file). External callers
 * should prefer the predicate.
 */
export const EXCLUDED_DIR_NAMES: ReadonlySet<string> = new Set([
  ...VCS_DIRECTORIES,
  ...DEPENDENCY_DIRECTORIES,
]);

/**
 * `true` when ANY segment of `relPath` matches an excluded dir name.
 * Catches both top-level (`.git/foo`) and nested
 * (`client/web/node_modules/bar`) cases in one shot.
 *
 * `relPath` MUST use forward-slash separators; callers are expected to
 * normalize via `.replaceAll("\\", "/")` before passing in.
 *
 * Consumer: tools/glob.ts (tool-layer post-filter, applied after
 * utils/glob.ts returns its pool of candidate paths).
 */
export function isInsideExcludedDir(relPath: string): boolean {
  return relPath.split("/").some((seg) => EXCLUDED_DIR_NAMES.has(seg));
}

/**
 * `true` when ANY segment of `relPath` starts with `.` — used to skip
 * hidden files / dirs (matching ripgrep's default behavior when
 * `--hidden` is *not* passed).
 *
 * Use this defensively in tool-layer post-filters: tracked dotfiles
 * (`git add`ed before being added to `.gitignore`, e.g. an old
 * `.sessions/foo.jsonl` checked in by mistake) slip past the
 * fallback's hidden-filter via `git ls-files --cached`.
 *
 * Consumer: tools/glob.ts (when `GLOB_HIDDEN=false`).
 */
export function hasDotSegment(relPath: string): boolean {
  return relPath.split("/").some((seg) => seg.startsWith("."));
}

export type ExcludeScope = "vcs" | "vcs+deps";

/**
 * Build the `--glob !X` argument pairs for a ripgrep invocation.
 *
 * For each excluded dir we emit THREE patterns because gitignore-style
 * matching semantics differ between real `rg` and our pure-Node
 * fallback (`utils/ripgrep-fallback.ts:matchesAnyGlob`):
 *   - `!node_modules`        — the dir entry itself at root
 *   - `!node_modules/**`     — top-level dir contents
 *   - `!**\/node_modules/**` — nested-anywhere contents
 *
 * Real `rg` would collapse these into one via gitignore semantics, but
 * the fallback only matches basename when the pattern has no `/`, so
 * the contents-anchored variants are required for both top-level and
 * nested matches.
 *
 * @param scope - "vcs" excludes only VCS metadata (used by grep, so the
 *                user can still opt-in to searching inside node_modules
 *                via the `path` arg). "vcs+deps" also excludes
 *                node_modules / dist / venv /… (used by glob, where
 *                noise drowns the result set).
 *
 * Consumers:
 *   - tools/grep.ts  → scope "vcs"
 *   - utils/glob.ts  → scope "vcs+deps"
 */
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

/**
 * Parse a `.env`-style boolean string into a real boolean.
 *
 * Why we don't just use `process.env.X === "true"`: tsx's built-in
 * `.env` parser does NOT reliably strip inline `# comments`, so the
 * value can arrive as `"false   # respect .gitignore"`. Naive equality
 * checks then fall through to the truthy branch (because the string
 * is non-empty), giving surprise-permissive behavior.
 *
 * This helper strips a trailing `# …` comment, trims whitespace, and
 * recognizes the usual truthy spellings (`1`, `true`, `yes`, `on`).
 *
 * Consumers:
 *   - tools/glob.ts  → reads GLOB_HIDDEN to decide tool-layer dotfile filter
 *   - utils/glob.ts  → reads GLOB_NO_IGNORE / GLOB_HIDDEN to decide rg flags
 */
export function envBool(
  value: string | undefined,
  defaultIfUnset: boolean
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
