/**
 * Glob tool — fast file pattern matching backed by ripgrep
 * (with pure-Node fallback when `rg` isn't installed).
 *
 * Returns paths sorted by modification time, capped at DEFAULT_LIMIT and
 * relativized to cwd to save tokens.
 */

import { tool } from "ai";
import { z } from "zod";
import * as path from "path";
import { glob as runGlob } from "../utils/glob.js";
import { resolvePath } from "./utils.js";
import type { ToolDefinition } from "../core/types.js";
import { GLOB_TOOL_NAME } from "./tool-names.js";
import { TASK_TOOL_NAME } from "./tool-names.js";

const DESCRIPTION = `- Fast file pattern matching tool that works with any codebase size
- Supports glob patterns like "**/*.js" or "src/**/*.ts"
- Returns matching file paths sorted by modification time
- Use this tool when you need to find files by name patterns
- When you are doing an open ended search that may require multiple rounds of globbing and grepping, use the ${TASK_TOOL_NAME} tool instead`;

const DEFAULT_LIMIT = 150;

// Tool-level post-filter applied to whatever `utils/glob.ts` returns.
// We belt-and-suspenders here: the ripgrep call in utils/glob.ts can be
// configured to exclude these via `--glob !X`, but the default
// `--no-ignore` makes node_modules leak through. A path is excluded if
// ANY segment of its cwd-relative path matches one of these names —
// catches both top-level (`.git/foo`) and nested
// (`client2/web/node_modules/bar`) cases in one shot.
const EXCLUDED_DIR_NAMES = new Set<string>([
  // VCS metadata.
  ".git", ".svn", ".hg", ".bzr", ".jj", ".sl",
  // Dependency / build-artifact dirs (reproducible from source, almost
  // never what the agent is actually looking for).
  "node_modules", ".venv", "venv", "__pycache__",
  ".pytest_cache", ".mypy_cache",
  ".next", ".nuxt", ".turbo", ".cache",
  "dist", "build", "target", ".gradle",
]);

function isInsideExcludedDir(relPath: string): boolean {
  return relPath.split("/").some((seg) => EXCLUDED_DIR_NAMES.has(seg));
}

/**
 * Strip trailing `# …` inline comments from a `.env` value before
 * interpreting it. We do this because `tsx`'s built-in `.env` loader
 * does NOT always strip inline comments — observed in production where
 * `GLOB_HIDDEN=false   # skip dotfiles` yielded
 * `process.env.GLOB_HIDDEN === "false   # skip dotfiles"`. Without
 * this, a literal "false" comparison fails and we silently take the
 * surprise-permissive branch.
 */
function envBool(value: string | undefined, defaultIfUnset: boolean): boolean {
  if (value === undefined) return defaultIfUnset;
  const cleaned = value.replace(/\s*#.*$/, "").trim().toLowerCase();
  if (cleaned === "") return defaultIfUnset;
  return cleaned === "1" || cleaned === "true" || cleaned === "yes" || cleaned === "on";
}

/**
 * `true` when ANY segment of the path starts with `.` — used to skip
 * hidden files / dirs (matching ripgrep's default behavior when
 * `--hidden` is *not* passed). The fallback in utils/ripgrep-fallback.ts
 * is supposed to do this too, but tracked dotfiles (`git add`ed before
 * being added to `.gitignore`) and tsx env-parsing quirks have caused
 * leaks. Filtering here guarantees consistent behavior regardless of
 * which code path ran below.
 */
function hasDotSegment(relPath: string): boolean {
  return relPath.split("/").some((seg) => seg.startsWith("."));
}

export const definition: ToolDefinition = {
  name: GLOB_TOOL_NAME,
  description: "Fast file pattern matching with glob syntax",
  create(cwd) {
    return tool({
      description: DESCRIPTION,
      inputSchema: z.object({
        pattern: z.string().describe("The glob pattern to match files against"),
        path: z
          .string()
          .optional()
          .describe(
            "The directory to search in. If not specified, the current working directory will be used. IMPORTANT: Omit this field to use the default directory. DO NOT enter \"undefined\" or \"null\" - simply omit it for the default behavior. Must be a valid directory path if provided."
          ),
      }),
      execute: async ({ pattern, path: searchPath }: { pattern: string; path?: string }) => {
        const baseRel = searchPath ?? ".";
        const resolved = resolvePath(cwd, baseRel);
        if ("error" in resolved) return resolved.error;
        const searchDir = resolved.abs;

        // We request a much bigger pool than DEFAULT_LIMIT from the
        // util layer because noise dirs (.git, node_modules) tend to
        // sort to the top by mtime and would otherwise eat the entire
        // limit before we get a chance to filter them out here. 10× is
        // the cheapest fix that scales — ripgrep is fast, the cost is
        // just an in-memory array slice in utils/glob.ts.
        const FETCH_LIMIT = DEFAULT_LIMIT * 10;
        let result: { files: string[]; truncated: boolean };
        try {
          result = await runGlob(
            pattern,
            searchDir,
            { limit: FETCH_LIMIT, offset: 0 },
            // AI SDK doesn't surface AbortController to tools yet; pass a
            // never-aborting signal.
            new AbortController().signal
          );
        } catch (e: unknown) {
          return `Error: ${e instanceof Error ? e.message : String(e)}`;
        }

        const allFilenames = result.files.map((abs) => {
          const rel = path.relative(cwd, abs);
          return rel === "" ? "." : rel.replaceAll("\\", "/");
        });

        // Apply tool-level filters BEFORE truncating to DEFAULT_LIMIT so
        // the user-facing limit applies to "real" files only:
        //   1. Noise dir blacklist (.git, node_modules, …).
        //   2. Dotfile filter when GLOB_HIDDEN is falsy. We honor this
        //      at the tool layer because tracked dotfiles (e.g. session
        //      files that were committed before `.gitignore` listed
        //      them) slip past the utils-layer hidden filter.
        const skipHidden = !envBool(process.env.GLOB_HIDDEN, true);
        const allKept = allFilenames.filter(
          (p) => !isInsideExcludedDir(p) && !(skipHidden && hasDotSegment(p))
        );
        const filteredCount = allFilenames.length - allKept.length;

        const filenames = allKept.slice(0, DEFAULT_LIMIT);
        const truncatedAfterFilter =
          allKept.length > DEFAULT_LIMIT || result.truncated;

        if (filenames.length === 0) {
          return filteredCount > 0
            ? `No files found (filtered ${filteredCount} matches in excluded dirs like .git/node_modules; if you really want those, search inside that directory directly via the \`path\` arg).`
            : "No files found";
        }

        const lines = [...filenames];
        if (truncatedAfterFilter) {
          lines.push(
            "(Results are truncated. Consider using a more specific path or pattern.)"
          );
        }
        if (filteredCount > 0) {
          lines.push(
            `(Filtered ${filteredCount} additional matches inside excluded dirs: .git, node_modules, dist, build, etc.)`
          );
        }

        return lines.join("\n");
      },
    });
  },
};
