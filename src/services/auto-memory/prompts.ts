/**
 * Auto-memory system + extract prompts, and CC-aligned buildMemoryPrompt
 * used by Agent Memory (memdir.ts parity — no extra bullets).
 * Prefetch mode uses skipIndex (no MEMORY.md Step 2 / no index inject).
 */
import * as fs from 'fs'
import { join } from 'path'
import {
  EDIT_FILE_TOOL_NAME,
  GLOB_TOOL_NAME,
  GREP_TOOL_NAME,
  FILE_READ_TOOL_NAME,
  WRITE_FILE_TOOL_NAME,
} from '../../constants/tool_names.js'
import { AUTO_MEM_ENTRYPOINT } from './paths.js'
import { MAX_ENTRYPOINT_LINES, truncateEntrypointContent } from './scan.js'
import {
  MEMORY_FRONTMATTER_EXAMPLE,
  TRUSTING_RECALL_SECTION,
  TYPES_SECTION_INDIVIDUAL,
  TYPES_SECTION_INDIVIDUAL_EXTERNAL,
  WHAT_NOT_TO_SAVE_SECTION,
  WHAT_NOT_TO_SAVE_SECTION_EXTERNAL,
  WHEN_TO_ACCESS_SECTION,
} from './types.js'
import type { MemoryVocabulary } from '../../core/types.js'

/**
 * The two sections that differ between a coding agent and an agent driving a
 * system it does not edit. Everything else in the guide is shared.
 */
function typesSection(vocabulary: MemoryVocabulary): readonly string[] {
  return vocabulary === 'external'
    ? TYPES_SECTION_INDIVIDUAL_EXTERNAL
    : TYPES_SECTION_INDIVIDUAL
}

function whatNotToSaveSection(vocabulary: MemoryVocabulary): readonly string[] {
  return vocabulary === 'external'
    ? WHAT_NOT_TO_SAVE_SECTION_EXTERNAL
    : WHAT_NOT_TO_SAVE_SECTION
}

/** Guidance when the memory directory already exists. (CC DIR_EXISTS_GUIDANCE) */
export const DIR_EXISTS_GUIDANCE =
  'This directory already exists — write to it directly with the Write tool (do not run mkdir or check for its existence).'

/**
 * CC buildSearchingPastContextSection — gated by tengu_coral_fern (default off).
 * Keep the hook so agent memory lines match CC structure; return [] when off.
 */
export function buildSearchingPastContextSection(
  _memoryDir: string,
): string[] {
  return []
}

/**
 * CC buildMemoryLines — shared by Agent Memory (includes MEMORY.md content)
 * and the typed-memory guide. Do not add product-only bullets here.
 */
export function buildMemoryLines(
  displayName: string,
  memoryDir: string,
  extraGuidelines?: string[],
  skipIndex = false,
  vocabulary: MemoryVocabulary = 'coding',
): string[] {
  const howToSave = skipIndex
    ? [
        '## How to save memories',
        '',
        'Write each memory to its own file (e.g., `user_role.md`, `feedback_testing.md`) using this frontmatter format:',
        '',
        ...MEMORY_FRONTMATTER_EXAMPLE,
        '',
        '- Keep the name, description, and type fields in memory files up-to-date with the content',
        '- Organize memory semantically by topic, not chronologically',
        '- Update or remove memories that turn out to be wrong or outdated',
        '- Do not write duplicate memories. First check if there is an existing memory you can update before writing a new one.',
      ]
    : [
        '## How to save memories',
        '',
        'Saving a memory is a two-step process:',
        '',
        '**Step 1** — write the memory to its own file (e.g., `user_role.md`, `feedback_testing.md`) using this frontmatter format:',
        '',
        ...MEMORY_FRONTMATTER_EXAMPLE,
        '',
        `**Step 2** — add a pointer to that file in \`${AUTO_MEM_ENTRYPOINT}\`. \`${AUTO_MEM_ENTRYPOINT}\` is an index, not a memory — each entry should be one line, under ~150 characters: \`- [Title](file.md) — one-line hook\`. It has no frontmatter. Never write memory content directly into \`${AUTO_MEM_ENTRYPOINT}\`.`,
        '',
        `- \`${AUTO_MEM_ENTRYPOINT}\` is always loaded into your conversation context — lines after ${MAX_ENTRYPOINT_LINES} will be truncated, so keep the index concise`,
        '- Keep the name, description, and type fields in memory files up-to-date with the content',
        '- Organize memory semantically by topic, not chronologically',
        '- Update or remove memories that turn out to be wrong or outdated',
        '- Do not write duplicate memories. First check if there is an existing memory you can update before writing a new one.',
      ]

  const lines: string[] = [
    `# ${displayName}`,
    '',
    `You have a persistent, file-based memory system at \`${memoryDir}\`. ${DIR_EXISTS_GUIDANCE}`,
    '',
    "You should build up this memory system over time so that future conversations can have a complete picture of who the user is, how they'd like to collaborate with you, what behaviors to avoid or repeat, and the context behind the work the user gives you.",
    '',
    'If the user explicitly asks you to remember something, save it immediately as whichever type fits best. If they ask you to forget something, find and remove the relevant entry.',
    '',
    ...typesSection(vocabulary),
    ...whatNotToSaveSection(vocabulary),
    '',
    ...howToSave,
    '',
    ...WHEN_TO_ACCESS_SECTION,
    '',
    ...TRUSTING_RECALL_SECTION,
    '',
    '## Memory and other forms of persistence',
    'Memory is one of several persistence mechanisms available to you as you assist the user in a given conversation. The distinction is often that memory can be recalled in future conversations and should not be used for persisting information that is only useful within the scope of the current conversation.',
    '- When to use or update a plan instead of memory: If you are about to start a non-trivial implementation task and would like to reach alignment with the user on your approach you should use a Plan rather than saving this information to memory. Similarly, if you already have a plan within the conversation and you have changed your approach persist that change by updating the plan rather than saving a memory.',
    '- When to use or update tasks instead of memory: When you need to break your work in current conversation into discrete steps or keep track of your progress use tasks instead of saving to memory. Tasks are great for persisting information about the work that needs to be done in the current conversation, but memory should be reserved for information that will be useful in future conversations.',
    '',
    ...(extraGuidelines ?? []),
    '',
  ]

  lines.push(...buildSearchingPastContextSection(memoryDir))

  return lines
}

/**
 * CC buildMemoryPrompt — Agent Memory (no getClaudeMds equivalent).
 * Embeds MEMORY.md index content when present.
 */
export function buildMemoryPrompt(params: {
  displayName: string
  memoryDir: string
  extraGuidelines?: string[]
  vocabulary?: MemoryVocabulary
}): string {
  const { displayName, memoryDir, extraGuidelines } = params
  const entrypoint = join(memoryDir, AUTO_MEM_ENTRYPOINT)

  let entrypointContent = ''
  try {
    entrypointContent = fs.readFileSync(entrypoint, { encoding: 'utf-8' })
  } catch {
    // No memory file yet
  }

  const lines = buildMemoryLines(
    displayName,
    memoryDir,
    extraGuidelines,
    false,
    params.vocabulary ?? 'coding',
  )

  if (entrypointContent.trim()) {
    const t = truncateEntrypointContent(entrypointContent)
    lines.push(`## ${AUTO_MEM_ENTRYPOINT}`, '', t.content)
  } else {
    lines.push(
      `## ${AUTO_MEM_ENTRYPOINT}`,
      '',
      `Your ${AUTO_MEM_ENTRYPOINT} is currently empty. When you save new memories, they will appear here.`,
    )
  }

  return lines.join('\n')
}

/** Auto-memory how-to-save (may include prefetch-only guidance when skipIndex). */
function howToSaveSection(skipIndex: boolean): string[] {
  if (skipIndex) {
    return [
      '## How to save memories',
      '',
      'Write each memory to its own file (e.g., `user_role.md`, `feedback_testing.md`) using this frontmatter format:',
      '',
      ...MEMORY_FRONTMATTER_EXAMPLE,
      '',
      '- Keep the name, description, and type fields in memory files up-to-date with the content',
      '- Organize memory semantically by topic, not chronologically',
      '- Update or remove memories that turn out to be wrong or outdated',
      '- Do not write duplicate memories. First check if there is an existing memory you can update before writing a new one.',
      '- Relevant memories may be injected via system-reminder attachments; you can also Read/Grep under the memory directory when needed.',
    ]
  }
  return [
    '## How to save memories',
    '',
    'Saving a memory is a two-step process:',
    '',
    '**Step 1** — write the memory to its own file (e.g., `user_role.md`, `feedback_testing.md`) using this frontmatter format:',
    '',
    ...MEMORY_FRONTMATTER_EXAMPLE,
    '',
    `**Step 2** — add a pointer to that file in \`${AUTO_MEM_ENTRYPOINT}\`. \`${AUTO_MEM_ENTRYPOINT}\` is an index, not a memory — each entry should be one line, under ~150 characters: \`- [Title](file.md) — one-line hook\`. It has no frontmatter. Never write memory content directly into \`${AUTO_MEM_ENTRYPOINT}\`.`,
    '',
    `- \`${AUTO_MEM_ENTRYPOINT}\` is always loaded into your conversation context — lines after ${MAX_ENTRYPOINT_LINES} will be truncated, so keep the index concise`,
    '- Keep the name, description, and type fields in memory files up-to-date with the content',
    '- Organize memory semantically by topic, not chronologically',
    '- Update or remove memories that turn out to be wrong or outdated',
    '- Do not write duplicate memories. First check if there is an existing memory you can update before writing a new one.',
  ]
}

/**
 * Main-agent behavioral guide.
 * Default skipIndex=true (prefetch path — no MEMORY.md inject).
 */
export function loadAutoMemoryPrompt(
  memoryDir: string,
  skipIndex = true,
  vocabulary: MemoryVocabulary = 'coding',
): string {
  return [
    '# auto memory',
    '',
    `You have a persistent, file-based memory system at \`${memoryDir}\`. ${DIR_EXISTS_GUIDANCE}`,
    '',
    "You should build up this memory system over time so that future conversations can have a complete picture of who the user is, how they'd like to collaborate with you, what behaviors to avoid or repeat, and the context behind the work the user gives you.",
    '',
    'If the user explicitly asks you to remember something, save it immediately as whichever type fits best. Preserve exact facts, names, paths, identifiers, codes, and literal values verbatim; do not generalize them away. If they ask you to forget something, find and remove the relevant entry.',
    '',
    ...typesSection(vocabulary),
    ...whatNotToSaveSection(vocabulary),
    '',
    ...howToSaveSection(skipIndex),
    '',
    ...WHEN_TO_ACCESS_SECTION,
    '',
    ...TRUSTING_RECALL_SECTION,
    '',
    '## Memory and other forms of persistence',
    'Memory is one of several persistence mechanisms available to you as you assist the user in a given conversation. The distinction is often that memory can be recalled in future conversations and should not be used for persisting information that is only useful within the scope of the current conversation.',
    '- When to use or update a plan instead of memory: If you are about to start a non-trivial implementation task and would like to reach alignment with the user on your approach you should use a Plan rather than saving this information to memory. Similarly, if you already have a plan within the conversation and you have changed your approach persist that change by updating the plan rather than saving a memory.',
    '- When to use or update tasks instead of memory: When you need to break your work in current conversation into discrete steps or keep track of your progress use tasks instead of saving to memory. Tasks are great for persisting information about the work that needs to be done in the current conversation, but memory should be reserved for information that will be useful in future conversations.',
    '',
  ].join('\n')
}

/**
 * Fork extract prompt (auto-memory only).
 * Tool list matches our canUseTool gate (no Bash).
 */
export function buildExtractAutoMemoryPrompt(opts: {
  newMessageCount: number
  existingMemories: string
  memoryDir: string
  skipIndex?: boolean
  vocabulary?: MemoryVocabulary
}): string {
  const { newMessageCount, existingMemories, memoryDir } = opts
  const skipIndex = opts.skipIndex !== false
  const vocabulary = opts.vocabulary ?? 'coding'
  const manifest =
    existingMemories.length > 0
      ? `\n\n## Existing memory files\n\n${existingMemories}\n\nCheck this list before writing — update an existing file rather than creating a duplicate.`
      : ''

  return [
    `You are now acting as the memory extraction subagent. Analyze the most recent ~${newMessageCount} messages above and use them to update your persistent memory systems.`,
    '',
    `Available tools: ${FILE_READ_TOOL_NAME}, ${GREP_TOOL_NAME}, ${GLOB_TOOL_NAME}, and ${EDIT_FILE_TOOL_NAME}/${WRITE_FILE_TOOL_NAME} for paths inside \`${memoryDir}\` only. All other tools will be denied.`,
    '',
    `You have a limited turn budget. ${EDIT_FILE_TOOL_NAME} requires a prior ${FILE_READ_TOOL_NAME} of the same file, so the efficient strategy is: turn 1 — issue all ${FILE_READ_TOOL_NAME} calls in parallel for every file you might update; turn 2 — issue all ${WRITE_FILE_TOOL_NAME}/${EDIT_FILE_TOOL_NAME} calls in parallel. Do not interleave reads and writes across multiple turns.`,
    '',
    `You MUST only use content from the last ~${newMessageCount} messages to update your persistent memories. Do not waste any turns attempting to investigate or verify that content further — no grepping source files, no reading code to confirm a pattern exists, no git commands.` +
      manifest,
    '',
    'If the user explicitly asks you to remember something, save it immediately as whichever type fits best. Preserve exact facts, names, paths, identifiers, codes, and literal values verbatim; do not generalize them away. If they ask you to forget something, find and remove the relevant entry.',
    '',
    ...typesSection(vocabulary),
    ...whatNotToSaveSection(vocabulary),
    '',
    ...howToSaveSection(skipIndex),
  ].join('\n')
}
