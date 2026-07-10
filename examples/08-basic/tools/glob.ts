/**
 * Glob tool — fast file pattern matching backed by ripgrep
 * (with pure-Node fallback when `rg` isn't installed).
 *
 * Returns paths sorted by modification time, capped at DEFAULT_LIMIT and
 * relativized to cwd to save tokens.
 */

import { tool } from 'ai'
import { z } from 'zod'
import * as path from 'path'
import { glob as runGlob } from '../utils/glob.js'
import { resolvePath } from './utils.js'
import type { ToolDefinition } from '../core/types.js'
import {
  assertAccessibleResolved,
  policyFromContext,
} from '../core/sandbox.js'
import { GLOB_TOOL_NAME } from '../constants/tool_names.js'
import { AGENT_TOOL_NAME } from '../constants/tool_names.js'
import {
  envBool,
  hasDotSegment,
  isInsideExcludedDir,
} from '../constants/file_filters.js'

const DESCRIPTION = `- Fast file pattern matching tool that works with any codebase size
- Supports glob patterns like "**/*.js" or "src/**/*.ts"
- Returns matching file paths sorted by modification time
- Use this tool when you need to find files by name patterns
- When you are doing an open ended search that may require multiple rounds of globbing and grepping, use the ${AGENT_TOOL_NAME} tool instead`

const DEFAULT_LIMIT = 150

// One-time diagnostic on the first glob call, so we can see what env the
// running server actually sees vs. what's in `.env`. Past confusion was
// debugging "GLOB_NO_IGNORE=false in .env but ripgrep still returns
// node_modules" — usually root cause was either a stale server, tsx
// inline-comment parsing, or a subagent in another context.
let diagnosticsLogged = false

export const definition: ToolDefinition = {
  name: GLOB_TOOL_NAME,
  description: 'Fast file pattern matching with glob syntax',
  isConcurrencySafe: () => true,
  create(cwd, context) {
    return tool({
      description: DESCRIPTION,
      inputSchema: z.object({
        pattern: z.string().describe('The glob pattern to match files against'),
        path: z
          .string()
          .optional()
          .describe(
            'The directory to search in. If not specified, the current working directory will be used. IMPORTANT: Omit this field to use the default directory. DO NOT enter "undefined" or "null" - simply omit it for the default behavior. Must be a valid directory path if provided.',
          ),
      }),
      execute: async ({
        pattern,
        path: searchPath,
      }: {
        pattern: string
        path?: string
      }) => {
        const baseRel = searchPath ?? '.'
        const resolved = resolvePath(cwd, baseRel)
        if ('error' in resolved) return resolved.error
        const searchDir = resolved.abs

        try {
          assertAccessibleResolved(
            searchDir,
            policyFromContext(cwd, context.sandbox),
            'read',
          )
        } catch (err) {
          return (err as Error).message
        }

        // We request a much bigger pool than DEFAULT_LIMIT from the
        // util layer because noise dirs (.git, node_modules) tend to
        // sort to the top by mtime and would otherwise eat the entire
        // limit before we get a chance to filter them out here. We use
        // a big 50× multiplier because on freshly `npm install`-ed
        // repos there can be tens of thousands of node_modules entries
        // with recent mtimes — anything smaller risks burying the
        // actual source tree.
        const FETCH_LIMIT = DEFAULT_LIMIT * 50

        if (!diagnosticsLogged) {
          diagnosticsLogged = true
          console.log(
            `[glob] first call: pattern=${JSON.stringify(pattern)} ` +
              `searchDir=${searchDir} ` +
              `env GLOB_NO_IGNORE=${JSON.stringify(process.env.GLOB_NO_IGNORE)} ` +
              `GLOB_HIDDEN=${JSON.stringify(process.env.GLOB_HIDDEN)} ` +
              `RG_FALLBACK=${JSON.stringify(process.env.RG_FALLBACK)}`,
          )
        }
        let result: { files: string[]; truncated: boolean }
        try {
          result = await runGlob(
            pattern,
            searchDir,
            { limit: FETCH_LIMIT, offset: 0 },
            // AI SDK doesn't surface AbortController to tools yet; pass a
            // never-aborting signal.
            new AbortController().signal,
          )
        } catch (e: unknown) {
          return `Error: ${e instanceof Error ? e.message : String(e)}`
        }

        const allFilenames = result.files.map(abs => {
          const rel = path.relative(cwd, abs)
          return rel === '' ? '.' : rel.replaceAll('\\', '/')
        })

        // Telemetry: how much of what utils returned was actually noise?
        // If this number is large, utils-layer .gitignore / --hidden flags
        // are not being honored, regardless of what `.env` says.
        const noiseInUtilsResult = allFilenames.filter(
          p =>
            /^(\.git|node_modules|dist|build|target|\.next|\.cache)(\/|$)/.test(
              p,
            ) || p.includes('/node_modules/'),
        ).length
        if (noiseInUtilsResult > 50) {
          console.warn(
            `[glob] utils returned ${result.files.length} paths of which ${noiseInUtilsResult} are noise ` +
              `(.git/node_modules/dist/…). utils-layer .gitignore filter likely not honored. ` +
              `Tool-layer post-filter will compensate, but consider installing \`rg\` or fixing env propagation.`,
          )
        }

        // Apply tool-level filters BEFORE truncating to DEFAULT_LIMIT so
        // the user-facing limit applies to "real" files only:
        //   1. Noise dir blacklist (.git, node_modules, …).
        //   2. Dotfile filter when GLOB_HIDDEN is falsy. We honor this
        //      at the tool layer because tracked dotfiles (e.g. session
        //      files that were committed before `.gitignore` listed
        //      them) slip past the utils-layer hidden filter.
        const skipHidden = !envBool(process.env.GLOB_HIDDEN, true)
        const allKept = allFilenames.filter(
          p => !isInsideExcludedDir(p) && !(skipHidden && hasDotSegment(p)),
        )
        const filteredCount = allFilenames.length - allKept.length

        const filenames = allKept.slice(0, DEFAULT_LIMIT)
        const truncatedAfterFilter =
          allKept.length > DEFAULT_LIMIT || result.truncated

        if (filenames.length === 0) {
          return filteredCount > 0
            ? `No files found (filtered ${filteredCount} matches in excluded dirs like .git/node_modules; if you really want those, search inside that directory directly via the \`path\` arg).`
            : 'No files found'
        }

        const lines = [...filenames]
        if (truncatedAfterFilter) {
          lines.push(
            '(Results are truncated. Consider using a more specific path or pattern.)',
          )
        }
        if (filteredCount > 0) {
          lines.push(
            `(Filtered ${filteredCount} additional matches inside excluded dirs: .git, node_modules, dist, build, etc.)`,
          )
        }

        return lines.join('\n')
      },
    })
  },
}
