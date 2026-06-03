/** @-mention extraction — from claude-code-rev `utils/attachments.ts`. */

export function extractAtMentionedFiles(content: string): string[] {
  const quotedAtMentionRegex = /(^|\s)@"([^"]+)"/g;
  const regularAtMentionRegex = /(^|\s)@([^\s]+)\b/g;

  const quotedMatches: string[] = [];
  const regularMatches: string[] = [];

  let match: RegExpExecArray | null;
  while ((match = quotedAtMentionRegex.exec(content)) !== null) {
    if (match[2] && !match[2].endsWith(" (agent)")) {
      quotedMatches.push(match[2]);
    }
  }

  const regularMatchArray = content.match(regularAtMentionRegex) || [];
  for (const m of regularMatchArray) {
    const filename = m.slice(m.indexOf("@") + 1);
    if (!filename.startsWith('"') && !filename.includes(":")) {
      regularMatches.push(filename);
    }
  }

  return [...new Set([...quotedMatches, ...regularMatches])];
}

export interface AtMentionedFileLines {
  filename: string;
  lineStart?: number;
  lineEnd?: number;
}

export function parseAtMentionedFileLines(mention: string): AtMentionedFileLines {
  const match = mention.match(/^([^#]+)(?:#L(\d+)(?:-(\d+))?)?(?:#[^#]*)?$/);
  if (!match) return { filename: mention };

  const [, filename, lineStartStr, lineEndStr] = match;
  const lineStart = lineStartStr ? parseInt(lineStartStr, 10) : undefined;
  const lineEnd = lineEndStr ? parseInt(lineEndStr, 10) : lineStart;
  return { filename: filename!, lineStart, lineEnd };
}
