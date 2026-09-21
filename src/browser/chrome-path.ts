/**
 * Where Chrome lives on this machine.
 *
 * Needed on two paths that have nothing else in common: the e2e helper that
 * launches a throwaway Chrome, and `open-connect-page.ts`, which asks the
 * user's *existing* Chrome to open a tab. Kept out of `src/scripts/` because
 * the second one ships.
 */
import * as fs from 'fs'
import * as path from 'path'

function windowsCandidates(): string[] {
  const roots = [
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    process.env.LOCALAPPDATA,
  ].filter((v): v is string => Boolean(v))
  return roots.map(root =>
    path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  )
}

export function chromeCandidates(): string[] {
  if (process.platform === 'win32') return windowsCandidates()
  if (process.platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ]
  }
  return ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser']
}

export function findChrome(): string | undefined {
  const fromEnv = process.env.CHROME_PATH
  if (fromEnv) return fromEnv
  return chromeCandidates().find(p => fs.existsSync(p))
}

export function chromePath(): string {
  const found = findChrome()
  if (!found) {
    throw new Error(
      `Could not find Chrome. Set CHROME_PATH. Looked in:\n  ${chromeCandidates().join('\n  ')}`,
    )
  }
  return found
}
