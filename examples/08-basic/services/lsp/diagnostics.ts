import { fileURLToPath } from 'url'
import type {
  LspDiagnostic,
  LspDiagnosticFile,
  PendingLspDiagnosticSet,
} from './types.js'

const MAX_DIAGNOSTICS_PER_FILE = 10
const MAX_TOTAL_DIAGNOSTICS = 30
const MAX_DELIVERED_FILES = 500

const pendingByWorkspace = new Map<string, PendingLspDiagnosticSet[]>()
const deliveredByWorkspace = new Map<string, Map<string, Set<string>>>()

function severityName(
  severity: number | undefined,
): LspDiagnostic['severity'] {
  switch (severity) {
    case 1:
      return 'Error'
    case 2:
      return 'Warning'
    case 3:
      return 'Info'
    case 4:
      return 'Hint'
    default:
      return 'Error'
  }
}

function severityRank(severity: LspDiagnostic['severity']): number {
  switch (severity) {
    case 'Error':
      return 1
    case 'Warning':
      return 2
    case 'Info':
      return 3
    case 'Hint':
      return 4
  }
}

function normalizeUri(uri: string): string {
  if (!uri.startsWith('file://')) return uri
  try {
    return fileURLToPath(uri)
  } catch {
    return uri
  }
}

function diagnosticKey(diag: LspDiagnostic): string {
  return JSON.stringify({
    message: diag.message,
    severity: diag.severity,
    range: diag.range,
    source: diag.source ?? null,
    code: diag.code ?? null,
  })
}

function deliveredForWorkspace(workspaceKey: string): Map<string, Set<string>> {
  let delivered = deliveredByWorkspace.get(workspaceKey)
  if (!delivered) {
    delivered = new Map()
    deliveredByWorkspace.set(workspaceKey, delivered)
  }
  return delivered
}

export function registerPendingLspDiagnostics(
  workspaceKey: string,
  serverName: string,
  files: LspDiagnosticFile[],
): void {
  if (files.length === 0) return
  const pending = pendingByWorkspace.get(workspaceKey) ?? []
  pending.push({ serverName, files })
  pendingByWorkspace.set(workspaceKey, pending)
}

export function convertPublishDiagnostics(params: {
  uri: string
  diagnostics: Array<{
    message: string
    severity?: number
    range: {
      start: { line: number; character: number }
      end: { line: number; character: number }
    }
    source?: string
    code?: string | number
  }>
}): LspDiagnosticFile[] {
  return [
    {
      uri: normalizeUri(params.uri),
      diagnostics: params.diagnostics.map(diag => ({
        message: diag.message,
        severity: severityName(diag.severity),
        range: diag.range,
        source: diag.source,
        code: diag.code === undefined ? undefined : String(diag.code),
      })),
    },
  ]
}

export function drainPendingLspDiagnostics(
  workspaceKey: string,
): PendingLspDiagnosticSet[] {
  const pending = pendingByWorkspace.get(workspaceKey) ?? []
  pendingByWorkspace.delete(workspaceKey)
  if (pending.length === 0) return []

  const delivered = deliveredForWorkspace(workspaceKey)
  const fileMap = new Map<string, LspDiagnosticFile>()
  const seenThisDrain = new Map<string, Set<string>>()
  const serverNames = new Set<string>()

  for (const set of pending) {
    serverNames.add(set.serverName)
    for (const file of set.files) {
      const fileDiagnostics = fileMap.get(file.uri) ?? {
        uri: file.uri,
        diagnostics: [],
      }
      const seen = seenThisDrain.get(file.uri) ?? new Set<string>()
      const alreadyDelivered = delivered.get(file.uri) ?? new Set<string>()

      for (const diag of file.diagnostics) {
        const key = diagnosticKey(diag)
        if (seen.has(key) || alreadyDelivered.has(key)) continue
        seen.add(key)
        fileDiagnostics.diagnostics.push(diag)
      }

      seenThisDrain.set(file.uri, seen)
      fileMap.set(file.uri, fileDiagnostics)
    }
  }

  const files = [...fileMap.values()].filter(f => f.diagnostics.length > 0)
  let total = 0
  for (const file of files) {
    file.diagnostics.sort(
      (a, b) => severityRank(a.severity) - severityRank(b.severity),
    )
    const remaining = MAX_TOTAL_DIAGNOSTICS - total
    file.diagnostics = file.diagnostics.slice(
      0,
      Math.min(MAX_DIAGNOSTICS_PER_FILE, remaining),
    )
    total += file.diagnostics.length
  }

  const limitedFiles = files.filter(f => f.diagnostics.length > 0)
  for (const file of limitedFiles) {
    let deliveredForFile = delivered.get(file.uri)
    if (!deliveredForFile) {
      deliveredForFile = new Set()
      delivered.set(file.uri, deliveredForFile)
    }
    for (const diag of file.diagnostics) {
      deliveredForFile.add(diagnosticKey(diag))
    }
  }

  while (delivered.size > MAX_DELIVERED_FILES) {
    const first = delivered.keys().next().value
    if (!first) break
    delivered.delete(first)
  }

  if (limitedFiles.length === 0) return []
  return [{ serverName: [...serverNames].join(', '), files: limitedFiles }]
}

export function clearDeliveredLspDiagnosticsForFile(
  workspaceKey: string,
  filePath: string,
): void {
  deliveredByWorkspace.get(workspaceKey)?.delete(filePath)
}

export function clearWorkspaceLspDiagnostics(workspaceKey: string): void {
  pendingByWorkspace.delete(workspaceKey)
  deliveredByWorkspace.delete(workspaceKey)
}
