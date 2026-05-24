import fs from "fs";
import path from "path";

const root = path.resolve("c:/Users/Harry/cursor_workspace/ai_coding_agent_intro");
const exts = new Set([".ts", ".tsx", ".js", ".jsx"]);

const replacements = [
  [/ \* Mirrors Claude Code's[^\n]*\n/g, ""],
  [/ \* Modeled after Claude Code's[^\n]*\n/g, ""],
  [/ \* Matches Claude Code's[^\n]*\n/g, ""],
  [/ \* Behaviorally identical to Claude Code's[^\n]*\n/g, ""],
  [/ \* Mirrors Claude[^\n]*\n/g, ""],
  [/ \* Mirrors CC's[^\n]*\n/g, ""],
  [/ \* mirroring CC's[^\n]*\n/g, ""],
  [/\/\/ Mirrors CC's[^\n]*\n/g, ""],
  [/\/\/ \(mirrors CC's[^\n]*\n/g, ""],
  [/\/\/ CC default:[^\n]*\n/g, "// Default: bash always; powershell additionally on Windows.\n"],
  [/\/\/ CC: [^\n]*\n/g, ""],
  [/\/\/ CC model:[^\n]*\n/g, ""],
  [/\/\/ CC-style:[^\n]*\n/g, ""],
  [/\/\/ Match Claude Code's[^\n]*\n/g, "// Cap at "],
  [/\/\/ Exit-code rule \(matches Claude Code's[^\n]*\n/g, "// Exit-code rule:\n"],
  [
    /\/\/ Start-of-conversation orphan handling \(mirrors Claude Code's[^\n]*\n/g,
    "// Start-of-conversation orphan handling:\n",
  ],
  [/\/\/ Defaults mirror Claude Code's[^\n]*\n/g, "// Defaults for autocompact thresholds on a 200K model\n"],
  [/\/\/ No direct token-based equivalent in Claude Code[^\n]*\n/g, ""],
  [/\(CC default\)/g, "(default)"],
  [/\(CC: [^)]+\)/g, ""],
  [/\(CC analogue[^)]*\)/g, ""],
  [/\(subset of CC's[^)]*\)/g, ""],
  [/\(matching CC's[^)]*\)/g, ""],
  [/\(CC's rule\)/g, ""],
  [/\(same order as CC's[^)]*\)/g, "(deepest project dir first)"],
  [/\/\/ Equivalent to CC's[^\n]*\n/g, ""],
  [/\/\/ — matches CC's[^\n]*\n/g, ""],
  [/Cursor \/ Claude Code/g, "Cursor"],
  [/Claude Code, Cursor, OpenCode/g, "Cursor, OpenCode"],
  [
    /The Claude Code AgentTool design \(one Task tool \+\n \* dynamic agent list\)/g,
    "A single Agent tool with a dynamic agent list",
  ],
  [/ \* well over CC's effective frontmatter[^\n]*/g, ""],
  [/ \(rather than CC's per-tool-[^\n]*/g, ""],
  [/CC-style: /g, ""],
  [/Two CC-style constructs:/g, "Supported constructs:"],
  [/Frontmatter schema \(subset of CC's slash-command frontmatter\):/g, "Frontmatter schema:"],
  [/Mirrors CC's mid-turn tool activation flow\./g, "Activates deferred tools mid-turn."],
  [/Decision order \(mirrors CC's `isDeferredTool`\):/g, "Decision order:"],
  [/Mirrors CC's `formatCommandsWithinBudget`\./g, ""],
  [/Mirrors CC's ToolSearchTool\. /g, ""],
  [/Mirrors CC's `omitClaudeMd: true` on the Explore agent: /g, ""],
  [/Mirrors CC's `omitClaudeMd: true` on the Plan agent\. /g, ""],
  [
    /Primary shell tool \(CC default: bash, including Git Bash on Windows\)\./g,
    "Primary shell tool (bash, including Git Bash on Windows).",
  ],
  [
    /shell snippets don't treat them as escape sequences\. Mirrors CC's[^\n]*/g,
    "shell snippets don't treat them as escape sequences.",
  ],
  [
    /Parse a "name" key from frontmatter as a stable identifier\. Mirrors CC's[^\n]*/g,
    'Parse a "name" key from frontmatter as a stable identifier.',
  ],
  [
    /files, sub-prompts — that live next to the skill body\. Mirrors Claude[^\n]*/g,
    "files, sub-prompts — that live next to the skill body.",
  ],
  [
    /Cheap \(~1ms per kind for tens of files\)\. Mirrors CC's per-turn[^\n]*/g,
    "Cheap (~1ms per kind for tens of files). Reloaded each turn",
  ],
  [/\(Claude Code style: analysis \+ summary\)/g, "(analysis + summary)"],
  [/Priority \(later overrides earlier, matching CC's `getActiveAgentsFromList`\):/g, "Priority (later overrides earlier):"],
  [/ \* chars\. Mirrors Claude Code's formatError \+ getErrorParts behavior\./g, " * chars."],
];

function walk(dir, files = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === "node_modules" || ent.name === ".git" || ent.name === "scripts") continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, files);
    else if (exts.has(path.extname(ent.name))) files.push(p);
  }
  return files;
}

let changed = 0;
for (const file of walk(root)) {
  let text = fs.readFileSync(file, "utf8");
  const orig = text;
  for (const [re, rep] of replacements) text = text.replace(re, rep);
  if (text !== orig) {
    fs.writeFileSync(file, text);
    changed++;
    console.log("updated:", path.relative(root, file));
  }
}
console.log("total changed:", changed);
