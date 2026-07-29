/**
 * Session-memory update prompts (Edit-only instructions).
 */
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { getAppDirName } from '../../utils/app-dir.js'
import { DEFAULT_SESSION_MEMORY_TEMPLATE } from './template.js'

export const MAX_SECTION_CHARS = 2000 * 4
export const MAX_TOTAL_SESSION_MEMORY_CHARS = 12_000 * 4
const MAX_SECTION_LENGTH = 2000
const MAX_TOTAL_SESSION_MEMORY_TOKENS = 12_000

function getDefaultUpdatePrompt(): string {
  return `IMPORTANT: This message and these instructions are NOT part of the actual user conversation. Do NOT include any references to "note-taking", "session notes extraction", or these update instructions in the notes content.

Based on the user conversation above (EXCLUDING this note-taking instruction message as well as system prompt, project rules, or any past session summaries), update the session notes file.

The file {{notesPath}} has already been read for you. Here are its current contents:
<current_notes_content>
{{currentNotes}}
</current_notes_content>

Your ONLY task is to use the Edit tool to update the notes file, then stop. You can make multiple edits (update every section as needed) - make all Edit tool calls in parallel in a single message. Do not call any other tools.

CRITICAL RULES FOR EDITING:
- The file must maintain its exact structure with all sections, headers, and italic descriptions intact
-- NEVER modify, delete, or add section headers (the lines starting with '#' like # Task specification)
-- NEVER modify or delete the italic _section description_ lines (these are the lines in italics immediately following each header - they start and end with underscores)
-- The italic _section descriptions_ are TEMPLATE INSTRUCTIONS that must be preserved exactly as-is - they guide what content belongs in each section
-- ONLY update the actual content that appears BELOW the italic _section descriptions_ within each existing section
-- Do NOT add any new sections, summaries, or information outside the existing structure
- Do NOT reference this note-taking process or instructions anywhere in the notes
- It's OK to skip updating a section if there are no substantial new insights to add. Do not add filler content like "No info yet", just leave sections blank/unedited if appropriate.
- Write DETAILED, INFO-DENSE content for each section - include specifics like file paths, function names, error messages, exact commands, technical details, etc.
- For "Key results", include the complete, exact output the user requested (e.g., full table, full answer, etc.)
- Keep each section under ~${MAX_SECTION_LENGTH} tokens/words - if a section is approaching this limit, condense it by cycling out less important details while preserving the most critical information
- Focus on actionable, specific information that would help someone understand or recreate the work discussed in the conversation
- IMPORTANT: Always update "Current State" to reflect the most recent work - this is critical for continuity after compaction

Use the Edit tool with file_path: {{notesPath}}

STRUCTURE PRESERVATION REMINDER:
Each section has TWO parts that must be preserved exactly as they appear in the current file:
1. The section header (line starting with #)
2. The italic description line (the _italicized text_ immediately after the header - this is a template instruction)

You ONLY update the actual content that comes AFTER these two preserved lines. The italic description lines starting and ending with underscores are part of the template structure, NOT content to be edited or removed.

REMEMBER: Use the Edit tool in parallel and stop. Do not continue after the edits. Only include insights from the actual user conversation, never from these note-taking instructions. Do not delete or change section headers or italic _section descriptions_.`
}

function sessionMemoryConfigDirs(cwd?: string): string[] {
  const dirs: string[] = []
  if (cwd) {
    dirs.push(path.join(cwd, '.ai-agent', 'session-memory'))
  }
  dirs.push(path.join(os.homedir(), getAppDirName(), 'session-memory'))
  return dirs
}

/** Load custom template from `.ai-agent/session-memory/template.md` (cwd then user). */
export function loadSessionMemoryTemplate(cwd?: string): string {
  for (const dir of sessionMemoryConfigDirs(cwd)) {
    const p = path.join(dir, 'template.md')
    try {
      if (fs.existsSync(p)) return fs.readFileSync(p, 'utf-8')
    } catch {
      // try next
    }
  }
  // Imported at top — DEFAULT_SESSION_MEMORY_TEMPLATE
  return DEFAULT_SESSION_MEMORY_TEMPLATE
}

function loadSessionMemoryPrompt(cwd?: string): string {
  for (const dir of sessionMemoryConfigDirs(cwd)) {
    const p = path.join(dir, 'prompt.md')
    try {
      if (fs.existsSync(p)) return fs.readFileSync(p, 'utf-8')
    } catch {
      // try next
    }
  }
  return getDefaultUpdatePrompt()
}

function substituteVariables(
  template: string,
  variables: Record<string, string>,
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(variables, key)
      ? variables[key]!
      : match,
  )
}

function analyzeSectionSizes(content: string): Record<string, number> {
  const sections: Record<string, number> = {}
  const lines = content.split('\n')
  let currentSection = ''
  let currentContent: string[] = []

  for (const line of lines) {
    if (line.startsWith('# ')) {
      if (currentSection && currentContent.length > 0) {
        const sectionContent = currentContent.join('\n').trim()
        sections[currentSection] = Math.ceil(sectionContent.length / 4)
      }
      currentSection = line
      currentContent = []
    } else {
      currentContent.push(line)
    }
  }

  if (currentSection && currentContent.length > 0) {
    const sectionContent = currentContent.join('\n').trim()
    sections[currentSection] = Math.ceil(sectionContent.length / 4)
  }

  return sections
}

function generateSectionReminders(
  sectionSizes: Record<string, number>,
  totalTokens: number,
): string {
  const overBudget = totalTokens > MAX_TOTAL_SESSION_MEMORY_TOKENS
  const oversizedSections = Object.entries(sectionSizes)
    .filter(([, tokens]) => tokens > MAX_SECTION_LENGTH)
    .sort(([, a], [, b]) => b - a)
    .map(
      ([section, tokens]) =>
        `- "${section}" is ~${tokens} tokens (limit: ${MAX_SECTION_LENGTH})`,
    )

  if (oversizedSections.length === 0 && !overBudget) {
    return ''
  }

  const parts: string[] = []

  if (overBudget) {
    parts.push(
      `\n\nCRITICAL: The session memory file is currently ~${totalTokens} tokens, which exceeds the maximum of ${MAX_TOTAL_SESSION_MEMORY_TOKENS} tokens. You MUST condense the file to fit within this budget. Aggressively shorten oversized sections by removing less important details, merging related items, and summarizing older entries. Prioritize keeping "Current State" and "Errors & Corrections" accurate and detailed.`,
    )
  }

  if (oversizedSections.length > 0) {
    parts.push(
      `\n\n${overBudget ? 'Oversized sections to condense' : 'IMPORTANT: The following sections exceed the per-section limit and MUST be condensed'}:\n${oversizedSections.join('\n')}`,
    )
  }

  return parts.join('')
}

/**
 * Build the Edit-only update prompt.
 * Conversation context is supplied via forked agent messages, not inlined here.
 */
export function buildSessionMemoryUpdatePrompt(input: {
  notesPath: string
  currentNotes: string
  cwd?: string
}): string {
  const promptTemplate = loadSessionMemoryPrompt(input.cwd)
  const sectionSizes = analyzeSectionSizes(input.currentNotes)
  const totalTokens = Math.ceil(input.currentNotes.length / 4)
  const sectionReminders = generateSectionReminders(sectionSizes, totalTokens)
  const basePrompt = substituteVariables(promptTemplate, {
    currentNotes: input.currentNotes,
    notesPath: input.notesPath,
  })
  return basePrompt + sectionReminders
}

/** Minimal system prompt for the session-memory fork (note-taker only). */
export const SESSION_MEMORY_FORK_SYSTEM_PROMPT = `You are a session-notes updater for a coding agent.

Your ONLY job is to update the session notes markdown file using the Edit tool, then stop.
- Do not answer the user.
- Do not call any tool except Edit.
- Do not modify section headers or italic _section description_ lines.
- Make all needed Edit calls, then end the turn.`

export function formatCompactSummaryMessage(
  summary: string,
  opts?: { recentMessagesPreserved?: boolean; memoryPath?: string },
): string {
  let text = `This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.

${summary.trim()}`

  if (opts?.recentMessagesPreserved) {
    text += `\n\nRecent messages are preserved verbatim.`
  }
  if (opts?.memoryPath) {
    text += `\n\nFull session memory (if truncated above): ${opts.memoryPath}`
  }
  text += `\n\nContinue from where you left off without asking questions. Resume directly — do not acknowledge the summary, do not recap what was happening. Pick up the last task as if the break never happened.`
  return text
}

export function truncateSessionMemoryForCompact(content: string): {
  truncatedContent: string
  wasTruncated: boolean
} {
  const lines = content.split('\n')
  const out: string[] = []
  let header = ''
  let section: string[] = []
  let wasTruncated = false

  const flush = () => {
    if (!header) {
      out.push(...section)
      return
    }
    const body = section.join('\n')
    if (body.length <= MAX_SECTION_CHARS) {
      out.push(header, ...section)
      return
    }
    wasTruncated = true
    let chars = 0
    out.push(header)
    for (const line of section) {
      if (chars + line.length + 1 > MAX_SECTION_CHARS) break
      out.push(line)
      chars += line.length + 1
    }
    out.push('\n[... section truncated for length ...]')
  }

  for (const line of lines) {
    if (line.startsWith('# ')) {
      flush()
      header = line
      section = []
    } else {
      section.push(line)
    }
  }
  flush()

  return { truncatedContent: out.join('\n'), wasTruncated }
}
