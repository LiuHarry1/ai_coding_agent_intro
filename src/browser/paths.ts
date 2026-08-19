/** Default browser scratch roots (downloads under a secure temp dir). */
import path from 'node:path'
import { resolveSecureTempRoot } from './fs-safe/secure-temp-dir.js'

const DEFAULT_FALLBACK_BROWSER_TMP_DIR = '/tmp/ai-agent'

function canUseNodeFs(): boolean {
  const getBuiltinModule = (
    process as NodeJS.Process & {
      getBuiltinModule?: (id: string) => unknown
    }
  ).getBuiltinModule
  if (typeof getBuiltinModule !== 'function') {
    return false
  }
  try {
    return getBuiltinModule('fs') !== undefined
  } catch {
    return false
  }
}

const DEFAULT_BROWSER_TMP_DIR = canUseNodeFs()
  ? resolveSecureTempRoot({
      preferredDir: '/tmp/ai-agent',
      fallbackPrefix: 'ai-agent',
      warningPrefix: '[ai-agent]',
      unsafeFallbackLabel: 'browser temp dir',
      skipPreferredOnWindows: true,
    })
  : DEFAULT_FALLBACK_BROWSER_TMP_DIR

export const DEFAULT_DOWNLOAD_DIR = path.join(
  DEFAULT_BROWSER_TMP_DIR,
  'downloads',
)

/** Isolated Chrome userDataDir when `browser.profile` is `fresh`. */
export function freshIsolatedProfileDir(sessionKey: string): string {
  return path.join(DEFAULT_BROWSER_TMP_DIR, 'profiles', sessionKey)
}
