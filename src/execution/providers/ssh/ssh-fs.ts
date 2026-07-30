import type { DirEntry, FileStat, FsPort, ReadOpts } from '../../types.js'
import { shQuote, sshExecOk } from './ssh-exec.js'
import type { ParsedSshHost } from './ssh-config.js'

/**
 * Build a remote shell expression for a path.
 * Bare `~` / `~/…` must NOT be fully single-quoted or tilde never expands
 * (that caused HTTP 500 ERR:not_a_dir when browsing SSH hosts).
 */
export function remotePathShell(filePath: string): string {
  const p = (filePath || '~').trim()
  if (p === '~' || p === '') return '"$HOME"'
  if (p.startsWith('~/')) {
    return `"$HOME"/${shQuote(p.slice(2))}`
  }
  if (p === '$HOME') return '"$HOME"'
  if (p.startsWith('$HOME/')) {
    return `"$HOME"/${shQuote(p.slice('$HOME/'.length))}`
  }
  return shQuote(p)
}

/**
 * Remote filesystem via `ssh` + shell helpers (no ssh2 dependency).
 */
export class SshFsPort implements FsPort {
  constructor(private host: ParsedSshHost) {}

  async list(dirPath: string): Promise<DirEntry[]> {
    const { dir, entries } = await this.listResolved(dirPath)
    // Preserve resolved dir for callers that only use list()
    Object.defineProperty(entries, 'resolvedDir', {
      value: dir,
      enumerable: false,
    })
    return entries
  }

  async listResolved(
    dirPath: string,
  ): Promise<{ dir: string; entries: DirEntry[] }> {
    const expr = remotePathShell(dirPath)
    const script = `
set -e
d=${expr}
if [ ! -d "$d" ]; then
  echo "ERR:not_a_dir"
  echo "path=$d" >&2
  exit 1
fi
d=$(cd "$d" && pwd -P)
echo "DIR:$d"
for e in "$d"/.* "$d"/*; do
  [ -e "$e" ] || continue
  base=$(basename "$e")
  [ "$base" = "." ] || [ "$base" = ".." ] && continue
  if [ -d "$e" ]; then t=d
  elif [ -f "$e" ]; then t=f
  else t=o; fi
  printf '%s\\t%s\\n' "$base" "$t"
done
`
    let out: string
    try {
      out = await sshExecOk(this.host, script)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(
        `Cannot list remote directory "${dirPath}": ${msg}. ` +
          `Hint: use an absolute path or ~/… (home is expanded on the remote).`,
      )
    }

    let resolvedDir = dirPath
    const entries: DirEntry[] = []
    for (const line of out.split(/\r?\n/)) {
      if (!line.trim()) continue
      if (line.startsWith('DIR:')) {
        resolvedDir = line.slice(4).trim() || resolvedDir
        continue
      }
      if (line.startsWith('ERR:')) continue
      const [name, y] = line.split('\t')
      if (!name || name === '.' || name === '..') continue
      const type: DirEntry['type'] =
        y === 'd' ? 'dir' : y === 'f' ? 'file' : 'other'
      entries.push({
        name,
        path: `${resolvedDir.replace(/\/$/, '')}/${name}`,
        type,
      })
    }
    entries.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    return { dir: resolvedDir, entries }
  }

  async stat(filePath: string): Promise<FileStat> {
    const expr = remotePathShell(filePath)
    const script = `
p=${expr}
if [ ! -e "$p" ]; then echo 'ERR:enoent'; exit 1; fi
if [ -d "$p" ]; then
  t=dir
  rp=$(cd "$p" && pwd -P)
else
  [ -f "$p" ] && t=file || t=other
  rp=$(cd "$(dirname "$p")" && pwd -P)/$(basename "$p")
fi
size=$(wc -c < "$p" 2>/dev/null || echo 0)
mtime=$(stat -c %Y "$p" 2>/dev/null || stat -f %m "$p" 2>/dev/null || echo 0)
printf '%s\\t%s\\t%s\\t%s\\n' "$t" "$size" "$mtime" "$rp"
`
    const out = (await sshExecOk(this.host, script)).trim()
    if (out.startsWith('ERR:')) {
      throw new Error(`Remote path not found: ${filePath}`)
    }
    const [type, size, mtime, resolved] = out.split('\t')
    return {
      path: resolved || filePath,
      type: (type as FileStat['type']) || 'other',
      size: Number(size) || 0,
      mtimeMs: (Number(mtime) || 0) * 1000,
    }
  }

  async read(filePath: string, opts?: ReadOpts): Promise<Uint8Array | string> {
    const out = await sshExecOk(this.host, `cat ${remotePathShell(filePath)}`)
    if (opts?.encoding) return out
    return new TextEncoder().encode(out)
  }

  async realpath(filePath: string): Promise<string> {
    const expr = remotePathShell(filePath)
    const out = await sshExecOk(
      this.host,
      `p=${expr}; if [ -d "$p" ]; then cd "$p" && pwd -P; elif [ -e "$p" ]; then cd "$(dirname "$p")" && echo "$(pwd -P)/$(basename "$p")"; else echo ${shQuote(filePath)}; fi`,
    )
    return out.trim().split(/\r?\n/)[0] || filePath
  }

  async close(): Promise<void> {}
}
