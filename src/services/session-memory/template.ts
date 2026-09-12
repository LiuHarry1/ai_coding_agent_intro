/**
 * Session-memory markdown template.
 */
export const SESSION_MEMORY_SECTION_HEADERS = [
  '# Session Title',
  '# Current State',
  '# Task specification',
  '# Files and Functions',
  '# Workflow',
  '# Errors & Corrections',
  '# Codebase and System Documentation',
  '# Learnings',
  '# Key results',
  '# Worklog',
] as const

export const DEFAULT_SESSION_MEMORY_TEMPLATE = `${SESSION_MEMORY_SECTION_HEADERS[0]}
_A short and distinctive 5-10 word descriptive title for the session. Super info dense, no filler_

${SESSION_MEMORY_SECTION_HEADERS[1]}
_What is actively being worked on right now? Pending tasks not yet completed. Immediate next steps._

${SESSION_MEMORY_SECTION_HEADERS[2]}
_What did the user ask to build? Any design decisions or other explanatory context_

${SESSION_MEMORY_SECTION_HEADERS[3]}
_What are the important files? In short, what do they contain and why are they relevant?_

${SESSION_MEMORY_SECTION_HEADERS[4]}
_What bash commands are usually run and in what order? How to interpret their output if not obvious?_

${SESSION_MEMORY_SECTION_HEADERS[5]}
_Errors encountered and how they were fixed. What did the user correct? What approaches failed and should not be tried again?_

${SESSION_MEMORY_SECTION_HEADERS[6]}
_What are the important system components? How do they work/fit together?_

${SESSION_MEMORY_SECTION_HEADERS[7]}
_What has worked well? What has not? What to avoid? Do not duplicate items from other sections_

${SESSION_MEMORY_SECTION_HEADERS[8]}
_If the user asked a specific output such as an answer to a question, a table, or other document, repeat the exact result here_

${SESSION_MEMORY_SECTION_HEADERS[9]}
_Step by step, what was attempted, done? Very terse summary for each step_
`

export function isEmptySessionMemoryTemplate(content: string): boolean {
  return content.trim() === DEFAULT_SESSION_MEMORY_TEMPLATE.trim()
}

/** Every fixed section header must appear exactly once, in order. */
export function validateSessionMemoryStructure(content: string): boolean {
  let from = 0
  for (const header of SESSION_MEMORY_SECTION_HEADERS) {
    const idx = content.indexOf(header, from)
    if (idx === -1) return false
    from = idx + header.length
  }
  return true
}

function splitKnownSections(content: string): Map<string, string> {
  const sections = new Map<string, string>()
  const lines = content.split('\n')
  let header: string | undefined
  let body: string[] = []

  const flush = () => {
    if (header && !sections.has(header)) {
      sections.set(
        header,
        [header, ...body.filter(line => line.trim() !== 'undefined')]
          .join('\n')
          .trimEnd(),
      )
    }
  }

  for (const line of lines) {
    if ((SESSION_MEMORY_SECTION_HEADERS as readonly string[]).includes(line)) {
      flush()
      header = line
      body = []
    } else if (header) {
      body.push(line)
    }
  }
  flush()
  return sections
}

/**
 * Rebuild a malformed model edit from known sections. Candidate sections win;
 * missing sections fall back to the last valid notes so one bad edit cannot
 * corrupt Session Memory or stall its generation cursor.
 */
export function repairSessionMemoryStructure(
  candidate: string,
  fallback: string,
): string | undefined {
  const candidateSections = splitKnownSections(candidate)
  const fallbackSections = splitKnownSections(fallback)
  const repaired: string[] = []

  for (const header of SESSION_MEMORY_SECTION_HEADERS) {
    const section = candidateSections.get(header) ?? fallbackSections.get(header)
    if (!section) return undefined
    repaired.push(section)
  }
  const result = `${repaired.join('\n\n')}\n`
  return validateSessionMemoryStructure(result) ? result : undefined
}
