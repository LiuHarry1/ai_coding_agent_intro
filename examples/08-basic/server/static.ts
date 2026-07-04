import * as fs from 'fs'
import * as path from 'path'
import type { IncomingMessage, ServerResponse } from 'http'
import { MIME_TYPES } from './http.js'

export function serveStaticFile(
  req: IncomingMessage,
  res: ServerResponse,
  staticDir: string,
): boolean {
  const urlPath =
    req.url === '/' ? '/index.html' : (req.url?.split('?')[0] ?? '/index.html')
  const filePath = path.join(staticDir, urlPath)

  if (
    req.method !== 'GET' ||
    !filePath.startsWith(staticDir) ||
    !fs.existsSync(filePath)
  ) {
    return false
  }

  const ext = path.extname(filePath)
  res.writeHead(200, {
    'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
  })
  fs.createReadStream(filePath).pipe(res)
  return true
}
