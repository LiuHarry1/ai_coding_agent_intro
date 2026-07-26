import { open } from 'fs/promises'
import * as path from 'path'
import { pathToFileURL } from 'url'
import { tool } from 'ai'
import { z } from 'zod'
import type {
  DocumentSymbol,
  Hover,
  Location,
  LocationLink,
  MarkedString,
  MarkupContent,
  SymbolInformation,
} from 'vscode-languageserver-types'
import type { ToolDefinition } from '../../core/types.js'
import { LSP_TOOL_NAME } from '../../constants/tool_names.js'
import { getLspManager } from '../../services/lsp/manager.js'
import { resolvePath } from '../utils.js'

const MAX_LSP_FILE_SIZE_BYTES = 10_000_000

const operations = [
  'go_to_definition',
  'find_references',
  'hover',
  'document_symbol',
  'workspace_symbol',
  'go_to_implementation',
] as const

type LspOperation = (typeof operations)[number]

export const definition: ToolDefinition = {
  name: LSP_TOOL_NAME,
  description: 'Code intelligence via Language Server Protocol',
  shouldDefer: true,
  isConcurrencySafe: () => true,
  create(cwd, context) {
    return tool({
      description: `Use configured Language Server Protocol servers for code intelligence.

Operations:
- go_to_definition: find where the symbol at a position is defined
- find_references: find references for the symbol at a position
- hover: get type/documentation at a position
- document_symbol: list symbols in a file
- workspace_symbol: search workspace symbols, using file_path only to select the server
- go_to_implementation: find implementations at a position

Requires lspServers configuration in .ai-agent/settings.json for the file extension.`,
      inputSchema: z.object({
        operation: z.enum(operations).describe('LSP operation to perform'),
        file_path: z.string().describe('Path to the file, relative to cwd'),
        line: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('1-based line number for position-based operations'),
        character: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('1-based character offset for position-based operations'),
        query: z
          .string()
          .optional()
          .describe('Workspace symbol search query. Defaults to empty string.'),
      }),
      execute: async (input: {
        operation: LspOperation
        file_path: string
        line?: number
        character?: number
        query?: string
      }): Promise<string> => {
        const resolved = resolvePath(cwd, input.file_path)
        if ('error' in resolved) return `Error: ${resolved.error}`
        const absolutePath = resolved.abs

        const manager = getLspManager(cwd, context.lspServers)
        if (!manager) {
          return 'No LSP servers configured. Add lspServers to .ai-agent/settings.json.'
        }

        const server = manager.getServerForFile(absolutePath)
        if (!server) {
          return `No LSP server configured for ${path.extname(absolutePath) || 'this file type'}.`
        }

        const methodAndParams = getMethodAndParams(input, absolutePath)
        if ('error' in methodAndParams) return methodAndParams.error

        try {
          if (!manager.isFileOpen(absolutePath)) {
            const handle = await open(absolutePath, 'r')
            try {
              const stats = await handle.stat()
              if (stats.size > MAX_LSP_FILE_SIZE_BYTES) {
                return `File too large for LSP analysis (${Math.ceil(stats.size / 1_000_000)}MB exceeds 10MB limit).`
              }
              const content = await handle.readFile({ encoding: 'utf-8' })
              await manager.openFile(absolutePath, content)
            } finally {
              await handle.close()
            }
          }

          const result = await manager.sendRequest(
            absolutePath,
            methodAndParams.method,
            methodAndParams.params,
          )
          return formatResult(input.operation, result, cwd)
        } catch (err) {
          return `Error performing ${input.operation}: ${
            err instanceof Error ? err.message : String(err)
          }`
        }
      },
    })
  },
}

function getMethodAndParams(
  input: {
    operation: LspOperation
    line?: number
    character?: number
    query?: string
  },
  absolutePath: string,
): { method: string; params: unknown } | { error: string } {
  const uri = pathToFileURL(absolutePath).href
  const position = makePosition(input)

  switch (input.operation) {
    case 'go_to_definition':
      if ('error' in position) return position
      return {
        method: 'textDocument/definition',
        params: { textDocument: { uri }, position },
      }
    case 'find_references':
      if ('error' in position) return position
      return {
        method: 'textDocument/references',
        params: {
          textDocument: { uri },
          position,
          context: { includeDeclaration: true },
        },
      }
    case 'hover':
      if ('error' in position) return position
      return {
        method: 'textDocument/hover',
        params: { textDocument: { uri }, position },
      }
    case 'document_symbol':
      return {
        method: 'textDocument/documentSymbol',
        params: { textDocument: { uri } },
      }
    case 'workspace_symbol':
      return {
        method: 'workspace/symbol',
        params: { query: input.query ?? '' },
      }
    case 'go_to_implementation':
      if ('error' in position) return position
      return {
        method: 'textDocument/implementation',
        params: { textDocument: { uri }, position },
      }
  }
}

function makePosition(input: {
  line?: number
  character?: number
}): { line: number; character: number } | { error: string } {
  if (!input.line || !input.character) {
    return {
      error:
        'line and character are required for this LSP operation. Use 1-based editor positions.',
    }
  }
  return {
    line: input.line - 1,
    character: input.character - 1,
  }
}

function formatResult(
  operation: LspOperation,
  result: unknown,
  cwd: string,
): string {
  switch (operation) {
    case 'go_to_definition':
    case 'go_to_implementation':
      return formatLocations(result, cwd, 'definition')
    case 'find_references':
      return formatLocations(result, cwd, 'reference')
    case 'hover':
      return formatHover(result as Hover | null)
    case 'document_symbol':
      return formatDocumentSymbols(
        (result as Array<DocumentSymbol | SymbolInformation> | null) ?? [],
        cwd,
      )
    case 'workspace_symbol':
      return formatWorkspaceSymbols(
        (result as SymbolInformation[] | null) ?? [],
        cwd,
      )
  }
}

function formatLocations(
  result: unknown,
  cwd: string,
  label: 'definition' | 'reference',
): string {
  const raw = Array.isArray(result) ? result : result ? [result] : []
  const locations = raw
    .map(toLocation)
    .filter((loc): loc is Location => Boolean(loc?.uri))
  if (locations.length === 0) return `No ${label}s found.`

  const grouped = new Map<string, Location[]>()
  for (const loc of locations) {
    const file = formatUri(loc.uri, cwd)
    const entries = grouped.get(file) ?? []
    entries.push(loc)
    grouped.set(file, entries)
  }

  const lines = [
    `Found ${locations.length} ${label}${locations.length === 1 ? '' : 's'} across ${grouped.size} file${grouped.size === 1 ? '' : 's'}:`,
  ]
  for (const [file, entries] of grouped) {
    lines.push(file)
    for (const loc of entries) {
      lines.push(
        `  line ${loc.range.start.line + 1}, character ${
          loc.range.start.character + 1
        }`,
      )
    }
  }
  return lines.join('\n')
}

function formatHover(result: Hover | null): string {
  if (!result) return 'No hover information found.'
  return (
    extractMarkupText(result.contents).trim() || 'No hover information found.'
  )
}

function formatDocumentSymbols(
  symbols: Array<DocumentSymbol | SymbolInformation>,
  cwd: string,
): string {
  if (symbols.length === 0) return 'No document symbols found.'
  const lines = ['Document symbols:']
  for (const symbol of symbols) {
    if ('location' in symbol) {
      lines.push(
        `- ${symbol.name} (${symbol.kind}) ${formatLocation(symbol.location, cwd)}`,
      )
    } else {
      appendDocumentSymbol(lines, symbol, cwd, 0)
    }
  }
  return lines.join('\n')
}

function appendDocumentSymbol(
  lines: string[],
  symbol: DocumentSymbol,
  cwd: string,
  depth: number,
): void {
  const indent = '  '.repeat(depth)
  lines.push(
    `${indent}- ${symbol.name} (${symbol.kind}) line ${
      symbol.selectionRange.start.line + 1
    }, character ${symbol.selectionRange.start.character + 1}`,
  )
  for (const child of symbol.children ?? []) {
    appendDocumentSymbol(lines, child, cwd, depth + 1)
  }
}

function formatWorkspaceSymbols(
  symbols: SymbolInformation[],
  cwd: string,
): string {
  if (symbols.length === 0) return 'No workspace symbols found.'
  return [
    `Found ${symbols.length} workspace symbol${symbols.length === 1 ? '' : 's'}:`,
    ...symbols.map(
      symbol =>
        `- ${symbol.name} (${symbol.kind}) ${formatLocation(symbol.location, cwd)}`,
    ),
  ].join('\n')
}

function formatLocation(location: Location, cwd: string): string {
  return `${formatUri(location.uri, cwd)}:${location.range.start.line + 1}:${
    location.range.start.character + 1
  }`
}

function formatUri(uri: string, cwd: string): string {
  let filePath = uri.replace(/^file:\/\//, '')
  if (/^\/[A-Za-z]:/.test(filePath)) filePath = filePath.slice(1)
  try {
    filePath = decodeURIComponent(filePath)
  } catch {
    // Keep the undecoded URI path.
  }
  const relative = path.relative(cwd, filePath).replaceAll('\\', '/')
  return relative && !relative.startsWith('..') ? relative : filePath
}

function toLocation(item: Location | LocationLink): Location | null {
  if (!item) return null
  if ('targetUri' in item) {
    return {
      uri: item.targetUri,
      range: item.targetSelectionRange ?? item.targetRange,
    }
  }
  return item
}

function extractMarkupText(
  contents: MarkupContent | MarkedString | MarkedString[],
): string {
  if (Array.isArray(contents)) {
    return contents
      .map(item => (typeof item === 'string' ? item : item.value))
      .join('\n\n')
  }
  if (typeof contents === 'string') return contents
  return contents.value
}
