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

/** Remote/local worker install dir under $HOME, e.g. .baize-agent-worker */
export const WORKER_HOME_DIRNAME = `.${APP_SLUG}-agent-worker`

/** Temp cwd-tracking file prefix for shell sessions */
export const WORKER_CWD_FILE_PREFIX = `${APP_SLUG}-worker-cwd`
export const WORKER_BG_CWD_FILE_PREFIX = `${APP_SLUG}-worker-bg-cwd`

export default brand
