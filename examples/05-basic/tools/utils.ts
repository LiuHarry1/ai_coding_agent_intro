import * as path from "path";

const MAX_OUTPUT = 30000;

export function truncate(text: string, max: number = MAX_OUTPUT): string {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  return (
    text.slice(0, half) +
    `\n\n... [${text.length - max} chars truncated] ...\n\n` +
    text.slice(-half)
  );
}

export function resolvePath(
  cwd: string,
  filePath: string
): { abs: string; error?: undefined } | { abs?: undefined; error: string } {
  const abs = path.isAbsolute(filePath)
    ? path.normalize(filePath)
    : path.resolve(cwd, filePath);
  return { abs };
}
