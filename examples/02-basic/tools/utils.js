import * as path from "path";

const MAX_OUTPUT = 30000;

export function truncate(text, max = MAX_OUTPUT) {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  return (
    text.slice(0, half) +
    `\n\n... [${text.length - max} chars truncated] ...\n\n` +
    text.slice(-half)
  );
}

export function resolvePath(cwd, filePath) {
  const abs = path.resolve(cwd, filePath);
  if (!abs.startsWith(cwd)) {
    return { error: `Error: access denied — path outside project directory` };
  }
  return { abs };
}
