/**
 * Public URL prefix when this agent is reverse-proxied (KnowBot nginx
 * `/code/` → this process on another port). Keep in sync with
 * client/web/src/lib/api/_http.js.
 *
 * KnowBot's nginx already strips the prefix before proxy_pass. Stripping
 * here as well means `/code/` also works if someone hits this port
 * directly, or if a gateway forwards the path unchanged.
 */
export const PUBLIC_MOUNT = '/code'

/** Strip PUBLIC_MOUNT from a request URL (path + query), if present. */
export function stripMountPath(url: string | undefined): string {
  if (!url) return '/'
  const q = url.indexOf('?')
  const path = q === -1 ? url : url.slice(0, q)
  const qs = q === -1 ? '' : url.slice(q)
  let next = path
  if (path === PUBLIC_MOUNT || path === `${PUBLIC_MOUNT}/`) next = '/'
  else if (path.startsWith(`${PUBLIC_MOUNT}/`)) {
    next = path.slice(PUBLIC_MOUNT.length) || '/'
  }
  return next + qs
}
