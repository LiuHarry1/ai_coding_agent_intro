/** @-mention extraction — from claude-code-rev `utils/attachments.ts`, + CJK-before-@. */

/** Whitespace, line start, or CJK/Hangul/Kana immediately before `@`. */
const AT_MENTION_PREFIX =
  '(?:^|[\\s\\u4e00-\\u9fff\\u3040-\\u30ff\\uac00-\\ud7af])'

export function extractAtMentionedFiles(content: string): string[] {
  const quotedAtMentionRegex = new RegExp(`${AT_MENTION_PREFIX}@"([^"]+)"`, 'g')
  const regularAtMentionRegex = new RegExp(
    `${AT_MENTION_PREFIX}@([^\\s]+)\\b`,
    'g',
  )

  const quotedMatches: string[] = []
  const regularMatches: string[] = []

  let match: RegExpExecArray | null
  while ((match = quotedAtMentionRegex.exec(content)) !== null) {
    if (match[1] && !match[1].endsWith(' (agent)')) {
      quotedMatches.push(match[1])
    }
  }

  const regularMatchArray = content.match(regularAtMentionRegex) || []
  for (const m of regularMatchArray) {
    const filename = m.slice(m.indexOf('@') + 1)
    if (!filename.startsWith('"') && !filename.includes(':')) {
      regularMatches.push(filename)
    }
  }

  return [...new Set([...quotedMatches, ...regularMatches])]
}

export interface AtMentionedFileLines {
  filename: string
  lineStart?: number
  lineEnd?: number
}

export function parseAtMentionedFileLines(
  mention: string,
): AtMentionedFileLines {
  const match = mention.match(/^([^#]+)(?:#L(\d+)(?:-(\d+))?)?(?:#[^#]*)?$/)
  if (!match) return { filename: mention }

  const [, filename, lineStartStr, lineEndStr] = match
  const lineStart = lineStartStr ? parseInt(lineStartStr, 10) : undefined
  const lineEnd = lineEndStr ? parseInt(lineEndStr, 10) : lineStart
  return { filename: filename!, lineStart, lineEnd }
}
