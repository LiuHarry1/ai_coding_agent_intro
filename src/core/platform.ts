import * as path from 'path'
import { spawn, type ChildProcess } from 'child_process'

export const isWindows = process.platform === 'win32'

/** One-line platform summary for system prompts. */
export const platformLabel = `${process.platform} (${process.arch})`

export function killChild(child: ChildProcess): void {
  if (isWindows) {
    try {
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
      })
    } catch {}
  } else {
    child.kill('SIGTERM')
    setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {}
    }, 3000)
  }
}

export function forceKillChild(child: ChildProcess): void {
  if (isWindows) {
    try {
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
      })
    } catch {}
  } else {
    try {
      child.kill('SIGKILL')
    } catch {}
  }
}

export function normalizePathForCompare(p: string): string {
  const resolved = path.resolve(p)
  return isWindows ? resolved.toLowerCase() : resolved
}

export function normalizeGitPath(gitPath: string): string {
  return path.resolve(gitPath)
}
