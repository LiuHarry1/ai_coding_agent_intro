/**
 * Pure-Node fallback for `rg`. Activated transparently by utils/ripgrep.ts
 * when the system `rg` binary is not found (ENOENT). The goal is **output
 * byte-compatibility** with the rg subset our glob/grep tools emit, so
 * downstream parsers see identical lines either way.
 *
 * Supported rg flag subset (anything our tools actually emit):
 *
 *   File-listing mode (utils/glob.ts):
 *     --files --glob <pat> --sort=modified [--no-ignore] [--hidden]
 *
 *   Search modes (tools/grep.ts):
 *     --hidden --glob !<dir> ...               (VCS exclusions)
 *     --max-columns 500                         (silently honored)
 *     [-U --multiline-dotall]                   (multiline)
 *     [-i]                                      (case-insensitive)
 *     [-l | -c]                                 (files_with_matches | count)
 *     [-n]                                      (line numbers, content mode)
 *     [-C N | -B N | -A N]                      (context)
 *     [--type <name>]                           (limited mapping below)
 *     [--glob <pat>] ...                        (include/exclude filters)
 *     [-e <pattern>] | <pattern>                (pattern)
 *
 * Anything else in the args list is silently ignored — better to under-
 * support than to throw on unrecognized flags the model didn't actually
 * need.
 *
 * Output line formats (matching rg):
 *   --files       : '<path-relative-to-search-dir>'
 *   -l            : '<absolute-path>'
 *   -c            : '<absolute-path>:<count>'
 *   content w/ -n : '<absolute-path>:<lineno>:<text>'   (match)
 *                   '<absolute-path>-<lineno>-<text>'   (context)
 *                   '--'                                (between groups)
 *   content no -n : '<absolute-path>:<text>' / '<absolute-path>-<text>'
 *
 * Same exit-code semantics as rg: 0 = matches, 1 = no matches. We don't
 * surface that via exit codes here; we just return a string[] and let
 * the caller treat empty as "no matches".
 *
 * Gitignore behavior: when `--no-ignore` is NOT in args and the target
 * is inside a git work tree, we enumerate files via
 * `git ls-files --cached --others --exclude-standard` — the same set rg
 * would see when respecting .gitignore. This delegates all .gitignore /
 * .git/info/exclude / global gitignore precedence to git itself rather
 * than re-implementing it.
 */

import { glob as globPkg } from "glob";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import {
  DEPENDENCY_DIRECTORIES,
  VCS_DIRECTORIES,
} from "../core/file-filters.js";

const MAX_FILES_SCANNED = 50_000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

// Rough rg --type table. rg's real table has 50+ entries; we cover the
// languages the model is most likely to ask about. Unrecognized type
// names match nothing (same observable behavior as `rg --type bogus`).
const TYPE_GLOBS: Record<string, string[]> = {
  js: ["*.js", "*.jsx", "*.cjs", "*.mjs"],
  ts: ["*.ts", "*.tsx", "*.cts", "*.mts"],
  py: ["*.py"],
  rust: ["*.rs"],
  go: ["*.go"],
  java: ["*.java"],
  c: ["*.c", "*.h"],
  cpp: ["*.cpp", "*.cc", "*.cxx", "*.hpp", "*.hh", "*.hxx"],
  cs: ["*.cs"],
  rb: ["*.rb"],
  php: ["*.php"],
  json: ["*.json"],
  yaml: ["*.yaml", "*.yml"],
  md: ["*.md", "*.markdown"],
  html: ["*.html", "*.htm"],
  css: ["*.css", "*.scss", "*.sass", "*.less"],
  sh: ["*.sh", "*.bash", "*.zsh"],
};

interface ParsedArgs {
  filesMode: boolean;          // --files
  sortModified: boolean;       // --sort=modified
  hidden: boolean;             // --hidden
  noIgnore: boolean;           // --no-ignore (we always behave as if true)
  caseInsensitive: boolean;    // -i
  multiline: boolean;          // -U + --multiline-dotall
  filesWithMatches: boolean;   // -l
  countMode: boolean;          // -c
  showLineNumbers: boolean;    // -n
  context: number;             // -C
  before: number;              // -B
  after: number;               // -A
  maxColumns?: number;         // --max-columns
  type?: string;               // --type
  includeGlobs: string[];      // --glob X
  excludeGlobs: string[];      // --glob !X
  pattern?: string;            // positional or -e
}

function parseArgs(rawArgs: string[]): ParsedArgs {
  const p: ParsedArgs = {
    filesMode: false,
    sortModified: false,
    hidden: false,
    noIgnore: false,
    caseInsensitive: false,
    multiline: false,
    filesWithMatches: false,
    countMode: false,
    showLineNumbers: false,
    context: 0,
    before: 0,
    after: 0,
    includeGlobs: [],
    excludeGlobs: [],
  };

  for (let i = 0; i < rawArgs.length; i++) {
    const a = rawArgs[i];
    switch (a) {
      case "--files": p.filesMode = true; break;
      case "--hidden": p.hidden = true; break;
      case "--no-ignore": p.noIgnore = true; break;
      case "-i": p.caseInsensitive = true; break;
      case "-U": case "--multiline-dotall": p.multiline = true; break;
      case "-l": p.filesWithMatches = true; break;
      case "-c": p.countMode = true; break;
      case "-n": p.showLineNumbers = true; break;
      case "-C": p.context = parseInt(rawArgs[++i] ?? "0", 10) || 0; break;
      case "-B": p.before = parseInt(rawArgs[++i] ?? "0", 10) || 0; break;
      case "-A": p.after = parseInt(rawArgs[++i] ?? "0", 10) || 0; break;
      case "--max-columns": p.maxColumns = parseInt(rawArgs[++i] ?? "0", 10) || undefined; break;
      case "--type": p.type = rawArgs[++i]; break;
      case "--sort=modified": p.sortModified = true; break;
      case "-e": p.pattern = rawArgs[++i]; break;
      case "--glob": {
        const g = rawArgs[++i] ?? "";
        if (g.startsWith("!")) p.excludeGlobs.push(g.slice(1));
        else p.includeGlobs.push(g);
        break;
      }
      default:
        if (a.startsWith("--sort=")) { p.sortModified = a === "--sort=modified"; break; }
        // Unrecognized flags are skipped. Unknown long flags with values
        // would mis-parse — but the only flags we emit are listed above.
        break;
    }
  }

  // Pattern extraction. ripGrepRaw appends `target` to args when spawning
  // the real rg binary, but the fallback receives `args` WITHOUT the
  // appended target (target is passed as the separate runner parameter).
  // So every positional in `rawArgs` here is either the pattern or
  // unrelated. -e takes precedence over a positional pattern (rg behavior).
  let positional: string | undefined;
  for (let i = 0; i < rawArgs.length; i++) {
    const a = rawArgs[i];
    if (a === "-C" || a === "-B" || a === "-A" || a === "--max-columns" ||
        a === "--type" || a === "-e" || a === "--glob") { i++; continue; }
    if (a.startsWith("-")) continue;
    positional = a; // last positional wins
  }
  const ePattern = (() => {
    for (let i = 0; i < rawArgs.length - 1; i++) {
      if (rawArgs[i] === "-e") return rawArgs[i + 1];
    }
    return undefined;
  })();
  if (ePattern !== undefined) p.pattern = ePattern;
  else if (!p.filesMode && positional !== undefined) p.pattern = positional;

  return p;
}

interface MiniMatchOptions { dot: boolean }

function patternToRegex(globPat: string, opts: MiniMatchOptions): RegExp {
  // Minimal glob → regex. Supports **, *, ?, [..], {a,b}. Anchored full
  // path match against POSIX-style paths. Mirrors what minimatch would
  // do for the patterns rg accepts.
  let re = "";
  let i = 0;
  while (i < globPat.length) {
    const c = globPat[i];
    if (c === "*") {
      if (globPat[i + 1] === "*") {
        // ** = any number of path segments
        re += ".*";
        i += 2;
        if (globPat[i] === "/") i++;
        continue;
      }
      re += opts.dot ? "[^/]*" : "(?:(?!\\.)[^/])*";
    } else if (c === "?") {
      re += "[^/]";
    } else if (c === "[") {
      const close = globPat.indexOf("]", i + 1);
      if (close === -1) { re += "\\["; i++; continue; }
      re += globPat.slice(i, close + 1);
      i = close + 1;
      continue;
    } else if (c === "{") {
      const close = globPat.indexOf("}", i + 1);
      if (close === -1) { re += "\\{"; i++; continue; }
      const parts = globPat.slice(i + 1, close).split(",");
      re += "(?:" + parts.map((p) => patternToRegex(p, opts).source.slice(1, -1)).join("|") + ")";
      i = close + 1;
      continue;
    } else if (/[.+^$()|\\]/.test(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
    i++;
  }
  return new RegExp("^" + re + "$");
}

function matchesAnyGlob(relPath: string, globs: string[], dot: boolean): boolean {
  if (globs.length === 0) return false;
  for (const g of globs) {
    // rg's --glob is anchored to repo root by default; patterns without
    // `/` should also match basename (rg gitignore-style).
    if (patternToRegex(g, { dot }).test(relPath)) return true;
    if (!g.includes("/")) {
      const base = relPath.split("/").pop() ?? "";
      if (patternToRegex(g, { dot }).test(base)) return true;
    }
  }
  return false;
}

/**
 * Try to enumerate files via `git ls-files --cached --others
 * --exclude-standard`, which yields the exact set rg would see when
 * respecting .gitignore (tracked + untracked-but-not-ignored). Returns
 * null when `target` is not inside a git work tree.
 *
 * This is how we honor rg's default-respect-.gitignore behavior in the
 * fallback without parsing .gitignore ourselves: let git decide what's
 * ignored, never re-implement the .gitignore precedence rules.
 */
function gitListFiles(targetAbs: string, includeHidden: boolean): string[] | null {
  try {
    // `git ls-files` outputs paths relative to the repo root, not to
    // `target`. We pass `target` as the path filter so we only get what's
    // under it, then make paths relative to `target` ourselves.
    const out = execFileSync(
      "git",
      ["-C", targetAbs, "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 50 * 1024 * 1024 }
    );
    const rels = out.split("\0").filter(Boolean);
    return includeHidden ? rels : rels.filter((r) => !r.split("/").some((seg) => seg.startsWith(".")));
  } catch {
    return null; // not a git repo, or git not installed
  }
}

async function enumerateFiles(
  targetAbs: string,
  parsed: ParsedArgs
): Promise<{ abs: string; rel: string }[]> {
  let st: fs.Stats;
  try { st = fs.statSync(targetAbs); } catch { return []; }
  if (st.isFile()) {
    return [{ abs: targetAbs, rel: path.basename(targetAbs) }];
  }

  // ── Respect .gitignore path ────────────────────────────────────────
  // rg defaults to honoring .gitignore. Our caller suppresses that by
  // passing `--no-ignore` (utils/glob.ts does this when the env var
  // GLOB_NO_IGNORE=true, its default). When the flag is absent, defer
  // to git for the file list.
  if (!parsed.noIgnore) {
    const gitFiles = gitListFiles(targetAbs, parsed.hidden);
    if (gitFiles !== null) {
      let entries = gitFiles.map((rel) => ({
        abs: path.join(targetAbs, rel),
        rel: rel.replaceAll("\\", "/"),
      }));
      if (entries.length > MAX_FILES_SCANNED) entries = entries.slice(0, MAX_FILES_SCANNED);
      // Caller still applies --glob include/exclude + --type filters below;
      // fall through into the existing post-filter block.
      return applyIncludeExcludeFilters(entries, parsed);
    }
    // Not in a git repo → fall through to full walk. Matches rg behavior:
    // outside a git repo, .gitignore has nothing to consult, so default is
    // "see everything".
  }

  // ── Full walk (rg --no-ignore equivalent) ─────────────────────────
  // Ignore patterns mirror `core/file-filters.ts` (VCS + dependency dirs).
  // Built here as `**/<name>/**` patterns because `glob`'s `ignore` option
  // uses gitignore-style globs — same shape we'd emit for ripgrep.
  const fullWalkIgnore = [...VCS_DIRECTORIES, ...DEPENDENCY_DIRECTORIES].map(
    (d) => `**/${d}/**`
  );
  const found = await globPkg("**/*", {
    cwd: targetAbs,
    nodir: true,
    dot: parsed.hidden,
    absolute: false,
    ignore: fullWalkIgnore,
  });

  let entries = found.map((rel) => ({
    abs: path.join(targetAbs, rel),
    rel: rel.replaceAll("\\", "/"),
  }));

  if (entries.length > MAX_FILES_SCANNED) {
    entries = entries.slice(0, MAX_FILES_SCANNED);
  }

  return applyIncludeExcludeFilters(entries, parsed);
}

function applyIncludeExcludeFilters(
  entries: { abs: string; rel: string }[],
  parsed: ParsedArgs
): { abs: string; rel: string }[] {
  // rg semantics: --type and --glob includes act as a whitelist if any
  // are present; --glob !X excludes always subtract.
  const typeIncludes = parsed.type ? TYPE_GLOBS[parsed.type.toLowerCase()] ?? [] : [];
  const allIncludes = [...parsed.includeGlobs, ...typeIncludes];

  let out = entries;
  if (allIncludes.length > 0) {
    out = out.filter((e) => matchesAnyGlob(e.rel, allIncludes, parsed.hidden));
  }
  if (parsed.excludeGlobs.length > 0) {
    out = out.filter((e) => !matchesAnyGlob(e.rel, parsed.excludeGlobs, parsed.hidden));
  }
  return out;
}

function sortByMtimeDesc<T extends { abs: string }>(items: T[]): T[] {
  const withMtime = items.map((it) => {
    let mtime = 0;
    try { mtime = fs.statSync(it.abs).mtimeMs; } catch { /* dangling */ }
    return { it, mtime };
  });
  withMtime.sort((a, b) => b.mtime - a.mtime);
  return withMtime.map((w) => w.it);
}

function readUtf8OrNull(abs: string): string | null {
  let buf: Buffer;
  try {
    const st = fs.statSync(abs);
    if (!st.isFile() || st.size > MAX_FILE_BYTES) return null;
    buf = fs.readFileSync(abs);
  } catch { return null; }
  const sniff = Math.min(buf.length, 8192);
  for (let i = 0; i < sniff; i++) if (buf[i] === 0) return null;
  return buf.toString("utf-8");
}

export async function ripGrepFallback(args: string[], target: string): Promise<string[]> {
  const parsed = parseArgs(args);

  const entries = await enumerateFiles(target, parsed);

  // ── --files (Glob) ───────────────────────────────────────────────
  if (parsed.filesMode) {
    // rg --sort=modified emits oldest-first; utils/glob.ts slices the
    // result without re-sorting, so we mirror that order here. Paths are
    // returned relative to searchDir (the caller joins them).
    const sorted = parsed.sortModified
      ? [...entries].sort((a, b) => {
          let aT = 0, bT = 0;
          try { aT = fs.statSync(a.abs).mtimeMs; } catch { /* ignore */ }
          try { bT = fs.statSync(b.abs).mtimeMs; } catch { /* ignore */ }
          return aT - bT;
        })
      : entries;
    return sorted.map((e) => e.rel);
  }

  if (parsed.pattern === undefined) return [];

  // Compile regex. JS regex flags: `g` always, `i` if -i, `s` if multi-
  // line (so `.` matches newlines). When multiline is OFF we scan
  // line-by-line so '\n' doesn't appear in input.
  let regex: RegExp;
  try {
    const flags = "g" + (parsed.caseInsensitive ? "i" : "") + (parsed.multiline ? "s" : "");
    regex = new RegExp(parsed.pattern, flags);
  } catch {
    return [];
  }

  // ── -l (files_with_matches) ──────────────────────────────────────
  if (parsed.filesWithMatches) {
    const out: { abs: string }[] = [];
    for (const e of entries) {
      const text = readUtf8OrNull(e.abs);
      if (text === null) continue;
      regex.lastIndex = 0;
      if (regex.test(text)) out.push({ abs: e.abs });
    }
    // tools/grep.ts sorts these by mtime itself, but rg also sorts by
    // (its own ordering); returning unsorted is fine — caller sorts.
    return out.map((e) => e.abs);
  }

  // ── -c (count) ───────────────────────────────────────────────────
  if (parsed.countMode) {
    const out: string[] = [];
    for (const e of entries) {
      const text = readUtf8OrNull(e.abs);
      if (text === null) continue;
      regex.lastIndex = 0;
      let count = 0;
      let m: RegExpExecArray | null;
      while ((m = regex.exec(text)) !== null) {
        count++;
        if (m.index === regex.lastIndex) regex.lastIndex++;
      }
      if (count > 0) out.push(`${e.abs}:${count}`);
    }
    return out;
  }

  // ── content mode ─────────────────────────────────────────────────
  // Output format mirrors rg with -n: `<abs>:<lineno>:<text>` for match
  // lines, `<abs>-<lineno>-<text>` for context lines, `--` between
  // groups within the same file.
  const before = parsed.context || parsed.before;
  const after = parsed.context || parsed.after;
  const showN = parsed.showLineNumbers;
  const maxColumns = parsed.maxColumns;
  const lines: string[] = [];

  for (const e of entries) {
    const text = readUtf8OrNull(e.abs);
    if (text === null) continue;

    const fileLines = text.split("\n");
    const matchedLines = new Set<number>();

    if (parsed.multiline) {
      regex.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = regex.exec(text)) !== null) {
        const upto = text.slice(0, m.index);
        const startLine = upto.split("\n").length;
        const endLine = startLine + m[0].split("\n").length - 1;
        for (let ln = startLine; ln <= endLine; ln++) matchedLines.add(ln);
        if (m.index === regex.lastIndex) regex.lastIndex++;
      }
    } else {
      for (let i = 0; i < fileLines.length; i++) {
        regex.lastIndex = 0;
        if (regex.test(fileLines[i])) matchedLines.add(i + 1);
      }
    }

    if (matchedLines.size === 0) continue;

    // Build merged windows of [start,end] line ranges, merge overlaps.
    const matched = [...matchedLines].sort((a, b) => a - b);
    const windows: Array<[number, number]> = [];
    for (const ln of matched) {
      const s = Math.max(1, ln - before);
      const en = Math.min(fileLines.length, ln + after);
      const last = windows[windows.length - 1];
      if (last && s <= last[1] + 1) last[1] = Math.max(last[1], en);
      else windows.push([s, en]);
    }

    for (let w = 0; w < windows.length; w++) {
      if (w > 0) lines.push("--");
      const [s, en] = windows[w];
      for (let i = s; i <= en; i++) {
        const isMatch = matchedLines.has(i);
        const sep = isMatch ? ":" : "-";
        let body = fileLines[i - 1] ?? "";
        if (maxColumns && body.length > maxColumns) {
          body = body.slice(0, maxColumns) + " [... omitted ...]";
        }
        lines.push(`${e.abs}${sep}${showN ? `${i}${sep}` : ""}${body}`);
      }
    }
  }

  return lines;
}
