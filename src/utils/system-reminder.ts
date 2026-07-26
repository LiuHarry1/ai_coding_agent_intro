export function isSystemReminderContent(content: string): boolean {
  const t = content.trim()
  return t.startsWith('<system-reminder>') && t.endsWith('</system-reminder>')
}

export function wrapInSystemReminder(content: string): string {
  return `<system-reminder>\n${content}\n</system-reminder>`
}
