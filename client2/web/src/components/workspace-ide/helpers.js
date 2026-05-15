import { fileName } from "../../lib/utils.js";

const EXT_LANG = {
  ts: "TypeScript", tsx: "TypeScript / TSX",
  js: "JavaScript", jsx: "JavaScript / JSX",
  json: "JSON", md: "Markdown",
  css: "CSS", html: "HTML",
  py: "Python", rs: "Rust", go: "Go",
  yml: "YAML", yaml: "YAML", toml: "TOML",
  sh: "Shell", bash: "Shell",
  txt: "Plain text",
};

/**
 * Human-readable language label inferred from a file's extension, shown in
 * the editor status bar. Falls back to the raw extension, or "Plain text".
 */
export function languageLabel(filePath) {
  const ext = (filePath.split(".").pop() || "").toLowerCase();
  return EXT_LANG[ext] || ext || "Plain text";
}

/**
 * Break a file path into breadcrumb segments relative to the workspace
 * cwd. Used by the editor breadcrumb bar.
 */
export function buildBreadcrumb(filePath, workspace) {
  if (!filePath) return [];
  let rel = filePath;
  if (workspace && filePath.startsWith(workspace)) {
    rel = filePath.slice(workspace.length).replace(/^\/+/, "");
  }
  const parts = rel.split("/").filter(Boolean);
  if (parts.length === 0) return [fileName(filePath)];
  return parts;
}
