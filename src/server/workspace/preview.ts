import * as fs from 'fs'
import * as path from 'path'
import type { ServerResponse } from 'http'
import { FsOpError } from './fs-ops.js'

/** Max HTML size for inline preview (search2chart-style single-file charts). */
export const MAX_PREVIEW_BYTES = 5 * 1024 * 1024

function sendJSON(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(data))
}

function contentDispositionInline(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, "'")
  const encoded = encodeURIComponent(name)
  return `inline; filename="${ascii}"; filename*=UTF-8''${encoded}`
}

/** Public agent base URL for preview links (matches deploy AGENT_PUBLIC_URL). */
export function getPreviewBaseUrl(): string | undefined {
  const raw = process.env.AGENT_PUBLIC_URL?.trim()
  if (!raw) return undefined
  return raw.replace(/\/$/, '')
}

/**
 * Stream a workspace HTML file for browser preview.
 * Maps search2chart-mcp's localhost HTTP serve to `/workspace/preview?path=`.
 */
export async function handlePreview(
  res: ServerResponse,
  pathParam: string | null,
  safe: (input: string, access?: 'read' | 'write') => string,
): Promise<void> {
  if (!pathParam) {
    sendJSON(res, 400, { error: "Missing 'path'" })
    return
  }

  const ext = path.extname(pathParam).toLowerCase()
  if (ext !== '.html' && ext !== '.htm') {
    sendJSON(res, 400, { error: 'Preview only supports .html files' })
    return
  }

  const target = safe(pathParam)
  if (!fs.existsSync(target)) {
    sendJSON(res, 404, { error: `Not found: ${target}` })
    return
  }

  const stat = fs.statSync(target)
  if (!stat.isFile()) {
    sendJSON(res, 400, { error: 'Not a file' })
    return
  }
  if (stat.size > MAX_PREVIEW_BYTES) {
    throw new FsOpError(
      'E2BIG',
      `File too large for preview (max ${MAX_PREVIEW_BYTES} bytes)`,
    )
  }

  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': String(stat.size),
    'Content-Disposition': contentDispositionInline(path.basename(target)),
  })
  const stream = fs.createReadStream(target)
  stream.on('error', () => res.destroy())
  stream.pipe(res)
}
