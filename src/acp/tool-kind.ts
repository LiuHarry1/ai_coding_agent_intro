import type { ToolKind, ToolCallLocation } from '@agentclientprotocol/sdk'
import * as path from 'path'
import {
  AGENT_TOOL_NAME,
  BASH_TOOL_NAME,
  EDIT_FILE_TOOL_NAME,
  GLOB_TOOL_NAME,
  GREP_TOOL_NAME,
  POWERSHELL_TOOL_NAME,
  READ_FILE_TOOL_NAME,
  SKILL_TOOL_NAME,
  WEB_FETCH_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
  WRITE_FILE_TOOL_NAME,
} from '../constants/tool_names.js'

export interface ToolDisplayInfo {
  title: string
  kind: ToolKind
  locations?: ToolCallLocation[]
}

function filePathFromArgs(args: unknown): string | null {
  if (!args || typeof args !== 'object') return null
  const record = args as Record<string, unknown>
  const fp = record.file_path ?? record.path
  return typeof fp === 'string' ? fp : null
}

function toDisplayPath(filePath: string, cwd?: string): string {
  if (!cwd) return filePath
  const resolvedCwd = path.resolve(cwd)
  const resolvedFile = path.resolve(filePath)
  if (
    resolvedFile.startsWith(resolvedCwd + path.sep) ||
    resolvedFile === resolvedCwd
  ) {
    return (
      path.relative(resolvedCwd, resolvedFile) || path.basename(resolvedFile)
    )
  }
  return filePath
}


export function toolInfoFromCall(
  name: string,
  args: unknown,
  cwd?: string,
): ToolDisplayInfo {
  switch (name) {
    case AGENT_TOOL_NAME:
    case SKILL_TOOL_NAME: {
      const input = args as { description?: string } | undefined
      return {
        title: input?.description ?? name,
        kind: 'think',
      }
    }
    case BASH_TOOL_NAME:
    case POWERSHELL_TOOL_NAME: {
      const input = args as
        { command?: string; description?: string } | undefined
      return {
        title: input?.command ?? input?.description ?? 'Terminal',
        kind: 'execute',
      }
    }
    case READ_FILE_TOOL_NAME: {
      const fp = filePathFromArgs(args)
      return {
        title: fp ? `Read ${toDisplayPath(fp, cwd)}` : 'Read file',
        kind: 'read',
        locations: fp ? [{ path: fp }] : undefined,
      }
    }
    case WRITE_FILE_TOOL_NAME:
    case EDIT_FILE_TOOL_NAME: {
      const fp = filePathFromArgs(args)
      return {
        title: fp ? `${name} ${toDisplayPath(fp, cwd)}` : name,
        kind: 'edit',
        locations: fp ? [{ path: fp }] : undefined,
      }
    }
    case GLOB_TOOL_NAME:
    case GREP_TOOL_NAME:
      return { title: name, kind: 'search' }
    case WEB_SEARCH_TOOL_NAME:
    case WEB_FETCH_TOOL_NAME:
      return { title: name, kind: 'fetch' }
    default:
      return { title: name, kind: 'other' }
  }
}
