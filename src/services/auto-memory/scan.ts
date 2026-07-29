/**
 * Scan topic files + truncate MEMORY.md index.
 */
import * as fs from 'fs'
import * as path from 'path'
import { AUTO_MEM_ENTRYPOINT, getAutoMemEntrypoint } from './paths.js'
import { parseMemoryType, type MemoryType } from './types.js'

const MAX_INDEX_LINES = 200
const MAX_INDEX_BYTES = 25 * 1024
const MAX_SCAN_FILES = 200

export type MemoryFileMeta = {
  absPath: string
  relPath: string
  name?: string
  description?: string
  type?: MemoryType
  mtimeMs: number
}

function parseFrontmatter(content: string): Record<string, string> {
  if (!content.startsWith('---')) return {}
  const end = content.indexOf('\n---', 3)
  if (end < 0) return {}
  const block = content.slice(3, end).trim()
  const out: Record<string, string> = {}
  for (const line of block.split('\n')) {
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/)
    if (m) out[m[1]!] = m[2]!.trim().replace(/^["']|["']$/g, '')
  }
  return out
}

/** List topic .md files under memdir (excludes MEMORY.md), newest first. */
export function scanMemoryFiles(memPath: string): MemoryFileMeta[] {
  if (!fs.existsSync(memPath)) return []
  const out: MemoryFileMeta[] = []

  const walk = (dir: string): void => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const ent of entries) {
      const abs = path.join(dir, ent.name)
      if (ent.isDirectory()) {
        if (ent.name === 'team' || ent.name === 'logs') continue
        walk(abs)
        continue
      }
      if (!ent.isFile() || !ent.name.endsWith('.md')) continue
      if (ent.name === AUTO_MEM_ENTRYPOINT) continue
      let content: string
      let st: fs.Stats
      try {
        st = fs.statSync(abs)
        content = fs.readFileSync(abs, 'utf-8')
      } catch {
        continue
      }
      const fm = parseFrontmatter(content)
      out.push({
        absPath: abs,
        relPath: path.relative(memPath, abs).split(path.sep).join('/'),
        name: fm.name,
        description: fm.description,
        type: parseMemoryType(fm.type),
        mtimeMs: st.mtimeMs,
      })
    }
  }

  walk(memPath)
  out.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return out.slice(0, MAX_SCAN_FILES)
}

export function formatMemoryManifest(files: MemoryFileMeta[]): string {
  if (files.length === 0) return ''
  return files
    .map(f => {
      const title = f.name ?? f.relPath
      const desc = f.description ? ` — ${f.description}` : ''
      const typ = f.type ? ` [${f.type}]` : ''
      return `- ${f.relPath}${typ}: ${title}${desc}`
    })
    .join('\n')
}

/** Truncate MEMORY.md to line + byte caps. */
export function truncateEntrypointContent(raw: string): {
  content: string
  truncated: boolean
} {
  const lines = raw.split('\n')
  let truncated = false
  let kept = lines
  if (kept.length > MAX_INDEX_LINES) {
    kept = kept.slice(0, MAX_INDEX_LINES)
    truncated = true
  }
  let content = kept.join('\n')
  if (Buffer.byteLength(content, 'utf-8') > MAX_INDEX_BYTES) {
    truncated = true
    while (
      content.length > 0 &&
      Buffer.byteLength(content, 'utf-8') > MAX_INDEX_BYTES
    ) {
      const nl = content.lastIndexOf('\n')
      content = nl >= 0 ? content.slice(0, nl) : ''
    }
  }
  if (truncated) {
    content =
      content.replace(/\n*$/, '') +
      '\n\n[... truncated — keep MEMORY.md concise; older lines omitted]'
  }
  return { content, truncated }
}

export function readEntrypointRaw(memPath: string): string {
  const p = getAutoMemEntrypoint(memPath)
  try {
    return fs.readFileSync(p, 'utf-8')
  } catch {
    return ''
  }
}

/**
 * Ensure index mentions relPath; append a stub line if missing.
 * Returns true if the index was modified.
 */
export function ensureIndexEntry(
  memPath: string,
  relPath: string,
  title: string,
  hook?: string,
): boolean {
  const entry = getAutoMemEntrypoint(memPath)
  let raw = ''
  try {
    raw = fs.readFileSync(entry, 'utf-8')
  } catch {
    raw = ''
  }
  if (raw.includes(`](${relPath})`) || raw.includes(`](./${relPath})`)) {
    return false
  }
  const line = `- [${title}](${relPath})${hook ? ` — ${hook}` : ''}`
  const next = raw.trimEnd() ? `${raw.replace(/\n*$/, '')}\n${line}\n` : `${line}\n`
  fs.writeFileSync(entry, next, { encoding: 'utf-8', mode: 0o600 })
  return true
}

/** Rebuild MEMORY.md from scanned topic files. */
export function rebuildIndex(memPath: string): void {
  const files = scanMemoryFiles(memPath)
  const lines = files.map(f => {
    const title = f.name ?? f.relPath.replace(/\.md$/i, '')
    const hook = f.description ?? ''
    return `- [${title}](${f.relPath})${hook ? ` — ${hook}` : ''}`
  })
  const body = lines.length ? lines.join('\n') + '\n' : ''
  fs.writeFileSync(getAutoMemEntrypoint(memPath), body, {
    encoding: 'utf-8',
    mode: 0o600,
  })
}
