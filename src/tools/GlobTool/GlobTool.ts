/**
 * Glob tool — fast file pattern matching backed by ripgrep
 * (with pure-Node fallback when `rg` isn't installed).
 *
 * Dual-channel: execute → `{ data: GlobOutput }`; mapper → model text.
 */

import { tool } from 'ai'
import { z } from 'zod'
import * as fs from 'fs'
import * as path from 'path'
import { buildGlobRgArgs, glob as runGlob } from '../../utils/glob.js'
import { resolvePath } from '../utils.js'
import type {
  DualChannelToolResult,
  ToolDefinition,
  ToolResultBlockParam,
} from '../../core/types.js'
import {
  assertAccessibleResolved,
  policyFromContext,
} from '../../core/sandbox.js'
import { GLOB_TOOL_NAME } from '../../constants/tool_names.js'
import { AGENT_TOOL_NAME } from '../../constants/tool_names.js'
import { isWorkerExecutionBackend } from '../../execution/worker-execution-backend.js'
import { isInsideExcludedDir } from '../../constants/file_filters.js'

const DESCRIPTION = `- Fast file pattern matching tool that works with any codebase size
- Supports glob patterns like "**/*.js" or "src/**/*.ts"
- Returns matching file paths sorted by modification time
- Use this tool when you need to find files by name patterns
- When you are doing an open ended search that may require multiple rounds of globbing and grepping, use the ${AGENT_TOOL_NAME} tool instead`

const DEFAULT_LIMIT = 150

export const GlobOutputSchema = z.object({
  filenames: z.array(z.string()),
  numFiles: z.number(),
  truncated: z.boolean(),
  filteredCount: z.number().optional(),
  durationMs: z.number().optional(),
})

export type GlobOutput = z.infer<typeof GlobOutputSchema>

let diagnosticsLogged = false

const HAS_GLOB_METACHAR = /[*?[{]/

type DirProbe = {
  resolveAbs: (rel: string) => { abs: string } | { error: string }
  isDirectory: (abs: string) => Promise<boolean>
}

function localDirProbe(cwd: string): DirProbe {
  return {
    resolveAbs: rel => resolvePath(cwd, rel),
    async isDirectory(abs) {
      try {
        return fs.statSync(abs).isDirectory()
      } catch {
        return false
      }
    },
  }
}

/**
 * Models often pass a directory path as "pattern" (e.g. .ai-agent/.../memory)
 * with no wildcards. Ripgrep treats that as a literal file name and returns
 * nothing. Rewrite to path + recursive glob when the pattern resolves to a dir.
 *
 * `probe` must stat on the same machine that will run rg (local fs vs SSH Worker).
 */
async function normalizeDirectoryPattern(
  pattern: string,
  searchPath: string | undefined,
  probe: DirProbe,
): Promise<{ pattern: string; searchPath?: string }> {
  if (searchPath || HAS_GLOB_METACHAR.test(pattern)) {
    return { pattern, searchPath }
  }
  const resolved = probe.resolveAbs(pattern)
  if ('error' in resolved) return { pattern, searchPath }
  try {
    if (await probe.isDirectory(resolved.abs)) {
      return { pattern: '**/*', searchPath: pattern }
    }
  } catch {
    // Not a readable dir — keep original pattern for rg error/empty handling.
  }
  return { pattern, searchPath }
}

function mapGlobOutput(
  output: GlobOutput,
  toolUseID: string,
): ToolResultBlockParam {
  if (output.filenames.length === 0) {
    const msg =
      (output.filteredCount ?? 0) > 0
        ? `No files found (filtered ${output.filteredCount} matches in excluded dirs like .git/node_modules; if you really want those, search inside that directory directly via the 'path' arg).`
        : 'No files found'
    return { tool_use_id: toolUseID, type: 'tool_result', content: msg }
  }
  const lines = [...output.filenames]
  if (output.truncated) {
    lines.push(
      '(Results are truncated. Consider using a more specific path or pattern.)',
    )
  }
  if ((output.filteredCount ?? 0) > 0) {
    lines.push(
      `(Filtered ${output.filteredCount} additional matches inside excluded dirs: .git, node_modules, dist, build, etc.)`,
    )
  }
  return {
    tool_use_id: toolUseID,
    type: 'tool_result',
    content: lines.join('\n'),
  }
}

export const definition: ToolDefinition = {
  name: GLOB_TOOL_NAME,
  description: 'Fast file pattern matching with glob syntax',
  isConcurrencySafe: () => true,
  outputSchema: GlobOutputSchema,
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return mapGlobOutput(output as GlobOutput, toolUseID)
  },
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
        pattern: rawPattern,
        path: rawSearchPath,
      }: {
        pattern: string
        path?: string
      }): Promise<DualChannelToolResult<GlobOutput> | string> => {
        const start = Date.now()
        const execution = context.execution
        // Local Worker uses native glob below. Remote (SSH) uses Worker `rg`
        // RPC — argv spawn, exit 0/1 = success (Claude Code style).
        const useRemoteRg =
          !!execution &&
          !(
            isWorkerExecutionBackend(execution) &&
            execution.environmentId === 'local'
          )
        let probe: DirProbe = localDirProbe(cwd)
        if (useRemoteRg && execution) {
          const remote = execution
          probe = {
            resolveAbs: rel => {
              try {
                const abs = remote.resolve(cwd, rel)
                remote.assertInWorkspace(cwd, abs, 'read')
                return { abs }
              } catch (err) {
                return {
                  error: err instanceof Error ? err.message : String(err),
                }
              }
            },
            isDirectory: abs => remote.isDirectory(abs),
          }
        }
        const { pattern, searchPath } = await normalizeDirectoryPattern(
          rawPattern,
          rawSearchPath,
          probe,
        )
        if (useRemoteRg && execution) {
          try {
            const baseRel = searchPath ?? '.'
            const searchDir = execution.resolve(cwd, baseRel)
            execution.assertInWorkspace(cwd, searchDir, 'read')
            const lines = await execution.rg(
              buildGlobRgArgs(pattern),
              searchDir,
              { timeoutMs: 60_000 },
            )
            const files = lines.slice(0, DEFAULT_LIMIT)
            const data: GlobOutput = {
              filenames: files,
              numFiles: files.length,
              truncated: lines.length > DEFAULT_LIMIT,
              durationMs: Date.now() - start,
            }
            return { data }
          } catch (err) {
            return `Error: ${err instanceof Error ? err.message : String(err)}`
          }
        }

        const baseRel = searchPath ?? '.'
        const resolved = resolvePath(cwd, baseRel)
        if ('error' in resolved) {
          return `Error: ${resolved.error || 'Invalid path'}`
        }
        const searchDir = resolved.abs

        try {
          assertAccessibleResolved(
            searchDir,
            policyFromContext(cwd, context.sandbox),
            'read',
          )
        } catch (err) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`
        }

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
            new AbortController().signal,
          )
        } catch (e: unknown) {
          return `Error: ${e instanceof Error ? e.message : String(e)}`
        }

        const allFilenames = result.files.map(abs => {
          const rel = path.relative(cwd, abs)
          return rel === '' ? '.' : rel.replaceAll('\\', '/')
        })

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

        // Hidden paths (.ai-agent, etc.) are included via rg --hidden in
        // utils/glob.ts (GLOB_HIDDEN defaults true). No extra dot-segment
        // post-filter — matches Claude Code GlobTool behavior.
        const allKept = allFilenames.filter(p => !isInsideExcludedDir(p))
        const filteredCount = allFilenames.length - allKept.length
        const filenames = allKept.slice(0, DEFAULT_LIMIT)
        const truncatedAfterFilter =
          allKept.length > DEFAULT_LIMIT || result.truncated

        const data: GlobOutput = {
          filenames,
          numFiles: filenames.length,
          truncated: truncatedAfterFilter,
          filteredCount,
          durationMs: Date.now() - start,
        }
        return { data }
      },
    })
  },
}
