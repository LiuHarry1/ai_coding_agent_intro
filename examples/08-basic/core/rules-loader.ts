import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import { normalizeGitPath } from "./platform.js";

// Single-file rule docs found at each directory level (in priority order
// per dir — first match wins). AGENTS.md is the cross-tool standard;
// CLAUDE.md is the Anthropic-specific equivalent; .cursorrules is the
// legacy Cursor file (superseded by .cursor/rules/*.md, which we load
// separately below).
const RULE_FILENAMES = ["AGENTS.md", "CLAUDE.md", ".cursorrules"];

// Directory of per-topic markdown rules (Cursor's modern format). All
// .md/.mdc files inside are concatenated, sorted by filename for
// stability.
const RULES_DIR_NAMES = [".cursor/rules"];

// Caps aligned with Claude Code's `MAX_MEMORY_CHARACTER_COUNT = 40000`
// in utils/claudemd.ts. Per-file cap stops a single mega-file from
// dominating; combined cap prevents the merged output from drowning out
// the system prompt itself.
const MAX_SINGLE_FILE_BYTES = 40 * 1024;
const MAX_RULES_BYTES = 40 * 1024;

function findGitRoot(dir: string): string | null {
  try {
    const raw = execSync("git rev-parse --show-toplevel", {
      cwd: dir,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return normalizeGitPath(raw);
  } catch {
    return null;
  }
}

function findRuleFile(dir: string): string | null {
  for (const name of RULE_FILENAMES) {
    const candidate = path.join(dir, name);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }
  return null;
}

interface RuleSource {
  /** Filesystem dir this rule was found under. */
  dir: string;
  /** Display label, e.g. "AGENTS.md" or ".cursor/rules/style.md". */
  label: string;
  content: string;
}

function readRuleFile(absPath: string): string | null {
  try {
    const raw = fs.readFileSync(absPath, "utf-8").trim();
    if (raw.length === 0) return null;
    if (Buffer.byteLength(raw, "utf-8") > MAX_SINGLE_FILE_BYTES) {
      return (
        raw.slice(0, MAX_SINGLE_FILE_BYTES) +
        "\n\n[...truncated — single rule file exceeded per-file cap]"
      );
    }
    return raw;
  } catch {
    return null;
  }
}

/**
 * Collect every .md / .mdc file under `<dir>/.cursor/rules/` (one level
 * deep), sorted by filename so iteration order is stable across runs.
 */
function collectCursorRules(dir: string): RuleSource[] {
  const out: RuleSource[] = [];
  for (const rulesSubpath of RULES_DIR_NAMES) {
    const rulesDir = path.join(dir, rulesSubpath);
    if (!fs.existsSync(rulesDir) || !fs.statSync(rulesDir).isDirectory()) {
      continue;
    }
    let entries: string[];
    try {
      entries = fs.readdirSync(rulesDir).sort();
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!/\.(md|mdc)$/i.test(name)) continue;
      const abs = path.join(rulesDir, name);
      try {
        if (!fs.statSync(abs).isFile()) continue;
      } catch {
        continue;
      }
      const content = readRuleFile(abs);
      if (content !== null) {
        out.push({ dir, label: `${rulesSubpath}/${name}`, content });
      }
    }
  }
  return out;
}

/**
 * Walk from `cwd` up to git root (or filesystem root), collecting:
 *   - one rule file per dir (AGENTS.md > CLAUDE.md > .cursorrules)
 *   - every .md/.mdc under each .cursor/rules/ dir we encounter
 *
 * Files closer to cwd appear LATER in the combined output and therefore
 * take higher priority when the model resolves conflicts (Codex /
 * OpenCode convention). Combined output is capped at MAX_RULES_BYTES.
 */
export function loadProjectRules(cwd: string): string {
  const absDir = path.resolve(cwd);
  const ceiling = findGitRoot(absDir) || path.parse(absDir).root;

  const sources: RuleSource[] = [];
  let cur = absDir;

  while (true) {
    const single = findRuleFile(cur);
    if (single) {
      const content = readRuleFile(single);
      if (content !== null) {
        sources.push({ dir: cur, label: path.basename(single), content });
      }
    }
    sources.push(...collectCursorRules(cur));

    if (cur === ceiling || cur === path.dirname(cur)) break;
    cur = path.dirname(cur);
  }

  if (sources.length === 0) return "";

  // Root-most rules first, cwd-local rules last (higher priority).
  // Reverse the collected list (it was built walking upward).
  sources.reverse();

  let combined = sources
    .map((s) => {
      if (sources.length === 1) return s.content;
      const relDir = path.relative(path.resolve(cwd), s.dir) || ".";
      const header = relDir === "." ? s.label : `${relDir}/${s.label}`;
      return `<!-- from ${header} -->\n${s.content}`;
    })
    .join("\n\n");

  if (Buffer.byteLength(combined, "utf-8") > MAX_RULES_BYTES) {
    combined = combined.slice(0, MAX_RULES_BYTES) + "\n\n[...truncated — combined rules exceeded cap]";
  }

  return combined;
}

/**
 * Check if any rule source exists in the given directory.
 */
export function hasRulesFile(cwd: string): boolean {
  const abs = path.resolve(cwd);
  if (findRuleFile(abs) !== null) return true;
  return collectCursorRules(abs).length > 0;
}
