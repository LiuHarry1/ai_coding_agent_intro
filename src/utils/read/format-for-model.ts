/**
 * Model-facing text formatting for Read (line numbers / range header).
 * Out / UI keep raw `file.content`; only mapToolResult uses these helpers.
 */
export function addLineNumbers(lines: string[], startLine: number): string {
  return lines
    .map((line, i) => `${String(startLine + i).padStart(4)}│${line}`)
    .join('\n')
}

export function formatTextReadForModel(file: {
  filePath: string
  content: string
  numLines: number
  startLine: number
  totalLines: number
}): string {
  if (!file.content) return ''
  const lines = file.content.split('\n')
  const endLine = file.startLine + Math.max(lines.length, 1) - 1
  const header = `${file.filePath} (lines ${file.startLine}-${endLine} of ${file.totalLines})`
  return `${header}\n${addLineNumbers(lines, file.startLine)}`
}
