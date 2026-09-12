/**
 * Auto-memory system + extract prompts.
 * Prefetch mode uses skipIndex (no MEMORY.md Step 2 / no index inject).
 */
import {
  EDIT_FILE_TOOL_NAME,
  GLOB_TOOL_NAME,
  GREP_TOOL_NAME,
  FILE_READ_TOOL_NAME,
  WRITE_FILE_TOOL_NAME,
} from '../../constants/tool_names.js'
import { AUTO_MEM_ENTRYPOINT } from './paths.js'
import {
  MEMORY_FRONTMATTER_EXAMPLE,
  TRUSTING_RECALL_SECTION,
  TYPES_SECTION_INDIVIDUAL,
  WHAT_NOT_TO_SAVE_SECTION,
  WHEN_TO_ACCESS_SECTION,
} from './types.js'

/** Guidance when the memory directory already exists. */
const DIR_EXISTS_GUIDANCE =
  'This directory already exists — write to it directly with the Write tool (do not run mkdir or check for its existence).'

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
    `- \`${AUTO_MEM_ENTRYPOINT}\` lines after 200 will be truncated, so keep the index concise`,
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
    ...TYPES_SECTION_INDIVIDUAL,
    ...WHAT_NOT_TO_SAVE_SECTION,
    '',
    ...howToSaveSection(skipIndex),
    '',
    ...WHEN_TO_ACCESS_SECTION,
    '',
    ...TRUSTING_RECALL_SECTION,
    '',
    '## Persistent custom-agent memory isolation',
    'A custom Agent may have its own Persistent Agent Memory. That namespace belongs to that Agent, not to this main Auto Memory.',
    '- Never copy a value, instruction, preference, or recall result that the user explicitly assigned to that Agent\'s own Persistent Agent Memory into main Auto Memory.',
    '- Delegating a remember/recall task to a memory-enabled Agent is not evidence that the same content should be persisted here.',
    '- Selecting a custom Agent as the main-thread profile is NOT a private-memory assignment. An explicit user request in that main conversation to remember a durable preference still belongs in main Auto Memory unless it came from the Agent\'s private Persistent Agent Memory.',
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
}): string {
  const { newMessageCount, existingMemories, memoryDir } = opts
  const skipIndex = opts.skipIndex !== false
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
    ...TYPES_SECTION_INDIVIDUAL,
    ...WHAT_NOT_TO_SAVE_SECTION,
    '',
    '## Persistent custom-agent memory isolation',
    'Custom Agent Persistent Memory is a separate namespace from main Auto Memory.',
    '- Do not save information from a recent turn when the user explicitly assigned it to that Agent\'s own Persistent Agent Memory.',
    '- Do not copy a private Agent-memory value, the delegation instruction, or the Agent recall result into main Auto Memory.',
    '- If that is the only potentially durable information in the recent messages, make no memory changes.',
    '- A selected main-thread custom Agent profile is not, by itself, private Agent Memory. Save an explicit main-conversation remember request normally unless the value originated from a `Persistent Agent Memory` section or an Agent-tool delegation/recall.',
    '',
    ...howToSaveSection(skipIndex),
  ].join('\n')
}
