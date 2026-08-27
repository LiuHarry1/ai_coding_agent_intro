/**
 * Product branding — single source: /brand.json at repo root.
 * Change name/tagline/slug there; UI, ACP, desktop, and worker paths pick it up.
 */
import brand from '../brand.json' with { type: 'json' }

export const APP_NAME: string = brand.name
export const APP_TAGLINE: string = brand.tagline
export const APP_SLUG: string = brand.slug

/** Bundled worker filename, e.g. baize-worker.cjs */
export const WORKER_BUNDLE_NAME = `${APP_SLUG}-worker.cjs`

/** Bundled desktop agent filename, e.g. baize-agent.cjs */
export const AGENT_BUNDLE_NAME = `${APP_SLUG}-agent.cjs`

/** Native compiled agent (Bun --compile), e.g. baize-agent.exe on Windows */
export function agentNativeFileName(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? `${APP_SLUG}-agent.exe` : `${APP_SLUG}-agent`
}

/** Remote/local worker install dir under $HOME, e.g. .baize-agent-worker */
export const WORKER_HOME_DIRNAME = `.${APP_SLUG}-agent-worker`

/** Temp cwd-tracking file prefix for shell sessions */
export const WORKER_CWD_FILE_PREFIX = `${APP_SLUG}-worker-cwd`
export const WORKER_BG_CWD_FILE_PREFIX = `${APP_SLUG}-worker-bg-cwd`

export default brand
