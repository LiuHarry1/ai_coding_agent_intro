/**
 * Parse user/project markdown slash-command files into `SlashCommand`.
 *
 * Frontmatter schema :
 *
 *   ---
 *   description: Run lints and auto-fix all reported issues.
 *   argument-hint: "[file-glob]"          # shown in autocomplete
 *   arguments: "scope severity"           # enables $scope / $severity
 *   model: my-model-name              # optional override
 *   ---
 *
 *   Body uses $ARGUMENTS / $1 / $name plus !`shell` and @file directives.
 *
 * The command name is derived from the filename (`fix-lint.md` → `/fix-lint`)
 * so users rename files instead of editing frontmatter to rename a command.
 */

import * as path from 'path'
import type { SlashCommand } from './types.js'
import { sourceRank, type MarkdownFile } from '../utils/markdownConfigLoader.js'
import { parseArgumentNames, parseString } from '../utils/frontmatterParser.js'

const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/i

export interface CommandParseResult {
  command: SlashCommand | null
  filePath: string
  error?: string
}

function fallbackDescription(body: string): string {
  for (const line of body.split('\n')) {
    const t = line.trim()
    if (!t) continue
    const stripped = t.replace(/^#+\s+/, '')
    return stripped.length > 100 ? stripped.slice(0, 97) + '…' : stripped
  }
  return 'Custom slash command'
}

export function parseCommandFromMarkdown(
  file: MarkdownFile,
): CommandParseResult {
  const name = path.basename(file.filePath, '.md')
  if (!NAME_RE.test(name)) {
    return {
      command: null,
      filePath: file.filePath,
      error: `command file '${name}.md': name must match ${NAME_RE} (got '${name}')`,
    }
  }

  const fm = file.frontmatter
  const body = file.body
  if (!body.trim()) {
    return {
      command: null,
      filePath: file.filePath,
      error: `command '/${name}': markdown body is empty`,
    }
  }

  return {
    command: {
      name,
      description: parseString(fm.description) ?? fallbackDescription(body),
      source: file.source,
      filePath: file.filePath,
      argumentHint: parseString(fm['argument-hint']),
      argumentNames: parseArgumentNames(fm.arguments),
      model: parseString(fm.model),
      body,
    },
    filePath: file.filePath,
  }
}

export function mergeCommands(files: readonly MarkdownFile[]): {
  commands: SlashCommand[]
  errors: Array<{ filePath: string; error: string }>
} {
  const errors: Array<{ filePath: string; error: string }> = []

  // plugin → user → project so project overrides user overrides plugin
  // (last write wins in Map).
  const ordered = [...files].sort(
    (a, b) => sourceRank(a.source) - sourceRank(b.source),
  )

  const byName = new Map<string, SlashCommand>()
  for (const f of ordered) {
    const { command, error, filePath } = parseCommandFromMarkdown(f)
    if (error) {
      errors.push({ filePath, error })
      console.warn(`[commands] ${error} (${filePath})`)
    }
    if (command) {
      if (byName.has(command.name)) {
        console.log(
          `[commands] overriding '/${command.name}' from ${f.filePath}`,
        )
      }
      byName.set(command.name, command)
    }
  }

  return { commands: [...byName.values()], errors }
}
