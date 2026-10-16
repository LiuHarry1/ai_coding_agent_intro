/** Desktop (Electron) bridge exposed via preload. No-op on web. */
export function isDesktop() {
  return Boolean(globalThis.desktop?.isDesktop)
}

export async function pickWorkspaceDir() {
  if (!isDesktop()) return null
  return globalThis.desktop.pickWorkspace()
}
