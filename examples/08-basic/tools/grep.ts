/**
 * Grep tool — regex search across files, backed by ripgrep (with pure-Node
 * fallback when `rg` isn't installed).
 *
 * The schema intentionally uses non-standard JS keys ('-A', '-B', '-C',
 * '-n', '-i') because models recognize and emit those rg flag names more
 * reliably than camelCased alternatives.
 *
 * Three output modes:
 *   - "files_with_matches" (default): paths only, sorted by mtime desc.
 *   - "content": matching lines with optional -A/-B/-C context.
 *   - "count": per-file match counts + summary totals.
 */

import { tool } from 'ai'
import { z } from 'zod'
import { stat } from 'fs/promises'
import * as path from 'path'
import { ripGrep } from '../utils/ripgrep.js'
import { resolvePath } from './utils.js'
import type { ToolDefinition } from '../core/types.js'
import {
  AGENT_TOOL_NAME,
  BASH_TOOL_NAME,
  GREP_TOOL_NAME,
  POWERSHELL_TOOL_NAME,
} from '../constants/tool_names.js'
import { isPowerShellToolEnabled } from '../core/shell/shell-utils.js'
import { buildRgExcludeGlobs } from '../constants/file_filters.js'

const DEFAULT_HEAD_LIMIT = 250

function getDescription(): string {
  const shellAvoid = isPowerShellToolEnabled()
    ? `\`${BASH_TOOL_NAME}\` or \`${POWERSHELL_TOOL_NAME}\``
    : `\`${BASH_TOOL_NAME}\``
  return `A powerful search tool built on ripgrep

  Usage:
  - ALWAYS use ${GREP_TOOL_NAME} for search tasks. NEVER invoke \`grep\` or \`rg\` as a ${shellAvoid} command. The ${GREP_TOOL_NAME} tool has been optimized for correct permissions and access.
  - Supports full regex syntax (e.g., "log.*Error", "function\\s+\\w+")
  - Filter files with glob parameter (e.g., "*.js", "**/*.tsx") or type parameter (e.g., "js", "py", "rust")
  - Output modes: "content" shows matching lines, "files_with_matches" shows only file paths (default), "count" shows match counts
  - Use ${AGENT_TOOL_NAME} tool for open-ended searches requiring multiple rounds
  - Pattern syntax: Uses ripgrep (not grep) - literal braces need escaping (use \`interface\\{\\}\` to find \`interface{}\` in Go code)
  - Multiline matching: By default patterns match within single lines only. For cross-line patterns like \`struct \\{[\\s\\S]*?field\`, use \`multiline: true\`
`
}

function applyHeadLimit<T>(
  items: T[],
  limit: number | undefined,
  offset: number = 0,
): { items: T[]; appliedLimit: number | undefined } {
  if (limit === 0) {
    return { items: items.slice(offset), appliedLimit: undefined }
  }
  const effectiveLimit = limit ?? DEFAULT_HEAD_LIMIT
  const sliced = items.slice(offset, offset + effectiveLimit)
  const wasTruncated = items.length - offset > effectiveLimit
  return {
    items: sliced,
    appliedLimit: wasTruncated ? effectiveLimit : undefined,
  }
}

function formatLimitInfo(
  appliedLimit: number | undefined,
  appliedOffset: number | undefined,
): string {
  const parts: string[] = []
  if (appliedLimit !== undefined) parts.push(`limit: ${appliedLimit}`)
  if (appliedOffset) parts.push(`offset: ${appliedOffset}`)
  return parts.join(', ')
}

function plural(n: number, word: string): string {
  return n === 1 ? word : `${word}s`
}

interface GrepArgs {
  pattern: string
  path?: string
  glob?: string
  type?: string
  output_mode?: 'content' | 'files_with_matches' | 'count'
  '-B'?: number
  '-A'?: number
  '-C'?: number
  context?: number
  '-n'?: boolean
  '-i'?: boolean
  head_limit?: number
  offset?: number
  multiline?: boolean
}

export const definition: ToolDefinition = {
  name: GREP_TOOL_NAME,
  description: 'Regex search across files (ripgrep)',
  isConcurrencySafe: () => true,
  create(cwd) {
    return tool({
      description: getDescription(),
      inputSchema: z.object({
        pattern: z
          .string()
          .describe(
            'The regular expression pattern to search for in file contents',
          ),
        path: z
          .string()
          .optional()
          .describe(
            'File or directory to search in (rg PATH). Defaults to current working directory.',
          ),
        glob: z
          .string()
          .optional()
          .describe(
            'Glob pattern to filter files (e.g. "*.js", "*.{ts,tsx}") - maps to rg --glob',
          ),
        output_mode: z
          .enum(['content', 'files_with_matches', 'count'])
          .optional()
          .describe(
            'Output mode: "content" shows matching lines (supports -A/-B/-C context, -n line numbers, head_limit), "files_with_matches" shows file paths (supports head_limit), "count" shows match counts (supports head_limit). Defaults to "files_with_matches".',
          ),
        '-B': z
          .number()
          .optional()
          .describe(
            'Number of lines to show before each match (rg -B). Requires output_mode: "content", ignored otherwise.',
          ),
        '-A': z
          .number()
          .optional()
          .describe(
            'Number of lines to show after each match (rg -A). Requires output_mode: "content", ignored otherwise.',
          ),
        '-C': z.number().optional().describe('Alias for context.'),
        context: z
          .number()
          .optional()
          .describe(
            'Number of lines to show before and after each match (rg -C). Requires output_mode: "content", ignored otherwise.',
          ),
        '-n': z
          .boolean()
          .optional()
          .describe(
            'Show line numbers in output (rg -n). Requires output_mode: "content", ignored otherwise. Defaults to true.',
          ),
        '-i': z
          .boolean()
          .optional()
          .describe('Case insensitive search (rg -i)'),
        type: z
          .string()
          .optional()
          .describe(
            'File type to search (rg --type). Common types: js, py, rust, go, java, etc. More efficient than include for standard file types.',
          ),
        head_limit: z
          .number()
          .optional()
          .describe(
            `Limit output to first N lines/entries, equivalent to "| head -N". Works across all output modes: content (limits output lines), files_with_matches (limits file paths), count (limits count entries). Defaults to ${DEFAULT_HEAD_LIMIT} when unspecified. Pass 0 for unlimited (use sparingly — large result sets waste context).`,
          ),
        offset: z
          .number()
          .optional()
          .describe(
            'Skip first N lines/entries before applying head_limit, equivalent to "| tail -n +N | head -N". Works across all output modes. Defaults to 0.',
          ),
        multiline: z
          .boolean()
          .optional()
          .describe(
            'Enable multiline mode where . matches newlines and patterns can span lines (rg -U --multiline-dotall). Default: false.',
          ),
      }),
      execute: async (rawArgs: GrepArgs) => {
        const {
          pattern,
          path: inputPath,
          glob,
          type,
          output_mode = 'files_with_matches',
          '-B': context_before,
          '-A': context_after,
          '-C': context_c,
          context,
          '-n': show_line_numbers = true,
          '-i': case_insensitive = false,
          head_limit,
          offset = 0,
          multiline = false,
        } = rawArgs

        const resolved = resolvePath(cwd, inputPath ?? '.')
        if ('error' in resolved) return resolved.error
        const absolutePath = resolved.abs

        const args: string[] = ['--hidden']

        // Exclude VCS metadata only — NOT node_modules / dist / etc.
        // Users can scope node_modules via `path` if needed.
        args.push(...buildRgExcludeGlobs('vcs'))

        // Cap line length so base64 blobs / minified files don't blow up
        // the model's context window.
        args.push('--max-columns', '500')

        if (multiline) {
          args.push('-U', '--multiline-dotall')
        }

        if (case_insensitive) {
          args.push('-i')
        }

        if (output_mode === 'files_with_matches') {
          args.push('-l')
        } else if (output_mode === 'count') {
          args.push('-c')
        }

        if (show_line_numbers && output_mode === 'content') {
          args.push('-n')
        }

        // context/`-C` takes precedence over before/after.
        if (output_mode === 'content') {
          if (context !== undefined) {
            args.push('-C', context.toString())
          } else if (context_c !== undefined) {
            args.push('-C', context_c.toString())
          } else {
            if (context_before !== undefined) {
              args.push('-B', context_before.toString())
            }
            if (context_after !== undefined) {
              args.push('-A', context_after.toString())
            }
          }
        }

        // Patterns starting with '-' need -e so rg doesn't parse them as
        // flags.
        if (pattern.startsWith('-')) {
          args.push('-e', pattern)
        } else {
          args.push(pattern)
        }

        if (type) {
          args.push('--type', type)
        }

        // Split glob on whitespace and commas, but preserve patterns with
        // brace expansion (e.g. "*.{ts,tsx}").
        if (glob) {
          const globPatterns: string[] = []
          const rawPatterns = glob.split(/\s+/)
          for (const rawPattern of rawPatterns) {
            if (rawPattern.includes('{') && rawPattern.includes('}')) {
              globPatterns.push(rawPattern)
            } else {
              globPatterns.push(...rawPattern.split(',').filter(Boolean))
            }
          }
          for (const globPattern of globPatterns.filter(Boolean)) {
            args.push('--glob', globPattern)
          }
        }

        const abortController = new AbortController()
        let results: string[]
        try {
          results = await ripGrep(args, absolutePath, abortController.signal)
        } catch (e: unknown) {
          return `Error: ${e instanceof Error ? e.message : String(e)}`
        }

        const toRelative = (abs: string): string => {
          const rel = path.relative(cwd, abs)
          return (rel === '' ? abs : rel).replaceAll('\\', '/')
        }

        // ── content mode ──
        if (output_mode === 'content') {
          const { items: limitedResults, appliedLimit } = applyHeadLimit(
            results,
            head_limit,
            offset,
          )
          const finalLines = limitedResults.map(line => {
            // Lines have format: /absolute/path:line_content or
            // /absolute/path:num:content
            const colonIndex = line.indexOf(':')
            if (colonIndex > 0) {
              const filePath = line.substring(0, colonIndex)
              const rest = line.substring(colonIndex)
              return toRelative(filePath) + rest
            }
            return line
          })
          const content = finalLines.join('\n') || 'No matches found'
          const limitInfo = formatLimitInfo(
            appliedLimit,
            offset > 0 ? offset : undefined,
          )
          return limitInfo
            ? `${content}\n\n[Showing results with pagination = ${limitInfo}]`
            : content
        }

        // ── count mode ──
        if (output_mode === 'count') {
          const { items: limitedResults, appliedLimit } = applyHeadLimit(
            results,
            head_limit,
            offset,
          )
          const finalCountLines = limitedResults.map(line => {
            // Lines have format: /absolute/path:count
            const colonIndex = line.lastIndexOf(':')
            if (colonIndex > 0) {
              const filePath = line.substring(0, colonIndex)
              const count = line.substring(colonIndex)
              return toRelative(filePath) + count
            }
            return line
          })

          let totalMatches = 0
          let fileCount = 0
          for (const line of finalCountLines) {
            const colonIndex = line.lastIndexOf(':')
            if (colonIndex > 0) {
              const count = parseInt(line.substring(colonIndex + 1), 10)
              if (!isNaN(count)) {
                totalMatches += count
                fileCount += 1
              }
            }
          }

          const rawContent = finalCountLines.join('\n') || 'No matches found'
          const limitInfo = formatLimitInfo(
            appliedLimit,
            offset > 0 ? offset : undefined,
          )
          const summary = `\n\nFound ${totalMatches} total ${
            totalMatches === 1 ? 'occurrence' : 'occurrences'
          } across ${fileCount} ${fileCount === 1 ? 'file' : 'files'}.${
            limitInfo ? ` with pagination = ${limitInfo}` : ''
          }`
          return rawContent + summary
        }

        // ── files_with_matches mode (default) ──
        // Use allSettled so a single ENOENT (file deleted between
        // ripgrep's scan and this stat) does not reject the whole batch.
        // Failed stats sort as mtime 0.
        const stats = await Promise.allSettled(results.map(r => stat(r)))
        const sortedMatches = results
          .map((r, i) => {
            const s = stats[i]!
            return [
              r,
              s.status === 'fulfilled' ? (s.value.mtimeMs ?? 0) : 0,
            ] as const
          })
          .sort((a, b) => {
            const timeComparison = b[1] - a[1]
            if (timeComparison === 0) return a[0].localeCompare(b[0])
            return timeComparison
          })
          .map(entry => entry[0])

        const { items: finalMatches, appliedLimit } = applyHeadLimit(
          sortedMatches,
          head_limit,
          offset,
        )
        const relativeMatches = finalMatches.map(toRelative)

        const numFiles = relativeMatches.length
        const limitInfo = formatLimitInfo(
          appliedLimit,
          offset > 0 ? offset : undefined,
        )
        if (numFiles === 0) {
          return 'No files found'
        }
        return `Found ${numFiles} ${plural(numFiles, 'file')}${
          limitInfo ? ` ${limitInfo}` : ''
        }\n${relativeMatches.join('\n')}`
      },
    })
  },
}
