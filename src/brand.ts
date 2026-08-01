/**
 * Product branding — single source: /brand.json at repo root.
 * Change the name there; UI, ACP, and desktop pick it up via this module.
 */
import brand from '../brand.json'

export const APP_NAME: string = brand.name
export const APP_TAGLINE: string = brand.tagline

export default brand
