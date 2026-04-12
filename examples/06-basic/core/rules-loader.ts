import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";

const RULE_FILENAMES = ["AGENTS.md", "CLAUDE.md"];
const MAX_RULES_BYTES = 16 * 1024; // 16KB hard cap

function findGitRoot(dir: string): string | null {
  try {
    return execSync("git rev-parse --show-toplevel", {
      cwd: dir,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
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

/**
 * Walk from `cwd` up to git root (or filesystem root), collecting all
 * AGENTS.md / CLAUDE.md files. Files closer to cwd appear later and
 * take higher priority (consistent with Codex / OpenCode convention).
 */
export function loadProjectRules(cwd: string): string {
  const absDir = path.resolve(cwd);
  const ceiling = findGitRoot(absDir) || path.parse(absDir).root;

  const files: { dir: string; content: string }[] = [];
  let cur = absDir;

  while (true) {
    const found = findRuleFile(cur);
    if (found) {
      try {
        const raw = fs.readFileSync(found, "utf-8").trim();
        if (raw.length > 0) {
          files.push({ dir: cur, content: raw });
        }
      } catch { /* skip unreadable */ }
    }

    if (cur === ceiling || cur === path.dirname(cur)) break;
    cur = path.dirname(cur);
  }

  if (files.length === 0) return "";

  // Root files first, cwd-local files last (higher priority)
  files.reverse();

  let combined = files
    .map((f) => {
      if (files.length === 1) return f.content;
      const rel = path.relative(path.resolve(cwd), f.dir) || ".";
      return `<!-- from ${rel} -->\n${f.content}`;
    })
    .join("\n\n");

  if (Buffer.byteLength(combined, "utf-8") > MAX_RULES_BYTES) {
    combined = combined.slice(0, MAX_RULES_BYTES) + "\n\n[...truncated — rules file too large]";
  }

  return combined;
}

/**
 * Check if a rules file already exists in the given directory.
 */
export function hasRulesFile(cwd: string): boolean {
  return findRuleFile(path.resolve(cwd)) !== null;
}
